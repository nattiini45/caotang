import { useEffect, useReducer } from 'react';
import { RuntimeStoreNewerError } from '@caotang/store';

import { runtimeStore } from './runtime.js';
import { fixtureWireFactory } from './mcp.js';
import { openAppServices } from './services.js';
import { initializeInterfaceLanguage } from '../i18n/language.js';
import { listProjects, setSessionDefaults } from './lifecycle.js';
import { interfacePending, settleInterface } from './interface.js';
import { bootMachine, type BootPhase } from './boot-phase.js';

export function useBootPhase(): BootPhase {
  const [phase, send] = useReducer(bootMachine.step, { kind: 'opening' });
  useEffect(() => {
    let alive = true;
    let detach: (() => void) | undefined;
    const factory = typeof indexedDB === 'undefined' ? null : indexedDB;
    const mcpWire = import.meta.env.DEV ? fixtureWireFactory() : undefined;
    void Promise.all([
      runtimeStore(),
      openAppServices(factory, { mcpWire }).then(async (services) => ({
        services,
        notice: await initializeInterfaceLanguage(services.settings.current().interfaceLanguage),
      })),
    ]).then(async ([store, { services, notice }]) => {
      if (!alive) return;
      const apply = (): void => {
        const { editor, retention } = services.settings.current();
        const coherence = { checks: () => services.settings.current().coherence.enabledChecks, providers: services.providers };
        const appRules = () => services.settings.current().agent.rules;
        setSessionDefaults({ debounceMs: editor.autosaveDebounceMs, retention, mcp: { client: services.mcp.client }, coherence, appRules, saveChannels: [services.settings.saveChannel] });
      };
      apply();
      detach = services.settings.subscribe(apply);
      send({ type: 'opened', store, services, notice });
      if (interfacePending()) {
        const projects = await listProjects(store).then((rows) => rows.length > 0, () => true);
        if (!alive) return;
        await settleInterface(projects, services.settingsKept).catch(() => undefined);
      }
      if (alive) send({ type: 'ready' });
    }).catch((error: unknown) => {
      if (alive) send({ type: 'failed', error: error instanceof Error ? error.message : String(error), newer: error instanceof RuntimeStoreNewerError });
    });
    return () => { alive = false; detach?.(); };
  }, []);
  return phase;
}
