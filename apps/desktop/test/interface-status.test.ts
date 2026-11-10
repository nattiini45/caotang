import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';

import type * as InterfaceModule from '../src/app/interface.js';

let api: typeof InterfaceModule;
let dataset: Record<string, string>;
let values: Map<string, string>;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  dataset = {};
  values = new Map();
  vi.stubGlobal('document', { documentElement: { dataset } });
  vi.stubGlobal('window', { localStorage: {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  api = await import('../src/app/interface.js');
});

afterEach(() => vi.unstubAllGlobals());

describe('the interface load status', () => {
  it('agrees with its transition table for every state and event', () => {
    expect(checkMachine(api.interfaceMachine, {
      states: [
        { kind: 'ready', chosen: 'classic', shown: 'classic' },
        { kind: 'ready', chosen: 'modern', shown: 'modern' },
        { kind: 'loading', chosen: 'modern', shown: 'classic' },
        { kind: 'loading', chosen: 'classic', shown: 'modern' },
        { kind: 'failed', chosen: 'modern', shown: 'classic', error: new Error('Offline') },
      ],
      events: [{ type: 'choose', value: 'classic' }, { type: 'choose', value: 'modern' }, { type: 'loaded' }, { type: 'failed', error: new Error('Offline') }],
    })).toEqual([]);
  });

  it('publishes a failed Modern choice without changing the displayed interface or stored choice', async () => {
    const error = new Error('Chunk unavailable');
    api.setModernShellLoader(() => Promise.reject(error));
    const listener = vi.fn();
    const unsubscribe = api.subscribeInterface(listener);
    api.rememberInterface('modern');
    const load = api.applyInterface('modern');
    expect(api.interfaceStatus()).toEqual({ kind: 'loading', chosen: 'modern', shown: 'classic' });
    await expect(load).rejects.toBe(error);
    expect(api.interfaceStatus()).toEqual({ kind: 'failed', chosen: 'modern', shown: 'classic', error });
    expect(api.currentInterface()).toBe('classic');
    expect(dataset['shell']).toBe('modern');
    expect([...values]).toEqual([[api.INTERFACE_KEY, 'modern']]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    api.setModernShellLoader(() => Promise.resolve());
    await api.applyInterface('modern');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clears a failure on retry and publishes Modern only once the retry loads', async () => {
    api.setModernShellLoader(() => Promise.reject(new Error('Offline')));
    await api.applyInterface('modern').catch(() => undefined);
    const retry = deferred();
    api.setModernShellLoader(() => retry.promise);
    const load = api.applyInterface('modern');
    expect(api.interfaceStatus()).toEqual({ kind: 'loading', chosen: 'modern', shown: 'classic' });
    retry.resolve();
    await load;
    expect(api.interfaceStatus()).toEqual({ kind: 'ready', chosen: 'modern', shown: 'modern' });
    expect(api.currentInterface()).toBe('modern');
  });

  for (const outcome of ['success', 'failure'] as const) {
    it(`ignores a stale Modern ${outcome} after Classic is chosen`, async () => {
      const old = deferred();
      api.setModernShellLoader(() => old.promise);
      const first = api.applyInterface('modern').catch(() => undefined);
      await api.applyInterface('classic');
      const latest = api.interfaceStatus();
      if (outcome === 'success') old.resolve();
      else old.reject(new Error('Stale failure'));
      await first;
      expect(api.interfaceStatus()).toBe(latest);
      expect(latest).toEqual({ kind: 'ready', chosen: 'classic', shown: 'classic' });
      expect(dataset['shell']).toBe('classic');
    });

    it(`ignores a stale Modern ${outcome} while a newer Modern choice is loading`, async () => {
      const old = deferred();
      const next = deferred();
      api.setModernShellLoader(() => old.promise);
      const first = api.applyInterface('modern').catch(() => undefined);
      api.setModernShellLoader(() => next.promise);
      const second = api.applyInterface('modern');
      const latest = api.interfaceStatus();
      if (outcome === 'success') old.resolve();
      else old.reject(new Error('Stale failure'));
      await first;
      expect(api.interfaceStatus()).toBe(latest);
      expect(api.currentInterface()).toBe('classic');
      next.resolve();
      await second;
      expect(api.interfaceStatus()).toEqual({ kind: 'ready', chosen: 'modern', shown: 'modern' });
    });
  }

  it('clears a failed Modern choice when Classic is chosen', async () => {
    api.setModernShellLoader(() => Promise.reject(new Error('Offline')));
    await api.applyInterface('modern').catch(() => undefined);
    await api.applyInterface('classic');
    expect(api.interfaceStatus()).toEqual({ kind: 'ready', chosen: 'classic', shown: 'classic' });
  });

  it('keeps the displayed Modern interface if another Modern load fails', async () => {
    await api.applyInterface('modern');
    api.setModernShellLoader(() => Promise.reject(new Error('Offline')));
    await api.applyInterface('modern').catch(() => undefined);
    expect(api.interfaceStatus()).toMatchObject({ kind: 'failed', chosen: 'modern', shown: 'modern' });
    expect(api.currentInterface()).toBe('modern');
  });

  it('publishes a synchronous loader failure as a rejected load', async () => {
    const error = new Error('Loader failed');
    api.setModernShellLoader(() => { throw error; });
    await expect(api.applyInterface('modern')).rejects.toBe(error);
    expect(api.interfaceStatus()).toEqual({ kind: 'failed', chosen: 'modern', shown: 'classic', error });
  });

  it('preserves the Classic fallback when a Classic skin fails', async () => {
    await api.applyInterface('modern');
    const error = new Error('Skin failed');
    vi.spyOn(await import('../src/app/skin.js'), 'applySkin').mockRejectedValueOnce(error);
    await expect(api.applyInterface('classic')).rejects.toBe(error);
    expect(api.interfaceStatus()).toEqual({ kind: 'failed', chosen: 'classic', shown: 'classic', error });
    expect(api.currentInterface()).toBe('classic');
  });
});
