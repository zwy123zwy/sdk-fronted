/**
 * K01-F6：未登记事件报告。
 *
 * 输入事件名清单（M01 或接收方导出，JSON 数组或 JSONL），列出注册表中没有的事件及出现次数。
 * 这是报告类命令，永远返回退出码 0；注册表本身的校验失败由调用方（CLI）决定退出码。
 */
import type { EventDefinition } from './definitions.js';

/** 未登记事件报告中的一项。 */
export interface UnregisteredEntry {
  event_name: string;
  count: number;
}

/** 未登记事件报告。 */
export interface UnregisteredReport {
  registry_name: string;
  registry_events: number;
  total_observed: number;
  distinct_observed: number;
  unregistered: readonly UnregisteredEntry[];
  note: string;
}

/** 统计注册表中不存在的事件名及出现次数，按次数降序、事件名升序。 */
export function collectUnregistered(
  registryNames: ReadonlySet<string>,
  observed: readonly string[],
): UnregisteredEntry[] {
  const counts = new Map<string, number>();
  for (const name of observed) {
    if (registryNames.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([eventName, count]) => ({ event_name: eventName, count }))
    .sort((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      return left.event_name < right.event_name ? -1 : 1;
    });
}

/** 组装完整的未登记事件报告。 */
export function toUnregisteredReport(input: {
  registryNames: ReadonlySet<string>;
  observed: readonly string[];
  registryName: string;
  keepVersions: number;
}): UnregisteredReport {
  const unregistered = collectUnregistered(input.registryNames, input.observed);
  return {
    registry_name: input.registryName,
    registry_events: input.registryNames.size,
    total_observed: input.observed.length,
    distinct_observed: new Set(input.observed).size,
    unregistered,
    note: `注册表之外的事件照常入库，由接收方决定处理方式（event-standard.md）；本报告只做提示，不改变退出码（K01-F6、K01-AC-11）`,
  };
}

/** 注册表中的事件名集合。 */
export function registryEventNames(events: readonly EventDefinition[]): Set<string> {
  return new Set(events.map((event) => event.eventName));
}

/** 把清单文本解析成事件名列表。支持 JSON 数组与 JSONL（每行一个对象或一个字符串）。 */
export function parseObservedEvents(text: string): { names: string[]; errors: string[] } {
  const trimmed = text.trim();
  const errors: string[] = [];
  if (trimmed === '') return { names: [], errors: ['清单文件为空'] };

  const names: string[] = [];
  const pushValue = (value: unknown, line: number | null): void => {
    const name = extractEventName(value);
    if (name === null) {
      errors.push(`${line === null ? '清单' : `第 ${String(line)} 行`} 无法解析出事件名：${JSON.stringify(value)}`);
      return;
    }
    names.push(name);
  };

  // 先按整体 JSON 解析（JSON 数组或单个对象）
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      for (const item of parsed) pushValue(item, null);
      return { names, errors };
    }
    pushValue(parsed, null);
    return { names, errors };
  } catch {
    // 退化为 JSONL
  }

  const lines = trimmed.split('\n');
  lines.forEach((line, index) => {
    const content = line.trim();
    if (content === '') return;
    try {
      pushValue(JSON.parse(content), index + 1);
    } catch {
      // 也接受每行一个裸事件名（M01 的简化导出）
      if (/^[a-z][a-z0-9_]*$/.test(content)) {
        names.push(content);
        return;
      }
      errors.push(`第 ${String(index + 1)} 行既不是 JSON 也不是事件名：${content}`);
    }
  });
  return { names, errors };
}

/** 从数组元素 / 对象 / 字符串中取出事件名。 */
function extractEventName(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['event_name', 'name', 'event']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/** 渲染可读的未登记事件报告（CLI 输出）。 */
export function formatUnregisteredReport(report: UnregisteredReport): string[] {
  const lines: string[] = [];
  lines.push(
    `未登记事件报告：注册表 ${String(report.registry_events)} 个事件，清单共 ${String(report.total_observed)} 次上报（${String(report.distinct_observed)} 个不同事件名）`,
  );
  if (report.unregistered.length === 0) {
    lines.push('未登记事件：0 个（清单中的事件都在注册表中）');
  } else {
    lines.push(`未登记事件：${String(report.unregistered.length)} 个`);
    for (const entry of report.unregistered) {
      lines.push(`  - ${entry.event_name}：出现 ${String(entry.count)} 次`);
    }
    lines.push(report.note);
  }
  return lines;
}
