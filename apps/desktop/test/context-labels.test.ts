import { afterEach, expect, it } from 'vitest';
import { contextDropText, contextLayerLabel } from '../src/components/context-labels.js';
import { pinFormatLocale } from '../src/i18n/locale.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

afterEach(() => {
  activateEnglish();
  pinFormatLocale(undefined);
});

it('localizes structured reasons and stable layer IDs without changing the payload', async () => {
  await activateCatalogue('de');
  pinFormatLocale('de-DE');
  const drop = { text: 'Backend budget prose', reason: { kind: 'budget' as const, layer: 'L5' as const, budget: 12_000, rank: 2_000 } };
  const before = structuredClone(drop);
  expect(contextDropText(drop)).toBe('Das Budget von 12.000 Tokens für L5 ist ausgeschöpft (Rang 2.000).');
  expect(contextDropText({ text: 'Raw never policy', reason: { kind: 'never' } })).toBe('Die Einbeziehen-Regel des Eintrags ist „Nie“.');
  expect(contextDropText({ text: 'Raw read rule', reason: { kind: 'withheld' } })).toBe('Eine Leseregel hält dieses Element vom Agenten fern.');
  expect(contextLayerLabel('L2', 'Backend codex name')).toBe('Kodexeinträge');
  expect(drop).toEqual(before);
});

it('keeps legacy prose and unknown layer names as supplied fallback content', () => {
  activateEnglish();
  expect(contextDropText({ text: 'Legacy stored prose' })).toBe('Legacy stored prose');
  expect(contextLayerLabel('future-layer', 'Stored layer name')).toBe('Stored layer name');
});
