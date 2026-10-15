/**
 * 批次头设备标识的「声称 ⇔ 实际」一致性（2026-10-15 定向诊断的实现修复）。
 *
 * 缺陷（`docs/reports/security-draft.md` 第 5 节，T31「设备标识腿」红）：
 * 1. `client.ts` 唯一接线 `session: () => sessionTracker.current()`，而 `current()` **既不生成
 *    也不落盘**（生成/落盘只在 `touch()` 与 `onConsentChange` 里，而 `touch()` 全仓 `packages` 各包
 *    `src` 零调用点）⇒ 装载 `consent:'granted'` 的实例：存储里没有 `DEVICE_ID_KEY`，批头却声称
 *    `device_id_persistent: true`；
 * 2. `header.ts` 在 `session.deviceId === ''` 时**现场 `createUuid()` 兜底** ⇒ 已授权接入方
 *    连续取批头得到**不同的** `device_id`（实测 3 次 3 个值），逐批漂移；
 * 3. 触发者是 D-09（构造时读 `options.consent`）：装配根把 `consent` 放进 `clientOptions` 再
 *    `init({...})`，`performInit` 的 `if (consent !== previousConsent)` 被跳过 ⇒ `persistDevice()`
 *    不执行；D-09 之前构造态恒为 `unknown`、守卫必触发，所以此前绿。
 *
 * 还固化两条同族路径的**生产可达性**（`ddfccaf3` 的写回、以及合法存储值的读回）：
 * - 非法非 uuid 的存储值被丢弃后**必须写回**合法值（否则每次启动重新生成，同一设备语义漂移）；
 * - 合法存储 uuid **必须被复用**（不得另造新 uuid）。
 *
 * 覆盖面刻意与既有用例互补：`client-ports.test.ts` 只覆盖 `init({ consent })` 入口且不测稳定性/
 * 写回；本文件覆盖 `createClient({ consent })` 入口、连续取头稳定、写回与复用、以及未授权回归。
 * 样本只用格式合法的伪造数据（非真实个人信息）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BATCH_HEADER_CAPABILITY, createClient } from './client';
import type { Client, ClientOptions } from './types';
import { DEVICE_ID_KEY } from '../context/constants';
import { createBatchHeaderProvider } from '../context/header';
import type { C04BatchHeader, ContextStoragePort } from '../context';

/** `batch.schema.json` 的 `$defs/uuid` 形态（v4 + variant `[89ab]`，小写）。 */
const SCHEMA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 合法 uuid（`$defs/uuid` 通过）；用作「存储里已有标识」的样本。 */
const STORED_DEVICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** 非 uuid 残留值（格式合法的伪造数据，不含真实个人信息）。 */
const INVALID_STORED_DEVICE_ID = '/user/13800138000';

const clients: Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

/** 记录读写的注入式存储端口。 */
function storageFixture(initial: Readonly<Record<string, string>> = {}): {
  readonly storage: ContextStoragePort;
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    storage: {
      read: (key: string): string | undefined => values.get(key),
      write: (key: string, value: string): void => {
        values.set(key, value);
      },
      remove: (key: string): void => {
        values.delete(key);
      },
    },
  };
}

/** 建客户端并登记，用例结束后统一 `destroy()`。 */
function open(options: ClientOptions): Client {
  const client = createClient(options);
  clients.push(client);
  return client;
}

/** 读取 C04 的批次头 provider（内核能力 `sdk.batch_header`）。 */
function headerOf(client: Client): () => C04BatchHeader {
  const capability = client.kernel.getCapability(BATCH_HEADER_CAPABILITY);
  if (typeof capability !== 'function') throw new Error('缺少 sdk.batch_header 能力');
  return capability as () => C04BatchHeader;
}

describe('已授权 ⇒ 设备标识真的落盘（两个等价的同意入口）', () => {
  it("入口一：createClient({ consent: 'granted' }) + init({ appId }) —— 存储里有 DEVICE_ID_KEY，且等于批头 device_id", () => {
    const recorder = storageFixture();
    const client = open({ consent: 'granted', storage: recorder.storage });
    // init 不再传 consent（装配根形态：consent 已在 clientOptions 里）；这正是守卫被跳过的路径。
    client.init({ appId: 'app-a' });

    const header = headerOf(client)();
    expect(header.device_id).toMatch(SCHEMA_UUID_RE);
    expect(header.device_id_persistent).toBe(true);
    expect(recorder.values.get(DEVICE_ID_KEY)).toBe(header.device_id);
  });

  it("入口二：init({ consent: 'granted' }) —— 同样落盘且两者一致（与入口一等价）", () => {
    const recorder = storageFixture();
    const client = open({ storage: recorder.storage });
    client.init({ appId: 'app-a', consent: 'granted' });

    const header = headerOf(client)();
    expect(header.device_id).toMatch(SCHEMA_UUID_RE);
    expect(header.device_id_persistent).toBe(true);
    expect(recorder.values.get(DEVICE_ID_KEY)).toBe(header.device_id);
  });

  it("入口一在 init 完成时即已落盘（不依赖随后是否读批头）——`performInit` 的同意同步必须无条件执行", () => {
    const recorder = storageFixture();
    const client = open({ consent: 'granted', storage: recorder.storage });
    client.init({ appId: 'app-a' });

    // 关键：这里**还没读过**批次头。若 `performInit` 因 `consent === previousConsent` 跳过
    // `onConsentChange`，则存储为空、只能等某次 header() 读取时才补写 —— 那正是本缺陷的形状。
    expect(recorder.values.has(DEVICE_ID_KEY)).toBe(true);
  });
});

describe('批头设备标识稳定：连续取头不得逐批漂移', () => {
  it("createClient({ consent: 'granted' }) 下连续 3 次 header() 得到同一 device_id，且等于存储值", () => {
    const recorder = storageFixture();
    const client = open({ consent: 'granted', storage: recorder.storage });
    client.init({ appId: 'app-a' });
    const header = headerOf(client);

    const first = header();
    const second = header();
    const third = header();
    expect(second.device_id).toBe(first.device_id);
    expect(third.device_id).toBe(first.device_id);
    expect(recorder.values.get(DEVICE_ID_KEY)).toBe(first.device_id);
  });
});

describe('存储值的读取/写回在生产路径可达（不得只在直接调 touch 时可达）', () => {
  it('非法非 uuid 存储值 ⇒ 丢弃、生成合法 uuid 并覆盖写回（写回路径可达）', () => {
    const recorder = storageFixture({ [DEVICE_ID_KEY]: INVALID_STORED_DEVICE_ID });
    const client = open({ consent: 'granted', storage: recorder.storage });
    client.init({ appId: 'app-a' });

    const header = headerOf(client)();
    expect(header.device_id).not.toBe(INVALID_STORED_DEVICE_ID);
    expect(header.device_id).toMatch(SCHEMA_UUID_RE);
    // 覆盖写回：被污染的残留值不再留在存储里，后续取头复用写回后的值。
    expect(recorder.values.get(DEVICE_ID_KEY)).toBe(header.device_id);
    expect(headerOf(client)().device_id).toBe(header.device_id);
  });

  it('合法存储 uuid ⇒ 原样复用（不得另造新 uuid）', () => {
    const recorder = storageFixture({ [DEVICE_ID_KEY]: STORED_DEVICE_ID });
    const client = open({ consent: 'granted', storage: recorder.storage });
    client.init({ appId: 'app-a' });

    const header = headerOf(client)();
    expect(header.device_id).toBe(STORED_DEVICE_ID);
    expect(headerOf(client)().device_id).toBe(STORED_DEVICE_ID);
    expect(recorder.values.get(DEVICE_ID_KEY)).toBe(STORED_DEVICE_ID);
  });
});

describe('未授权 ⇒ 不落盘（回归，保持既有语义）', () => {
  it('缺省 unknown + essential_only：不写持久化存储、device_id_persistent 为 false', () => {
    const recorder = storageFixture();
    const client = open({ storage: recorder.storage });
    client.init({ appId: 'app-a' });

    const header = headerOf(client)();
    expect(header.device_id_persistent).toBe(false);
    expect(recorder.values.has(DEVICE_ID_KEY)).toBe(false);
    expect(recorder.values.size).toBe(0);
  });

  it('未授权时批头 device_id 也是**页面级稳定值**（不得每次取头现场另造），但仍不落盘', () => {
    // 这一条是 `current()` 惰性物化（修法 1）独有的判别点：若 `current()` 仍返回空串，
    // `header.ts` 的 `createUuid()` 兜底会每次取头都造一个新 uuid（逐批漂移），即使未授权也一样错。
    const recorder = storageFixture();
    const client = open({ storage: recorder.storage });
    client.init({ appId: 'app-a' });
    const header = headerOf(client);

    const first = header();
    expect(first.device_id).toMatch(SCHEMA_UUID_RE);
    expect(header().device_id).toBe(first.device_id);
    expect(header().device_id_persistent).toBe(false);
    expect(recorder.values.has(DEVICE_ID_KEY)).toBe(false);
  });
});

describe('device_id 与 device_id_persistent 必须同源（不得声称强于事实）', () => {
  it('session.deviceId 为空串时不得声称 persistent: true（即使会话层说 true）', () => {
    // 直接构造 provider：模拟「会话层未能提供标识」的任意来源（本缺陷里的 current()）。
    // 批头 `device_id` 是必填 + `$ref uuid`：兜底生成合法值，但**不得**跟着声称已持久化。
    const provider = createBatchHeaderProvider({
      appId: 'app-a',
      sdkName: '@web-report-sdk/core',
      sdkVersion: '0.0.0',
      session: () => ({ sessionId: '', deviceId: '', deviceIdPersistent: true }),
      user: () => undefined,
      consent: () => 'granted',
      clock: () => ({ offsetMs: 0, calibrated: false }),
    });
    const header = provider();
    expect(header.device_id).toMatch(SCHEMA_UUID_RE);
    expect(header.device_id_persistent).toBe(false);
  });
});
