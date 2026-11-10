import { afterEach, expect, it } from 'vitest';
import { saveConflictWords } from '../src/app/save-conflict.js';
import { saveLineOf } from '../src/media/screenplay-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

afterEach(() => activateEnglish());

it('names the revision conflict and recovery in English and German', async () => {
  for (const locale of ['en', 'de'] as const) {
    await activateCatalogue(locale);
    const words = saveLineOf({ state: 'conflict', dirty: true, revision: 3, lastError: new Error('revision moved') });
    expect(words).toBe(saveConflictWords());
    expect(words).toBe(locale === 'en'
      ? 'Newer text is already saved for this document. Your words are kept in this tab. Copy them somewhere safe before reloading.'
      : 'Für dieses Dokument ist bereits neuerer Text gespeichert. Deine Wörter bleiben in diesem Tab. Kopiere sie vor dem Neuladen an einen sicheren Ort.');
  }
});
