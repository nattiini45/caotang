// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { createAgent } from '@ui-sdk/react/agent';
import type { ModelHook } from '@caotang/harness';
import { expect, it, vi } from 'vitest';
import { APP_KEYS, type AppDb } from '../src/app/app-db.js';
import { SettingsStore } from '../src/app/services.js';
import { DEFAULT_SETTINGS } from '../src/app/settings.js';
import { ModelHookSettings } from '../src/components/ModelHookSettings.js';
import { activateEnglish } from '../src/i18n/runtime.js';

const projectId = 'p_123456789A';
const hook: ModelHook = {
  id: 'r_123456789A', name: 'Check scene notes', enabled: true, event: 'tool.before',
  tool: 'notes.append', prompt: 'Look for a decision.', failClosed: true,
};

async function renderSettings(test: (fixture: {
  host: HTMLDivElement;
  put: ReturnType<typeof vi.fn<AppDb['put']>>;
  settings: SettingsStore;
  agent: ReturnType<typeof createAgent>;
  change: (ref: string, action: string, args?: unknown[]) => Promise<void>;
  approve: () => void;
}) => Promise<void>, initial?: ModelHook): Promise<void> {
  activateEnglish();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const visibility = Object.getOwnPropertyDescriptor(Element.prototype, 'checkVisibility');
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, value: () => true });
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const put = vi.fn<AppDb['put']>().mockResolvedValue(undefined);
  const db: AppDb = { put, get: async () => undefined, list: async () => [], delete: async () => {}, close: () => {} };
  const settings = new SettingsStore(db, initial === undefined ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, modelHooks: { [projectId]: [initial] } });
  let approved = false;
  const agent = createAgent({ allow: (step) => !step.confirm || approved });
  const change = async (ref: string, action: string, args: unknown[] = []): Promise<void> => {
    await act(async () => {
      const result = await agent.act({ steps: [{ ref, action, args }] });
      expect(result.ok, result.error?.message).toBe(true);
    });
  };
  try {
    await act(async () => root.render(<I18nProvider i18n={i18n}><ModelHookSettings projectId={projectId} services={{ db, settings }} /></I18nProvider>));
    await test({ host, put, settings, agent, change, approve: () => { approved = true; } });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (visibility === undefined) Reflect.deleteProperty(Element.prototype, 'checkVisibility');
    else Object.defineProperty(Element.prototype, 'checkVisibility', visibility);
    if (animations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations');
    else Object.defineProperty(Element.prototype, 'getAnimations', animations);
    vi.unstubAllGlobals();
  }
}

it('names the form controls for agents and only saves instructions after confirmation', () =>
  renderSettings(async ({ host, put, settings, agent, change, approve }) => {
    await change('Add model hook', 'press');
    const labels = () => agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more').map((entry) => entry.label);
    for (const name of ['Name', 'Built-in agent tool', 'Event', 'Check instructions', 'Block the tool if the model hook cannot run', 'Save model hook']) {
      expect(labels()).toContain(name);
    }
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(host.querySelector('input[data-slot="input"]'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Enter a name');
    await change('Name', 'setValue', ['Check scene notes']);
    await change('Built-in agent tool', 'setValue', ['notes.append']);
    expect(labels()).toContain('Let this hook propose replacement text');
    await change('Check instructions', 'setValue', ['Look for a decision.']);
    await act(async () => {
      const denied = await agent.act({ steps: [{ ref: 'Save model hook', action: 'press', args: [] }] });
      expect(denied.ok).toBe(false);
    });
    expect(put).not.toHaveBeenCalled();
    approve();
    await change('Save model hook', 'press');
    expect(put).toHaveBeenCalledWith(APP_KEYS.settings, expect.objectContaining({
      modelHooks: { [projectId]: [expect.objectContaining({ name: 'Check scene notes', tool: 'notes.append', event: 'tool.before', prompt: 'Look for a decision.' })] },
    }));
    expect(settings.current().modelHooks[projectId]?.[0]).not.toHaveProperty('canTransform');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Saved the model hook.');
  }));

async function key(element: Element | null, value: string): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    const options = { key: value, code: value === ' ' ? 'Space' : value, bubbles: true, cancelable: true };
    const down = element?.dispatchEvent(new KeyboardEvent('keydown', options));
    const up = element?.dispatchEvent(new KeyboardEvent('keyup', options));
    if (value === ' ' && down && up && element instanceof HTMLButtonElement) element.click();
  });
}

it('opts into a replacement with Space and requires a new opt-in when the tool changes', () =>
  renderSettings(async ({ host, settings, change, approve }) => {
    approve();
    await change('Edit Check scene notes', 'press');
    const rewriteCheckbox = () => [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find(control => control.textContent?.includes('Let this hook propose replacement text'));
    expect(rewriteCheckbox()?.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(rewriteCheckbox()?.getAttribute('aria-describedby') ?? '')?.textContent).toContain('new approval card');
    await act(async () => { rewriteCheckbox()?.focus(); });
    await key(document.activeElement, ' ');
    expect(rewriteCheckbox()?.getAttribute('aria-checked')).toBe('true');
    await change('Built-in agent tool', 'setValue', ['scene.draft']);
    expect(rewriteCheckbox()).toBeUndefined();
    await change('Built-in agent tool', 'setValue', ['synopsis.set']);
    expect(rewriteCheckbox()?.getAttribute('aria-checked')).toBe('false');
    await act(async () => { rewriteCheckbox()?.focus(); });
    await key(document.activeElement, ' ');
    await change('Save model hook', 'press');
    expect(settings.current().modelHooks[projectId]?.[0]).toMatchObject({ tool: 'synopsis.set', canTransform: true });
  }, hook));

it('chooses turn-end by keyboard and saves without a tool, fail-closed flag or rewrite opt-in', () =>
  renderSettings(async ({ host, settings, agent, change, approve }) => {
    approve();
    await change('Edit Check scene notes', 'press');
    expect([...host.querySelectorAll('[role="checkbox"]')].map(control => control.getAttribute('aria-checked'))).toEqual(['true', 'true']);
    const eventTrigger = host.querySelector<HTMLElement>('[role="combobox"]');
    await act(async () => { eventTrigger?.focus(); });
    await key(eventTrigger, 'ArrowDown');
    expect(eventTrigger?.getAttribute('aria-expanded')).toBe('true');
    await key(document.activeElement, 'End');
    await key(document.activeElement, 'Enter');
    await vi.waitFor(() => expect(document.activeElement).toBe(eventTrigger));
    expect(eventTrigger?.textContent).toContain('When the agent finishes a turn');
    expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    expect(agent.snapshot().filter(entry => !entry.offPage).map(entry => entry.label)).not.toContain('Built-in agent tool');
    expect(document.getElementById(eventTrigger?.getAttribute('aria-describedby') ?? '')?.textContent).toContain('usual approval rules');
    await change('Save model hook', 'press');
    const turn = settings.current().modelHooks[projectId]?.[0];
    expect(turn).toMatchObject({ event: 'turn.end', tool: '', failClosed: false });
    expect(turn).not.toHaveProperty('canTransform');
    expect(host.querySelector('.settings-rules li')?.textContent).toContain('When the agent finishes a turn');
  }, { ...hook, canTransform: true }));
