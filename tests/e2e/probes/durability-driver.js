/**
 * D004 落盘探针（跑在真实浏览器页内）。
 *
 * **被测对象**：`packages/transport/dist/index.js` —— 真实实现（由单包 build 产出，
 * 零运行时依赖、单文件 ESM），不是 POC 的原型。
 *
 * 探针只做三件事：
 *   1. 用 `createOfflineStore` 打开真实离线存储（IndexedDB 后端，D004 强制）；
 *   2. **同步**发出 N 个 `prewrite`（模拟「事件已产生」），可选择等待 `settled`
 *      —— `settled` 只在事务 `oncomplete` 之后 resolve（`idb-backend.ts` 的落盘点定义）；
 *   3. 重启后穷举 `list()` / `read()` 把「同一 profile 上还读得到什么」如实交回 Node 侧。
 *
 * 页面不做任何判定、不吞错：一切数字都交回 Node 侧写 JSON。
 *
 * ## 口径（#4，2026-10-15）：本探针证明的是**传输层的落盘/读回**，不是 **SDK 组批**
 *
 * 批次正文由 `issue()` **手写**（事件数组与 `protocol_version` 都是探针自己拼的），
 * 直接喂给 `createOfflineStore` 的 `prewrite`。所以"重启后还读得到"证明的是
 * transport 的离线存储语义，**不能**推论 `createAssembly → track → 组批 → 落盘` 这条链路。
 */
import * as T from '/transport/index.js';

globalThis.window.__d004 = {
  version: T.PACKAGE_NAME,

  /** 打开真实离线存储。`sessionId` 每次重启都不同（模拟新标签页）。 */
  async open(cfg) {
    const store = T.createOfflineStore({
      appId: cfg.appId,
      sessionId: cfg.sessionId,
      dbName: cfg.dbName,
      ...(cfg.deadSessionMs === undefined ? {} : { deadSessionMs: cfg.deadSessionMs }),
      ...(cfg.limits === undefined ? {} : { limits: cfg.limits }),
    });
    globalThis.window.__store = store;
    await store.ready();
    return { stats: store.stats(), commitLoss: store.commitLoss() };
  },

  /**
   * 同步发出 `count` 个批次（每批 `eventsPerBatch` 个事件），返回 batch_id 列表。
   * 严格同步：函数返回时所有 `prewrite` 都已受理，但事务**未必**提交。
   */
  issue(cfg) {
    const store = globalThis.window.__store;
    const batchIds = [];
    const t0 = globalThis.performance.now();
    for (let i = 0; i < cfg.count; i += 1) {
      const events = [];
      const pad = cfg.padBytes ? 'x'.repeat(cfg.padBytes) : null;
      for (let j = 0; j < cfg.eventsPerBatch; j += 1) {
        events.push({
          event_id: `${cfg.prefix}-${i}-${j}`,
          event_name: 'e2e_d004_probe',
          event_type: 'performance',
          schema_version: 1,
          occurred_at: Date.now(),
          priority: cfg.priority ?? 'critical',
          ...(pad === null ? {} : { e2e_padding: pad }),
        });
      }
      const batch = {
        protocol_version: 1,
        app_id: cfg.appId,
        env: 'e2e',
        release: 'e2e',
        sdk_name: '@web-report-sdk/browser',
        sdk_version: '0.0.0',
        device_id: 'e2e-device',
        session_id: cfg.sessionId,
        clock_offset: 0,
        consent: 'granted',
        batch_id: `${cfg.prefix}-batch-${i}`,
        sent_at: Date.now(),
        common: { url: 'http://127.0.0.1/probes/durability.html' },
        events,
      };
      const handle = store.prewrite(batch);
      globalThis.window.__handles = globalThis.window.__handles ?? new Map();
      globalThis.window.__handles.set(handle.batchId, handle);
      batchIds.push(handle.batchId);
    }
    return { issued: batchIds.length, ms: globalThis.performance.now() - t0, batchIds };
  },

  /** 等所有已发出批次的 `settled` 有结论（有界：超时返回已结论的部分）。 */
  async awaitSettled(timeoutMs) {
    const startedAt = globalThis.performance.now();
    const handles = [...(globalThis.window.__handles ?? new Map()).values()];
    const outcomes = handles.map((handle) =>
      Promise.race([
        handle.settled.then((outcome) => ({ batchId: handle.batchId, ...outcome })),
        new Promise((resolve) =>
          globalThis.setTimeout(() => resolve({ batchId: handle.batchId, status: 'timeout' }), timeoutMs),
        ),
      ]),
    );
    const settled = await Promise.all(outcomes);
    const tally = {};
    for (const item of settled) tally[item.status] = (tally[item.status] ?? 0) + 1;
    return { total: settled.length, tally, settled, elapsedMs: globalThis.performance.now() - startedAt };
  },

  /** 重启后穷举：list() 索引 + 逐条 read() 取原样批次（校验 event_id 与条数）。 */
  async inventory(limit) {    const store = globalThis.window.__store;
    const list = await store.list(limit ?? 100_000);
    const records = [];
    for (const summary of list) {
      const batch = await store.read(summary.batch_id);
      records.push({
        batchId: summary.batch_id,
        eventCount: summary.event_count,
        criticalCount: summary.critical_count,
        readable: batch !== null,
        eventIds: batch === null ? null : batch.events.map((event) => event.event_id),
      });
    }
    return { count: records.length, records, stats: store.stats(), commitLoss: store.commitLoss() };
  },

  /** 读下标（用于隔离「索引可见但记录读不回」这类半落盘状态）。 */
  async indexOnly(limit) {
    const store = globalThis.window.__store;
    const list = await store.list(limit ?? 100_000);
    return list.map((summary) => ({ batchId: summary.batch_id, eventCount: summary.event_count }));
  },

  /**
   * **不经过 SDK**、直接开同一个 IndexedDB 数一遍三个 object store 与 meta，
   * 用来判定「读回变少」到底是存储层只落了一部分，还是 SDK 的索引/淘汰逻辑把记录藏了/删了。
   * 必须在 `open()` 之前调用（避免 SDK 打开时的 prune/淘汰改变现场）。
   */
  async rawDump(dbName) {
    return await new Promise((resolve) => {
      const request = globalThis.indexedDB.open(dbName);
      request.onerror = () => resolve({ error: String(request.error) });
      request.onsuccess = () => {
        const db = request.result;
        const stores = [...db.objectStoreNames];
        try {
          const tx = db.transaction(stores, 'readonly');
          const counts = {};
          for (const name of stores) counts[name] = tx.objectStore(name).count();
          const meta = tx.objectStore('meta').getAll();
          tx.oncomplete = () => {
            const result = { stores, counts: {}, meta: meta.result };
            for (const name of stores) result.counts[name] = counts[name].result;
            result.metaParsed = (meta.result ?? []).map((entry) => {
              try {
                return { key: entry.key, value: JSON.parse(entry.value) };
              } catch {
                return { key: entry.key, value: entry.value };
              }
            });
            db.close();
            resolve(result);
          };
          tx.onerror = () => {
            db.close();
            resolve({ error: String(tx.error) });
          };
        } catch (error) {
          db.close();
          resolve({ error: String(error) });
        }
      };
    });
  },
};
globalThis.window.__d004Ready = true;
