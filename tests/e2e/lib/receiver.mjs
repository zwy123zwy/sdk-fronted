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
 */
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

/** RR-05：默认去重窗口 7 天。 */
export const DEFAULT_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 计入对账（去重 + 入库 + 计数）的请求路径。 */
const LEDGER_PATHS = new Set(['/ingest', '/beacon', '/gzip']);

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
    /** 正文无法解析成批次：失败可见，但不伪造事件数。 */
    onUnparsableBatch: (path, appId) => {
      unparsableBatches += 1;
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
          ledger.onUnparsableBatch(path, appId);
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
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    hits: (path) => received.filter((item) => item.path === path),
    counters: ledger.counters,
    events: ledger.events,
    dedupeWindowMs,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
