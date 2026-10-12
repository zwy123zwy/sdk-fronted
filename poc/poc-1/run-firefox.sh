#!/usr/bin/env bash
# T02 / POC-1：Firefox 一栏的**一次性**测量命令。
#
# 为什么需要单独跑：Firefox 主进程的 macOS `sandbox_init()` 无法嵌套在 DSH 的文件沙箱里，
# 在本会话（沙箱内）启动 Firefox 会卡在启动阶段（`-juggler-pipe` 始终没有握手输出）。
# **必须在非沙箱 shell 里执行本脚本。**
#
# 重要（实测教训，2026-10-12 修正）：不要给 Firefox 导出 `MOZ_DISABLE_*_SANDBOX` /
# `MOZ_FORCE_DISABLE_E10S` 这类变量——它们会破坏 Playwright 的 juggler 握手，表现为
# `launchPersistentContext: Timeout 60000ms exceeded`。本脚本**不设置任何 MOZ_* 变量**，
# 只依赖「在沙箱之外运行」这一点。去掉这些变量后，Firefox 在非沙箱 shell 里跑通了全部四类场景。
#
# 本脚本只做两件事：跑 POC 的四类场景、把结果写进 poc/poc-1/results-firefox/。
# 不安装任何东西、不访问外网（只连 127.0.0.1 的 M01 mock）。
#
# 用法（仓库根目录）：
#   bash poc/poc-1/run-firefox.sh
#
# 跑完后生成含 Firefox 列的报告表格：
#   node poc/poc-1/tables.mjs --dir poc/poc-1/results --dir poc/poc-1/results-firefox

set -u
cd "$(dirname "$0")/../.." || exit 1

echo "POC-1 Firefox 测量开始：$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "仓库根：$(pwd)"
echo "注意：本脚本必须在 DSH 文件沙箱之外运行；不要设置任何 MOZ_* 环境变量。"

node --import ./poc/poc-1/lib/register.mjs poc/poc-1/run.mjs \
  --browser firefox \
  --preset full \
  --out poc/poc-1/results-firefox
status=$?

echo "退出码：$status"
echo "结果目录：poc/poc-1/results-firefox/<runId>/"
exit "$status"
