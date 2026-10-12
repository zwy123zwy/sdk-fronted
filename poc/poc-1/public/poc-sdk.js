/**
 * POC-1（T02）浏览器侧最小原型：critical 预写 + 补发。
 *
 * 这不是正式包代码，只用于可靠投递测量。它实现被测方案的关键机制：
 *  - critical 事件在入队时同步写入 localStorage（预写），normal 只进内存队列；
 *  - 页面离开时按配置用 sendBeacon 或 fetch keepalive 冲刷；
 *  - 常规通道（fetch）在收到 202 后才删除离线副本；信标通道不删（I-01 3.1、C07-F5）；
 *  - 恢复时按配置使用 Web Locks / BroadcastChannel / 不选主 决定谁来补发；
 *  - 所有丢弃路径都有原因码，计数与 trace 落到 localStorage，页面被强杀后仍可读取。
 *
 * 无任何外部依赖；不使用 Cookie，不碰业务 storage 键。
 */
(function () {
  'use strict';

  var K_PENDING = 'wr.poc.pending.v1';
  // 每个页面一套统计键（前缀 + 页面 id），读取时聚合：
  // localStorage 的读改写不是跨渲染进程原子的，共用同一个键会互相覆盖。
  var META_PREFIX = 'wr.poc.meta.v2.';
  var LOCK_NAME = 'wr.poc.recover.v1';
  var BC_NAME = 'wr.poc.recover.v1';
  var MAX_BATCH_EVENTS = 50;

  var TAB_ID = Math.random().toString(36).slice(2, 10);
  var META_KEY = META_PREFIX + TAB_ID;

  var state = {
    cfg: null,
    queue: [], // normal 事件（内存）
    bc: null,
    leaderLost: 0,
    lastResults: []
  };

  var DEFAULT_STATS = {
    enqueued_critical: 0,
    enqueued_normal: 0,
    prewrite_ok: 0,
    prewrite_failed_quota: 0,
    dropped_critical_cap: 0,
    dropped_normal_cap: 0,
    flush_calls: 0,
    flush_reason_visibility: 0,
    flush_reason_pagehide: 0,
    beacon_accepted: 0,
    beacon_rejected: 0,
    batch_202: 0,
    batch_other: 0,
    batch_network_error: 0,
    acked_events: 0,
    recover_runs: 0,
    recover_leader: 0,
    recover_not_leader: 0,
    recovered_events: 0,
    recovered_batches: 0
  };

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function readPending() {
    var v = readJSON(K_PENDING, {});
    return v && typeof v === 'object' ? v : {};
  }

  function readMeta() {
    var v = readJSON(META_KEY, null);
    if (!v || typeof v !== 'object') v = { stats: {}, trace: [] };
    if (!v.stats) v.stats = {};
    if (!Array.isArray(v.trace)) v.trace = [];
    return v;
  }

  function writeMeta(meta) {
    try {
      writeJSON(META_KEY, meta);
    } catch (e) {
      /* 统计写不进去不影响投递 */
    }
  }

  /** 汇总本 origin 下所有页面载入的统计与 trace（跨页、跨重启都可读）。 */
  function aggregateMeta() {
    var stats = {};
    var trace = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(META_PREFIX) !== 0) continue;
        var v = null;
        try {
          v = JSON.parse(localStorage.getItem(k));
        } catch (e) {
          v = null;
        }
        if (!v) continue;
        var s = v.stats || {};
        for (var key in s) stats[key] = (stats[key] || 0) + s[key];
        if (Array.isArray(v.trace)) trace = trace.concat(v.trace);
      }
    } catch (e) {
      /* ignore */
    }
    trace.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    if (trace.length > 400) trace = trace.slice(trace.length - 400);
    return { stats: stats, trace: trace };
  }

  function bumpStats(delta) {
    var meta = readMeta();
    for (var k in delta) {
      meta.stats[k] = (meta.stats[k] || 0) + delta[k];
    }
    writeMeta(meta);
  }

  function tracePush(entry) {
    var meta = readMeta();
    entry.ts = Date.now();
    meta.trace.push(entry);
    if (meta.trace.length > 400) meta.trace = meta.trace.slice(meta.trace.length - 400);
    writeMeta(meta);
  }

  function uuid4(prefixHex) {
    var hex = prefixHex.toString(16);
    while (hex.length < 12) hex = '0' + hex;
    return '00000000-0000-4000-8000-' + hex;
  }

  function newBatchId() {
    var r = '';
    for (var i = 0; i < 12; i++) r += '0123456789abcdef'[(Math.random() * 16) | 0];
    return '10000000-0000-4000-9000-' + r;
  }

  var DEVICE_ID = '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f';
  var SESSION_ID = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';

  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function buildBatchBody(evts, includeAuth) {
    var now = Date.now();
    var batch = {
      protocol_version: 1,
      app_id: state.cfg.appId,
      env: 'poc',
      release: '0.0.0-poc',
      sdk_name: 'web-report-sdk-poc',
      sdk_version: '0.0.0',
      device_id: DEVICE_ID,
      session_id: SESSION_ID,
      batch_id: newBatchId(),
      sent_at: now,
      clock_offset: 0,
      clock_calibrated: false,
      events: evts.map(function (e) {
        return {
          event_id: e.id,
          event_name: e.n || 'poc_reliability_probe',
          event_type: 'custom',
          schema_version: 1,
          occurred_at: e.t,
          priority: e.c,
          dimensions: { probe: 't02' }
        };
      })
    };
    if (includeAuth) {
      batch.auth = { app_id: state.cfg.appId, write_token: state.cfg.token };
    }
    return JSON.stringify(batch);
  }

  function ackIds(ids) {
    var store = readPending();
    var removed = 0;
    for (var i = 0; i < ids.length; i++) {
      if (Object.prototype.hasOwnProperty.call(store, ids[i])) {
        delete store[ids[i]];
        removed++;
      }
    }
    if (removed > 0) {
      try {
        writeJSON(K_PENDING, store);
      } catch (e) {
        /* ignore */
      }
    }
    return removed;
  }

  function sendChunk(transport, evts, reason) {
    var body = buildBatchBody(evts, transport === 'beacon');
    var cls = evts[0].c;
    if (transport === 'beacon') {
      var ok = false;
      try {
        ok = navigator.sendBeacon(state.cfg.endpoint, body);
      } catch (e) {
        ok = false;
      }
      bumpStats(ok ? { beacon_accepted: 1 } : { beacon_rejected: 1 });
      tracePush({ k: 'flush', r: reason, t: transport, n: evts.length, c: cls, ok: ok, ack: 0 });
      return Promise.resolve({ ok: ok, acked: 0, transport: transport, reason: reason, cls: cls, n: evts.length });
    }
    var headers = {
      'Content-Type': 'application/json',
      'X-App-Id': state.cfg.appId,
      'X-Write-Token': state.cfg.token
    };
    return fetch(state.cfg.endpoint, {
      method: 'POST',
      keepalive: transport === 'keepalive',
      headers: headers,
      body: body
    }).then(function (res) {
      var acked = 0;
      if (res.status === 202) {
        bumpStats({ batch_202: 1 });
        if (cls === 'critical') acked = ackIds(evts.map(function (e) { return e.id; }));
        if (acked > 0) bumpStats({ acked_events: acked });
      } else {
        bumpStats({ batch_other: 1 });
      }
      tracePush({ k: 'flush', r: reason, t: transport, n: evts.length, c: cls, ok: res.status === 202, status: res.status, ack: acked });
      return { ok: res.status === 202, status: res.status, acked: acked, transport: transport, reason: reason, cls: cls, n: evts.length };
    }).catch(function (err) {
      bumpStats({ batch_network_error: 1 });
      tracePush({ k: 'flush', r: reason, t: transport, n: evts.length, c: cls, ok: false, err: String(err && err.name) });
      return { ok: false, error: String(err && err.name), acked: 0, transport: transport, reason: reason, cls: cls, n: evts.length };
    });
  }

  function removeNormalIds(ids) {
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    state.queue = state.queue.filter(function (e) { return !set[e.id]; });
  }

  /** 冲刷：normal 取内存队列，critical 取离线副本（含历史遗留）。 */
  function flush(reason, transport, opts) {
    opts = opts || {};
    var includeCritical = opts.includeCritical !== false;
    var statsDelta = { flush_calls: 1 };
    if (reason === 'visibilitychange') statsDelta.flush_reason_visibility = 1;
    if (reason === 'pagehide') statsDelta.flush_reason_pagehide = 1;
    bumpStats(statsDelta);

    var jobs = [];
    var normals = state.queue.slice();
    var store = readPending();
    var criticals = includeCritical
      ? Object.keys(store).map(function (id) {
          return { id: id, c: 'critical', t: store[id].t, n: store[id].n };
        })
      : [];

    chunk(normals, MAX_BATCH_EVENTS).forEach(function (group) {
      jobs.push(sendChunk(transport, group, reason).then(function (r) {
        if (r.cls === 'normal' && r.ok) removeNormalIds(group.map(function (e) { return e.id; }));
        return r;
      }));
    });
    chunk(criticals, MAX_BATCH_EVENTS).forEach(function (group) {
      jobs.push(sendChunk(transport, group, reason));
    });
    return Promise.all(jobs).then(function (flat) {
      state.lastResults = flat;
      return { reason: reason, transport: transport, batches: flat.length, results: flat };
    });
  }

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  function doRecover() {
    var jobs = [];
    var all = [];
    var store = readPending();
    var ids = Object.keys(store);
    if (ids.length === 0) {
      return Promise.resolve({ leader: true, events: 0, batches: 0 });
    }
    chunk(ids, MAX_BATCH_EVENTS).forEach(function (group) {
      var evts = group.map(function (id) { return { id: id, c: 'critical', t: store[id].t, n: store[id].n }; });
      all.push(evts);
      jobs.push(sendChunk('fetch', evts, 'recover'));
    });
    return Promise.all(jobs).then(function (rs) {
      var acked = rs.reduce(function (a, r) { return a + r.acked; }, 0);
      bumpStats({ recovered_events: acked, recovered_batches: rs.length });
      return { leader: true, events: acked, batches: rs.length };
    });
  }

  /** 选主 + 补发：返回 {leader:boolean, ...}。 */
  function recover() {
    bumpStats({ recover_runs: 1 });
    var leader = state.cfg.leader;
    if (leader === 'none') {
      bumpStats({ recover_leader: 1 });
      return doRecover();
    }
    if (leader === 'locks') {
      if (!navigator.locks || !navigator.locks.request) {
        tracePush({ k: 'leader', kind: 'locks', err: 'unsupported' });
        bumpStats({ recover_leader: 1 });
        return doRecover();
      }
      return navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, function (lock) {
        if (!lock) {
          bumpStats({ recover_not_leader: 1 });
          tracePush({ k: 'leader', kind: 'locks', got: false });
          return { leader: false };
        }
        tracePush({ k: 'leader', kind: 'locks', got: true });
        bumpStats({ recover_leader: 1 });
        return doRecover();
      });
    }
    // BroadcastChannel（朴素实现：广播 claim，等 settle 窗口，收到更优先的 claim 就退出）
    return new Promise(function (resolve) {
      if (!state.bc) {
        bumpStats({ recover_leader: 1 });
        resolve(doRecover());
        return;
      }
      var mine = { ts: Date.now(), id: TAB_ID };
      var denied = false;
      var handler = function (ev) {
        var d = ev.data;
        if (!d || d.type !== 'claim' || d.id === TAB_ID) return;
        if (d.ts < mine.ts || (d.ts === mine.ts && d.id < mine.id)) denied = true;
      };
      state.bc.addEventListener('message', handler);
      try {
        state.bc.postMessage({ type: 'claim', ts: mine.ts, id: TAB_ID });
      } catch (e) {
        /* ignore */
      }
      sleep(state.cfg.bcSettleMs).then(function () {
        state.bc.removeEventListener('message', handler);
        if (denied) {
          bumpStats({ recover_not_leader: 1 });
          tracePush({ k: 'leader', kind: 'bc', got: false, settle: state.cfg.bcSettleMs });
          resolve({ leader: false });
          return;
        }
        bumpStats({ recover_leader: 1 });
        tracePush({ k: 'leader', kind: 'bc', got: true, settle: state.cfg.bcSettleMs });
        resolve(doRecover());
      });
    });
  }

  function track(ids, cls, name) {
    var now = Date.now();
    if (cls === 'critical') {
      var store = readPending();
      var cap = state.cfg.pendingCap;
      var added = 0;
      var dropped = 0;
      for (var i = 0; i < ids.length; i++) {
        if (Object.keys(store).length >= cap) {
          dropped++;
          continue;
        }
        store[ids[i]] = { t: now, n: name || 'poc_reliability_probe' };
        added++;
      }
      try {
        writeJSON(K_PENDING, store);
        bumpStats({ prewrite_ok: added, enqueued_critical: ids.length, dropped_critical_cap: dropped });
      } catch (e) {
        bumpStats({ prewrite_failed_quota: added, enqueued_critical: ids.length, dropped_critical_cap: dropped });
      }
      return { added: added, dropped: dropped };
    }
    var capN = state.cfg.normalCap;
    var accepted = 0;
    var droppedN = 0;
    for (var j = 0; j < ids.length; j++) {
      if (state.queue.length >= capN) {
        droppedN++;
        continue;
      }
      state.queue.push({ id: ids[j], c: 'normal', t: now, n: name || 'poc_reliability_probe' });
      accepted++;
    }
    bumpStats({ enqueued_normal: ids.length, dropped_normal_cap: droppedN });
    return { added: accepted, dropped: droppedN };
  }

  function init(cfg) {
    state.cfg = {
      endpoint: cfg.endpoint,
      appId: cfg.appId,
      token: cfg.token,
      leader: cfg.leader || 'none',
      bcSettleMs: typeof cfg.bcSettleMs === 'number' ? cfg.bcSettleMs : 150,
      pendingCap: cfg.pendingCap || 5000,
      normalCap: cfg.normalCap || 500,
      leaveTrigger: (cfg.leave && cfg.leave.trigger) || 'none',
      leaveTransport: (cfg.leave && cfg.leave.transport) || 'beacon'
    };
    if (state.cfg.leader === 'bc' && typeof BroadcastChannel === 'function') {
      state.bc = new BroadcastChannel(BC_NAME);
    }
    if (state.cfg.leaveTrigger === 'visibilitychange') {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
          flush('visibilitychange', state.cfg.leaveTransport, {});
        }
      });
    }
    if (state.cfg.leaveTrigger === 'pagehide') {
      window.addEventListener('pagehide', function () {
        flush('pagehide', state.cfg.leaveTransport, {});
      });
    }
    if (cfg.autoRecover) {
      // 真实 SDK 的重连处理：先把内存里的 normal 队列冲出去，再补发离线副本。
      window.addEventListener('online', function () {
        flush('online', 'fetch', { includeCritical: false });
        recover();
      });
      recover();
    }
    tracePush({ k: 'init', trigger: state.cfg.leaveTrigger, transport: state.cfg.leaveTransport, leader: state.cfg.leader });
    return { tabId: TAB_ID, visibility: document.visibilityState };
  }

  function stats() {
    var meta = aggregateMeta();
    var out = {};
    for (var k in DEFAULT_STATS) out[k] = meta.stats[k] || 0;
    for (var k2 in meta.stats) if (!(k2 in out)) out[k2] = meta.stats[k2];
    out.pending = Object.keys(readPending()).length;
    out.normal_queue = state.queue.length;
    out.tab_id = TAB_ID;
    out.visibility = document.visibilityState;
    out.leader_lost = state.leaderLost;
    out.pages_with_stats = countMetaKeys();
    return out;
  }

  function countMetaKeys() {
    var n = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(META_PREFIX) === 0) n++;
      }
    } catch (e) {
      /* ignore */
    }
    return n;
  }

  /** 只看本页面载入自己的计数（多标签页诊断用，避免被其它标签页聚合掉）。 */
  function statsOwn() {
    var meta = readMeta();
    var out = {};
    for (var k in DEFAULT_STATS) out[k] = meta.stats[k] || 0;
    for (var k2 in meta.stats) if (!(k2 in out)) out[k2] = meta.stats[k2];
    out.pending = Object.keys(readPending()).length;
    out.normal_queue = state.queue.length;
    out.tab_id = TAB_ID;
    out.visibility = document.visibilityState;
    return out;
  }

  function trace() {
    return aggregateMeta().trace;
  }

  function trace() {
    return readMeta().trace;
  }

  function pendingIds() {
    return Object.keys(readPending());
  }

  function resetAll() {
    localStorage.removeItem(K_PENDING);
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(META_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {
      /* ignore */
    }
    state.queue = [];
  }

  window.__poc = {
    init: init,
    track: track,
    flush: flush,
    recover: recover,
    stats: stats,
    statsOwn: statsOwn,
    trace: trace,
    pendingIds: pendingIds,
    resetAll: resetAll,
    version: 'poc1-1'
  };
})();
