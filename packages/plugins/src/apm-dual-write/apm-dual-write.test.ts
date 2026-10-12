/**
 * C05-F5 第三方 APM 双写适配器验收用例（T19）：C05-AC-15 至 C05-AC-18。
 *
 * 说明（与 `packages/plugins/package.json` 的所有权有关）：`packages/plugins` 目前
 * **没有声明** `@web-report-sdk/core` 依赖，工作区里也没有 `packages/plugins/node_modules`
 * 链接，因此本文件不能 `import` 真实内核。适配器按 C02 契约只使用宿主的三个接口
 * （`counters`、`addProcessor('before_send')`、`registerCapability`），本文件用一个
 * 与 C02 插件宿主语义一致的**最小宿主**驱动它：安装 = 调用 `install`，卸载 = 后进先出
 * 执行宿主登记的注销函数，`before_send` 处理器按注册顺序执行。文件末尾用 C02 `Plugin`
 * 的结构镜像做编译期赋值检查，证明工厂产物可以直接交给真实插件宿主。
 *
 * `packages/plugins/tsconfig.json` 的 `"types": []` 不引入 Node 类型（SDK 源码零运行时依赖），
 * 所以这里只声明测试真正用到的那几个 Node 能力，不做 `any` 转换、不关闭任何检查。
 */
import { describe, expect, it } from 'vitest';

import {
  APM_DUAL_WRITE_PLUGIN_ID,
  APM_DUAL_WRITE_STATS_CAPABILITY,
  DEFAULT_APM_FIELD_MAP,
  createApmDualWritePlugin,
} from './index';
import type {
  ApmDualWriteContext,
  ApmDualWriteEvent,
  ApmDualWritePlugin,
  ApmDualWriteStats,
} from './index';

/** Node 全局能力的最小声明：测试环境由 Node 提供。 */
interface NodeFs {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
}
interface NodeChildProcess {
  execFileSync(file: string, args: readonly string[], options: { readonly encoding: 'utf8' }): string;
}
declare const process: { getBuiltinModule(id: string): unknown; cwd(): string };

const nodeFs = process.getBuiltinModule('node:fs') as NodeFs;
const nodeChildProcess = process.getBuiltinModule('node:child_process') as NodeChildProcess;

// 门禁命令约定从仓库根目录运行 vitest（`pnpm test` / 本任务的局部自检命令）。
const packageRoot = `${process.cwd()}/packages/plugins`;

/** 与 C02 插件宿主契约一致的最小宿主。 */
interface TestHost {
  readonly context: ApmDualWriteContext;
  install(plugin: ApmDualWritePlugin): void;
  /** 等价于 `applyPluginConfig({ apm_dual_write: false })`：后进先出执行注销函数。 */
  uninstall(): void;
  /** 等价于内核六段管线：`before_send` 处理器按注册顺序执行，最后交给输出回调。 */
  emit(event: ApmDualWriteEvent): ApmDualWriteEvent;
  readonly reasons: Readonly<Record<string, number>>;
  readonly outputs: readonly ApmDualWriteEvent[];
  readonly capabilities: ReadonlyMap<string, unknown>;
  /** 适配器注册处理器时使用的段名；应当是 `before_send`。 */
  readonly stages: readonly string[];
}

function createHost(): TestHost {
  const disposers: (() => void)[] = [];
  const processors: ((event: ApmDualWriteEvent) => ApmDualWriteEvent)[] = [];
  const reasons: Record<string, number> = {};
  const outputs: ApmDualWriteEvent[] = [];
  const capabilities = new Map<string, unknown>();
  const stages: string[] = [];

  const context: ApmDualWriteContext = {
    counters: {
      count(reason: string, delta = 1): void {
        reasons[reason] = (reasons[reason] ?? 0) + delta;
      },
    },
    addProcessor(stage: string, processor): () => void {
      stages.push(stage);
      processors.push(processor);
      const dispose = (): void => {
        const index = processors.indexOf(processor);
        if (index >= 0) processors.splice(index, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
    registerCapability(name, value): () => void {
      capabilities.set(name, value);
      const dispose = (): void => {
        if (capabilities.get(name) === value) capabilities.delete(name);
      };
      disposers.push(dispose);
      return dispose;
    },
  };

  return {
    context,
    reasons,
    outputs,
    capabilities,
    stages,
    install(plugin): void {
      plugin.install(context);
    },
    uninstall(): void {
      for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.();
      disposers.length = 0;
    },
    emit(event): ApmDualWriteEvent {
      let current = event;
      for (const processor of [...processors]) current = processor(current);
      outputs.push(current);
      return current;
    },
  };
}

function customEvent(overrides: Partial<ApmDualWriteEvent> = {}): ApmDualWriteEvent {
  return {
    event_name: 'task_submit_complete',
    event_type: 'custom',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
    event_id: '3f1a0f9e-0000-4000-8000-000000000001',
    ...overrides,
  };
}

describe('C05-AC-15 双写转发', () => {
  it('C05-AC-15 每条自定义事件按映射配置转发一次', () => {
    const forwarded: Record<string, unknown>[] = [];
    const plugin = createApmDualWritePlugin({
      forward: (record) => {
        forwarded.push({ ...record });
      },
      fieldMap: {
        eventName: 'event_name',
        ts: 'occurred_at',
        taskId: 'dimensions.task_id',
        duration: 'metrics.duration_ms',
      },
    });
    const host = createHost();
    host.install(plugin);

    const event = customEvent({
      dimensions: { task_id: 't-1' },
      metrics: { duration_ms: 12 },
    });
    host.emit(event);
    host.emit(event);

    expect(forwarded).toEqual([
      { eventName: 'task_submit_complete', ts: 1_700_000_000_000, taskId: 't-1', duration: 12 },
      { eventName: 'task_submit_complete', ts: 1_700_000_000_000, taskId: 't-1', duration: 12 },
    ]);
    // 「每条事件转发一次」：两次上报得到两条记录，且不是同一个对象。
    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]).not.toBe(forwarded[1]);
    expect(host.stages).toEqual(['before_send']);
    expect(plugin.stats()).toEqual({ forwarded: 2, failed: 0, skipped: 0 });
    expect(host.capabilities.get(APM_DUAL_WRITE_STATS_CAPABILITY)).toEqual({
      forwarded: 2,
      failed: 0,
      skipped: 0,
    });
  });

  it('C05-AC-15 缺省只转发自定义事件，可通过 eventTypes 调整范围', () => {
    const forwarded: Record<string, unknown>[] = [];
    const plugin = createApmDualWritePlugin({
      forward: (record) => {
        forwarded.push({ ...record });
      },
    });
    const host = createHost();
    host.install(plugin);

    host.emit(customEvent());
    host.emit(customEvent({ event_name: 'web_js_error', event_type: 'error' }));
    host.emit(customEvent({ event_name: 'web_vitals', event_type: 'perf' }));
    host.emit(customEvent({ event_type: undefined }));

    expect(forwarded).toHaveLength(1);
    expect(plugin.stats()).toEqual({ forwarded: 1, failed: 0, skipped: 3 });

    const widePlugin = createApmDualWritePlugin({
      forward: (record) => {
        forwarded.push({ ...record });
      },
      eventTypes: ['custom', 'error'],
    });
    const wideHost = createHost();
    wideHost.install(widePlugin);
    wideHost.emit(customEvent({ event_type: 'error' }));
    expect(forwarded).toHaveLength(2);
    expect(widePlugin.stats()).toEqual({ forwarded: 1, failed: 0, skipped: 0 });
  });

  it('C05-AC-15 缺省映射保留 SDK 字段名，缺失字段不写入记录，常量字段可被映射覆盖', () => {
    const forwarded: Record<string, unknown>[] = [];
    const plugin = createApmDualWritePlugin({
      forward: (record) => {
        forwarded.push({ ...record });
      },
      constants: { sdk: 'web-report-sdk', event_name: 'constant-name' },
    });
    const host = createHost();
    host.install(plugin);

    const event = customEvent({
      page_id: '/task/:id',
      dimensions: { task_id: 't-9' },
      // metrics 缺失
    });
    host.emit(event);

    expect(DEFAULT_APM_FIELD_MAP).toMatchObject({ event_name: 'event_name', metrics: 'metrics' });
    expect(forwarded).toEqual([
      {
        sdk: 'web-report-sdk',
        event_name: 'task_submit_complete',
        event_type: 'custom',
        occurred_at: 1_700_000_000_000,
        event_id: '3f1a0f9e-0000-4000-8000-000000000001',
        priority: 'normal',
        page_id: '/task/:id',
        dimensions: { task_id: 't-9' },
      },
    ]);
  });
});

describe('C05-AC-16 第三方接口异常隔离', () => {
  it('C05-AC-16 第三方接口抛错时本 SDK 正常上报并计数 processor_error', () => {
    const plugin = createApmDualWritePlugin({
      forward: () => {
        throw new Error('第三方 APM 不可用');
      },
    });
    const host = createHost();
    host.install(plugin);

    // 适配器之后的处理器仍然收到事件，说明事件继续流转、异常没有冒泡。
    const downstream: string[] = [];
    host.context.addProcessor('before_send', (event) => {
      downstream.push(event.event_name);
      return event;
    });

    const event = customEvent();
    expect(() => host.emit(event)).not.toThrow();
    expect(host.outputs).toEqual([event]);
    expect(downstream).toEqual(['task_submit_complete']);
    expect(host.reasons['processor_error']).toBe(1);
    expect(plugin.stats()).toEqual({ forwarded: 0, failed: 1, skipped: 0 });
  });

  it('C05-AC-16 第三方接口不存在时本 SDK 正常上报并计数 processor_error', () => {
    const plugin = createApmDualWritePlugin({
      resolve: () => undefined,
    });
    const host = createHost();
    host.install(plugin);

    const first = customEvent();
    const second = customEvent({ event_name: 'task_retry' });
    host.emit(first);
    host.emit(second);

    expect(host.outputs).toEqual([first, second]);
    expect(host.reasons['processor_error']).toBe(2);
    expect(plugin.stats()).toEqual({ forwarded: 0, failed: 2, skipped: 0 });
  });

  it('C05-AC-16 第三方接口后加载：惰性解析可用后恢复转发', () => {
    const forwarded: Record<string, unknown>[] = [];
    let loaded = false;
    const plugin = createApmDualWritePlugin({
      resolve: () => (loaded ? (record) => forwarded.push({ ...record }) : undefined),
    });
    const host = createHost();
    host.install(plugin);

    host.emit(customEvent());
    expect(forwarded).toHaveLength(0);
    expect(host.reasons['processor_error']).toBe(1);

    loaded = true;
    host.emit(customEvent());
    expect(forwarded).toHaveLength(1);
    expect(plugin.stats()).toEqual({ forwarded: 1, failed: 1, skipped: 0 });
  });
});

describe('C05-AC-17 双写开关', () => {
  it('C05-AC-17 默认关闭：未安装不转发；关闭后不再转发并释放能力', () => {
    const forwarded: Record<string, unknown>[] = [];
    const plugin = createApmDualWritePlugin({
      forward: (record) => {
        forwarded.push({ ...record });
      },
    });
    const host = createHost();

    // 只注册定义、没有 applyPluginConfig({ apm_dual_write: true })：默认关闭。
    host.emit(customEvent());
    expect(forwarded).toHaveLength(0);

    host.install(plugin);
    host.emit(customEvent());
    expect(forwarded).toHaveLength(1);
    expect(host.capabilities.has(APM_DUAL_WRITE_STATS_CAPABILITY)).toBe(true);

    host.uninstall();
    host.emit(customEvent());
    expect(forwarded).toHaveLength(1);
    expect(host.capabilities.has(APM_DUAL_WRITE_STATS_CAPABILITY)).toBe(false);
    // 卸载后处理器已注销，事件不再进入适配器，因此统计停在关闭前的快照。
    expect(plugin.stats()).toEqual({ forwarded: 1, failed: 0, skipped: 0 });
    expect(host.reasons['processor_error']).toBeUndefined();
  });
});

describe('C05-AC-18 构建产物', () => {
  it('C05-AC-18 适配器源码不 import 任何第三方包', () => {
    const directory = `${packageRoot}/src/apm-dual-write/`;
    const sources = nodeFs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(0);

    for (const name of sources) {
      const source = nodeFs.readFileSync(`${directory}${name}`, 'utf8');
      const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier.startsWith('.')).toBe(true);
      }
      expect(source).not.toMatch(/\brequire\s*\(/);
    }
  });

  it('C05-AC-18 适配器构建产物不含第三方包代码且 gzip 不超过 1.5 KB', { timeout: 120_000 }, () => {
    const script = `${packageRoot}/scripts/measure-apm-adapter.mjs`;
    const output = nodeChildProcess.execFileSync('node', [script], { encoding: 'utf8' });
    const gzip = /gzip (\d+) B/.exec(output);
    expect(gzip).not.toBeNull();
    expect(Number(gzip?.[1] ?? Number.NaN)).toBeLessThanOrEqual(1536);
    expect(output).toContain('第三方包检查：ok');
  });
});

/**
 * C02 `Plugin` 的最小结构镜像（只读参考 `packages/core/src/kernel/types.ts`）。
 * 本次赋值在编译期证明：适配器产物可以直接交给真实插件宿主 `kernel.registerPlugin`。
 */
interface CorePluginLike {
  readonly id: string;
  readonly install: (context: CorePluginContextLike) => void;
}
interface CorePluginContextLike {
  readonly counters: {
    count(reason: string, delta?: number): void;
    get(reason: string): number;
    snapshot(): Readonly<Record<string, number>>;
    reset(): void;
  };
  addProcessor(
    stage: 'validate' | 'enrich' | 'filter' | 'sample' | 'build' | 'before_send',
    processor: (
      event: ApmDualWriteEvent,
      context: { readonly stage: string; readonly counters: unknown; readonly processorId: string },
    ) => ApmDualWriteEvent | { readonly stop: true; readonly reason: string },
    options?: { readonly id?: string | undefined },
  ): () => void;
  registerCapability(name: string, value: unknown): () => void;
}

describe('C05-AC-15 与 C02 插件宿主的类型兼容', () => {
  it('C05-AC-15 工厂产物可赋值给 C02 Plugin 形状', () => {
    const plugin: ApmDualWritePlugin = createApmDualWritePlugin({ forward: () => undefined });
    const asCorePlugin: CorePluginLike = plugin;
    const stats: ApmDualWriteStats = plugin.stats();
    expect(asCorePlugin.id).toBe(APM_DUAL_WRITE_PLUGIN_ID);
    expect(stats).toEqual({ forwarded: 0, failed: 0, skipped: 0 });
  });
});
