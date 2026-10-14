/**
 * C04 富化与脱敏基准（T20 是契约目标值的权威验证方；单元护栏见
 * `packages/core/src/privacy/perf.test.ts`）。
 *
 * 契约目标值（T14 任务卡）：**富化与脱敏单条 P99 ≤ 0.03 ms**（正则在配置加载时预编译）。
 *
 * 计时口径（比单元护栏更严格，见下）：
 * - **事件构造在计时区之外**：预先建好「每条只被处理一次」的事件池（池大小 = 迭代数），
 *   计时区内只调用处理器。单元护栏把 `makeEvent()` 也计进去，会同时量到构造成本与处理器成本；
 *   本基准把两者分开报（另给一行「含构造」对照，便于与单元护栏对齐读数）。
 * - 池内每条事件**只处理一次**：避免把「就地修改后的稳定态」（已脱敏/已截断）当成真实成本。
 * - 三段分开测量：① 字段约束 + 脱敏处理器；② 脱敏器单独处理 256 字符（生产上界）；
 *   ③ 真实上下文富化处理器。
 */
import { afterAll, describe, expect, test } from 'vitest';

import { loadCoreEntry } from './lib/entries';
import { makeKernelEvent, TEST_START } from './lib/fixtures';
import { createBenchReport } from './lib/report';
import { formatMs, summarize, timedIterations, warmup } from './lib/stats';

const report = createBenchReport('c04-privacy');

/** 契约目标：富化与脱敏单条 P99。 */
const PRIVACY_P99_TARGET_MS = 0.03;

const ITERATIONS = 20_000;
const WARMUP = 2_000;

afterAll(() => {
  report.finish();
});

/** 计数器端口（与单元护栏同形）。 */
function makeCounter(): {
  readonly count: (reason: string, delta?: number) => void;
  readonly get: (reason: string) => number;
  readonly snapshot: () => Readonly<Record<string, number>>;
} {
  const counts = new Map<string, number>();
  return {
    count: (reason, delta = 1) => {
      counts.set(reason, (counts.get(reason) ?? 0) + delta);
    },
    get: (reason) => counts.get(reason) ?? 0,
    snapshot: () => Object.fromEntries(counts),
  };
}

/** 生产形态事件池（含伪造 PII 与 200 字符长值）。 */
function poolOf(size: number, make: () => LooseLike): LooseLike[] {
  const pool: LooseLike[] = [];
  for (let index = 0; index < size; index += 1) pool.push(make());
  return pool;
}

describe('T20 基准：C04 富化与脱敏', () => {
  test('字段约束 + 脱敏处理器（契约 P99 ≤ 0.03 ms）', async () => {
    const core = await loadCoreEntry();
    const counter = makeCounter();
    const processor = core.createFieldConstraintsProcessor({
      limits: core.C04_LIMITS,
      masker: core.createMasker(),
      count: counter.count,
    });
    const context = { stage: 'validate', counters: counter, processorId: 't20-bench' };

    // 正断言：脱敏确实生效（伪造的联系方式不再原样出现），证明测的是真实处理
    const probeText = JSON.stringify(processor(makeKernelEvent(), context));
    expect(probeText).not.toContain('alice.smith+tag@example.co.uk');
    expect(probeText).not.toContain('13800138000');

    const warmupPool = poolOf(WARMUP, makeKernelEvent);
    for (const event of warmupPool) processor(event, context);

    const pool = poolOf(ITERATIONS, makeKernelEvent);
    const stats = summarize(
      timedIterations(ITERATIONS, (index) => {
        const event = pool[index];
        if (event === undefined) throw new Error('事件池越界');
        processor(event, context);
      }),
    );

    report.record({
      metric: 'C04 字段约束 + 脱敏：单条事件（仅处理器）',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      target: PRIVACY_P99_TARGET_MS,
      targetText: 'P99 ≤ 0.03 ms',
      source: 'docs/tasks/T14.md 非功能目标',
      extra: { p50: stats.p50, min: stats.min, max: stats.max },
    });
  });

  test('脱敏器单独处理 256 字符（契约 P99 ≤ 0.03 ms）', async () => {
    const core = await loadCoreEntry();
    const masker = core.createMasker();
    const value = 'x'.repeat(256);
    // 正断言：不是空跑
    expect(typeof masker.apply(value)).toBe('string');

    warmup(WARMUP, () => {
      masker.apply(value);
    });
    const stats = summarize(
      timedIterations(ITERATIONS, () => {
        masker.apply(value);
      }),
    );
    report.record({
      metric: 'C04 脱敏器单独处理 256 字符',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      target: PRIVACY_P99_TARGET_MS,
      targetText: 'P99 ≤ 0.03 ms',
      source: 'docs/tasks/T14.md 非功能目标',
      extra: { p50: stats.p50, min: stats.min },
    });
  });

  test('脱敏器随字符串长度的成本曲线（定位 0.03 ms 目标的支配因素）', async () => {
    const core = await loadCoreEntry();
    const masker = core.createMasker();
    for (const length of [32, 64, 128, 256]) {
      const value = 'x'.repeat(length);
      const samples = timedIterations(10_000, () => {
        masker.apply(value);
      });
      const stats = summarize(samples);
      report.record({
        metric: `C04 脱敏器 apply()，长度 ${String(length)} 字符`,
        stat: 'p50',
        value: stats.p50,
        unit: 'ms',
        samples: samples.length,
        note: `每字符 ${((stats.p50 / length) * 1_000_000).toFixed(1)} ns；P99=${formatMs(stats.p99)} ms`,
        extra: { p99: stats.p99, ns_per_char: (stats.p50 / length) * 1_000_000 },
      });
    }
  });

  test('真实上下文富化处理器（补齐 page_id/url/context）', async () => {
    const core = await loadCoreEntry();
    const page = core.createPageTracker({
      createId: core.createUuid,
      pageId: '/task/:id',
      url: 'https://a.example/task/123?tab=detail',
    });
    const consent = core.createConsentManager({
      mode: 'essential_only',
      state: 'granted',
      count: () => undefined,
      emit: () => undefined,
      sizeOf: (event: LooseLike) => JSON.stringify(event).length,
      limits: { maxEvents: core.CONSENT_BUFFER_MAX_EVENTS, maxBytes: core.CONSENT_BUFFER_MAX_BYTES },
    });
    const store = core.createContextStore({
      page,
      consent,
      consentMode: 'essential_only',
      initialContext: { tenant: 'acme', plan: 'pro' },
    });
    const processor = core.createContextEnrichProcessor(store);

    /** 缺 `page_id`/`view_id`/`url`/`context` 的事件：富化必须真的补上。 */
    const makeBareEvent = (): LooseLike => ({
      event_name: 'task_complete',
      event_type: 'custom',
      schema_version: 1,
      occurred_at: TEST_START,
      priority: 'normal',
      dimensions: { task_id: 't-1' },
      metrics: { duration_ms: 42 },
    });

    // 正断言：富化确实补齐了字段
    const enriched = processor(makeBareEvent(), { stage: 'enrich' }) as LooseLike;
    expect(enriched['page_id']).toBe('/task/:id');
    expect(enriched['url']).toBe('https://a.example/task/123?tab=detail');
    expect(JSON.stringify(enriched['context'])).toContain('acme');

    const warmupPool = poolOf(WARMUP, makeBareEvent);
    for (const event of warmupPool) processor(event, { stage: 'enrich' });

    const pool = poolOf(ITERATIONS, makeBareEvent);
    const stats = summarize(
      timedIterations(ITERATIONS, (index) => {
        const event = pool[index];
        if (event === undefined) throw new Error('事件池越界');
        processor(event, { stage: 'enrich' });
      }),
    );
    report.record({
      metric: 'C04 上下文富化处理器：单条事件',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      target: PRIVACY_P99_TARGET_MS,
      targetText: 'P99 ≤ 0.03 ms',
      source: 'docs/tasks/T14.md 非功能目标',
      extra: { p50: stats.p50, min: stats.min },
    });
  });

  test('对照：含事件构造（与单元护栏同口径）', async () => {
    const core = await loadCoreEntry();
    const counter = makeCounter();
    const processor = core.createFieldConstraintsProcessor({
      limits: core.C04_LIMITS,
      masker: core.createMasker(),
      count: counter.count,
    });
    const context = { stage: 'validate', counters: counter, processorId: 't20-bench' };
    warmup(WARMUP, () => {
      processor(makeKernelEvent(), context);
    });
    const stats = summarize(
      timedIterations(ITERATIONS, () => {
        processor(makeKernelEvent(), context);
      }),
    );
    report.record({
      metric: 'C04 字段约束 + 脱敏：含事件构造（对照）',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      note: '口径与单元护栏一致：计时区含 makeEvent()',
      extra: { p50: stats.p50 },
    });
  });
});

/** 本文件内联使用的宽松记录类型（避免静态 import 包源码，原因见 `./lib/entries.ts`）。 */
type LooseLike = Record<string, unknown>;
