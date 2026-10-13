# 远程配置 I-02

- 版本：0.2（已冻结，2026-10-10；批准见 `README.md`“冻结记录”）
- 对应任务：T07；需求：C03-F1 至 C03-F6、C04-F4、C04-F5、K02-F1 至 K02-F6
- 提供方：接入方用 K02 生成签名发布物，自行托管到静态资源服务（D001）；调用方：C03。M01 可以托管测试发布物（M01-F5）

## 1. 寻址与拉取

| 项 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `{config_endpoint}/v1/config/{app_id}/{env}.json`，静态发布物 |
| 端点来源 | 初始化参数 `config_endpoint`；SDK 不得内置默认域名；不传时不拉取，直接使用内置默认值 |
| 条件请求 | SDK 带上次响应的 `ETag`，放在 `If-None-Match` 中；未变化时返回 304 |
| 缓存 | 建议托管方设置 `Cache-Control: max-age=300`；SDK 本地缓存最多 24 小时，超过后视为过期 |
| 拉取时机 | 初始化后异步拉取，不阻塞初始化；之后每 5 分钟、页面重新可见时各拉取一次，两次拉取间隔至少 60 秒 |

托管方按建议缓存时间设置时，配置变更 P95 在 10 分钟内生效（缓存 5 分钟加拉取周期 5 分钟），这是 C03 性能指标的来源。托管方缓存时间更长时，生效时间相应变长，不属于 SDK 缺陷。

## 2. 生效配置的合并顺序（C03-F1）

优先级从低到高：

1. SDK 内置默认值；
2. 远程配置（通过签名校验的最新版本）；
3. 初始化参数中的运行时覆盖，只允许覆盖 `transport`、`debug` 这两组字段，以及在 `plugins` 中关闭插件（不能开启远程配置中已关闭的插件）。

kill switch、采样规则、脱敏规则不能被运行时覆盖。`consent_mode` 单独按 2.1 合并。

### 2.1 `consent_mode` 的来源（Q5、D002）

| 取值 | 初始化参数 | 远程配置 |
|---|---|---|
| `essential_only` | 可以 | 可以 |
| `buffer` | 可以 | 可以 |
| `full` | 可以 | **不可以** |

- 生效值 = 远程配置中的值；远程配置没有设置时取初始化参数；都没有时为 `essential_only`。
- 远程配置中出现 `full`（或任何不认识的取值）时，SDK 忽略该字段，按“远程配置没有设置”处理，计数 `config_consent_mode_rejected`；配置的其他部分照常生效。
- 因此远程配置只能把 `full` 收紧为 `buffer` 或 `essential_only`，不能放宽到 `full`。

## 3. 失败与降级（C03-F2）

| 情况 | 行为 | 原因码 | 验收用例 |
|---|---|---|---|
| 网络失败、5xx，有未过期缓存 | 优先**保持当前生效配置**；仅在没有任何可用配置时才采用该缓存 | `config_fetch_failed` | C03-AC-05 |
| 网络失败、5xx，没有缓存 | 拒绝本次配置：**有当前生效配置则保持，无则使用保守默认** | `config_fetch_failed` | C03-AC-06 |
| 签名校验失败、`key_id` 不在公钥列表中 | 拒绝本次配置，继续使用当前生效配置；没有可用配置时使用保守默认 | `config_signature_invalid` | C03-AC-07、C03-AC-16 |
| `config_version` 不大于当前生效版本 | 拒绝本次配置，保持当前配置 | `config_version_stale` | C03-AC-08 |
| `app_id`、`env` 与请求路径不一致 | 同签名校验失败 | `config_scope_mismatch` | C03-AC-17 |
| `format_version` 主版本不认识 | 同签名校验失败 | `config_format_unsupported` | C03-AC-09 |
| 发布物或正文不是合法 JSON | 同签名校验失败 | `config_parse_failed` | C03-AC-18 |
| 本地缓存超过 24 小时 | 视为没有缓存 | `config_cache_expired` | C03-AC-19 |
| 运行环境不支持 WebCrypto | **唯一例外**：不校验签名，**即使存在缓存或当前生效配置也只使用保守默认** | `config_signature_unavailable` | C03-AC-20 |

**生效配置语义的通则（2026-10-13 经 CR-004 明确）**：除上表最后一行（WebCrypto 不可用）这一**唯一例外**外，本表所有「拒绝本次配置」的行统一遵循——**有当前生效配置时保持该配置不变；只有没有任何可用配置时才使用保守默认**。

明确这一点的原因：若把「有当前配置也退回保守默认」当作字面实现，则**推送一份非法配置、或制造一次网络抖动，就能把 SDK 打回最保守模式、停掉上报**（对数据管道构成拒绝服务）。保守默认只在"本来就没有任何可用配置"时作为起点使用。

**保守默认**：只保留 critical 事件和 JS 错误采集，采样率 1，其他插件关闭，`consent_mode` 取初始化参数的值，没有时为 `essential_only`。

## 4. 签名

- 发布物结构：`{ "format_version": 1, "key_id": "...", "alg": "ES256", "payload": "<字符串>", "signature": "<base64url>" }`。
- `payload` 是配置正文序列化后的 JSON 字符串。签名覆盖 `payload` 字符串的 UTF-8 字节，不需要规范化 JSON。
- 算法：ECDSA P-256 + SHA-256。签名为 IEEE P1363 格式（r‖s，64 字节，与 WebCrypto 输出一致），再做 base64url 编码（无填充，86 字符）。
- 公钥通过初始化参数 `config_public_keys` 传入（R-002），格式为 `{ [key_id]: JWK }`，JWK 只含 `kty`、`crv`、`x`、`y`；SDK 不内置公钥。
- 轮换：先发布带新公钥的接入方页面（新旧公钥并存），再切换签名私钥；旧公钥至少保留 30 天。
- 私钥由接入方保管，K02 支持从本地文件（仅测试）或外部签名命令（接入方的 KMS）取得签名（K02-F6）。K02 不得读取、打印或提交私钥内容。
- 配置中不得包含任何密钥或令牌。K02 保存前检查疑似令牌的字符串（K02-AC-07）。

### 4.1 测试密钥与参考步骤

测试密钥在测试运行时生成，不提交到仓库。Node.js 20+ 参考步骤：

```js
import { generateKeyPairSync, sign, verify } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const payload = JSON.stringify(body); // body 为配置正文
const signature = sign('sha256', Buffer.from(payload, 'utf8'), {
  key: privateKey,
  dsaEncoding: 'ieee-p1363', // 64 字节 r‖s，与 WebCrypto 一致
}).toString('base64url');
const envelope = { format_version: 1, key_id: 'test-key', alg: 'ES256', payload, signature };
const jwk = publicKey.export({ format: 'jwk' }); // 传给 config_public_keys

// 自检：篡改 payload 任意一个字节后必须返回 false
verify('sha256', Buffer.from(payload, 'utf8'), { key: publicKey, dsaEncoding: 'ieee-p1363' },
  Buffer.from(signature, 'base64url'));
```

浏览器侧用 `crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])` 导入，再用 `crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, utf8(payload))` 验签。

## 5. 配置正文

完整定义见 `schemas/remote-config.schema.json`。SDK 必须忽略不认识的字段。

| 字段 | 说明 | 需求 |
|---|---|---|
| `app_id`、`env` | 必须与请求路径一致，不一致时拒绝 | C03-F2、K02-F1 |
| `config_version` | 单调递增的整数；SDK 只接受比当前生效版本更大的配置，防止旧发布物被回放；K02 检查递增 | C03-F2、K02-F2 |
| `published_at` | 发布时间 | K02-F3 |
| `kill_switch` | 全局开关、按 SDK 版本范围关闭、按插件关闭 | C03-F5 |
| `sampling` | 会话级采样率、白名单用户、事件级规则 | C03-F3、C03-F4 |
| `plugins` | 各插件的开关与参数 | C05-F6 |
| `privacy` | URL 参数白名单、追加的敏感请求头、追加的脱敏规则、`consent_mode`（不能为 `full`，见 2.1） | C04-F4、C04-F5 |
| `endpoints` | 上报端点覆盖 | C07 |
| `transport` | 批次与冲刷参数覆盖 | C06-F2 |
| `overrides` | 灰度规则，按 SDK 版本或会话分桶，对上述字段打补丁 | C03-F3 |

### 5.1 kill switch 语义

- `kill_switch.all: true`：SDK 进入“已销毁”状态，释放所有监听。同一页面生命周期内不恢复。
- `kill_switch.sdk_versions`：semver 范围列表（如 `>=2.3.0 <2.3.2`），命中时等同于 `all: true`。
- `kill_switch.plugins`：命中的插件立即卸载，并恢复它安装的 hook。
- kill switch 生效后丢弃的事件计数 `killed`。

**`sdk_versions` 支持的 semver 语法子集（2026-10-13 经 CR-003 明确；SDK 为零依赖实现，必须按此边界判断）**

| 形式 | 示例 | 含义 |
|---|---|---|
| 精确版本 | `2.3.1` | 等于 `2.3.1` |
| 比较符 | `>2.3.1`、`>=2.3.1`、`<2.3.1`、`<=2.3.1` | 按 semver 优先级比较 |
| 合取（空格分隔） | `>=2.3.0 <2.3.2` | 全部满足 |
| 析取 | `^1.0.0 \|\| >=2.0.0` | 任一满足 |
| 脱字符 `^` | `^1.2.3`（等价 `>=1.2.3 <2.0.0`）；`^0.2.3`（等价 `>=0.2.3 <0.3.0`） | 允许次版本/补丁升级 |
| 波浪号 `~` | `~1.2.3`（等价 `>=1.2.3 <1.3.0`） | 只允许补丁升级 |
| 通配 | `1.2.x`、`1.x`、`*` | 缺省位不限 |

**版本字符串**：`major.minor.patch`，可选 `-prerelease`（按 semver §11 优先级比较，预发布版本低于同号正式版）；`+build` 元数据被忽略。

**明确不支持**（出现即在整份配置上计 `config_schema_invalid`、拒绝该配置并退回保守默认——**不得静默忽略**，否则一条无法求值的 kill switch 规则会被当作"不命中"）：连字符区间（`1.2.3 - 2.0.0`）、范围表达式中的预发布标识（`>=1.2.3-beta.1`）、以及上表未列出的任何语法。本节同样适用于 `overrides[].sdk_versions`。

### 5.2 采样语义

- 会话级：`sampling.session_rate` 取值 0–1。会话随机数在会话开始时生成并持久化（同意前只存内存），`random < session_rate` 时命中。未命中的会话拆除采集监听（C03-F6），只保留 critical 事件的上报能力。
- 白名单：`sampling.allow_users` 中的 `user_id`（或其哈希值）始终全量采集。
- 事件级：`sampling.rules` 按顺序匹配，第一条命中的规则生效；`rate: 0` 表示禁用该事件。
- critical 事件不受任何采样影响。
- 事件最终的 `sample_rate` 等于会话采样率乘以命中规则的采样率。

### 5.3 灰度（overrides）

`overrides` 按顺序应用，每条包含匹配条件（`sdk_versions` 范围和/或 `session_bucket` 区间 [from, to)，取值 0–100，用会话随机数乘以 100 计算）和一个 `patch` 对象。`patch` 只能修改 `sampling`、`plugins`、`transport`，不能修改 `kill_switch` 和 `privacy`。

### 5.4 内置敏感请求头与脱敏规则（C04-F4）

远程配置只能追加，不能删除或关闭以下内置项（C04-AC-09）。

内置敏感请求头（不区分大小写，HTTP 插件不采集其值）：`authorization`、`proxy-authorization`、`cookie`、`set-cookie`、`x-write-token`、`x-api-key`、`x-auth-token`、`x-csrf-token`、`x-xsrf-token`。

内置 URL 查询参数处理：不在 `url_query_allowlist` 中的参数一律删除；白名单为空时删除全部查询参数。

内置脱敏规则（作用于维度值、`message`、`attachment`、URL 路径）：

| 名称 | 匹配内容 | 替换为 |
|---|---|---|
| `email` | 电子邮箱 | `***@***` |
| `cn_mobile` | 中国大陆手机号（11 位，1 开头） | `1**********` |
| `cn_id_card` | 18 位身份证号（末位可为 X） | `******************` |
| `bank_card` | 13–19 位连续数字 | `****` |
| `jwt` | `eyJ` 开头的三段 base64url | `***` |
| `bearer_token` | `Bearer` 后的令牌 | `Bearer ***` |
| `ipv4` | IPv4 地址 | `0.0.0.0` |

内置规则合计 7 条，加上 `extra_mask_rules` 最多 40 条，总数不超过 50 条（C04 性能指标）。正则的具体写法由 T14 实现，用例见 C04-AC-07。

## 6. 示例

见 `examples/remote-config.valid.json`（发布物与解码后的正文）和 `examples/remote-config.invalid.json`。签名正确与篡改的样例由 T10 用 4.1 的步骤现场生成。

## 7. 已关闭的评审问题

| 问题 | 结论 |
|---|---|
| `consent_mode` 的取值 | 三种取值保留；`full` 只能在初始化参数中设置（D002），见 2.1 |
| 公钥由接入方传入还是打包进 SDK | 由接入方在初始化参数中传入，见 R-002 |
| 运行时覆盖是否允许开启插件 | 不允许，只能关闭。开启插件属于采集范围变化，统一走签名配置 |

## 8. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1 | 2026-10-09 | 草案 |
| 0.2 | 2026-10-10 | 按 D001 去掉 S02/CDN/KMS 表述；`consent_mode` 来源规则（D002）；降级表补原因码与用例；补测试密钥步骤、内置敏感请求头和脱敏规则；冻结 |
