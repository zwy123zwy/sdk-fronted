/**
 * CR-008（2026-10-14 批准）追加到 `sdk_health.metrics` 的**四个指标键**的本地副本。
 *
 * **这是契约数据的本地副本**：成员、顺序都必须与机器可读权威
 * `docs/contracts/schemas/builtin-events/sdk_health.schema.json` 的 `metrics.properties`
 * 中 description 以 `CR-008：` 开头的键一致；`cr008-observables.test.ts` 从真实 Schema
 * 推导并双向比对，任何一侧漂移（少、多、错序）都会让门禁失败。
 *
 * 两组键的口径（`docs/contracts/changes/CR-008-squeeze-bounds-and-observables.md`）：
 * - **夹逼端点**：D004 的真实暴露窗口 W 的右端点（进程死亡时刻）在客户端不可观测，
 *   因此契约**不承诺**一个叫"真实窗口"的字段，只承诺两个显式命名的区间端点：
 *   `[exposure_window_lower_bound_ms, exposure_window_upper_bound_ms]`。
 *   上界与既有 `exposure_window_ms` 同源同值（都是 `reconcileCommitLoss().windowMs`）。
 * - **两个观测量**：CR-001 §5.2 第 3 条裁定 `flush_skipped_due_to_budget`、`leader_lost`
 *   **不新增原因码**、改为观测量上报；名字照抄 CR-001 原文，**不加 `drop_` / `count_` 前缀**
 *   （它们不是原因码：没有任何事件被丢弃）。
 */

/** 暴露窗口夹逼的**下界**（`stats().exposure.commitLostObservedWindowMs`）。 */
export const EXPOSURE_WINDOW_LOWER_BOUND_MS = 'exposure_window_lower_bound_ms';

/** 暴露窗口夹逼的**上界**（与 `exposure_window_ms` 同源同值，只是名字显式标注为上界）。 */
export const EXPOSURE_WINDOW_UPPER_BOUND_MS = 'exposure_window_upper_bound_ms';

/** CR-001 裁定的观测量：离开 burst 内首次因预算用尽而停手的次数（不是原因码）。 */
export const METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET = 'flush_skipped_due_to_budget';

/** CR-001 裁定的观测量：本标签页从 leader 变为非 leader 的次数（不是原因码）。 */
export const METRIC_LEADER_LOST = 'leader_lost';

/** 两个**观测量**的契约指标名（照抄 CR-001 §5.2 的原文名字，顺序与 Schema 一致）。 */
export const CR008_OBSERVABLE_METRIC_KEYS = [
  METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET,
  METRIC_LEADER_LOST,
] as const;

/** CR-008 追加的**全部**契约指标名（顺序与 Schema 的 `properties` 顺序一致，用于漂移锁定）。 */
export const CR008_METRIC_KEYS = [
  EXPOSURE_WINDOW_LOWER_BOUND_MS,
  EXPOSURE_WINDOW_UPPER_BOUND_MS,
  METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET,
  METRIC_LEADER_LOST,
] as const;
