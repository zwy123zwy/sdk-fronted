# Web 自定义上报 SDK

浏览器端自定义上报 SDK，以及三个配套开发工具：事件注册表与类型生成 CLI（K01）、配置签名 CLI（K02）、本地 mock 接收服务（M01）。接收服务不在本项目内，接收方需要满足 [`docs/contracts/receiver-requirements.md`](docs/contracts/receiver-requirements.md)。

当前阶段：**P1/P2 开发**。契约已冻结为 0.2。已完成：仓库与门禁（T08）、契约与内置事件 Schema（T05–T07、T06）、C02 内核（T11）、M01 mock 接收服务（T09）；C01、C03、C04、C06、C07、C08 与 K01、K02 待实现。

## 快速开始

```bash
nvm use            # Node.js 24
pnpm install
pnpm gates         # lint、typecheck、test、build、size、api:check、examples
```

## 目录

| 路径 | 内容 |
|---|---|
| `packages/core` | 内核、公共 API、配置与采样、上下文与隐私（C01–C04） |
| `packages/transport` | 队列与调度、传输与可靠投递、自监控（C06–C08） |
| `packages/plugins` | 采集插件、第三方 APM 双写适配器（C05） |
| `packages/browser` | 接入方安装的入口包，另产出 `<script>` 用的 IIFE |
| `tools/event-registry` | K01 |
| `tools/config-signer` | K02 |
| `tools/mock-receiver` | M01（只用于测试） |
| `examples/` | Vite、`<script>`、Vitest/Jest 接入示例 |
| `tests/` | 契约测试、E2E、验收用例规格 |

## 文档导航

| 文档 | 用途 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI Agent 进入仓库后的第一份必读材料 |
| [docs/agent-development-guide.md](docs/agent-development-guide.md) | Agent 开发指南：流程、门禁、升级规则、角色、编码约束 |
| [docs/contracts/](docs/contracts/README.md) | 上报协议、事件标准、远程配置、原因码、接收方要求 |
| [docs/decisions/](docs/decisions/README.md) | 范围决定 D001、D002 与 Q1–Q7 |
| [docs/tasks/board.md](docs/tasks/board.md) | 任务看板；任务卡见 `docs/tasks/Txx.md` |
| [docs/use-cases.md](docs/use-cases.md) | 公共 API 设计用例 |
| [tests/acceptance/](tests/acceptance/README.md) | 按需求编号编写的验收用例规格 |
| [docs/templates/](docs/templates/) | ADR、POC 报告、实施计划模板 |

总体设计方案（飞书）：<https://nwd4iy9rd2s.feishu.cn/docx/D9wXdUn8xooIu8x9RVDchSeanDg>。仓库内的契约与决策优先于飞书方案。

## 文档状态

| 类别 | 状态 |
|---|---|
| 契约 | 0.2 已冻结（2026-10-10）；`builtin-events/` 已于 2026-10-12 由 T06 按兼容变更补齐 |
| 决策 | D001、D002、Q1、Q3–Q7 已确认；Q2 待确认（只阻塞 T33） |
| 仓库与门禁 | T08 已验收；全量门禁命令为 `pnpm gates`；CI 首次运行待确认 |
| 验收用例 | 规格稿；已开工任务（T06、T09、T11）的用例已转为可执行测试 |
