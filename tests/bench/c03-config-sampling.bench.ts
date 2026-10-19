/**
 * C03 配置与采样基准（T20 是契约目标值的权威验证方；单元护栏见
 * `packages/core/src/config/perf.test.ts` 与 `packages/core/src/sampling/perf.test.ts`）。
 *
 * 契约目标值（T13 任务卡）：
 * - **采样判定单条 P99 ≤ 0.01 ms**；
 * - 三级配置合并**没有**任务卡指标（T13 只要求「拉取不阻塞初始化」），因此合并耗时**只记录**，
 *   不设达标线（单元护栏里的 0.05 ms 是该文件自定的回归护栏，不是契约值）。
 */
import { afterAll, describe, expect, test } from 'vitest';

import { loadCoreEntry } from './lib/entries';
import { makeKernelEvent } from './lib/fixtures';
import { createBenchReport } from './lib/report';
import { summarize, timedIterations, warmup } from './lib/stats';

const report = createBenchReport('c03-config-sampling');

/** 契约目标：采样判定单条 P99。 */
const SAMPLING_P99_TARGET_MS = 0.01;

const MERGE_SAMPLES = 5_000;
const SAMPLING_ITERATIONS = 20_000;
const SAMPLING_WARMUP = 2_000;

afterAll(() => {
  report.finish();
});

describe('T20 基准：C03 配置合并与采样判定', () => {
  test('三级配置合并（无契约目标，只记录）', async () => {
    const core = await loadCoreEntry();
    const builtin = core.createBuiltinConfig('essential_only');
    const input = {
      builtin,
      remote: {
        format_version: 1,
        app_id: 'demo-app',
        env: 'production',
        config_version: 42,
        published_at: 1_793_000_000_000,
        transport: { max_batch_events: 20 },
        sampling: { session_rate: 0.3 },
      },
      runtime: { transport: { max_batch_events: 5 } },
      configVersion: 42,
      publishedAt: 1_793_000_000_000,
      source: 'remote',
      consentMode: undefined,
      sessionRandom: 0.5,
      sdkVersion: '1.0.0',
    };

    // 正断言：证明测的是真实合并，而不是空跑
    expect(core.mergeConfig(input).config['config_version']).toBe(42);

    warmup(200, () => {
      core.mergeConfig(input);
    });
    const samples = timedIterations(MERGE_SAMPLES, () => {
      core.mergeConfig(input);
    });
    const stats = summarize(samples);
    report.record({
      metric: 'C03 mergeConfig 三级合并单次耗时',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      note: 'T13 任务卡无该指标的目标值，仅记录趋势',
      extra: { p50: stats.p50, min: stats.min, max: stats.max },
    });
  });

  test('采样判定单条 P99（契约 P99 ≤ 0.01 ms）', async () => {
    const core = await loadCoreEntry();
    const builtin = core.createBuiltinConfig('essential_only');
    const config = {
      current: () => ({
        ...builtin,
        sampling: { session_rate: 1, allow_users: [], rules: [{ match: { event_name: 'editor_*' }, rate: 1 }] },
      }),
      subscribe: () => () => undefined,
    };
    const kernel = core.createKernel({ target: null });
    const memory = new Map<string, string>();
    const session = core.createSessionSampling({
      config,
      random: () => 0,
      storage: { read: (key: string) => memory.get(key), write: (key: string, value: string) => void memory.set(key, value) },
      storeKey: 't20-bench-session',
    });
    core.createSamplingProcessor({ kernel, config, session, random: () => 0 });

    // 测量完整性：采样处理器确实注册
    expect(kernel.pipeline.size('sample')).toBeGreaterThanOrEqual(1);

    const makeEvent = (): Record<string, unknown> => ({ event_name: 'editor_save', priority: 'normal', occurred_at: 1_793_000_000_000 });
    warmup(SAMPLING_WARMUP, () => {
      kernel.pipeline.process(makeEvent());
    });
    const samples = timedIterations(SAMPLING_ITERATIONS, () => {
      kernel.pipeline.process(makeEvent());
    });
    const stats = summarize(samples);

    report.record({
      metric: 'C03 采样判定单条耗时（整条管线：sample 段）',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      target: SAMPLING_P99_TARGET_MS,
      targetText: 'P99 ≤ 0.01 ms',
      source: 'docs/tasks/T13.md 非功能目标',
      extra: { p50: stats.p50, min: stats.min, max: stats.max },
    });
    kernel.destroy();
  });

  test('空六段管线（无处理器）的对照基线', async () => {
    const core = await loadCoreEntry();
    const kernel = core.createKernel({ target: null });
    kernel.init();
    kernel.start();
    kernel.markConfigReady();

    // 正断言 1：证明「空六段」这个**前提**成立（不是只把数字记下来）。
    // 六段仍然是六段，且每一段都没有处理器——若有人在本节之前（或内核默认路径里）注册了处理器，
    // 这里的样本就不再是「无处理器的固定开销」，而用例标题与 note 仍这么写 ⇒ 必须红。
    expect(core.PIPELINE_STAGES).toHaveLength(6);
    for (const stage of core.PIPELINE_STAGES) {
      const registered = kernel.pipeline.size(stage);
      expect(
        registered,
        `「空六段」前提不成立：stage=${stage} 上有 ${String(registered)} 个处理器`,
      ).toBe(0);
    }

    // 正断言 2：证明测的是同一条**恒等透传**的管线——空管线不换事件对象、结论为 processed。
    // 任何处理器（即便原样返回）或任何阶段的短路都会让这两条之一变红。
    const event = makeKernelEvent();
    const firstOutcome = kernel.pipeline.process(event) as
      | { readonly status?: unknown; readonly event?: unknown }
      | undefined;
    expect(firstOutcome?.status).toBe('processed');
    expect(firstOutcome?.event).toBe(event);

    warmup(2_000, () => {
      kernel.pipeline.process(event);
    });
    const samples = timedIterations(10_000, () => {
      kernel.pipeline.process(event);
    });
    const stats = summarize(samples);
    // 测量完整性（README §1：只有这类断言会失败）：样本量与有限值由基准文件自己断言，
    // 不交给 `report` 兜底——空数组会让 p99 变成 NaN 并静默记进结果 JSON。
    expect(stats.samples).toBe(10_000);
    expect(Number.isFinite(stats.p99)).toBe(true);
    report.record({
      metric: 'C02/C03 空六段管线单条事件（对照基线）',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      note: '无处理器注册时的管线固定开销，用于解释其它几何指标的构成',
      extra: { p50: stats.p50, min: stats.min },
    });
    kernel.destroy();
  });
});
