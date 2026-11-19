// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, it, vi } from 'vitest';
import { APP_KEYS, type AppDb } from '../src/app/app-db.js';
import { SettingsStore } from '../src/app/services.js';
import { DEFAULT_SETTINGS } from '../src/app/settings.js';
import { ModelHookSettings } from '../src/components/ModelHookSettings.js';
import { activateEnglish } from '../src/i18n/runtime.js';

it('names the form controls for agents and only saves instructions after confirmation', async () => {
  activateEnglish();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const visibility = Object.getOwnPropertyDescriptor(Element.prototype, 'checkVisibility');
  Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, value: () => true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const put = vi.fn<AppDb['put']>().mockResolvedValue(undefined);
  const db: AppDb = { put, get: async () => undefined, list: async () => [], delete: async () => {}, close: () => {} };
  const settings = new SettingsStore(db, DEFAULT_SETTINGS);
  let approved = false;
  const agent = createAgent({ allow: (step) => !step.confirm || approved });
  const change = async (ref: string, action: string, args: unknown[] = []): Promise<void> => {
    await act(async () => {
      const result = await agent.act({ steps: [{ ref, action, args }] });
      expect(result.ok, result.error?.message).toBe(true);
    });
  };
  const projectId = 'p_123456789A';
  try {
    await act(async () => root.render(<I18nProvider i18n={i18n}><ModelHookSettings projectId={projectId} services={{ db, settings }} /></I18nProvider>));
    await change('Add model hook', 'press');
    const entries = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more');
    for (const name of ['Name', 'Built-in agent tool', 'Event', 'Check instructions', 'Block the tool if the model hook cannot run', 'Save model hook']) {
      expect(entries.map((entry) => entry.label)).toContain(name);
    }
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(host.querySelector('input[data-slot="input"]'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Enter a name');
    await change('Name', 'setValue', ['Check scene notes']);
    await change('Built-in agent tool', 'setValue', ['notes.append']);
    await change('Check instructions', 'setValue', ['Look for a decision.']);
    await act(async () => {
      const denied = await agent.act({ steps: [{ ref: 'Save model hook', action: 'press', args: [] }] });
      expect(denied.ok).toBe(false);
    });
    expect(put).not.toHaveBeenCalled();
    approved = true;
    await change('Save model hook', 'press');
    expect(put).toHaveBeenCalledWith(APP_KEYS.settings, expect.objectContaining({
      modelHooks: { [projectId]: [expect.objectContaining({ name: 'Check scene notes', tool: 'notes.append', event: 'tool.before', prompt: 'Look for a decision.' })] },
    }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Saved the model hook.');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (visibility === undefined) Reflect.deleteProperty(Element.prototype, 'checkVisibility');
    else Object.defineProperty(Element.prototype, 'checkVisibility', visibility);
    vi.unstubAllGlobals();
  }
});
