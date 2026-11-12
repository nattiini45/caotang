import { expect, it, vi } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';

import { SessionHandle, sessionMachine, type SessionPhase, type SessionEvent } from '../src/app/session-handle.js';
import { bootMachine, type BootPhase, type BootEvent, type BootResources } from '../src/app/boot-phase.js';
import { DemoStart, demoStartMachine, type DemoStartState, type DemoStartEvent } from '../src/app/demo-start.js';

it('checks every session, boot and demo transition', () => {
  const states: SessionPhase[] = [{ kind: 'opening' }, { kind: 'open' }, { kind: 'closing' }, { kind: 'closed' }];
  const events: SessionEvent[] = [{ type: 'opened' }, { type: 'close' }, { type: 'closed' }];
  expect(checkMachine(sessionMachine, { states, events })).toEqual([]);
  const resources = { store: {}, services: {}, notice: null } as BootResources;
  const bootStates: BootPhase[] = [{ kind: 'opening' }, { ...resources, kind: 'settling-interface' }, { ...resources, kind: 'ready' }, { kind: 'failed', error: 'storage', newer: true }];
  const bootEvents: BootEvent[] = [{ ...resources, type: 'opened' }, { type: 'ready' }, { type: 'failed', error: 'storage', newer: false }];
  expect(checkMachine(bootMachine, { states: bootStates, events: bootEvents })).toEqual([]);
  const demoStates: DemoStartState[] = [{ kind: 'idle' }, { kind: 'opening', intent: 'Review' }];
  const demoEvents: DemoStartEvent[] = [{ type: 'start', intent: 'Plan' }, { type: 'settled' }];
  expect(checkMachine(demoStartMachine, { states: demoStates, events: demoEvents })).toEqual([]);
});

it.each(['opening', 'open'] as const)('always closes a %s session when settling rejects, keeping the first failure', async (phase) => {
  const handle = new SessionHandle();
  if (phase === 'open') handle.opened();
  const failed = new Error('The settle failed.');
  const cleanup = vi.fn().mockRejectedValue(new Error('The close also failed.'));
  const closed = handle.closeSafely(() => Promise.reject(failed), cleanup);
  expect(handle.getSnapshot().kind).toBe('closing');
  expect(handle.closeSafely(vi.fn(), vi.fn())).toBe(closed);
  await expect(closed).rejects.toBe(failed);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(handle.getSnapshot().kind).toBe('closed');
  handle.opened();
  expect(handle.getSnapshot().kind).toBe('closed');
});

it('holds closing until settlement and cleanup finish, and never repeats either', async () => {
  const handle = new SessionHandle();
  handle.opened();
  let release!: () => void;
  const settling = new Promise<void>((resolve) => { release = resolve; });
  const settle = vi.fn(() => settling);
  const cleanup = vi.fn(async () => undefined);
  const first = handle.closeSafely(settle, cleanup);
  await Promise.resolve();
  expect(cleanup).not.toHaveBeenCalled();
  release();
  await first;
  expect(handle.closeSafely(settle, cleanup)).toBe(first);
  await handle.closeSafely(settle, cleanup);
  expect(settle).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});

it('takes one demo intent synchronously and permits another after success or failure', () => {
  const demo = new DemoStart();
  const changes = vi.fn();
  const detach = demo.subscribe(changes);
  expect(demo.start('Review')).toBe(true);
  expect(demo.start('Plan')).toBe(false);
  expect(demo.getSnapshot()).toEqual({ kind: 'opening', intent: 'Review' });
  demo.settled();
  expect(demo.start('Plan')).toBe(true);
  detach();
  demo.settled();
  expect(changes).toHaveBeenCalledTimes(3);
});
