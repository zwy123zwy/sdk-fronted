/**
 * T30 真实浏览器复核的**跨平台定位 + 证据形状**（`tests/compat/scripts/` 共用）。
 *
 * 复用什么：`examples/webpack/scripts/lib/chromium-locate.mjs` —— 本仓**已经是**跨平台的那一份实现
 * （2026-10-15 修好，`docs/reports/e2e-real-browser.md` §6）：定位顺序是
 *
 *   1. `PW_CHROMIUM_EXE`（显式指定）；
 *   2. `chromium.executablePath()`（Playwright 自己算出来的、当前平台/架构下期望的二进制）；
 *   3. 本机 ms-playwright 缓存里按 revision 从新到旧的已装构建（缓存根按平台算，也尊重
 *      `PLAYWRIGHT_BROWSERS_PATH`），只认 Playwright 自己的目录布局；
 *
 * 且**候选存在不算数，真的 `launch()` 成功才算数**。
 *
 * 为什么是「import 它」而不是「在本目录再写一份」：本任务要消灭的正是"同一个定位逻辑有两份实现"
 * 的漂移——`tests/compat/scripts/{browser-core-path,vite-dev-server}.mjs` 此前各写死一条
 * `$HOME/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/…`，与 webpack 脚本修前**同型**。
 * 再抄一份只会把同一串平台路径重新散布到第三个地方。该模块只 import `node:fs/os/path`，不依赖
 * `examples/webpack` 的 node_modules，所以 `tests/**` 直接引用它不需要任何额外安装。
 *
 * 为什么不把共享模块放到"两边都能 import 的中立位置"（例如 `scripts/lib/`）：那需要让
 * `examples/webpack/scripts/**` 也改成 import 新位置，而本轮**不允许改 `examples/**`**
 * （该目录已合入、属别处）。等下一次有人动 `examples/webpack/scripts/**` 时，把实现搬到中立位置、
 * 两边同时 import 才是终局；在那之前，**tests 单向复用 examples 的已修实现**比复制更不容易漂移。
 * 这一点写进了 `docs/reports/compat-matrix.md` 的追加节（含"为什么不复制一份"的理由）。
 *
 * 定位不到时**绝不假装有**：返回 `browser === null` + `attempts`（每个候选与真实报错），
 * 调用方必须把结论写成 `browser.status='blocked'`、整体 `status='blocked'`、**exit 1**。
 * （`tests/e2e/lib/skip-audit.mjs` 的 `skipUnavailableBrowser()` 是 Playwright 用例专用的跳过入口，
 * 依赖 `testInfo`；这两个是**独立 CLI 证据脚本**，没有 `testInfo`，所以走"证据 JSON + 终端告警 +
 * 非零退出码"这一条等价的显式记账路径。）
 */
import { createRequire } from 'node:module';

import { chromium } from '@playwright/test';

import {
  resolveLaunchableChromium,
  unavailableReason,
} from '../../../../examples/webpack/scripts/lib/chromium-locate.mjs';

/** 仓库锁定的 `@playwright/test` 版本（进证据 JSON，便于与驱动/浏览器配对关系对照）。 */
export function playwrightDriverVersion() {
  try {
    const require = createRequire(import.meta.url);
    const parsed = require('@playwright/test/package.json');
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Playwright 自己算出来的期望路径（当前平台/架构/`PLAYWRIGHT_BROWSERS_PATH` 下），不是拼出来的。 */
function expectedChromiumPath() {
  try {
    const value = chromium.executablePath();
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * 定位并**真启动**一个 Chromium。
 *
 * @param {(line: string) => void} [log] 逐候选的定位日志（进 stdout，便于审计）
 * @returns {Promise<{ browser: object|null, executablePath: string|null, source: string|null,
 *   attempts: Array<{ path: string, source: string, error: string|null }>, reason: string,
 *   status: 'pass'|'blocked' }>}
 */
export async function launchChromium(log = () => {}) {
  const attempts = [];
  const legacy = legacyChromiumPath();
  if (legacy !== null) {
    // 旧名字仍识别（见 `legacyChromiumPath()` 的注释），但先打一次弃用告警。
    warnLegacyEnv();
    try {
      const browser = await chromium.launch({ executablePath: legacy });
      attempts.push({ path: legacy, source: LEGACY_SOURCE, error: null });
      log(`[chromium-locate] 可用：${LEGACY_SOURCE} → ${legacy}`);
      return {
        browser,
        executablePath: legacy,
        source: `${LEGACY_SOURCE}，请改用 ${CHROMIUM_EXE_ENV}`,
        attempts,
        status: 'pass',
        reason: '',
      };
    } catch (error) {
      const message = String(error?.message ?? error).split('\n')[0].slice(0, 300);
      attempts.push({ path: legacy, source: LEGACY_SOURCE, error: message });
      log(`[chromium-locate] 启动失败 ${LEGACY_SOURCE}：${message}`);
    }
  }

  const located = await resolveLaunchableChromium({
    launch: (options) => chromium.launch(options),
    playwrightPath: expectedChromiumPath(),
    log,
  });
  const merged = [...attempts, ...located.attempts];
  const available = located.browser !== null;
  return {
    ...located,
    attempts: merged,
    status: available ? 'pass' : 'blocked',
    reason: available ? '' : unavailableReason(merged),
  };
}

/** 统一的"显式指定可执行文件"变量名（与 `tests/e2e/lib/browsers.mjs`、`examples/webpack` 同名）。 */
export const CHROMIUM_EXE_ENV = 'PW_CHROMIUM_EXE';

/** 已弃用的旧变量名（只有 `browser-core-path.mjs` 曾经认它，未文档化）。 */
export const LEGACY_CHROMIUM_ENV = 'T30_CHROMIUM_PATH';

const LEGACY_SOURCE = `env ${LEGACY_CHROMIUM_ENV}（已弃用）`;

let legacyWarned = false;

/**
 * 旧变量 `T30_CHROMIUM_PATH` 仍然识别——**保留而不是删掉**。
 *
 * 理由（裁定 (c)）：它未文档化，但"未文档化"不等于"没人用"。若直接不再识别，某个人的本机脚本会从
 * "能跑"变成"定位不到"，而且**症状是"没有证据/跳过"而不是报错**——按本仓口径，"跳过"最容易被忽略。
 * 一行 warn 的代价远小于一次静默失效。新名字 `PW_CHROMIUM_EXE` 优先；两者都设时只用新名字。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function legacyChromiumPath(env = process.env) {
  const legacy = env[LEGACY_CHROMIUM_ENV];
  if (typeof legacy !== 'string' || legacy === '') return null;
  const canonical = env[CHROMIUM_EXE_ENV];
  if (typeof canonical === 'string' && canonical !== '') return null; // 新名字优先
  return legacy;
}

/** 弃用告警（同一进程只打一次，不刷屏）。 */
function warnLegacyEnv() {
  if (legacyWarned) return;
  legacyWarned = true;
  console.warn(
    `⚠ [T30] 环境变量 ${LEGACY_CHROMIUM_ENV} 已弃用：本次仍按它定位，但请改用 ` +
      `${CHROMIUM_EXE_ENV}（与 tests/e2e、examples/webpack 同名）。旧名字在后续版本可能被移除，` +
      '届时症状是"定位不到/没有证据"，而不是报错。',
  );
}

/**
 * 进证据 JSON 的浏览器记账（成功也带 source/executablePath，可审计"用的是什么跑出来的"）。
 * @param {Awaited<ReturnType<typeof launchChromium>>} located
 */
export function browserEvidence(located) {
  return {
    status: located.status,
    engine: 'chromium',
    driver: `@playwright/test@${playwrightDriverVersion() ?? 'unknown'}`,
    executablePath: located.executablePath,
    source: located.source,
    reason: located.reason,
    attempts: located.attempts,
  };
}

/**
 * 定位不到时的**显式**终端告警（不许静默）。返回打出去的文本，调用方可以原样写进证据 JSON。
 *
 * @param {Awaited<ReturnType<typeof launchChromium>>} located
 * @param {string} target 这次要产出什么（进文案）
 * @returns {string}
 */
export function warnUnavailable(located, target) {
  const lines = [
    `⛔ [T30] 没有可用的 Chromium：${target} 的浏览器结论**本次未产出**（不记为 pass，exit 1）。`,
    '   定位顺序：PW_CHROMIUM_EXE → chromium.executablePath() → 本机 ms-playwright 缓存（每个候选都真启动一次）。',
  ];
  for (const attempt of located.attempts) {
    lines.push(`   尝试：${attempt.source} → ${attempt.path}（${attempt.error ?? '可用'}）`);
  }
  lines.push(
    '   补测：`pnpm exec playwright install chromium`（下载当前 @playwright/test 期望的构建），' +
      '或设 PW_CHROMIUM_EXE=/path/to/chrome；缓存不在默认位置时用 PLAYWRIGHT_BROWSERS_PATH 指定。',
  );
  const text = lines.join('\n');
  console.error(text);
  return text;
}
