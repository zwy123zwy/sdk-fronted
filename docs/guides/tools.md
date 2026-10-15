# 工具指南（K01 / K02 / M01）

- 对应交付：T34（A14）；读者：接入方的 CI / 前端工程师、接收方工程师
- 事实来源：`tools/event-registry/README.md`、`tools/config-signer/README.md`、`tools/mock-receiver/README.md`（三者是各自工具的事实来源；本文只做面向使用者的整理与交叉引用）

## 0. 总览

| 工具 | 包名 / bin | 用途 | 只读还是写 | 验收状态 |
|---|---|---|---|---|
| **K01** 事件注册表与类型生成（T22） | `@web-report-sdk/event-registry` / `web-report-event-registry` | 校验接入方仓库的 `events/*.json`、检查 critical 配额与兼容性、生成 TypeScript 类型、导出接收方运行期校验规则、报告未登记事件 | 只读注册表，**不改接入方仓库、不访问网络** | 已验收（main `407f871`） |
| **K02** 配置签名 CLI（T25） | `@web-report-sdk/config-signer` / `web-report-config-signer` | 校验远程配置正文、生成签名发布物（自托管到静态资源服务）、发布前自检 | 生成发布物；**不读取/打印/提交私钥内容** | 已合入 main `f18355c`，评审中；`K02-AC-03` 浏览器侧验签**属部分实现** |
| **M01** 本地 mock 接收服务（T09） | `@web-report-sdk/mock-receiver` / `web-report-mock-receiver` | 本地联调、POC、集成与 E2E、可靠性对账 | 进程内内存态；**只监听 `127.0.0.1`，不得用于生产** | 已验收（main `e8e1486`） |

三个工具都属开发/测试用途，**都不是生产组件**。生产接收方必须满足 [接收方指南](receiver-guide.md)（`receiver-requirements.md`）；M01 与文档都不得作为生产接收方的参考实现对外提供（指南第 11 节）。

共同运行方式（未发布，按本地构建）：

```bash
# 在仓库根目录，逐个构建
pnpm --filter @web-report-sdk/event-registry run build
pnpm --filter @web-report-sdk/config-signer run build
pnpm --filter @web-report-sdk/mock-receiver run build

# 直接用构建产物
node tools/event-registry/dist/cli.js --help
node tools/config-signer/dist/cli.js --help
node tools/mock-receiver/dist/cli.js --help

# 或安装后调用 bin
pnpm exec web-report-event-registry --help
pnpm exec web-report-config-signer --help
pnpm exec web-report-mock-receiver --help
```

三个 CLI 的共同约定：失败时返回非零退出码并输出可读错误，可直接用在接入方 CI 里（指南第 11 节）。

---

## K01 事件注册表与类型生成

接入方在自己仓库的 `events/*.json` 中维护事件定义（元模型 `docs/contracts/schemas/event-definition.schema.json`，契约 0.2）。K01 只读它们；生成的类型文件由接入方自己提交或发布（契约不要求本项目发布类型包）。

### K01.1 子命令

| 子命令 | 作用 | 退出码 |
|---|---|---|
| `check` | 按契约 Schema 校验、critical 配额检查、可选兼容性对比 | 0 / 1 / 2 |
| `generate` | 生成 TypeScript 类型声明（只含 `active` 事件的最新版本） | 0 / 1 / 2 |
| `export-rules` | 导出接收方运行期校验规则 JSON（每个事件保留最近 3 个版本） | 0 / 1 / 2 |
| `report-unregistered` | 报告清单中未登记的事件及出现次数 | **始终 0**（除用法/文件错误） |

```bash
# 1) 校验 + critical 配额 + 兼容性
web-report-event-registry check --registry events/*.json

# 2) 生成类型（省略 --out 写到标准输出）
web-report-event-registry generate --registry events/*.json --out src/generated/events.ts

# 3) 导出接收方运行期校验规则
web-report-event-registry export-rules --registry events/*.json \
  --out dist/rules.json --registry-name demo-app --keep-versions 3

# 4) 未登记事件报告
web-report-event-registry report-unregistered --registry events/*.json --events observed-events.jsonl

# 5) CI 中对比 git 基线（破坏性变更默认拦截）
web-report-event-registry check --registry events/*.json --baseline-git origin/main
# 已获数据负责人批准时放行"已递增版本的破坏性变更"
web-report-event-registry check --registry events/*.json --baseline-git origin/main --allow-breaking
```

`check` 做四类判定：Schema 校验（错误含文件路径与 JSON 指针）、注册表级检查（同名同版本重复、metric 后缀与 `unit` 一致）、critical 配额（`critical` 事件名数 ≤ 事件名去重总数 × 10%，Q3 结论）、兼容性（提供基线时按 `dictionary-compat.md` 逐行判定并报出行号）。

### K01.2 选项

| 选项 | 适用命令 | 说明 |
|---|---|---|
| `--registry <路径>` | 全部 | 目录、glob（`events/*.json`）或单个文件；默认 `events/*.json` |
| `--cwd <目录>` | 全部 | 工作目录；`--registry`、`--baseline-dir` 与 git 仓库都相对它解析 |
| `--baseline-dir <目录>` | check | 兼容性基线：一份基线注册表快照目录 |
| `--baseline-git <引用>` | check | 兼容性基线：git 引用（`HEAD`、`main`、commit-ish）；只执行只读 git 命令 |
| `--allow-breaking` | check | 放行"已递增版本的破坏性变更"；**不放过**未递增版本（K01-AC-04/05） |
| `--schema <文件>` | check | 用自带的 JSON Schema 2020-12 文件替换内置元模型 |
| `--out <文件>` | generate、export-rules | 输出文件；省略则写到标准输出，自动创建父目录 |
| `--events <文件>` | report-unregistered | 事件名清单（JSON 数组 / JSONL / 每行一个事件名） |
| `--keep-versions <数量>` | export-rules | 保留版本数，1–10，默认 3 |
| `--registry-name <名称>` | export-rules、report-unregistered | 写入报告的注册表名称，默认 `workspace` |
| `--help` | 全部 | 用法 |

`--baseline-dir` 与 `--baseline-git` 互斥。

### K01.3 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功（含 `report-unregistered` 的报告结果、`check` 未发现问题） |
| `1` | 检查未通过：Schema 校验失败、同名同版本、critical 配额超限、兼容性破坏性变更、未递增 `schema_version` |
| `2` | 用法或运行环境错误：未知子命令/参数、缺参数、注册表/基线/清单不可读、`--baseline-git` 不在 git 仓库内 |

CI 里建议只判断"非 0 即失败"。

### K01.4 兼容性规则（摘要，判定表以契约为准）

按 `dictionary-compat.md`（冻结 0.2）逐行判定，**工具不自行放宽**：新增可选字段 / 必填改可选 / enum 增加取值 / 放宽上下界 / `sensitivity` 更严格 / `priority` 双向变更 → **兼容**；新增必填字段 / 删除字段 / 改 `type` 或 `kind` / 可选改必填 / enum 删除取值 / 收紧上下界 / 改 `unit` / `sensitivity` 更宽松 → **破坏性**；只改 `description`、`trigger`、`owner` → **不递增版本**。

版本规则：破坏性变更必须递增 `schema_version` 并由接入方数据负责人在代码评审中批准；**兼容变更也要递增 `schema_version`**；改了字段却没递增版本时，`--allow-breaking` 也不放行。

### K01.5 生成类型的接入方式

生成的 `.ts` **只含类型声明**，没有任何运行期值导出、表达式或副作用，可以被完全擦除（可自行 `grep -c "export const\|export function" generated/events.ts` 验证为 0）。形状与消费约定：

```ts
import type { EventDefinitions, EventName, EventEntry, EventPayload } from './generated/events.js';
import { createClient } from '@web-report-sdk/browser';

const client = createClient<EventDefinitions>({ appId: 'your-app-id' });
client.init({ appId: 'your-app-id' });

// 事件名是字面量联合：拼错、未登记、保留前缀（sdk_/web_）都会编译失败
client.track('checkout_order_complete', {
  dimensions: { order_type: 'normal', channel: 'wallet' },
  metrics: { amount_ratio: 1 },
});

type Entry = EventEntry<'checkout_order_complete'>;
type Priority = Entry['priority'];   // 'critical'（投递等级是字面量，调用时不能改，Q3）
type Version = Entry['schema_version'];
type Payload = EventPayload<'checkout_order_complete'>;
```

- `FieldSpec<TValue, TRequired>` 的 `required` 是**必需的字面量布尔**，可选性同时体现在属性位置的 `?` 上：`required: true` → 属性必需，`required: false` → 属性带 `?`。
- **消费侧投影必填/可选时用 TypeScript 标准的属性可选性探测，不要直接索引 `required`**：本项目与 C01 都开启 `noUncheckedIndexedAccess`，可选属性被索引后会带上 `| undefined`，`T[K]['required'] extends true` 会失真、负载类型被推成 `never`。工具生成的辅助类型（`RequiredFieldNames` / `OptionalFieldNames` / `PickRequired` / `PickOptional` / `EventPayload`）已处理 `NonNullable`。
- `sensitivity`、`unit`、`min/max`、`max_length` 不进入字典类型（它们是接收方脱敏与运行期校验用的），完整信息在 `export-rules` 的 JSON 里。
- `export-rules` 输出的规则文件自带 Schema（`schema_id = urn:web-report-sdk:k01:runtime-validation-rules:1`）；接收方可以用它做运行期校验（RR-22，"[可以]"级）。

### K01.6 示例工程（可直接跑）

`examples/event-registry/` 是最小可用注册表：12 个定义文件 / 10 个事件名 / 1 个 critical（10%，恰好等于 Q3 配额上限），全部占位值。命令见 `examples/event-registry/README.md`，本文第 0 节已给构建方式。验证记录见 `examples/event-registry/README.md` 与文末「本次验证记录」。

### K01.7 已知边界（不要当成已验证）

- `export-rules` 的规则文件格式**未进契约**（由工具自带 Schema 并自校验）；RR-22 是"可以"级且尚无接收方消费，建议等有接收方接入时再走兼容追加固化（`docs/reports/wave1-lanes.md` 第 6 节）。
- `--baseline-git` **未在真实多提交历史**（含 tag / 分支名 / 浅克隆）上验证：只用过临时 git 仓库 + `HEAD`；`snapshot.ts` 分支覆盖率 37.5%（git 失败等错误分支未构造用例）。
- 工具用 `Ajv2020({ strict: false })`，另以断言保证内嵌 Schema 去掉 `description` 后与契约文件深度相等（`docs/reports/wave1-lanes.md` D-8）。

---

## K02 配置签名与托管

接入方用 K02 校验远程配置正文、生成签名发布物，自行托管到静态资源服务（D001）。契约依据 `docs/contracts/remote-config.md` 0.2 第 4 节与 `schemas/remote-config.schema.json`。

### K02.1 快速开始

```bash
# 1. 生成测试密钥对（只用于测试；私钥权限 0600，切勿提交）
web-report-config-signer keygen \
  --out-private ./tmp/test-key.pem --out-public ./tmp/public-keys.json \
  --key-id test-key-2026a

# 2. 校验配置正文（含 config_version 递增检查与疑似令牌扫描）
web-report-config-signer validate --body ./config.json --previous ./published/remote-config.json

# 3. 签名，产出发布物
web-report-config-signer sign \
  --body ./config.json \
  --private-key ./tmp/test-key.pem \
  --key-id test-key-2026a \
  --public-key ./tmp/public-keys.json \
  --out ./remote-config.json

# 4. 发布前自检
web-report-config-signer verify --envelope ./remote-config.json --public-key ./tmp/public-keys.json
```

**生产环境不要用 `--private-key`**，用 `--sign-command` 接入接入方自己的 KMS：

```bash
web-report-config-signer sign \
  --body ./config.json \
  --sign-command /opt/kms/sign-p256 \
  --key-id prod-key-2026a \
  --public-key ./public-keys.json \
  --out ./remote-config.json
```

外部签名命令的约定（`tools/config-signer/README.md`）：K02 把 `payload` 的 UTF-8 字节经 **stdin** 传给该命令（不走命令行参数，避免出现在进程列表）；该命令只在 **stdout** 输出 64 字节裸签名的 base64url（86 字符，IEEE P1363 的 r‖s）；K02 用 `--public-key` 对签名做一次自检，不匹配时返回非零退出码；**K02 进程完全不接触私钥**（既不读私钥文件，也不解析或缓存私钥材料）。

### K02.2 子命令与选项

| 子命令 | 作用 | 主要选项 |
|---|---|---|
| `validate` | 按 Schema 校验正文、检查 `config_version` 递增、扫描疑似令牌 | `--body`、`--previous`、`--allow-token-path` |
| `sign` | 先校验再签名，输出 `{format_version,key_id,alg,payload,signature}` 发布物 | `--body`、`--private-key` 或 `--sign-command`、`--key-id`、`--public-key`、`--previous`、`--out` |
| `verify` | 校验发布物结构、签名与正文 Schema，用于发布前自检 | `--envelope`（等价 `--body`）、`--public-key`、`--previous`、`--no-body-schema` |
| `keygen` | 生成测试密钥对（只用于测试） | `--out-private`、`--out-public`、`--key-id`、`--force` |

`--body` / `--envelope` 支持 `-` 表示从 stdin 读取；`--body` 也接受契约样例的 `{ "decoded_payload": {...} }` 与 `{ "cases": [...] }` 两种包装。

### K02.3 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 检查未通过：Schema 校验失败、`config_version` 未递增、疑似令牌、验签失败 |
| 2 | 用法或运行环境错误：未知子命令、缺参数、文件不可读、密钥不可解析 |

失败信息一律写到 stderr，逐行给出「问题码 + 字段路径 + 说明」。

### K02.4 `config_version` 递增（K02-F2）

`--previous <文件>` 接受 K02 发布物（envelope，取 `payload` 里的值）或配置正文。新正文的 `config_version` 必须**严格大于**上一份；相等会被 SDK 判为 `config_version_stale`（`remote-config.md` 第 3 节），更小还会导致旧发布物回放，两者都返回退出码 1。不传 `--previous` 时跳过该检查，并在 stdout 明确打印"已跳过"。

### K02.5 `consent_mode: full`（D002）

远程配置**不接受** `full`：它只能写在接入方页面代码的初始化参数里（见[接入指南 · 同意管理](integration.md#6-同意管理合规提示务必读完)）。正文中出现 `privacy.consent_mode: "full"` 时，K02 返回退出码 1，并提示 D002 与"只能收紧为 `buffer` 或 `essential_only`"。`remote-config.schema.json` 的 `privacy.consent_mode` 已去掉 `full`，所以 K02 校验时自然拒绝。

### K02.6 疑似令牌扫描（K02-AC-07）

递归扫描正文的所有字符串值与键名，命中以下形态即返回退出码 1：`pem_header`（PEM 私钥/证书头）、`jwt`（`eyJ` 开头的三段 base64url）、`hex_secret`（32 位以上连续十六进制）、`base64_secret`（解码后 ≥ 32 字节）、`bearer_literal`、`provider_prefix`（`AKIA`/`ASIA`/`ghp_`/`github_pat_`/`xox[baprs]-`/`sk-`）。

- 报告只给**字段路径、模式名、长度与值的 SHA-256 前 6 位（不可逆）**，不回显原串。
- 自动放行的只有三类良性形态：连字符 UUID、纯十进制数字串、`sha256-<64hex>` 摘要。
- **32 位及以上纯十六进制串一律拦截**（含 UUID 的 32 位紧凑写法、40 位 git SHA-1、64 位摘要）：安全工具的失败方向应是"要求人工确认"，而不是"静默放行"。确需放行时用 `--allow-token-path /plugins/error/options/commit`；该参数默认空，每次放行都会在 stdout 打印一行留痕；**没有**全局关闭扫描的开关。

### K02.7 密钥处理（K02-AC-08）

- `keygen` 生成的私钥以 PKCS#8 PEM 写入，权限 **0600**（`open(..., 'wx', 0o600)` + `fchmod`），已存在时默认拒绝覆盖（`--force` 才覆盖）；命令行输出只含路径、权限与提示，不含密钥内容。
- 测试密钥在测试运行时生成，只落操作系统临时目录，不提交到仓库。
- 私钥来源只有 `--private-key <文件>`（仅测试）与 `--sign-command`（KMS）两种；K02 **不支持**从命令行明文、stdin 或环境变量读私钥（会留在 shell 历史与进程环境里）。
- 所有问题经统一渲染，`Problem` 类型不含原始取值。

### K02.8 与 SDK 的对接（给接入方与接收方）

- **配置消费方（C03）**：发布物字段与 `remote-config.md` 第 4 节一致；公钥用 `keygen --out-public` 产出的 `{ [key_id]: JWK }` 传给配置运行时（R-002）。当前**尚未接到公共 API**（见[接入指南 5.3 节](integration.md#53-远程配置参数尚未接到公共-api)）。
- **托管**：静态发布物路径为 `{config_endpoint}/v1/config/{app_id}/{env}.json`，建议 `Cache-Control: max-age=300`；SDK 带 `ETag` 做条件请求，本地缓存最多 24 小时（`remote-config.md` 第 1 节）。本地联调可用 M01 的配置托管（`GET /v1/config/{app_id}/{env}.json`）。
- **轮换**：先发布带新公钥的接入方页面（新旧公钥并存），再切换签名私钥；旧公钥至少保留 30 天（`remote-config.md` 第 4 节）。

### K02.9 已知边界（**必读**）

- **`K02-AC-03` 的浏览器侧验签（Playwright Chromium）属部分实现。** 单测用 Node 24 的全局 `crypto.subtle`（与 Chromium 的 WebCrypto 走同一条 W3C ECDSA P-256 + SHA-256 路径）验证发布物；**AC-03 点名的"Playwright Chromium"验签尚未执行**，已移交 T29 的 E2E，**这一条不算通过**。
- 未做系统调用级追踪（macOS 上 strace/dtrace 不可移植），改用"代码结构 + 行为 + 材料指纹"三层证据替代（`tools/config-signer/README.md`「未完全覆盖的验收条目」）。

---

## M01 本地联调

> **只用于本地测试，不得用于生产。** 它只监听 `127.0.0.1`，不实现真实鉴权（令牌只做固定占位值比对），不提供 TLS，数据只存在内存里。生产接收方必须满足 `receiver-requirements.md`；本文与 M01 代码都不得作为生产接收方的参考实现对外提供（指南第 11 节）。

M01 实现 `receiver-requirements.md` 的**全部"必须"条目**，覆盖 M01-AC-01 至 M01-AC-15（63 个测试）。它可以作为接收方自查时的**行为参照**（不是参考实现）。

### M01.1 启动

```bash
pnpm --filter @web-report-sdk/mock-receiver run build   # 产出 dist/cli.js
node tools/mock-receiver/dist/cli.js                    # 默认 127.0.0.1:8787
pnpm exec web-report-mock-receiver --port 8899          # 安装后直接调用 bin
```

| 选项 | 说明 |
|---|---|
| `--port <端口>` | 监听端口；`0` 表示自动分配空闲端口（默认 `8787`） |
| `--host <地址>` | **只允许 `127.0.0.1`**；其他取值启动失败并返回退出码 1（M01-AC-15） |
| `--config-file <文件>` | 启动时托管的 I-02 配置发布物（默认读 `docs/contracts/examples/remote-config.valid.json`） |
| `--storage-fail` | 启动即注入"存储失败"（等价于 `POST /__mock/injection {"storageFail":true}`） |
| `--help` | 打印用法 |

### M01.2 编程式 API

```ts
import { startReceiver, type MockReceiver } from '@web-report-sdk/mock-receiver';

const receiver: MockReceiver = await startReceiver({ port: 0 }); // port 省略时默认 8787
const baseUrl = `http://127.0.0.1:${receiver.port}`;
// ... 发请求、断言 ...
await receiver.stop();          // 释放端口；可重复调用
```

`startReceiver(options)` 的选项：`port`（默认 `8787`，`0` 自动分配）、`host`（默认 `127.0.0.1`，其他取值 reject `ReceiverStartError`）、`writeToken`（默认是一个内置的固定占位值，只做比对；具体取值见 `tools/mock-receiver/README.md` 第 2 节）、`isTokenRevoked`（外部吊销判断，与内置集合取并集）、`storageFail`、`configFile`、`logger`。

返回的 `MockReceiver` 成员：`port` / `host` / `listening`；`counters.snapshot()` / `counters.clear()`；`events.list(appId?)` / `events.size(appId?)` / `events.clear()`（不含 `auth`，RR-13）；`logs.entries()` / `logs.text()` / `logs.clear()`；`injection.setSequence()` / `setRatio()` / `setStorageFail()` / `clear()` / `config()`；`config.publish()` / `get()` / `list()`；`inspect.lastDecompressedBytes` / `inspect.writeToken` / `inspect.boundAt`；`revokeToken(token?)`；`stop()`。Playwright 与 Vitest 都可以在 `beforeAll` / `afterAll` 中直接调用，不需要额外进程。

### M01.3 HTTP 接口

所有响应都带 `X-Server-Time`（UTC 毫秒）与 `X-Request-Id`（回显或生成）；429 / 503 带整数 `Retry-After`；所有响应带 CORS 允许来源（回显 `Origin`，缺省 `*`）与 `Access-Control-Expose-Headers: Retry-After, X-Server-Time, X-Request-Id`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/batch` | 常规通道：`Content-Type: application/json` + `X-App-Id` + `X-Write-Token` |
| `POST` | `/v1/batch` | 信标通道：`Content-Type: text/plain;charset=UTF-8`，令牌在请求体 `auth.write_token`；请求头令牌被忽略 |
| `OPTIONS` | 任意 | CORS 预检 |

响应码与 `error`（`ingest-protocol.md` 3.1、`reason-codes.md` 第 3 节）：`202`（已写入内存存储，响应体为空）；`400` + `invalid_json` / `invalid_structure` / `unsupported_protocol` / `unsupported_encoding` / `app_id_mismatch`；`401` + `invalid_token` / `token_revoked`；`413` + `payload_too_large` / `too_many_events`；`405` + `method_not_allowed`。单条事件序列化后 > 16 KB 时**只丢弃该条**，其余正常入库，批次仍返回 `202`，丢弃计入 `rejected_event_too_large`。

**故障注入**：

| 方法 | 路径 | 请求体 |
|---|---|---|
| `POST` | `/__mock/injection` | `{"sequence":["429","503","413","401","timeout","reset","none"]}` |
| `POST` | `/__mock/injection` | `{"mode":"ratio","kind":"503","rate":0.3}` |
| `POST` | `/__mock/injection` | `{"storageFail":true}` |
| `POST` | `/__mock/injection` | `{"clear":true}` |
| `GET` | `/__mock/injection` | 返回当前注入配置 |

按比例的默认随机源是**固定种子**的，同一配置下 1,000 次采样的占比可复现；`storageFail` 开启后所有合法批次返回 `503 storage_unavailable`，**从不返回 2xx**，`stored_events` 不增加（RR-02）。

**计数与查询**：`GET /__mock/counters`（别名 `/__mock/stats`）、`POST|DELETE /__mock/counters/reset`、`GET|DELETE /__mock/events`、`GET /__mock/logs`、`POST /__mock/logs/reset`、`POST /__mock/revoke`、`GET /__mock/health`。

计数快照字段：`received_batches` / `received_events`（已解析并进入处理的）、`stored_batches` / `stored_events`（实际入库的）、`duplicate_events`、`rejected_event_too_large`、`rejected_<error>`（按 3.1 的 `error` 分类，9 类每类恒有字段）、`failed_storage`、`injected_<kind>`。**对账恒等式：`received_events - stored_events === duplicate_events`**（M01-AC-06）。

**配置托管**：`GET /v1/config/{app_id}/{env}.json` 返回 I-02 发布物（带 `ETag` 与 `Cache-Control: max-age=300`）；带 `If-None-Match` 且内容未变时返回 `304`；`POST /__mock/config` 替换发布物。签名是占位值，**不做验签**（验签由 C03 负责）。

### M01.4 去重、字段提升与脱敏

- 去重键为 `app_id` + `event_id`，在进程生命周期内有效（mock 不做 7 天窗口与持久化）。
- `common` 在入库前展开到每条事件：对象字段（如 `context`）按字段合并、事件体中的同名字段优先，标量字段由事件体覆盖；还原后与未提升写法逐字段一致（RR-06）。
- 事件体与批次中的 `auth`、`write_token` 在入库前删除；`sdk_health` 与业务事件一样入库计数（RR-23）。
- 日志脱敏：令牌占位值、`auth` / `write_token` / `token` 字段值、`wt_` / `sk_` / `pk_` 前缀串替换为 `[redacted]`；手机号替换为 `[redacted-phone]`；IPv4 去掉末段、IPv6 只保留前 48 位（前 6 组）（RR-13）。

### M01.5 已知限制（**不得忽略**）

- **不得用于生产**：无 TLS、只监听回环地址、令牌是固定占位值、无真实鉴权与限流。
- 数据只在内存中，进程退出即丢失；不实现 7 天去重窗口、死信队列与持久化；"持久化后才返回 202"按"存储层接受后即 202"追认（RR-02 的 mock 解释）。
- RR-11（HTTPS）、RR-14（来源白名单）、RR-15（限流）**不在 M01 范围内**，接收方须自行实现与自查。
- 不做真实签名校验；`/__mock/*` 都没有鉴权，仅限本机测试使用。
- 吞吐规格线（30 秒 ≥500 批/秒）**不进单元门禁**：门禁内是"5 轮 × 1.2 秒中位数 ≥ 40 批/秒"的回归护栏，规格线由 T20 基准与 T32 对账行使（T20/T32 未就绪）。

---

## 本次验证记录（T34 执行 Agent 实跑，2026-10-13，本工作树）

在本工作树（`temp/wt-T34`）实跑的命令与结果：

| 命令 | 结果 |
|---|---|
| `pnpm examples:test`（**构建前**） | exit 1：`examples/script-tag` 报 `Cannot find module .../packages/browser/dist/web-report-sdk.iife.js`（`dist` 不存在） |
| `pnpm --filter @web-report-sdk/core run build` | exit 0（`dist/index.js` 96.61 KB、`dist/index.d.ts` 48.94 KB） |
| `pnpm --filter @web-report-sdk/browser run build` | exit 0（IIFE 20.59 KB、ESM 483 B） |
| `pnpm examples:build` | exit 0（vite 构建成功） |
| `pnpm examples:test` | exit 0（script-tag：`WebReportSDK.SDK_VERSION = 0.1.0`；node-import：Vitest 1 passed、Jest 1 passed） |
| `pnpm --filter @web-report-sdk/event-registry run build` | exit 0 |
| `node tools/event-registry/dist/cli.js check --registry examples/event-registry/events` | exit 0：`12 个事件定义文件，12 个事件`、`critical 配额：1/10（10.0%）`、兼容性未提供基线已跳过 |
| `node tools/event-registry/dist/cli.js generate --registry examples/event-registry/events` | exit 0（写 stdout；**未**写入 `examples/`，以免改动不在可写范围内的文件） |
| `node tools/event-registry/dist/cli.js export-rules --registry examples/event-registry/events --registry-name demo-app` | exit 0（写 stdout，`schema_id = urn:web-report-sdk:k01:runtime-validation-rules:1`、`keep_versions: 3`） |
| `node tools/event-registry/dist/cli.js report-unregistered --registry examples/event-registry/events --events examples/event-registry/observed-events.sample.jsonl` | exit 0：清单 8 次上报 / 5 个事件名，未登记 2 个 |
| `pnpm --filter @web-report-sdk/mock-receiver run build` | exit 0 |
| `node tools/mock-receiver/dist/cli.js --port 8899` + `curl` 联调 | `GET /__mock/health` → `status: ok`；`POST /v1/batch`（`batch.valid.json`，占位令牌）→ **202**；重复投递同一批次 → **202**，`received_events=6 / stored_events=3 / duplicate_events=3`（恒等式成立）；错误令牌 → **401** |

**未执行**（按派工约束与任务性质）：`pnpm install`、`pnpm gates`、`pnpm ci`、全仓 `pnpm build`、`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm size`、`pnpm api:check`、`pnpm test:contract`、`pnpm test:e2e`。其中与本文相关的只有 `api:check`（用于核对 API 报告）与 `test:e2e`（K02-AC-03 的 Chromium 验签在 T29 之前不存在），二者均**未由本文执行**，故本文不声明它们通过。

K02 的四个子命令**未在本工作树实跑**（其行为与选项全部引自 `tools/config-signer/README.md`；该工具已合入 main `f18355c`，评审中，K02-AC-03 的部分实现见上）。
