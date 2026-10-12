# @web-report-sdk/core —— C02 内核内部接口（T11 交接产物）

本文档面向 **T12–T18** 的实现 Agent，说明 C02 内核（`packages/core/src/kernel/`）导出的内部接口、约定和最小示例。
公共方法同步返回、从不抛错；所有注册接口都返回可重复调用的注销函数（`Dispose`）。

> 状态：T11 交付版本。处理器接口一旦被 T12–T18 使用，修改需要先通知 A00 冻结相关下游任务。

## 1. 组装内核

```ts
import { createKernel } from '@web-report-sdk/core';

const kernel = createKernel();          // 浏览器：缺省在首次订阅原生事件时解析 globalThis
const kernel = createKernel({ target: window });   // 显式指定原生目标（推荐给测试与多实例）
const kernel = createKernel({ target: null });     // SSR / Node：原生订阅静默降级
```

`createKernel` 不在模块顶层访问 `window`，可以在 SSR 与 Vitest 中直接导入。

生命周期（C02-F1）：`init()` → `start()` → `pause(reason?)` / `resume()` → `destroy()`。

| 方法 | 说明 |
|---|---|
| `state()` | 当前状态；只读访问器不计数 |
| `init()` / `start()` | 未初始化时启动被忽略；重复调用被忽略；都不抛错 |
| `pause(reason?)` | 运行中 → 暂停；暂停期间 `report()` 按 `reason` 计数不发送（如 C04 传 `consent_denied`、C03 传 `killed`） |
| `resume()` | 暂停 → 运行中 |
| `destroy()` | 卸载全部插件、清空管线/监听/hook/定时器/预启动队列；此后再调用会改变状态的方法都计数 `destroyed` |
| `configReady()` / `markConfigReady()` | 配置就绪标记；就绪前的 `report()` 进入预启动队列，`markConfigReady()` 按原顺序回放 |
| `report(event)` | 上报一条事件：未初始化忽略 → 暂停按原因计数 → 配置未就绪入队 → 否则走六段管线 |
| `setOutput(sink)` | 设置「发送前」段之后的输出回调（T15/T16 在这里接队列），返回注销函数 |

### 状态命名（与 `sdk_health` 的 `dimensions.state` 对齐）

生命周期**直接使用**契约冻结的四个字面量，T14/T17 生成 `sdk_health` 时无需转换：

| `LifecycleState` | `sdk_health.dimensions.state` | 说明 |
|---|---|---|
| `initialized` | `initialized` | 已初始化（`init()` 之后） |
| `running` | `running` | 运行中（`start()` 之后） |
| `paused` | `paused` | 暂停（撤回同意、kill switch 等） |
| `destroyed` | `destroyed` | 已销毁 |
| `uninitialized` | ——（不属于冻结取值） | 仅表示 `init()` 之前；此时不会有 `sdk_health` 上报，C08 不要在维度里输出该值 |

## 2. 六段处理管线（C02-F2、C02-F3）

顺序固定：**校验 `validate` → 富化 `enrich` → 过滤 `filter` → 采样 `sample` → 构建 `build` → 发送前 `before_send`**。

```ts
import { PIPELINE_STAGES, REASON_CODES, stopPipeline } from '@web-report-sdk/core';

const off = kernel.registerProcessor('enrich', (event, context) => {
  event['page_id'] = '/task/:id';        // 就地修改后返回同一个事件
  return event;
}, { id: 'c04_context' });              // id 只用于调试与异常归因

const off2 = kernel.registerProcessor('filter', (event) => {
  if (isDuplicate(event)) {
    return stopPipeline(REASON_CODES.filteredByPlugin);   // 终止 + 原因码
  }
  return event;
});

off();                                   // 注销；可重复调用
kernel.pipeline.size('enrich');          // 已注册处理器数量
```

约定：

- 处理器**必须返回**事件（就地修改后返回原事件，或返回替换后的新事件）或 `stopPipeline(reason)`；
  返回替换后的新事件时，后续段看到的是新事件。
- 同一段内按注册顺序执行；注册/注销可以在处理器运行期间发生（遍历的是注册快照）。
- 任意处理器抛错：跳过该处理器、事件继续流转、计数 `processor_error`，异常不会冒泡到业务或 `window.onerror`。
- 终止信号会按 `reason` 计数，事件不进入后续段，也不进入输出回调。

## 3. 插件宿主（C02-F4）

```ts
import { definePlugin } from '@web-report-sdk/core';

const echo = definePlugin({
  id: 'echo',
  dependencies: ['config'],              // 依赖插件 id，可省略
  install: (ctx) => {
    ctx.registerCapability('echo.events', echoes);
    ctx.listen('error', (event) => { /* ... */ });          // 原生监听，卸载时自动移除
    ctx.hook(window.history, 'pushState', (original) => {   // hook 只包装不替换
      return function (this: History, ...args) { return original.apply(this, args); };
    });
    ctx.addProcessor('before_send', (event) => { echoes.push(event.event_name); return event; });
    ctx.schedule(() => { /* ... */ }, 5000);                // 定时器，卸载时自动清除
    ctx.onDispose(() => { /* 自定义清理，后进先出执行 */ });
  },
});

kernel.registerPlugin(echo);
kernel.applyPluginConfig({ echo: true, config: true });   // true 安装（含依赖），false 卸载
kernel.plugins.isInstalled('echo');
kernel.plugins.installedIds();
kernel.plugins.install('echo');       // 也可直接安装，返回 PluginActionResult
kernel.plugins.uninstall('echo');
```

约定与原因码：

- 依赖不存在 → 该插件不安装，计数 `plugin_dependency_missing`；其他插件不受影响。
- 依赖存在但安装失败 → 依赖方返回 `dependency_failed`，不再重复计数。
- 安装函数抛错 → 回滚该插件本次已注册的全部资源、计数 `plugin_install_failed`，SDK 继续运行。
- `applyPluginConfig({ id: false })` → 卸载插件，释放它注册的**全部**监听、hook、定时器、处理器与能力。
- 同一 `id` 重复 `registerPlugin` 以最后一次定义为准；重复安装是幂等的（`already_installed`）。
- 插件清理统一用 `ctx.onDispose(fn)`（后进先出，抛错被隔离并计数 `processor_error`）；`install` 不返回值。

## 4. 能力注册（模块间解耦）

```ts
const off = kernel.registerCapability('transport', transportPort);   // 同名以后注册者为准
kernel.getCapability('transport') as TransportPort | undefined;      // 值类型由注册方与读取方约定
kernel.capabilities.has('transport');
kernel.capabilities.names();
off();                                                               // 仅在自己仍是当前值时移除
```

插件里用 `ctx.registerCapability(name, value)`，卸载时自动移除。`capabilities` / `counters` / `lifecycle` /
`pipeline` / `plugins` / `registry` / `prestartQueue` 也直接挂在 `kernel` 上供下游使用。

## 5. 计数器接口（C08 读取）

```ts
kernel.counters.count('custom_reason');        // delta 缺省 1；非正数/非有限值忽略
kernel.counters.get('processor_error');        // 未出现过返回 0
kernel.counters.snapshot();                    // { 原因码: 计数 } 浅拷贝，只含非零项
kernel.counters.reset();                       // C08 每个窗口聚合后调用
```

内核负责的原因码（`REASON_CODES`，取值见 `docs/contracts/reason-codes.md`）：

| 常量 | 值 | 路径 |
|---|---|---|
| `processorError` | `processor_error` | 只计数：处理器/监听/hook/定时器/输出回调抛错、状态监听抛错 |
| `prestartQueueOverflow` | `prestart_queue_overflow` | 丢弃：预启动队列溢出 |
| `pluginDependencyMissing` | `plugin_dependency_missing` | 丢弃：插件依赖不存在 |
| `pluginInstallFailed` | `plugin_install_failed` | 丢弃：插件安装函数抛错 |
| `filteredByPlugin` | `filtered_by_plugin` | 丢弃：过滤段插件终止（C05 去重等） |
| `destroyed` | `destroyed` | 丢弃：销毁后调用 |

`prestart_queue_overflow` 每次溢出计数 1（淘汰一条已有 normal，或丢弃新到达的事件）。
计数保留原始原因码，`drop_` / `count_` 前缀由 C08 聚合 `sdk_health` 时添加。

## 6. 预启动队列（C02-F5）

配置就绪（`markConfigReady()`）之前 `report()` 的事件按原顺序缓存，上限 **500** 条：

- 队列满时淘汰**最早的 normal** 事件并计数 `prestart_queue_overflow`；
- `critical` 事件永不淘汰；队列全为 critical 时新到达的事件被丢弃（同样计数）；
- `markConfigReady()` 按原顺序回放；暂停期间回放的事件按暂停原因计数后丢弃。

```ts
kernel.prestartQueue.size();       // 当前条数
kernel.prestartQueue.capacity();   // 500
```

## 7. 全局注册表（C02-F6）

```ts
kernel.registry.listen(window, 'error', handler);          // 同一 目标+事件+capture 只装一次原生监听
kernel.registry.listenGlobal('error', handler);            // 使用内核配置的 target
kernel.registry.hook(window.history, 'pushState', (original) => { /* 返回替代实现 */ });
kernel.registry.schedule(fn, ms);
kernel.registry.scheduleRepeat(fn, ms);
kernel.registry.stats();      // { listeners, nativeListeners, hooks, timers }
kernel.registry.dispose();    // 全部释放；销毁后注册计数 destroyed
```

约定：

- **原生监听去重**：多个插件订阅同一 `(target, type, capture)` 时只调用一次 `addEventListener`，
  所有订阅者都收到事件；最后一个订阅者注销时才 `removeEventListener`。
- **hook 只包装不替换**：包装函数收到包装前的函数（可能是业务自己的包装），注销时恢复该函数而不是原生函数；
  同一属性多次 hook 会重建包装链，后进先出恢复；包装逻辑抛错时回退到包装前的函数并计数 `processor_error`。
- **定时器**统一登记，注销或 `destroy()` 时清除；`destroy()` 后不留任何监听、hook、定时器。
- 销毁后 `listen` / `listenGlobal` / `hook` / `schedule` / `scheduleRepeat` 计数 `destroyed` 并返回空操作。

## 8. 最小「回声插件」样例

完整可运行版本见 `packages/core/src/kernel/echo-plugin.test.ts`：

```ts
import { createKernel, definePlugin } from '@web-report-sdk/core';

function createEchoPlugin(echoes: string[]) {
  return definePlugin({
    id: 'echo',
    install: (context) => {
      context.registerCapability('echo.events', echoes);
      const stop = context.addProcessor('before_send', (event) => {
        echoes.push(event.event_name);       // 回显事件名
        return event;
      });
      context.onDispose(stop);               // 卸载时自动注销（addProcessor 已自动回收，这里演示自定义清理）
    },
  });
}

const kernel = createKernel();
kernel.init();
kernel.start();
kernel.markConfigReady();
const echoes: string[] = [];

kernel.registerPlugin(createEchoPlugin(echoes));
kernel.applyPluginConfig({ echo: true });    // 安装
kernel.report({ event_name: 'echo_event', priority: 'normal', occurred_at: Date.now() });
// echoes === ['echo_event']

kernel.applyPluginConfig({ echo: false });   // 卸载：处理器、能力全部释放
```

## 9. 内核约定速查

- 销毁后调用会改变状态的方法 → 计数 `destroyed` 并忽略；只读访问器（`state()`、`configReady()`、
  `pipeline.size()`、`plugins.installedIds()`、`prestartQueue.capacity()`、`counters.get()`）不计数。
- 所有队列都有上限：预启动队列 500，命令队列 200（T12），内存队列见 C06。
- 原因码只使用 `docs/contracts/reason-codes.md` 中的取值，不新增。
- 「发送前」段之后的事件由 `setOutput` 回调交给 T15/T16；没有设置回调时事件在管线末尾终止（不回滚计数）。

## 10. 本地自检

```bash
pnpm exec vitest run --coverage.enabled=false packages/core/src/kernel
pnpm exec tsc -p packages/core/tsconfig.json
pnpm exec eslint packages/core/src/kernel packages/core/src/index.ts
```
