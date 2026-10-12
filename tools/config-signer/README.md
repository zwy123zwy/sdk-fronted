# K02 配置签名 CLI（`@web-report-sdk/config-signer`）

接入方用 K02 校验远程配置正文、生成签名发布物，自行托管到静态资源服务（D001）。
契约依据：`docs/contracts/remote-config.md` 0.2（已冻结）第 4 节、`docs/contracts/schemas/remote-config.schema.json`。
任务卡：`docs/tasks/T25.md`（K02-F1 至 K02-F6）。

## 快速开始

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

生产环境不要用 `--private-key`。用 `--sign-command` 接入接入方自己的 KMS：

```bash
web-report-config-signer sign \
  --body ./config.json \
  --sign-command /opt/kms/sign-p256 \
  --key-id prod-key-2026a \
  --public-key ./public-keys.json \
  --out ./remote-config.json
```

外部签名命令的约定：

- K02 把 `payload` 的 UTF-8 字节经 **stdin** 传给该命令（不走命令行参数，避免出现在进程列表）；
- 该命令只在 **stdout** 输出 64 字节裸签名的 base64url（86 字符，IEEE P1363 的 r‖s）；
- K02 用 `--public-key` 提供的公钥对签名做一次自检；不匹配时返回非零退出码；
- **K02 进程完全不接触私钥**，它既不读私钥文件，也不解析或缓存私钥材料。

## 子命令

| 子命令 | 作用 | 主要选项 |
|---|---|---|
| `validate` | 按 Schema 校验正文、检查 `config_version` 递增、扫描疑似令牌 | `--body`、`--previous`、`--allow-token-path` |
| `sign` | 先校验再签名，输出 `{format_version,key_id,alg,payload,signature}` 发布物 | `--body`、`--private-key` 或 `--sign-command`、`--key-id`、`--public-key`、`--previous`、`--out` |
| `verify` | 校验发布物结构、签名与正文 Schema，用于发布前自检 | `--envelope`（等价 `--body`）、`--public-key`、`--previous`、`--no-body-schema` |
| `keygen` | 生成测试密钥对（只用于测试） | `--out-private`、`--out-public`、`--key-id`、`--force` |

`--body` / `--envelope` 支持 `-` 表示从 stdin 读取。`--body` 也接受契约样例的
`{ "decoded_payload": {...} }` 与 `{ "cases": [...] }` 两种包装（见
`docs/contracts/examples/remote-config.valid.json`、`remote-config.invalid.json`）。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 检查未通过：Schema 校验失败、`config_version` 未递增、疑似令牌、验签失败 |
| 2 | 用法或运行环境错误：未知子命令、缺参数、文件不可读、密钥不可解析 |

失败信息一律写到 stderr，逐行给出「问题码 + 字段路径 + 说明」，便于在接入方 CI 中定位。

## `config_version` 递增（K02-F2）

`--previous <文件>` 接受两种形态：K02 发布物（envelope，取 `payload` 里的值）或配置正文。
新正文的 `config_version` 必须**严格大于**上一份；相等会被 SDK 判为 `config_version_stale`
（`remote-config.md` 第 3 节），更小还会导致旧发布物回放，两者都返回退出码 1。
不传 `--previous` 时跳过该检查，并在 stdout 明确打印「已跳过」。

## `consent_mode: full`（D002）

远程配置**不接受** `full`（`docs/decisions/D002-consent-full-mode.md`）：它只能写在接入方
页面代码的初始化参数里。正文中出现 `privacy.consent_mode: "full"` 时，K02 返回退出码 1，
并提示 D002 与「只能收紧为 `buffer` 或 `essential_only`」。

## 疑似令牌扫描（K02-AC-07）

递归扫描正文的所有字符串值与键名，命中以下形态即返回退出码 1：

| 模式 | 匹配内容 |
|---|---|
| `pem_header` | `-----BEGIN ... PRIVATE KEY-----`、`-----BEGIN CERTIFICATE-----` 等 |
| `jwt` | `eyJ` 开头的三段 base64url |
| `hex_secret` | 32 位以上连续十六进制（且字母数字混合、字符足够分散） |
| `base64_secret` | 大小写与数字混合、解码后 ≥ 32 字节的 base64/base64url 段 |
| `bearer_literal` | `Bearer <令牌>` |
| `provider_prefix` | `AKIA`/`ASIA`/`ghp_`/`github_pat_`/`xox[baprs]-`/`sk-` 前缀 |

报告只给字段路径、模式名、长度与值的 SHA-256 前 6 位（不可逆），**不回显原串**。

已知良性形态自动放行的只有三类：连字符 UUID、纯十进制数字串、`sha256-<64hex>` 摘要。

**32 位及以上纯十六进制串一律拦截**（含 UUID 的 32 位紧凑写法、40 位 git SHA-1、64 位摘要）：
K02-AC-07 字面要求「32 位以上随机十六进制串」命中即报，而区分 commit hash 与密钥的启发式
不可靠——安全工具的失败方向应该是「要求人工确认」，而不是「静默放行」。确需放行时用：

```bash
web-report-config-signer validate --body ./config.json \
  --allow-token-path /plugins/error/options/commit
```

该参数默认空，每次放行都会在 stdout 打印一行留痕；**没有**全局关闭扫描的开关。

## 密钥处理

- `keygen` 生成的私钥以 PKCS#8 PEM 写入，权限 **0600**（`open(..., 'wx', 0o600)` + `fchmod`），
  已存在时默认拒绝覆盖（`--force` 才覆盖）。命令行输出只含路径、权限与提示，不含密钥内容。
- **测试密钥在测试运行时生成，只落操作系统临时目录，不提交到仓库**；`.gitignore` 无需改动。
- 私钥来源只有 `--private-key <文件>`（仅测试）与 `--sign-command`（KMS）两种；
  K02 **不支持**从命令行明文、stdin 或环境变量读私钥（会留在 shell 历史与进程环境里）。
- 本地私钥只在 `src/signer-source.ts` 的 `local-file` 分支出现；解析失败时错误信息不回显文件内容。
- 所有问题经 `src/errors.ts` 统一渲染，`Problem` 类型不含原始取值。

## 验证与测试

```bash
pnpm exec vitest run --coverage.enabled=false tools/config-signer   # 80 个用例
pnpm exec vitest run --coverage                                     # 全仓覆盖率门槛
pnpm exec tsc -p tools/config-signer/tsconfig.json
pnpm exec eslint tools/config-signer
```

测试覆盖 `tests/acceptance/K02.md` 的 K02-AC-01 至 K02-AC-09。其中私钥不泄漏（K02-AC-08）用三层证据：

1. **材料指纹扫描**：把本次真实使用的密钥材料（私钥 PEM 每行、PKCS#8 DER 的 base64、
   私钥 JWK 的 `d`、公钥 `x/y`）当指纹，断言它们不出现在四个子命令的任何 stdout/stderr，
   也不出现在仓库工作树的任何文本文件里；
2. **仓库形态扫描**：用「能否解析成 EC 私钥」判定文件是否含私钥（只有真能 `createPrivateKey`
   解析成功才算命中），避开源码字符串字面量造成的自指误报；并用白名单登记只含 PEM 头示例文本的文档；
3. **零新增文件差集**：用 `git ls-files -o --exclude-standard` 在扫描前后取快照对比，
   确认没有新增密钥文件。

### 未完全覆盖的验收条目

- **K02-AC-03 的浏览器侧验签（Playwright Chromium）：属部分实现。**
  本任务的单测用 Node 24 的全局 `crypto.subtle`（与 Chromium 的 WebCrypto 走同一条 W3C
  ECDSA P-256 + SHA-256 路径；本仓库 T10 已断言 `crypto === webcrypto`）验证发布物。
  **AC-03 括号里点名的「Playwright Chromium」验签尚未执行**，已移交 T29 的 E2E，
  不写在本工具目录下。这一条**不算通过**。
- 未做系统调用级追踪（macOS 上 strace/dtrace 不可移植），改用「代码结构 + 行为 + 材料指纹」
  三层证据替代，边界如实登记在合入报告里。

## 给下游的使用说明

- **T13 / C03（SDK 配置消费）**：发布物字段与 `remote-config.md` 第 4 节一致；
  公钥用 `keygen --out-public` 产出的 `{ [key_id]: JWK }` 传给 `config_public_keys`（R-002）。
- **T29（E2E）**：把 `sign` 的产物发布到 M01（`tools/mock-receiver` 的 `config-host.ts`），
  并补 K02-AC-03 的 Chromium 验签。
- **T34（文档）**：`consent_mode: full` 只能在初始化参数中设置，需要接入方自行确认合规。
