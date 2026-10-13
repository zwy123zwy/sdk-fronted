#!/usr/bin/env bash
# T02 / POC-1 追加轮：**Firefox 的存储落盘窗口测量**（一次性命令）。
#
# 为什么需要单独跑：Firefox 主进程的 macOS `sandbox_init()` 无法嵌套在 DSH 的文件沙箱里，
# 在沙箱内启动 Firefox 会卡在启动阶段（`-juggler-pipe` 始终没有握手输出）。
# **必须在非沙箱 shell 里执行本脚本。**
#
# 重要（POC-1 的实测教训）：不要给 Firefox 导出 `MOZ_DISABLE_*_SANDBOX` /
# `MOZ_FORCE_DISABLE_E10S` 这类变量——它们会破坏 Playwright 的 juggler 握手，表现为
# `launchPersistentContext: Timeout 60000ms exceeded`。本脚本**不设置任何 MOZ_* 变量**。
#
# 测量内容（与 Chromium/WebKit 完全相同的一套格子）：
#   storage        3 种存储 × 8 个 Δt 点 + 4 个对照格，每格 2 次试验 × 500 条 = 1000 条样本
#   storage-multitab  4 种存储 × 3 轮 × 3 标签页 × 200 条（并发写）
#   storage-perf      4 种存储的写入耗时 / 配额
# 并重复 3 次独立运行（POC-1 的教训：同一延迟点的存活率会出现分歧，单次运行不足以支撑结论）。
#
# 用法（仓库根目录）：
#   bash poc/poc-1/run-storage-firefox.sh

set -u
cd "$(dirname "$0")/../.." || exit 1

echo "POC-1 追加轮 Firefox 存储测量开始：$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "仓库根：$(pwd)"
echo "注意：必须在 DSH 文件沙箱之外运行；不要设置任何 MOZ_* 环境变量。"

node --import ./poc/poc-1/lib/register.mjs poc/poc-1/run.mjs \
  --browser firefox \
  --scenario storage-all \
  --preset full \
  --runs 3 \
  --out poc/poc-1/results-storage-firefox
status=$?

echo "退出码：$status"
echo "结果目录：poc/poc-1/results-storage-firefox/<runId>/"
exit "$status"
