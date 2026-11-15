import { describe, expect, it } from 'vitest';
import { createManualClock } from '../src/clock.js';
import { ProfileLimiter } from '../src/limiter.js';
import { flush } from './helpers.js';

describe('the profile completion limiter', () => {
  it('keeps each priority FIFO, gives foreground queued work priority and never preempts a slot', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => 1);
    const active = await limiter.acquire('a', true);
    const order: string[] = [];
    const enqueue = (name: string, background: boolean) => limiter.acquire('a', background).then((release) => {
      order.push(name);
      release();
    });
    const pending = [enqueue('b1', true), enqueue('b2', true), enqueue('f1', false), enqueue('f2', false)];
    await flush();
    expect(order).toEqual([]);
    active();
    active();
    await Promise.all(pending);
    expect(order).toEqual(['f1', 'f2', 'b1', 'b2']);
    expect(clock.pending).toBe(0);
  });

  it('holds the latest shared pause, while other profiles are independent', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => 2);
    limiter.pause('a', 3_000);
    limiter.pause('a', 1_000);
    let admitted = false;
    const queued = limiter.acquire('a', false).then((release) => { admitted = true; return release; });
    const other = await limiter.acquire('b', true);
    other();
    clock.advance(2_999);
    await flush();
    expect(admitted).toBe(false);
    expect(clock.pending).toBe(1);
    clock.advance(1);
    (await queued)();
    expect(admitted).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('removes an aborted queued request and its pause timer without consuming a slot', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => 1);
    limiter.pause('a', 10_000);
    const abort = new AbortController();
    const queued = limiter.acquire('a', false, abort.signal);
    const refused = expect(queued).rejects.toMatchObject({ name: 'CallerCancelled' });
    abort.abort();
    await refused;
    expect(clock.pending).toBe(0);
    clock.advance(10_000);
    const release = await limiter.acquire('a', false);
    release();
    expect(clock.pending).toBe(0);
  });

  it('reads a changed limit for subsequent scheduling without interrupting admitted calls', async () => {
    const clock = createManualClock();
    let limit = 2;
    const limiter = new ProfileLimiter(clock, () => limit);
    const first = await limiter.acquire('a', false);
    const second = await limiter.acquire('a', false);
    limit = 1;
    let admitted = false;
    const next = limiter.acquire('a', false).then((release) => { admitted = true; return release; });
    first();
    await flush();
    expect(admitted).toBe(false);
    second();
    (await next)();
    expect(admitted).toBe(true);
  });

  it('does not spin overflowing browser timers for a long pause', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => 1);
    const abort = new AbortController();
    limiter.pause('a', 3_000_000_000);
    const queued = limiter.acquire('a', false, abort.signal);
    const refused = expect(queued).rejects.toMatchObject({ name: 'CallerCancelled' });
    clock.advance(2_147_483_647);
    await flush();
    expect(clock.pending).toBe(1);
    abort.abort();
    await refused;
    expect(clock.pending).toBe(0);
  });
});
