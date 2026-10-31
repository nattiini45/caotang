import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DETERMINISTIC_CHECK_IDS, DETERMINISTIC_CHECK_LABELS, emptyCoherenceFile, type CoherenceRun } from '@caotang/coherence';
import {
  checkLabelOf,
  dismissalLabelOf,
  dismissalReasons,
  FILTER_LABELS,
  modeLabel,
  runViewsOf,
  scanCoverageLine,
  SCOPE_CHOICES,
} from '../src/app/findings-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

beforeEach(activateEnglish);
afterEach(activateEnglish);

function run(overrides: Partial<CoherenceRun> = {}): CoherenceRun {
  return {
    id: 'r_AAAAAAAAAA',
    at: '2026-10-08T09:00:00.000Z',
    kind: 'deterministic',
    checkIds: ['timeline.order-drift'],
    scope: { docIds: [], mode: 'full' },
    findingsUpserted: [],
    status: 'complete',
    ...overrides,
  };
}

describe('findings interface language', () => {
  it('translates the model-supplied picker and check labels after activation', async () => {
    expect(DETERMINISTIC_CHECK_IDS.map(checkLabelOf)).toEqual(DETERMINISTIC_CHECK_IDS.map((id) => DETERMINISTIC_CHECK_LABELS[id]));
    await activateCatalogue('en-XA');
    for (const id of DETERMINISTIC_CHECK_IDS) expect(checkLabelOf(id), id).toContain('⟦');
    for (const label of Object.values(FILTER_LABELS)) expect(label).toContain('⟦');
    for (const choice of SCOPE_CHOICES) expect(choice.label).toContain('⟦');
    for (const reason of dismissalReasons()) {
      expect(reason.label).toContain('⟦');
      if (reason.tooltip !== undefined) expect(reason.tooltip).toContain('⟦');
      if (reason.crossLink !== undefined) expect(reason.crossLink).toContain('⟦');
    }
    expect(modeLabel('flashback')).toContain('⟦');
    expect(modeLabel('a-future-mode')).toBe('A future mode');
    expect(dismissalLabelOf('the writer’s own reason')).toBe('the writer’s own reason');
    expect(scanCoverageLine([])).toContain('⟦');
    expect(scanCoverageLine(['timeline.order-drift'])).toContain('⟦');
    activateEnglish();
    expect(FILTER_LABELS.open).toBe('Open');
    expect(SCOPE_CHOICES[0]?.label).toBe('This document');
  });

  it('translates run metadata without rewriting persisted notes or titles', async () => {
    const file = emptyCoherenceFile();
    file.runs = [run({ kind: 'llm', scope: { docIds: ['n_SCENE00001'] }, notes: ['Writer evidence'], tokens: { promptTokens: 1234, completionTokens: 56 }, model: 'test-model' })];
    const original = structuredClone(file);
    await activateCatalogue('en-XA');
    const view = runViewsOf(file, () => 'الفصل الأول', 'en-US')[0];
    expect(view?.kind).toContain('⟦');
    expect(view?.status).toContain('⟦');
    expect(view?.scopeLabel).toContain('\u2068الفصل الأول\u2069');
    expect(view?.tokenLine).toContain('⟦');
    expect(view?.tokenLine).toContain('1,234');
    expect(view?.tokenLine).toContain('test-model');
    expect(view?.notes).toEqual(['Writer evidence']);
    expect(file).toEqual(original);
  });
});
