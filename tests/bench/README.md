# T20 受控性能基准（`tests/bench/`）

本目录是 **T20「客户端性能基准与体积报告」** 的所有权目录，是各包 `perf.test.ts` 里
「契约目标值的权威验证归 T20」所指的**权威验证方**（清单见 `docs/reports/handover.md` 第 2 节 T20 小节）。

## 1. 这不是回归门禁

根 `vitest.config.ts` 的 `unit` / `contract` / `security` 三个 project **不包含** `tests/bench/**`，
因此 `pnpm test` 与 `pnpm gates` **不会**运行这里的任何文件。这是刻意的：

- ① **达标判定**（相对契约目标值）是本任务要回答的问题，作为**数据**记录在报告与
  `results/*.json` 里，**不用来阻断**任何流程；
- ② **趋势对比**（与历史值）用 `results/history.jsonl` 的方差报告，**同样不是门禁**；
- 只有「测量完整性」的断言会失败（样本量、正断言、队列确实被填满等）——也就是说，
  基准失败只意味着**测错了**，不意味着**实现退化了**。

各包 `src/**/perf.test.ts` 只保留带余量的中位数回归护栏，契约目标值的判定在这里。

## 2. 怎么跑

```bash
# 时间基准（受控：node 环境、串行、单 worker）
BENCH_RUN_ID=run-1 BENCH_CPU="$(sysctl -n machdep.cpu.brand_string)" \
  pnpm exec vitest run --config tests/bench/vitest.config.ts --coverage.enabled=false

# 体积基准（读已有 dist，不重建任何包；加载桩用 tsup 单文件打包到本目录临时区）
BENCH_RUN_ID=run-1 node tests/bench/size.mjs

# 合并基线 + 多次运行方差（结果写入 results/baseline.json）
node tests/bench/collect.mjs
BENCH_RUNS=run-1,run-3 node tests/bench/collect.mjs   # 只看没被同机负载污染的运行
```

**没有新增 npm script**：`test:bench` 之类属门禁配置变更，需负责人批准后由编排方添加
（见本任务的硬要求）。上面的命令可直接执行，不需要改 `package.json`。

## 3. 文件

| 文件 | 作用 |
|---|---|
| `vitest.config.ts` | 基准专用配置：`environment: node`、`fileParallelism: false`、`maxWorkers: 1`、关覆盖率 |
| `lib/stats.ts` | 稳健统计量：min / P50 / P95 / P99、分轮中位数、吞吐；**不含「总耗时」** |
| `lib/report.ts` | 报告收集器：打印「指标 + 统计量 + 样本量 + 契约目标 + 余量 + 达标判定」，写 `results/*.json` 与 `history.jsonl` |
| `lib/entries.ts` | 各包真实入口的**变量说明符动态 import**（原因见文件头：根 tsconfig 的 lib 与包不同，静态导入会让 `pnpm typecheck` 失败） |
| `lib/fixtures.ts` | 夹具：只用格式合法的**伪造**数据（保留示例域名 / 文档号段） |
| `lib/memory.ts` | 三种内存口径：JSON 码元数（仓库体积口径）、UTF-16×2 上界、堆增量上界 |
| `c01-track.bench.ts` | C01 `track` P99 / 吞吐 / 命令队列 200 条 push |
| `c02-kernel.bench.ts` | C02 初始化、六段管线、预启动队列内存（500 条） |
| `c03-config-sampling.bench.ts` | C03 三级合并、采样判定 P99、空管线对照 |
| `c04-privacy.bench.ts` | C04 字段约束 + 脱敏、脱敏器随长度成本曲线、上下文富化 |
| `c06-queue.bench.ts` | C06 入队 P99、单批组装 + 序列化、满载队列常驻内存 |
| `c07-offline.bench.ts` | C07 `prewrite` 同步阻塞、异步落盘 P50/P95 |
| `c08-monitor.bench.ts` | C08 单次计数操作、整窗映射、自监控流量占比（真实产出） |
| `k02-signer.bench.ts` | K02-AC-09 进程内签名 / 验签各 100 次 |
| `size.mjs` | 体积：加载桩压缩 IIFE、各包产物按 **size-limit 口径**（打包 + minify）后 gzip |
| `collect.mjs` | 合并 `results/*.json` → `results/baseline.json`，并按运行计算方差 |
| `results/` | 基线数据：`<bench>.json`（最近一次）、`history.jsonl`（追加历史）、`baseline.json`（合并） |

## 4. 口径红线

1. **不用「总耗时」**：vitest 并行跑测试文件时总耗时会被 GC/调度抖动灌满。用中位数/最小值/P99，
   并且把「每 N 条一组」的组耗时也取**中位数**再判定批量目标。
2. **契约目标不达标不让基准失败**：它进入报告与升级清单（T20.md 要求「列在报告中并升级」），
   **不得**为了达标而改测量方法。
3. **内存分口径**：`JSON 码元数`（`event-standard.md` 第 4 节，V8 对 Latin-1 字符串按 1 B/码元）、
   `UTF-16×2` 上界、`process.memoryUsage().heapUsed` 增量上界。**堆增量未强制 GC，曾在一次运行里
   出现负值（测量期间发生 GC）**，因此它只作参考，绝不用来判定契约目标。
4. **真实浏览器 / 真机项归 T29**：真实长任务（`PerformanceObserver`）、真实 80 KB 信标、
   真实 `visibilitychange`、真机 IndexedDB 落盘、Chromium 里的 K02 发布物验签等，
   本目录只给 **node / happy-dom 本机数字**，并在报告中逐条标注。
5. **只读实现**：本目录不修改 `packages/*/src/**`；体积基准只读磁盘上**已有**的 `dist/`
   （并报告产物是否比源码旧），不重建任何包。
