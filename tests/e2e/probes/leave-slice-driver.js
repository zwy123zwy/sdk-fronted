/**
 * C07-AC-03（离开通道切片路径）页内探针。
 *
 * 只做两件事：调用**真实实现**（`packages/transport/dist` 的 ESM 产物，`?transport=` 可换变体），
 * 使用**真实浏览器 API**（真实 `navigator.sendBeacon`），把观测到的原始数字交回 Node 侧。
 * 任何判定都在 spec 里做（与 T29 的分工一致）。
 *
 * 本探针**不修改实现**：切片/预算全部走真实代码路径。唯一可注入的是 `leaveBudget`
 * （`createDelivery` 的既有公开选项），用来把「切片机制」与「离开预算」两个变量分开测量。
 */
const PARAMS = new globalThis.URLSearchParams(globalThis.location.search);
const TRANSPORT_URL = PARAMS.get('transport') ?? '/transport/index.js';

// 顶层 await：探针必须真实加载指定变体，加载失败要让 Node 侧看见（不静默降级）。
const T = await import(TRANSPORT_URL);

const APP_ID = 'ac03';
const WRITE_TOKEN = 'tok-ac03';

function buildEvents({ count, padBytes, numericFields }) {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const metrics = {};
    for (let n = 0; n < numericFields; n += 1) metrics[`m${n}`] = 1;
    events.push({
      event_id: `ac03-${String(i).padStart(4, '0')}`,
      event_name: 'ac03_slice',
      event_type: 'custom',
      schema_version: 1,
      // 固定时间戳：让每次运行的字节数可复现（不受时钟影响）。
      occurred_at: 1_750_000_000_000 + i,
      priority: 'normal',
      attachment: 'A'.repeat(padBytes),
      ...(numericFields > 0 ? { metrics } : {}),
    });
  }
  return events;
}

function buildEnvelope(events) {
  return {
    protocol_version: 1,
    app_id: APP_ID,
    env: 'e2e',
    release: 'e2e',
    sdk_name: '@web-report-sdk/browser',
    sdk_version: '0.0.0',
    device_id: 'ac03-device',
    session_id: 'ac03-session',
    clock_offset: 0,
    consent: 'granted',
    batch_id: 'ac03-batch',
    sent_at: 1_750_000_000_000,
    events,
  };
}

function countingPort() {
  const counts = {};
  return {
    counts,
    port: {
      count(reason) {
        counts[reason] = (counts[reason] ?? 0) + 1;
      },
    },
  };
}

globalThis.window.__ac03 = {
  /** 探针与真实实现的常量/能力（判定用的口径都从这里取，不靠猜）。 */
  config() {
    return {
      transportUrl: TRANSPORT_URL,
      leaveBudget: T.LEAVE_BUDGET ?? null,
      hasCreateDelivery: typeof T.createDelivery === 'function',
      hasEstimateEventBytes: typeof T.estimateEventBytes === 'function',
      hasSliceForBeacon: typeof T.sliceForBeacon === 'function',
      hasSendBeacon: typeof globalThis.navigator.sendBeacon === 'function',
      userAgent: globalThis.navigator.userAgent,
    };
  },

  /** 对照：单次 `navigator.sendBeacon`（复现 T29 的 80 KB → false）。 */
  rawBeacon(url, bytes) {
    const payload = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 1) payload[i] = i % 251;
    let accepted = null;
    let error = null;
    try {
      accepted = globalThis.navigator.sendBeacon(
        url,
        new globalThis.Blob([payload], { type: 'text/plain' }),
      );
    } catch (caught) {
      error = String(caught);
    }
    return { bytes, accepted, error };
  },

  /**
   * 对照：在**同一个任务里连续调用**多次 `navigator.sendBeacon`（尺寸序列），返回每次的返回值。
   * 用来隔离浏览器侧的「单次上限 / 累计在途额度」，与实现无关。
   */
  rawBeaconSequence(url, sizes) {
    const accepted = [];
    for (const bytes of sizes) {
      const payload = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i += 1) payload[i] = i % 251;
      try {
        accepted.push(
          globalThis.navigator.sendBeacon(
            url,
            new globalThis.Blob([payload], { type: 'text/plain' }),
          ),
        );
      } catch {
        accepted.push(false);
      }
    }
    return accepted;
  },

  /**
   * 走**真实离开通道**（`channel: 'page_leave'` → `createLeaveSender` → `sliceForBeacon`）
   * 发一个批次，返回 SDK 侧观测量与期望的事件序列。
   * @param {{url: string, count: number, padBytes: number, numericFields: number,
   *          budget?: object, waitMs?: number}} options
   */
  sliceSend(options) {
    const events = buildEvents(options);
    const envelope = buildEnvelope(events);
    const { counts, port } = countingPort();
    const delivery = T.createDelivery({
      appId: APP_ID,
      sessionId: 'ac03-session',
      credentials: {
        current: () => ({ endpoint: options.url, appId: APP_ID, writeToken: WRITE_TOKEN, revision: 1 }),
      },
      http: { sendBeacon: globalThis.navigator.sendBeacon.bind(globalThis.navigator) },
      offline: { idbFactory: null },
      counters: port,
      ...(options.budget === undefined ? {} : { leaveBudget: options.budget }),
    });

    const complete = [];
    delivery.submit.submit(envelope, {
      channel: 'page_leave',
      complete: (status) => complete.push(String(status)),
    });

    // sendBeacon 没有完成回调：等接收端真的收到（Node 侧再按请求数收敛确认）。
    return new Promise((resolve) => {
      globalThis.setTimeout(() => {
        const metrics = delivery.metrics();
        delivery.dispose();
        resolve({
          expectedIds: events.map((event) => event.event_id),
          eventCount: events.length,
          oneEventActualBytes: JSON.stringify(events[0]).length,
          oneEventEstimateBytes: T.estimateEventBytes(events[0]),
          eventsActualBytes: events.reduce((sum, event) => sum + JSON.stringify(event).length + 1, 0),
          eventsEstimateBytes: events.reduce((sum, event) => sum + T.estimateEventBytes(event) + 2, 0),
          wholeBatchJsonBytes: JSON.stringify(envelope).length,
          singleBodyWithAuthBytes: JSON.stringify({
            ...envelope,
            auth: { app_id: APP_ID, write_token: WRITE_TOKEN },
          }).length,
          leave: metrics.leave,
          complete,
          counters: { ...counts },
        });
      }, options.waitMs ?? 1_500);
    });
  },
};

globalThis.window.__ac03Ready = true;
