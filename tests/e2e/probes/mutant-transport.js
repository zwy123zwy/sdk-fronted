// src/batch/promote.ts
var OPTIONAL_EVENT_FIELDS = [
  "sample_rate",
  "page_id",
  "view_id",
  "url",
  "level",
  "dimensions",
  "metrics",
  "context",
  "attachment",
  "truncated",
  "retry_count",
  "replayed"
];
var PROMOTABLE_FIELDS = ["page_id", "view_id", "url", "sample_rate", "context"];
function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}
function asRecord(value) {
  return value;
}
function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== "object" || left === null) return false;
  if (typeof right !== "object" || right === null) return false;
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  for (const key of leftKeys) {
    if (!hasOwn(rightRecord, key)) return false;
    if (!deepEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}
function projectEvent(event, omitted) {
  const projected = {
    event_id: event.event_id,
    event_name: event.event_name,
    event_type: event.event_type,
    schema_version: event.schema_version,
    occurred_at: event.occurred_at,
    priority: event.priority
  };
  for (const field of OPTIONAL_EVENT_FIELDS) {
    if (omitted !== void 0 && hasOwn(omitted, field)) continue;
    const value = event[field];
    if (value !== void 0) projected[field] = value;
  }
  return projected;
}
function promoteCommonFields(events) {
  const first = events[0];
  if (first === void 0) return { common: void 0, events: [] };
  const shared = {};
  let promoted = false;
  for (const field of PROMOTABLE_FIELDS) {
    const value = first[field];
    if (value === void 0) continue;
    if (!events.every((event) => deepEqual(event[field], value))) continue;
    shared[field] = value;
    promoted = true;
  }
  if (!promoted) {
    return { common: void 0, events: events.map((event) => projectEvent(event)) };
  }
  return {
    common: shared,
    events: events.map((event) => projectEvent(event, shared))
  };
}

// src/batch/assembler.ts
var UUID_VARIANT_MIN = 8;
function randomHex(length) {
  let output = "";
  while (output.length < length) output += Math.floor(Math.random() * 16).toString(16);
  return output;
}
function fallbackUuidV4() {
  const variant = (UUID_VARIANT_MIN + Math.floor(Math.random() * 4)).toString(16);
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-${variant}${randomHex(3)}-${randomHex(12)}`;
}
function defaultCreateId() {
  const source = globalThis.crypto;
  if (source !== void 0 && typeof source.randomUUID === "function") return source.randomUUID();
  return fallbackUuidV4();
}
function createBatchAssembler(options) {
  const headerSource = options.header;
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? defaultCreateId;
  return {
    assemble(events) {
      if (events.length === 0) {
        throw new Error("\u6279\u6B21\u81F3\u5C11\u8981\u6709\u4E00\u6761\u4E8B\u4EF6\uFF08batch.schema.json \u7684 events.minItems \u4E3A 1\uFF09");
      }
      const promoted = promoteCommonFields(events);
      const envelope = {
        ...headerSource.header(),
        batch_id: createId(),
        sent_at: now(),
        events: promoted.events
      };
      if (promoted.common === void 0) return envelope;
      return { ...envelope, common: promoted.common };
    }
  };
}

// src/queue/page-lifecycle.ts
function createDomPageLeaveSource(target) {
  return {
    subscribe(handler) {
      const onVisibilityChange = () => {
        if (target.visibilityState === "hidden") handler("hidden");
      };
      const onPageHide = () => {
        handler("pagehide");
      };
      target.addEventListener("visibilitychange", onVisibilityChange);
      target.addEventListener("pagehide", onPageHide);
      return () => {
        target.removeEventListener("visibilitychange", onVisibilityChange);
        target.removeEventListener("pagehide", onPageHide);
      };
    }
  };
}

// src/queue/constants.ts
var QUEUE_MAX_EVENTS = 500;
var QUEUE_MAX_BYTES = 512 * 1024;
var DEFAULT_MAX_BATCH_EVENTS = 20;
var DEFAULT_MAX_BATCH_BYTES = 32 * 1024;
var DEFAULT_IDLE_FLUSH_MS = 1e3;
var DEFAULT_MAX_WAIT_MS = 5e3;
var DEFAULT_REPLAY_BATCHES_PER_SECOND = 1;
var LIMIT_RANGES = {
  maxBatchEvents: { min: 1, max: 100 },
  maxBatchBytes: { min: 1024, max: 61440 },
  idleFlushMs: { min: 200, max: 1e4 },
  maxWaitMs: { min: 1e3, max: 6e4 }
};
var REPLAY_BATCHES_PER_SECOND_MAX = 2;
var DEFAULT_SLOW_EFFECTIVE_TYPES = ["slow-2g", "2g"];
var DEFAULT_WEAK_BATCH_EVENTS_MULTIPLIER = 2;
var DEFAULT_WEAK_IDLE_FLUSH_MS_MULTIPLIER = 2;
var DEFAULT_WEAK_NETWORK_POLICY = {
  slowEffectiveTypes: DEFAULT_SLOW_EFFECTIVE_TYPES,
  batchEventsMultiplier: DEFAULT_WEAK_BATCH_EVENTS_MULTIPLIER,
  idleFlushMsMultiplier: DEFAULT_WEAK_IDLE_FLUSH_MS_MULTIPLIER
};
var REASON_QUEUE_EVICTED = "queue_evicted";
var REASON_STORAGE_UNAVAILABLE = "storage_unavailable";
var REASON_CIRCUIT_OPEN = "circuit_open";
var REASON_PROCESSOR_ERROR = "processor_error";

// src/queue/size.ts
var STRING_QUOTES = 2;
var NUMBER_SIZE = 20;
var BOOLEAN_SIZE = 5;
var NULL_SIZE = 4;
var OBJECT_BRACES = 2;
var ARRAY_BRACKETS = 2;
var ENTRY_OVERHEAD = 4;
function isUnknownArray(value) {
  return Array.isArray(value);
}
function asRecord2(value) {
  return value;
}
function estimateValue(value) {
  if (value === void 0) return 0;
  if (value === null) return NULL_SIZE;
  if (typeof value === "string") return value.length + STRING_QUOTES;
  if (typeof value === "number") return NUMBER_SIZE;
  if (typeof value === "boolean") return BOOLEAN_SIZE;
  if (isUnknownArray(value)) {
    let total = ARRAY_BRACKETS;
    for (const item of value) total += estimateValue(item) + 1;
    return total;
  }
  if (typeof value === "object") return estimateRecord(asRecord2(value));
  return 0;
}
function estimateRecord(record) {
  let total = OBJECT_BRACES;
  for (const [key, value] of Object.entries(record)) {
    total += key.length + ENTRY_OVERHEAD + estimateValue(value);
  }
  return total;
}
function estimateEventBytes(event) {
  return estimateRecord(event);
}

// src/queue/memory-queue.ts
var noopCounters = {
  count: () => void 0
};
var COMPACT_THRESHOLD = 64;
function createMemoryQueue(options = {}) {
  const maxEvents = options.maxEvents ?? QUEUE_MAX_EVENTS;
  const maxBytes = options.maxBytes ?? QUEUE_MAX_BYTES;
  const counters = options.counters ?? noopCounters;
  const measure = options.measure ?? estimateEventBytes;
  const offline = options.offline;
  let events = [];
  let sizes = [];
  let head = 0;
  let totalBytes = 0;
  function length() {
    return events.length - head;
  }
  function overLimit() {
    return length() > maxEvents || totalBytes > maxBytes;
  }
  function compactIfNeeded() {
    if (head > COMPACT_THRESHOLD && head * 2 >= events.length) {
      events = events.slice(head);
      sizes = sizes.slice(head);
      head = 0;
    }
  }
  function firstNormalIndex() {
    for (let index = head; index < events.length; index += 1) {
      const event = events[index];
      if (event !== void 0 && event.priority !== "critical") return index;
    }
    return -1;
  }
  function removeAt(index) {
    const removed = events[index];
    if (removed === void 0) return void 0;
    const removedSize = sizes[index] ?? 0;
    if (index === head) {
      head += 1;
    } else if (index === events.length - 1) {
      events.pop();
      sizes.pop();
    } else {
      events.splice(index, 1);
      sizes.splice(index, 1);
    }
    totalBytes -= removedSize;
    compactIfNeeded();
    return removed;
  }
  function spill(event) {
    if (offline !== void 0) {
      try {
        if (offline.spill(event, "queue_overflow")) return true;
      } catch {
      }
    }
    counters.count(REASON_STORAGE_UNAVAILABLE);
    return false;
  }
  return {
    push(event) {
      const size = measure(event);
      events.push(event);
      sizes.push(size);
      totalBytes += size;
      const evicted = [];
      while (overLimit()) {
        const index = firstNormalIndex();
        if (index < 0) break;
        const removed = removeAt(index);
        if (removed === void 0) break;
        evicted.push(removed);
        counters.count(REASON_QUEUE_EVICTED);
      }
      if (overLimit()) {
        removeAt(events.length - 1);
        const accepted = spill(event);
        return {
          status: accepted ? "spilled" : "spill_failed",
          event,
          evicted: evicted.length > 0 ? evicted : void 0
        };
      }
      const pushedEvicted = evicted.some((item) => item.event_id === event.event_id);
      return {
        status: pushedEvicted ? "rejected" : evicted.length > 0 ? "evicted" : "queued",
        event,
        evicted: evicted.length > 0 ? evicted : void 0
      };
    },
    drainUpTo(limitEvents, limitBytes) {
      const available = length();
      let count = 0;
      let bytes = 0;
      while (count < limitEvents && count < available) {
        const size = sizes[head + count] ?? 0;
        if (count > 0 && bytes + size > limitBytes) break;
        bytes += size;
        count += 1;
      }
      const taken = events.slice(head, head + count);
      head += count;
      totalBytes -= bytes;
      compactIfNeeded();
      return { events: taken, bytes };
    },
    size() {
      return length();
    },
    bytes() {
      return totalBytes;
    },
    clear() {
      events = [];
      sizes = [];
      head = 0;
      totalBytes = 0;
    }
  };
}

// src/queue/settings.ts
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function rangedInteger(value, min, max, fallback) {
  if (value === void 0 || !Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}
function rangedNumber(value, min, max, fallback) {
  if (value === void 0 || !Number.isFinite(value) || value <= min || value > max) return fallback;
  return value;
}
function multiplier(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}
function resolveLimits(settings, network, policy = DEFAULT_WEAK_NETWORK_POLICY) {
  const maxBatchEvents = rangedInteger(
    settings.max_batch_events,
    LIMIT_RANGES.maxBatchEvents.min,
    LIMIT_RANGES.maxBatchEvents.max,
    DEFAULT_MAX_BATCH_EVENTS
  );
  const maxBatchBytes = rangedInteger(
    settings.max_batch_bytes,
    LIMIT_RANGES.maxBatchBytes.min,
    LIMIT_RANGES.maxBatchBytes.max,
    DEFAULT_MAX_BATCH_BYTES
  );
  const idleFlushMs = rangedInteger(
    settings.idle_flush_ms,
    LIMIT_RANGES.idleFlushMs.min,
    LIMIT_RANGES.idleFlushMs.max,
    DEFAULT_IDLE_FLUSH_MS
  );
  const maxWaitMs = rangedInteger(
    settings.max_wait_ms,
    LIMIT_RANGES.maxWaitMs.min,
    LIMIT_RANGES.maxWaitMs.max,
    DEFAULT_MAX_WAIT_MS
  );
  const replayBatchesPerSecond = rangedNumber(
    settings.replay_batches_per_second,
    0,
    REPLAY_BATCHES_PER_SECOND_MAX,
    DEFAULT_REPLAY_BATCHES_PER_SECOND
  );
  const slowTypes = policy.slowEffectiveTypes ?? DEFAULT_SLOW_EFFECTIVE_TYPES;
  const effectiveType = network.effectiveType;
  const weakNetwork = effectiveType !== void 0 && slowTypes.includes(effectiveType) || network.saveData === true;
  if (!weakNetwork) {
    return {
      maxBatchEvents,
      maxBatchBytes,
      idleFlushMs,
      maxWaitMs,
      replayBatchesPerSecond,
      weakNetwork: false
    };
  }
  return {
    maxBatchEvents: clamp(
      Math.round(
        maxBatchEvents * multiplier(policy.batchEventsMultiplier ?? DEFAULT_WEAK_BATCH_EVENTS_MULTIPLIER)
      ),
      LIMIT_RANGES.maxBatchEvents.min,
      LIMIT_RANGES.maxBatchEvents.max
    ),
    maxBatchBytes,
    idleFlushMs: clamp(
      Math.round(
        idleFlushMs * multiplier(policy.idleFlushMsMultiplier ?? DEFAULT_WEAK_IDLE_FLUSH_MS_MULTIPLIER)
      ),
      LIMIT_RANGES.idleFlushMs.min,
      LIMIT_RANGES.idleFlushMs.max
    ),
    maxWaitMs,
    replayBatchesPerSecond,
    weakNetwork: true
  };
}

// src/queue/transport-queue.ts
var noopCounters2 = {
  count: () => void 0
};
function createTransportQueue(options) {
  const counters = options.counters ?? noopCounters2;
  const policy = options.weakNetwork ?? DEFAULT_WEAK_NETWORK_POLICY;
  const assembler = createBatchAssembler({
    header: options.header,
    now: options.now,
    createId: options.createId
  });
  const queue = createMemoryQueue({
    maxEvents: options.maxQueueEvents,
    maxBytes: options.maxQueueBytes,
    measure: options.measure,
    counters,
    offline: options.offline
  });
  let idleTimer = null;
  let maxWaitTimer = null;
  let inFlightCount = 0;
  let circuitOpen = false;
  let disposed = false;
  let pumping = false;
  function limits() {
    const snapshot = options.network === void 0 ? {} : options.network.snapshot();
    return resolveLimits(options.config.transport(), snapshot, policy);
  }
  function isDisposed() {
    return disposed;
  }
  function isCircuitOpen() {
    return circuitOpen;
  }
  function clearTimers() {
    if (idleTimer !== null) {
      globalThis.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (maxWaitTimer !== null) {
      globalThis.clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }
  function armTimers() {
    if (disposed || circuitOpen || queue.size() === 0) {
      clearTimers();
      return;
    }
    const current = limits();
    if (maxWaitTimer === null) {
      maxWaitTimer = globalThis.setTimeout(() => {
        maxWaitTimer = null;
        attemptFlush("max_wait");
      }, current.maxWaitMs);
    }
    if (idleTimer !== null) globalThis.clearTimeout(idleTimer);
    idleTimer = globalThis.setTimeout(() => {
      idleTimer = null;
      attemptFlush("idle");
    }, current.idleFlushMs);
  }
  function handleComplete(outcome) {
    if (outcome === "circuit_open") {
      circuitOpen = true;
      counters.count(REASON_CIRCUIT_OPEN);
    }
    if (disposed) return;
    if (queue.size() > 0) {
      armTimers();
      if (!circuitOpen && inFlightCount === 0) pump("resume");
      return;
    }
    clearTimers();
  }
  function submitSlice(events, channel) {
    let batch;
    try {
      batch = assembler.assemble(events);
    } catch {
      counters.count(REASON_PROCESSOR_ERROR);
      return null;
    }
    inFlightCount += 1;
    const inFlightBefore = inFlightCount;
    let settled = false;
    const complete = (outcome) => {
      if (settled) return;
      settled = true;
      inFlightCount -= 1;
      handleComplete(outcome);
    };
    const context = { channel, complete };
    try {
      options.submit.submit(batch, context);
    } catch {
      if (inFlightCount === inFlightBefore) inFlightCount -= 1;
      counters.count(REASON_PROCESSOR_ERROR);
      return null;
    }
    return batch;
  }
  function pump(reason) {
    if (disposed) return { status: "empty", reason };
    if (circuitOpen) return { status: "circuit_open", reason };
    if (queue.size() === 0) return { status: "empty", reason };
    if (inFlightCount > 0 || pumping) return { status: "in_flight", reason };
    pumping = true;
    let firstBatch = null;
    try {
      while (!isDisposed() && !isCircuitOpen() && inFlightCount === 0 && queue.size() > 0) {
        const current = limits();
        const slice = queue.drainUpTo(current.maxBatchEvents, current.maxBatchBytes);
        if (slice.events.length === 0) break;
        clearTimers();
        const batch = submitSlice(slice.events, "default");
        if (batch === null) continue;
        if (firstBatch === null) firstBatch = batch;
      }
    } finally {
      pumping = false;
    }
    if (firstBatch === null) return { status: "empty", reason };
    return { status: "submitted", reason, batch: firstBatch };
  }
  function attemptFlush(reason) {
    if (disposed) return { status: "empty", reason };
    if (queue.size() === 0) return { status: "empty", reason };
    if (circuitOpen) return { status: "circuit_open", reason };
    if (inFlightCount > 0) return { status: "in_flight", reason };
    return pump(reason);
  }
  function flushPageLeave() {
    if (disposed) return;
    while (!isDisposed() && queue.size() > 0) {
      const current = limits();
      const slice = queue.drainUpTo(current.maxBatchEvents, current.maxBatchBytes);
      if (slice.events.length === 0) break;
      submitSlice(slice.events, "page_leave");
    }
    clearTimers();
  }
  const disposePageLeave = options.pageLeave === void 0 ? null : options.pageLeave.subscribe(() => {
    flushPageLeave();
  });
  function setCircuitOpen(open) {
    circuitOpen = open;
    if (open) {
      clearTimers();
      return;
    }
    if (disposed) return;
    if (queue.size() > 0) {
      armTimers();
      if (inFlightCount === 0) pump("resume");
    }
  }
  return {
    enqueue(event) {
      if (disposed) return { status: "rejected", event };
      const result = queue.push(event);
      if (queue.size() === 0) return result;
      const current = limits();
      const reachedEvents = queue.size() >= current.maxBatchEvents;
      if (reachedEvents || queue.bytes() >= current.maxBatchBytes) {
        pump(reachedEvents ? "events" : "bytes");
      }
      if (queue.size() > 0) armTimers();
      return result;
    },
    flush(reason = "manual") {
      if (disposed) return { status: "empty", reason };
      if (queue.size() === 0) return { status: "empty", reason };
      if (circuitOpen) {
        counters.count(REASON_CIRCUIT_OPEN);
        return { status: "circuit_open", reason };
      }
      if (inFlightCount > 0) return { status: "in_flight", reason };
      return pump(reason);
    },
    inFlight() {
      return inFlightCount > 0;
    },
    isCircuitOpen() {
      return circuitOpen;
    },
    setCircuitOpen,
    queueLength() {
      return queue.size();
    },
    queueBytes() {
      return queue.bytes();
    },
    limits,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimers();
      if (disposePageLeave !== null) disposePageLeave();
    }
  };
}

// src/offline/constants.ts
var OFFLINE_FORMAT_VERSION = 1;
var OFFLINE_DB_NAME = "web-report-sdk-offline";
var OFFLINE_RECORD_STORE = "records";
var OFFLINE_SUMMARY_STORE = "summaries";
var OFFLINE_META_STORE = "meta";
var OFFLINE_DB_VERSION = 1;
var DEFAULT_OFFLINE_LIMITS = {
  maxEvents: 5e3,
  maxBatches: 2e3,
  maxBytes: 5 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1e3,
  commitBatchSize: 100,
  commitIntervalMs: 200
};
var DEFAULT_DEAD_SESSION_MS = 9e4;
var META_INTENT_PREFIX = "intent:";
var META_FORMAT_KEY = "format";
var REASON_OFFLINE_EVICTED = "offline_evicted";
var REASON_OFFLINE_INCOMPATIBLE = "offline_incompatible";
var REASON_STORAGE_UNAVAILABLE2 = "storage_unavailable";
var REASON_PREWRITE_COMMIT_LOST = "prewrite_commit_lost";
var METRIC_EXPOSURE_WINDOW_EVENTS = "exposure_window_events";
var METRIC_EXPOSURE_WINDOW_MS = "exposure_window_ms";

// src/offline/format.ts
var HEADER_BYTES = 256;
function countCriticalEvents(batch) {
  let total = 0;
  for (const event of batch.events) {
    if (event.priority === "critical") total += 1;
  }
  return total;
}
function estimateBatchBytes(batch) {
  let total = HEADER_BYTES;
  for (const event of batch.events) total += estimateEventBytes(event);
  return total;
}
function createOfflineRecord(input) {
  const criticalCount = countCriticalEvents(input.batch);
  return {
    batch_id: input.batch.batch_id,
    format_version: input.formatVersion,
    app_id: input.appId,
    session_id: input.sessionId,
    enqueued_at: input.enqueuedAt,
    committed_at: input.committedAt,
    has_critical: criticalCount > 0,
    event_count: input.batch.events.length,
    critical_count: criticalCount,
    bytes: estimateBatchBytes(input.batch),
    attempt_count: 0,
    last_attempt_at: null,
    batch: input.batch
  };
}
function toSummary(record) {
  return {
    batch_id: record.batch_id,
    format_version: record.format_version,
    enqueued_at: record.enqueued_at,
    has_critical: record.has_critical,
    event_count: record.event_count,
    critical_count: record.critical_count,
    bytes: record.bytes,
    attempt_count: record.attempt_count,
    last_attempt_at: record.last_attempt_at
  };
}
function isRecordCompatible(record, formatVersion) {
  return record.format_version === formatVersion;
}

// src/offline/idb-backend.ts
function resolveFactory(explicit) {
  if (explicit === null) return null;
  if (explicit !== void 0) return explicit;
  const candidate = globalThis.indexedDB;
  return candidate ?? null;
}
function asError(value) {
  if (value instanceof Error) return value;
  return new Error("offline backend failure");
}
function abortQuietly(tx) {
  try {
    tx.abort();
  } catch {
  }
}
function runTransaction(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([...stores], mode);
    } catch (error) {
      reject(asError(error));
      return;
    }
    let result;
    try {
      result = work(tx);
    } catch (error) {
      abortQuietly(tx);
      reject(asError(error));
      return;
    }
    tx.oncomplete = () => {
      resolve(result);
    };
    tx.onerror = () => {
      reject(asError(tx.error));
    };
    tx.onabort = () => {
      reject(asError(tx.error));
    };
  });
}
function createSchema(db) {
  if (!db.objectStoreNames.contains(OFFLINE_RECORD_STORE)) {
    db.createObjectStore(OFFLINE_RECORD_STORE, { keyPath: "batch_id" });
  }
  if (!db.objectStoreNames.contains(OFFLINE_SUMMARY_STORE)) {
    const summaries = db.createObjectStore(OFFLINE_SUMMARY_STORE, { keyPath: "batch_id" });
    summaries.createIndex("by_enqueued_at", "enqueued_at", { unique: false });
  }
  if (!db.objectStoreNames.contains(OFFLINE_META_STORE)) {
    db.createObjectStore(OFFLINE_META_STORE, { keyPath: "key" });
  }
}
function openDatabase(factory, name, version) {
  return new Promise((resolve) => {
    let request;
    try {
      request = factory.open(name, version);
    } catch {
      resolve({ kind: "unavailable" });
      return;
    }
    request.onupgradeneeded = () => {
      createSchema(request.result);
    };
    request.onsuccess = () => {
      resolve({ kind: "ok", db: request.result });
    };
    request.onerror = () => {
      const error = request.error;
      resolve(error !== null && error.name === "VersionError" ? { kind: "incompatible" } : { kind: "unavailable" });
    };
    request.onblocked = () => {
      resolve({ kind: "unavailable" });
    };
  });
}
function deleteDatabase(factory, name) {
  return new Promise((resolve) => {
    let request;
    try {
      request = factory.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      resolve();
    };
    request.onblocked = () => {
      resolve();
    };
  });
}
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}
function isOfflineRecord(value) {
  return isObjectLike(value) && typeof value["batch_id"] === "string" && typeof value["format_version"] === "number" && typeof value["event_count"] === "number" && typeof value["critical_count"] === "number" && typeof value["has_critical"] === "boolean" && typeof value["bytes"] === "number" && typeof value["enqueued_at"] === "number" && isObjectLike(value["batch"]);
}
function isSummary(value) {
  return isObjectLike(value) && typeof value["batch_id"] === "string" && typeof value["format_version"] === "number" && typeof value["enqueued_at"] === "number" && typeof value["has_critical"] === "boolean" && typeof value["event_count"] === "number" && typeof value["bytes"] === "number";
}
function isMetaEntry(value) {
  return isObjectLike(value) && typeof value["key"] === "string" && typeof value["value"] === "string";
}
function toSummaries(values) {
  const summaries = [];
  for (const value of values) {
    if (isSummary(value)) summaries.push(value);
  }
  return summaries;
}
function toMetaEntries(values) {
  const entries = [];
  for (const value of values) {
    if (isMetaEntry(value)) entries.push(value);
  }
  return entries;
}
function createIdbBackend(options = {}) {
  const dbName = options.dbName ?? OFFLINE_DB_NAME;
  const dbVersion = options.dbVersion ?? OFFLINE_DB_VERSION;
  const factory = resolveFactory(options.idbFactory);
  let db = null;
  function requireDb() {
    if (db === null) throw new Error("offline database is not open");
    return db;
  }
  function attachVersionGuard(handle) {
    handle.onversionchange = () => {
      handle.close();
      db = null;
    };
  }
  return {
    open() {
      if (factory === null) return Promise.resolve("unavailable");
      return openDatabase(factory, dbName, dbVersion).then((outcome) => {
        if (outcome.kind === "ok") {
          db = outcome.db;
          attachVersionGuard(outcome.db);
          return "ok";
        }
        return outcome.kind;
      });
    },
    reset() {
      if (db !== null) {
        db.close();
        db = null;
      }
      if (factory === null) return Promise.resolve();
      return deleteDatabase(factory, dbName);
    },
    commit(records, metas) {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_RECORD_STORE, OFFLINE_SUMMARY_STORE, OFFLINE_META_STORE],
        "readwrite",
        (tx) => {
          const recordStore = tx.objectStore(OFFLINE_RECORD_STORE);
          const summaryStore = tx.objectStore(OFFLINE_SUMMARY_STORE);
          for (const record of records) {
            recordStore.put(record);
            summaryStore.put(toSummary(record));
          }
          if (metas !== void 0) {
            const metaStore = tx.objectStore(OFFLINE_META_STORE);
            for (const entry of metas) metaStore.put(entry);
          }
        }
      );
    },
    putSummaries(summaries) {
      const handle = requireDb();
      return runTransaction(handle, [OFFLINE_SUMMARY_STORE], "readwrite", (tx) => {
        const store = tx.objectStore(OFFLINE_SUMMARY_STORE);
        for (const summary of summaries) store.put(summary);
      });
    },
    readSummaries(limit) {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_SUMMARY_STORE],
        "readonly",
        (tx) => tx.objectStore(OFFLINE_SUMMARY_STORE).getAll(void 0, limit)
      ).then((request) => toSummaries(request.result));
    },
    read(batchId) {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_RECORD_STORE],
        "readonly",
        (tx) => tx.objectStore(OFFLINE_RECORD_STORE).get(batchId)
      ).then((request) => isOfflineRecord(request.result) ? request.result : null);
    },
    remove(batchIds) {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_RECORD_STORE, OFFLINE_SUMMARY_STORE],
        "readwrite",
        (tx) => {
          const recordStore = tx.objectStore(OFFLINE_RECORD_STORE);
          const summaryStore = tx.objectStore(OFFLINE_SUMMARY_STORE);
          for (const batchId of batchIds) {
            recordStore.delete(batchId);
            summaryStore.delete(batchId);
          }
        }
      );
    },
    clear() {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_RECORD_STORE, OFFLINE_SUMMARY_STORE, OFFLINE_META_STORE],
        "readwrite",
        (tx) => {
          tx.objectStore(OFFLINE_RECORD_STORE).clear();
          tx.objectStore(OFFLINE_SUMMARY_STORE).clear();
          tx.objectStore(OFFLINE_META_STORE).clear();
        }
      );
    },
    putMeta(entry) {
      const handle = requireDb();
      return runTransaction(handle, [OFFLINE_META_STORE], "readwrite", (tx) => {
        tx.objectStore(OFFLINE_META_STORE).put(entry);
      });
    },
    readMeta(key) {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_META_STORE],
        "readonly",
        (tx) => tx.objectStore(OFFLINE_META_STORE).get(key)
      ).then((request) => isMetaEntry(request.result) ? request.result : null);
    },
    listMeta(prefix) {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_META_STORE],
        "readonly",
        (tx) => tx.objectStore(OFFLINE_META_STORE).getAll()
      ).then(
        (request) => toMetaEntries(request.result).filter((entry) => entry.key.startsWith(prefix))
      );
    },
    deleteMeta(keys) {
      const handle = requireDb();
      return runTransaction(handle, [OFFLINE_META_STORE], "readwrite", (tx) => {
        const store = tx.objectStore(OFFLINE_META_STORE);
        for (const key of keys) store.delete(key);
      });
    },
    close() {
      if (db !== null) {
        db.close();
        db = null;
      }
    }
  };
}

// src/offline/offline-store.ts
var noopCounters3 = { count: () => void 0 };
var LATENCY_SAMPLE_CAP = 200;
function hasIndexedDb(explicit) {
  if (explicit === null) return false;
  if (explicit !== void 0) return true;
  return globalThis.indexedDB !== void 0;
}
function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
function isQuotaError(error) {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "QuotaExceededError";
  }
  return error instanceof Error && error.name === "QuotaExceededError";
}
function percentile(samples, ratio2) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio2));
  return sorted[index] ?? null;
}
function isObjectLike2(value) {
  return typeof value === "object" && value !== null;
}
function parseIntent(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isObjectLike2(parsed)) return null;
  const session = parsed["session_id"];
  const enqueued = parsed["total_enqueued"];
  const committed = parsed["total_committed"];
  const firstPending = parsed["first_pending_at"];
  const updatedAt = parsed["updated_at"];
  if (typeof session !== "string" || typeof enqueued !== "number" || typeof committed !== "number" || typeof firstPending !== "number" || typeof updatedAt !== "number") {
    return null;
  }
  return {
    session_id: session,
    total_enqueued: enqueued,
    total_committed: committed,
    first_pending_at: firstPending,
    updated_at: updatedAt
  };
}
function createOfflineStore(options) {
  const appId = options.appId;
  const sessionId = options.sessionId;
  const formatVersion = options.formatVersion ?? OFFLINE_FORMAT_VERSION;
  const now = options.now ?? (() => Date.now());
  const counters = options.counters ?? noopCounters3;
  const deadSessionMs = options.deadSessionMs ?? DEFAULT_DEAD_SESSION_MS;
  const limits = { ...DEFAULT_OFFLINE_LIMITS, ...options.limits };
  const summaryScanLimit = Math.max(limits.maxBatches + 1, 5e3);
  const intentKey = `${META_INTENT_PREFIX}${sessionId}`;
  const assembler = options.header === void 0 ? null : createBatchAssembler({ header: options.header });
  const backend = options.backend ?? createIdbBackend({
    dbName: options.dbName,
    dbVersion: options.dbVersion,
    idbFactory: options.idbFactory
  });
  const knownUnavailable = options.backend === void 0 && !hasIndexedDb(options.idbFactory);
  const index = /* @__PURE__ */ new Map();
  const pending = [];
  const latencySamples = [];
  let available = null;
  let openPromise = null;
  let timer = null;
  let committing = false;
  let disposed = false;
  let totalEnqueued = 0;
  let totalCommitted = 0;
  let firstPendingAt = null;
  let inFlight = [];
  let anchorsEnabled = false;
  let anchorsPaused = false;
  let anchorBusy = false;
  let anchorQueued = false;
  let anchorTail = Promise.resolve();
  let resolveAnchorTail = null;
  let evictedBatches = 0;
  let evictedEvents = 0;
  let writeFailures = 0;
  let lossReport = { events: 0, windowMs: 0, observedWindowMs: 0, sessionIds: [] };
  function settle(entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    entry.resolve(outcome);
  }
  function failPending(reason, countStorageUnavailable) {
    const entries = pending.splice(0, pending.length);
    if (entries.length === 0) return;
    let events = 0;
    for (const entry of entries) {
      events += entry.record.event_count;
      settle(entry, { status: "rejected", reason });
    }
    totalEnqueued -= events;
    if (totalEnqueued < totalCommitted) totalEnqueued = totalCommitted;
    firstPendingAt = null;
  }
  function markUnavailable() {
    if (available === false) return;
    available = false;
    anchorsEnabled = false;
    counters.count(REASON_STORAGE_UNAVAILABLE2);
    failPending("unavailable");
  }
  async function evict(batchIds) {
    const victims = [];
    for (const batchId of batchIds) {
      const summary = index.get(batchId);
      if (summary === void 0) continue;
      victims.push(batchId);
      evictedBatches += 1;
      evictedEvents += summary.event_count;
      index.delete(batchId);
    }
    if (victims.length === 0) return;
    counters.count(REASON_OFFLINE_EVICTED, victims.length);
    try {
      await backend.remove(victims);
    } catch {
    }
  }
  async function pruneExpired() {
    if (available !== true) return;
    const cutoff = now() - limits.maxAgeMs;
    const expired = [];
    for (const summary of index.values()) {
      if (summary.enqueued_at < cutoff) expired.push(summary.batch_id);
    }
    if (expired.length > 0) await evict(expired);
  }
  async function enforceLimits(newSummaries) {
    const candidates = [...index.values(), ...newSummaries];
    let events = 0;
    let bytes = 0;
    for (const summary of candidates) {
      events += summary.event_count;
      bytes += summary.bytes;
    }
    let batches = candidates.length;
    const withinLimits = () => events <= limits.maxEvents && bytes <= limits.maxBytes && batches <= limits.maxBatches;
    if (withinLimits()) return [];
    const ordered = [...candidates].sort((left, right) => {
      const rankLeft = left.has_critical ? 1 : 0;
      const rankRight = right.has_critical ? 1 : 0;
      if (rankLeft !== rankRight) return rankLeft - rankRight;
      return left.enqueued_at - right.enqueued_at;
    });
    const newIds = new Set(newSummaries.map((summary) => summary.batch_id));
    const storedVictims = [];
    const droppedNew = [];
    for (const candidate of ordered) {
      if (withinLimits()) break;
      if (newIds.has(candidate.batch_id)) {
        droppedNew.push(candidate.batch_id);
      } else {
        storedVictims.push(candidate.batch_id);
        index.delete(candidate.batch_id);
      }
      events -= candidate.event_count;
      bytes -= candidate.bytes;
      batches -= 1;
    }
    for (const batchId of storedVictims) {
      const summary = index.get(batchId);
      evictedBatches += 1;
      evictedEvents += summary === void 0 ? 0 : summary.event_count;
    }
    if (storedVictims.length > 0) {
      counters.count(REASON_OFFLINE_EVICTED, storedVictims.length);
      try {
        await backend.remove(storedVictims);
      } catch {
      }
    }
    if (droppedNew.length > 0) counters.count(REASON_OFFLINE_EVICTED, droppedNew.length);
    return droppedNew;
  }
  async function aggressiveEvict() {
    const ordered = [...index.values()].sort((left, right) => left.enqueued_at - right.enqueued_at);
    const target = Math.max(1, Math.floor(ordered.length / 2));
    await evict(ordered.slice(0, target).map((summary) => summary.batch_id));
  }
  async function reconcileCommitLoss() {
    const entries = await backend.listMeta(META_INTENT_PREFIX);
    const reap = [];
    let events = 0;
    let windowMs = 0;
    let observedWindowMs = 0;
    const sessionIds = [];
    for (const entry of entries) {
      const state = parseIntent(entry.value);
      if (state === null || state.session_id === sessionId) {
        reap.push(entry.key);
        continue;
      }
      if (now() - state.updated_at <= deadSessionMs) continue;
      const lost = Math.max(0, state.total_enqueued - state.total_committed);
      reap.push(entry.key);
      if (lost > 0) {
        events += lost;
        sessionIds.push(state.session_id);
        windowMs = Math.max(windowMs, Math.max(0, now() - state.first_pending_at));
        observedWindowMs = Math.max(
          observedWindowMs,
          Math.max(0, state.updated_at - state.first_pending_at)
        );
      }
    }
    if (reap.length > 0) {
      try {
        await backend.deleteMeta(reap);
      } catch {
      }
    }
    if (events > 0) counters.count(REASON_PREWRITE_COMMIT_LOST, events);
    return { events, windowMs, observedWindowMs, sessionIds };
  }
  function intentValue() {
    const intent = {
      session_id: sessionId,
      total_enqueued: totalEnqueued,
      total_committed: totalCommitted,
      first_pending_at: firstPendingAt ?? now(),
      updated_at: now()
    };
    return JSON.stringify(intent);
  }
  function requestAnchor() {
    if (disposed) return;
    if (!anchorsEnabled || anchorsPaused || anchorBusy) {
      anchorQueued = true;
      return;
    }
    anchorBusy = true;
    anchorQueued = false;
    anchorTail = new Promise((resolve) => {
      resolveAnchorTail = resolve;
    });
    const value = intentValue();
    let write;
    try {
      write = backend.putMeta({ key: intentKey, value });
    } catch {
      write = Promise.resolve();
    }
    void write.catch(() => void 0).then(() => {
      anchorBusy = false;
      const resolve = resolveAnchorTail;
      resolveAnchorTail = null;
      if (resolve !== null) resolve();
      if (anchorQueued && !anchorsPaused && !disposed) requestAnchor();
    });
  }
  async function pauseAnchors() {
    anchorsPaused = true;
    await anchorTail;
  }
  function resumeAnchors() {
    anchorsPaused = false;
    if (disposed) return;
    if (anchorQueued) requestAnchor();
  }
  function scheduleFlush(delayMs) {
    if (disposed || available === false) return;
    if (timer !== null) {
      if (delayMs > 0) return;
      globalThis.clearTimeout(timer);
      timer = null;
    }
    if (available === null) return;
    timer = globalThis.setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  }
  function failureOutcome(error) {
    if (isAbortError(error)) return { status: "aborted" };
    return { status: "rejected", reason: isQuotaError(error) ? "quota" : "unavailable" };
  }
  async function commitWithRetry(records, intent) {
    try {
      await backend.commit(records, [intent]);
      return { ok: true };
    } catch (error) {
      if (!isQuotaError(error)) return { ok: false, outcome: failureOutcome(error) };
      try {
        await aggressiveEvict();
        await backend.commit(records, [intent]);
        return { ok: true };
      } catch (retryError) {
        return { ok: false, outcome: failureOutcome(retryError) };
      }
    }
  }
  async function flush() {
    if (committing) return;
    if (pending.length === 0) return;
    if (available !== true) {
      failPending("unavailable");
      return;
    }
    committing = true;
    const entries = pending.splice(0, pending.length);
    inFlight = entries;
    const records = entries.map((entry) => entry.record);
    const startedAt = now();
    try {
      const droppedNew = await enforceLimits(records.map(toSummary));
      const droppedSet = new Set(droppedNew);
      for (const entry of entries) {
        if (!droppedSet.has(entry.record.batch_id)) continue;
        settle(entry, { status: "rejected", reason: "overflow" });
        evictedEvents += entry.record.event_count;
        totalEnqueued -= entry.record.event_count;
      }
      const writable = records.filter((record) => !droppedSet.has(record.batch_id));
      if (writable.length === 0) return;
      await pauseAnchors();
      try {
        await backend.putMeta({ key: intentKey, value: intentValue() });
      } catch {
      }
      const settledIntent = {
        key: intentKey,
        value: JSON.stringify({
          session_id: sessionId,
          total_enqueued: totalEnqueued,
          total_committed: totalEnqueued,
          first_pending_at: firstPendingAt ?? startedAt,
          updated_at: now()
        })
      };
      const attempt = await commitWithRetry(writable, settledIntent);
      if (attempt.ok) {
        totalCommitted = totalEnqueued;
        for (const record of writable) index.set(record.batch_id, toSummary(record));
        for (const entry of entries) {
          if (!droppedSet.has(entry.record.batch_id)) settle(entry, { status: "durable" });
        }
        latencySamples.push(Math.max(0, now() - startedAt));
        if (latencySamples.length > LATENCY_SAMPLE_CAP) latencySamples.shift();
        if (pending.length === 0) firstPendingAt = null;
        return;
      }
      writeFailures += 1;
      counters.count(REASON_STORAGE_UNAVAILABLE2);
      for (const record of writable) {
        const entry = entries.find((item) => item.record.batch_id === record.batch_id);
        if (entry !== void 0) settle(entry, attempt.outcome);
      }
      totalEnqueued = totalCommitted;
      if (pending.length === 0) firstPendingAt = null;
      try {
        await backend.putMeta({ key: intentKey, value: intentValue() });
      } catch {
      }
    } catch {
      writeFailures += 1;
      failPending("unavailable");
      counters.count(REASON_STORAGE_UNAVAILABLE2);
    } finally {
      resumeAnchors();
      inFlight = [];
      committing = false;
      if (!disposed && pending.length > 0) scheduleFlush(0);
    }
  }
  async function loadState() {
    const stored = await backend.readMeta(META_FORMAT_KEY);
    if (stored !== null && stored.value !== String(formatVersion)) {
      counters.count(REASON_OFFLINE_INCOMPATIBLE);
      await backend.clear();
      await backend.putMeta({ key: META_FORMAT_KEY, value: String(formatVersion) });
    } else if (stored === null) {
      await backend.putMeta({ key: META_FORMAT_KEY, value: String(formatVersion) });
    }
    const summaries = await backend.readSummaries(summaryScanLimit);
    const incompatible = [];
    for (const summary of summaries) {
      if (summary.format_version !== formatVersion) {
        incompatible.push(summary.batch_id);
        continue;
      }
      index.set(summary.batch_id, summary);
    }
    if (incompatible.length > 0) {
      counters.count(REASON_OFFLINE_INCOMPATIBLE, incompatible.length);
      try {
        await backend.remove(incompatible);
      } catch {
      }
    }
    await pruneExpired();
    await enforceLimits([]);
    lossReport = await reconcileCommitLoss();
    if (pending.length > 0) scheduleFlush(0);
  }
  function openInternal() {
    if (openPromise !== null) return openPromise;
    openPromise = (async () => {
      try {
        if (knownUnavailable) {
          markUnavailable();
          return;
        }
        const result = await backend.open();
        if (result === "unavailable") {
          markUnavailable();
          return;
        }
        if (result === "incompatible") {
          counters.count(REASON_OFFLINE_INCOMPATIBLE);
          await backend.reset();
          const retryResult = await backend.open();
          if (retryResult !== "ok") {
            markUnavailable();
            return;
          }
        }
        available = true;
        await loadState();
        anchorsEnabled = true;
        if (anchorQueued) requestAnchor();
      } catch {
        markUnavailable();
      }
    })();
    return openPromise;
  }
  function prewrite(batch) {
    const enqueuedAt = now();
    const record = createOfflineRecord({
      batch,
      formatVersion,
      sessionId,
      appId,
      enqueuedAt,
      committedAt: enqueuedAt
    });
    let resolveOutcome = () => void 0;
    const settled = new Promise((resolve) => {
      resolveOutcome = resolve;
    });
    const handle = {
      batchId: record.batch_id,
      eventCount: record.event_count,
      criticalCount: record.critical_count,
      bytes: record.bytes,
      settled
    };
    if (disposed || available === false) {
      resolveOutcome({ status: "rejected", reason: "unavailable" });
      return handle;
    }
    pending.push({ record, resolve: resolveOutcome, settled: false });
    totalEnqueued += record.event_count;
    if (firstPendingAt === null) firstPendingAt = enqueuedAt;
    void openInternal();
    requestAnchor();
    if (pending.length >= limits.commitBatchSize) scheduleFlush(0);
    else scheduleFlush(limits.commitIntervalMs);
    return handle;
  }
  return {
    prewrite,
    // 实现只用到 event；`reason` 由接口（C06 的 OfflineSpillPort）声明。
    spill(event) {
      if (disposed || knownUnavailable || available === false) return false;
      if (assembler === null) return false;
      let batch;
      try {
        batch = assembler.assemble([event]);
      } catch {
        return false;
      }
      prewrite(batch);
      return true;
    },
    async list(limit) {
      await openInternal();
      if (available !== true) return [];
      await pruneExpired();
      return [...index.values()].sort((left, right) => left.enqueued_at - right.enqueued_at).slice(0, limit);
    },
    async read(batchId) {
      await openInternal();
      if (available !== true) return null;
      const record = await backend.read(batchId);
      if (record === null) return null;
      if (!isRecordCompatible(record, formatVersion)) {
        counters.count(REASON_OFFLINE_INCOMPATIBLE);
        index.delete(batchId);
        try {
          await backend.remove([batchId]);
        } catch {
        }
        return null;
      }
      return record.batch;
    },
    async markAttempt(batchId) {
      await openInternal();
      if (available !== true) return;
      const summary = index.get(batchId);
      if (summary === void 0) return;
      const updated = {
        ...summary,
        attempt_count: summary.attempt_count + 1,
        last_attempt_at: now()
      };
      index.set(batchId, updated);
      try {
        await backend.putSummaries([updated]);
      } catch {
      }
    },
    async remove(batchIds) {
      for (const batchId of batchIds) index.delete(batchId);
      await openInternal();
      if (available !== true || batchIds.length === 0) return;
      await backend.remove(batchIds);
    },
    async clear() {
      failPending("unavailable");
      index.clear();
      await openInternal();
      if (available === true) await backend.clear();
    },
    stats() {
      let storedEvents = 0;
      let storedBytes = 0;
      for (const summary of index.values()) {
        storedEvents += summary.event_count;
        storedBytes += summary.bytes;
      }
      const pendingEvents = Math.max(0, totalEnqueued - totalCommitted);
      return {
        storedBatches: index.size,
        storedEvents,
        storedBytes,
        evictedBatches,
        evictedEvents,
        writeFailures,
        ready: available !== null,
        available: available === true,
        exposure: {
          pendingBatches: pending.length + inFlight.length,
          pendingEvents,
          oldestPendingMs: firstPendingAt === null ? null : Math.max(0, now() - firstPendingAt),
          commitLatencyP50Ms: percentile(latencySamples, 0.5),
          commitLatencyP95Ms: percentile(latencySamples, 0.95),
          commitLostEvents: lossReport.events,
          commitLostWindowMs: lossReport.events === 0 ? null : lossReport.windowMs,
          commitLostObservedWindowMs: lossReport.events === 0 ? null : lossReport.observedWindowMs
        }
      };
    },
    quota() {
      const storage = globalThis.navigator?.storage;
      if (storage?.estimate === void 0) return Promise.resolve(null);
      return storage.estimate().then((value) => ({ usage: value.usage ?? 0, quota: value.quota ?? 0 })).catch(() => null);
    },
    commitLoss() {
      return lossReport;
    },
    ready() {
      return openInternal();
    },
    async drain() {
      await openInternal();
      for (let guard = 0; guard < 200; guard += 1) {
        if (pending.length === 0 && !committing) return;
        await flush();
        if (pending.length === 0 && !committing) return;
        await new Promise((resolve) => {
          globalThis.setTimeout(resolve, 0);
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
        timer = null;
      }
      failPending("unavailable");
      try {
        backend.close();
      } catch {
      }
    }
  };
}

// src/leader/leader.ts
var MIN_SETTLE_MS = 50;
var DEFAULT_LOCK_NAME = "web-report-sdk:replay";
var DEFAULT_CHANNEL_NAME = "web-report-sdk:leader";
function createDefaultLocksPort() {
  const manager = globalThis.navigator?.locks;
  if (manager === void 0 || manager === null) return null;
  const request = manager.request;
  if (request === void 0) return null;
  return {
    tryAcquire(name, task) {
      return request.call(manager, name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (lock === null || lock === void 0) return false;
        await task();
        return true;
      });
    }
  };
}
function createDefaultBroadcastPort() {
  const ctor = globalThis.BroadcastChannel;
  if (typeof ctor !== "function") return null;
  return {
    open(name) {
      try {
        return new ctor(name);
      } catch {
        return null;
      }
    }
  };
}
function isClaim(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return candidate["type"] === "claim" && typeof candidate["ts"] === "number" && typeof candidate["id"] === "string";
}
function isBetter(other, mine) {
  if (other.ts !== mine.ts) return other.ts < mine.ts;
  return other.id < mine.id;
}
function randomId() {
  return Math.random().toString(36).slice(2, 10);
}
function createLeaderElection(options = {}) {
  const locks = options.locks ?? null;
  const broadcast = options.broadcast ?? null;
  const settleMs = Math.max(options.settleMs ?? MIN_SETTLE_MS, MIN_SETTLE_MS);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  }));
  const now = options.now ?? (() => Date.now());
  const tabId = options.tabId ?? randomId();
  const lockName = options.lockName ?? DEFAULT_LOCK_NAME;
  const channelName = options.channelName ?? DEFAULT_CHANNEL_NAME;
  let lastMode = "none";
  let lastWasLeader = false;
  async function runWithBroadcast(task) {
    const channel = broadcast === null ? null : broadcast.open(channelName);
    if (channel === null) return { leader: true, mode: "none", result: await task() };
    const mine = { type: "claim", ts: now(), id: tabId };
    const state = { denied: false };
    const listener = (event) => {
      const claim = event.data;
      if (!isClaim(claim) || claim.id === tabId) return;
      if (isBetter(claim, mine)) state.denied = true;
    };
    channel.addEventListener("message", listener);
    try {
      for (let round = 0; round < 2; round += 1) {
        channel.postMessage(mine);
        await sleep(settleMs);
      }
      if (state.denied) return { leader: false, mode: "broadcast", result: void 0 };
      return { leader: true, mode: "broadcast", result: await task() };
    } finally {
      channel.removeEventListener("message", listener);
      channel.close();
    }
  }
  return {
    async run(task) {
      if (locks !== null) {
        const holder = { value: void 0 };
        const acquired = await locks.tryAcquire(lockName, async () => {
          holder.value = await task();
        });
        lastMode = "locks";
        lastWasLeader = acquired;
        return { leader: acquired, mode: "locks", result: acquired ? holder.value : void 0 };
      }
      if (broadcast !== null) {
        const outcome = await runWithBroadcast(task);
        lastMode = outcome.mode;
        lastWasLeader = outcome.leader;
        return outcome;
      }
      lastMode = "none";
      lastWasLeader = true;
      return { leader: true, mode: "none", result: await task() };
    },
    mode() {
      return lastMode;
    },
    lastLeader() {
      return lastWasLeader;
    }
  };
}

// src/sender/constants.ts
var DEFAULT_BACKOFF = {
  baseMs: 1e3,
  factor: 2,
  maxMs: 6e4,
  maxAttempts: 3,
  jitterRatio: 0.2
};
var DEFAULT_CIRCUIT = {
  failuresToOpen: 5,
  openMs: 5 * 60 * 1e3
};
var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
var COMPRESS_THRESHOLD_BYTES = 4 * 1024;
var BEACON_MAX_BYTES = 10 * 1024 * 1024;
var LEAVE_BUDGET = {
  maxBytes: 48 * 1024,
  maxEvents: 200,
  maxBatches: 4,
  /** 单次离开循环的软时间上限，避免长时间占用主线程。 */
  maxMs: 50
};
var REPLAY_MAX_BATCH_EVENTS = 100;
var REPLAY_MAX_ROUND_EVENTS = 500;
var REPLAY_MIN_INTERVAL_MS = 100;
var REASON_REJECTED_400 = "rejected_400";
var REASON_REJECTED_401 = "rejected_401";
var REASON_REJECTED_403 = "rejected_403";
var REASON_REJECTED_413 = "rejected_413";
var REASON_RETRY_429 = "retry_429";
var REASON_RETRY_5XX = "retry_5xx";
var REASON_RETRY_NETWORK = "retry_network";
var REASON_SPLIT_413 = "split_413";
var REASON_REPLAYED = "replayed";
var REASON_RETRY_EXHAUSTED = "retry_exhausted";

// src/leader/replay.ts
var DEFAULT_RATE = 1;
var MAX_RATE = 2;
var FAILURE_BACKOFF_BASE_MS = 1e3;
var FAILURE_BACKOFF_MAX_MS = 6e4;
function markReplayed(batch) {
  return {
    ...batch,
    events: batch.events.map((event) => ({ ...event, replayed: true }))
  };
}
function createReplayController(options) {
  const sleep = options.sleep ?? ((ms) => {
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, ms);
    });
  });
  const maxRoundEvents = options.maxRoundEvents ?? REPLAY_MAX_ROUND_EVENTS;
  const maxBatchEvents = options.maxBatchEvents ?? REPLAY_MAX_BATCH_EVENTS;
  function intervalMs() {
    const raw = options.rate();
    const rate = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_RATE) : DEFAULT_RATE;
    return Math.max(REPLAY_MIN_INTERVAL_MS, Math.ceil(1e3 / rate));
  }
  async function runRound() {
    let batches = 0;
    let events = 0;
    let skipped = 0;
    const interval = intervalMs();
    let firstSend = true;
    while (events < maxRoundEvents) {
      const remaining = maxRoundEvents - events;
      const summaries = await options.offline.list(Math.min(maxBatchEvents, remaining));
      if (summaries.length === 0) break;
      const summary = summaries[0];
      if (summary === void 0) break;
      if (!firstSend) await sleep(interval);
      firstSend = false;
      const batch = await options.offline.read(summary.batch_id);
      if (batch === null) {
        skipped += summary.event_count;
        continue;
      }
      const result = await options.sender.send(markReplayed(batch));
      if (result.status === "sent") {
        await options.offline.remove([summary.batch_id]);
        options.counters.count(REASON_REPLAYED);
        batches += 1;
        events += summary.event_count;
        continue;
      }
      await options.offline.markAttempt(summary.batch_id);
      if (result.terminal) {
        await options.offline.remove([summary.batch_id]);
        skipped += summary.event_count;
        continue;
      }
      const attempt = summary.attempt_count + 1;
      const backoff = Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (attempt - 1), FAILURE_BACKOFF_MAX_MS);
      await sleep(backoff);
      break;
    }
    return { batches, events, skipped };
  }
  return {
    async run() {
      const outcome = await options.leader.run(runRound);
      if (!outcome.leader || outcome.result === void 0) {
        return { leader: outcome.leader, mode: outcome.mode, batches: 0, events: 0, skipped: 0 };
      }
      return {
        leader: true,
        mode: outcome.mode,
        batches: outcome.result.batches,
        events: outcome.result.events,
        skipped: outcome.result.skipped
      };
    },
    maxRoundEvents() {
      return maxRoundEvents;
    }
  };
}

// src/sender/native.ts
var captureCache = /* @__PURE__ */ new WeakMap();
function readRefs(target) {
  const scope = target;
  const fetchRef = scope.fetch;
  const xhrRef = scope.XMLHttpRequest;
  const beaconRef = scope.navigator?.sendBeacon;
  const refs = {
    ...typeof fetchRef === "function" ? { fetch: fetchRef } : {},
    ...typeof xhrRef === "function" ? { xhr: xhrRef } : {},
    ...typeof beaconRef === "function" ? { sendBeacon: beaconRef.bind(scope.navigator) } : {}
  };
  return Object.freeze(refs);
}
function captureNativeHttpRefs(target = globalThis) {
  const cached = captureCache.get(target);
  if (cached !== void 0) return cached;
  const refs = readRefs(target);
  captureCache.set(target, refs);
  return refs;
}
function supportsFetchKeepalive() {
  try {
    if (typeof Request !== "function") return false;
    return "keepalive" in new Request("data:,");
  } catch {
    return false;
  }
}
function toHeaderRecord(raw) {
  const headers = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key !== "") headers[key] = value;
  }
  return headers;
}
function buildRequestInit(request, signal) {
  const init = {
    method: "POST",
    headers: { ...request.headers },
    body: request.bodyBytes ?? request.body,
    keepalive: request.keepalive
  };
  if (signal !== null) init.signal = signal;
  return init;
}
function createFetchTransport(refs) {
  return {
    async send(request) {
      const fetchRef = refs.fetch;
      if (fetchRef === void 0) throw new Error("native fetch unavailable");
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller === null ? null : globalThis.setTimeout(() => {
        controller.abort();
      }, request.timeoutMs);
      try {
        const response = await fetchRef(request.url, buildRequestInit(request, controller?.signal ?? null));
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: response.status, headers };
      } finally {
        if (timer !== null) globalThis.clearTimeout(timer);
      }
    }
  };
}
function createXhrTransport(refs) {
  return {
    send(request) {
      return new Promise((resolve, reject) => {
        const Xhr = refs.xhr;
        if (Xhr === void 0) {
          reject(new Error("native XMLHttpRequest unavailable"));
          return;
        }
        const xhr = new Xhr();
        try {
          xhr.open("POST", request.url, true);
          for (const [key, value] of Object.entries(request.headers)) {
            xhr.setRequestHeader(key, value);
          }
          xhr.timeout = request.timeoutMs;
          xhr.onload = () => {
            resolve({ status: xhr.status, headers: toHeaderRecord(xhr.getAllResponseHeaders()) });
          };
          xhr.onerror = () => {
            reject(new Error("xhr network error"));
          };
          xhr.ontimeout = () => {
            reject(new Error("xhr timeout"));
          };
          xhr.send(request.bodyBytes ?? request.body);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("xhr failure"));
        }
      });
    }
  };
}
function createDefaultTransport(refs, keepaliveSupported = supportsFetchKeepalive) {
  const fetchTransport = refs.fetch === void 0 ? null : createFetchTransport(refs);
  const xhrTransport = refs.xhr === void 0 ? null : createXhrTransport(refs);
  return {
    send(request) {
      if (fetchTransport !== null && keepaliveSupported()) return fetchTransport.send(request);
      if (xhrTransport !== null) return xhrTransport.send(request);
      if (fetchTransport !== null) return fetchTransport.send(request);
      return Promise.reject(new Error("no transport available"));
    }
  };
}
function createBeaconSender(refs) {
  const beacon = refs.sendBeacon;
  if (beacon === void 0) return null;
  return (url, data) => {
    try {
      return beacon(url, data);
    } catch {
      return false;
    }
  };
}

// src/sender/page-leave.ts
var noopCounters4 = { count: () => void 0 };
function createUuid() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID !== void 0) {
    try {
      return cryptoRef.randomUUID();
    } catch {
    }
  }
  const hex = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      out += "-";
      continue;
    }
    if (index === 14) {
      out += "4";
      continue;
    }
    if (index === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)] ?? "8";
      continue;
    }
    out += hex[Math.floor(Math.random() * 16)] ?? "0";
  }
  return out;
}
function sliceForBeacon(batch, maxBytes) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const event of batch.events) {
    const bytes = estimateEventBytes(event) + 2;
    if (current.length > 0 && size + bytes > maxBytes) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(event);
    size += bytes;
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) return [batch];
  if (groups.length === 1) return [batch];
  return groups.map((events) => ({ ...batch, batch_id: createUuid(), events }));
}
function createLeaveSender(options) {
  const counters = options.counters ?? noopCounters4;
  const now = options.now ?? (() => Date.now());
  const budget = { ...LEAVE_BUDGET, ...options.budget };
  const beacon = createBeaconSender(options.http ?? {});
  let burstStartedAt = 0;
  let usedBatches = 0;
  let usedEvents = 0;
  let usedBytes = 0;
  let sentTotal = 0;
  let skippedTotal = 0;
  let requestsTotal = 0;
  let bytesTotal = 0;
  function exhausted() {
    return usedBatches >= budget.maxBatches || usedEvents >= budget.maxEvents || usedBytes >= budget.maxBytes || now() - burstStartedAt > budget.maxMs;
  }
  return {
    resetBudget() {
      burstStartedAt = now();
      usedBatches = 0;
      usedEvents = 0;
      usedBytes = 0;
    },
    send(batch) {
      const credentials = options.credentials.current();
      if (credentials === null) {
        skippedTotal += batch.events.length;
        return { accepted: false, requests: 0, skippedEvents: batch.events.length, bytes: 0 };
      }
      if (burstStartedAt === 0) burstStartedAt = now();
      const bytesBefore = usedBytes;
      const slices = sliceForBeacon(batch, BEACON_MAX_BYTES - 256);
      let accepted = false;
      let requests = 0;
      let skipped = 0;
      let bytes = usedBytes;
      for (const slice of slices) {
        if (exhausted()) {
          skipped += slice.events.length;
          continue;
        }
        const body = JSON.stringify({
          ...slice,
          auth: { app_id: credentials.appId, write_token: credentials.writeToken }
        });
        const size = body.length;
        if (usedBytes + size > budget.maxBytes) {
          skipped += slice.events.length;
          continue;
        }
        requests += 1;
        usedBatches += 1;
        usedEvents += slice.events.length;
        usedBytes += size;
        bytes = usedBytes;
        if (beacon !== null) {
          const ok = beacon(
            credentials.endpoint,
            new Blob([body], { type: "text/plain;charset=UTF-8" })
          );
          if (ok) accepted = true;
          else counters.count(REASON_RETRY_NETWORK);
        } else {
          void options.transport.send({
            url: credentials.endpoint,
            headers: {
              "content-type": "application/json",
              "x-app-id": credentials.appId,
              "x-write-token": credentials.writeToken,
              "x-request-id": slice.batch_id,
              "x-beacon-fallback": "keepalive"
            },
            body,
            bodyBytes: void 0,
            keepalive: true,
            timeoutMs: 5e3
          }).catch(() => {
            counters.count(REASON_RETRY_NETWORK);
          });
        }
      }
      sentTotal += usedEvents;
      skippedTotal += skipped;
      requestsTotal += requests;
      bytesTotal += usedBytes - bytesBefore;
      return { accepted, requests, skippedEvents: skipped, bytes };
    },
    stats() {
      return { sent: sentTotal, skipped: skippedTotal, bytes: bytesTotal, requests: requestsTotal };
    }
  };
}

// src/sender/compress.ts
function resolveCtor(explicit) {
  const candidate = globalThis.CompressionStream;
  return candidate ?? null;
}
function createCompressor(explicit) {
  return {
    available() {
      return resolveCtor() !== null;
    },
    async compress(text) {
      const ctor = resolveCtor();
      if (ctor === null) throw new Error("CompressionStream unavailable");
      const stream = new Blob([text]).stream().pipeThrough(new ctor("gzip"));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    }
  };
}
function shouldCompress(body, compressor) {
  if (body.length <= COMPRESS_THRESHOLD_BYTES) return false;
  return compressor.available();
}

// src/sender/policy.ts
function parseRetryAfterMs(headers) {
  const raw = headers["retry-after"];
  if (raw === void 0) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1e3;
}
function parseServerTime(headers) {
  const raw = headers["x-server-time"];
  if (raw === void 0) return null;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
function classifyStatus(status, headers = {}) {
  if (status >= 200 && status < 300) return { kind: "success" };
  if (status === 401) return { kind: "pause", reason: REASON_REJECTED_401 };
  if (status === 403) return { kind: "pause", reason: REASON_REJECTED_403 };
  if (status === 413) return { kind: "split" };
  if (status === 429) {
    return { kind: "retry", reason: REASON_RETRY_429, retryAfterMs: parseRetryAfterMs(headers) };
  }
  if (status >= 500) {
    return { kind: "retry", reason: REASON_RETRY_5XX, retryAfterMs: parseRetryAfterMs(headers) };
  }
  return { kind: "drop", reason: REASON_REJECTED_400 };
}
function classifyError() {
  return { kind: "retry", reason: REASON_RETRY_NETWORK, retryAfterMs: null };
}
function createBackoff(overrides, random) {
  const options = { ...DEFAULT_BACKOFF, ...overrides };
  return {
    options,
    delayFor(attempt, retryAfterMs) {
      const exponent = Math.max(0, attempt - 1);
      const local = Math.min(options.baseMs * options.factor ** exponent, options.maxMs);
      const remote = retryAfterMs === null ? 0 : Math.min(retryAfterMs, options.maxMs);
      const target = Math.max(local, remote);
      const jitter = 1 - options.jitterRatio + 2 * options.jitterRatio * random();
      return Math.round(Math.min(target * jitter, options.maxMs));
    }
  };
}
function createCircuitBreaker(overrides, now) {
  const options = { ...DEFAULT_CIRCUIT, ...overrides };
  let open = false;
  let openedAt = 0;
  let failures = 0;
  let probeInFlight = false;
  let opens = 0;
  let probes = 0;
  return {
    isOpen() {
      return open;
    },
    admit() {
      if (!open) return true;
      if (now() - openedAt < options.openMs) return false;
      if (probeInFlight) return false;
      probeInFlight = true;
      probes += 1;
      return true;
    },
    onSuccess() {
      open = false;
      failures = 0;
      probeInFlight = false;
    },
    onFailure() {
      probeInFlight = false;
      if (open) {
        openedAt = now();
        return;
      }
      failures += 1;
      if (failures >= options.failuresToOpen) {
        open = true;
        openedAt = now();
        opens += 1;
      }
    },
    opens() {
      return opens;
    },
    probes() {
      return probes;
    },
    failures() {
      return failures;
    }
  };
}
function createSendGate(credentials) {
  let paused = false;
  let pausedAt = null;
  return {
    pause() {
      if (paused) return;
      paused = true;
      pausedAt = credentials.current();
    },
    isPaused() {
      if (!paused) return false;
      const current = credentials.current();
      if (current === null) return true;
      const before = pausedAt;
      if (before === null) {
        paused = false;
        return false;
      }
      const revisionChanged = current.revision !== before.revision;
      const targetChanged = current.writeToken !== before.writeToken || current.endpoint !== before.endpoint;
      if (revisionChanged && targetChanged) {
        paused = false;
        pausedAt = null;
        return false;
      }
      return true;
    }
  };
}

// src/sender/sender.ts
var noopCounters5 = { count: () => void 0 };
var MAX_SPLIT_DEPTH = 8;
function createUuid2() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID !== void 0) {
    try {
      return cryptoRef.randomUUID();
    } catch {
    }
  }
  const hex = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      out += "-";
      continue;
    }
    if (index === 14) {
      out += "4";
      continue;
    }
    if (index === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)] ?? "8";
      continue;
    }
    out += hex[Math.floor(Math.random() * 16)] ?? "0";
  }
  return out;
}
function createBatchSender(options) {
  const counters = options.counters ?? noopCounters5;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  }));
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const compressor = options.compressor ?? createCompressor();
  const backoff = createBackoff(options.backoff, random);
  const circuit = createCircuitBreaker(options.circuit, now);
  const gate = createSendGate(options.credentials);
  const transport = options.transport ?? createDefaultTransport(options.http ?? {}, options.keepaliveSupported ?? supportsFetchKeepalive);
  let attempts = 0;
  let retries = 0;
  let sent = 0;
  let dropped = 0;
  async function attemptOnce(batch) {
    const credentials = options.credentials.current();
    if (credentials === null) {
      return { kind: "pause", reason: "rejected_401" };
    }
    const body = JSON.stringify(batch);
    let bodyBytes;
    const headers = {
      "content-type": "application/json",
      "x-app-id": credentials.appId,
      "x-write-token": credentials.writeToken,
      "x-request-id": batch.batch_id
    };
    if (shouldCompress(body, compressor)) {
      try {
        bodyBytes = await compressor.compress(body);
        headers["content-encoding"] = "gzip";
      } catch {
        bodyBytes = void 0;
        delete headers["content-encoding"];
      }
    }
    try {
      const response = await transport.send({
        url: credentials.endpoint,
        headers,
        body,
        bodyBytes,
        keepalive: true,
        timeoutMs
      });
      const serverTime = parseServerTime(response.headers);
      if (serverTime !== null && options.onServerTime !== void 0) options.onServerTime(serverTime);
      return classifyStatus(response.status, response.headers);
    } catch {
      return classifyError();
    }
  }
  async function sendSplit(batch, depth) {
    const events = batch.events;
    if (events.length <= 1) {
      counters.count(REASON_REJECTED_413);
      dropped += 1;
      return { status: "failed", attempts: 1, terminal: true, reason: REASON_REJECTED_413 };
    }
    if (depth >= MAX_SPLIT_DEPTH) {
      return { status: "failed", attempts: 1, terminal: false, reason: REASON_RETRY_EXHAUSTED };
    }
    counters.count(REASON_SPLIT_413);
    const middle = Math.floor(events.length / 2);
    const halves = [
      events.slice(0, middle),
      events.slice(middle)
    ];
    let totalAttempts = 0;
    for (const half of halves) {
      const sub = { ...batch, batch_id: createUuid2(), events: half };
      const result = await sendWithRetry(sub, depth + 1);
      totalAttempts += result.attempts;
      if (result.status !== "sent") {
        return {
          status: "failed",
          attempts: totalAttempts,
          terminal: result.terminal,
          ...result.reason === void 0 ? {} : { reason: result.reason }
        };
      }
    }
    return { status: "sent", attempts: totalAttempts, terminal: false };
  }
  async function sendWithRetry(batch, depth) {
    let attempt = 0;
    for (; ; ) {
      attempt += 1;
      attempts += 1;
      const classified = await attemptOnce(batch);
      if (classified.kind === "success") {
        sent += 1;
        circuit.onSuccess();
        return { status: "sent", attempts: attempt, terminal: false };
      }
      if (classified.kind === "drop") {
        counters.count(classified.reason);
        dropped += 1;
        circuit.onSuccess();
        return {
          status: "failed",
          attempts: attempt,
          terminal: true,
          reason: classified.reason
        };
      }
      if (classified.kind === "pause") {
        counters.count(classified.reason);
        gate.pause();
        return { status: "failed", attempts: attempt, terminal: false, reason: classified.reason };
      }
      if (classified.kind === "split") {
        return sendSplit(batch, depth);
      }
      if (attempt > backoff.options.maxAttempts) {
        dropped += 1;
        circuit.onFailure();
        return {
          status: "failed",
          attempts: attempt,
          terminal: false,
          reason: REASON_RETRY_EXHAUSTED
        };
      }
      counters.count(classified.reason);
      retries += 1;
      await sleep(backoff.delayFor(attempt, classified.retryAfterMs));
    }
  }
  return {
    transport,
    async send(batch) {
      if (!circuit.admit()) {
        return { status: "circuit_open", attempts: 0, terminal: false };
      }
      if (gate.isPaused()) {
        return { status: "failed", attempts: 0, terminal: false };
      }
      try {
        return await sendWithRetry(batch, 0);
      } catch {
        counters.count(REASON_RETRY_NETWORK);
        return { status: "failed", attempts: 1, terminal: false };
      }
    },
    isCircuitOpen() {
      return circuit.isOpen();
    },
    isPaused() {
      return gate.isPaused();
    },
    stats() {
      return {
        attempts,
        retries,
        sent,
        dropped,
        retryRatio: attempts === 0 ? 0 : retries / attempts,
        circuitOpen: circuit.isOpen(),
        paused: gate.isPaused(),
        circuitOpens: circuit.opens(),
        probes: circuit.probes()
      };
    }
  };
}

// src/sender/delivery.ts
function createDomPageEventsSource(target) {
  return {
    subscribe(handler) {
      const onOnline = () => {
        handler("online");
      };
      const onVisible = () => {
        if (target.visibilityState === "visible") handler("visible");
      };
      const onPageShow = () => {
        handler("pageshow");
      };
      target.addEventListener("online", onOnline);
      target.addEventListener("visibilitychange", onVisible);
      target.addEventListener("pageshow", onPageShow);
      return () => {
        target.removeEventListener("online", onOnline);
        target.removeEventListener("visibilitychange", onVisible);
        target.removeEventListener("pageshow", onPageShow);
      };
    }
  };
}
var noopCounters6 = { count: () => void 0 };
var LEAVE_BURST_GAP_MS = 100;
function createDelivery(options) {
  const counters = options.counters ?? noopCounters6;
  const now = options.now ?? (() => Date.now());
  const offline = options.offline !== void 0 && "prewrite" in options.offline ? options.offline : createOfflineStore({
    appId: options.appId,
    sessionId: options.sessionId,
    ...options.offline === void 0 ? {} : options.offline,
    ...options.header === void 0 ? {} : { header: options.header },
    ...options.counters === void 0 ? {} : { counters: options.counters },
    ...options.now === void 0 ? {} : { now: options.now }
  });
  const sender = createBatchSender({
    credentials: options.credentials,
    ...options.http === void 0 ? {} : { http: options.http },
    ...options.transport === void 0 ? {} : { transport: options.transport },
    ...options.counters === void 0 ? {} : { counters: options.counters },
    ...options.now === void 0 ? {} : { now: options.now },
    ...options.random === void 0 ? {} : { random: options.random },
    ...options.sleep === void 0 ? {} : { sleep: options.sleep },
    ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
    ...options.keepaliveSupported === void 0 ? {} : { keepaliveSupported: options.keepaliveSupported },
    ...options.onServerTime === void 0 ? {} : { onServerTime: options.onServerTime }
  });
  const leave = createLeaveSender({
    credentials: options.credentials,
    ...options.http === void 0 ? {} : { http: options.http },
    transport: sender.transport,
    ...options.counters === void 0 ? {} : { counters: options.counters },
    ...options.now === void 0 ? {} : { now: options.now },
    ...options.leaveBudget === void 0 ? {} : { budget: options.leaveBudget }
  });
  const leader = createLeaderElection({
    ...options.locks === void 0 ? {} : { locks: options.locks },
    ...options.broadcast === void 0 ? {} : { broadcast: options.broadcast },
    ...options.settleMs === void 0 ? {} : { settleMs: options.settleMs },
    ...options.now === void 0 ? {} : { now: options.now },
    ...options.sleep === void 0 ? {} : { sleep: options.sleep },
    ...options.counters === void 0 ? {} : { counters: options.counters }
  });
  const replayController = createReplayController({
    offline,
    sender,
    leader,
    counters,
    rate: () => queueControl?.limits().replayBatchesPerSecond ?? 1,
    ...options.now === void 0 ? {} : { now: options.now },
    ...options.sleep === void 0 ? {} : { sleep: options.sleep }
  });
  let queueControl = null;
  let disposed = false;
  let replaying = false;
  let lastLeaveAt = 0;
  let eventsSent = 0;
  let batchesSent = 0;
  let batchesFailed = 0;
  let offlineWrittenBatches = 0;
  let offlineWrittenEvents = 0;
  let offlineReplayedBatches = 0;
  let offlineReplayedEvents = 0;
  let lastReplayReason = "manual";
  function trackHandle(handle) {
    void handle.settled.then((outcome) => {
      if (outcome.status !== "durable") return;
      offlineWrittenBatches += 1;
      offlineWrittenEvents += handle.eventCount;
    });
  }
  function deleteWhenDurable(handle) {
    void handle.settled.then((outcome) => {
      if (outcome.status === "durable") void offline.remove([handle.batchId]);
    });
  }
  function submit(batch, context) {
    if (disposed) {
      context.complete("failed");
      return;
    }
    let handle = null;
    try {
      if (countCriticalEvents(batch) > 0) {
        handle = offline.prewrite(batch);
        trackHandle(handle);
      }
    } catch {
      handle = null;
    }
    if (context.channel === "page_leave") {
      try {
        const startedAt = now();
        if (startedAt - lastLeaveAt > LEAVE_BURST_GAP_MS) leave.resetBudget();
        lastLeaveAt = startedAt;
        leave.send(batch);
      } catch {
      }
      context.complete("failed");
      return;
    }
    void sender.send(batch).then(
      (result) => {
        if (result.status === "sent") {
          eventsSent += batch.events.length;
          batchesSent += 1;
          if (handle !== null) deleteWhenDurable(handle);
        } else if (result.status === "circuit_open") {
          batchesFailed += 1;
          const control = queueControl;
          if (control !== null) control.setCircuitOpen(true);
        } else {
          batchesFailed += 1;
          if (result.terminal && handle !== null) deleteWhenDurable(handle);
        }
        context.complete(result.status);
      },
      () => {
        batchesFailed += 1;
        context.complete("failed");
      }
    );
  }
  async function replay(reason = "manual") {
    if (disposed || replaying) {
      return { leader: false, mode: "none", batches: 0, events: 0, skipped: 0 };
    }
    replaying = true;
    lastReplayReason = reason;
    try {
      const result = await replayController.run();
      offlineReplayedBatches += result.batches;
      offlineReplayedEvents += result.events;
      return result;
    } catch {
      return { leader: false, mode: leader.mode(), batches: 0, events: 0, skipped: 0 };
    } finally {
      replaying = false;
    }
  }
  return {
    submit: { submit },
    offline,
    sender,
    attachQueue(queue) {
      queueControl = queue;
    },
    wireEnqueue(queue) {
      return (event) => {
        queue.enqueue(event);
        if (event.priority === "critical") queue.flush("events");
      };
    },
    replay,
    async clearOffline() {
      await offline.clear();
      offlineWrittenBatches = 0;
      offlineWrittenEvents = 0;
    },
    metrics() {
      const offlineStats = offline.stats();
      const senderStats = sender.stats();
      return {
        eventsSent,
        batchesSent,
        batchesFailed,
        offlineWritten: offlineWrittenBatches,
        offlineWrittenEvents,
        offlineReplayed: offlineReplayedBatches,
        offlineReplayedEvents,
        offlineEvicted: offlineStats.evictedBatches,
        exposure: offlineStats.exposure,
        leave: leave.stats(),
        retry: { attempts: senderStats.attempts, ratio: senderStats.retryRatio },
        leader: { mode: leader.mode(), leader: leader.lastLeader() },
        circuitOpen: senderStats.circuitOpen,
        paused: senderStats.paused,
        lastReplayReason
      };
    },
    exposureMetrics() {
      const exposure = offline.stats().exposure;
      if (exposure.commitLostEvents < 1) return [];
      const metrics = [
        { name: METRIC_EXPOSURE_WINDOW_EVENTS, value: exposure.commitLostEvents }
      ];
      if (exposure.commitLostWindowMs !== null) {
        metrics.push({
          name: METRIC_EXPOSURE_WINDOW_MS,
          value: Math.max(1, Math.round(exposure.commitLostWindowMs))
        });
      }
      return metrics;
    },
    start() {
      const pageEvents = options.pageEvents;
      if (pageEvents === void 0) return () => void 0;
      const unsubscribe = pageEvents.subscribe((reason) => {
        void replay(reason);
      });
      void replay("startup");
      return () => {
        unsubscribe();
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      queueControl = null;
      offline.dispose();
    }
  };
}

// src/monitor/reason-codes.ts
var DROP_REASON_CODES = [
  "invalid_args",
  "invalid_event_name",
  "invalid_field_key",
  "non_finite_metric",
  "event_too_large",
  "command_queue_overflow",
  "prestart_queue_overflow",
  "plugin_dependency_missing",
  "plugin_install_failed",
  "sampled_out_session",
  "sampled_out_rule",
  "disabled_by_rule",
  "killed",
  "consent_denied",
  "consent_buffer_cleared",
  "filtered_by_plugin",
  "queue_evicted",
  "offline_evicted",
  "offline_incompatible",
  "retry_exhausted",
  "prewrite_commit_lost",
  "rejected_400",
  "rejected_401",
  "rejected_403",
  "rejected_413",
  "destroyed"
];
var COUNT_REASON_CODES = [
  "processor_error",
  "truncated_dimension",
  "truncated_dimension_keys",
  "truncated_metric_keys",
  "truncated_attachment",
  "retry_429",
  "retry_5xx",
  "retry_network",
  "split_413",
  "circuit_open",
  "replayed",
  "storage_unavailable",
  "config_fetch_failed",
  "config_signature_invalid",
  "config_version_stale",
  "config_scope_mismatch",
  "config_format_unsupported",
  "config_parse_failed",
  "config_schema_invalid",
  "config_cache_expired",
  "config_signature_unavailable",
  "config_consent_mode_rejected"
];

// src/monitor/types.ts
var FIXED_METRIC_NAMES = [
  "calls_total",
  "events_enqueued",
  "events_sent",
  "batches_sent",
  "batches_failed",
  "offline_written",
  "offline_replayed",
  "queue_length_max"
];
var LATENCY_STAGES = ["track", "pipeline", "serialize"];
var LATENCY_METRIC_NAMES = {
  track: "track_p99_ms",
  pipeline: "pipeline_p99_ms",
  serialize: "serialize_p99_ms"
};

// src/monitor/metrics.ts
var WINDOW_METRIC_KEY = "window_ms";
function clampWindowMs(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}
function toCountValue(value) {
  if (value === void 0 || !Number.isFinite(value) || value < 1) return null;
  const rounded = Math.round(value);
  return rounded >= 1 ? rounded : null;
}
function buildHealthMetrics(input) {
  const metrics = { [WINDOW_METRIC_KEY]: clampWindowMs(input.windowMs) };
  const fixed = input.fixed;
  if (fixed !== void 0) {
    for (const name of FIXED_METRIC_NAMES) {
      const value = toCountValue(fixed[name]);
      if (value !== null) metrics[name] = value;
    }
  }
  const exposure = input.exposure;
  if (exposure !== void 0 && exposure !== null) {
    const events = toCountValue(exposure.events);
    if (events !== null) {
      metrics[METRIC_EXPOSURE_WINDOW_EVENTS] = events;
      if (exposure.windowMs !== null) {
        const windowMs = toCountValue(exposure.windowMs);
        if (windowMs !== null) metrics[METRIC_EXPOSURE_WINDOW_MS] = windowMs;
      }
    }
  }
  for (const code of DROP_REASON_CODES) {
    const value = toCountValue(input.counters[code]);
    if (value !== null) metrics[`drop_${code}`] = value;
  }
  for (const code of COUNT_REASON_CODES) {
    const value = toCountValue(input.counters[code]);
    if (value !== null) metrics[`count_${code}`] = value;
  }
  const latency = input.latency;
  if (latency !== void 0) {
    for (const stage of LATENCY_STAGES) {
      const value = latency[stage];
      if (value !== void 0 && Number.isFinite(value) && value >= 0) {
        metrics[LATENCY_METRIC_NAMES[stage]] = value;
      }
    }
  }
  return metrics;
}

// src/monitor/events.ts
var MAX_METRICS_PER_EVENT = 50;
function clampMaxMetrics(value) {
  if (value === void 0 || !Number.isFinite(value)) return MAX_METRICS_PER_EVENT;
  return Math.min(MAX_METRICS_PER_EVENT, Math.max(2, Math.floor(value)));
}
function buildHealthEvents(input) {
  const maxMetrics = clampMaxMetrics(input.maxMetricsPerEvent);
  const windowMs = input.metrics[WINDOW_METRIC_KEY] ?? 1;
  const others = Object.entries(input.metrics).filter(([key]) => key !== WINDOW_METRIC_KEY);
  const createEvent = (metrics) => ({
    event_id: input.createId(),
    event_name: "sdk_health",
    event_type: "sdk_internal",
    schema_version: 1,
    occurred_at: input.occurredAt,
    priority: "normal",
    dimensions: input.dimensions,
    metrics
  });
  if (others.length === 0) {
    return [createEvent({ [WINDOW_METRIC_KEY]: windowMs })];
  }
  const capacity = maxMetrics - 1;
  const events = [];
  for (let index = 0; index < others.length; index += capacity) {
    const chunk = others.slice(index, index + capacity);
    events.push(createEvent({ [WINDOW_METRIC_KEY]: windowMs, ...Object.fromEntries(chunk) }));
  }
  return events;
}

// src/monitor/latency.ts
var DEFAULT_SESSION_SAMPLE_RATE = 0.01;
var DEFAULT_LATENCY_CAPACITY = 512;
function normalizeRate(rate) {
  if (rate === void 0) return DEFAULT_SESSION_SAMPLE_RATE;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (rate >= 1) return 1;
  return rate;
}
function createSessionSampler(options = {}) {
  const random = options.random ?? (() => Math.random());
  const rate = normalizeRate(options.rate);
  let decided = null;
  return {
    sampled() {
      if (decided === null) decided = random() < rate;
      return decided;
    },
    rate: () => rate
  };
}
function nearestRankPercentile(values, percentile2) {
  if (values.length === 0) return null;
  const clamped = Number.isFinite(percentile2) ? Math.min(1, Math.max(0, percentile2)) : 0;
  const rank = Math.ceil(clamped * values.length);
  const index = Math.min(values.length - 1, Math.max(0, rank - 1));
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[index] ?? null;
}
function normalizeCapacity(value) {
  if (value === void 0 || !Number.isFinite(value)) return DEFAULT_LATENCY_CAPACITY;
  return Math.max(1, Math.floor(value));
}
function createLatencyWindow(options = {}) {
  const sampled = options.sampled ?? false;
  const capacity = normalizeCapacity(options.capacity);
  const samples = /* @__PURE__ */ new Map();
  for (const stage of LATENCY_STAGES) samples.set(stage, []);
  function p99(stage) {
    const list = samples.get(stage);
    if (list === void 0 || list.length === 0) return null;
    return nearestRankPercentile(list, 0.99);
  }
  function reset() {
    for (const list of samples.values()) list.length = 0;
  }
  return {
    sampled,
    record(stage, durationMs) {
      if (!sampled || !Number.isFinite(durationMs) || durationMs < 0) return;
      const list = samples.get(stage);
      if (list === void 0) return;
      list.push(durationMs);
      if (list.length > capacity) list.splice(0, list.length - capacity);
    },
    p99,
    reset,
    take() {
      if (!sampled) return {};
      const taken = {};
      for (const stage of LATENCY_STAGES) {
        const value = p99(stage);
        if (value !== null) taken[stage] = value;
      }
      reset();
      return taken;
    }
  };
}

// src/monitor/instrument.ts
var COUNTED_CALL_METHODS = [
  "init",
  "track",
  "log",
  "captureError",
  "setUser",
  "clearUser",
  "setContext",
  "removeContext",
  "setPage",
  "setConsent",
  "flush",
  "destroy"
];
var DEFAULT_LATENCY_CALL_METHODS = ["track", "log", "captureError"];
function wrapMethods(client, methods, wrapper) {
  const source = client;
  const wrapped = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "function" && methods.has(key)) {
      const invoke = value;
      wrapped[key] = (...args) => wrapper(() => invoke(...args));
    } else {
      wrapped[key] = value;
    }
  }
  return wrapped;
}
function createCallCounter(client, options = {}) {
  const methods = new Set(options.methods ?? COUNTED_CALL_METHODS);
  let calls = 0;
  const wrapped = wrapMethods(client, methods, (invoke) => {
    calls += 1;
    return invoke();
  });
  return {
    client: wrapped,
    take() {
      const delta = calls;
      calls = 0;
      return delta >= 1 ? { calls_total: delta } : {};
    }
  };
}
function createLatencyDecorators(options) {
  const now = options.now ?? (() => Date.now());
  const callMethods = new Set(options.callMethods ?? DEFAULT_LATENCY_CALL_METHODS);
  const callStage = options.callStage ?? "track";
  const pipelineStage = options.pipelineStage ?? "pipeline";
  const functionStage = options.functionStage ?? "serialize";
  function measure(stage, invoke) {
    const startedAt = now();
    try {
      return invoke();
    } finally {
      options.recorder.record(stage, now() - startedAt);
    }
  }
  return {
    wrapCalls(client) {
      return wrapMethods(client, callMethods, (invoke) => measure(callStage, invoke));
    },
    wrapPipeline(pipeline) {
      const process = (event) => {
        const startedAt = now();
        try {
          return pipeline.process(event);
        } finally {
          options.recorder.record(pipelineStage, now() - startedAt);
        }
      };
      const wrapped = { ...pipeline, process };
      return wrapped;
    },
    wrapFunction(fn) {
      return (...args) => measure(functionStage, () => fn(...args));
    }
  };
}

// src/monitor/adapters.ts
var isAcceptedPush = (status) => status === "queued" || status === "evicted" || status === "spilled";
var DEFAULT_IS_SELF = (event) => event.event_name === "sdk_health";
function createFixedMetricsAccumulator() {
  const sums = /* @__PURE__ */ new Map();
  const peaks = /* @__PURE__ */ new Map();
  return {
    add(name, delta = 1) {
      if (!Number.isFinite(delta) || delta <= 0) return;
      sums.set(name, (sums.get(name) ?? 0) + delta);
    },
    observePeak(name, value) {
      if (!Number.isFinite(value) || value < 0) return;
      peaks.set(name, Math.max(peaks.get(name) ?? 0, value));
    },
    take() {
      const deltas = {};
      for (const [name, value] of sums) {
        if (value >= 1) deltas[name] = value;
      }
      for (const [name, value] of peaks) {
        if (value >= 1) deltas[name] = Math.max(deltas[name] ?? 0, value);
      }
      sums.clear();
      peaks.clear();
      return deltas;
    }
  };
}
function combineFixedMetrics(...sources) {
  return {
    take() {
      const merged = {};
      for (const source of sources) {
        const deltas = source.take();
        for (const name of FIXED_METRIC_NAMES) {
          const value = deltas[name];
          if (value === void 0 || !Number.isFinite(value)) continue;
          const current = merged[name];
          merged[name] = name === "queue_length_max" ? current === void 0 ? value : Math.max(current, value) : (current ?? 0) + value;
        }
      }
      return merged;
    }
  };
}
function createQueueMetricsSource(options) {
  const base = options.queue;
  const isSelf = options.isSelf ?? DEFAULT_IS_SELF;
  let enqueued = 0;
  let peak = 0;
  const wrapped = {
    enqueue(event) {
      const result = base.enqueue(event);
      if (!isSelf(event)) {
        if (isAcceptedPush(result.status)) enqueued += 1;
        peak = Math.max(peak, base.queueLength());
      }
      return result;
    },
    flush: (reason) => base.flush(reason),
    inFlight: () => base.inFlight(),
    isCircuitOpen: () => base.isCircuitOpen(),
    setCircuitOpen: (open) => {
      base.setCircuitOpen(open);
    },
    queueLength: () => base.queueLength(),
    queueBytes: () => base.queueBytes(),
    limits: () => base.limits(),
    dispose: () => {
      base.dispose();
    }
  };
  return {
    queue: wrapped,
    take() {
      const deltas = {};
      if (enqueued >= 1) deltas.events_enqueued = enqueued;
      if (peak >= 1) deltas.queue_length_max = peak;
      enqueued = 0;
      peak = 0;
      return deltas;
    }
  };
}
function createSubmitMetricsSource(options) {
  const base = options.submit;
  const isSelf = options.isSelf ?? DEFAULT_IS_SELF;
  let eventsSent = 0;
  let batchesSent = 0;
  let batchesFailed = 0;
  const wrapped = {
    submit(batch, context) {
      if (context.channel === "page_leave") {
        base.submit(batch, context);
        return;
      }
      const selfCount = batch.events.filter((event) => isSelf(event)).length;
      const businessCount = batch.events.length - selfCount;
      base.submit(batch, {
        channel: context.channel,
        complete(outcome) {
          if (outcome === "sent") {
            if (businessCount >= 1) eventsSent += businessCount;
            if (selfCount === 0) batchesSent += 1;
          } else if (selfCount === 0) {
            batchesFailed += 1;
          }
          context.complete(outcome);
        }
      });
    }
  };
  return {
    submit: wrapped,
    take() {
      const deltas = {};
      if (eventsSent >= 1) deltas.events_sent = eventsSent;
      if (batchesSent >= 1) deltas.batches_sent = batchesSent;
      if (batchesFailed >= 1) deltas.batches_failed = batchesFailed;
      eventsSent = 0;
      batchesSent = 0;
      batchesFailed = 0;
      return deltas;
    }
  };
}
function createDeliveryMetricsSource(delivery) {
  const initial = delivery.metrics();
  let lastWritten = initial.offlineWritten;
  let lastReplayed = initial.offlineReplayed;
  return {
    take() {
      const current = delivery.metrics();
      const written = current.offlineWritten - lastWritten;
      const replayed = current.offlineReplayed - lastReplayed;
      lastWritten = current.offlineWritten;
      lastReplayed = current.offlineReplayed;
      const deltas = {};
      if (written >= 1) deltas.offline_written = written;
      if (replayed >= 1) deltas.offline_replayed = replayed;
      return deltas;
    }
  };
}
function createOfflineExposureSource(source) {
  return {
    exposure() {
      const exposure = source.stats().exposure;
      return { events: exposure.commitLostEvents, windowMs: exposure.commitLostWindowMs };
    }
  };
}
function createRegistryTimer(registry) {
  return {
    schedule: (handler, intervalMs) => registry.scheduleRepeat(handler, intervalMs)
  };
}
var HEALTH_STATES = {
  initialized: "initialized",
  running: "running",
  paused: "paused",
  destroyed: "destroyed"
};
function createHealthDimensionsReader(options) {
  return () => {
    const state = HEALTH_STATES[options.lifecycle.state()] ?? null;
    const configVersion = options.configVersion === void 0 ? null : options.configVersion();
    return { sdk_version: options.sdkVersion, state, config_version: configVersion };
  };
}

// src/monitor/reporter.ts
var DEFAULT_HEALTH_WINDOW_MS = 6e4;
function fallbackUuidV42() {
  let out = "";
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      out += "-";
      continue;
    }
    if (index === 14) {
      out += "4";
      continue;
    }
    const value = Math.floor(Math.random() * 16);
    out += (index === 19 ? value & 3 | 8 : value).toString(16);
  }
  return out;
}
function defaultCreateId2() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef !== void 0 && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  return fallbackUuidV42();
}
function toConfigVersionText(value) {
  if (value === null || value === void 0 || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 1 ? String(rounded) : null;
}
function normalizeWindowMs(value) {
  if (value === void 0 || !Number.isFinite(value)) return DEFAULT_HEALTH_WINDOW_MS;
  return Math.max(1, Math.round(value));
}
function createHealthReporter(options) {
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? defaultCreateId2;
  const windowMs = normalizeWindowMs(options.windowMs);
  let windowStartedAt = now();
  let cancel = null;
  let disposed = false;
  let flushing = false;
  function flush() {
    if (disposed || flushing) return [];
    const at = now();
    const elapsed = at - windowStartedAt;
    windowStartedAt = at;
    const dimensions = options.dimensions();
    if (dimensions.state === null) return [];
    const counters = options.counters.snapshot();
    options.counters.reset();
    const metrics = buildHealthMetrics({
      counters,
      fixed: options.metrics?.take(),
      latency: options.latency?.take(),
      exposure: options.exposure?.exposure() ?? null,
      windowMs: clampWindowMs(elapsed)
    });
    const configVersion = toConfigVersionText(dimensions.config_version);
    const healthDimensions = {
      sdk_version: dimensions.sdk_version,
      state: dimensions.state,
      ...configVersion === null ? {} : { config_version: configVersion }
    };
    flushing = true;
    let events;
    try {
      events = buildHealthEvents({
        metrics,
        dimensions: healthDimensions,
        occurredAt: at,
        createId,
        maxMetricsPerEvent: options.maxMetricsPerEvent
      });
      for (const event of events) options.emit(event);
    } finally {
      flushing = false;
    }
    options.counters.snapshot();
    options.counters.reset();
    return events;
  }
  return {
    start() {
      if (disposed || cancel !== null) return;
      const timer = options.timer;
      if (timer === void 0) return;
      cancel = timer.schedule(() => {
        flush();
      }, windowMs);
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = cancel;
      cancel = null;
      if (current !== null) current();
    }
  };
}

// src/monitor/traffic.ts
function jsonSize(value) {
  const text = JSON.stringify(value);
  return typeof text === "string" ? text.length : 0;
}
function ratio(part, whole) {
  if (whole > 0) return part / whole;
  return part > 0 ? Number.POSITIVE_INFINITY : 0;
}
function measureTrafficShare(healthEvents, businessEvents) {
  const healthBytes = healthEvents.reduce((total, event) => total + jsonSize(event), 0);
  const businessBytes = businessEvents.reduce((total, event) => total + jsonSize(event), 0);
  return {
    healthEvents: healthEvents.length,
    businessEvents: businessEvents.length,
    healthBytes,
    businessBytes,
    countRatio: ratio(healthEvents.length, businessEvents.length),
    byteRatio: ratio(healthBytes, businessBytes)
  };
}

// src/debug/gate.ts
var DEBUG_QUERY_PARAM = "wr_debug";
var DEFAULT_PRODUCTION_ENVS = ["production", "prod"];
var DISABLED_VALUES = ["0", "false", "off"];
function readQueryParam(search, name) {
  if (search === void 0 || search === "") return null;
  const questionMark = search.indexOf("?");
  const query = questionMark >= 0 ? search.slice(questionMark + 1) : search;
  const params = new URLSearchParams(query);
  if (!params.has(name)) return null;
  return params.get(name) ?? "";
}
function resolveDebugMode(options) {
  const paramName = options.paramName ?? DEBUG_QUERY_PARAM;
  const raw = readQueryParam(options.search, paramName);
  const requested = raw !== null && !DISABLED_VALUES.includes(raw.trim().toLowerCase());
  if (!requested) {
    return { requested: false, allowed: false, enabled: false, reason: "not_requested" };
  }
  const productionEnvs = options.productionEnvs ?? DEFAULT_PRODUCTION_ENVS;
  const env = options.env;
  const nonProduction = env !== void 0 && !productionEnvs.includes(env);
  const allowUsers = options.allowUsers ?? [];
  const candidates = [options.user, options.hashedUser].filter(
    (value) => value !== void 0
  );
  const allowlistedUser = candidates.some((value) => allowUsers.includes(value));
  if (!nonProduction && !allowlistedUser) {
    return {
      requested: true,
      allowed: false,
      enabled: false,
      reason: "production_user_not_allowlisted"
    };
  }
  return {
    requested: true,
    allowed: true,
    enabled: true,
    reason: allowlistedUser ? "allowed_allowlisted_user" : "allowed_non_production"
  };
}

// src/debug/types.ts
var DEBUG_DESTINATIONS = [
  "queued",
  "sent",
  "failed",
  "retry",
  "circuit_open",
  "offline",
  "replayed",
  "dropped",
  "page_leave",
  "emitted"
];

// src/debug/format.ts
var DEBUG_PREFIX = "[web-report-sdk]";
var DESTINATION_LABELS = {
  queued: "\u5DF2\u5165\u961F",
  sent: "\u5DF2\u53D1\u9001",
  failed: "\u53D1\u9001\u5931\u8D25",
  retry: "\u91CD\u8BD5",
  circuit_open: "\u7194\u65AD\u6682\u505C",
  offline: "\u5DF2\u8F6C\u79BB\u7EBF",
  replayed: "\u79BB\u7EBF\u8865\u53D1",
  dropped: "\u5DF2\u4E22\u5F03",
  page_leave: "\u9875\u9762\u79BB\u5F00\u901A\u9053",
  emitted: "\u5DF2\u4EA7\u51FA"
};
var SCRUB_PATTERN = /[^\w.:\-/]/gu;
var SCRUB_MAX_LENGTH = 64;
function scrub(value) {
  return value.replace(SCRUB_PATTERN, "").slice(0, SCRUB_MAX_LENGTH);
}
function formatDiagnosticsRecord(record) {
  const parts = [
    `${DEBUG_PREFIX} ${scrub(record.kind)}`,
    `reason_code=${scrub(record.reason_code)}`,
    record.dropped === "event" ? "\u53BB\u5411=\u4E8B\u4EF6\u672A\u4E0A\u62A5" : "\u53BB\u5411=\u5B57\u6BB5\u672A\u4E0A\u62A5"
  ];
  if (record.event_name !== void 0) parts.push(`event_name=${scrub(record.event_name)}`);
  if (record.field !== void 0) parts.push(`field=${scrub(record.field)}`);
  return parts.join(" ");
}
function formatRouteRecord(record) {
  const parts = [
    `${DEBUG_PREFIX} ${scrub(record.kind)}`,
    `\u53BB\u5411=${DESTINATION_LABELS[record.destination]}`
  ];
  if (record.reason_code !== void 0) parts.push(`reason_code=${scrub(record.reason_code)}`);
  if (record.event_name !== void 0) parts.push(`event_name=${scrub(record.event_name)}`);
  if (record.count !== void 0) parts.push(`count=${String(record.count)}`);
  return parts.join(" ");
}

// src/debug/tracer.ts
function createDebugTracer(options) {
  const enabledOption = options.enabled;
  const isEnabled = typeof enabledOption === "function" ? enabledOption : () => enabledOption;
  return {
    enabled: isEnabled,
    diagnostic(record) {
      if (!isEnabled()) return;
      options.write(formatDiagnosticsRecord(record));
    },
    route(record) {
      if (!isEnabled()) return;
      options.write(formatRouteRecord(record));
    }
  };
}
var NOOP_DEBUG_TRACER = {
  enabled: () => false,
  diagnostic: () => void 0,
  route: () => void 0
};

// src/index.ts
var PACKAGE_NAME = "@web-report-sdk/transport";

export { COUNTED_CALL_METHODS, COUNT_REASON_CODES, DEBUG_DESTINATIONS, DEBUG_PREFIX, DEBUG_QUERY_PARAM, DEFAULT_BACKOFF, DEFAULT_CHANNEL_NAME, DEFAULT_CIRCUIT, DEFAULT_DEAD_SESSION_MS, DEFAULT_HEALTH_WINDOW_MS, DEFAULT_IDLE_FLUSH_MS, DEFAULT_LATENCY_CALL_METHODS, DEFAULT_LATENCY_CAPACITY, DEFAULT_LOCK_NAME, DEFAULT_MAX_BATCH_BYTES, DEFAULT_MAX_BATCH_EVENTS, DEFAULT_MAX_WAIT_MS, DEFAULT_OFFLINE_LIMITS, DEFAULT_PRODUCTION_ENVS, DEFAULT_REPLAY_BATCHES_PER_SECOND, DEFAULT_SESSION_SAMPLE_RATE, DEFAULT_SLOW_EFFECTIVE_TYPES, DEFAULT_WEAK_BATCH_EVENTS_MULTIPLIER, DEFAULT_WEAK_IDLE_FLUSH_MS_MULTIPLIER, DEFAULT_WEAK_NETWORK_POLICY, DESTINATION_LABELS, DROP_REASON_CODES, FIXED_METRIC_NAMES, LATENCY_METRIC_NAMES, LATENCY_STAGES, LEAVE_BUDGET, LIMIT_RANGES, MAX_METRICS_PER_EVENT, METRIC_EXPOSURE_WINDOW_EVENTS, METRIC_EXPOSURE_WINDOW_MS, MIN_SETTLE_MS, NOOP_DEBUG_TRACER, OFFLINE_DB_NAME, OFFLINE_FORMAT_VERSION, PACKAGE_NAME, QUEUE_MAX_BYTES, QUEUE_MAX_EVENTS, REASON_CIRCUIT_OPEN, REASON_OFFLINE_EVICTED, REASON_OFFLINE_INCOMPATIBLE, REASON_PREWRITE_COMMIT_LOST, REASON_PROCESSOR_ERROR, REASON_QUEUE_EVICTED, REASON_REJECTED_400, REASON_REJECTED_401, REASON_REJECTED_403, REASON_REJECTED_413, REASON_REPLAYED, REASON_RETRY_429, REASON_RETRY_5XX, REASON_RETRY_EXHAUSTED, REASON_RETRY_NETWORK, REASON_SPLIT_413, REASON_STORAGE_UNAVAILABLE, REPLAY_BATCHES_PER_SECOND_MAX, WINDOW_METRIC_KEY, buildHealthEvents, buildHealthMetrics, captureNativeHttpRefs, clampWindowMs, combineFixedMetrics, createBatchAssembler, createCallCounter, createDebugTracer, createDefaultBroadcastPort, createDefaultLocksPort, createDelivery, createDeliveryMetricsSource, createDomPageEventsSource, createDomPageLeaveSource, createFixedMetricsAccumulator, createHealthDimensionsReader, createHealthReporter, createIdbBackend, createLatencyDecorators, createLatencyWindow, createLeaderElection, createMemoryQueue, createOfflineExposureSource, createOfflineStore, createQueueMetricsSource, createRegistryTimer, createReplayController, createSessionSampler, createSubmitMetricsSource, createTransportQueue, estimateEventBytes, formatDiagnosticsRecord, formatRouteRecord, jsonSize, measureTrafficShare, nearestRankPercentile, resolveDebugMode, resolveLimits, supportsFetchKeepalive };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map