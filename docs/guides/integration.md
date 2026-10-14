# 接入指南

- 对应交付：T34（A14）；读者：接入方的 Web 前端工程师
- 事实来源：`packages/browser/etc/browser.api.md`、`packages/core/etc/core.api.md`、`packages/browser/README.md`、`packages/core/README.md`（C01 部分）、`docs/contracts/`、`docs/decisions/Q5-consent.md`、`D002`

> **先读 [docs/guides/README.md](README.md) 的「能力状态总表」。** 一句话总结：引入方式、C01 公共 API、三个开发工具、以及**把 SDK 装配成"事件真的发到接收方"这一步（T18 装配根，`createAssembly()`）现在就能用**；本指南第 8.3 节的「端到端自检」已具备可执行性（真实浏览器 E2E 仍归 T29）。

## 1. 这份指南能让你做到什么

**现在可以做到：**

- 用 npm 依赖或 `<script>` 两种方式把包引进来，在 Vite 的生产构建、`<script>` 无构建环境、Vitest、Jest 中直接导入（指南第 4.2 节要求主流构建工具都不需要额外配置；本仓库 `examples/` 覆盖 Vite、IIFE、Vitest、Jest，**webpack 与开发服务器未在本仓库验证**）。
- 按 [API 参考](api-reference.md) 调用 C01 的公共方法：`init` / `track` / `log` / `captureError` / `setUser` / `clearUser` / `setContext` / `removeContext` / `setPage` / `setConsent` / `flush` / `destroy`，以及 `onEvent` / `onDiagnostics`。
- 用 K01 在自己的仓库里维护事件注册表并生成类型；用 K02 给远程配置正文签名并托管；用 M01 在本地起一个接收服务做协议联调（见 [工具指南](tools.md)）。

**现在还不能做到（不要按"已可用"设计）：**

- **真实浏览器 E2E 未验证（T29 未就绪）**：信标通道、真实 `visibilitychange`、真机 IndexedDB 落盘、Web Locks 选主等只在单测/注入替身下验证过。
- **调试 URL 参数门禁（`?wr_debug=1`）尚未接线**（见第 7.2 节）；请用 `createAssembly`/`createClient` 的 `debug` 选项。
- **远程配置的真实签名链路**（K02 发布物 + 真实公钥）未在浏览器验证；`createAssembly({ configEndpoint, configPublicKeys })` 的接线已完成，但真实签名的浏览器侧验证归 T29。
- 包尚未发布：全部 `private: true`、`version: 0.0.0`，所以第 3 节的安装命令目前只能在**本地联调**形态下使用（`link:`）。

## 2. 环境与前置

| 项 | 取值 | 出处 |
|---|---|---|
| 运行环境 | 浏览器；编译目标 ES2020 | 指南第 3 节；`packages/*/tsup.config.ts` 的 `target: 'es2020'` |
| 运行时依赖 | 零（SDK 不假设你使用任何 HTTP 库、状态管理库或第三方 APM） | 指南第 3、4.2 节 |
| 框架依赖 | 无；核心包不依赖任何框架。框架集成包需要框架声明为 `peerDependency`，目前尚未提供 | 指南第 3 节 |
| 开发工具（K01/K02/M01） | Node.js 24（`.nvmrc`） | `.nvmrc`；`tools/*/README.md` |
| 模块形态 | ESM（`"type": "module"`），`package.json` 声明 `"sideEffects": false`，模块顶层无副作用，可在 SSR 与测试环境直接导入 | 各包 `package.json`；各包 README |
| 类型声明 | 每个包发布 `.d.ts`（`pnpm build` 产出 `dist/index.d.ts`） | 指南第 3 节；`packages/browser/README.md` 第 5 节 |

## 3. 接入方式 A：npm / 构建工具

### 3.1 安装

正式版本发布后（T35，**未执行**）：

```bash
pnpm add @web-report-sdk/browser
# 或 npm install @web-report-sdk/browser
```

当前（包尚未发布）本地联调按指南第 4.1 节：

```bash
# 只在本地使用，不提交到接入方仓库
pnpm add @web-report-sdk/browser@link:<SDK 仓库路径>/packages/browser
```

测试与预发布阶段使用带 `-beta.N` 后缀的预发布版本，接入方**锁定精确版本**（指南第 4.1 节；发布由人执行）。

### 3.2 引入与最小调用

```ts
import { createClient } from '@web-report-sdk/browser';

const client = createClient();
client.init({
  appId: 'your-app-id',        // 必填且非空；非法时计数 invalid_args 并忽略整个 init
  env: 'production',
  release: '1.2.3',
});
client.track('task_complete', { dimensions: { task_id: 't-1' } });
client.setUser('user-1');
client.destroy();
```

要点（与 `packages/browser/README.md` 第 1 节、`packages/core/README.md` 第 11 节一致）：

- 所有公共方法**同步返回 `undefined`、从不抛错**；内部异常一律被捕获并计数（指南第 11 节）。
- **`app_id` 不是事件体字段**：它属于批次公共头；事件体只含 `event_id`、`event_name`、`event_type`、`schema_version`、`occurred_at`、`priority` 等 `batch.schema.json` `$defs/event` 允许的键。
- `createClient(options)` 的 `options` 里只有 `debug` / `onEvent` / `location` / `dictionary` / `target` / `registry` 会被记下；**`appId` 等初始化参数要放在 `init()` 里**（见第 5.2 节）。

### 3.3 已验证的导入环境

仓库 `examples/` 下有三个可运行的最小工程，就是"接入方在各类构建/测试环境中能否直接导入"的基准（指南第 4.2 节）：

| 工程 | 验证什么 | 命令 |
|---|---|---|
| `examples/vite` | Vite 生产构建能解析并打包含（`vite build`） | `pnpm examples:build` |
| `examples/node-import` | Vitest 与 Jest（原生 ESM）中直接导入**构建产物**，不需要额外配置/transform | `pnpm examples:test` |
| `examples/script-tag` | IIFE 产物在无构建环境中通过 `<script>` 暴露全局 `WebReportSDK` | `pnpm examples:test` |

前置条件：新工作树/新克隆里这些命令需要先有 `packages/*/dist`（`examples/vite` 的解析与 `examples/node-import` 的导入都指向 `dist`）。指南第 6 节已明确 `pnpm gates` 的顺序是 `lint → build → typecheck → …`，原因就是这一点。本指南的验证记录见第 8.1 节。

## 4. 接入方式 B：`<script>`（无构建流程）

页面**头部先内联加载桩**，再异步加载主包 IIFE；加载桩先把调用缓存到队列，主包加载完成后回放。

```html
<script>
  // 构建脚本把 packages/browser/src/loading-stub.ts 压缩后的内容内联到这里
</script>
<script async src="https://cdn.example.com/web-report-sdk.iife.js"></script>
<script>
  // 加载桩阶段就可以调用：全部进入队列，主包加载后按原顺序回放
  window.WebReportSDK.init({ appId: 'your-app-id' });
  window.WebReportSDK.track('page_landing');
</script>
```

主包加载完成后做一次交接（走内部能力，**不是公共 API 方法**）：

```ts
import { createClient, STUB_BRIDGE_CAPABILITY } from '@web-report-sdk/browser';
import type { StubCommand } from '@web-report-sdk/browser';

const stub = window.WebReportSDK;                 // 加载桩安装的全局对象
const client = createClient({ appId: 'your-app-id' });
const bridge = client.kernel.getCapability(STUB_BRIDGE_CAPABILITY) as (c: StubCommand) => void;
for (const command of stub.drain()) bridge(command);   // drain 同时移除加载桩的错误监听
client.flush();
```

IIFE 产物与加载桩的事实（`packages/browser/README.md` 第 2 节、`packages/browser/src/loading-stub.ts`）：

- 产物：`packages/browser/dist/web-report-sdk.iife.js`，全局变量名 **`WebReportSDK`**；导出映射 `@web-report-sdk/browser/iife`（`examples/script-tag/check.mjs` 用它做 `require.resolve`）。
- 加载桩与主包**完全独立**：不 import 任何模块，可整体内联；每条命令在**调用当时**生成 `eventId` 并记下 `occurredAt` 与 `location.href` 快照，主包原样沿用（去重依据与时间戳不被回放时刻污染）。
- 队列上限 **200** 条，保留最早的调用，超出时丢弃新调用并 warn；`drain()` 会**先移除**它注册的 `window` 捕获阶段 `error` 监听再交出队列。
- 主包加载失败（404）时不抛错、不影响页面；重复内联/重复执行不重置已有队列（单例键）。
- 加载桩暴露的调用面就是 C01 的公共方法，外加 `getQueueLength()` / `drain()` / `queueLimit` / `ready`（调试与自检用）。
- 体积（实测 2026-10-12）：压缩 IIFE 1601 B / gzip 781 B，预算 1 KB；复现命令 `node packages/browser/scripts/measure-stub.mjs`。

## 5. 初始化参数

### 5.1 参数表（逐条对齐 `ClientInitOptions` / `ClientOptions`）

| 参数 | 类型 | 必填 | 说明 | C01 当前是否消费 |
|---|---|---|---|---|
| `appId` | `string` | **是**（非空） | 应用标识；非法（非字符串或空串）时计数 `invalid_args` 并忽略 `init` | 是 |
| `consent` | `'granted' \| 'denied' \| 'buffer' \| 'unknown'` | 否 | 初始同意状态，**缺省 `unknown`**（Q5），见第 6 节 | 是 |
| `pageId` | `string` | 否 | 手动路由模式下的初始页面标识（非空字符串才生效） | 是 |
| `debug` | `boolean \| DiagnosticsSink` | 否 | 调试输出，缺省静默，见第 7 节 | 是 |
| `onEvent` | `EventSink` | 否 | 事件出口：每条产出的事件都会调用它。装配根用它接传输 | 是 |
| `location` | `LocationSource` | 否 | 位置来源（`{ href, pageId }`）；不传则首次使用时读运行环境的 `location` | 是 |
| `dictionary` | `EventDictionary` | 否 | 事件字典（K01 生成物），用于 `track` 的字段级类型与 `priority`/`schema_version` 取值 | 是 |
| `endpoint` | `string` | 否 | 上报端点（契约里叫"端点来源：初始化参数 `endpoint`"） | C01 不消费；**装配根消费**（`createAssembly` 组装凭据端口） |
| `token` | `string` | 否 | 写令牌（只写不读） | C01 不消费；**装配根消费**（`createAssembly` 组装凭据端口） |
| `env` | `string` | 否 | 环境，如 `production`、`staging`（批次头必填） | **否**（属装配/批次头） |
| `release` | `string` | 否 | 接入方应用版本（批次头必填） | **否**（属装配/批次头） |

`ClientOptions`（`createClient(options)` 的入参）在 `ClientInitOptions` 之上只增加 `registry`（共享全局注册表）与 `target`（原生事件目标），并把 `debug` / `location` / `onEvent` 再声明一次。

### 5.2 一个容易踩的坑

`createClient({ appId })` **不会**完成初始化——`createClient` 的 `options` 里不消费 `appId`。正确写法是创建后调用 `init`：

```ts
const client = createClient({ appId: 'your-app-id' });   // appId 在这里被忽略
client.init({ appId: 'your-app-id' });                    // 初始化要在这里做
```

多实例（微前端）也一样，每个实例独立 `init`：

```ts
import { createClient } from '@web-report-sdk/browser';

const main = createClient({ appId: 'main-app' });
const sub = createClient({ appId: 'sub-app' });
main.init({ appId: 'main-app' });
sub.init({ appId: 'sub-app' });
```

每个实例拥有独立的内核、命令队列、计数器与状态；销毁一个实例不影响另一个。页面上想共享一份原生监听时，传入同一个 `registry`（计数器仍各实例独立）：

```ts
import { createClient, createCounters, createGlobalRegistry } from '@web-report-sdk/core';

const registry = createGlobalRegistry({ counters: createCounters(), target: window });
const main = createClient({ appId: 'main-app', registry, target: window });
const sub = createClient({ appId: 'sub-app', registry, target: window });
```

> `createGlobalRegistry` 与 `createCounters` **不在** `@web-report-sdk/browser` 的导出面里（见 `packages/browser/etc/browser.api.md`），上例从 `@web-report-sdk/core` 导入。多实例共享注册表属集成场景，接入方通常不需要。

### 5.3 远程配置参数（尚未接到公共 API）

契约规定公钥与配置端点由接入方传入：`remote-config.md` 第 4 节（`config_public_keys`，格式 `{ [key_id]: JWK }`，SDK 不内置公钥）、第 1 节（`config_endpoint`，不传则不拉取、直接用内建默认）。C03 已实现为 `createConfigRuntime({ configEndpoint, publicKeys, consentMode, ... })`（`packages/core/README.md` 第 21 节），但：

- 这些字段**不在** `ClientInitOptions` 里（C01 不能改，属破坏面）；
- `ClientInitOptions → ConfigRuntimeOptions` 的映射由 **T18 装配根**完成：`createAssembly({ configEndpoint, configPublicKeys, consentMode })` 会在内核上创建配置运行时并 `start()`（`packages/core/README.md` 第 21 节）；
- `createClient().init(...)` 仍然不能启用远程配置——它是纯 C01 面，没有配置运行时。

远程配置正文的格式、签名算法与托管方式见 [工具指南 · K02](tools.md#k02-配置签名与托管)。

## 6. 同意管理（合规提示，务必读完）

### 6.1 设计口径（Q5 + D002）

- **同意由接入方收集**：SDK 不提供同意弹窗，只提供 `setConsent(state)`。接入方负责自己的合规判断（Q5 结论："接入方必须自行确认合规。SDK 只提供机制和保守的默认值，不判断接入方的业务是否已经取得授权。T34 的接入指南必须写明这一点"）。
- **四种同意状态**：`unknown`（**初始态**——尚未取得任何授权）、`granted`（已同意）、`denied`（已拒绝）、`buffer`（先缓存不发送）。类型定义见 `packages/core/etc/core.api.md`。
- 三种 `consent_mode`：`essential_only`（默认）、`buffer`、`full`（`ConsentMode`，`packages/core/etc/core.api.md`）。

### 6.2 `full` 模式：只能写在初始化参数里，且需要接入方法务确认

> **`consent_mode: full` 只能在接入方页面代码的初始化参数中设置，需要接入方的法务确认。**

三条依据与后果：

1. `full` 只允许出现在**接入方自己评审、自己发布**的页面代码里，留下代码评审记录；远程配置**不接受** `full`（D002 结论）。SDK 收到远程配置中的 `full` 时忽略该字段并计数 `config_consent_mode_rejected`（`remote-config.md` 2.1）。K02 校验时也会直接拒绝 `privacy.consent_mode: "full"`（`tools/config-signer/README.md`）。
2. 远程配置只能把 `full` **收紧**为 `buffer` 或 `essential_only`，不能放宽。
3. Q5 明确要求本指南在 `full` 的说明中注明"需要接入方的法务确认"——因为放宽采集范围是**接入方的合规决定**，SDK 不做合规判断。

### 6.3 各状态下的默认行为（Q5 表格）

| 状态 | 采集 | 发送 | 本地标识 |
|---|---|---|---|
| `unknown`（未表态） | 按 `consent_mode` 处理，默认 `essential_only` | 只发送必要事件 | 不生成持久化设备标识，只用内存中的会话标识 |
| `granted` | 全部 | 全部 | 生成并持久化设备标识 |
| `denied` | 只采集必要事件 | 只发送必要事件 | 清除设备标识、离线数据和会话随机数 |

"必要事件"= 不含任何用户/设备标识与自定义维度的 SDK 健康事件（`sdk_health`），以及脱敏、去掉堆栈中 URL 查询参数的 JS 错误计数（Q5 第 4 条）。

### 6.4 当前实现的边界（**必须知道**）

- Q5 的"初始状态 `unknown`"**已由 C04（T14）落地并合入 main**：`ConsentState` 含 `'unknown'`，且 **C01 的缺省同意态已是 `unknown`**（2026-10-13 经负责人签字的 Q5 一致性修正）。`consent_mode` 的合并由 C03 落地。
- 这段历史值得知道：本指南初版时 **C01 的缺省是 `granted`**（与 Q5 不一致，可被读作"未经同意即采集"），由 T14 与 T34 **各自独立发现**后上报、经负责人裁定修正。免踩坑记录见 `docs/tasks/board.md`。
- **仍建议显式传值**：`unknown` 表示"尚未取得授权"，SDK 按 Q5 的保守语义处理；请在你的同意组件回调里显式调用 `setConsent(...)`，并在 `init` 里显式传入 `consent`。

### 6.5 用法

```ts
// 你的同意组件回调
client.setConsent('granted');   // 用户同意
client.setConsent('denied');    // 用户拒绝
client.setConsent('buffer');    // 先缓存不发送，同意后补发
```

`setConsent` 的入参由运行期校验：非法枚举取值计数 `invalid_args` 并忽略（`packages/core/README.md` 第 17 节）。

## 7. 调试模式

### 7.1 与 SDK 对齐的开关（`debug` 选项）

调试输出是**可注入的 sink，缺省静默**（C08-AC-09：非白名单用户**不**因 URL 参数自动开启调试）：

```ts
createClient();                                          // 缺省：静默
createClient({ debug: true });                           // 默认 console sink
createClient({ debug: (record) => panel.push(record) }); // 自定义面板
createClient({ debug: false });                          // 显式静默
```

- 默认 console sink 输出"原因码 + 事件去向"，**绝不含令牌**。仓库对 `console` 只有两处精确豁免：`packages/core/src/api/console-sink.ts`（本 sink 的实现）与 `packages/browser/src/loading-stub.ts`（队列溢出时告警）；其余 SDK 代码禁止 `console`（`eslint.config.js` 的 `no-console`）。
- `DiagnosticsRecord` 的字段只有 `kind`、`reason_code`、`dropped`（`'event'` / `'field'`）、可选的 `event_name` 与 `field`（`packages/core/etc/core.api.md`）。
- 也可以随时挂接 / 摘除：`client.onDiagnostics(sink)` 返回注销函数。

### 7.2 URL 参数开关（C08，**尚未接到公共 API**）

C08 实现了 URL 参数门禁：参数名 **`wr_debug`**（`0` / `false` / `off` 视为关闭），**只有非生产环境或白名单用户**才真正开启；`env` 缺失时保守处理（仅白名单）（`packages/transport/README.md` 第 7 节；`DEBUG_QUERY_PARAM = "wr_debug"`，`packages/transport/etc/transport.api.md`）。

- 该门禁由 C08 的 `resolveDebugMode()` 实现，但**没有任何任务认领它的接线**（T17 的「遗留交接义务」只列了计数/计时装饰器与 `captureNativeHttpRefs()`；T18 的 8 项接线义务也不含它），因此加 `?wr_debug=1` 不会有任何效果——属**归属空缺**，已在看板登记。请直接用第 7.1 节的 `debug` 选项。
- 参数名由 T17 自定（契约未指定），`resolveDebugMode({ paramName })` 可配置；将来若要改名不需要改逻辑。

## 8. 自检

自检分三层，**三层现在都能跑**（第三层的真实浏览器版本归 T29）。

### 8.1 第一层：引入自检（现在可跑）

在 SDK 仓库里：

```bash
# 前置：本工作树里 packages/*/dist 存在。新工作树先跑一次 pnpm build（指南第 6 节）。
pnpm examples:build     # Vite 生产构建
pnpm examples:test      # <script>/IIFE、Vitest、Jest 三条导入路径
```

在你自己的项目里（最小自检）：

```ts
import { SDK_VERSION, PUBLIC_METHODS } from '@web-report-sdk/browser';

console.log(SDK_VERSION);           // 期望：'0.0.0'（未发布工作区版本）
console.log(PUBLIC_METHODS);        // 期望：12 个公共方法名
```

### 8.2 第二层：公共 API 行为自检（现在可跑）

用 `onEvent` 观察事件是否按预期产出（C01 的事件出口），不需要传输：

```ts
import { createClient, COMMAND_QUEUE_CAPACITY } from '@web-report-sdk/browser';

const seen: unknown[] = [];
const client = createClient({ onEvent: (event) => { seen.push(event); } });

// 1) init 之前调用会进命令队列（上限 200），init 后按序回放
client.track('before_init');                 // 进队列
client.init({ appId: 'your-app-id' });
client.track('after_init', { dimensions: { task_id: 't-1' }, metrics: { duration_ms: 12 } });
client.flush();                              // 立即回放命令队列
client.destroy();

console.log(COMMAND_QUEUE_CAPACITY);         // 200
console.log(seen);                           // 两条事件；每条含 event_id/event_name/.../priority
```

逐项期望（都可以在 `packages/core/README.md` 第 11–17 节找到出处）：

- `init` 之前调用任何公共方法都不抛错、进命令队列；`init` 后回放，顺序不变。
- 每条事件都带 `event_id`（UUID v4）、`event_name`、`event_type`、`schema_version`、`occurred_at`、`priority`。
- 未在字典中登记的事件名取 `schema_version: 1`、`priority: 'normal'`。
- 事件名必须至少两段小写下划线，且不得使用保留前缀 `sdk_` / `web_`；违规整条丢弃并计数 `invalid_event_name`。
- 非法参数（非对象维度/指标、非法枚举、空串用户/页面、非法上下文键名）计数 `invalid_args`；指标为 `NaN`/`Infinity` 时只丢该字段并计数 `non_finite_metric`。
- 销毁后调用任何公共方法计数 `destroyed` 并忽略（`destroy()` 本身那次不计数）。

### 8.3 第三层：端到端上报自检（用 `createAssembly()`）

用装配根把接收方接上（本仓库已验证的是 M01 一侧的协议行为，见 [工具指南 · M01](tools.md#m01-本地联调)）：

1. 用 [M01](tools.md#m01-本地联调) 在本地起接收服务：`node tools/mock-receiver/dist/cli.js`（默认 `127.0.0.1:8787`）。
2. 把 SDK 的端点指向 M01（`endpoint` / 远程配置 `endpoints.ingest`），`app_id` 与令牌用占位值。
3. 调用 `client.track('self_check_event')` 后 `client.flush()`。
4. 查 M01 的计数：`curl -s http://127.0.0.1:8787/__mock/counters`，确认 `stored_events` 增加且 `rejected_*` 为 0；查入库：`curl -s http://127.0.0.1:8787/__mock/events`。
5. 对账恒等式：`received_events - stored_events === duplicate_events`（M01-AC-06）。

**当前状态：第 1–5 步可执行**。装配根用法：`createAssembly({ appId, endpoint, token, env, release, consent: 'granted' })` 后调用 `assembly.init()`（或直接用返回的 `client`），`track` 产出的事件会经 C04 管线 → C06 队列 → C07 发送器发到 `endpoint`。仓库里的端到端用例见 `packages/browser/src/assembly.test.ts`（注入传输替身，不需要真实网络）。

## 9. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 调了 `createClient({ appId })` 但什么都没发生 | `createClient` 不消费 `appId`，必须再调 `client.init({ appId })`（第 5.2 节） |
| 报"事件名非法" | 事件名需至少两段小写下划线，且不得以 `sdk_` / `web_` 开头；计数 `invalid_event_name`，整条丢弃 |
| 事件没有上报 | 先用 `createAssembly({...})` 装配（`createClient` 没有输出端）；确认传了 `endpoint` + `token` 与 `consent: 'granted'`（`essential_only` + `unknown` 下非必要事件不发送）；再用 `debug: true` 看原因码 |
| 想读当前状态 | **没有 `getState()`**（AC-01 要求所有公共方法返回 `undefined`）。状态走内核能力：`client.kernel.getCapability(STATE_CAPABILITY)()`，类型 `ClientState`。这是集成接口，不是公共 API |
| 想手动把加载桩缓存的命令交回来 | **没有 `acceptCommand()`**，走 `STUB_BRIDGE_CAPABILITY`（第 4 节） |
| 事件重复了 | SDK 为保证不丢失会重复送达；去重由接收方按 `app_id` + `event_id` 在至少 7 天内完成（RR-05） |
| `import` 报模块找不到 | `examples/vite` / `examples/node-import` 解析的是 `dist`；新工作树先 `pnpm build` |
