/**
 * 浏览器可用性：**真启动探测** + 探测结果记账 + "能不能起"的唯一判据。
 *
 * 为什么把它单独一个文件：`leave-slice.spec.mjs` 与 `beacon-quota.spec.mjs` 必须用**同一套**口径回答
 * "这个浏览器在本机能不能跑"。两份实现会让"能跑就跑"漂移成两套判据，也会让"跳过不可静默"出现
 * 两处登记入口。**跳过本身仍然只有唯一入口**：`lib/skip-audit.mjs` 的 `skipUnavailableBrowser()`
 * ——本文件只负责**探测 + 记账 + 生成理由文本**，从不调用 `test.skip`（`test.skip` 只允许出现在
 * `skip-audit.mjs` 里，见 `eslint.config.js` 的窄规则）。
 *
 * 为什么必须是"真启动"而不是"二进制存在"：本机沙箱下 `resolveBrowser('firefox')` 是**成功**的
 * （chromium-1223 / firefox-1522 / webkit-2287 都在缓存里），失败发生在 launch 阶段——firefox 会打出
 * "Juggler listening to the pipe" 然后卡到超时。用"能不能解析出可执行文件"当判据，会把"起不来"
 * 错判成"能跑"（实测教训，见 `docs/reports/e2e-real-browser.md`）。
 *
 * 判据里**没有**任何 `browserName` 名单：可用就真的跑，不可用才登记跳过。
 *
 * 判别性证明用的**测试钩子**：`E2E_FORCE_RUN_BROWSER=<name>`（旧名 `AC03_FORCE_RUN_BROWSER` 仍识别）
 * 让该浏览器被当作"能跑"，于是用例会**真的去启动**并在起不来时**真红** —— 用来证明"这条跳过是
 * 环境判据，不是写死的引擎名单"（写死跳过的旧代码在该浏览器上**恒**跳过）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBrowser } from './browsers.mjs';
import { killMatching, launchPersistent, profilePids } from './harness.mjs';

/** 单行化 + 限长的真实报错（探测失败原因要能直接进报告）。 */
export function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0].slice(0, 400);
}

/** 强制走"能跑"分支的浏览器名（判别性证明钩子）；未设置时是空串。 */
function forcedBrowserName() {
  return process.env['E2E_FORCE_RUN_BROWSER'] ?? process.env['AC03_FORCE_RUN_BROWSER'] ?? '';
}

/**
 * 真启动探测：解析 → 启动 → 关闭。只有**启动**成功才算能跑。
 *
 * 启动与关闭**分开**：探测已经启动成功之后，只要关闭阶段报错（headless 退出抖动、进程被回收等），
 * 旧写法会把整条记成"起不来"而跳过 —— 那会把**能跑**的浏览器误判成不可用。现在启动成功即
 * `ready: true`，关不上只记 `note`。
 *
 * @param {'chromium'|'firefox'|'webkit'} browserName
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<{ browserName: string, ready: boolean, stage: string, driver: string|null,
 *   reason: string, note: string, forced?: boolean }>}
 */
export async function probeBrowser(browserName, options = {}) {
  let info;
  try {
    info = await resolveBrowser(browserName);
  } catch (error) {
    return { browserName, ready: false, stage: 'resolve', driver: null, reason: firstLine(error), note: '' };
  }
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-probe-${browserName}-`));
  let closeNote = '';
  try {
    // 比正式用例的 60 s 短：探测只回答"能不能起来"，不承担正式用例的等待预算。
    const context = await launchPersistent(info, probeDir, { timeout: options.timeout ?? 20_000 });
    // 关键：启动成功即"能跑"；关闭阶段的异常**不得**把能跑的浏览器误判成起不来。
    try {
      await context.close();
    } catch (error) {
      closeNote = `探测后关闭 context 报错（不影响"能跑"判定）：${firstLine(error)}`;
    }
    return { browserName, ready: true, stage: 'launch', driver: info.driverId, reason: '', note: closeNote };
  } catch (error) {
    return { browserName, ready: false, stage: 'launch', driver: info.driverId, reason: firstLine(error), note: '' };
  } finally {
    killMatching(profilePids(probeDir));
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * 建一个"每个浏览器只探测一次"的可用性缓存（返回的 `ready()` 是纯函数式的查询）。
 *
 * 用闭包而不是模块级 Map：两个 spec 各自持有一份缓存，互不干扰（Playwright 的 worker 进程本来
 * 也不共享状态）。
 *
 * @param {{ log?: (line: string) => void, timeout?: number, tag?: string }} [options]
 */
export function createBrowserAvailability(options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const tag = options.tag ?? 'e2e-probe';
  const cache = new Map();

  return {
    /** @param {'chromium'|'firefox'|'webkit'} browserName @returns {Promise<object>} */
    async ready(browserName) {
      const cached = cache.get(browserName);
      if (cached !== undefined) return cached;
      let entry = await probeBrowser(browserName, { timeout: options.timeout });
      // 判别性证明钩子（不影响正常路径）：置为该浏览器名时假装"起得来"，让用例真的去跑。
      if (forcedBrowserName() === browserName) {
        log(
          `[E2E_FORCE_RUN_BROWSER] 强制按"能跑"执行 [${browserName}]（真实探测 ready=${String(entry.ready)}，` +
            `原因：${entry.reason === '' ? '无' : entry.reason}）`,
        );
        entry = { ...entry, ready: true, reason: '', forced: true };
      }
      cache.set(browserName, entry);
      log(
        `[${tag}] [${browserName}] ready=${String(entry.ready)} stage=${entry.stage} driver=${String(entry.driver)}` +
          `${entry.reason === '' ? '' : ` reason=${entry.reason}`}${entry.note === '' ? '' : ` note=${entry.note}`}`,
      );
      return entry;
    },
  };
}

/**
 * 该浏览器起不来就登记跳过——**显式、带理由**（不是按引擎名单的静默跳过）。
 *
 * 本函数**不**调用 `test.skip`：跳过只允许出现在 `lib/skip-audit.mjs`（eslint 窄规则）。
 *
 * @param {string} browserName
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {object} probe `createBrowserAvailability().ready()` 的返回值
 * @param {{ noteProbe: (name: string, probe: object) => void,
 *   skipUnavailableBrowser: (name: string, info: object, probe: object, note: string) => boolean }} skipAudit
 * @returns {boolean} 是否登记了跳过
 */
export function requireBrowser(browserName, testInfo, probe, skipAudit) {
  // 探测结果**无论可用与否**都要记账：汇总/JSON 要靠它区分"能跑却没跑"与"起不来才跳过"。
  skipAudit.noteProbe(browserName, probe);
  if (probe.ready) return false;
  const note =
    `${browserName} 在本机起不来（探测阶段=${probe.stage}，驱动=${String(probe.driver)}），本用例无法执行：${probe.reason}。` +
    `补测：换一台能起 ${browserName} 的机器（或 PW_${browserName.toUpperCase()}_EXE=/path/to/binary）` +
    `后重跑 \`pnpm test:e2e --project=${browserName}\`。`;
  // 跳过登记进审计（含真实原因）；输出/报告可见性、旁路跳过判红、整 spec 全跳过判红都在那里。
  return skipAudit.skipUnavailableBrowser(browserName, testInfo, probe, note);
}
