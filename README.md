# Web 自定义上报 SDK

浏览器端自定义上报 SDK，以及配套的接入网关、数据处理管道、存储与查询、配置中心、埋点字典和管理控制台。本仓库存放客户端 SDK（C01–C08）、跨端契约、任务卡和测试；服务端代码的存放位置由 T08 决定。

当前阶段：**P0 方案定稿**。代码仓库尚未初始化，契约为草案，待确认事项未关闭。

## 文档导航

| 文档 | 用途 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI Agent 进入仓库后的第一份必读材料 |
| [docs/agent-development-guide.md](docs/agent-development-guide.md) | Agent 开发指南：流程、门禁、升级规则、角色、编码约束 |
| [docs/contracts/](docs/contracts/README.md) | 上报协议、事件 Schema、配置格式、埋点字典元模型 |
| [docs/decisions/](docs/decisions/README.md) | 范围决定与待确认事项 Q1–Q7 |
| [docs/tasks/board.md](docs/tasks/board.md) | 任务看板；任务卡见 `docs/tasks/Txx.md` |
| [docs/use-cases.md](docs/use-cases.md) | 公共 API 设计用例 |
| [tests/acceptance/](tests/acceptance/README.md) | 按需求编号编写的验收用例规格 |
| [docs/templates/](docs/templates/) | ADR、POC 报告、实施计划模板 |

总体设计方案（飞书）：<https://nwd4iy9rd2s.feishu.cn/docx/D9wXdUn8xooIu8x9RVDchSeanDg>

## 文档状态

| 类别 | 状态 | 关闭条件 |
|---|---|---|
| 契约 | 草案 v0.1 | T05–T07 评审通过，架构负责人批准后标记为“已冻结” |
| 待确认事项 | 已给出建议，未确认 | 确认人在对应决策文件中签署结论 |
| 任务卡 | 已发布 | 依赖验收后由 A00 把状态改为“可领取” |
| 验收用例 | 规格稿 | T08 完成后由 A09 转为可执行测试 |
