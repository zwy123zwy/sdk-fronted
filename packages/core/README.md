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


---

# C01 公共 API、命令队列与类型化事件（T12 交接产物）

面向 **接入方** 与 **T13–T18**：`packages/core/src/api/` 提供接入方直接调用的公共 API。
所有公共方法**同步返回 `undefined`、从不抛错**；销毁后调用任何公共方法都计数 `destroyed`
（真正执行销毁的那次 `destroy()` 不计数，契约原文是「销毁后**仍有**调用」）。

```ts
import { createClient, createSdk } from '@web-report-sdk/core';

const client = createClient();
client.init({ appId: 'your-app-id', env: 'production', release: '1.2.3' });
client.track('task_complete', { dimensions: { task_id: 't-1' }, metrics: { duration_ms: 12 } });
client.setUser('user-1');
client.destroy();
```

## 11. 公共方法一览

| 方法 | 说明 |
|---|---|
| `init(options?)` | 初始化；`appId` 必填且非空，非法时计数 `invalid_args` 并忽略 |
| `track(name, { dimensions, metrics, attachment, priority })` | 自定义事件；事件名需至少两段小写下划线，不得用保留前缀 `sdk_` / `web_` |
| `log(level, message, { dimensions, metrics, attachment })` | 日志事件（见第 14 节的事件形态） |
| `captureError(error, { dimensions, metrics, attachment })` | 手动错误（`web_js_error`，见第 15 节） |
| `setUser(id, { hashed }?)` / `clearUser()` | 设置与清除用户 |
| `setContext(key, value)` / `removeContext(key)` | 全局自定义上下文；键名需满足 `fieldKey` 格式 |
| `setPage(pageId)` | 手动路由模式下的页面标识 |
| `setConsent(state)` | 同意状态（`granted` / `denied` / `buffer`） |
| `flush()` | 立即回放命令队列 |
| `destroy()` | 立即销毁并清空命令队列 |
| `onEvent(sink)` / `onDiagnostics(sink)` | 注册事件出口 / 调试输出，返回注销函数 |

**没有 `getState()`**：AC-01 要求所有公共方法返回 `undefined`，状态快照改由内核能力读取
（`STATE_CAPABILITY`，见第 19 节）。**没有 `acceptCommand()`**：加载桩交回是集成点，
通过 `STUB_BRIDGE_CAPABILITY` 完成（见第 18 节）。

`createClient<TDictionary>()` 的 `track` 参数类型来自事件字典（第 13 节）。

## 12. 事件体字段（严格遵守 `batch.schema.json` `$defs/event`）

`$defs/event` 是 `additionalProperties: false`，SDK 只产出下列键：

| 键 | 必填 | 来源 |
|---|---|---|
| `event_id` | 是 | **调用当时**生成的 UUID v4（去重依据；补发与重试不变） |
| `event_name` | 是 | `track` 的事件名 / `sdk_log` / `web_js_error` |
| `event_type` | 是 | `custom` / `log` / `error` |
| `schema_version` | 是 | 事件定义声明值；未声明或未登记事件取 **1** |
| `occurred_at` | 是 | **调用当时**的客户端时钟（UTC 毫秒） |
| `priority` | 是 | 显式入参 > 事件定义声明 > `normal` |
| `page_id` / `url` | 否 | **调用当时**的位置快照 |
| `level` | 否 | 仅 `log` 事件（Schema 要求 `event_type: 'log'` 时必填） |
| `dimensions` / `metrics` / `attachment` / `truncated` | 否 | 见各事件形态 |

**`app_id` 不是事件体字段**：它属于批次公共头，由 C04/C06/C07 组装批次时提供；
`page_id` / `view_id` / `url` / `sample_rate` 出现在事件体或批次 `common` 的「至少一处」
由 C04/C06 负责，C01 不产出 `sample_rate`。

## 13. 类型化事件字典（**给 T22/K01 与 T34 的接口契约**）

K01 生成物应满足下面的形状；`FieldSpec` 的 `required` 是**字面量布尔**，
可选字段用「属性带 `?`」+「`required: false`」成对表达：

```ts
type FieldSpec<TValue, TRequired extends boolean> = {
  readonly type: TValue;            // 维度：string | boolean | 字面量联合；指标：number
  readonly required: TRequired;
};
interface XxxEntry {
  readonly priority: 'normal' | 'critical';   // 字面量
  readonly schema_version: number;            // 字面量
  readonly dimensions: {
    readonly task_id: FieldSpec<string, true>;            // 必填：属性不可选
    readonly channel?: FieldSpec<'web' | 'app', false>;   // 可选：属性带 ?
  };
  readonly metrics: Readonly<Record<string, FieldSpec<number, boolean>>>;
}
type EventDefinitions = Readonly<Record<'<event_name>', XxxEntry>>;
```

消费侧（本包）的推导规则与**必须遵守的实现约束**：

- `track` 的入参类型由「事件名 → 定义」推导：必填字段是必需属性、可选字段可省、
  enum 维度只接受字面量联合、`boolean` 维度接受 `boolean`、指标接受 `number`；
- **判断必填必须用属性类型投影，不要索引 `required`**。在 `noUncheckedIndexedAccess` 下，
  可选属性被索引时会带上 `| undefined`，`T[K]['required'] extends true` 会失真，
  最终把字段类型推成 `never`。本包用
  `{ [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T]` 取可选键，
  再用 `NonNullable<T[K]>` 读 `required` 字面量（见 `typed-events.ts` 的注释）；
- `defineEventDictionary` 用 `const` 类型参数保留字面量（手写便利字典用）；
  便利写法里**可选字段必须写 `required: false`**（属性无法在值字面量里带 `?`）。
- `schema_version` 与 `priority` 从**运行期字典**读取：`createClient({ dictionary })` /
  `init({ dictionary })` 传入 K01 生成物；未登记事件取 `schema_version: 1`、`priority: 'normal'`。

## 14. `log()` 的事件形态

- `event_name: 'sdk_log'`（`sdk_` 是保留前缀，日志属 SDK 生成的内部事件）、
  `event_type: 'log'`、`level` 为顶层字段；
- **正文放 `dimensions.message`**（事件体没有顶层 `message` 字段），`attachment` 放较长正文；
- `schema_version: 1`。

## 15. `captureError()` 的事件形态（`web_js_error`）

满足 `schemas/builtin-events/web_js_error.schema.json`：

- `event_name: 'web_js_error'`、`event_type: 'error'`、`priority: 'normal'`（Schema 为 `const`）、
  `schema_version: 1`（Schema 为 `const`）；
- `dimensions` **必填 4 键**且不接受额外键：`error_type`、`message`、`source`（手动上报为
  `manual`）、`fingerprint`（由 source + 错误类型 + 归一化消息稳定派生，FNV-1a 十六进制）；
  调用方只能覆盖这 4 个键，其它维度键被丢弃并计数 `invalid_args`；
- `metrics.count` **必填**，缺省 `1`；`line` / `column` 可选（非负整数）；
- 超过 Schema `maxLength` 的字符串会被截断并计数 `truncated_dimension`、路径写入 `truncated`
  （**正式的长度约束与 `truncated` 语义由 C04 接管**，此处为保证产出事件合法先行实现）。

## 16. 命令队列（C01-F2）

`init` 之前的调用进入命令队列：**上限 200 条，保留最早的调用**，多出的每次计数一次
`command_queue_overflow`；`init` 后按调用顺序回放。`event_id`、`occurred_at`、`url`、`page_id`
都是**调用当时**的快照。

## 17. 参数非法与调试输出（C01-F6）

| 原因码 | 触发 |
|---|---|
| `invalid_event_name` | 事件名不符合命名规则或使用保留前缀（整条丢弃） |
| `invalid_args` | 非对象维度/指标、非法枚举取值、空字符串用户/页面、非法上下文键名、`captureError` 的越界维度键 |
| `non_finite_metric` | 指标值为 `NaN` / `Infinity`（该字段丢弃，事件继续） |
| `truncated_dimension` | 维度值按 Schema 上限被截断 |
| `command_queue_overflow` | 命令队列溢出 |
| `destroyed` | 销毁后调用任何公共方法 |
| `processor_error` | 处理器 / 事件出口 / 调试出口抛错 |

调试输出是**可注入 sink，缺省静默**（C08-AC-09：非白名单用户不因 URL 参数自动开启调试）：

```ts
createClient();                                  // 缺省：静默
createClient({ debug: true });                   // 默认 console sink（C01-AC-12）
createClient({ debug: (r) => panel.push(r) });   // 自定义（C08 调试面板）
createClient({ debug: false });                  // 显式静默
```

`packages/core/src/api/console-sink.ts` 是**唯一允许使用 `console` 的文件**
（根 `eslint.config.js` 的精确豁免）；输出只含原因码、事件去向、事件名与字段路径，**绝不含令牌**。
C08（T17）解析 URL 参数后，把「是否调试」映射到 `debug` 选项即可。

## 18. 多实例与共享注册表（C01-F5 / C01-AC-10）

```ts
const registry = createGlobalRegistry({ counters: createCounters(), target: window });
const main = createClient({ appId: 'main-app', registry, target: window });
const sub = createClient({ appId: 'sub-app', registry, target: window });
```

- 传入**同一个** `registry` 时，同一 `(target, event, capture)` 在页面上只安装一次原生监听，
  两个实例的订阅者都收到事件（C01-AC-10）；
- **计数器不共享**：每个实例有自己的 `counters`，两个 `app_id` 的计数不会串；
- 不传 `registry` 时每个实例各自一份，实例间互不影响；
- `KernelConfig.registry` 是 T12 在 A02 授权下对内核做的**向后兼容扩权**（T11 行为不变）。

## 19. 加载桩交接（C01-F3）

加载桩（`packages/browser/src/loading-stub.ts`）在页面头部缓存调用，主包加载后交接：

```ts
const stub = window.WebReportSDK;                  // 加载桩的全局对象
const client = createClient({ appId: 'your-app-id' });
const bridge = client.kernel.getCapability('sdk.stub_bridge') as (c: StubCommand) => void;
for (const command of stub.drain()) bridge(command);   // drain 同时移除加载桩的错误监听
client.flush();
```

- 交接走内核能力 `STUB_BRIDGE_CAPABILITY`（`'sdk.stub_bridge'`），**不是公共 API 方法**；
- 加载桩在调用当时生成 `eventId`，主包原样沿用（去重依据不变）；
- 加载桩注册 `window` 的捕获阶段 `error` 监听，尽早把首屏错误缓存成 `captureError` 命令；
  `drain()` 会**先移除该监听**再交出队列，避免与主包插件重复采集（T18/C05 需验证）；
- 状态快照能力名 `STATE_CAPABILITY`（`'sdk.client_state'`），值是返回 `ClientState` 的函数。

## 20. C01 本地自检

```bash
pnpm exec vitest run --coverage.enabled=false packages/core/src/api packages/core/src/kernel
pnpm exec tsc -p packages/core/tsconfig.json
pnpm exec tsc -p packages/browser/tsconfig.json
pnpm exec eslint packages/core/src/api packages/core/src/index.ts packages/browser/src
node packages/browser/scripts/measure-stub.mjs
```

契约自证：`packages/core/src/api/schema-validation.test.ts` 用 Ajv 2020-12 把公共 API 实际
产出的事件对着 `docs/contracts/schemas/batch.schema.json` 与
`docs/contracts/schemas/builtin-events/web_js_error.schema.json` 校验。
