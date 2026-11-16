import { describe, expect, it } from 'vitest';
import { createManualClock } from '../src/clock.js';
import { defaultConcurrency, ProfileLimiter } from '../src/limiter.js';
import { flush } from './helpers.js';

describe('the profile completion limiter', () => {
  it('keeps each priority FIFO, gives foreground queued work priority and never preempts a slot', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => ({ start: 1, max: 1 }));
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
    const limiter = new ProfileLimiter(clock, () => ({ start: 2, max: 2 }));
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
    const limiter = new ProfileLimiter(clock, () => ({ start: 1, max: 1 }));
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

  it('reads a lowered limit for subsequent scheduling without interrupting admitted calls', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => ({ start: 2, max: 2 }));
    const first = await limiter.acquire('a', false);
    const second = await limiter.acquire('a', false);
    limiter.rateLimited('a', 0);
    let admitted = false;
    const next = limiter.acquire('a', false).then((release) => { admitted = true; return release; });
    first();
    await flush();
    expect(admitted).toBe(false);
    second();
    (await next)();
    expect(admitted).toBe(true);
  });

  it('halves on a 429 down to one, and a burst of 429s inside one pause costs one step', () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => ({ start: 8, max: 8 }));
    limiter.rateLimited('a', 2_000);
    limiter.rateLimited('a', 1_000);
    limiter.rateLimited('a', 1_500);
    expect(limiter.limitOf('a')).toBe(4);
    clock.advance(2_000);
    limiter.rateLimited('a', 1_000);
    limiter.rateLimited('b', 1_000);
    expect(limiter.limitOf('a')).toBe(2);
    expect(limiter.limitOf('b')).toBe(4);
    clock.advance(1_000);
    limiter.rateLimited('a', 1_000);
    clock.advance(1_000);
    limiter.rateLimited('a', 1_000);
    expect(limiter.limitOf('a')).toBe(1);
  });

  it('raises the limit by one after a run of successes, never past the ceiling, and a 429 restarts the run', () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => ({ start: 2, max: 3 }), 3);
    limiter.succeeded('a');
    limiter.succeeded('a');
    expect(limiter.limitOf('a')).toBe(2);
    limiter.rateLimited('a', 0);
    expect(limiter.limitOf('a')).toBe(1);
    limiter.succeeded('a');
    limiter.succeeded('a');
    limiter.succeeded('a');
    expect(limiter.limitOf('a')).toBe(2);
    for (let index = 0; index < 9; index += 1) limiter.succeeded('a');
    expect(limiter.limitOf('a')).toBe(3);
    expect(limiter.limitOf('b')).toBe(2);
  });

  it('admits waiting calls at once when successes raise the limit', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => ({ start: 1, max: 2 }), 1);
    const first = await limiter.acquire('a', false);
    let admitted = false;
    const next = limiter.acquire('a', false).then((release) => { admitted = true; return release; });
    await flush();
    expect(admitted).toBe(false);
    limiter.succeeded('a');
    await flush();
    expect(admitted).toBe(true);
    first();
    (await next)();
  });

  it('keeps the adapted limit while a profile is idle', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => ({ start: 4, max: 8 }));
    limiter.rateLimited('a', 1_000);
    clock.advance(1_000);
    (await limiter.acquire('a', false))();
    expect(limiter.limitOf('a')).toBe(2);
    expect(defaultConcurrency('mock', undefined)).toEqual({ start: 8, max: 8 });
  });

  it('does not spin overflowing browser timers for a long pause', async () => {
    const clock = createManualClock();
    const limiter = new ProfileLimiter(clock, () => ({ start: 1, max: 1 }));
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
