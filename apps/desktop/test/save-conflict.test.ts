import { afterEach, expect, it } from 'vitest';
import { RevisionConflictError } from '@caotang/store';
import { documentSaveState, saveConflictWords } from '../src/app/save-conflict.js';
import { saveLineOf } from '../src/media/screenplay-model.js';
import { saveStateWords } from '../src/app/integrity-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

afterEach(() => activateEnglish());

it('gives the footer and project capsule the same conflict recovery instruction', async () => {
  for (const locale of ['en', 'de'] as const) {
    await activateCatalogue(locale);
    const recovery = locale === 'de'
      ? 'Kopieren Sie Ihren ungespeicherten Text vor dem Neuladen an einen sicheren Ort.'
      : 'Copy your unsaved text somewhere safe before reloading.';
    expect(saveConflictWords()).toContain(recovery);
    const capsule = saveStateWords('failed', 'newer-text', ['documents']);
    expect(capsule.text).toContain(recovery);
    expect(capsule.offersBackup).toBe(false);
  }
});

it('names the revision conflict and recovery in English and German', async () => {
  for (const locale of ['en', 'de'] as const) {
    await activateCatalogue(locale);
    const words = saveLineOf({ state: 'conflict', dirty: true, revision: 3, lastError: new Error('revision moved') });
    expect(words).toBe(saveConflictWords());
    expect(words).toBe(locale === 'en'
      ? 'Newer text is already saved for this document. Your words are kept in this tab. Copy your unsaved text somewhere safe before reloading.'
      : 'Für dieses Dokument ist bereits neuerer Text gespeichert. Ihre Wörter bleiben in diesem Tab. Kopieren Sie Ihren ungespeicherten Text vor dem Neuladen an einen sicheren Ort.');
  }
});

it('keeps the conflict recovery instruction while later typing is pending or saving', async () => {
  const conflict = new RevisionConflictError('n_scene', 3, 9);
  for (const locale of ['en', 'de'] as const) {
    await activateCatalogue(locale);
    for (const state of ['pending', 'saving', 'clean', 'error'] as const) {
      const status = { state, dirty: state !== 'clean', revision: 3, lastError: conflict };
      expect(saveLineOf(status)).toBe(saveConflictWords());
      expect(documentSaveState(status)).toBe('conflict');
    }
  }
  expect(documentSaveState({ state: 'clean', lastError: null })).toBe('clean');
  expect(saveLineOf({ state: 'clean', dirty: false, revision: 9, lastError: null })).toBe('Saved');
});
