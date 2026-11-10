// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyInterface, currentInterface, interfaceStatus, setModernShellLoader } from '../src/app/interface.js';
import { DEFAULT_SETTINGS } from '../src/app/settings.js';
import type { AppServices } from '../src/app/services.js';
import { Settings } from '../src/components/Settings.js';
import { activateEnglish } from '../src/i18n/runtime.js';

let root: Root;
let host: HTMLDivElement;

const services = { settings: { current: () => DEFAULT_SETTINGS, subscribe: () => () => undefined } } as unknown as AppServices;

function renderSettings(): void {
  root.render(<I18nProvider i18n={i18n}><Settings services={services} session={null} store={null} initialSection="appearance" onClose={() => undefined} /></I18nProvider>);
}

beforeEach(async () => {
  activateEnglish();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.open = true; },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); },
  });
  localStorage.clear();
  setModernShellLoader(() => Promise.resolve());
  await applyInterface('classic');
  host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setModernShellLoader(() => Promise.resolve());
});

describe('Settings interface load feedback', () => {
  it('announces a failed Modern switch beside the choice and retries without losing radio focus', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('Private loader detail')).mockResolvedValue(undefined);
    setModernShellLoader(load);
    await act(async () => renderSettings());
    const modern = host.querySelectorAll<HTMLInputElement>('input[name="shell"]')[1];
    if (!modern) throw new Error('Missing Modern radio');
    modern.focus();
    await act(async () => modern.click());
    expect(document.activeElement).toBe(modern);
    expect(modern.checked).toBe(true);
    expect(currentInterface()).toBe('classic');
    const choice = host.querySelector('[data-testid="interface-choice"]');
    expect(choice?.getAttribute('data-state')).toBe('failed');
    expect(choice?.nextElementSibling?.textContent).toContain('Modern could not load. The current interface is still in use. Try again or choose Classic.');
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('Private loader detail');
    expect(localStorage.getItem('caotang.interface')).toBe('modern');
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Try again');
    if (!retry) throw new Error('Missing retry button');
    retry.focus();
    await act(async () => retry.click());
    expect(document.activeElement).toBe(modern);
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(choice?.getAttribute('data-state')).toBe('ready');
    expect(currentInterface()).toBe('modern');
  });

  it('subscribes to external choices and shows a pending load without disabling Classic', async () => {
    await act(async () => renderSettings());
    let finish!: () => void;
    setModernShellLoader(() => new Promise<void>((resolve) => { finish = resolve; }));
    let load!: Promise<unknown>;
    await act(async () => { load = applyInterface('modern'); });
    const radios = host.querySelectorAll<HTMLInputElement>('input[name="shell"]');
    expect(radios[1]?.checked).toBe(true);
    expect(radios[0]?.disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading the interface…');
    await act(async () => { radios[0]?.click(); });
    expect(interfaceStatus().chosen).toBe('classic');
    await act(async () => { finish(); await load; });
    expect(radios[0]?.checked).toBe(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('retains failure feedback after Settings is reopened', async () => {
    setModernShellLoader(() => Promise.reject(new Error('Offline')));
    await applyInterface('modern').catch(() => undefined);
    await act(async () => renderSettings());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Modern could not load.');
    expect(host.querySelectorAll<HTMLInputElement>('input[name="shell"]')[1]?.checked).toBe(true);
  });
});
