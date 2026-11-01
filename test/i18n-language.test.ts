/**
 * The live interface-language switch (I4 / #194): load before activate, latest request wins, and a
 * failed load leaves the active catalogue and the stored setting alone. The controller is injected so
 * a load can be held open; no browser and no compiled pseudo catalogue is involved.
 */
import type { Messages } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { createLanguageController, type SwitchResult } from '../apps/desktop/src/i18n/language.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function harness(load: (tag: string) => Promise<Messages>) {
  const events: string[] = [];
  const controller = createLanguageController({
    resolve: (setting) => (setting === 'system' ? 'en' : setting),
    load: async (tag) => {
      events.push(`load:${tag}`);
      return load(tag);
    },
    activate: (tag) => {
      events.push(`activate:${tag}`);
    },
    publish: (tag) => {
      events.push(`publish:${tag}`);
    },
    messages: {
      loadFailed: () => 'load failed',
      persistFailed: () => 'persist failed',
    },
  });
  return { controller, events };
}

const switched: SwitchResult = { status: 'switched' };
const superseded: SwitchResult = { status: 'superseded' };

describe('the language switch', () => {
  it('loads the catalogue before it activates and publishes it', async () => {
    const gate = deferred<Messages>();
    const { controller, events } = harness(() => gate.promise);

    const switching = controller.switchTo('en-XA');
    expect(events).toEqual(['load:en-XA']);
    expect(controller.revision()).toBe(0);
    expect(controller.setting()).toBe('system');

    gate.resolve({ message: 'catalogue' });
    await expect(switching).resolves.toEqual(switched);
    expect(events).toEqual(['load:en-XA', 'activate:en-XA', 'publish:en-XA']);
    expect(controller.revision()).toBe(1);
    expect(controller.setting()).toBe('en-XA');
  });

  it('leaves everything alone when the load rejects', async () => {
    const { controller, events } = harness(() => Promise.reject(new Error('offline')));

    await expect(controller.switchTo('ar-XB')).resolves.toEqual({ status: 'failed', message: 'load failed' });
    expect(events).toEqual(['load:ar-XB']);
    expect(controller.revision()).toBe(0);
    expect(controller.setting()).toBe('system');
  });

  it('leaves everything alone when the setting names no catalogue this build has', async () => {
    const events: string[] = [];
    const controller = createLanguageController({
      resolve: () => {
        throw new Error('no such catalogue');
      },
      load: async () => {
        events.push('load');
      },
      activate: () => events.push('activate'),
      publish: () => events.push('publish'),
      messages: { loadFailed: () => 'load failed', persistFailed: () => 'persist failed' },
    });

    await expect(controller.switchTo('xx-XX')).resolves.toEqual({ status: 'failed', message: 'load failed' });
    expect(events).toEqual([]);
    expect(controller.revision()).toBe(0);
  });

  it('lets the latest request win when two loads race', async () => {
    const first = deferred<Messages>();
    const second = deferred<Messages>();
    const { controller, events } = harness((tag) => (tag === 'en-XA' ? first.promise : second.promise));

    const slow = controller.switchTo('en-XA');
    const fast = controller.switchTo('ar-XB');
    expect(events).toEqual(['load:en-XA', 'load:ar-XB']);

    second.resolve({});
    await expect(fast).resolves.toEqual(switched);
    expect(events).toEqual(['load:en-XA', 'load:ar-XB', 'activate:ar-XB', 'publish:ar-XB']);
    expect(controller.setting()).toBe('ar-XB');

    // The older download finishes late and must activate nothing.
    first.resolve({});
    await expect(slow).resolves.toEqual(superseded);
    expect(events).toEqual(['load:en-XA', 'load:ar-XB', 'activate:ar-XB', 'publish:ar-XB']);
    expect(controller.revision()).toBe(1);
    expect(controller.setting()).toBe('ar-XB');
  });

  it('does not resurrect an older successful load when the newer request fails', async () => {
    const first = deferred<Messages>();
    const { controller, events } = harness((tag) => (tag === 'en-XA' ? first.promise : Promise.reject(new Error('offline'))));

    const older = controller.switchTo('en-XA');
    await expect(controller.switchTo('ar-XB')).resolves.toEqual({ status: 'failed', message: 'load failed' });

    first.resolve({});
    await expect(older).resolves.toEqual(superseded);
    expect(events).toEqual(['load:en-XA', 'load:ar-XB']);
    expect(controller.revision()).toBe(0);
    expect(controller.setting()).toBe('system');
  });

  it('keeps the activated language when the preference cannot be saved, and says so', async () => {
    const { controller, events } = harness(() => Promise.resolve({}));

    await expect(controller.switchTo('en-XA', async () => 'The quota was exceeded.')).resolves.toEqual({
      status: 'kept',
      message: 'persist failed',
    });
    expect(events).toEqual(['load:en-XA', 'activate:en-XA', 'publish:en-XA']);
    expect(controller.setting()).toBe('en-XA');
  });

  it('publishes the preference only after activation, and never for a superseded request', async () => {
    const first = deferred<Messages>();
    const second = deferred<Messages>();
    const saved: string[] = [];
    const { controller, events } = harness((tag) => (tag === 'en-XA' ? first.promise : second.promise));

    const slow = controller.switchTo('en-XA', async (setting) => {
      saved.push(setting);
      return null;
    });
    const fast = controller.switchTo('ar-XB', async (setting) => {
      saved.push(setting);
      return null;
    });

    second.resolve({});
    await fast;
    first.resolve({});
    await expect(slow).resolves.toEqual(superseded);

    expect(events).toEqual(['load:en-XA', 'load:ar-XB', 'activate:ar-XB', 'publish:ar-XB']);
    expect(saved).toEqual(['ar-XB']);
  });
});
