import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getBody, getRevision, MemoryIndexedDb, openRuntimeStore, writeProjectState, type AutosaveStatus } from '@caotang/store';

import { IDS, project } from '../../../e2e/unit/fixtures.js';
import { ProjectSession } from '../src/app/session.js';
import { shadowOf } from '../src/app/persistence-plan.js';
import { documentSaveState, saveConflictWords } from '../src/app/save-conflict.js';
import { saveStateWords } from '../src/app/integrity-model.js';
import { saveLineOf } from '../src/media/screenplay-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  activateEnglish();
  vi.unstubAllGlobals();
});

it.each(['read', 'flush'] as const)('keeps both recovery messages after a later producer %s fails', async (failure) => {
  for (const locale of ['en', 'de'] as const) {
    await activateCatalogue(locale);
    const state = project();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);
    const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
    try {
      await session.settle();
      const statuses: AutosaveStatus[] = [];
      session.autosave.subscribe(({ status }) => statuses.push(status));
      const original = getBody(state, IDS.sceneA);
      session.autosave.open(IDS.sceneA, { body: original, revision: getRevision(state, IDS.sceneA) });
      expect(session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Newer saved text.' }).ok).toBe(true);
      await session.persistence.settle();
      session.autosave.noteEdit(IDS.sceneA, 'My unsaved words.');
      expect((await session.autosave.flush(IDS.sceneA))[0]?.outcome).toBe('conflict');
      const later = new Error('The later producer failed.');
      session.autosave.noteEdit(IDS.sceneA, () => { throw later; });
      if (failure === 'read') expect(session.autosave.pendingBodyOf(IDS.sceneA)).toBeNull();
      else expect((await session.autosave.flush(IDS.sceneA))[0]?.outcome).toBe('failed');
      const status = session.autosave.status(IDS.sceneA);
      expect(status.lastError).toBe(later);
      expect(status.revisionConflict).toBe(true);
      expect(statuses.at(-1)).toMatchObject({ revisionConflict: true, lastError: later });
      expect(saveLineOf(status)).toBe(saveConflictWords());
      expect(documentSaveState(status)).toBe('conflict');
      expect(session.saveState()).toBe('failed');
      expect(session.failedSaveChannels()).toEqual(['documents']);
      const capsule = saveStateWords(session.saveState(), undefined, session.failedSaveChannels());
      expect(capsule.text).toContain(locale === 'de'
        ? 'Kopieren Sie Ihren ungespeicherten Text vor dem Neuladen an einen sicheren Ort.'
        : 'Copy your unsaved text somewhere safe before reloading.');
      expect(capsule.offersBackup).toBe(false);
      session.autosave.noteEdit(IDS.sceneA, original);
      expect((await session.autosave.flush(IDS.sceneA))[0]?.outcome).toBe('unchanged');
      expect(documentSaveState(session.autosave.status(IDS.sceneA))).toBe('conflict');
      expect(session.saveState()).toBe('failed');
      await session.autosave.reseat(IDS.sceneA, { body: getBody(state, IDS.sceneA), revision: getRevision(state, IDS.sceneA) });
      expect(session.autosave.status(IDS.sceneA).revisionConflict).toBe(false);
      expect(session.saveState()).toBe('saved');
    } finally {
      await session.close();
      store.close();
    }
  }
});
