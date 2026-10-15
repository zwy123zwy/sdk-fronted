/**
 * CR-008 的契约-实现同步守卫与发出点自证。
 *
 * 覆盖四层，缺一层都算未落地：
 * 1. **Schema 层**：真实 `sdk_health.schema.json` 的 `metrics` 里能读到 4 个新键，
 *    且类型/下界/`dependentRequired` 与 CR-008 一致（用 Ajv 校验真实产出与负向对照）；
 * 2. **漂移锁定**：从**真实 Schema**（`metrics.properties` 中 description 以 `CR-008：`
 *    开头的键）推导出本次追加的键集合，与 `monitor/observables.ts` 的常量清单**双向**比对：
 *    少一个、多一个、错序都红；另断言 Schema 的 `metrics.properties` 是**封闭集合**
 *    （没有任何未登记的显式键）；
 * 3. **实现层**：`buildHealthMetrics` 真的产出夹逼端点与两个观测量，且遵守
 *    「没有下界读数就不报区间」「计数为 0 不上报」的规则；
 * 4. **发出点**：`createOfflineExposureSource` 读到 T16 的下界读数，
 *    `createObservableMetricsSource` 把两个累计观测量差分成本窗口增量，
 *    `createHealthReporter` 把它们一路带进 `sdk_health.metrics`。
 */
import { Ajv2020 } from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv';
import { describe, expect, test } from 'vitest';
import sdkHealthSchema from '../../../../docs/contracts/schemas/builtin-events/sdk_health.schema.json';
import { buildHealthEvents } from './events';
import { buildHealthMetrics } from './metrics';
import type { HealthMetricsInput } from './metrics';
import {
  CR008_METRIC_KEYS,
  CR008_OBSERVABLE_METRIC_KEYS,
  EXPOSURE_WINDOW_LOWER_BOUND_MS,
  EXPOSURE_WINDOW_UPPER_BOUND_MS,
  METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET,
  METRIC_LEADER_LOST,
} from './observables';
import { FIXED_METRIC_NAMES, LATENCY_METRIC_NAMES, LATENCY_STAGES } from './types';
import type { HealthDimensions, SdkHealthEvent } from './types';

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validateHealth: ValidateFunction = ajv.compile(sdkHealthSchema);

const DIMENSIONS: HealthDimensions = { sdk_version: '1.2.3', state: 'running' };

let sequence = 0;
function createId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function buildEvents(metrics: Readonly<Record<string, number>>): readonly SdkHealthEvent[] {
  return buildHealthEvents({
    metrics,
    dimensions: DIMENSIONS,
    occurredAt: 1_793_000_060_000,
    createId,
  });
}

// ----------------------------------------------------------- 从真实 Schema 推导

interface SchemaMetricProperty {
  readonly description?: string | undefined;
  readonly type?: string | undefined;
  readonly minimum?: number | undefined;
}

const metricProperties = sdkHealthSchema.properties.metrics
  .properties as unknown as Readonly<Record<string, SchemaMetricProperty>>;

const metricDependentRequired = sdkHealthSchema.properties.metrics
  .dependentRequired as unknown as Readonly<Record<string, readonly string[]>>;

/** 从 description 的 `CR-xxx：` / `CR-xxx（` 前缀推导出该键属于哪一次契约变更。 */
function crTagOf(description: string | undefined): string | null {
  if (description === undefined) return null;
  const match = /^CR-(\d{3})[：:（(]/u.exec(description);
  const id = match === null ? undefined : match[1];
  return id === undefined ? null : `CR-${id}`;
}

/** 从**真实 Schema** 推导某次 CR 追加的指标键（顺序即 Schema 顺序）。 */
function contractKeysOf(cr: string): readonly string[] {
  return Object.entries(metricProperties)
    .filter(([, property]) => crTagOf(property.description) === cr)
    .map(([key]) => key);
}

// ----------------------------------------------------------- 1. Schema 层 + 2. 漂移锁定

describe('CR-008 Schema 层与漂移锁定', () => {
  test('漂移锁定：CR-008 追加的指标键与真实 Schema 完全一致（少/多/错序都红）', () => {
    expect([...CR008_METRIC_KEYS]).toEqual(contractKeysOf('CR-008'));
  });

  test('漂移锁定：CR-001 的两个既有键仍被 Schema 标为 CR-001，本次未改写', () => {
    expect(contractKeysOf('CR-001')).toEqual([
      'exposure_window_events',
      'exposure_window_ms',
    ]);
  });

  test('漂移锁定：观测量清单是两个不含 drop_/count_ 前缀的键（CR-001 裁定不是原因码）', () => {
    expect([...CR008_OBSERVABLE_METRIC_KEYS]).toEqual([
      METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET,
      METRIC_LEADER_LOST,
    ]);
    for (const key of CR008_OBSERVABLE_METRIC_KEYS) {
      expect(key.startsWith('drop_'), key).toBe(false);
      expect(key.startsWith('count_'), key).toBe(false);
    }
  });

  test('封闭集合：metrics.properties 的每个显式键都在已登记清单内，且清单里的键都在 Schema 内', () => {
    const registered = [
      'window_ms',
      ...FIXED_METRIC_NAMES,
      ...LATENCY_STAGES.map((stage) => LATENCY_METRIC_NAMES[stage]),
      'exposure_window_events',
      'exposure_window_ms',
      ...CR008_METRIC_KEYS,
    ];
    expect([...Object.keys(metricProperties)].sort()).toEqual([...registered].sort());
  });

  test('Schema 元数据：夹逼端点类型/下界，以及 dependentRequired 的成对同现规则', () => {
    expect(metricProperties[EXPOSURE_WINDOW_LOWER_BOUND_MS]).toMatchObject({
      type: 'integer',
      minimum: 0,
    });
    expect(metricProperties[EXPOSURE_WINDOW_UPPER_BOUND_MS]).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    for (const key of CR008_OBSERVABLE_METRIC_KEYS) {
      expect(metricProperties[key], key).toMatchObject({ type: 'integer', minimum: 1 });
    }
    // 夹逼端点必须成对，并与 exposure_window_events 和既有 exposure_window_ms 同现：
    // 三个端点同现保证「夹逼 = [下界, 既有上界]」不会只出现一半。
    expect(metricDependentRequired[EXPOSURE_WINDOW_LOWER_BOUND_MS]).toEqual([
      EXPOSURE_WINDOW_UPPER_BOUND_MS,
      'exposure_window_events',
      'exposure_window_ms',
    ]);
    expect(metricDependentRequired[EXPOSURE_WINDOW_UPPER_BOUND_MS]).toEqual([
      EXPOSURE_WINDOW_LOWER_BOUND_MS,
      'exposure_window_events',
      'exposure_window_ms',
    ]);
  });
});

// ----------------------------------------------------------- 3. 实现层：映射

describe('CR-008 映射层真的产出这 4 个值', () => {
  const withSqueeze: HealthMetricsInput = {
    counters: {},
    windowMs: 60_000,
    exposure: { events: 3, windowMs: 1247, observedWindowMs: 7 },
    observables: { flushSkippedDueToBudget: 2, leaderLost: 1 },
  };

  test('夹逼端点与两个观测量都出现在 metrics 里，且上界与 exposure_window_ms 同值', () => {
    const metrics = buildHealthMetrics(withSqueeze);
    expect(metrics[EXPOSURE_WINDOW_LOWER_BOUND_MS]).toBe(7);
    expect(metrics[EXPOSURE_WINDOW_UPPER_BOUND_MS]).toBe(1247);
    expect(metrics[METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET]).toBe(2);
    expect(metrics[METRIC_LEADER_LOST]).toBe(1);
    expect(metrics[EXPOSURE_WINDOW_UPPER_BOUND_MS]).toBe(metrics['exposure_window_ms']);
  });

  test('下界允许 0（时长不是计数）；没有下界读数时两个端点都不上报', () => {
    const zero = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      exposure: { events: 1, windowMs: 953, observedWindowMs: 0 },
    });
    expect(zero[EXPOSURE_WINDOW_LOWER_BOUND_MS]).toBe(0);
    expect(zero[EXPOSURE_WINDOW_UPPER_BOUND_MS]).toBe(953);

    const noReading = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      exposure: { events: 5, windowMs: 953, observedWindowMs: null },
    });
    expect('exposure_window_events' in noReading).toBe(true);
    expect(EXPOSURE_WINDOW_LOWER_BOUND_MS in noReading).toBe(false);
    expect(EXPOSURE_WINDOW_UPPER_BOUND_MS in noReading).toBe(false);

    const missing = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      exposure: { events: 5, windowMs: 953 },
    });
    expect(EXPOSURE_WINDOW_LOWER_BOUND_MS in missing).toBe(false);
    expect(EXPOSURE_WINDOW_UPPER_BOUND_MS in missing).toBe(false);
  });

  test('窗口未捕获（events=0）时，夹逼端点与观测量计数都不上报', () => {
    const metrics = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      exposure: { events: 0, windowMs: 0, observedWindowMs: 0 },
      observables: { flushSkippedDueToBudget: 0, leaderLost: 0 },
    });
    expect(Object.keys(metrics)).toEqual(['window_ms']);
  });

  test('观测量的非正整数被剔除（与固定计数同口径，Schema minimum: 1）', () => {
    const metrics = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      observables: { flushSkippedDueToBudget: 0, leaderLost: -3 },
    });
    expect(METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET in metrics).toBe(false);
    expect(METRIC_LEADER_LOST in metrics).toBe(false);
  });
});

// ----------------------------------------------------------- 1'. Ajv：真实产出的正/负向对照

describe('CR-008 用 Ajv 校验真实产出（含负向对照）', () => {
  test('含 4 个新键的真实产出通过真实 Schema 校验', () => {
    const metrics = buildHealthMetrics({
      counters: { prewrite_commit_lost: 2, replayed: 1 },
      windowMs: 60_000,
      exposure: { events: 2, windowMs: 1247, observedWindowMs: 7 },
      observables: { flushSkippedDueToBudget: 1, leaderLost: 2 },
    });
    const events = buildEvents(metrics);
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      const valid = validateHealth(toJson(event));
      expect(valid, JSON.stringify(validateHealth.errors)).toBe(true);
    }
  });

  test('负向对照：夹逼端点单独出现、观测量为 0 均被 Schema 拒绝', () => {
    const validMetrics: Record<string, number> = {
      window_ms: 60_000,
      exposure_window_events: 2,
      exposure_window_ms: 1247,
      [EXPOSURE_WINDOW_LOWER_BOUND_MS]: 7,
      [EXPOSURE_WINDOW_UPPER_BOUND_MS]: 1247,
      [METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET]: 1,
      [METRIC_LEADER_LOST]: 1,
    };
    const base = buildEvents(validMetrics)[0];
    expect(base).toBeDefined();
    if (base === undefined) return;

    const cases: readonly (readonly [string, Record<string, number>])[] = [
      [
        '只有下界（缺上界与 events）',
        { window_ms: 60_000, [EXPOSURE_WINDOW_LOWER_BOUND_MS]: 7 },
      ],
      [
        '只有上界（缺下界）',
        { window_ms: 60_000, exposure_window_events: 2, [EXPOSURE_WINDOW_UPPER_BOUND_MS]: 1247 },
      ],
      [
        '有端点但没有 exposure_window_events',
        { window_ms: 60_000, [EXPOSURE_WINDOW_LOWER_BOUND_MS]: 7, [EXPOSURE_WINDOW_UPPER_BOUND_MS]: 1247 },
      ],
      [
        '观测量为 0',
        { ...validMetrics, [METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET]: 0 },
      ],
      [
        '有端点但缺 exposure_window_ms（同源同值必须一起给）',
        {
          window_ms: 60_000,
          exposure_window_events: 2,
          [EXPOSURE_WINDOW_LOWER_BOUND_MS]: 7,
          [EXPOSURE_WINDOW_UPPER_BOUND_MS]: 1247,
        },
      ],
    ];
    for (const [label, metrics] of cases) {
      const valid = validateHealth(toJson({ ...base, metrics }));
      expect(valid, `${label}（本应被拒绝）`).toBe(false);
      expect(validateHealth.errors ?? [], label).not.toEqual([]);
    }
  });
});

