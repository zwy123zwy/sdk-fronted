# 接收方样例包（T10）

本目录是给 **M01（本地 mock 接收服务）与外部接收方** 复用的协议自查样例包，由 `tests/contract/`
的契约测试维护。它把 `docs/contracts/receiver-requirements.md` 的每条「必须」映射到
`docs/contracts/examples/` 下已冻结的样例与对应的 JSON Schema。

## 内容

| 文件 | 说明 |
|---|---|
| `manifest.json` | 机器可读清单：`required_checks` 覆盖全部「必须」条目，`optional_checks` 覆盖「应该 / 可以」条目；每条给出 `samples`（样例路径、校验 Schema、期望结论）与 `self_check`（自查步骤） |
| `README.md` | 本说明 |

样例包**只引用、不复制**契约样例：`docs/contracts/` 是只读契约，复制会产生两份会漂移的样例。
`tests/contract/sample-pack.test.ts` 会断言本目录只有 `manifest.json` 与 `README.md`。

## 怎么用

1. 读 `manifest.json` 的 `required_checks`，按 `samples[].path` 取 `docs/contracts/examples/` 下的样例，
   用 `samples[].schema` 指定的 Schema（JSON Schema 2020-12）校验：
   - `expect: "pass"`：样例必须通过校验；
   - `expect: "each_case_must_fail"`：样例是 `cases` 数组（或单值）形态，**每一个 case 都必须校验失败**。
2. 对 `check_kind: "behavior"` 的条目（如 RR-02、RR-08、RR-11），没有可复用的 JSON 样例，
   按 `self_check` 的步骤做故障注入或协议行为验证。
3. 复现本仓库的全部校验结论：

   ```bash
   pnpm test:contract
   ```

   本仓库用 `ajv` 8.20.0（`ajv/dist/2020` 的 `Ajv2020`）+ `ajv-formats` 3.0.1 做校验，
   不用手写关键字子集校验器。

## 「必须」条目与自查样例

| 要求 | 级别 | 主要样例 / 自查方式 |
|---|---|---|
| RR-01 端点、请求格式、上限与响应码 | 必须 | `batch.valid.json`、`batch-promoted.valid.json`、`batch-beacon.valid.json`；`batch.invalid.json` 的 5 个 case 必须失败 |
| RR-02 只在持久化后返回 202 | 必须 | 行为自查（故障注入），无可复用 JSON 样例 |
| RR-03 常规通道与信标通道、常规通道忽略 body 里的 `auth` | 必须 | `batch-beacon.valid.json`（body 内 `auth`）+ 行为自查 |
| RR-04 gzip、解压防护、413 / 400 | 必须 | 压缩 `batch.valid.json` 后发送 + 行为自查 |
| RR-05 按 `app_id` + `event_id` 去重 | 必须 | 重复投递 `batch.valid.json` |
| RR-06 还原批次 `common` 字段 | 必须 | `batch-promoted.valid.json` |
| RR-08 CORS 与响应头 | 必须 | 行为自查（预检 OPTIONS） |
| RR-11 只接受 HTTPS | 必须 | 行为自查（TLS 1.2+） |
| RR-12 令牌只写不读、可吊销、401 | 必须 | `batch-beacon.valid.json` 的 `auth` 位置（占位令牌） |
| RR-13 日志与持久化不含令牌 / 完整 IP | 必须 | `batch-beacon.valid.json` 的 `auth` 字段 + 行为自查 |
| RR-23 保留 `sdk_health` 用于对账 | 必须 | `builtin-events/sdk_health.valid.json`；两个 `*.invalid.json` 必须失败 |

「应该 / 可以」条目（RR-07、RR-14、RR-15、RR-21、RR-22）见 `manifest.json` 的 `optional_checks`，
不属于「必须」100% 通过的范围。

## 数据约定

- 样例中的 UUID、域名、令牌位置全部是**占位值**；不得写入真实个人信息、令牌或密钥。
- 契约测试的签名用例（`tests/contract/remote-config-signature.test.ts`）在测试运行时现场生成
  P-256 测试密钥，绝不落盘、绝不提交。
- `examples/remote-config.valid.json` 同时含发布物 `envelope` 与解码后的正文 `decoded_payload`：
  前者按 `remote-config.schema.json#/$defs/envelope` 校验，后者按正文 Schema 校验。
