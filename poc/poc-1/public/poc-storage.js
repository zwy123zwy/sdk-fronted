/**
 * POC-1 追加轮：离线副本的可切换存储实现（只用于测量，不是正式包代码）。
 *
 * 统一接口（同步或异步，全部返回 Promise）：
 *   create(mode, opts) -> store
 *   store.init()            准备（打开 DB / 启动 worker）
 *   store.put(records)      写入；**Promise resolve 的那一刻定义为「落盘点」**
 *   store.all()             读回全部记录 [{id,t,n}]
 *   store.remove(ids)       删除已确认的
 *   store.clear()           清空
 *   store.estimate()        配额估算 {usage, quota} 或 null
 *   store.info()            能力探测信息（供报告记录）
 *
 * 支持的模式：
 *   local         localStorage.setItem（基线；setItem 返回即算「落盘点」，这正是问题所在）
 *   idb           IndexedDB 显式事务，tx.oncomplete 才算落盘
 *   idb-strict    同上，但事务带 {durability:'strict'}（强制刷盘后才 complete）
 *   idb-pending   对照：事务打开但故意不提交（永远不会 complete）
 *   opfs          OPFS，写进 **每标签页一个文件** pending-<tabId>.json，close() 才算落盘
 *   opfs-shared   对照：所有标签页写同一个 pending.json（朴素实现，会互相覆盖）
 *   opfs-pending  对照：worker 里写入但不 close()
 */
(function () {
  'use strict';

  var LOCAL_KEY = 'wr.poc.pending.v1';
  var IDB_NAME = 'wr-poc-storage';
  var IDB_STORE = 'pending';
  var OPFS_PREFIX = 'pending';
  var DEFAULT_DEFER_MS = 60000;

  // ---------------------------------------------------------------- localStorage
  function createLocalStore() {
    return {
      mode: 'local',
      init: function () { return Promise.resolve(); },
      put: function (records) {
        var map = {};
        try {
          var raw = localStorage.getItem(LOCAL_KEY);
          if (raw) map = JSON.parse(raw) || {};
        } catch (e) { map = {}; }
        for (var i = 0; i < records.length; i++) map[records[i].id] = { t: records[i].t, n: records[i].n };
        localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
        return Promise.resolve();
      },
      all: function () {
        var raw = localStorage.getItem(LOCAL_KEY);
        var map = raw ? JSON.parse(raw) : {};
        return Promise.resolve(Object.keys(map).map(function (id) { return { id: id, t: map[id].t, n: map[id].n }; }));
      },
      remove: function (ids) {
        var raw = localStorage.getItem(LOCAL_KEY);
        var map = raw ? JSON.parse(raw) : {};
        ids.forEach(function (id) { delete map[id]; });
        localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
        return Promise.resolve();
      },
      clear: function () { localStorage.removeItem(LOCAL_KEY); return Promise.resolve(); },
      estimate: function () {
        return navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null);
      },
      info: function () { return { mode: 'local', durablePoint: 'setItem 返回（不代表落盘）' }; }
    };
  }

  // ---------------------------------------------------------------- IndexedDB
  function openIdb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
    });
  }

  function createIdbStore(opts) {
    opts = opts || {};
    var deferred = !!opts.deferredCommit;
    var durability = opts.durability || null;
    var durabilitySupported = null;
    var db = null;

    function begin(mode) {
      if (!durability) return db.transaction(IDB_STORE, mode);
      try {
        var tx = db.transaction(IDB_STORE, mode, { durability: durability });
        durabilitySupported = true;
        return tx;
      } catch (e) {
        durabilitySupported = false;
        return db.transaction(IDB_STORE, mode);
      }
    }

    return {
      mode: opts.mode,
      init: function () {
        return openIdb().then(function (d) { db = d; });
      },
      put: function (records) {
        return new Promise(function (resolve, reject) {
          var tx = begin('readwrite');
          var store = tx.objectStore(IDB_STORE);
          var write = function () {
            for (var i = 0; i < records.length; i++) {
              store.put({ id: records[i].id, t: records[i].t, n: records[i].n });
            }
          };
          if (deferred) {
            // 对照格：写入推迟到 60 s 之后，强杀时事务根本还没开始/未完成
            // （IndexedDB 的事务在没有待处理请求时会自动提交，所以「故意不提交」只能这样模拟）
            setTimeout(function () { write(); }, DEFAULT_DEFER_MS);
            setTimeout(function () { reject(new Error('deferred commit never completed')); }, DEFAULT_DEFER_MS + 1000);
            return;
          }
          write();
          txDone(tx).then(resolve, reject);
        });
      },
      all: function () {
        return new Promise(function (resolve, reject) {
          var tx = begin('readonly');
          var req = tx.objectStore(IDB_STORE).getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        });
      },
      remove: function (ids) {
        return new Promise(function (resolve, reject) {
          var tx = begin('readwrite');
          var store = tx.objectStore(IDB_STORE);
          ids.forEach(function (id) { store.delete(id); });
          txDone(tx).then(resolve, reject);
        });
      },
      clear: function () {
        return new Promise(function (resolve, reject) {
          var tx = begin('readwrite');
          tx.objectStore(IDB_STORE).clear();
          txDone(tx).then(resolve, reject);
        });
      },
      estimate: function () {
        return navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null);
      },
      info: function () {
        return {
          mode: opts.mode,
          durability: durability,
          durabilitySupported: durabilitySupported,
          deferredCommit: deferred,
          durablePoint: deferred ? '（对照：写入推迟 60 s，观测时未完成）' : 'tx.oncomplete'
        };
      }
    };
  }

  // ---------------------------------------------------------------- OPFS
  function createOpfsStore(opts) {
    opts = opts || {};
    var perTab = opts.perTab !== false;
    var writeOpts = opts.writeOpts || {};
    var worker = null;
    var seq = 0;
    var pendingReplies = {};
    var fileForTab = null;
    var supported = typeof Worker === 'function' && !!navigator.storage && !!navigator.storage.getDirectory;

    function ensureWorker() {
      if (worker) return;
      worker = new Worker('./opfs-worker.js');
      worker.onmessage = function (ev) {
        var msg = ev.data || {};
        var cb = pendingReplies[msg.reqId];
        if (!cb) return;
        delete pendingReplies[msg.reqId];
        if (msg.ok) cb.resolve(msg.result);
        else cb.reject(new Error(msg.error || 'opfs worker error'));
      };
      worker.onerror = function (ev) {
        Object.keys(pendingReplies).forEach(function (k) {
          pendingReplies[k].reject(new Error('opfs worker crashed: ' + (ev && ev.message)));
          delete pendingReplies[k];
        });
      };
    }

    function call(op, payload) {
      if (!supported) return Promise.reject(new Error('OPFS 不可用'));
      ensureWorker();
      var reqId = ++seq;
      return new Promise(function (resolve, reject) {
        pendingReplies[reqId] = { resolve: resolve, reject: reject };
        worker.postMessage(Object.assign({ reqId: reqId, op: op }, payload || {}));
      });
    }

    function myFile() {
      if (!perTab) return OPFS_PREFIX + '.json';
      if (!fileForTab) fileForTab = OPFS_PREFIX + '-' + Math.random().toString(36).slice(2, 10) + '.json';
      return fileForTab;
    }

    function readAll() {
      return call('list', { prefix: OPFS_PREFIX }).then(function (names) {
        return Promise.all(
          names.map(function (name) {
            return call('get', { file: name }).then(function (text) {
              if (!text) return [];
              try {
                var map = JSON.parse(text);
                return Object.keys(map).map(function (id) { return { id: id, t: map[id].t, n: map[id].n }; });
              } catch (e) {
                return [];
              }
            });
          })
        ).then(function (lists) {
          var out = [];
          lists.forEach(function (l) { out = out.concat(l); });
          return out;
        });
      });
    }

    return {
      mode: opts.mode,
      init: function () {
        return call('probe', {}).then(function () { return undefined; });
      },
      put: function (records) {
        // 写入 = 读本文件 → 合并 → 覆盖写回（朴素实现：没有跨标签页锁，
        // opfs-shared 模式下多个标签页写同一个文件会互相覆盖）
        var file = myFile();
        return call('get', { file: file }).then(function (text) {
          var map = {};
          try { map = text ? JSON.parse(text) : {}; } catch (e) { map = {}; }
          for (var i = 0; i < records.length; i++) {
            map[records[i].id] = { t: records[i].t, n: records[i].n };
          }
          return call('put', { file: file, text: JSON.stringify(map), opts: writeOpts });
        });
      },
      all: function () { return readAll(); },
      remove: function (ids) {
        // 只重写「确实包含这些 id」的文件
        return call('list', { prefix: OPFS_PREFIX }).then(function (names) {
          return Promise.all(
            names.map(function (name) {
              return call('get', { file: name }).then(function (text) {
                var map = {};
                try { map = text ? JSON.parse(text) : {}; } catch (e) { map = {}; }
                var changed = false;
                ids.forEach(function (id) { if (map[id]) { delete map[id]; changed = true; } });
                if (!changed) return null;
                return call('put', { file: name, text: JSON.stringify(map), opts: {} });
              });
            })
          );
        }).then(function () { return undefined; });
      },
      clear: function () { return call('clear', { prefix: OPFS_PREFIX }); },
      estimate: function () {
        return navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null);
      },
      info: function () {
        return {
          mode: opts.mode,
          perTab: perTab,
          writeOpts: writeOpts,
          supported: supported,
          durablePoint: opts.durablePoint || 'createSyncAccessHandle: flush() + close()'
        };
      }
    };
  }

  window.__pocStorage = {
    create: function (mode, opts) {
      if (mode === 'local') return createLocalStore();
      if (mode === 'idb') return createIdbStore({ mode: 'idb' });
      if (mode === 'idb-strict') return createIdbStore({ mode: 'idb-strict', durability: 'strict' });
      if (mode === 'idb-pending') return createIdbStore({ mode: 'idb-pending', deferredCommit: true });
      if (mode === 'opfs') return createOpfsStore({ mode: 'opfs', perTab: true });
      if (mode === 'opfs-shared') return createOpfsStore({ mode: 'opfs-shared', perTab: false });
      if (mode === 'opfs-pending') {
        // 对照：整个写入推迟 60 s（强杀时「写」还没发生）
        return createOpfsStore({
          mode: 'opfs-pending',
          perTab: true,
          writeOpts: { deferWriteMs: DEFAULT_DEFER_MS },
          durablePoint: '（对照：写入被推迟 60 s，观测时未完成）'
        });
      }
      if (mode === 'opfs-noclose') {
        // 对照：已 write + flush，但不 close
        return createOpfsStore({
          mode: 'opfs-noclose',
          perTab: true,
          writeOpts: { deferCloseMs: DEFAULT_DEFER_MS },
          durablePoint: '（对照：flush 已完成，close 被推迟）'
        });
      }
      throw new Error('未知存储模式：' + mode);
    },
    supportedModes: ['local', 'idb', 'idb-strict', 'idb-pending', 'opfs', 'opfs-shared', 'opfs-pending', 'opfs-noclose']
  };
})();
