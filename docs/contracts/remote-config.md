# 远程配置 I-02

- 版本：0.1（草案，未冻结）
- 对应任务：T07；需求：C03-F1 至 C03-F6、C04-F4、C04-F5、S02-F1 至 S02-F5
- 提供方：S02 配置中心（经 CDN 分发）；调用方：C03

## 1. 寻址与拉取

| 项 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/v1/config/{app_id}/{env}.json`，由 CDN 托管的静态发布物 |
| 端点来源 | 初始化参数 `config_endpoint`；SDK 不得内置默认域名 |
| 条件请求 | SDK 带上次响应的 `ETag`，放在 `If-None-Match` 中；未变化时返回 304 |
| 缓存 | 发布物 `Cache-Control: max-age=300`；SDK 本地缓存最多 24 小时，超过后视为过期 |
| 拉取时机 | 初始化后异步拉取，不阻塞初始化；之后每 5 分钟、页面重新可见时各拉取一次，两次拉取间隔至少 60 秒 |

配置变更 P95 在 10 分钟内生效（CDN 缓存 5 分钟加拉取周期 5 分钟），这是 C03 性能指标的来源。

## 2. 生效配置的合并顺序（C03-F1）

优先级从低到高：

1. SDK 内置默认值；
2. 远程配置（通过签名校验的最新版本）；
3. 初始化参数中的运行时覆盖，只允许覆盖 `transport`、`debug` 这两组字段，以及在 `plugins` 中关闭插件（不能开启远程配置中已关闭的插件）。

kill switch、采样规则、脱敏规则不能被运行时覆盖。

## 3. 失败与降级（C03-F2）

| 情况 | 行为 | 原因码 |
|---|---|---|
| 网络失败、5xx | 使用本地缓存；没有缓存时使用保守默认 | `config_fetch_failed` |
| 签名校验失败 | 拒绝本次配置，继续使用当前生效配置；没有可用配置时使用保守默认 | `config_signature_invalid` |
| `format_version` 主版本不认识 | 同上 | `config_format_unsupported` |
| 本地缓存超过 24 小时 | 视为没有缓存 | `config_cache_expired` |
| 运行环境不支持 WebCrypto | 不校验签名，只接受保守默认中允许的配置项 | `config_signature_unavailable` |

**保守默认**：只保留 critical 事件和 JS 错误采集，采样率 1，其他插件关闭，`consent_mode` 为 `essential_only`。

## 4. 签名

- 发布物结构：`{ "format_version": 1, "key_id": "...", "alg": "ES256", "payload": "<字符串>", "signature": "<base64url>" }`。
- `payload` 是配置正文序列化后的 JSON 字符串。签名覆盖 `payload` 字符串的 UTF-8 字节，不需要规范化 JSON。
- 算法：ECDSA P-256 + SHA-256。签名为 IEEE P1363 格式（r‖s，64 字节，与 WebCrypto 输出一致），再做 base64url 编码。
- 公钥通过初始化参数 `config_public_keys` 传入，按 `key_id` 查找；SDK 不内置公钥。轮换时先发布带新公钥的 SDK 初始化配置，再切换签名私钥，旧公钥至少保留 30 天。
- 私钥保存在 KMS，只有 S02 的发布流程可以使用（S02 安全要求）。
- 配置中不得包含任何密钥或令牌。

## 5. 配置正文

完整定义见 `schemas/remote-config.schema.json`。

| 字段 | 说明 | 需求 |
|---|---|---|
| `app_id`、`env` | 必须与请求路径一致，不一致时拒绝 | S02-F1 |
| `config_version` | 单调递增的整数；SDK 只接受比当前生效版本更大的配置，防止旧发布物被回放 | S02-F2 |
| `published_at` | 发布时间 | S02-F2 |
| `kill_switch` | 全局开关、按 SDK 版本范围关闭、按插件关闭 | C03-F5 |
| `sampling` | 会话级采样率、白名单用户、事件级规则 | C03-F3、C03-F4 |
| `plugins` | 各插件的开关与参数 | C05-F6 |
| `privacy` | URL 参数白名单、敏感请求头、追加的脱敏规则、`consent_mode` | C04-F4、C04-F5 |
| `endpoints` | 上报端点覆盖 | C07 |
| `transport` | 批次与冲刷参数覆盖 | C06-F2 |
| `overrides` | 灰度规则，按 SDK 版本或会话分桶，对上述字段打补丁 | S02-F3 |

### 5.1 kill switch 语义

- `kill_switch.all: true`：SDK 进入“已销毁”状态，释放所有监听。同一页面生命周期内不恢复。
- `kill_switch.sdk_versions`：semver 范围列表（如 `>=2.3.0 <2.3.2`），命中时等同于 `all: true`。
- `kill_switch.plugins`：命中的插件立即卸载，并恢复它安装的 hook。

### 5.2 采样语义

- 会话级：`sampling.session_rate` 取值 0–1。会话随机数在会话开始时生成并持久化（同意前只存内存），`random < session_rate` 时命中。未命中的会话拆除采集监听（C03-F6），只保留 critical 事件的上报能力。
- 白名单：`sampling.allow_users` 中的 `user_id`（或其哈希值）始终全量采集。
- 事件级：`sampling.rules` 按顺序匹配，第一条命中的规则生效；`rate: 0` 表示禁用该事件。
- critical 事件不受任何采样影响。
- 事件最终的 `sample_rate` 等于会话采样率乘以命中规则的采样率。

### 5.3 灰度（overrides）

`overrides` 按顺序应用，每条包含匹配条件（`sdk_versions` 范围和/或 `session_bucket` 区间 [from, to)，取值 0–100，用会话随机数乘以 100 计算）和一个 `patch` 对象。`patch` 只能修改 `sampling`、`plugins`、`transport`，不能修改 `kill_switch` 和 `privacy`。

## 6. 示例

见 `examples/remote-config.valid.json`（发布物与解码后的正文）和 `examples/remote-config.invalid.json`。

## 7. 待评审问题

1. `consent_mode` 的取值依赖 Q5 的结论。
2. 公钥由接入方在初始化参数中传入，会增加接入步骤；备选方案是把公钥打包进 SDK，但这样轮换密钥就必须发布新版本 SDK。
3. 运行时覆盖是否需要允许开启插件。草案只允许关闭。
