/**
 * C07-AC-07：413 拆成两半重发，`event_id` 不变、`batch_id` 重新生成；
 * 单条仍超限时丢弃该条并计 `rejected_413`。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, makeBatch, makeEvent } from '../offline/fixtures';
import { createFakeCredentials, createFakeTransport, createSleepSpy } from './fixtures';
import { createBatchSender } from './sender';

function makeRig(): {
  readonly sender: ReturnType<typeof createBatchSender>;
  readonly transport: ReturnType<typeof createFakeTransport>;
  readonly counters: ReturnType<typeof createCountersSpy>;
} {
  const transport = createFakeTransport();
  const counters = createCountersSpy();
  return {
    transport,
    counters,
    sender: createBatchSender({
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      counters: counters.port,
      sleep: createSleepSpy().sleep,
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    }),
  };
}

describe('C07-AC-07 413 拆分', () => {
  test('AC-07 413 → 两半重发；event_id 不变、batch_id 重新生成、计 split_413', async () => {
    const rig = makeRig();
    const events = [makeEvent(), makeEvent(), makeEvent(), makeEvent()];
    const batch = makeBatch({ events });
    rig.transport.push(413);
    rig.transport.push(202);
    rig.transport.push(202);

    const result = await rig.sender.send(batch);
    expect(result.status).toBe('sent');
    expect(rig.counters.get('split_413')).toBe(1);
    expect(rig.transport.requests).toHaveLength(3);

    const originals = events.map((event) => event.event_id);
    const firstHalf = JSON.parse(rig.transport.requests[1]?.body ?? '{}') as {
      batch_id?: string;
      events?: { event_id: string }[];
    };
    const secondHalf = JSON.parse(rig.transport.requests[2]?.body ?? '{}') as {
      batch_id?: string;
      events?: { event_id: string }[];
    };
    expect(firstHalf.events?.map((event) => event.event_id)).toEqual(originals.slice(0, 2));
    expect(secondHalf.events?.map((event) => event.event_id)).toEqual(originals.slice(2));
    expect(firstHalf.batch_id).not.toBe(batch.batch_id);
    expect(secondHalf.batch_id).not.toBe(batch.batch_id);
    expect(firstHalf.batch_id).not.toBe(secondHalf.batch_id);
  });

  test('AC-07 单条仍超限：丢弃该条并计 rejected_413（终态，不再补发）', async () => {
    const rig = makeRig();
    const batch = makeBatch({ events: [makeEvent()] });
    rig.transport.push(413);
    const result = await rig.sender.send(batch);
    expect(result.status).toBe('failed');
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe('rejected_413');
    expect(rig.counters.get('rejected_413')).toBe(1);
    expect(rig.counters.get('split_413')).toBe(0);
  });

  test('AC-07 递归拆分：3 条事件时拆到单条粒度仍能全部送达', async () => {
    const rig = makeRig();
    const batch = makeBatch({ events: [makeEvent(), makeEvent(), makeEvent()] });
    // 第一次 413 → 拆成 [e1] 与 [e2,e3]；后者再 413 → 拆成 [e2] 与 [e3]
    rig.transport.push(413);
    rig.transport.push(202);
    rig.transport.push(413);
    rig.transport.push(202);
    rig.transport.push(202);
    const result = await rig.sender.send(batch);
    expect(result.status).toBe('sent');
    expect(rig.counters.get('split_413')).toBe(2);
  });
});
