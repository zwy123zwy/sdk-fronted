/**
 * C04-AC-01 / C04-AC-10 / C04-AC-19 的批次头部分：公共上下文（C04-F1）。
 *
 * AC-01：批次头包含 `device_id`、`session_id`、`release`、`env`、`sdk_version`；
 *        事件包含 `page_id`、`view_id`、`url`。
 * AC-10：未取得同意时不写持久化设备标识，批次 `device_id_persistent` 为 false。
 * AC-19：`full` + `unknown` → 生成持久化设备标识，批次 `consent` 为 `unknown`。
 *
 * 批次头的字段形状结构对齐 T16 的 `BatchHeader`（core 不 import transport）。
 *
 * 取证顺序：本文件在 `createBatchHeaderProvider` 实现前先写（当时 `device_id_persistent`/
 * `consent`/用户字段的语义用例红过），之后实现转绿。
 */
import { describe, expect, it } from 'vitest';

import { createBatchHeaderProvider } from './header';
import { createClockCalibration } from './clock';
import { createSessionTracker } from './session';
import type { C04BatchHeader, ContextStoragePort, SessionState } from './ports';
import type { ConsentMode, ConsentState } from '../privacy/types';

/** 内存存储（测试替身）。 */
function memoryStorage(seed: Record<string, string> = {}): ContextStoragePort {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 组装一个批次头 provider（模拟装配根在 T18 的接线）。 */
function makeHeader(options: {
  consent?: ConsentState;
  mode?: ConsentMode;
  authorized?: boolean;
  env?: string;
  release?: string;
  user?: { id: string; hashed?: boolean | undefined };
  offsetMs?: number;
  calibrated?: boolean;
}) {
  const consentState = options.consent ?? 'unknown';
  const mode = options.mode ?? 'essential_only';
  const session = createSessionTracker({
    createId: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
      };
    })(),
    now: () => 1_700_000_000_000,
    state: consentState,
    mode,
    persistentStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    limits: { sessionIdleMs: 1_800_000 },
  });
  session.touch(1_700_000_000_000);
  if (consentState === 'granted' || mode === 'full') session.onConsentChange(consentState, mode);

  const clock = createClockCalibration();
  if (options.offsetMs !== undefined) {
    clock.noteServerTime({
      serverTimeMs: 1_700_000_000_000 + options.offsetMs,
      clientSentAtMs: 1_700_000_000_000 - 50,
      clientReceivedAtMs: 1_700_000_000_000 + 50,
    });
  }

  const provider = createBatchHeaderProvider({
    appId: 'app-a',
    sdkName: '@web-report-sdk/browser',
    sdkVersion: '0.0.0',
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.release === undefined ? {} : { release: options.release }),
    session: () => session.current(),
    user: () => options.user,
    consent: () => (consentState === 'granted' ? 'granted' : consentState === 'denied' ? 'denied' : 'unknown'),
    clock: () => clock.current(),
  });
  return { header: provider, session, clock };
}

describe('C04-AC-01 批次头字段', () => {
  it('包含 device_id / session_id / release / env / sdk_name / sdk_version', () => {
    const { header } = makeHeader({ authorized: true, consent: 'granted' });
    const value = header();
    expect(value.protocol_version).toBe(1);
    expect(value.app_id).toBe('app-a');
    expect(value.env).toBe('production');
    expect(value.release).toBe('0.0.0');
    expect(value.sdk_name).toBe('@web-report-sdk/browser');
    expect(value.sdk_version).toBe('0.0.0');
    expect(value.device_id).toMatch(UUID_RE);
    expect(value.session_id).toMatch(UUID_RE);
  });

  it('env / release 可由装配根注入', () => {
    const { header } = makeHeader({ env: 'staging', release: '1.2.3' });
    const value = header();
    expect(value.env).toBe('staging');
    expect(value.release).toBe('1.2.3');
  });

  it('每次取头都重新求值（时钟偏移变化后下次头会更新）', () => {
    const { header, clock } = makeHeader({});
    expect(header().clock_offset).toBe(0);
    clock.noteServerTime({
      serverTimeMs: 1_700_000_005_000,
      clientSentAtMs: 1_699_999_999_950,
      clientReceivedAtMs: 1_700_000_000_050,
    });
    expect(header().clock_offset).toBeGreaterThan(4000);
    expect(header().clock_calibrated).toBe(true);
  });
});

describe('C04-AC-10 / C04-AC-19 设备标识持久化与 consent 字段', () => {
  it('AC-10：unknown + essential_only → device_id_persistent 为 false', () => {
    const { header } = makeHeader({ consent: 'unknown', mode: 'essential_only' });
    expect(header().device_id_persistent).toBe(false);
    expect(header().consent).toBe('unknown');
  });

  it('AC-19：full + unknown → device_id_persistent 为 true，consent 仍为 unknown', () => {
    const { header } = makeHeader({ consent: 'unknown', mode: 'full' });
    expect(header().device_id_persistent).toBe(true);
    expect(header().consent).toBe('unknown');
  });

  it('granted → device_id_persistent 为 true、consent 为 granted', () => {
    const { header } = makeHeader({ consent: 'granted' });
    expect(header().device_id_persistent).toBe(true);
    expect(header().consent).toBe('granted');
  });

  it('denied → device_id_persistent 为 false、consent 为 denied', () => {
    const { header } = makeHeader({ consent: 'denied' });
    expect(header().device_id_persistent).toBe(false);
    expect(header().consent).toBe('denied');
  });

  it('buffer 状态的批头 consent 映射为 unknown（枚举只有三态）', () => {
    const { header } = makeHeader({ consent: 'buffer', mode: 'buffer' });
    expect(header().consent).toBe('unknown');
  });
});

describe('用户标识只进批次头', () => {
  it('有用户时输出 user_id；hashed 为 true 时同时输出 user_id_hashed', () => {
    const { header } = makeHeader({ user: { id: 'user-a', hashed: true } });
    const value = header();
    expect(value.user_id).toBe('user-a');
    expect(value.user_id_hashed).toBe(true);
  });

  it('未设置用户时 user_id 字段不出现（不是空串）', () => {
    const { header } = makeHeader({});
    expect('user_id' in header()).toBe(false);
    expect('user_id_hashed' in header()).toBe(false);
  });

  it('未标记 hashed 时不输出 user_id_hashed', () => {
    const { header } = makeHeader({ user: { id: 'user-b' } });
    const value = header();
    expect(value.user_id).toBe('user-b');
    expect('user_id_hashed' in value).toBe(false);
  });
});

/**
 * 「同一来源」硬化（2026-10-15 定向诊断，T31 设备标识腿的根）。
 *
 * 本缺陷的形状是：`device_id_persistent` 取「授权意图」（`session.deviceIdPersistent`），
 * 而 `device_id` 在 `session.deviceId === ''` 时由 `header.ts` **现场 `createUuid()` 兜底**
 * ——两者来源不同，于是出现「永远声称 `persistent: true` + 存储为空 + 每次取头换一个 uuid」。
 * 因此这里钉住两条：
 * 1. 会话层给不出标识时**不得**声称已持久化（两个字段描述同一个值）；
 * 2. 批次头的标识**唯一来源是会话追踪器**：未 touch 过也要稳定，不得逐次现场另造。
 */
describe('device_id / session_id 与 device_id_persistent 必须同源（2026-10-15 硬化）', () => {
  const constantClock = (): { readonly offsetMs: number; readonly calibrated: boolean } => ({
    offsetMs: 0,
    calibrated: false,
  });

  function providerFor(session: () => SessionState): () => C04BatchHeader {
    return createBatchHeaderProvider({
      appId: 'app-a',
      sdkName: '@web-report-sdk/core',
      sdkVersion: '0.0.0',
      session,
      user: () => undefined,
      consent: () => 'granted',
      clock: constantClock,
    });
  }

  it('会话层给不出标识（空串）时不得声称 persistent: true —— 兜底生成合法 uuid，但 persistent 为 false', () => {
    const provider = providerFor(() => ({ sessionId: '', deviceId: '', deviceIdPersistent: true }));
    const header = provider();
    expect(header.device_id).toMatch(UUID_RE);
    expect(header.device_id_persistent).toBe(false);
  });

  it('未 touch 过的 tracker：连续取头 session_id / device_id 稳定（唯一来源是 tracker）', () => {
    const session = createSessionTracker({
      createId: (() => {
        let counter = 0;
        return () => {
          counter += 1;
          return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
        };
      })(),
      now: () => 1_700_000_000_000,
      state: 'granted',
      mode: 'essential_only',
      persistentStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      limits: { sessionIdleMs: 1_800_000 },
    });
    const provider = providerFor(() => session.current());
    const first = provider();
    expect(first.session_id).toMatch(UUID_RE);
    expect(first.device_id).toMatch(UUID_RE);
    expect(provider().session_id).toBe(first.session_id);
    expect(provider().device_id).toBe(first.device_id);
  });
});

describe('时钟字段与批次 Schema 的边界', () => {
  it('未校准时 clock_offset 为 0 且 clock_calibrated 为 false', () => {
    const { header } = makeHeader({});
    expect(header().clock_offset).toBe(0);
    expect(header().clock_calibrated).toBe(false);
  });

  it('校准后的偏移落在 Schema 的 ±24h 之内', () => {
    const { header } = makeHeader({ offsetMs: 5_000 });
    expect(Math.abs(header().clock_offset)).toBeLessThanOrEqual(86_400_000);
    expect(header().clock_calibrated).toBe(true);
  });
});
