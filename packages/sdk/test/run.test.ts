import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@caotang/harness';

import { createEventQueue } from '../src/run.js';

const delta = (n: number): AgentEvent => ({ type: 'model.delta', turnId: 't', delta: String(n) });
const turn = (n: number): AgentEvent => ({ type: 'turn', turnId: `t${n}`, phase: 'planning' }) as AgentEvent;

async function drain(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('the event queue', () => {
  it('holds events until they are read, in order, and ends when the turn does', async () => {
    const queue = createEventQueue();
    queue.push(delta(1));
    queue.push(delta(2));
    queue.end();
    expect(await drain(queue.iterator())).toEqual([delta(1), delta(2)]);
  });

  it('wakes a reader that is waiting', async () => {
    const queue = createEventQueue();
    const reading = drain(queue.iterator());
    await Promise.resolve();
    queue.push(delta(1));
    queue.end();
    expect(await reading).toEqual([delta(1)]);
  });

  it('drains what it holds and then throws when the turn failed', async () => {
    const queue = createEventQueue();
    queue.push(delta(1));
    queue.fail(new Error('boom'));
    const iterator = queue.iterator();
    expect(await iterator.next()).toEqual({ value: delta(1), done: false });
    await expect(iterator.next()).rejects.toThrow('boom');
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('drops the oldest streamed text past its bound, and no other event', async () => {
    const queue = createEventQueue(3);
    queue.push(turn(1));
    for (let n = 1; n <= 6; n += 1) queue.push(delta(n));
    queue.push(turn(2));
    queue.end();
    const events = await drain(queue.iterator());
    expect(events.filter((event) => event.type === 'turn')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'model.delta').length).toBeLessThan(6);
    expect(events[events.length - 1]).toEqual(turn(2));
  });

  it('stops delivering when the reader returns early', async () => {
    const queue = createEventQueue();
    queue.push(delta(1));
    const iterator = queue.iterator();
    await iterator.return?.();
    queue.push(delta(2));
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});
