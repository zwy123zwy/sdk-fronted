# @web-report-sdk/transport

传输包（C06–C08）。当前实现 **C06 队列与调度（T15）**；C07 发送与可靠投递、C08 自监控由 T16/T17 补充。

- 零运行时依赖；模块顶层无副作用（不注册监听、不访问 `window`），可在 SSR 与 Vitest 中直接导入。
- C06 **不负责发送**：批次通过注入的 `BatchSubmitPort` 交出；离线存储、生效配置、网络信息、页面离开信号同样为注入接口。
- 公共 API 只从 `src/index.ts` 暴露；本文件是给 T16 的接口约定（T15 交接产物）。

## 1. 快速用法

```ts
import { createTransportQueue, createDomPageLeaveSource } from '@web-report-sdk/transport';

const queue = createTransportQueue({
  config: { transport: () => config.transport },      // C03：生效配置的 transport 组
  header: { header: () => buildBatchHeader() },       // C04/C07：批次公共头
  submit: mySender,                                    // T16：提交批次
  offline: myOfflineStore,                             // T16：溢出转离线（critical）
  network: myNetworkInfo,                              // C06-F5：navigator.connection
  pageLeave: createDomPageLeaveSource(document),       // C02 也可用全局注册表接管监听
  counters,                                            // C08：原因码计数
});

queue.enqueue(event);   // 入队并按需冲刷
queue.flush();          // 业务主动冲刷（C06-F2）
queue.dispose();        // 销毁：清除定时器与页面离开订阅
```

## 2. 交接接口定义（给 T16）

> **已冻结（2026-10-12，前端负责人确认）**：本节的五组接口——提交批次、在途状态、熔断信号、批次头来源、溢出转离线——是 T16 的冻结基线（与 `batch.schema.json` 的 `additionalProperties: false`、`events.minItems: 1` 及 `reason-codes.md` 一致）。T16 若需改签名，必须先通知负责人，不得单方面变更。

### 2.1 提交批次：`BatchSubmitPort`

```ts
type SubmitChannel = 'default' | 'page_leave';
type SubmitOutcome = 'sent' | 'failed' | 'circuit_open';

interface SubmitContext {
  readonly channel: SubmitChannel;
  /** 必须在批次处理结束后调用；可以同步调用（如同步 XHR / sendBeacon 判定失败）。 */
  readonly complete: (outcome: SubmitOutcome) => void;
}

interface BatchSubmitPort {
  submit(batch: BatchEnvelope, context: SubmitContext): void;
}
```

- `batch` 已通过 `docs/contracts/schemas/batch.schema.json` 校验所需的结构（字段提升已完成）。
- **约定：`submit` 不向 C06 抛错**；失败用 `context.complete('failed')` 上报。若实现仍抛错，C06 会捕获、计 `processor_error` 并释放该批次的在途状态（该批次的事件不再回到队列）。
- `complete` 必须在批次处理结束后调用一次；重复调用会被忽略。不调用则 C06 认为该批次一直在途。
- `channel === 'page_leave'` 表示页面正在离开（`visibilitychange` → hidden 或 `pagehide`），T16 应走信标 / 同步发送通道。

### 2.2 在途状态与在途控制（C06-F4）

- 同一时刻**只允许一个常规批次在途**。`queue.inFlight()` 反映该状态；在途期间新的冲刷触发（条数、体积、空闲、最长等待、业务 `flush`）都不会发出第二个常规批次，事件继续入队。
- 在途批次 `complete` 后，C06 立即继续冲刷积压事件：先武装空闲/最长等待计时器，再在有积压且未熔断时立即 `pump`。
- `flush()` 返回 `FlushResult.status`：`submitted` | `empty` | `in_flight` | `circuit_open`，便于 C07 观测。
- **例外**：页面离开（`page_leave`）是同步通道，不受在途限制；一次离开可以连续提交多个批次（受 `max_batch_events` / `max_batch_bytes` 分段，事件总数上限为内存队列的 500 条）。

### 2.3 熔断信号（C07 → C06）

```ts
type SubmitOutcome = 'sent' | 'failed' | 'circuit_open';
interface TransportQueue {
  isCircuitOpen(): boolean;
  setCircuitOpen(open: boolean): void;
}
```

- 两种设置方式：`context.complete('circuit_open')`（C07 在提交结果里上报）或 `queue.setCircuitOpen(true)`（C07 的熔断器主动通知）。
- 熔断生效后：暂停常规冲刷（清空已武装的计时器），事件继续入队；队列满了仍按 C06-F1 淘汰 normal 事件。`flush()` 返回 `circuit_open` 并计 `circuit_open`（计时器与入队触发的抑制不重复计数）。
- 关闭熔断（`setCircuitOpen(false)`）时，如果队列有积压且无在途批次，C06 立即冲刷一次。
- 页面离开通道不受熔断限制（离开时的同步发送由 T16 决定是否退化为本地存储）。

### 2.4 批次头来源：`BatchHeaderSource`

```ts
interface BatchHeaderSource {
  header(): BatchHeader;   // 每个批次组装时调用一次
}
```

`BatchHeader` 覆盖批次 Schema 的必填头字段：`protocol_version`（常量 `1`）、`app_id`、`env`、`release`、`sdk_name`、`sdk_version`、`device_id`、`session_id`、`clock_offset`，以及可选字段 `device_id_persistent`、`user_id`、`user_id_hashed`、`consent`、`clock_calibrated`。

- **由 C04/C07 提供**，C06 不编造：设备/会话/版本/时钟偏移/同意状态都不在 C06 的职责内。
- C06 生成每个批次的 `batch_id`（缺省 `crypto.randomUUID()`，不可用时退回 Math.random 的 UUID v4）与 `sent_at`（缺省 `Date.now()`）；可用 `now` / `createId` 覆盖（便于测试与确定性）。
- 组装器只输出批次 Schema 声明的字段；事件体中未声明的字段由 C04 在字段约束阶段处理，不进入批次（Schema 是 `additionalProperties: false`）。
- 事件为空时不组装（`assemble` 抛错；批次 Schema 的 `events.minItems` 为 1），调度器保证只对非空片段调用。

### 2.5 溢出转离线：`OfflineSpillPort`

```ts
interface OfflineSpillPort {
  /** 返回 true 表示受理；返回 false 或抛错表示离线存储不可用。 */
  spill(event: QueueEvent, reason: 'queue_overflow'): boolean;
}
```

- 调用时机：内存队列溢出、**已无 normal 事件可淘汰**、新到事件为 critical 时（全是 critical 的队列）。C06 把新到事件交给该接口，不改动队列内容。
- **语义约定（2026-10-12 前端负责人确认）**：溢出转入离线存储的是**新到的** critical 事件；内存队列中已有的 critical 保持不变（避免丢已有数据）。normal 事件不写离线存储。
- 未注入或返回 false/抛错时：该 critical 事件被丢弃并计 `storage_unavailable`（reason-codes.md 第 2 节）。
- normal 事件不写离线存储：溢出时优先淘汰最早的 normal，并计 `queue_evicted`。
- C07 的离线存储上限、7 天过期、容量淘汰仍由 T16 自己计数（`offline_evicted` 等）。

### 2.6 其他注入接口

| 接口 | 提供方 | 说明 |
|---|---|---|
| `TransportConfigPort.transport()` | C03 | 返回生效配置的 `transport` 组；**每次冲刷重新读取**，支持运行期配置变更 |
| `NetworkInfoPort.snapshot()` | C06/C03 | `{ effectiveType, saveData }`；命中弱网时放大上限 |
| `PageLeaveSource.subscribe()` | C02/C06 | 页面离开信号；`createDomPageLeaveSource(document)` 是 DOM 实现 |
| `CountersPort.count()` | C08 | 原因码计数，与 `packages/core` 的 `Counters` 结构兼容 |

## 3. 参数、默认值与不变量

`transport` 组（`remote-config.schema.json`）与 C06 默认值：

| 参数 | 契约区间 | C06 默认值 | 用途 |
|---|---|---|---|
| `max_batch_events` | 1–100 | 20 | 入队条数达到上限立即冲刷（C06-F2） |
| `max_batch_bytes` | 1024–61440 | 32768（32 KB） | 入队体积达到上限立即冲刷（C06-F2） |
| `idle_flush_ms` | 200–10000 | 1000 | 静默冲刷（C06-F2） |
| `max_wait_ms` | 1000–60000 | 5000 | 距首条事件的最长等待（C06-F2） |
| `replay_batches_per_second` | (0, 2] | 1 | 透传给 C07 的补发限速 |

- 超出区间或非整数的取值回退到默认值；缺失字段用默认值。
- 内存队列：条数上限 **500**、体积上限 **512 KB**（`QUEUE_MAX_EVENTS` / `QUEUE_MAX_BYTES`，双上限同时生效）。
- 体积口径：按 UTF-16 码元估算（`estimateEventBytes`），估算值不小于实际 JSON 长度。
- `drainUpTo` 总是至少取一条事件，避免单条事件超过批体积上限时死循环。

### 弱网自适应（C06-F5）

命中条件：`effectiveType` 属于 `slowEffectiveTypes`（缺省 `['slow-2g', '2g']`）**或** `saveData === true`。
行为：`max_batch_events` × `batchEventsMultiplier`、`idle_flush_ms` × `idleFlushMsMultiplier`（缺省均 2 倍），再钳制回契约上限（100 / 10000）；体积上限与最长等待不变。

> **已裁定（2026-10-12，前端负责人）**：放大倍率**不做远程可配**，保持为 `TransportQueueOptions.weakNetwork` 运行期参数。理由：冻结的 `remote-config.schema.json` 的 `transport` 组是 `additionalProperties: false` 且没有对应字段，为它加字段属于契约变更，收益不抵成本。默认 2 倍并钳制回契约上限（`max_batch_events` ≤ 100、`idle_flush_ms` ≤ 10000）。T16/T20 按此实现与测试。

## 4. C06 计数（通过 `CountersPort`）

| 原因码 | 触发 |
|---|---|
| `queue_evicted` | 内存队列溢出，淘汰最早的 normal 事件（reason-codes.md 第 1 节） |
| `storage_unavailable` | critical 溢出且离线存储未注入或不可用 |
| `circuit_open` | 熔断期间业务/计时器触发的冲刷被暂停 |
| `processor_error` | 批次组装或提交端口抛错（只计数，流程继续） |

`events_enqueued`、`batches_sent` 等发送侧指标由 C07/C08 统计，不在 C06。

> **已裁定（2026-10-12，前端负责人）**：复用契约已有原因码，**不新增**。`storage_unavailable` 覆盖「离线存储不可用导致 critical 无法落盘」，`processor_error` 覆盖「处理/提交端口抛错」，两者语义已足够；若将来需要更精确的码，走契约变更请求。

## 5. 模块与测试

| 路径 | 内容 |
|---|---|
| `src/queue/` | 双上限内存队列、冲刷调度、页面离开适配、上限解析 |
| `src/batch/` | 批次组装与字段提升（C06-F3） |

验收用例：`tests/acceptance/C06.md` 的 C06-AC-01 至 C06-AC-11，可执行用例分布在
`src/queue/memory-queue.test.ts`、`src/queue/transport-queue.test.ts`、`src/batch/assembler.test.ts`、
`src/queue/perf.test.ts`；时间相关断言全部使用假定时器。
C06-AC-09 用 `ajv`（Ajv2020）编译 `docs/contracts/schemas/batch.schema.json` 真实校验线上 JSON，
包含一条反例对照（缺必填头字段 / 未声明字段判为非法）证明校验是有效门禁。

### 非功能目标与回归护栏（`src/queue/perf.test.ts`）

**契约目标**：入队 P99 ≤ 0.01 ms；单批组装与序列化 ≤ 2 ms。
**空闲实测**（无并发负载，2026-10-12）：入队 P99 **0.00287 ms**；单批组装+序列化均值 **0.0143 ms**。
**权威验证**：由 **T20 的基准套件在受控环境下**完成；单元测试里的耗时断言只是**回归护栏**，不是契约目标值。

护栏锚定**中位数 P50** 而不是 P99，原因是返工实测（并发 lane 的全量 `pnpm test`，load average 5–16）：

| 指标 | 有负载 P50 | 有负载单轮 P99 |
|---|---|---|
| 入队 | 0.005–0.0073 ms | 0.021–**0.429** ms |
| 单批组装+序列化 | 0.041–0.0487 ms | 最高 **51.7** ms |

P99/均值在共享机器上由进程抢占主导，以契约目标值当门禁会必现误报，而以「有负载 P99 × 10」当门禁会超过 1 ms。
护栏取中位数的 ≥10 倍余量，均 < 1 ms：入队 P50 < 0.1 ms（≥13 倍于有负载实测最大值，≈35 倍于空闲 P99）；
组装+序列化 P50 < 0.6 ms（≥12 倍于有负载实测最大值，≈42 倍于空闲均值）。二者仍能拦住 10 倍量级的病态回归。
