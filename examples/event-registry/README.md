# K01 示例注册表

给 T12、T34 与接入方参考的最小可用事件注册表，用于验证 K01 的四条子命令。所有取值都是占位值，
不含真实个人信息、令牌或密钥。

```
events/                            事件定义（接入方自己维护，K01 只读）
  page_view.v1.json                normal
  media_play_start.v1.json         normal，含 boolean 维度
  media_play_progress.v1.json      normal
  media_play_stall.v1.json         normal
  media_play_complete.v1.json      normal
  media_quality_change.v1.json     normal
  search_submit.v1.json            normal
  search_result_click.v1.json      normal
  checkout_order_complete.v1.json   critical
  checkout_order_complete.v2.json   critical（多版本，支撑 K01-F5 的"最近 3 版"）
  checkout_order_complete.v3.json   critical（最新版本，K01-F4 只生成这一版）
  editor_draft_saved.v1.json       normal，draft 状态（K01-F4 不生成类型）
observed-events.sample.jsonl       接收方导出的事件名清单样例（K01-F6 的输入）
```

规模：12 个文件 / 10 个事件名 / 1 个 critical（10%，恰好等于 Q3 的配额上限）。

## 用法

在仓库根目录执行（`--registry` 默认 `events/*.json`）：

```bash
# 1) 校验 + critical 配额 + 兼容性
web-report-event-registry check --registry examples/event-registry/events

# 2) 生成 TypeScript 类型声明（只含 active 事件的最新版本）
web-report-event-registry generate \
  --registry examples/event-registry/events \
  --out examples/event-registry/generated/events.d.ts

# 3) 导出接收方运行期校验规则（每个事件保留最近 3 个版本）
web-report-event-registry export-rules \
  --registry examples/event-registry/events \
  --out examples/event-registry/generated/rules.json \
  --registry-name demo-app

# 4) 未登记事件报告（退出码 0）
web-report-event-registry report-unregistered \
  --registry examples/event-registry/events \
  --events examples/event-registry/observed-events.sample.jsonl

# 5) CI 中对比 git 基线
web-report-event-registry check \
  --registry events/*.json \
  --baseline-git origin/main
```

完整选项与退出码见 `tools/event-registry/README.md`。
