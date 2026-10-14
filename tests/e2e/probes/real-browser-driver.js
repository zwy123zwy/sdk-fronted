/**
 * T29「真实浏览器项」页内探针。
 *
 * 只做两件事：调用**真实实现**（`packages/browser/dist` 的 IIFE 全局 + `packages/transport/dist`），
 * 使用**真实浏览器 API**（crypto / sendBeacon / IndexedDB / BroadcastChannel / Web Locks / XHR / fetch），
 * 把观测到的原始结果交回 Node 侧。任何判定都在 spec 里做。
 */
import * as T from '/transport/index.js';

const SDK = globalThis.WebReportSDK;
const SIGNAL_KEY = '__rb_signals';

function readSignals() {
  try {
    return JSON.parse(globalThis.sessionStorage.getItem(SIGNAL_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function pushSignal(value) {
  const signals = readSignals();
  signals.push({ ...value, at: Date.now() });
  try {
    globalThis.sessionStorage.setItem(SIGNAL_KEY, JSON.stringify(signals));
  } catch {
    /* 忽略 */
  }
}

function envelope(prefix, count, appId = 'e2e-real') {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push({
      event_id: `${prefix}-${i}`,
      event_name: 'e2e_real_probe',
      event_type: 'performance',
      schema_version: 1,
      occurred_at: Date.now(),
      priority: 'critical',
    });
  }
  return {
    protocol_version: 1,
    app_id: appId,
    env: 'e2e',
    release: 'e2e',
    sdk_name: '@web-report-sdk/browser',
    sdk_version: '0.0.0',
    device_id: 'e2e-device',
    session_id: 'e2e-session',
    clock_offset: 0,
    consent: 'granted',
    batch_id: `${prefix}-batch`,
    sent_at: Date.now(),
    events,
  };
}

globalThis.window.__rb = {
  /** 真实浏览器能力与本页真实 URL。 */
  capabilities() {
    return {
      userAgent: globalThis.navigator.userAgent,
      isSecureContext: globalThis.isSecureContext,
      href: globalThis.location.href,
      search: globalThis.location.search,
      hasRandomUUID: typeof globalThis.crypto?.randomUUID === 'function',
      hasSendBeacon: typeof globalThis.navigator.sendBeacon === 'function',
      hasLocks: typeof globalThis.navigator.locks?.request === 'function',
      hasBroadcastChannel: typeof BroadcastChannel === 'function',
      hasIndexedDB: typeof globalThis.indexedDB === 'object',
      hasCompressionStream: typeof CompressionStream === 'function',
      iifeKeys: SDK === undefined ? null : Object.keys(SDK).length,
      createUuidExported: typeof SDK?.createUuid === 'function',
      readLocationExported: typeof SDK?.readLocation === 'function',
    };
  },

  /** T12/T13：真实 `crypto.randomUUID` 与不可用时的回退，都在真实浏览器里跑。 */
  uuidProbe() {
    const real = [];
    for (let i = 0; i < 200; i += 1) real.push(SDK.createUuid());
    const origin = globalThis.crypto.randomUUID;
    let fallback = [];
    let restoreError = null;
    try {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
      for (let i = 0; i < 200; i += 1) fallback.push(SDK.createUuid());
    } catch (error) {
      restoreError = String(error);
    } finally {
      try {
        Object.defineProperty(globalThis.crypto, 'randomUUID', { value: origin, configurable: true });
      } catch (error) {
        restoreError = `${restoreError ?? ''} restore:${String(error)}`;
      }
    }
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    return {
      realAllV4: real.every((value) => uuidV4.test(value)),
      realUnique: new Set(real).size,
      realSample: real.slice(0, 2),
      fallbackRemoved: typeof globalThis.crypto.randomUUID !== 'function' || fallback.length === 200,
      fallbackAllV4: fallback.every((value) => uuidV4.test(value)),
      fallbackUnique: new Set(fallback).size,
      fallbackSample: fallback.slice(0, 2),
      restoreError,
      restored: typeof globalThis.crypto.randomUUID === 'function',
    };
  },

  /** T12/T13：真实 `location.search`。 */
  locationProbe() {
    const value = SDK.readLocation();
    return { value, href: globalThis.location.href, search: globalThis.location.search };
  },

  /** AC-13：真实 `navigator.sendBeacon` 本身的行为（浏览器层真相）。 */
  sendBeaconProbe(url, bytes) {
    const payload = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 1) payload[i] = i % 251;
    let accepted = null;
    let error = null;
    try {
      accepted = globalThis.navigator.sendBeacon(url, new globalThis.Blob([payload], { type: 'text/plain' }));
    } catch (caught) {
      error = String(caught);
    }
    return { bytes, accepted, error };
  },

  /**
   * AC-13：经**真实实现**的离开通道发一个 critical 批次。
   * `submit(batch, {channel:'page_leave', complete})` 是 C07 的真实离开路径，
   * 内部用 `http.sendBeacon`（真实 `navigator.sendBeacon`）。
   */
  async leaveBeaconProbe(url, eventCount) {
    const complete = [];
    const delivery = T.createDelivery({
      appId: 'e2e-real',
      sessionId: 'leave-probe',
      credentials: { current: () => ({ endpoint: url, appId: 'e2e-real', writeToken: 't', revision: 1 }) },
      http: { sendBeacon: globalThis.navigator.sendBeacon.bind(globalThis.navigator) },
      offline: { idbFactory: null },
    });
    delivery.submit.submit(envelope('leave-beacon', eventCount), {
      channel: 'page_leave',
      complete: (status) => complete.push(String(status)),
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 800));
    const metrics = delivery.metrics();
    delivery.dispose();
    return { eventCount, complete, leave: metrics.leave, eventsSent: metrics.eventsSent };
  },

  /** AC-15：真实 `document` 上的 `visibilitychange` / `pagehide` 订阅（真实实现 source）。 */
  subscribePageLeave() {
    const source = T.createDomPageLeaveSource(globalThis.document);
    const unsubscribe = source.subscribe((signal) => pushSignal({ type: 'leave', signal }));
    globalThis.window.__rbUnsubscribe = unsubscribe;
    pushSignal({ type: 'subscribed', visibility: globalThis.document.visibilityState });
    return { visibility: globalThis.document.visibilityState, subscribed: true };
  },

  /** 直接把真实 DOM 事件派到真实 `document` 上（是真实事件对象，但触发是脚本派的）。 */
  dispatchLeave(type) {
    globalThis.document.dispatchEvent(new globalThis.Event(type));
    return readSignals();
  },

  /** 读累计信号（跨 reload 用 sessionStorage）。 */
  signals() {
    return { signals: readSignals(), visibility: globalThis.document.visibilityState };
  },

  /**
   * 真实 `versionchange`：SDK 打开 v1 后，另一个连接用 v2 打开同一个库。
   * 后端 `onversionchange` 必须主动 close 让位，否则 v2 的 open 会被 blocked。
   */
  async versionchangeProbe(dbName) {
    const store = T.createOfflineStore({ appId: 'e2e-real', sessionId: 'vc-first', dbName });
    await store.ready();
    store.prewrite(envelope('vc', 2));
    await store.drain();
    const before = await store.list(1000);
    const upgrade = await new Promise((resolve) => {
      const request = globalThis.indexedDB.open(dbName, 2);
      const timer = globalThis.setTimeout(() => resolve({ blocked: null, timeout: true }), 5000);
      request.onblocked = () => {
        globalThis.clearTimeout(timer);
        resolve({ blocked: true });
      };
      request.onsuccess = () => {
        globalThis.clearTimeout(timer);
        request.result.close();
        resolve({ blocked: false });
      };
      request.onerror = () => {
        globalThis.clearTimeout(timer);
        resolve({ blocked: false, error: String(request.error) });
      };
      request.onupgradeneeded = () => undefined;
    });
    // v1 连接已被后端主动关闭 → 后续写入应明确失败（而不是静默丢）
    const afterHandle = store.prewrite(envelope('vc-after', 2));
    const afterOutcome = await Promise.race([
      afterHandle.settled,
      new Promise((resolve) => globalThis.setTimeout(() => resolve({ status: 'timeout' }), 3000)),
    ]);
    return { beforeCount: before.length, upgrade, afterOutcome };
  },

  /** T12/T13：真实 IndexedDB 持久化（reload 后按同一 dbName 读回）。 */
  async idbWrite(dbName, prefix, count) {
    const store = T.createOfflineStore({ appId: 'e2e-real', sessionId: 'reload-first', dbName });
    await store.ready();
    const handle = store.prewrite(envelope(prefix, count));
    await handle.settled;
    await store.dispose();
    return { batchId: handle.batchId, events: handle.eventCount };
  },

  async idbRead(dbName) {
    const store = T.createOfflineStore({ appId: 'e2e-real', sessionId: 'reload-second', dbName });
    await store.ready();
    const list = await store.list(1000);
    const batch = list.length === 0 ? null : await store.read(list[0].batch_id);
    return { count: list.length, events: batch === null ? 0 : batch.events.length, id: list[0]?.batch_id ?? null };
  },

  /** 真实 XHR + 真实超时（对端永不响应）。`createBatchSender` 不是公开导出，走装配根 `createDelivery().sender`。 */
  async xhrTimeoutProbe(url, timeoutMs) {
    const delivery = T.createDelivery({
      appId: 'e2e-real',
      sessionId: `xhr-${Math.random().toString(16).slice(2)}`,
      credentials: { current: () => ({ endpoint: url, appId: 'e2e-real', writeToken: 't', revision: 1 }) },
      http: { xhr: globalThis.XMLHttpRequest },
      timeoutMs,
      offline: { idbFactory: null },
    });
    const startedAt = globalThis.performance.now();
    const result = await delivery.sender.send(envelope('xhr-timeout', 1));
    const elapsedMs = Math.round(globalThis.performance.now() - startedAt);
    const stats = delivery.sender.stats();
    delivery.dispose();
    // 注意：elapsedMs 是**含退避重试**的总耗时；单次尝试的真实超时由 timeoutMs 决定。
    return { elapsedMs, result: String(result?.status ?? result), attempts: stats.attempts ?? null, stats };
  },

  /** 真实 fetch + 真实 401（令牌吊销）。 */
  async revokedProbe(url) {
    const delivery = T.createDelivery({
      appId: 'e2e-real',
      sessionId: `revoked-${Math.random().toString(16).slice(2)}`,
      credentials: { current: () => ({ endpoint: url, appId: 'e2e-real', writeToken: 't', revision: 1 }) },
      http: { fetch: globalThis.fetch.bind(globalThis) },
      offline: { idbFactory: null },
    });
    const result = await delivery.sender.send(envelope('revoked', 1));
    const snapshot = { result: String(result?.status ?? result), paused: delivery.sender.isPaused(), circuitOpen: delivery.sender.isCircuitOpen() };
    delivery.dispose();
    return snapshot;
  },

  /**
   * AC-17 / AC-18：真实多标签页选主。
   * 捕获异常并如实交回（真实浏览器里可能抛 `Illegal invocation` 这类只有真 API 才会有的错）。
   */
  async leaderRun(settleMs, withRealLocks = true) {
    const locks = withRealLocks ? T.createDefaultLocksPort() : null;
    const election = T.createLeaderElection({
      locks,
      broadcast: T.createDefaultBroadcastPort(),
      settleMs,
      tabId: `tab-${Math.random().toString(16).slice(2)}`,
    });
    try {
      const outcome = await election.run(async () => 'task-ran');
      return {
        leader: outcome.leader,
        mode: outcome.mode,
        modeAfter: election.mode(),
        locksPort: locks === null ? 'null' : 'real',
      };
    } catch (error) {
      return {
        error: `${error?.name ?? 'Error'}: ${String(error?.message ?? error)}`,
        locksPort: locks === null ? 'null' : 'real',
      };
    }
  },

  /** 真实 `navigator.storage.estimate()`（配额现状，用于判断能否构造真实 QuotaExceededError）。 */
  async storageEstimate() {
    const estimate = await globalThis.navigator.storage?.estimate?.();
    return estimate ?? null;
  },

  /** 真实 IndexedDB 的 `QuotaExceededError` 构造尝试：写入超大 Blob 直到被拒。 */
  async quotaProbe(dbName, targetBytes) {
    const open = () =>
      new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('blobs');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await open();
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let written = 0;
    let error = null;
    try {
      for (let i = 0; i < Math.ceil(targetBytes / chunk.byteLength); i += 1) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').put(chunk, `chunk-${i}`);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        });
        written += chunk.byteLength;
      }
    } catch (caught) {
      error = { name: caught?.name ?? null, message: String(caught?.message ?? caught) };
    }
    db.close();
    return { written, error };
  },
};

globalThis.window.__rbReady = true;
