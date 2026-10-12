# Q4 技术栈

- 状态：已确认（依据 D001 缩小范围）
- 确认人：wenye.zhang
- 确认日期：2026-10-09

## 问题

原问题是部署环境与服务端技术栈的选型。D001 决定只做浏览器 SDK 后，服务端选型不在本项目内，只剩 SDK 仓库和开发工具的技术栈需要确定。

## 结论

| 领域 | 结论 | 说明 |
|---|---|---|
| SDK 语言 | TypeScript（strict） | 总体方案已定 |
| 包管理 | pnpm workspace | 版本由 T08 锁定 |
| 打包 | tsup | 配置简单，同时产出 ESM、CJS（可选）、IIFE 和类型声明；体积不达标时由 T08 改用 Rollup，属于 T08 的决定，不需要重新确认 Q4 |
| 单元测试 | Vitest + jsdom / happy-dom | |
| 浏览器测试 | Playwright（Chromium、Firefox、WebKit） | E2E、兼容性、可靠性对账 |
| 体积预算 | size-limit | |
| API 审计 | API Extractor | |
| Lint | ESLint（typescript-eslint，type-aware 规则） | |
| JSON Schema 校验 | Ajv（2020-12） | 只用于开发与测试，不进入 SDK 运行时 |
| 开发工具 K01、K02、M01 | Node.js 24（T08 修订：Vitest 5 要求 Node ≥ 22.12），TypeScript，放在本仓库 `tools/` 下 | 不引入服务端框架；M01 只用 Node 内置 `http` 模块，加上一个可选的 gzip 解压 |
| CI | 由 T08 根据代码托管平台决定 | |
| 发布渠道 | 由 T08 决定（私有 npm 源优先） | 首次发布由人工执行 |

服务端相关的候选与评估标准保留在总体方案的“关键技术选型”一节，供日后另行立项时参考。

## 如果以后要做服务端

新开一条决策记录（D002），恢复原 Q4 的服务端候选表，并按 POC 结果确定。本记录不需要修改。
