/**
 * 冒烟：确认「仓库驱动 + 本机已装浏览器」这一组合能不能 launch（不下载任何东西）。
 *
 * 用法：`node tests/e2e/lib/smoke-browsers.mjs [all|chromium|firefox|webkit]`（默认 `chromium`）
 *
 * 取值口径：浏览器名**来自 `lib/browser-names.mjs`**（= `@playwright/test` 导出的 BrowserType，
 * 即 `lib/browsers.mjs` 解析、`lib/browser-availability.mjs` 探测所用的同一批名字），
 * 这里不再自己写一份 `['chromium','firefox','webkit']`；拼错的名字（`chrome`）会**报错并列出合法取值**，
 * 而不是被当成"某个浏览器"继续往下传、最后给出一条"本机没有可用组合"的误导性错误。
 *
 * 退出码（"不许静默"）：全部起来 → 0；任一没起来 → **1**（逐条打印 RESOLVE-FAIL / LAUNCH-FAIL
 * 与真实报错，再打一行汇总）；参数非法 → 2。此前这里无论成败都 exit 0——打完 `LAUNCH-FAIL`
 * 仍然是绿的，脚本调用方看不到任何差别。
 *
 * 本文件**不设**任何 `MOZ_*` 变量：Firefox 在本会话沙箱里 `sandbox_init()` EPERM 起不来，
 * 如实记 `LAUNCH-FAIL` 即可，不得靠环境变量"让它过"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_BROWSERS, DECLARED_BROWSERS, expandBrowserArg } from './browser-names.mjs';
import { resolveBrowser } from './browsers.mjs';

const usage = `用法：node tests/e2e/lib/smoke-browsers.mjs [${ALL_BROWSERS}|${DECLARED_BROWSERS.join('|')}]`;

const which = process.argv[2] ?? 'chromium';
let names;
try {
  names = expandBrowserArg(which);
} catch (error) {
  console.error(`${String(error?.message ?? error)}\n${usage}`);
  process.exit(2);
}

/** 每个浏览器的结局：`ok` 才算过；另两种都必须在汇总里点名。 */
const outcomes = [];

for (const name of names) {
  const t0 = Date.now();
  let info;
  try {
    info = await resolveBrowser(name);
  } catch (error) {
    console.log(`${name}: RESOLVE-FAIL ${error.message}`);
    outcomes.push({ name, status: 'resolve-fail' });
    continue;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-smoke-${name}-`));
  try {
    const ctx = await info.playwright[name].launchPersistentContext(dir, {
      headless: true,
      executablePath: info.executablePath,
      timeout: 45_000,
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('about:blank');
    const ua = await page.evaluate(() => globalThis.navigator.userAgent);
    console.log(`${name}: OK driver=${info.driverId} exe=${info.executablePath}`);
    console.log(`${name}: ua=${ua} (${Date.now() - t0} ms)`);
    outcomes.push({ name, status: 'ok' });
    await ctx.close();
  } catch (error) {
    console.log(`${name}: LAUNCH-FAIL driver=${info.driverId} exe=${info.executablePath}`);
    console.log(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')}`);
    outcomes.push({ name, status: 'launch-fail' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const failed = outcomes.filter((item) => item.status !== 'ok');
console.log(
  `\n冒烟汇总：ok=${outcomes.length - failed.length} failed=${failed.length}（${names.join('、')}）`,
);
if (failed.length > 0) {
  console.error(
    `⚠ 以下浏览器在本机**起不来**（不是"通过"）：` +
      `${failed.map((item) => `${item.name}（${item.status}）`).join('、')}；` +
      '逐条真实报错见上。补测：在能起该引擎的机器上重跑（不得设置任何 `MOZ_*`）。',
  );
  process.exitCode = 1;
}
