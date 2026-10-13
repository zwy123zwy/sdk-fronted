/**
 * C08-F4 调试输出用例：
 * - 与 `packages/core/src/api/console-sink.ts` 的既有约定一致（前缀、`reason_code`、去向、
 *   `event_name`、`field`）；本模块不直接使用 `console`，而是通过注入的写端口输出；
 * - **输出中绝不出现令牌**：只序列化字段白名单，调用方多带的 `token` / 请求头等一律不读；
 * - 门禁关闭时（AC-09）不写任何内容。
 */
import { describe, expect, test } from 'vitest';
import { DEBUG_PREFIX, DEBUG_DESTINATIONS, formatDiagnosticsRecord, formatRouteRecord } from './format';
import type { DebugRouteRecord } from './types';
import { NOOP_DEBUG_TRACER, createDebugTracer } from './tracer';

interface LeakyRecord extends DebugRouteRecord {
  readonly token: string;
  readonly writeToken: string;
  readonly headers: Readonly<Record<string, string>>;
}

describe('调试输出格式（与 core console-sink 约定一致）', () => {
  test('事件整体丢弃', () => {
    const line = formatDiagnosticsRecord({
      kind: 'track',
      reason_code: 'invalid_args',
      dropped: 'event',
      event_name: 'demo_event',
    });
    expect(line).toBe(
      `${DEBUG_PREFIX} track reason_code=invalid_args 去向=事件未上报 event_name=demo_event`,
    );
  });

  test('字段级丢弃带 field', () => {
    const line = formatDiagnosticsRecord({
      kind: 'track',
      reason_code: 'invalid_field_key',
      dropped: 'field',
      field: 'metrics.duration_ms',
    });
    expect(line).toBe(
      `${DEBUG_PREFIX} track reason_code=invalid_field_key 去向=字段未上报 field=metrics.duration_ms`,
    );
  });

  test('事件去向行包含去向与原因码', () => {
    const line = formatRouteRecord({ kind: 'batch', destination: 'sent', reason_code: 'replayed', count: 2 });
    expect(line).toBe(`${DEBUG_PREFIX} batch 去向=已发送 reason_code=replayed count=2`);
  });

  test('每一种去向都有非空中文标签', () => {
    for (const destination of DEBUG_DESTINATIONS) {
      const line = formatRouteRecord({ kind: 'event', destination });
      expect(line, destination).toContain('去向=');
      expect(line.length, destination).toBeGreaterThan(`${DEBUG_PREFIX} event 去向=`.length);
    }
  });

  test('控制字符与超长取值被清洗（不换行、不注入）', () => {
    const line = formatDiagnosticsRecord({
      kind: 'x\n[INJECT]',
      reason_code: 'a'.repeat(200),
      dropped: 'event',
    });
    expect(line.includes('\n')).toBe(false);
    expect(line.length).toBeLessThan(400);
  });
});

describe('createDebugTracer（C08-AC-08 / AC-09）', () => {
  test('开启时逐条写出事件去向与原因码', () => {
    const lines: string[] = [];
    const tracer = createDebugTracer({ enabled: true, write: (line) => lines.push(line) });
    tracer.diagnostic({ kind: 'track', reason_code: 'invalid_args', dropped: 'event' });
    tracer.route({ kind: 'batch', destination: 'dropped', reason_code: 'rejected_400' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('reason_code=invalid_args');
    expect(lines[1]).toContain('去向=已丢弃');
    expect(tracer.enabled()).toBe(true);
  });

  test('关闭时不写任何内容（AC-09）', () => {
    const lines: string[] = [];
    const tracer = createDebugTracer({ enabled: false, write: (line) => lines.push(line) });
    tracer.diagnostic({ kind: 'track', reason_code: 'invalid_args', dropped: 'event' });
    tracer.route({ kind: 'batch', destination: 'sent' });
    expect(lines).toEqual([]);
    expect(tracer.enabled()).toBe(false);
  });

  test('输出中不出现令牌（只读字段白名单）', () => {
    const lines: string[] = [];
    const tracer = createDebugTracer({ enabled: true, write: (line) => lines.push(line) });
    const record: LeakyRecord = {
      kind: 'batch',
      destination: 'sent',
      reason_code: 'retry_5xx',
      event_name: 'demo_event',
      token: 'tok_live_SECRET',
      writeToken: 'tok_live_SECRET',
      headers: { authorization: 'Bearer tok_live_SECRET' },
    };
    tracer.route(record);
    const output = lines.join('\n');
    expect(output).not.toContain('tok_live_SECRET');
    expect(output).not.toContain('Bearer');
    expect(output).toContain('去向=已发送');
  });

  test('enabled 传函数时按运行期判定', () => {
    let enabled = false;
    const lines: string[] = [];
    const tracer = createDebugTracer({ enabled: () => enabled, write: (line) => lines.push(line) });
    tracer.route({ kind: 'batch', destination: 'sent' });
    enabled = true;
    tracer.route({ kind: 'batch', destination: 'sent' });
    expect(lines).toHaveLength(1);
  });

  test('NOOP_DEBUG_TRACER 恒定关闭且不写', () => {
    expect(NOOP_DEBUG_TRACER.enabled()).toBe(false);
    expect(() => {
      NOOP_DEBUG_TRACER.diagnostic({ kind: 'track', reason_code: 'killed', dropped: 'event' });
      NOOP_DEBUG_TRACER.route({ kind: 'batch', destination: 'sent' });
    }).not.toThrow();
  });
});
