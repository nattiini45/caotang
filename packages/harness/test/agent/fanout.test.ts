import { expect, it } from 'vitest';

import { fanOut } from '../../src/agent/fanout.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

it('bounds concurrent work, isolates failure, and returns outcomes in binder order', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const thirdStarted = deferred<void>();
  const started: string[] = [];
  const settled: number[] = [];
  const outcomes = fanOut(
    ['a', 'b', 'c'].map((key) => ({ key, input: key })),
    async (key) => {
      started.push(key);
      if (key === 'a') return first.promise;
      if (key === 'b') return second.promise;
      thirdStarted.resolve();
      return 'last chapter';
    },
    { concurrency: 2, onSettled: (done) => settled.push(done) },
  );

  expect(started).toEqual(['a', 'b']);
  second.reject(new Error('provider unavailable'));
  await thirdStarted.promise;
  first.resolve('first chapter');
  expect(await outcomes).toEqual([
    { key: 'a', ok: true, value: 'first chapter' },
    { key: 'b', ok: false, error: 'provider unavailable' },
    { key: 'c', ok: true, value: 'last chapter' },
  ]);
  expect(settled).toEqual([1, 2, 3]);
});

it('keeps completed work and never starts queued items after Stop', async () => {
  const controller = new AbortController();
  const active = deferred<void>();
  const started: string[] = [];
  const outcomes = fanOut(
    ['done', 'active', 'queued'].map((key) => ({ key, input: key })),
    async (key, signal) => {
      started.push(key);
      if (key === 'active') {
        active.resolve();
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return key;
    },
    { concurrency: 1, signal: controller.signal },
  );
  await active.promise;
  controller.abort(new Error('Stopped during work.'));
  expect(await outcomes).toEqual([
    { key: 'done', ok: true, value: 'done' },
    { key: 'active', ok: false, error: 'Stopped during work.' },
    { key: 'queued', ok: false, error: 'Stopped before starting.' },
  ]);
  expect(started).toEqual(['done', 'active']);
});
