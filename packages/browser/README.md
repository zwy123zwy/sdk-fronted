# @web-report-sdk/browser —— 接入方入口包（T12 交接产物）

接入方实际安装的包：重新导出 `@web-report-sdk/core` 的公共 API，并提供 `<script>` 场景的
**加载桩**。本包顶层无副作用：不注册原生监听、不访问 `window`、不自动 `init`。

## 1. 安装（npm / 构建工具）

```bash
pnpm add @web-report-sdk/browser
```

```ts
import { createClient } from '@web-report-sdk/browser';

const client = createClient();                 // 或 createSdk()
client.init({ appId: 'your-app-id', env: 'production', release: '1.2.3' });
client.track('task_complete', { dimensions: { task_id: 't-1' } });
```

在 Vite / webpack 的生产构建、开发服务器以及 Vitest / Jest 中都可以直接导入（见仓库 `examples/`）。

## 2. `<script>` 引入（无构建流程）

页面头部先内联**加载桩**，再异步加载主包 IIFE。加载桩在页面头部先缓存调用
（包括尽早捕获的首屏错误），主包加载完成后回放。

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

主包加载完成后，把加载桩缓存的命令交给真实客户端回放（走内部能力，不是公共 API）：

```ts
import { createClient, STUB_BRIDGE_CAPABILITY } from '@web-report-sdk/browser';
import type { StubCommand } from '@web-report-sdk/browser';

const stub = window.WebReportSDK;                 // 加载桩安装的全局对象
const client = createClient({ appId: 'your-app-id' });
const bridge = client.kernel.getCapability(STUB_BRIDGE_CAPABILITY) as (c: StubCommand) => void;
for (const command of stub.drain()) bridge(command);   // drain 同时移除加载桩的错误监听
client.flush();
```

加载桩的性质（C01-F3）：

- 与主包**完全独立**：不 import 任何模块，可以整体内联；
- 每条命令在**调用当时**生成 `eventId`（UUID v4）并记下 `occurredAt` 与 `location.href`
  快照，主包原样沿用（去重依据与时间戳不被回放时刻污染）；
- 队列上限 **200** 条，保留最早的调用，超出时丢弃新调用并 warn；
- 注册 `window` 的捕获阶段 `error` 监听，尽早把首屏错误缓存成 `captureError` 命令；
  交接时 `drain()` **先移除该监听**再交出队列，避免与主包插件重复采集；
- **主包加载失败（404）时不抛错、不影响页面**，队列不超过上限；
- 重复内联/重复执行不重置已有队列（单例键）；
- 体积（实测，2026-10-12，`node packages/browser/scripts/measure-stub.mjs`）：
  压缩 IIFE（真实交付）**1601 B / gzip 781 B**；类型擦除+轻量整理（未压缩）gzip 996 B。上限 1 KB。

复现实测：

```bash
node packages/browser/scripts/measure-stub.mjs
```

## 3. 多实例（C01-F5）

```ts
import { createClient } from '@web-report-sdk/browser';

const main = createClient({ appId: 'main-app' });
const sub = createClient({ appId: 'sub-app' });   // 微前端子应用
main.init({ appId: 'main-app' });
sub.init({ appId: 'sub-app' });
```

每个实例拥有独立的内核、命令队列、计数器与状态（应用标识、用户、上下文、同意状态、页面标识），
销毁一个实例不影响另一个。

页面上共享一份全局注册表时，同一原生事件（目标 + 事件 + capture）**只安装一次**监听，
所有实例的订阅者都收到事件；**计数器仍各实例独立**（两个 `app_id` 的计数不会串）：

```ts
import { createClient, createCounters, createGlobalRegistry } from '@web-report-sdk/browser';

const registry = createGlobalRegistry({ counters: createCounters(), target: window });
const main = createClient({ appId: 'main-app', registry, target: window });
const sub = createClient({ appId: 'sub-app', registry, target: window });
```

不传 `registry` 时每个实例各自一份，实例间互不影响。

## 4. 调试输出

调试输出是可注入的 sink，**缺省静默**（C08-AC-09：不因 URL 参数自动开启调试）：

```ts
createClient();                                  // 缺省：静默
createClient({ debug: true });                   // 默认 console sink，输出「原因码 + 事件去向」，不含令牌
createClient({ debug: (record) => panel.push(record) });   // 自定义面板
```

默认实现是本仓库唯一允许使用 `console` 的模块（`@web-report-sdk/core` 的 `console-sink.ts`）。

## 5. 版本与状态

- 当前版本：`0.0.0`（私有工作区包，首次发布前由人改为非 private）。
- 公共 API 与 `.d.ts`：`pnpm build` 产出 `dist/index.js`、`dist/index.d.ts` 与
  `dist/web-report-sdk.iife.js`（全局变量 `WebReportSDK`）。
- API 报告：`packages/browser/etc/browser.api.md`（首次登记需前端负责人确认后运行 `pnpm api:update`）。
