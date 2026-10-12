# 实施计划：T25 K02 配置签名 CLI

> 交对接负责人（前端负责人、安全负责人）确认。按任务卡「属于安全相关任务，计划需安全负责人确认」与指南第 5 节第 4 步、第 7 节（涉及密钥），**确认前不写实现代码**。
> 本文件由 A08 于本阶段落盘，仅用于评审；不在任何门禁范围内（`docs/**` 之外的 Markdown）。

## 已读清单

- 指南章节：`AGENTS.md`（入口、必须停下情况）；`docs/agent-development-guide.md` 第 0–8 节、第 9 节 A08 行、第 11 节（开发工具硬约束）、第 12 节（T25 切片：C03、安全要求汇总中的配置安全）、第 13 节
- 任务卡：`docs/tasks/T25.md`
- 看板：`docs/tasks/board.md`（T25 行「可领取」；T07、T08 已验收，依赖满足）
- 契约文件与版本：
  - `docs/contracts/remote-config.md` 0.2（已冻结）重点第 2.1、3、4、4.1、5 节
  - `docs/contracts/schemas/remote-config.schema.json`（含 `$defs/envelope`）
  - `docs/contracts/examples/remote-config.valid.json`、`remote-config.invalid.json`（正文与非法 case 的数据来源）
- 验收用例：`tests/acceptance/K02.md`（K02-AC-01 至 K02-AC-09，只读；含 T25 任务卡未列出的 AC-09 非功能目标）
- 现有代码：
  - 骨架 `tools/config-signer/{package.json,tsconfig.json,src/cli.ts,src/index.ts}`（`cli.ts` 注释已约定 `validate / sign / verify / keygen`）
  - 同构参考 `tools/event-registry/src/cli.ts`、`src/definitions.ts`（Ajv 用法）、`src/__tests__/cli.test.ts`、`src/__tests__/test-support.ts`（进程内 `runCli` 测试、临时目录夹具、退出码约定）
  - `tools/mock-receiver/src/config-host.ts`（`ConfigEnvelope` 消费方：`format_version/key_id/alg/payload/signature`）
  - `tests/contract/remote-config.test.ts`、`tests/contract/remote-config-signature.test.ts`（T10 已实现的 envelope Schema 校验与 WebCrypto 验签参考）
  - `vitest.config.ts`（`include` 只收 `packages/*/src/**`、`tools/*/src/**`；`tools/*/src/**` 覆盖率行 80%/分支 70%；`tools/*/src/cli.ts` 与 `index.ts` 排除）、`eslint.config.js`、`tsconfig.base.json`、根 `package.json`、`pnpm-workspace.yaml`、`.gitignore`

超出切片读取的内容及原因：`tools/mock-receiver/src/config-host.ts` 与 `tests/contract/**`（T25 不在切片里，但它们分别定义发布物的下游消费形态与本仓库已有的签名/验签参考步骤，直接决定 K02 的输出约定，故读取）。

## 要改的文件

| 文件 | 新增 / 修改 | 是否在所有权范围内 |
|---|---|---|
| `tools/config-signer/src/cli.ts` | 修改（去掉「尚未实现」骨架，接上解析与分发） | 是 |
| `tools/config-signer/src/index.ts` | 修改（导出公共类型/函数，保持 `TOOL_ID`） | 是 |
| `tools/config-signer/src/validate.ts` | 新增：Schema 校验 + D002 + 版本单调 + 令牌扫描，组装问题列表 | 是 |
| `tools/config-signer/src/schema.ts` | 新增：加载/编译 `remote-config.schema.json`（含 `$defs/envelope`） | 是 |
| `tools/config-signer/src/version.ts` | 新增：读「上一份发布物」并比较 `config_version` | 是 |
| `tools/config-signer/src/token-scan.ts` | 新增：疑似令牌/密钥扫描与脱敏报告 | 是 |
| `tools/config-signer/src/sign.ts` | 新增：ES256/P1363 签名、envelope 组装、签名后自检 | 是 |
| `tools/config-signer/src/verify.ts` | 新增：envelope 校验 + 验签 + 可选正文校验 | 是 |
| `tools/config-signer/src/keys.ts` | 新增：测试密钥对生成、JWK 读取、私钥文件权限处理 | 是 |
| `tools/config-signer/src/signer-source.ts` | 新增：私钥来源抽象（本地文件 / 外部签名命令） | 是 |
| `tools/config-signer/src/errors.ts` | 新增：`Problem` 类型、退出码常量、错误渲染 | 是 |
| `tools/config-signer/src/__tests__/test-support.ts` | 新增：测试夹具（内存密钥、临时目录、进程内运行 CLI、泄漏扫描器） | 是 |
| `tools/config-signer/src/__tests__/*.test.ts` | 新增：K02-AC-01 至 AC-09 的可执行测试 | 是 |
| `tools/config-signer/README.md` | 新增：交接给 T13/T29/T34 的使用说明 | 是 |
| `tools/config-signer/PLAN.md` | 新增：本计划 | 是 |

不改动：`package.json`（含根与各包）、`pnpm-lock.yaml`、`vitest.config.ts`、`eslint.config.js`、`docs/contracts/**`、`tests/acceptance/**`、`packages/**`。`tools/config-signer/package.json`、`src/cli.ts` 的现状已满足需要（`bin`、`build`、`tsconfig` 均无需改）。

## 实现要点

### 0. 通用约定

- 退出码：`0` 成功；`1` 检查未通过（校验失败、版本未递增、疑似令牌、验签失败）；`2` 用法或运行环境错误（未知子命令、缺参数、文件不可读、私钥不可解析）。与 K01 一致，便于接入方 CI 判断。
- 输出：正常摘要走 stdout；所有问题走 stderr，逐行渲染为 `问题码：字段路径 <path> —— 说明`。失败时 stdout 不输出任何配置内容。
- 纯函数核心 + 薄 CLI：参数解析、校验、签名、验签、扫描全部实现为可单测的纯/IO 分离函数；`cli.ts` 只做参数转发（`vitest.config.ts` 已把 `cli.ts` 排除出覆盖率，逻辑必须放在独立模块）。
- JSON 指针风格的字段路径（与 Ajv `instancePath` 一致，如 `/privacy/consent_mode`、`/sampling/rules/2/rate`），满足「错误信息含字段路径」。

### K02-F1 按 Schema 校验正文

- 用 `Ajv2020`（`ajv/dist/2020.js`，与 `tools/event-registry/src/definitions.ts` 同一写法，`allErrors: true, strict: false, allowUnionTypes: true`）编译 `docs/contracts/schemas/remote-config.schema.json`。
- 关键点（已实测确认）：`removeAdditional` 默认为关闭，正文里的未知字段会被保留且不影响通过——符合契约「SDK 必须忽略不认识的字段，正文允许额外字段」。
- `validate <body.json>`：正文来源是文件；若文件是 `{ "decoded_payload": {...} }` 形态（契约样例 `remote-config.valid.json`），自动取 `decoded_payload`；若是 `{ "cases": [...] }`（`remote-config.invalid.json`），逐个 case 校验。也接受裸正文对象。用 `--json-pointer` 风格的 `--body-pointer` 不需要引入。
- 每个 Ajv 错误转成一个 `Problem`：`code='schema_invalid'`、`path=instancePath`、`message="Schema 校验失败：<keyword> <message>"`，绝不回显字段值。

### K02-F2 版本单调递增

- 新正文的 `config_version` 由 Schema 保证是 ≥1 的整数。
- 「上一份发布物」来源：`--previous <文件>`（K02-AC-01/02 统一用显式文件参数，避免引入未在契约中定义的目录命名约定）。该文件两种形态都接受：
  1. K02 发布物（envelope，含 `payload` 字符串）→ 解析 `payload` 取 `config_version`；
  2. 配置正文或 `{ "decoded_payload": {...} }` → 直接取 `config_version`。
  若 `--previous` 缺省，则跳过该检查并在 stdout 明确写「未提供 --previous，已跳过 config_version 递增检查」（不静默通过）。
- 断言：`newVersion > previousVersion`。相等或更小 → `code='config_version_not_increasing'`，stderr 写「config_version 必须严格大于上一份发布物：上一份 <n>，本次 <m>；相等会导致回放，更小会被 SDK 判为 config_version_stale（remote-config.md 第 3 节）」→ 退出码 1。AC-02 的 42/41/43 三种输入都覆盖。
- `--previous` 文件不可读或 `config_version` 缺失/非整数 → 退出码 2（环境错误，不当作检查失败）。
- 本任务只做契约明确要求的「config_version 递增」。`app_id`/`env` 一致性（对应 SDK 侧 `config_scope_mismatch`）与 `published_at` 是否单调属于我的建议增强而非契约要求，见「对契约的疑问」第 3 条。

### K02-F3 ES256 签名与发布物输出

- `payload = JSON.stringify(body)`，签名覆盖 `payload` 字符串的 UTF-8 字节，不做 JSON 规范化/重排（契约第 4 节）。
- `sign('sha256', Buffer.from(payload,'utf8'), { key, dsaEncoding: 'ieee-p1363' })` → 64 字节 r‖s；`.toString('base64url')` → 86 字符无填充。已实测确认 64/86 与本仓库现有 `tests/contract/remote-config-signature.test.ts` 的写法一致。
- envelope：`{ format_version: 1, key_id, alg: 'ES256', payload, signature }`，字段顺序固定，写文件时 `JSON.stringify(envelope, null, 2) + '\n'`（便于 diff 与人工核对）。
- 输出：`--out <文件>` 或 stdout。写文件用「同目录临时文件 + rename」保证原子性。
- **签名前必须校验**：`sign` 内部固定执行 F1 + F2（若给了 `--previous`）+ F3（令牌扫描），任一失败即退出码 1 且不产出发布物；不提供任何跳过校验的开关。
- **签名后自检**：用公钥对刚生成的 envelope 验签一次（内部调用同一 `verifyEnvelope`），失败则视为内部缺陷并退出码 1。这保证 K02 产出的东西一定自洽。
- `sign --envelope-schema` 不需要；`sign` 产出的 envelope 在测试里用 `$defs/envelope` 断言（AC-03）。

### K02-F4 验签子命令

- `verify --envelope <file> --public-key <jwk文件>`（`--public-key` 可重复或指向 `{ key_id: JWK }` 映射文件，与 SDK 的 `config_public_keys` 形状一致，R-002）。
- 步骤：(1) envelope 通过 `$defs/envelope`（若失败，报 `envelope_schema_invalid`）；(2) `key_id` 能在公钥表中找到，否则 `key_id_unknown`；(3) `crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'}, key, sigBytes, payloadBytes)` 或用 `node:crypto verify`（两者等价，见「跨实现验证」）；(4) 可选 `--body-schema` 对 `JSON.parse(payload)` 再跑一次正文 Schema（默认开启，与下游 C03 行为一致；`--no-body-schema` 可关）。
- 失败诊断区分：`envelope_schema_invalid` / `key_id_unknown` / `payload_not_json` / `body_schema_invalid` / `signature_invalid`，全部退出码 1，且不回显 `payload` 内容（只给长度与路径提示），避免把配置正文（可能含业务信息）打到 CI 日志。
- 成功时 stdout 打印 `验签通过：key_id=<id> alg=ES256 config_version=<n>`。

### K02-F5 生成测试密钥对（只用于测试）

- `keygen --out-private <pem> --out-public <jwk.json> [--key-id <id>] [--force]`：
  - `generateKeyPairSync('ec', { namedCurve: 'P-256' })`；
  - 私钥写 PKCS#8 PEM，**写前用 `open(path, 'wx', 0o600)`**（原子地「不存在才创建」+ 0600），再 `fchmod` 兜底；文件已存在时默认拒绝（退出码 2，除非 `--force`）。满足 K02-AC-05 的 0600；
  - 公钥写 `{ "<key_id>": { kty, crv, x, y } }`（只含 JWK 公有字段；已实测 Node 的 `publicKey.export({format:'jwk'})` 恰好只给 `kty,crv,x,y`）；
  - stdout/stderr 只打印 `key_id`、文件路径、私钥文件权限（`0o600`）与「仅用于测试，不得用于生产」提示——**不打印任何密钥内容**；
  - `keygen` 是 F5 明确要求的测试工具，但实现上它也不「读取」私钥：私钥材料只在进程内从 `generateKeyPairSync` 流向 `export`，不经过任何日志/错误路径。
- 明确禁止的形式：不接受从 stdin/环境变量读私钥来签名（会把密钥留在 shell 历史与 `/proc` 环境里），见「对契约的疑问」第 5 条。

### K02-F6 签名私钥来源可替换

- 定义签名来源接口：

  ```ts
  type Signer =
    | { kind: 'local-file'; privateKeyPem: string }        // 仅测试
    | { kind: 'external-command'; command: string; args: readonly string[] };
  interface SignPayload {
    (payloadBytes: Buffer): Promise<Buffer> | Buffer;        // 返回 64 字节裸签名
  }
  ```

- **本地文件（仅测试）**：`sign --private-key <pem文件>`。`sign.ts` 里唯一 `readFile` 私钥的位置集中在 `signer-source.ts`，且只在 `kind==='local-file'` 分支执行；`--private-key` 的取值为路径，错误信息里只出现路径不出现内容。
- **外部签名命令（接入方 KMS）**：`sign --sign-command "<命令行>"`（字符串按 shell-quote 简单拆分，或 `--sign-command` + 重复 `--sign-arg`，实现取后者以免自行实现 shell 解析）。约定：
  - **payload 只经 stdin** 传给外部命令（避免 `ps`/进程列表泄漏正文，也避免命令行长度限制）；
  - 外部命令只在 stdout 输出 **64 字节裸签名的 base64url**（86 字符）；
  - K02 侧**从不解析、不校验、不存储**私钥；`signer-source.ts` 的 `external-command` 分支没有对私钥文件的任何 `readFile`/`open`；
  - K02 拿到签名后用**外部传入的公钥**（`--public-key`，或接入方给出）做一次验签自检，验签失败即退出码 1；这样 K02 既不需要私钥，也能保证「KMS 返回的签名确实是这把公钥对应的私钥产生的」；
  - 子进程用 `spawn`（不经 shell，`shell: false`）避免命令注入；非零退出码 → 退出码 2，stderr 只带外部命令的 stderr 片段（做长度截断与 PEM 头过滤，防 KMS 侧把私钥打回来）。
- AC-06 的测试替身：内置一个只做 `if (argv[2]==='--sign')` 的最小子命令 `sign-stdin --private-key-env <VAR>` 放在**测试夹具代码**里（`src/__tests__/` 下，且仅由测试 `spawn` 调用），它从环境变量读测试私钥、签名、只输出 base64url。测试断言：AC-06 产出物与 AC-03 同样通过 WebCrypto 验签，且 K02 进程的 stdout/stderr 不含私钥材料。

### 疑似令牌扫描（K02-AC-07）

- 递归遍历配置正文的所有字符串值（含数组下标与对象键路径），对每个值做模式匹配；命中即 `code='suspected_token'`，**报告字段路径 + 模式名 + 脱敏提示，绝不打印该字符串原文**。脱敏提示形如 `<疑似 JWT，长度 312，未回显>`；如必须给定位线索，只给长度与 SHA-256 前 6 位十六进制（不可逆、无法据此还原）。
- 扫描模式（第一版，逐条在计划中固定下来，便于评审收敛误报）：
  1. `pem_header`：`-----BEGIN [A-Z ]*PRIVATE KEY-----` 或 `-----BEGIN CERTIFICATE-----`；
  2. `jwt`：`^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$`（三段 base64url，与 `remote-config.md` 第 5.4 节内置 `jwt` 脱敏规则同形）；
  3. `hex_secret`：`[0-9a-f]{32,}` 或 `[0-9A-F]{32,}`；
  4. `base64_secret`：长度 ≥40 且同时含小写、大写、数字的 base64/base64url 串；
  5. `bearer_literal`：`(?i)bearer\s+[A-Za-z0-9._~+/-]{16,}`；
  6. `provider_prefix`：`AKIA`/`ASIA` 前缀、`sk-` 前缀、`ghp_`/`github_pat_` 前缀、`xox[baprs]-` 前缀。
- 已知良性形态的例外（避免误报，且**例外只针对确定的形态**）：连字符 UUID、纯十进制数字串（如 `bank_card` 类样例）、以及本仓库自己的 SHA-256 摘要形态 `"sha256-<64hex>"`（如 M01 的 ETag）。
  **32 位及以上纯十六进制串不设例外**（含 UUID 紧凑写法、40 位 git SHA-1）：负责人 2026-10-12 复核裁定按 K02-AC-07 字面执行，确属良性时走 `--allow-token-path`。
- 逃生舱：**暂不实现**。若接入方确有合法长 hex（如 commit hash 写进 `overrides.patch.plugins.*.options`），我建议用显式 `--allow-token-path <JSON 指针>` 白名单（默认空，且每次使用都在 stdout 留下「已放行 <path>，模式 <name>」记录）而不是全局 `--no-token-scan`。是否要有这个口子请安全负责人定，见「需确认的问题」第 4 条。
- 「不误报 commit hash」的具体取舍：`hex_secret` 匹配 ≥32 位连续十六进制（且字母数字混合、字符足够分散）；32 位与 40 位 git SHA-1 都会命中，这是**刻意的**——配置正文里出现这类不透明串同样应由人确认后走白名单，而不是静默放行。

### K02-AC-01 的 D002 提示

- `privacy.consent_mode: "full"` 在 Schema 层就失败（`enum: ["essential_only","buffer"]`，已实测确认 Ajv 报 `/privacy/consent_mode must be equal to one of the allowed values`）。我在 Ajv 错误之上做一次**路径感知的改写**：
  - 若错误路径恰为 `/privacy/consent_mode` 且实际值是 `"full"`，输出专属问题 `code='consent_mode_full_rejected'`，说明：
    `远程配置不接受 consent_mode: full（D002，见 docs/decisions/Q5-consent.md、docs/contracts/remote-config.md 第 2.1 节）：full 只能在初始化参数中设置；远程配置只能收紧为 buffer 或 essential_only。`
  - 其他非法取值（如 `"always"`）保持通用 Schema 错误，但仍带路径。
  - 两种都退出码 1。
- 实现在 `validate.ts` 里做「值 + 路径」判定，而不是靠匹配 Ajv 的英文文案（文案随 Ajv 版本可能变）。

### 非功能：性能（K02-AC-09）

- 目标：签名与验签**单次不超过 100 ms**。测量口径写进测试与报告：预热 1 次后计时，取 100 次的**中位数与 p95**，并同时给出「内部核心函数耗时」与「进程内 `runCli` 端到端耗时」两组数，避免口径争议。
- ECDSA P-256 签名/验签在 Node 上通常是亚毫秒级（预期远低于预算）；真实成本在 Ajv 编译与否。因此：Ajv 实例与编译后的 `validate` 在进程内**编译一次并复用**（`schema.ts` 暴露 `getValidator()` 懒加载单例）；`sign`/`verify` 各只编译一次 envelope/正文校验器。
- 若外部签名命令路径（F6）的进程启动开销使端到端超过 100 ms，报告里区分说明：**K02 侧开销**与**外部命令开销**分列，并请安全负责人确认 AC-09 的口径是否只针对 K02 自身（见「需确认的问题」第 7 条）。

### 测试策略（K02-AC-01 至 AC-09）

测试全部放 `tools/config-signer/src/**/*.test.ts`（`vitest.config.ts` 的 `include` 只收 `packages/*/src/**`、`tools/*/src/**`；该配置不在我的可写范围，因此**不移动、不修改它**）。夹具放 `src/__tests__/test-support.ts`（非 `.test.ts`，不被收集）。测试在进程内调用 `runCli(argv, io)` 收集 stdout/stderr/退出码（同 K01 `cli.test.ts` 写法），需要真进程隔离的（AC-08 的第三方进程扫描）用 `spawn`。

| 用例 | 测试做法 |
|---|---|
| K02-AC-01 | 读 `docs/contracts/examples/remote-config.valid.json` 的 `decoded_payload` → `validate` 退出码 0；逐个 `remote-config.invalid.json` 的 `cases` → 每个退出码 ≠0，且 stderr 每条都含 `/` 开头的字段路径；对 `consent_mode:"full"` 那个 case 额外断言 stderr 含 `D002`。 |
| K02-AC-02 | 用 `valid.decoded_payload` 生成 `--previous` 文件（config_version 42）；新正文 42 / 41 / 43 分别 `validate --previous`；断言 42、41 退出码 1 且提到「必须严格大于」，43 退出码 0。 |
| K02-AC-03 | `keygen` 到临时目录 → `sign` 产出 envelope → 用 `$defs/envelope`（Ajv，读契约 Schema）断言通过；`signature` 匹配 `^[A-Za-z0-9_-]{86}$` 且 base64url 解码后 64 字节；再用 **WebCrypto**（Node 24 全局 `crypto.subtle`）`importKey('jwk', jwk, {name:'ECDSA',namedCurve:'P-256'}, false, ['verify'])` + `subtle.verify` 验签通过——这就是「模拟浏览器侧」的跨实现验证，与 `tests/contract/remote-config-signature.test.ts` 完全同一条路径。（说明：此处不需要 Playwright；AC-03 括号里的「Playwright Chromium」是验收用例给出的可选方式，Node 24 的 `crypto.subtle` 与 Chromium 的 WebCrypto 同为 W3C 实现，且真浏览器验证由 T29 的 E2E 承担。是否必须补一条 Playwright 用例见「需确认的问题」第 8 条。） |
| K02-AC-04 | 对 AC-03 的 envelope 做四种篡改：`payload` 改 1 个字节、`payload` 重排 JSON（换行/缩进）、`signature` 改 1 个字符、`key_id` 换成未配置/另一把已知 key → 每个 `verify` 退出码 ≠0；并加一条「未篡改时退出码 0」的对照，避免假阴性。 |
| K02-AC-05 | `keygen` 到临时目录 → `stat` 私钥文件 `mode & 0o777 === 0o600`；公钥 JSON 只含 `kty/crv/x/y`；捕获的 stdout/stderr 断言不含 `PRIVATE KEY`、不含私钥 PEM 任何一行、不含私钥 JWK 的 `d` 与 `x` 值、不含私钥材料派生出的 base64url 片段。 |
| K02-AC-06 | 建一个最小外部签名脚本（测试夹具，`spawn` 时传 `--sign-stdin`，私钥经环境变量给该脚本，K02 命令行里**只有公钥**）→ `sign --sign-command ... --public-key ...` 产出 envelope → WebCrypto 验签通过、`$defs/envelope` 通过；并断言 K02 的 stdout/stderr 不含私钥材料；另加一条：把该外部命令换成「输出非法签名的脚本」，断言 K02 退出码 ≠0（自检生效）。 |
| K02-AC-07 | 用合法正文 + 在若干字段（含嵌套数组元素、`overrides.patch.plugins.*.options`、`sampling.allow_users[0]`）注入 JWT、PEM 头、40/64 位随机十六进制串 → 每个退出码 ≠0，stderr 出现**该字段的 JSON 指针路径**，且断言 stderr/stdout 中**不出现注入串原文**（用注入值本身去 `includes` 断言为 false）。再加反例：注入 UUID、`"sha256-<64hex>"`、`ORD123456789012` 等已知良性串 → 断言通过（误报护栏）。 |
| K02-AC-08 | 见下节。 |
| K02-AC-09 | 预热后各跑 100 次，断言中位数与 p95 < 100 ms；同时把实测数写进合入报告。 |

### K02-AC-08 的仓库/输出泄漏扫描（我打算这么做）

两层，一层「材料指纹」、一层「仓库形态」：

1. **材料指纹扫描（强断言，无自指误报）**：测试运行时在内存里持有本次生成的全套密钥材料，并对每个待扫描对象断言这些**具体字节**都不出现：
   - 私钥 PEM 的每一行（去掉 `\n`）、私钥 DER/base64 主体、私钥 JWK 的 `d` 与 `x` 值、以及由它们派生的 base64url 片段；
   - 扫描对象：K02 四个子命令所有调用的 stdout/stderr 汇总、以及仓库工作树里除 `node_modules/`、`.git/`、`dist/`、`coverage/` 之外的所有文本文件内容（`git ls-files` 的跟踪文件 + 测试产生的未跟踪文件）。
   - 因为是「拿本次真实密钥材料去比对」，扫描模块自身源码里的字面量（如 `'-----BEGIN'`）不构成自指误报。
2. **仓库形态扫描（通用断言）**：对 `tools/config-signer/` 与仓库工作树做结构检查：
   - 用 `createPrivateKey({ format:'pem' })` / `importJWK` 之类的解析器判定「这个文件里是否存在可解析的私钥」——只有真正能解析成 EC 私钥的内容才算命中，从而完全避开测试源码里的字符串字面量；命中即失败；
   - 断言测试期间工作树中新增的文件全部位于**操作系统临时目录**（`src/__tests__` 的 `makeTempDir()` 统一用 `mkdtemp(join(tmpdir(), 'k02-'))`）且已被清理，仓库内零新增文件（用测试前后各一次 `git ls-files -o --exclude-standard` 快照做差集，同时兼容未跟踪文件）；
   - 断言仓库里不存在 `*.pem`、`*.key`、`*private*` 形式的私钥文件。
3. 顺带断言 `.gitignore` **无需改动**：因为 (a) 没有任何测试把密钥写进仓库目录，(b) `temp/` 已在 `.gitignore` 中，(c) 密钥只落在 OS 临时目录并在 `finally` 清理。所以本任务不改 `.gitignore`（它也不在我的所有权范围）。

## 新增依赖

无。`ajv@8.20.0` + `ajv-formats@3.0.1` 已由负责人批准并声明为根 `devDependencies`（本仓库既有 K01 与 `tests/contract/lib/schemas.ts` 已在使用 ajv）。其余全部使用 Node 内置模块（`node:crypto`、`node:fs`、`node:fs/promises`、`node:path`、`node:child_process`、`node:os`、`node:url`）。`ajv-formats` 本任务可能用不到（契约 Schema 未用 `format` 关键字），若不用就不 import。

## 风险与对策

1. **最容易出安全问题的地方：私钥泄漏到 stdout/stderr/日志。** 兜底：私钥材料只在 `signer-source.ts` 的 `local-file` 分支出现；错误渲染统一走 `errors.ts`，`Problem` 结构里没有「原始值」字段（只有 `code/path/message`），从类型上禁止把值带进日志；AC-08 的「具体字节不出现」扫描是所有命令输出的硬断言。
2. **误把 `--previous` 的正文当作已发布内容。** `--previous` 只用于取一个整数，不参与签名、不回显正文。
3. **令牌扫描误报导致接入方 CI 卡死。** 例外只针对确定形态（UUID、`sha256-<hex>`），并提供显式白名单口子（待安全负责人定）；扫描命中一律给出路径，便于人工改写。
4. **`keygen` 覆盖已有私钥 / 权限被 umask 削弱。** `open(..., 'wx', 0o600)` + `fchmod(0o600)` 双保险；默认拒绝覆盖。
5. **外部签名命令路径的进程/注入风险。** `spawn` 不经过 shell；payload 只走 stdin；对外部命令 stderr 做截断与 PEM 头过滤，防止 KMS 侧把私钥回显后又被 K02 打到日志。
6. **Ajv 误差文案随版本变化导致 D002 判定失效。** D002 判定基于「路径 + 实际值」，不依赖英文文案。
7. **AC-09 口径不明**（是否含进程启动）。分列内部耗时与端到端耗时，并把口径列为待确认问题。
8. **测试文件位置约束。** 全部放 `tools/config-signer/src/**`；不试图修改 `vitest.config.ts`。
9. **`tools/` 覆盖率门槛（行 80%/分支 70%）。** 逻辑模块化 + 全用例覆盖各失败分支；`cli.ts` 与 `index.ts` 已被排除，不要把逻辑写进这两个文件。

## 对契约的疑问

1. `--previous` 的形态：契约与验收用例只说「上一份发布物」。我按「显式文件参数，接受 envelope 或正文」实现。是否需要支持「目录/上次输出文件自动发现」？（我倾向不需要，避免发明命名约定。）
2. D002 的强度：`consent_mode: "full"` 在远程配置里按契约第 2.1 节是「SDK 忽略该字段、其他部分照常生效」，但 K02-AC-01 要求非零退出码。我按「K02 发布前硬拒绝」实现（更安全），确认这是预期而不是「只警告」。
3. 是否要在 K02 侧一并检查 `app_id`/`env` 与「上一份发布物」一致、以及 `published_at` 单调？契约只要求 `config_version` 递增；我默认不做（避免超出 K02-F2 的授权范围），可加。
4. 令牌扫描的启发式与误报策略（尤其 40 位 git SHA-1 是否豁免）、以及要不要给 `--allow-token-path` 逃生舱，需要安全负责人拍板。
5. 私钥输入形式：我**明确不支持**从 stdin/环境变量读私钥（泄漏面更大），只支持 `--private-key <文件>` 与 `--sign-command`。确认这是期望的收紧。
6. `sign` 对已存在的 `--out` 文件：默认覆盖（CI 里每次重新签名是常态），是否需要拒绝？
7. AC-09 的 100 ms 是否包含进程启动与 Ajv 编译？
8. AC-03 的浏览器侧验证：Node 24 的 `crypto.subtle` 是否足以代表 Chromium 的 WebCrypto，还是必须补一条 Playwright 用例？

## 验收用例确认

- 用例范围：`tests/acceptance/K02.md` 中的 K02-AC-01 至 K02-AC-09
- 当前状态：已确认存在。转成可执行测试的落点是 `tools/config-signer/src/__tests__/`（实现阶段第一步先建测试并确认在当前骨架下失败，再实现）。K02-AC-01/02/03/04 所需数据来自已冻结的契约样例与运行时生成的测试密钥；K02-AC-05/06/07/08/09 由测试夹具自建。

## 附：K02 全程不接触/不泄露私钥的证明方案

1. **结构证明**：全仓库只有 `signer-source.ts` 会触碰私钥；`external-command` 分支与私钥文件无任何文件系统交集（代码评审可逐行核对）；`Problem` 类型不含原始值，日志路径在类型层面拿不到私钥。
2. **行为证明**：AC-06 用例中 K02 命令行只出现公钥，私钥只存在于测试替身脚本的环境里；K02 仍能产出通过验签的发布物。
3. **泄漏证明**：AC-05 + AC-08 用「本次真实密钥材料的具体字节」扫描四个子命令的全部 stdout/stderr 与仓库工作树；再用可解析性判定扫仓库中的私钥文件；用 `git ls-files -o` 差集证明仓库零新增文件。
4. **权限证明**：AC-05 断言私钥文件 `0600`；仓库内不产生任何密钥文件，`.gitignore` 无需改动。
5. **不落盘证明**：所有测试密钥只在运行时生成、只写 OS 临时目录、`finally` 清理；提交物中不存在任何密钥材料（AC-08 的仓库扫描同时覆盖这一点）。
6. 合入报告里附「未执行/无法执行」的诚实说明（例如不声称做了系统调用级 strace 追踪，macOS 上不可移植；改用代码结构 + 行为 + 材料指纹三层替代）。
