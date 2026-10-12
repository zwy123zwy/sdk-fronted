# 公共 API 设计用例

- 状态：草案（A03 在 T18 开工前补全，由前端负责人确认后冻结）
- 用途：指南第 4.3 节。每个场景都必须能用公共 API 表达出来；表达不了时升级，不得临时加 API。

下文的 API 写法是**建议形态**，用来检验场景覆盖是否完整，不是最终签名。最终签名由 T12 在实施计划中提出，前端负责人确认后通过 `pnpm api:check` 登记。

## 建议的公共 API

| 方法 | 用途 | 对应需求 |
|---|---|---|
| `init(options)` | 初始化：应用标识、令牌、端点、配置端点与公钥、环境、版本、初始同意状态、插件 | C01-F1、C03-F1 |
| `track(name, { dimensions, metrics, attachment })` | 上报自定义事件 | C01-F1、C01-F4 |
| `log(level, message, { dimensions })` | 上报日志 | C01-F1 |
| `captureError(error, { dimensions })` | 手动上报错误 | C05-F1 |
| `setUser(id, { hashed })` / `clearUser()` | 设置与清除用户 | C04-F1 |
| `setContext(key, value)` / `removeContext(key)` | 全局自定义上下文 | C04-F3 |
| `setPage(pageId)` | 手动路由模式下设置页面 | C05-F3 |
| `setConsent(state)` | 设置同意状态 | C04-F5 |
| `flush()` | 立即冲刷 | C06-F2 |
| `destroy()` | 销毁 | C02-F1 |
| `createClient(options)` | 创建独立实例 | C01-F5 |

所有方法同步返回，从不抛错（C01-F1）。

## 场景

| 编号 | 场景 | API 表达 | 涉及需求 |
|---|---|---|---|
| UC-01 | 应用启动后自动采集错误、性能、页面浏览、HTTP，并按规则过滤 | `init` 时启用插件；过滤规则由远程配置 `sampling.rules` 与插件 `options` 下发 | C05-F1 至 F4、C03-F4 |
| UC-02 | 用户登录后设置用户，退出后清除；匿名阶段的事件不关联用户 | 登录回调中 `setUser`，退出时 `clearUser` | C04-F1 |
| UC-03 | 业务完成一个关键动作（如提交任务），要求可靠送达 | `track('task_submit_complete', ...)`；投递等级由字典声明为 critical | C07-F5、Q3 |
| UC-04 | 页面内高频的业务操作轨迹（每秒数十条），会话结束时也要尽量送达 | 每个动作 `track`；离开页面时由 SDK 自动冲刷，业务在提交按钮处可以调用 `flush` | C06-F2、C07-F1 |
| UC-05 | 媒体播放指标：开始播放、拖动、卡顿、首帧耗时 | 每类动作一个事件名，耗时放 `metrics`，例如 `track('video_play_stall', { metrics: { stall_ms } })` | C01-F1 |
| UC-06 | 接入方用 K02 签名一份调低采样率、关闭某个插件的配置并发布到自己的静态资源服务，10 分钟内生效 | 无需业务代码改动；远程配置下发 | C03-F3 至 F5 |
| UC-07 | 用户在隐私设置中拒绝“体验改进”，之后又同意 | 接入方的同意组件回调 `setConsent('denied')` / `setConsent('granted')` | C04-F5、Q5 |
| UC-08 | 迁移期与已有第三方 APM 并行运行，自定义事件双写 | `init` 时注册双写适配器，并注入第三方的上报函数 | C05-F5、Q7 |
| UC-09 | 单页应用使用自定义路由，路由库不触发 History 事件 | 关闭自动路由，在路由守卫中调用 `setPage` | C05-F3 |
| UC-10 | 微前端：主应用与子应用分别上报到不同应用 | 子应用用 `createClient` 创建独立实例 | C01-F5 |
| UC-11 | 静态页面没有构建流程，需要尽早捕获首屏错误 | 头部内联加载桩，之后通过命令队列调用 | C01-F2、C01-F3 |
| UC-12 | 开发者排查“为什么我的事件没上报” | 开发环境通过 URL 参数开启调试模式 | C08-F4 |

## 待补充（A03）

- 每个场景的完整调用示例（放到 `examples/` 中后在此链接）。
- 每个场景在 `tests/acceptance/` 中的对应用例编号。
- 无法表达的场景列表（如有），及升级记录。
