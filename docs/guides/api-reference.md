# API 参考

- 对应交付：T34（A14）；读者：接入方工程师
- 事实来源：`packages/browser/etc/browser.api.md`（入口包导出面，55 条）、`packages/core/etc/core.api.md`（C01 公共 API 与类型）、`packages/plugins/etc/plugins.api.md`（双写适配器）、`packages/transport/etc/transport.api.md`（内部交接接口，仅供识别"不属公共面"）
- 生成与核对方式：这些 `etc/*.api.md` 由 API Extractor 生成，门禁 `pnpm api:check` 会把"有未登记的公共 API 变更"判为失败；有意变更时运行 `pnpm api:update`。

> **本文是人工逐条对齐的结果，不是自动生成物。** 写法规则：
> - 每个条目的签名以 `etc/*.api.md` 为准；本文不引入契约或代码中不存在的参数、返回值、原因码与常量。
> - 标注了 **[入口包导出]** 的符号可以从 `@web-report-sdk/browser` 直接 `import`；标注 **[core]** / **[plugins]** 的需要从对应包导入（且通常是集成用途）。
> - 关于"当前能做什么、不能做什么"，以 [docs/guides/README.md 的能力状态总表](README.md#能力状态总表重要) 为准。

---

## 1. 入口包与导出面

接入方安装的入口包是 `@web-report-sdk/browser`，它当前**只重新导出 `@web-report-sdk/core` 的 C01 公共面**（`packages/browser/src/index.ts`；`packages/browser/etc/browser.api.md` 的 55 条导出与 core 一一对应）。它同时产出 `<script>` 场景用的 IIFE（`dist/web-report-sdk.iife.js`，全局变量 `WebReportSDK`，导出映射 `@web-report-sdk/browser/iife`）。

**55 条导出按用途分组：**

| 组 | 导出 | 说明 |
|---|---|---|
| 工厂 | `createClient`、`createSdk` | 创建客户端实例；两者实现相同，`createSdk()` 内部就是 `createClient()`（**每次调用都创建一个新实例**，多实例请用 `createClient`） |
| 类型：实例与状态 | `Client`、`Sdk`、`ClientState`、`ClientOptions`、`ClientInitOptions`、`ConsentState`、`LogLevel`、`UserInput` | 见第 3 节 |
| 类型：事件与字典 | `EventDictionary`、`EventDefinitionShape`、`EventInput`、`EventRequest`、`EventRequestOf`、`FieldSpec`、`FieldValue`、`ShapeOf`、`RequiredShape`、`OptionalShape`、`RequiredFieldKeys`、`OptionalFieldKeys`、`DimensionFields`、`DimensionFieldsOf`、`MetricFields`、`MetricFieldsOf`、`PermissiveDictionary` | 见第 4 节 |
| 类型：出口与诊断 | `EventSink`、`DiagnosticsSink`、`DiagnosticsRecord`、`LocationSource` | 见第 3、4 节 |
| 类型：加载桩交接与命令队列 | `StubCommand`、`QueuedCommand`、`CommandQueue`、`CommandQueuePushResult`、`PublicMethod` | 见第 5 节 |
| 常量 | `SDK_VERSION`、`COMMAND_QUEUE_CAPACITY`、`MAX_DIMENSION_VALUE_LENGTH`、`PUBLIC_METHODS`、`RESERVED_EVENT_PREFIXES`、`WEB_JS_ERROR_LIMITS`、`API_REASON_CODES`、`STATE_CAPABILITY`、`STUB_BRIDGE_CAPABILITY` | 见第 5 节 |
| 字典与校验工具 | `defineEventDictionary`、`hasValidEventName`、`hasValidFieldKey`、`isConsentState`、`isNonEmptyString`、`isPlainRecord`、`readLocation`、`truncate`、`createUuid`、`createCommandQueue` | 见第 5 节 |

**不在入口包导出面里的**（需要从其它包导入，属集成用途）：C02 内核（`createKernel` 等）、C03 配置运行时（`createConfigRuntime`、`CONFIG_CAPABILITY` 等）、C06/C07/C08（`createTransportQueue`、`createDelivery`、`createHealthReporter` 等）、插件宿主与 `definePlugin`、双写适配器（见第 7 节）。

---

## 2. 公共方法

`Client` 接口的完整签名（`packages/core/etc/core.api.md` 的 `Client`）。**所有公共方法同步返回 `undefined`、从不抛错**；销毁后调用任何公共方法计数 `destroyed` 并忽略（`destroy()` 本身那次不计数）。

```ts
interface Client<TDictionary extends EventDictionary = PermissiveDictionary> {
  init(options?: ClientInitOptions): undefined;
  track<TName extends keyof TDictionary & string>(name: TName, input?: EventRequestOf<TDictionary, TName>): undefined;
  log(level: LogLevel, message: string, input?: EventInput): undefined;
  captureError(error: unknown, input?: EventInput): undefined;
  setUser(id: string, options?: { readonly hashed?: boolean | undefined }): undefined;
  clearUser(): undefined;
  setContext(key: string, value: string): undefined;
  removeContext(key: string): undefined;
  setPage(pageId: string): undefined;
  setConsent(state: ConsentState): undefined;
  flush(): undefined;
  destroy(): undefined;
  readonly kernel: Kernel;                          // 集成句柄，接入方不得依赖（见第 7 节）
  onEvent(sink: EventSink): () => void;
  onDiagnostics(sink: DiagnosticsSink): () => void;
}
```

`PUBLIC_METHODS`（[入口包导出]）是上面 12 个"公共方法"的名字数组（不含 `kernel` / `onEvent` / `onDiagnostics`）：

```ts
["init","track","log","captureError","setUser","clearUser","setContext","removeContext","setPage","setConsent","flush","destroy"]
```

### 2.1 `init(options?)`

初始化实例。`init` **立即生效**：它决定后续调用进入执行还是进命令队列。

```ts
const client = createClient();
client.init({ appId: 'your-app-id', env: 'production', release: '1.2.3' });
```

- `appId` 必填且非空；非法时计数 `invalid_args` 并**忽略整个 `init`**（`packages/core/README.md` 第 11 节）。
- 重复调用 `init` 被忽略。
- `init` 之前的调用进入命令队列（上限 200，保留最早的调用），`init` 后按调用顺序回放；`event_id`、`occurred_at`、`url`、`page_id` 都是**调用当时**的快照（C01-F2）。
- 各参数含义与"C01 当前是否消费"见 [接入指南 · 初始化参数](integration.md#5-初始化参数)。

### 2.2 `track(name, input?)`

上报自定义事件。

```ts
client.track('task_complete', {
  dimensions: { task_id: 't-1' },       // 值必须是字符串
  metrics: { duration_ms: 12 },          // 值必须是有限数值
  attachment: 'optional long text',
  priority: 'normal',                    // 显式入参 > 事件定义声明 > 'normal'
});
```

实际产出的事件体（本工作树实测）：

```json
{
  "event_id": "8d8b1c02-…", "event_name": "task_complete", "event_type": "custom",
  "schema_version": 1, "priority": "normal", "occurred_at": 1791881883633,
  "page_id": "/home", "dimensions": { "task_id": "t-1" }, "metrics": { "duration_ms": 12 }
}
```

- 事件名需至少两段小写下划线，且不得使用保留前缀 `sdk_` / `web_`；违规整条丢弃并计数 `invalid_event_name`。
- `schema_version` 取事件定义声明值，未声明或未登记事件取 `1`；`priority` 取"显式入参 > 事件定义声明 > `normal`"。
- 传入 K01 生成的字典做类型参数后，`name` 是事件名字面量联合，字段级类型按定义推导（见 [工具指南 · K01.5](tools.md#k015-生成类型的接入方式)）。
- Q3 的约束：**投递等级不能在调用时改变**——注册表声明为 critical 的事件，调用时不写也按 critical 处理（由装配/传输与 C08 落地）。
- 事件体中**没有 `app_id`**（它属批次公共头）。

### 2.3 `log(level, message, input?)`

上报日志事件。

```ts
client.log('warn', 'disk almost full', { dimensions: { disk: 'root' } });
```

实际产出（实测）：

```json
{
  "event_id": "0e9e18fb-…", "event_name": "sdk_log", "event_type": "log",
  "schema_version": 1, "priority": "normal", "occurred_at": 1791881883633,
  "page_id": "/home", "level": "warn",
  "dimensions": { "disk": "root", "message": "disk almost full" }
}
```

- `level` ∈ `'debug' | 'info' | 'warn' | 'error'`（`LogLevel`），是**顶层字段**；非法取值计数 `invalid_args`。
- **正文放 `dimensions.message`**（事件体没有顶层 `message` 字段），较长正文用 `attachment`。
- `event_name` 固定 `sdk_log`（`sdk_` 是保留前缀，日志属 SDK 生成的内部事件），`schema_version: 1`。

### 2.4 `captureError(error, input?)`

手动上报错误事件（`web_js_error`）。

```ts
try {
  riskyOperation();
} catch (error) {
  client.captureError(error, { metrics: { count: 1 } });
}
```

实际产出（实测）：

```json
{
  "event_id": "10ff9f9b-…", "event_name": "web_js_error", "event_type": "error",
  "schema_version": 1, "priority": "normal", "occurred_at": 1791881883633,
  "page_id": "/home",
  "dimensions": { "error_type": "TypeError", "message": "bad input", "source": "manual", "fingerprint": "fp_c9ed9de2" },
  "metrics": { "count": 1 },
  "attachment": "TypeError: bad input\n    at …"
}
```

- `dimensions` **必填 4 键且不接受额外键**：`error_type`、`message`、`source`（手动上报固定 `manual`）、`fingerprint`（由 source + 错误类型 + 归一化消息稳定派生，FNV-1a 十六进制）。**调用方只能覆盖这 4 个键，其它维度键被丢弃并计数 `invalid_args`**（实测 `{ dimensions: { area: 'checkout' } }` 中的 `area` 被丢弃）。
- `metrics.count` **必填**，缺省 `1`；`line` / `column` 可选（非负整数）。
- `priority` 与 `schema_version` 是 Schema 的 `const`（`normal` / `1`）。
- 超过 Schema `maxLength` 的字符串会被截断并计数 `truncated_dimension`，路径写入 `truncated`（正式的长度约束与 `truncated` 语义由 C04 接管）。
- `attachment` 是错误栈文本；请自行确认不要在其中携带个人信息，接收方侧脱敏规则见 [接收方指南](receiver-guide.md)。

### 2.5 `setUser(id, options?)` / `clearUser()`

```ts
client.setUser('user-1');                  // 原始 id
client.setUser('<hashed-user-id>', { hashed: true }); // 已是哈希值（占位）
client.clearUser();                         // 退出登录：清除用户
```

- `id` 必须是**非空字符串**，否则计数 `invalid_args`。
- `options.hashed` 标记该值是否已是哈希值；匿名阶段的事件不关联用户（Q5/UC-02）。
- 可读状态里的用户形状 `UserInput = { readonly id: string; readonly hashed?: boolean }`。

### 2.6 `setContext(key, value)` / `removeContext(key)`

全局自定义上下文（与事件自身的 `dimensions` 分开存放）。

```ts
client.setContext('tenant', 'acme');
client.removeContext('tenant');
```

- `key` 必须满足 `fieldKey` 格式：小写字母开头，只含小写字母、数字、下划线，最长 64（`hasValidFieldKey`）；非法计数 `invalid_args`（实测 `'Bad-Key'` 被拒且未进入上下文）。
- `value` 类型是 `string`。契约里 `context` 的值也是字符串、`maxProperties: 50`、每值 ≤256 字符。
- 读取当前上下文：内核能力 `STATE_CAPABILITY` 返回的 `ClientState.contexts`（集成接口，见第 7 节）。

### 2.7 `setPage(pageId)`

手动路由模式下的页面标识（UC-09：路由库不触发 History 事件时，在路由守卫里调用）。

```ts
router.afterEach((to) => { client.setPage(to.meta.pageId as string); });
```

- `pageId` 必须是**非空字符串**，否则计数 `invalid_args`。
- 不调用且 `init` 也没传 `pageId` 时，事件**不带 `page_id`**（`location` 只提供 `url`：`url` 取调用当时的位置快照 `location.href`；`readLocation()` 的 `pageId` 恒为 `undefined`）。

### 2.8 `setConsent(state)`

```ts
client.setConsent('granted');   // 'granted' | 'denied' | 'buffer' | 'unknown'
```

- 非法枚举取值计数 `invalid_args` 并忽略。
- 默认态、`consent_mode` 与 `full` 的合规提示见[接入指南 · 同意管理](integration.md#6-同意管理合规提示务必读完)。**当前不要依赖缺省同意态。**

### 2.9 `flush()`

立即回放命令队列（业务主动冲刷，C06-F2 的入口）。

```ts
submitButton.addEventListener('click', () => {
  client.track('submit_clicked');
  client.flush();
});
```

命令队列的 `flush` 只是"把队列交给实例执行"；批次层面的冲刷（条数/体积/空闲/最长等待）属 C06/C07，**尚未装配**。

### 2.10 `destroy()`

立即销毁并清空命令队列。

```ts
client.destroy();
```

销毁后：不再留有监听、定时器与 hook（C02-F1）；此后调用任何公共方法计数 `destroyed` 并忽略。

### 2.11 `onEvent(sink)` / `onDiagnostics(sink)`

```ts
const offEvent = client.onEvent((event) => console.log(event.event_name));
const offDiag  = client.onDiagnostics((record) => panel.push(record));
offEvent();   // 注销
offDiag();
```

- 返回注销函数（`() => void`）。
- `onEvent` 是事件出口：管线产出的事件都会调用它；`sink` 抛错只计数 `processor_error`，不影响业务。**装配根用它把事件接到传输**（T18，未交付）。
- `onDiagnostics` 是调试输出：`DiagnosticsRecord = { kind: string; reason_code: string; dropped: 'event' | 'field'; event_name?: string; field?: string }`。输出只含原因码、事件去向、事件名与字段路径，**绝不含令牌**。

---

## 3. 初始化选项与状态类型

### 3.1 `ClientInitOptions`（`init` 的入参）

```ts
interface ClientInitOptions {
  readonly appId?: string | undefined;
  readonly consent?: ConsentState | undefined;
  readonly debug?: boolean | DiagnosticsSink | undefined;
  readonly dictionary?: EventDictionary | undefined;
  readonly endpoint?: string | undefined;
  readonly env?: string | undefined;
  readonly location?: LocationSource | undefined;
  readonly onEvent?: EventSink | undefined;
  readonly pageId?: string | undefined;
  readonly release?: string | undefined;
  readonly token?: string | undefined;
}
```

逐参数的说明与"C01 当前是否消费"见[接入指南 5.1 节](integration.md#51-参数表逐条对齐-clientinitoptions--clientoptions)。注意 `appId` 是唯一必填项。

### 3.2 `ClientOptions`（`createClient` 的入参）

`ClientOptions extends ClientInitOptions`，额外提供 `registry?: GlobalRegistry`、`target?: EventTarget | null`，并重新声明 `debug` / `location` / `onEvent`。

```ts
interface ClientOptions extends ClientInitOptions {
  readonly debug?: boolean | DiagnosticsSink | undefined;
  readonly location?: LocationSource | undefined;
  readonly onEvent?: EventSink | undefined;
  readonly registry?: GlobalRegistry | undefined;
  readonly target?: EventTarget | null | undefined;
}
```

- `target`：原生事件目标（测试与多实例用）；不传时首次订阅原生事件时解析 `globalThis`，`null` 表示静默降级（SSR / Node）。
- `registry`：共享全局注册表，多实例共用一份原生监听（计数器仍各实例独立）。
- **`createClient` 不消费 `appId` / `consent` / `pageId`**：它们要放在 `init()` 里（实测；见[接入指南 5.2 节](integration.md#52-一个容易踩的坑)）。

### 3.3 `ClientState`（内核能力 `STATE_CAPABILITY` 的读数）

```ts
interface ClientState {
  readonly app_id: string | undefined;
  readonly initialized: boolean;
  readonly destroyed: boolean;
  readonly consent: ConsentState;
  readonly user: UserInput | undefined;
  readonly pageId: string | undefined;
  readonly contexts: Readonly<Record<string, string>>;
}
```

实测（`createClient()` → `init({ appId: 'your-app-id', consent: 'buffer', pageId: '/home' })` → `setUser('user-1')` → `setPage('/task/:id')`）：

```json
{ "app_id": "your-app-id", "initialized": true, "destroyed": false,
  "consent": "granted", "user": { "id": "user-1" }, "pageId": "/task/:id", "contexts": {} }
```

（上例中 `setConsent('granted')` 覆盖了 `init` 的 `buffer`。）

### 3.4 其它类型

| 类型 | 定义 | 说明 |
|---|---|---|
| `ConsentState` | `'granted' \| 'denied' \| 'buffer' \| 'unknown'` | 同意状态；**缺省 `unknown`**（Q5，2026-10-13 修正） |
| `LogLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | `log` 的级别 |
| `LocationSource` | `{ readonly href: string \| undefined; readonly pageId: string \| undefined }` | 位置来源 |
| `EventSink` | `(event: KernelEvent) => void` | 事件出口 |
| `DiagnosticsSink` | `(record: DiagnosticsRecord) => void` | 调试出口 |
| `UserInput` | `{ readonly id: string; readonly hashed?: boolean \| undefined }` | 用户标识 |

**[core] 不从入口包导出、必要时从 `@web-report-sdk/core` 导入的两个类型**：`Dispose`（`() => void`，`onEvent` / `onDiagnostics` 的返回类型）与 `KernelEvent`（`EventSink` 收到的形状：`{ readonly event_name: string; readonly occurred_at: number; readonly priority: EventPriority; [field: string]: unknown }`）。

---

## 4. 事件字典与字段类型

K01 生成的字典形状（`packages/core/README.md` 第 13 节，也是与 K01 的接口契约）：

```ts
type FieldSpec<TValue, TRequired extends boolean> = {
  readonly type: TValue;      // 维度：string | boolean | 字面量联合；指标：number
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

消费侧的推导规则（`packages/core/README.md` 第 13 节，**实现约束，务必遵守**）：

- `track` 的入参类型由"事件名 → 定义"推导：必填字段是必需属性、可选字段可省、enum 维度只接受字面量联合、`boolean` 维度接受 `boolean`、指标接受 `number`。
- **判断必填必须用属性类型投影，不要索引 `required`。** 在 `noUncheckedIndexedAccess` 下，可选属性被索引时会带上 `| undefined`，`T[K]['required'] extends true` 会失真，最终把字段类型推成 `never`。本项目用 `{ [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T]` 取可选键，再用 `NonNullable<T[K]>` 读 `required` 字面量。

| 导出 | 定义（`packages/core/etc/core.api.md`） | 用途 |
|---|---|---|
| `EventDictionary` | `Readonly<Record<string, EventDefinitionShape>>` | 字典的宽类型 |
| `EventDefinitionShape` | `{ dimensions?: …; metrics?: …; priority?: 'normal' \| 'critical'; schema_version?: number }` | 单个事件定义的宽类型 |
| `PermissiveDictionary` | `{ [eventName: string]: { priority?; schema_version?; dimensions?; metrics? } }` | `createClient()` 的缺省类型参数（事件名不校验） |
| `EventInput` | `{ dimensions?: TDimensions; metrics?: TMetrics; attachment?: string; priority?: 'normal' \| 'critical' }` | `log` / `captureError` 的入参形状 |
| `EventRequest<TDefinition>` | `{ dimensions?: DimensionFields<TDefinition>; metrics?: MetricFields<TDefinition>; attachment?: string; priority? }` | `track` 的入参形状 |
| `EventRequestOf<TDictionary, TName>` | `EventRequest<TDictionary[TName]>` | `track` 的精确定义 |
| `FieldSpec<TValue, TRequired>` | `{ readonly type: TValue; readonly required: TRequired }` | 单字段规格 |
| `FieldValue<TField>` | `TField extends { type: infer TValue } ? TValue : never` | 取字段值类型 |
| `DimensionFields(Of)` / `MetricFields(Of)` | `ShapeOf<…>` 投影 | 维度 / 指标负载类型 |
| `ShapeOf<TFields>` | 必填属性 + 可选属性 | `RequiredShape & OptionalShape` |
| `RequiredShape` / `OptionalShape` / `RequiredFieldKeys` / `OptionalFieldKeys` | 投影与键集合 | 必填/可选性推导 |

`defineEventDictionary`（[入口包导出]）是"校验 + 保留字面量"的工具函数：

```ts
function defineEventDictionary<const TDictionary extends EventDictionary>(dictionary: TDictionary): TDictionary;
```

- 它**不生成类型**；它做两件事：校验字面量满足 `EventDictionary` 形状，并用 `const` 类型参数**保留字面量**（含 `boolean`、字面量联合）不被宽化。
- 因此手写运行时字典时，`type` 位置上写的是**代表性字面量**，它会成为该字段的值类型：`type: 'free'` 表示该维度只接受字面量 `'free'`，`metrics: { duration_ms: { type: 0, required: true } }` 的字段值类型是字面量 `0`。需要开放类型时用类型标注放宽：`type: 'string' as string`、`type: 'web' as 'web' | 'app'`。
- **推荐路径是用 K01 生成的类型**（`createClient<EventDefinitions>()`，见 [工具指南 · K01.5](tools.md#k015-生成类型的接入方式)）：生成物直接在类型层面写 `FieldSpec<string, true>`，没有上面这些字面量取舍。仓库里 `packages/core/src/api/typed-events.test.ts` 展示了两种写法的对照。

类型层面（K01 生成物的形状，`packages/browser/src/typed-events.fixture.ts` 是它的可执行类型规格）：

```ts
import { createClient } from '@web-report-sdk/browser';
import type { FieldSpec } from '@web-report-sdk/browser';

type Dictionary = {
  readonly task_complete: {
    readonly priority: 'critical';          // 字面量：调用时不能改投递等级（Q3）
    readonly schema_version: 3;             // 字面量
    readonly dimensions: {
      readonly task_id: FieldSpec<string, true>;            // 必填：属性不可选
      readonly channel?: FieldSpec<'web' | 'app', false>;   // 可选：属性带 ? + required: false
    };
    readonly metrics: {
      readonly duration_ms: FieldSpec<number, true>;
      readonly retry_count?: FieldSpec<number, false>;
    };
  };
};

const client = createClient<Dictionary>();
client.track('task_complete', { dimensions: { task_id: 't-1' }, metrics: { duration_ms: 12 } });
client.track('task_complete', { dimensions: { task_id: 't-1', channel: 'web' }, metrics: { duration_ms: 12 } });
// client.track('not_registered');                       // 编译错误：未登记事件名
// client.track('task_complete', { dimensions: {} });     // 编译错误：缺必填字段
// client.track('task_complete', { dimensions: { task_id: 't-1', channel: 'desktop' } }); // 编译错误：enum 越界
```

运行时字典（`createClient({ dictionary })` / `init({ dictionary })`）用来提供 `schema_version` 与 `priority` 的取值；类型只负责编译期约束。

---

## 5. 常量与工具函数

### 5.1 常量（均可从 `@web-report-sdk/browser` 导入）

| 常量 | 值 | 说明 |
|---|---|---|
| `SDK_VERSION` | `"0.0.0"` | 当前版本（未发布工作区版本；首个对外版本号由 T35 决定） |
| `COMMAND_QUEUE_CAPACITY` | `200` | 命令队列上限；溢出每次计数一次 `command_queue_overflow` |
| `MAX_DIMENSION_VALUE_LENGTH` | `256` | 维度值长度上限 |
| `RESERVED_EVENT_PREFIXES` | `["sdk_", "web_"]` | 事件名保留前缀 |
| `WEB_JS_ERROR_LIMITS` | `{ errorType: 128, message: 256, source: 32, fingerprint: 64, attachment: 8192 }` | `web_js_error` 各字段的 Schema 上限 |
| `STATE_CAPABILITY` | `"sdk.client_state"` | 内核能力名：值是返回 `ClientState` 的函数（集成接口） |
| `STUB_BRIDGE_CAPABILITY` | `"sdk.stub_bridge"` | 内核能力名：值是 `(command: StubCommand) => void`（加载桩交接，集成接口） |
| `PUBLIC_METHODS` | 12 个方法名 | 见第 2 节 |
| `API_REASON_CODES` | 见第 6 节 | C01 的原因码常量 |

### 5.2 工具函数

| 函数 | 签名 | 说明 |
|---|---|---|
| `createUuid` | `(): string` | 生成 UUID v4（优先 `crypto.randomUUID()`，不可用时回退到手写 v4 模板） |
| `readLocation` | `(): LocationSource` | 读当前 `location.href` 的快照；`pageId` 恒为 `undefined`（页面标识由 `init({ pageId })` / `setPage` 提供）；无 `window` 时两个字段都是 `undefined` |
| `truncate` | `(value: string, maxLength: number): string` | 按 UTF-16 码元截断，且不切断代理对（`value.length <= maxLength` 时原样返回） |
| `hasValidEventName` | `(name: unknown): boolean` | 事件名规则校验 |
| `hasValidFieldKey` | `(key: unknown): key is string` | `fieldKey` 规则校验 |
| `isConsentState` | `(value: unknown): value is ConsentState` | 同意状态校验 |
| `isNonEmptyString` | `(value: unknown): value is string` | 非空字符串校验 |
| `isPlainRecord` | `(value: unknown): value is Record<string, unknown>` | 普通对象校验 |
| `defineEventDictionary` | `<const T extends EventDictionary>(dictionary: T): T` | 保留字面量的字典定义（见第 4 节） |
| `createCommandQueue` | `(options?: { capacity?: number }): CommandQueue` | 命令队列（加载桩/集成用；`CommandQueue` 见下） |

```ts
interface CommandQueue {
  capacity(): number;
  size(): number;
  push(command: QueuedCommand): CommandQueuePushResult;   // { status: 'queued' | 'rejected' }
  shift(): QueuedCommand | undefined;
  clear(): void;
}

interface QueuedCommand {
  readonly kind: string;            // 公共方法名
  readonly eventId: string;
  readonly occurredAt: number;
  readonly name?: string | undefined;
  readonly args?: readonly unknown[] | undefined;
  readonly pageId?: string | undefined;
  readonly url?: string | undefined;
}

interface StubCommand {              // 加载桩交给主包的命令
  readonly kind: string;
  readonly eventId?: string | undefined;   // 加载桩在调用当时生成，主包原样沿用
  readonly occurredAt?: number | undefined;
  readonly name?: string | undefined;
  readonly args?: readonly unknown[] | undefined;
  readonly pageId?: string | undefined;
  readonly url?: string | undefined;
}
```

---

## 6. 原因码

`API_REASON_CODES`（[入口包导出]；`packages/core/etc/core.api.md`）。取值本身是契约 `reason-codes.md` 的子集：

| 常量 | 值 | 触发 |
|---|---|---|
| `invalidArgs` | `invalid_args` | 非对象维度/指标、非法枚举取值、空字符串用户/页面、非法上下文键名、`captureError` 的越界维度键 |
| `invalidEventName` | `invalid_event_name` | 事件名不符合命名规则或使用保留前缀（整条丢弃） |
| `nonFiniteMetric` | `non_finite_metric` | 指标值为 `NaN` / `Infinity`（该字段丢弃，事件继续） |
| `commandQueueOverflow` | `command_queue_overflow` | 命令队列溢出 |
| `truncatedDimension` | `truncated_dimension` | 维度值按 Schema 上限被截断 |
| `destroyed` | `destroyed` | 销毁后调用任何公共方法 |
| `processorError` | `processor_error` | 处理器 / 事件出口 / 调试出口抛错 |
| `sinkError` | `processor_error` | 与 `processorError` **同值**（历史别名） |

C01 的调试输出会带原因码（`DiagnosticsRecord.reason_code`），示例见[接入指南 · 调试模式](integration.md#7-调试模式)。

**C03 的配置原因码不在入口包导出面里**（`CONFIG_REASON_CODES` 仅在 `@web-report-sdk/core` 中导出；web 侧的读数是 `sdk_health` 的 `count_config_*` 指标与调试输出）：`config_fetch_failed`、`config_signature_invalid`、`config_signature_unavailable`、`config_version_stale`、`config_scope_mismatch`、`config_format_unsupported`、`config_parse_failed`、`config_schema_invalid`、`config_cache_expired`、`config_consent_mode_rejected`（`packages/core/etc/core.api.md` 的 `CONFIG_REASON_CODES`；语义见 `reason-codes.md` 第 2 节）。

完整的客户端原因码清单（含 C04–C08 的）见 `docs/contracts/reason-codes.md`，接收方读到的 `sdk_health` 计数指标口径见 [接收方指南](receiver-guide.md)。

---

## 7. 双写适配器 API（`@web-report-sdk/plugins`）

迁移期的第三方 APM 双写适配器（C05-F5，T19）。**它不在 `@web-report-sdk/browser` 的导出面里**，要从 `@web-report-sdk/plugins` 导入。

```ts
interface ApmDualWriteOptions {
  forward?: ApmForward;                          // 直接注入（第三方 SDK 已在手）
  resolve?: () => ApmForward | undefined;        // 惰性解析：第三方 SDK 未加载时返回 undefined
  fieldMap?: Readonly<Record<string, string>>;   // 目标字段名 → SDK 事件字段路径
  constants?: Readonly<Record<string, unknown>>; // 每条记录附加的固定字段
  eventTypes?: readonly string[];                // 转发的 event_type，缺省 ['custom']
}

type ApmForward = (record: Readonly<Record<string, unknown>>) => void;

interface ApmDualWriteStats { readonly forwarded: number; readonly failed: number; readonly skipped: number; }

interface ApmDualWritePlugin {
  readonly id: string;
  readonly install: (context: ApmDualWriteContext) => void;
  stats(): ApmDualWriteStats;
}

function createApmDualWritePlugin(options?: ApmDualWriteOptions): ApmDualWritePlugin;
const APM_DUAL_WRITE_PLUGIN_ID: string;                 // 'apm_dual_write'
const APM_DUAL_WRITE_STATS_CAPABILITY: string;          // 'apm_dual_write.stats'
const DEFAULT_APM_FIELD_MAP: Readonly<Record<string, string>>;
const DEFAULT_APM_EVENT_TYPES: readonly string[];       // ['custom']
const PACKAGE_NAME: string;                             // '@web-report-sdk/plugins'
```

关键约定（`packages/plugins/README.md` 第 1 节）：

- **注入，不 import**：第三方接口由接入方注入；适配器源码与产物都不出现任何第三方包（C05-AC-18）。
- **单向**：只把本 SDK 的事件写出去，**不从第三方 APM 读取数据**（Q7 第 3 条）。
- **默认关闭**：只 `registerPlugin` 不会转发；必须显式 `applyPluginConfig({ apm_dual_write: true })`（Q7 第 2 条）。
- `forward` 与 `resolve` 二选一，同时给出时 `forward` 优先；两者都没有（或 `resolve()` 返回 `undefined`）时按"第三方接口不存在"处理：**每条命中事件计数一次 `processor_error`**，事件继续流转。
- 取值缺失的目标字段不写入记录；`0`、`''`、`false` 会写入。`constants` 先铺底，`fieldMap` 的结果覆盖同名目标字段。
- 在 `before_send` 段注册处理器，转发的是最终形态的事件，且被采样/过滤掉的事件不会转发。
- 计数口径：`processor_error`（内核计数器）、`forwarded` / `failed` / `skipped`（`stats()` 或能力 `apm_dual_write.stats`）。完整配置示例见[迁移指南 · 双写适配器配置](migration.md#第-2-步开启双写)。

> **使用前提（当前不满足）**：适配器要挂到内核插件宿主上，而插件宿主与 `captureNativeHttpRefs()` 的调用点属于**装配根（T18，未交付）**。当前无法从 `createClient()` 得到一个可安装插件的装配实例。详见[迁移指南 · 前提与边界](migration.md#0-前提与边界)。

---

## 8. 明确不属于公共面的接口

以下接口在 `etc/*.api.md` 里是 `@public`（可被其它包 import），但**不是给接入方用的**；文档与示例都不得依赖它们（看板 2026-10-12 裁定：保留 `Client.kernel` 但标注为内部句柄、接入方不得依赖）：

| 接口 | 位置 | 为什么不是接入面 |
|---|---|---|
| `Client.kernel`（`Kernel`、`createKernel`、`Pipeline`、`PluginHost`、`CapabilityRegistry`、`Counters`、`GlobalRegistry`、`definePlugin` 等） | `packages/core/etc/core.api.md` | C02 内核是 T12–T18 的集成面；`kernel` 是 C06/C08 的接线句柄 |
| `createConfigRuntime`、`CONFIG_CAPABILITY`、`EffectiveConfig`、`ConfigRuntimeOptions`、`verifyEnvelope` 等（C03） | `packages/core/etc/core.api.md` | 装配根（T18）的接线面；`ConfigRuntimeOptions` 是 C03 自有类型 |
| `createTransportQueue`、`createDelivery`、`BatchSubmitPort`、`createHealthReporter`、`createDebugTracer`、`captureNativeHttpRefs` 等（C06–C08） | `packages/transport/etc/transport.api.md` | 传输与自监控的内部装配面；`README.md` 第 2 节是给 T16 的冻结交接接口 |
| `createApmDualWritePlugin` 之外的插件宿主装配 | —— | T18 的义务 |

唯一**例外地提供给接入方使用**的两个内核能力是 `STATE_CAPABILITY` 与 `STUB_BRIDGE_CAPABILITY`（第 5.1 节）：它们通过 `client.kernel.getCapability(...)` 读取，用于状态自检与加载桩交接，属"集成点"而非公共方法。

---

## 9. 怎么核对本文与真实 API

```bash
# 公共 API 审计：与各包 etc/*.api.md 比对，有未登记的变更时阻断
pnpm api:check

# 有意变更时更新 API 报告（由前端负责人确认签名后执行）
pnpm api:update
```

**本工作树未运行 `pnpm api:check`**（按 T34 派工约束，不跑门禁）；本文的签名逐条对照的是 `packages/browser/etc/browser.api.md` 与 `packages/core/etc/core.api.md` 的当前内容，并未依赖运行该命令。
