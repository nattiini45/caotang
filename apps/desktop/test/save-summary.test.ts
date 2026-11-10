import { afterEach, expect, it } from 'vitest';
import { saveStateWords } from '../src/app/integrity-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

afterEach(() => activateEnglish());

it('names the failed channel briefly without replacing its full recovery instruction', async () => {
  for (const locale of ['en', 'de'] as const) {
    await activateCatalogue(locale);
    for (const channel of ['documents', 'tasks', 'settings'] as const) {
      const names = locale === 'de'
        ? { documents: 'Dokumente', tasks: 'Aufgaben', settings: 'Einstellungen' }
        : { documents: 'Documents', tasks: 'Tasks', settings: 'Settings' };
      const words = saveStateWords('failed', 'newer-text', [channel]);
      expect(words.summary).toBe(`${locale === 'de' ? 'Nicht gespeichert' : 'Not saved'}: ${names[channel]}`);
      expect(words.text.length).toBeGreaterThan(words.summary!.length);
      if (channel === 'documents') expect(words.offersBackup).toBe(false);
    }
  }
});

it('keeps ordinary save states and Classic failure guidance unchanged', () => {
  expect(saveStateWords('saved')).toEqual({ text: 'All changes saved in this browser', offersBackup: false });
  expect(saveStateWords('saving')).toEqual({ text: 'Saving…', offersBackup: false });
  expect(saveStateWords('conflict')).toEqual({ text: 'Another tab has newer text', offersBackup: false });
  const failed = saveStateWords('failed');
  expect(failed.summary).toBe('Not saved: Project');
  expect(failed.text).toContain('written again on the next change');
  expect(failed.offersBackup).toBe(true);
});
