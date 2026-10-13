/**
 * C07-AC-21 安全：撤回同意 / 注销时清空离线数据；离线数据中不出现未脱敏内容。
 *
 * 「不出现未脱敏内容」在本层能自证的部分：存储层**只保存 C04 交给它的批次**，
 * 不新增任何字段；用真实 `batch.schema.json`（`additionalProperties: false`）
 * 校验落盘批次，任何额外字段都会被 Ajv 判非法。
 */
import 'fake-indexeddb/auto';
import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, test } from 'vitest';
import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import { createRecordingBackend, makeBatch, makeEvent } from './fixtures';
import { createOfflineStore } from './offline-store';
import type { OfflineRecord } from './types';

const ajv = new Ajv2020({ allErrors: true });
const validateBatch = ajv.compile(batchSchema);

/** 离线记录的字段白名单：存储层不得引入任何额外字段。 */
const RECORD_KEYS: readonly string[] = [
  'app_id',
  'attempt_count',
  'batch',
  'batch_id',
  'bytes',
  'committed_at',
  'critical_count',
  'enqueued_at',
  'event_count',
  'format_version',
  'has_critical',
  'last_attempt_at',
  'session_id',
];

let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `wr-test-privacy-${String(dbCounter)}`;
}

describe('C07-AC-21 离线数据与撤回同意', () => {
  test('AC-21 落盘批次通过真实 batch Schema 校验（不多不少）', async () => {
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      dbName: freshDbName(),
      limits: { commitBatchSize: 100, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      const batch = makeBatch({
        events: [makeEvent({ priority: 'critical' }), makeEvent({ priority: 'normal' })],
      });
      await store.prewrite(batch).settled;
      const readBack = await store.read(batch.batch_id);
      expect(readBack).not.toBeNull();
      const valid = validateBatch(readBack);
      expect(validateBatch.errors ?? [], JSON.stringify(validateBatch.errors)).toEqual([]);
      expect(valid).toBe(true);
    } finally {
      store.dispose();
    }
  });

  test('AC-21 记录只含声明的字段（存储层不引入未脱敏内容）', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 100, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      await store.prewrite(makeBatch()).settled;
      const records: readonly OfflineRecord[] = [...recorder.records.values()];
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record).toBeDefined();
      if (record === undefined) return;
      expect(Object.keys(record).sort()).toEqual([...RECORD_KEYS].sort());
    } finally {
      store.dispose();
    }
  });

  test('AC-21 撤回同意 / 注销：clear 清空全部离线数据', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      await store.prewrite(makeBatch()).settled;
      await store.prewrite(makeBatch()).settled;
      expect(store.stats().storedBatches).toBe(2);
      await store.clear();
      expect(await store.list(10)).toEqual([]);
      expect(store.stats().storedBatches).toBe(0);
      expect(recorder.records.size).toBe(0);
    } finally {
      store.dispose();
    }
  });

  test('AC-21 clear 对未落盘的排队记录也不抛错，且它们的句柄有结论', async () => {
    const recorder = createRecordingBackend();
    let resolveSettled: (value: string) => void = (): void => undefined;
    const settledText = new Promise<string>((resolve) => {
      resolveSettled = resolve;
    });
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: {
        ...recorder.backend,
        commit: (): Promise<void> => new Promise<void>(() => undefined),
      },
      limits: { commitBatchSize: 100, commitIntervalMs: 10_000 },
    });
    try {
      await store.ready();
      const handle = store.prewrite(makeBatch());
      void handle.settled.then((outcome) => {
        resolveSettled(outcome.status);
      });
      await store.clear();
      expect(await settledText).toBe('rejected');
    } finally {
      store.dispose();
    }
  });
});
