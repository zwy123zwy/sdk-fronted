/**
 * T29 用的本地接收端：只监听 127.0.0.1，用来在真实浏览器里驱动**真实**网络行为
 * （真实 `sendBeacon`、真实 `fetch`/XHR、真实 401、真实超时）。
 *
 * 端点：
 *   POST /ingest         → 202，记录正文（默认成功路径）
 *   POST /revoked        → 401（令牌吊销对照组）
 *   POST /hang           → 永不响应（真实超时对照组）
 *   POST /beacon         → 202（`sendBeacon` 的 no-cors POST）
 *   POST /gzip           → 202（压缩正文）
 *   OPTIONS *            → 204 + CORS 预检
 *
 * T32 缺口 5（`docs/reports/reliability-reconciliation.md`）：本接收端此前"只收请求，
 * 不去重、不入库、不计数"，导致**重复送达率**与"以 M01 去重后入库计数为准"的对账口径
 * 无法满足。现在它按 M01 的口径补齐去重 + 入库 + 计数：
 *
 *   - 去重键 `app_id` + `event_id`，窗口默认 **7 天**（RR-05），可用 `dedupeWindowMs` 覆盖、
 *     用 `now` 注入时钟；
 *   - 入库数据按 `app_id` 过滤查询，`auth` / `write_token` 在入库前删除（RR-13）；
 *   - 计数：`received_*` / `stored_*` / `duplicate_events` / `duplicate_rate`，并按
 *     **事件名**（`by_event_name`）与**批次**（`by_batch`）分别计数，便于与 SDK 侧对账；
 *   - 读接口对齐 M01-F4：`GET /__mock/counters`（别名 `/__mock/stats`）、
 *     `POST|DELETE /__mock/counters/reset`、`GET|DELETE /__mock/events`。
 *
 * 既有能力不变：`received` / `hits(path)` / `close()` 与各端点的响应码口径保持原样；
 * 401 与"不响应"的请求不进入对账计数，但仍逐请求出现在 `received` 里。
 *
 * ## 不可解析批次（#5，2026-10-15）
 *
 * 缺口的形状：`parseBatchBody` 失败时只把计数加一，随后**照样写 202**；而 `unparsable_batches`
 * 在任何 spec 里**都没有被读过**——于是"SDK 发来的批次根本解析不了"这件事可以整轮静默通过。
 *
 * 现在加断言，但**不假装能对一切路径断言**：
 *   - `BATCH_ONLY_PATHS`（`/ingest`、`/gzip`）**只应承载批次**——这些路径上出现不可解析正文
 *     即为失败（`close()` 默认抛出，见 `assertNoUnparsableBatches`）；
 *   - `/beacon` **不在**其中：`tests/e2e/real-browser.spec.mjs` 会故意往那里发**二进制哨兵**
 *     （`sendBeaconProbe` 的 `i % 251` 字节，见该文件 120-131 行）来刻画浏览器层行为。
 *     把 `/beacon` 也算进来只会造出假失败，所以它按 `RAW_SENTINEL_PATHS` 豁免——这是**如实降级**，
 *     不是放水：豁免是**按路径**的，且 `/beacon` 上的不可解析计数仍然逐条可查（`unparsableByPath()`）。
 */
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

/** RR-05：默认去重窗口 7 天。 */
export const DEFAULT_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 计入对账（去重 + 入库 + 计数）的请求路径。 */
const LEDGER_PATHS = new Set(['/ingest', '/beacon', '/gzip']);

/**
 * #5：**只应承载批次**的路径。不可解析正文出现在这里 → `assertNoUnparsableBatches` 失败。
 */
export const BATCH_ONLY_PATHS = ['/ingest', '/gzip'];

/**
 * #5：允许出现不可解析正文的**原始哨兵**路径（豁免必须有理由，见文件头注释）。
 */
export const RAW_SENTINEL_PATHS = ['/beacon'];

/** 与 `docs/contracts/ingest-protocol.md` 3.1 对齐的拒绝原因码。 */
const REJECT_CODES = [
  'invalid_json',
  'invalid_structure',
  'unsupported_protocol',
  'unsupported_encoding',
  'app_id_mismatch',
  'invalid_token',
  'token_revoked',
  'payload_too_large',
  'too_many_events',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 入库前删除敏感字段（RR-13）。 */
function stripSecrets(value) {
  const clone = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'auth' || key === 'write_token' || key === 'token') continue;
    clone[key] = item;
  }
  return clone;
}

/** 创建对账账本：去重登记 + 入库数据 + 计数。 */
function createLedger(dedupeWindowMs, now) {
  /** 去重键（`app_id` + `event_id`）→ 首次入库时刻。 */
  const seen = new Map();
  /** 入库行（保持入库顺序；同一 `event_id` 在窗口过期后可再入库一行）。 */
  const rows = [];
  const byEventName = new Map();

  let receivedBatches = 0;
  let receivedEvents = 0;
  let storedBatches = 0;
  let storedEvents = 0;
  let duplicateEvents = 0;
  let expiredDedupeKeys = 0;
  let unparsableBatches = 0;
  /** #5：不可解析批次**按路径**计数（断言只用它，不看全局数，避免假失败）。 */
  const unparsableByPath = new Map();
  /** #5：不可解析正文的少量样本（前 120 字符），让失败信息可诊断而不是只报一个数字。 */
  const unparsableSamples = [];
  const rejected = new Map(REJECT_CODES.map((code) => [code, 0]));
  const byBatch = [];

  function countFor(eventName) {
    const existing = byEventName.get(eventName);
    if (existing !== undefined) return existing;
    const created = { received_events: 0, stored_events: 0, duplicate_events: 0 };
    byEventName.set(eventName, created);
    return created;
  }

  function snapshot() {
    const names = {};
    for (const [name, counts] of byEventName) names[name] = { ...counts };
    const base = {
      received_batches: receivedBatches,
      received_events: receivedEvents,
      stored_batches: storedBatches,
      stored_events: storedEvents,
      duplicate_events: duplicateEvents,
      duplicate_rate: receivedEvents === 0 ? 0 : duplicateEvents / receivedEvents,
      dedupe_window_ms: dedupeWindowMs,
      expired_dedupe_keys: expiredDedupeKeys,
      unparsable_batches: unparsableBatches,
      /** #5：按路径拆开，`assertNoUnparsableBatches` 的判据就是这个。 */
      unparsable_by_path: Object.fromEntries(unparsableByPath),
      by_event_name: names,
      by_batch: byBatch.map((batch) => ({ ...batch, event_names: [...batch.event_names] })),
    };
    const rejects = {};
    for (const code of REJECT_CODES) rejects[`rejected_${code}`] = rejected.get(code) ?? 0;
    return { ...base, ...rejects };
  }

  return {
    /** 一个可对账的批次：解析正文、逐事件去重后入库。 */
    ingestBatch: (path, appId, batch) => {
      const events = Array.isArray(batch.events) ? batch.events : null;
      receivedBatches += 1;
      const record = {
        index: byBatch.length,
        app_id: appId,
        path,
        received_events: 0,
        stored_events: 0,
        duplicate_events: 0,
        event_names: [],
      };
      byBatch.push(record);
      if (events === null) return record;

      for (const raw of events) {
        if (!isPlainObject(raw)) continue;
        const eventName = typeof raw.event_name === 'string' ? raw.event_name : '';
        const eventId = typeof raw.event_id === 'string' ? raw.event_id : null;
        receivedEvents += 1;
        record.received_events += 1;
        record.event_names.push(eventName);
        const named = countFor(eventName);
        named.received_events += 1;
        if (eventId === null) continue;

        const key = `${appId}\u0000${eventId}`;
        const firstSeenAt = seen.get(key);
        if (firstSeenAt !== undefined) {
          if (now() - firstSeenAt < dedupeWindowMs) {
            duplicateEvents += 1;
            record.duplicate_events += 1;
            named.duplicate_events += 1;
            continue;
          }
          // 超出 RR-05 窗口：视为首次送达（旧行保留，新行另计入库）
          seen.delete(key);
          expiredDedupeKeys += 1;
        }

        const storedEvent = { app_id: appId, ...stripSecrets(raw), event_id: eventId };
        seen.set(key, now());
        rows.push({ key, event: storedEvent });
        storedEvents += 1;
        record.stored_events += 1;
        named.stored_events += 1;
      }
      if (record.stored_events > 0) storedBatches += 1;
      return record;
    },
    /** 正文无法解析成批次：失败可见，但不伪造事件数。`preview` 只用于诊断（#5）。 */
    onUnparsableBatch: (path, appId, preview) => {
      unparsableBatches += 1;
      unparsableByPath.set(path, (unparsableByPath.get(path) ?? 0) + 1);
      if (unparsableSamples.length < 5) {
        unparsableSamples.push({
          path,
          app_id: appId,
          preview: typeof preview === 'string' ? preview.slice(0, 120) : null,
        });
      }
      rejected.set('invalid_json', (rejected.get('invalid_json') ?? 0) + 1);
      receivedBatches += 1;
      byBatch.push({
        index: byBatch.length,
        app_id: appId,
        path,
        received_events: 0,
        stored_events: 0,
        duplicate_events: 0,
        event_names: [],
      });
    },
    onRejected: (code) => {
      rejected.set(code, (rejected.get(code) ?? 0) + 1);
    },
    /** #5：断言用的原始数据（按路径计数 + 少量样本），不经过 `snapshot()` 的拼装。 */
    unparsableByPath: () => new Map(unparsableByPath),
    unparsableSamples: () => unparsableSamples.map((sample) => ({ ...sample })),
    counters: {
      snapshot,
      clear: () => {
        receivedBatches = 0;
        receivedEvents = 0;
        storedBatches = 0;
        storedEvents = 0;
        duplicateEvents = 0;
        expiredDedupeKeys = 0;
        unparsableBatches = 0;
        unparsableByPath.clear();
        unparsableSamples.length = 0;
        for (const code of REJECT_CODES) rejected.set(code, 0);
        byEventName.clear();
        byBatch.length = 0;
      },
    },
    events: {
      list: (appId) =>
        rows
          .filter((row) => appId === undefined || row.key.startsWith(`${appId}\u0000`))
          // 入库数据都是 JSON 往返可还原的对象，用 JSON 深拷贝而非 structuredClone
          // （本仓库的 eslint 在 node 语境下未声明该全局）。
          .map((row) => JSON.parse(JSON.stringify(row.event))),
      size: (appId) => {
        if (appId === undefined) return rows.length;
        return rows.filter((row) => row.key.startsWith(`${appId}\u0000`)).length;
      },
      clear: () => {
        rows.length = 0;
      },
    },
  };
}

/** 解析批次正文：JSON（常规/信标通道），gzip 正文先解压。 */
function parseBatchBody(req, body) {
  if (body.length === 0) return { batch: null, appIdFromBody: null };
  let text;
  try {
    const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
    const payload = encoding.includes('gzip') ? gunzipSync(body) : body;
    text = payload.toString('utf8');
  } catch {
    return { batch: null, appIdFromBody: null };
  }
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return { batch: null, appIdFromBody: null };
    return {
      batch: parsed,
      appIdFromBody: typeof parsed.app_id === 'string' ? parsed.app_id : null,
    };
  } catch {
    return { batch: null, appIdFromBody: null };
  }
}

export async function startReceiver(options = {}) {
  const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const now = options.now ?? Date.now;
  // #5：默认开启。只有"整轮故意往批次路径发非批次正文"的用例才应显式关掉，并写清理由。
  const strictUnparsableBatches = options.strictUnparsableBatches ?? true;
  const received = [];
  const ledger = createLedger(dedupeWindowMs, now);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      const body = globalThis.Buffer.concat(chunks);
      const record = {
        path,
        method: req.method,
        headers: req.headers,
        bytes: body.length,
        at: Date.now(),
        accepted: true,
      };
      received.push(record);

      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (path === '/hang') {
        record.accepted = false;
        return; // 故意不响应
      }
      if (path === '/revoked') {
        record.accepted = false;
        ledger.onRejected('invalid_token');
        res.writeHead(401, { ...cors, 'content-type': 'application/json' });
        res.end('{"error":"token_revoked"}');
        return;
      }
      if (path === '/__mock/counters' || path === '/__mock/stats') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify(ledger.counters.snapshot()));
        return;
      }
      if (path === '/__mock/counters/reset') {
        ledger.counters.clear();
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify(ledger.counters.snapshot()));
        return;
      }
      if (path === '/__mock/events') {
        if (req.method === 'DELETE') {
          ledger.events.clear();
        }
        const appId = typeof req.headers['x-app-id'] === 'string' ? req.headers['x-app-id'] : undefined;
        const events = ledger.events.list(appId);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ events, count: events.length }));
        return;
      }
      if (LEDGER_PATHS.has(path) && req.method === 'POST') {
        const { batch, appIdFromBody } = parseBatchBody(req, body);
        const headerAppId = typeof req.headers['x-app-id'] === 'string' ? req.headers['x-app-id'] : null;
        const appId = appIdFromBody ?? headerAppId ?? 'unknown';
        if (batch === null) {
          // 202 的语义不变（见文件头 #5）；但对**只应承载批次**的路径，这条会被
          // `assertNoUnparsableBatches` 在 `close()` 时判为失败，并带上这个 preview。
          ledger.onUnparsableBatch(path, appId, body.toString('utf8'));
        } else {
          ledger.ingestBatch(path, appId, batch);
        }
      }
      res.writeHead(202, { ...cors, 'content-type': 'application/json' });
      res.end('{"accepted":true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const api = {
    url: `http://127.0.0.1:${port}`,
    received,
    hits: (path) => received.filter((item) => item.path === path),
    counters: ledger.counters,
    events: ledger.events,
    dedupeWindowMs,
    /** #5：不可解析批次按路径计数（断言判据，不做路径豁免）。 */
    unparsableByPath: () => Object.fromEntries(ledger.unparsableByPath()),
    /** #5：不可解析正文的少量样本（诊断用）。 */
    unparsableSamples: () => ledger.unparsableSamples(),
    /** #5 断言：`BATCH_ONLY_PATHS` 上的不可解析批次必须为 0。 */
    assertNoUnparsableBatches: (assertOptions) => assertNoUnparsableBatches(api, assertOptions),
    close: async () => {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      // 先关服务再断言，避免断言抛出后把监听端口漏在进程里。
      if (strictUnparsableBatches) api.assertNoUnparsableBatches();
    },
  };
  return api;
}

/**
 * #5 的断言：**`BATCH_ONLY_PATHS` 上的 `unparsable_batches` 必须为 0**。
 *
 * 为什么不是"全局 `unparsable_batches === 0`"：`/beacon` 上有**故意的**二进制哨兵
 * （`real-browser.spec.mjs` 的 `sendBeaconProbe`），全局断言会造出与 SDK 无关的假失败。
 * 豁免按路径给（`RAW_SENTINEL_PATHS`，可用 `allowPaths` 覆盖），所以它不是"看不见"，
 * 只是"不在此处判死"。
 *
 * 失败信息里带 `unparsableSamples()`（前 120 字符正文），让"哪个请求不可解析"可诊断。
 */
export function assertNoUnparsableBatches(receiver, options = {}) {
  const allowPaths = options.allowPaths ?? RAW_SENTINEL_PATHS;
  const byPath = receiver.unparsableByPath();
  const violations = Object.entries(byPath).filter(
    ([path, count]) => count > 0 && !allowPaths.includes(path),
  );
  if (violations.length === 0) return;
  const detail = violations.map(([path, count]) => `${path}×${count}`).join('、');
  throw new Error(
    `接收端在"只应承载批次"的路径上收到不可解析正文：${detail}；` +
      `样本=${JSON.stringify(receiver.unparsableSamples())}`,
  );
}
