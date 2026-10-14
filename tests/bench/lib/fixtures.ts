/**
 * 基准夹具（T20）：**只用格式合法的伪造数据**（无真实个人信息、无令牌、无密钥）。
 *
 * 数据形状对齐 `docs/contracts/schemas/`：UUID v4 形态的 id、契约允许的时间戳下界
 * （1793000000000）。与各包 `perf.test.ts` 的样本形态一致，便于与单元护栏对照。
 *
 * 注意：这里**不静态 import 任何包**（含 `import type`）——根 tsconfig 的 lib 与各包不同，
 * 静态导入会把包源码拉进根程序使 `pnpm typecheck` 失败，原因见 `./entries.ts` 的文件头。
 */

/** 基准使用的宽松记录类型（跨动态导入边界的值）。 */
export type LooseEvent = Record<string, unknown>;

/** 契约允许的时间戳下界（`batch.schema.json` 的 `timestamp.minimum`）。 */
export const TEST_START = 1_793_000_000_000;

export const TEST_APP_ID = 'demo-app';

/** 合法 UUID v4 形状。 */
export function testUuid(counter: number): string {
  return `e0000000-0000-4000-8000-${String(counter % 0xffffffff).padStart(12, '0')}`;
}

/** 合法的批次头（对齐 `batch.schema.json` 的必填字段）。 */
export function testHeader(): Record<string, unknown> {
  return {
    protocol_version: 1,
    app_id: TEST_APP_ID,
    env: 'staging',
    release: '1.4.0',
    sdk_name: 'web-report-sdk',
    sdk_version: '0.1.0',
    device_id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
    session_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
    clock_offset: 0,
  };
}

let queueSeq = 0;

/**
 * 造一条合法队列事件（C06/C07 用）。
 * `bytes > 0` 时用 `attachment` 填充，模拟「有附件的业务事件」，仍是合法形状。
 */
export function makeQueueEvent(bytes = 0): LooseEvent {
  queueSeq += 1;
  const padding = bytes <= 0 ? '' : 'x'.repeat(bytes);
  return {
    event_id: testUuid(queueSeq),
    event_name: 'web_vitals',
    event_type: 'perf',
    schema_version: 1,
    occurred_at: TEST_START + queueSeq,
    priority: 'normal',
    page_id: '/list',
    url: 'https://app.example.com/list?tab=detail',
    sample_rate: 1,
    metrics: { value: 1840, delta: 1840 },
    dimensions: { metric_name: 'LCP', rating: 'good', tenant: 'acme' },
    ...(padding === '' ? {} : { attachment: padding }),
  };
}

/** 造一个合法批次（C07 的 `prewrite` 输入）。 */
export function makeBatch(eventCount = 1, bytes = 0): LooseEvent {
  const events: LooseEvent[] = [];
  for (let index = 0; index < eventCount; index += 1) events.push(makeQueueEvent(bytes));
  queueSeq += 1;
  return { ...testHeader(), batch_id: testUuid(queueSeq), sent_at: TEST_START + queueSeq, events };
}

/**
 * 造一条「典型形态」内核事件（内存预算用）：3 个短维度、无长值、无附件。
 * 与下面的「生产上界形态」成对使用，用来回答「256 KB / 500 条隐含的平均每条预算是多少」。
 */
export function makeTypicalKernelEvent(index = 0): LooseEvent {
  return {
    event_name: 'task_complete',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: TEST_START + index,
    priority: 'normal',
    dimensions: { task_id: `t-${String(index)}`, tenant: 'acme', plan: 'pro' },
    metrics: { duration_ms: 42, retry_count: 0 },
  };
}

/**
 * 造一条「生产形态」内核事件（C04 富化/脱敏用）：少量维度、含一处**伪造**联系信息
 * （`alice.smith+tag@example.co.uk` / `13800138000` 都是保留示例，不是真实个人信息）、
 * 一个 200 字符的长值。
 */
export function makeKernelEvent(): LooseEvent {
  return {
    event_id: '00000000-0000-4000-8000-000000000001',
    event_name: 'task_complete',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: TEST_START,
    priority: 'normal',
    page_id: '/task/:id',
    view_id: '00000000-0000-4000-8000-000000000002',
    url: 'https://a.example/task/123?tab=detail',
    dimensions: {
      task_id: 't-1',
      tenant: 'acme',
      contact: 'mail alice.smith+tag@example.co.uk or 13800138000',
      note: 'x'.repeat(200),
    },
    metrics: { duration_ms: 42, retry_count: 0 },
  };
}
