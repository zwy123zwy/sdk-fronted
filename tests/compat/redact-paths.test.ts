/**
 * 证据产物脱敏器的判别性用例：既证明"用户名/绝对路径被去掉"，也证明"诊断信息还在"。
 *
 * 口径见 `lib/redact-paths.mjs` 头注释与 `docs/reports/e2e-real-browser.md` 的脱敏一节。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REPO_ROOT, redactPaths, redactText } from './lib/redact-paths.mjs';

/** 夹具用假仓库根，避免用例依赖本机真实用户名。 */
const FAKE_REPO = '/Users/someone/Desktop/sdk';

/** 任何形态的家目录前缀——脱敏后都不得出现。 */
const HOME_PREFIX = /\/Users\/|\/home\/|C:\\Users/u;

describe('redactText：仓库内路径 → <repo>', () => {
  test('普通绝对路径变成相对仓库根', () => {
    expect(redactText(`${FAKE_REPO}/packages/browser/dist/index.js`, FAKE_REPO)).toBe(
      '<repo>/packages/browser/dist/index.js',
    );
  });

  test('Vite 的 /@fs/ 前缀保留分隔符（不出现 /@fs<repo>）', () => {
    expect(redactText(`/@fs${FAKE_REPO}/packages/browser/dist/index.js`, FAKE_REPO)).toBe(
      '/@fs/<repo>/packages/browser/dist/index.js',
    );
    expect(redactText(`http://127.0.0.1:59041/@fs${FAKE_REPO}/a.js`, FAKE_REPO)).toBe(
      'http://127.0.0.1:59041/@fs/<repo>/a.js',
    );
  });

  test('file:// URL 里的仓库根同样被替换', () => {
    expect(redactText(`file://${FAKE_REPO}/a.js`, FAKE_REPO)).toBe('file://<repo>/a.js');
  });
});

describe('redactText：仓库外路径 → 稳定类别标记', () => {
  test('Playwright 缓存保留浏览器名与构建号（诊断价值仍在）', () => {
    const mac =
      '/Users/someone/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    const redacted = redactText(mac);
    expect(redacted).toBe(
      '<ms-playwright>/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
    expect(redacted).toContain('chromium-1248');
    expect(redacted).not.toMatch(HOME_PREFIX);
  });

  test('Linux 缓存与 WebKit 包装脚本同样保留构建号', () => {
    expect(redactText('/home/someone/.cache/ms-playwright/chromium-1248/chrome-linux/chrome')).toBe(
      '<ms-playwright>/chromium-1248/chrome-linux/chrome',
    );
    expect(redactText('/Users/someone/Library/Caches/ms-playwright/webkit-2287/pw_run.sh')).toBe(
      '<ms-playwright>/webkit-2287/pw_run.sh',
    );
  });

  test('Windows 缓存与家目录', () => {
    expect(
      redactText('C:\\Users\\someone\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win\\chrome.exe'),
    ).toBe('<ms-playwright>/chromium-1248\\chrome-win\\chrome.exe');
    expect(redactText('C:\\Users\\someone\\projects\\x.js')).toBe('<home>\\projects\\x.js');
  });

  test('其他家目录 → <home>，系统临时目录 → <tmp>', () => {
    expect(redactText('/Users/someone/other/x.js')).toBe('/<home>/other/x.js');
    expect(redactText('/home/someone/other/x.js')).toBe('/<home>/other/x.js');
    expect(redactText('/var/folders/tz/abc/T/t29-e2e-d004-chromium-1792134790784')).toBe(
      '<tmp>/t29-e2e-d004-chromium-1792134790784',
    );
  });
});

describe('redactPaths：递归 + 幂等', () => {
  const payload = {
    task: 'T30',
    cells: [
      { evidence: `${FAKE_REPO}/packages/browser/dist/index.js` },
      {
        browser: {
          executablePath:
            '/Users/someone/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/chrome',
          attempts: [{ path: '/Users/someone/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/chrome' }],
        },
        profileRoot: '/var/folders/tz/abc/T/t29-e2e-d004-chromium-1',
      },
    ],
    count: 3,
    ok: true,
  };

  test('字符串叶子被脱敏，非字符串原样保留', () => {
    const redacted = redactPaths(payload, FAKE_REPO);
    const text = JSON.stringify(redacted);
    expect(text).not.toMatch(HOME_PREFIX);
    expect(text).not.toContain('/var/folders/');
    expect(text).toContain('<repo>/packages/browser/dist/index.js');
    expect(text).toContain('<ms-playwright>/chromium-1223/');
    expect(text).toContain('<ms-playwright>/chromium-1248/');
    expect(text).toContain('<tmp>/t29-e2e-d004-chromium-1');
    expect(redacted.count).toBe(3);
  });

  test('不修改入参', () => {
    redactPaths(payload, FAKE_REPO);
    expect(JSON.stringify(payload)).toContain('/Users/someone/Library/Caches/ms-playwright');
  });

  test('幂等（writeJsonStable 的"实质内容"比较依赖它）', () => {
    const once = redactPaths(payload, FAKE_REPO);
    expect(redactPaths(once, FAKE_REPO)).toEqual(once);
  });

  test('默认仓库根由本模块推导（绝对路径，且能吃掉真实仓库内的路径）', () => {
    expect(isAbsolute(REPO_ROOT)).toBe(true);
    expect(redactText(`${REPO_ROOT}/packages/browser/dist/index.js`)).toBe(
      '<repo>/packages/browser/dist/index.js',
    );
  });
});

/**
 * **防新残留的守卫**（比清理历史更重要）。
 *
 * 上面几组用例证明"脱敏函数本身正确"；这一组直接读**已落盘的证据 JSON**，证明"写入者接上了脱敏函数"。
 * 任何一次漏接（新写入者忘了走 `writeJsonStable` / `redactPaths`）都会在这里红，而不是等到
 * 用户名已经进了 git 历史才发现。
 *
 * 范围刻意只含 `tests/{e2e,compat}/results/**`：`tests/reliability/results/**` 属另一条 lane，
 * 现在仍有同类字段，把它算进来会让本守卫因**范围外**的原因红。
 */
describe('防新残留守卫：已落盘的证据不得含用户名前缀', () => {
  test('tests/{e2e,compat}/results/**/*.json 不含 /Users/、/home/、C:\\Users', () => {
    const problems: string[] = [];
    let scanned = 0;
    for (const dir of ['tests/e2e/results', 'tests/compat/results']) {
      const absolute = join(REPO_ROOT, dir);
      if (!existsSync(absolute)) continue;
      for (const name of readdirSync(absolute)) {
        if (!name.endsWith('.json')) continue;
        scanned += 1;
        const text = readFileSync(join(absolute, name), 'utf8');
        if (HOME_PREFIX.test(text)) problems.push(`${dir}/${name} 含用户名前缀`);
      }
    }
    // 至少扫到一份（目录被移走/改名的静默通过也不允许）。
    expect(scanned).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
