/**
 * `lib/browsers.mjs` 的**跨平台定位**判据的确定性自检（不需要真实浏览器、不需要 Linux）。
 *
 * 为什么需要它：本机是 macOS + 已装 chromium-1223，`resolveBrowser()` 在本机走的是
 * "树外驱动精确配对"那条（分支 2）——**平台缓存根 / 构建内布局这两条恰恰在本机测不到**。
 * 而本轮修的正是这两条（写死 `~/Library/Caches` 与 macOS arm64 布局 ⇒ Linux CI 上必然定位不到）。
 * 所以这里把"平台"与"缓存根"做成**注入参数**，用夹具把三件事钉住：
 *
 *   1. 缓存根按平台算：Linux → `~/.cache/ms-playwright`（或 `$XDG_CACHE_HOME`）、
 *      Windows → `%LOCALAPPDATA%\ms-playwright`、macOS → `~/Library/Caches/ms-playwright`；
 *   2. 构建内布局**从 Playwright 的 `executablePath()` 推导**：Linux 形状的期望路径
 *      （`…/chromium-1248/chrome-linux/chrome`）只换 revision 就能命中已装构建，
 *      不需要任何平台布局表；
 *   3. 端到端两条分支：`PLAYWRIGHT_BROWSERS_PATH` 指到假缓存时
 *      - 分支 3（仓库驱动期望路径）命中；
 *      - 只有**别的 revision** 时，分支 4（缓存扫描 + 布局推导）命中。
 *
 * 还有 `lib/browser-names.mjs` 的词汇表：`all` 展开、拼错的名字必须**报错并列出合法取值**。
 *
 * 跑法：`node tests/e2e/lib/browser-locate-selftest.mjs`（exit 0 = 全过）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failures = [];
let passed = 0;

/** 一条断言：`ok` 为真即通过；否则把 `detail` 记进失败清单。 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`ok   ${name}`);
    return;
  }
  failures.push(`${name}${detail === undefined ? '' : `：${detail}`}`);
  console.log(`FAIL ${name}${detail === undefined ? '' : `：${detail}`}`);
}

/** 断言抛错且消息里包含关键文本（"报错而不是静默"的判据）。 */
function checkThrows(name, run, expectedText) {
  try {
    run();
    check(name, false, '没有抛错（本应显式报错）');
  } catch (error) {
    const message = String(error?.message ?? error);
    check(name, message.includes(expectedText), `报错文本里没有 ${JSON.stringify(expectedText)}：${message}`);
  }
}

/* ---------------------------------------------------------------- 假缓存：模拟"非默认缓存根 + 非本平台布局" */

const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-locate-selftest-'));
const fakeCache = path.join(fakeRoot, 'ms-playwright');
/** 在假缓存里造一个"已装构建"：`<cache>/<build>/<tail>`（`tail` 用 Linux 形状）。 */
function makeFakeBuild(build, tail) {
  const exe = path.join(fakeCache, build, ...tail.split('/'));
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', 'utf8');
  return exe;
}

async function main() {
  // `resolveBrowser()` 在调用时才读 `PLAYWRIGHT_BROWSERS_PATH`（`chromium.executablePath()` 也读它），
  // 所以先设环境变量、再动态 import —— 这样自检不会碰到本机真实缓存里的构建。
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = fakeCache;
  delete process.env['PW_CHROMIUM_EXE'];
  delete process.env['PW_FIREFOX_EXE'];
  delete process.env['PW_WEBKIT_EXE'];
  const browsers = await import('./browsers.mjs');
  const names = await import('./browser-names.mjs');

  /* ------------------------------------------------------------ 1. 缓存根：平台口径 */

  const home = '/home/ci';
  check(
    'linux：默认缓存根是 ~/.cache/ms-playwright（不是 ~/Library/Caches）',
    browsers.cacheRootForPlatform('linux', {}, home) === path.join(home, '.cache', 'ms-playwright'),
    String(browsers.cacheRootForPlatform('linux', {}, home)),
  );
  check(
    'linux：尊重 $XDG_CACHE_HOME',
    browsers.cacheRootForPlatform('linux', { XDG_CACHE_HOME: '/xdg' }, home) ===
      path.join('/xdg', 'ms-playwright'),
    String(browsers.cacheRootForPlatform('linux', { XDG_CACHE_HOME: '/xdg' }, home)),
  );
  check(
    'darwin：~/Library/Caches/ms-playwright',
    browsers.cacheRootForPlatform('darwin', {}, home) ===
      path.join(home, 'Library', 'Caches', 'ms-playwright'),
    String(browsers.cacheRootForPlatform('darwin', {}, home)),
  );
  check(
    'win32：%LOCALAPPDATA%\\ms-playwright',
    browsers.cacheRootForPlatform('win32', { LOCALAPPDATA: '/win-local' }, home) ===
      path.join('/win-local', 'ms-playwright'),
    String(browsers.cacheRootForPlatform('win32', { LOCALAPPDATA: '/win-local' }, home)),
  );
  check(
    'win32：没有 LOCALAPPDATA 时退回 %USERPROFILE%\\AppData\\Local',
    browsers.cacheRootForPlatform('win32', {}, home) ===
      path.join(home, 'AppData', 'Local', 'ms-playwright'),
    String(browsers.cacheRootForPlatform('win32', {}, home)),
  );
  check(
    '未知平台返回 null（调用方据此显式记账，不猜）',
    browsers.cacheRootForPlatform('aix', {}, home) === null,
    String(browsers.cacheRootForPlatform('aix', {}, home)),
  );
  check(
    'PLAYWRIGHT_BROWSERS_PATH 优先于平台默认根',
    browsers.defaultCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: '/custom' }, 'linux', home) === '/custom',
    String(browsers.defaultCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: '/custom' }, 'linux', home)),
  );
  check(
    'PLAYWRIGHT_BROWSERS_PATH=0（装进包内）时退回平台默认根',
    browsers.defaultCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: '0' }, 'linux', home) ===
      path.join(home, '.cache', 'ms-playwright'),
    String(browsers.defaultCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: '0' }, 'linux', home)),
  );

  /* ------------------------------------------------------------ 2. 布局：从 executablePath() 推导，无平台表 */

  const linuxExpected = '/home/ci/.cache/ms-playwright/chromium-1248/chrome-linux/chrome';
  check(
    '从期望路径反推缓存根（Linux 形状）',
    browsers.cacheRootFromBrowserPath(linuxExpected) === '/home/ci/.cache/ms-playwright',
    String(browsers.cacheRootFromBrowserPath(linuxExpected)),
  );
  check(
    '构建内相对路径 = 期望路径去掉 <name>-<revision> 段（Linux 形状）',
    browsers.executableTail('chromium', linuxExpected) === 'chrome-linux/chrome',
    String(browsers.executableTail('chromium', linuxExpected)),
  );
  check(
    '构建内相对路径（Firefox 形状，含 .app 包）',
    browsers.executableTail(
      'firefox',
      '/home/ci/.cache/ms-playwright/firefox-1555/firefox/Nightly.app/Contents/MacOS/firefox',
    ) === 'firefox/Nightly.app/Contents/MacOS/firefox',
    String(
      browsers.executableTail(
        'firefox',
        '/home/ci/.cache/ms-playwright/firefox-1555/firefox/Nightly.app/Contents/MacOS/firefox',
      ),
    ),
  );
  check(
    '推导不出时返回 null（不瞎指路径）',
    browsers.executableTail('chromium', '') === null && browsers.executableTail('chromium', '/nope') === null,
  );

  const fakeBuild = makeFakeBuild('chromium-9999', 'chrome-linux/chrome');
  check(
    '已装构建 + Linux 形状的期望路径 → 命中（只换 revision）',
    browsers.executableInBuild('chromium', path.join(fakeCache, 'chromium-9999'), linuxExpected) === fakeBuild,
    String(browsers.executableInBuild('chromium', path.join(fakeCache, 'chromium-9999'), linuxExpected)),
  );
  check(
    '构建里没有那个相对路径 → null（不假装有）',
    browsers.executableInBuild('chromium', path.join(fakeCache, 'chromium-9999'), '/x/chromium-1248/chrome-win/chrome.exe') === null,
  );
  check(
    'installedBuildDirs 只认 <name>-<纯数字> 目录，且能扫到非默认根',
    JSON.stringify(browsers.installedBuildDirs('chromium', [fakeCache]).map((item) => item.build)) ===
      JSON.stringify(['chromium-9999']),
    JSON.stringify(browsers.installedBuildDirs('chromium', [fakeCache])),
  );

  /* ------------------------------------------------------------ 3. 端到端：假缓存上的两条命中分支 */

  const expectedForFakeRoot = (await browsers.loadRepoPlaywright()).chromium.executablePath();
  check(
    'Playwright 的 executablePath() 跟着 PLAYWRIGHT_BROWSERS_PATH 走（假缓存根）',
    expectedForFakeRoot.startsWith(fakeCache),
    expectedForFakeRoot,
  );

  // 分支 4：假缓存里只有**别的 revision**（9999），仓库驱动期望的是 1248 → 靠布局推导命中 9999。
  const tail = browsers.executableTail('chromium', expectedForFakeRoot);
  const fakeTail = makeFakeBuild('chromium-9999', tail.split(path.sep).join('/'));
  const viaScan = await browsers.resolveBrowser('chromium', { driver: 'repo' });
  check(
    '端到端（分支 4）：仓库驱动 + 缓存里唯一构建（revision 不同、非默认缓存根）→ 命中',
    viaScan.executablePath === fakeTail && viaScan.exactPairing === false,
    JSON.stringify({ source: viaScan.source, exe: viaScan.executablePath, expected: fakeTail }),
  );

  // 分支 3：把**仓库驱动期望的那个 revision** 也造出来 → 应当优先用它（exactPairing=true）。
  const expectedExact = makeFakeBuild('chromium-1248', tail.split(path.sep).join('/'));
  const viaExpected = await browsers.resolveBrowser('chromium', { driver: 'repo' });
  check(
    '端到端（分支 3）：仓库驱动期望的二进制存在时优先采用（exactPairing=true）',
    viaExpected.executablePath === expectedExact && viaExpected.exactPairing === true,
    JSON.stringify({ source: viaExpected.source, exe: viaExpected.executablePath, expected: expectedExact }),
  );

  // 负对照：缓存根本不存在时，必须**报错**（带缺什么/补测/试过的候选），不许返回一条假路径。
  fs.rmSync(fakeCache, { recursive: true, force: true });
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = path.join(fakeRoot, 'empty-cache');
  await checkThrowsAsync('端到端（负对照）：缓存为空 → 抛错而不是假装有', async () => {
    await browsers.resolveBrowser('chromium', { driver: 'repo' });
  }, '没有可用的浏览器 + 驱动组合');

  /* ------------------------------------------------------------ 4. 词汇表：声明的浏览器 = Playwright 的 BrowserType */

  check(
    '声明的浏览器 = 带 launchPersistentContext 的非私有导出（当前 chromium/firefox/webkit）',
    JSON.stringify(names.DECLARED_BROWSERS) === JSON.stringify(['chromium', 'firefox', 'webkit']),
    JSON.stringify(names.DECLARED_BROWSERS),
  );
  check(
    'declaredBrowsers 由注入对象推导（不是手写名单）：只留 BrowserType',
    JSON.stringify(
      names.declaredBrowsers({
        chromium: { launchPersistentContext: () => {} },
        firefox: { launchPersistentContext: () => {} },
        _electron: { launchPersistentContext: () => {} },
        devices: {},
        request: { launch: () => {} },
      }),
    ) === JSON.stringify(['chromium', 'firefox']),
    JSON.stringify(
      names.declaredBrowsers({
        chromium: { launchPersistentContext: () => {} },
        firefox: { launchPersistentContext: () => {} },
        _electron: { launchPersistentContext: () => {} },
        devices: {},
        request: { launch: () => {} },
      }),
    ),
  );
  check(
    'all 展开成全部声明浏览器',
    JSON.stringify(names.expandBrowserArg('all')) === JSON.stringify(names.DECLARED_BROWSERS),
    JSON.stringify(names.expandBrowserArg('all')),
  );
  check('单个名字原样保留', JSON.stringify(names.expandBrowserArg('webkit')) === '["webkit"]');
  checkThrows('拼错的名字 → 报错并列出合法取值', () => names.expandBrowserArg('chrome'), '未知的浏览器名');
  checkThrows('空名字 → 报错', () => names.expandBrowserArg('  '), '浏览器名为空');

  fs.rmSync(fakeRoot, { recursive: true, force: true });

  console.log(`\nbrowser-locate 判据自检：${passed}/${passed + failures.length} 通过`);
  if (failures.length > 0) {
    console.error(`\n未通过：\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
}

/** 异步版"必须抛错"断言（`checkThrows` 只适合同步）。 */
async function checkThrowsAsync(name, run, expectedText) {
  try {
    await run();
    check(name, false, '没有抛错（本应显式报错）');
  } catch (error) {
    const message = String(error?.message ?? error);
    check(name, message.includes(expectedText), `报错文本里没有 ${JSON.stringify(expectedText)}：${message.split('\n')[0]}`);
  }
}

await main();
