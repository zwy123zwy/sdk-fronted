/**
 * 冒烟：确认「仓库驱动 + 本机已装浏览器」这一组合能不能 launch（不下载任何东西）。
 * 用法：node tests/e2e/lib/smoke-browsers.mjs [chromium|firefox|webkit|all]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBrowser } from './browsers.mjs';

const which = process.argv[2] ?? 'chromium';
const names = which === 'all' ? ['chromium', 'firefox', 'webkit'] : [which];

for (const name of names) {
  const t0 = Date.now();
  let info;
  try {
    info = await resolveBrowser(name);
  } catch (error) {
    console.log(`${name}: RESOLVE-FAIL ${error.message}`);
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
    await ctx.close();
  } catch (error) {
    console.log(`${name}: LAUNCH-FAIL driver=${info.driverId} exe=${info.executablePath}`);
    console.log(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
