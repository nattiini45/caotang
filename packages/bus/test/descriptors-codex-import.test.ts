/**
 * `codex.importBatch`'s descriptor (codex.md §7.1): the writer's batch import, validated whole before anything is written.
 *
 * What is pinned: the gate's class (never for an agent, compensable, one project mutation); every failing entry is listed by
 * name with its reason in one refusal; collisions with the codex's names and aliases and inside the batch are refused, never
 * merged; the citation must be the text at its offsets of the document or page it names; pages land in research unless the
 * caller names a folder, and never directly under the manuscript.
 */

import { describe, expect, it } from 'vitest';

import { COMMAND_REGISTRY, type PerOpFailure } from '../src/index.js';
import { CODEX_IMPORT_BATCH_MAX, codexImportBatch } from '../src/descriptors-codex-import.js';
import { BODY, CHAPTER_ONE, MANUSCRIPT, RESEARCH, THE_LANDING, makeSnapshot } from './fixtures.js';

const PAGE = { title: 'Mara', body: 'Mara keeps the light on the north point.' };
const MARA = { name: 'Mara', page: 0, cite: { from: 0, to: 4, quote: 'Mara' } };

function failuresOf(result: ReturnType<typeof codexImportBatch.validate>): PerOpFailure[] {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  return (result.error.details?.['failures'] as PerOpFailure[] | undefined) ?? [];
}

describe('codex.importBatch — the descriptor', () => {
  it('is the writer’s alone, compensable, and registered by the bus', () => {
    expect(COMMAND_REGISTRY['codex.importBatch'].descriptor).toBe(codexImportBatch);
    expect(codexImportBatch.agentRisk).toBe('never');
    expect(codexImportBatch.undo).toBe('compensable');
    expect(codexImportBatch.mutates).toBe('project');
  });

  it('accepts an entry citing a page of the same command, and puts the pages in research by default', () => {
    const result = codexImportBatch.validate({ entries: [MARA], pages: [PAGE] }, makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parentId).toBe(RESEARCH);
    expect(result.value.entries[0]).toEqual(MARA);
  });

  it('accepts an entry citing an existing document at the offsets of its body', () => {
    const from = BODY.indexOf('Elena');
    const result = codexImportBatch.validate(
      { entries: [{ name: 'the island', aliases: ['isle'], type: 'location', attachTo: THE_LANDING, cite: { from: BODY.indexOf('island'), to: BODY.indexOf('island') + 6, quote: 'island' } }] },
      makeSnapshot({ codex: [] }),
    );
    expect(from).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('lists every failing entry by name with its reason, in one refusal', () => {
    const result = codexImportBatch.validate(
      {
        entries: [
          { ...MARA, name: 'elena' }, // the fixture's existing entry, case-insensitively
          { ...MARA, name: 'Tomas', type: 'faction' },
          { ...MARA, name: 'Ilse', description: 'x'.repeat(2001) },
          { ...MARA, name: 'Petra', aliases: Array.from({ length: 11 }, (_, i) => `P${i}`) },
          { ...MARA, name: 'Oskar', keywords: ['k'.repeat(65)] },
          { ...MARA, name: 'Greta', cite: { from: 0, to: 4, quote: 'Gret' } },
          { ...MARA, name: 'Hanne', page: 3 },
          { name: 'Udo', cite: { from: 0, to: 1, quote: 'U' } },
          { ...MARA, name: 'Vera', origin: 'manual' },
        ],
        pages: [PAGE],
      },
      makeSnapshot(),
    );
    const failures = failuresOf(result);
    const text = failures.map((failure) => failure.message).join('\n');
    expect(text).toMatch(/"elena".*collides with the existing entry "Elena"/);
    expect(text).toMatch(/"Tomas".*type must be one of/);
    expect(text).toMatch(/"Ilse".*description is 2001 characters, limit 2000/);
    expect(text).toMatch(/"Petra".*aliases holds 11 items, limit 10/);
    expect(text).toMatch(/"Oskar".*keywords\[0\] is 65 characters/);
    expect(text).toMatch(/"Greta".*cite.quote is not the text/);
    expect(text).toMatch(/"Hanne".*page must be the index of one of the 1 pages/);
    expect(text).toMatch(/"Udo".*names neither a document nor a page/);
    expect(text).toMatch(/"Vera".*"origin" is not a field/);
    // Nine entries, each named; none is accepted while one fails.
    for (const name of ['elena', 'Tomas', 'Ilse', 'Petra', 'Oskar', 'Greta', 'Hanne', 'Udo', 'Vera']) expect(text).toContain(`"${name}"`);
    if (!result.ok) expect(result.error.correctiveHint).toMatch(/nothing was written/);
  });

  it('refuses a name or alias that collides with an existing alias, or with another entry of the batch — never a merge', () => {
    const snapshot = makeSnapshot({ codex: [{ id: 'c_2H7KD4M9QP', name: 'Elena', aliases: ['The Keeper'] }] });
    const failures = failuresOf(
      codexImportBatch.validate(
        {
          entries: [
            { ...MARA, aliases: ['the keeper'] },
            { ...MARA, name: 'Mara Lind', aliases: ['MARA'] },
          ],
          pages: [PAGE],
        },
        snapshot,
      ),
    );
    const text = failures.map((failure) => failure.message).join('\n');
    expect(text).toMatch(/"the keeper" collides with the existing entry "Elena"/);
    // The first entry failed, so its name was never claimed; the second collides with nothing but must still list the first's failure only.
    expect(failures).toHaveLength(1);
    const twice = failuresOf(
      codexImportBatch.validate(
        { entries: [MARA, { ...MARA, name: 'Mara Lind', aliases: ['MARA'] }], pages: [PAGE] },
        snapshot,
      ),
    );
    expect(twice.map((failure) => failure.message).join('\n')).toMatch(/"Mara Lind".*"MARA" collides with "Mara" in this same import/);
  });

  it('refuses an alias that repeats the entry’s own name', () => {
    const failures = failuresOf(codexImportBatch.validate({ entries: [{ ...MARA, aliases: ['mara'] }], pages: [PAGE] }, makeSnapshot()));
    expect(failures[0]?.message).toMatch(/"mara" is given twice for this entry/);
  });

  it('refuses the manuscript, the root and a document as the pages’ parent, and takes a research folder', () => {
    const tree = makeSnapshot({ extraNodes: [{ id: 'n_RSRCHFLDR1', parentId: RESEARCH, type: 'folder', title: 'People' }] });
    expect(codexImportBatch.validate({ entries: [MARA], pages: [PAGE], parentId: MANUSCRIPT }, tree).ok).toBe(false);
    expect(codexImportBatch.validate({ entries: [MARA], pages: [PAGE], parentId: 'root' }, tree).ok).toBe(false);
    expect(codexImportBatch.validate({ entries: [MARA], pages: [PAGE], parentId: THE_LANDING }, tree).ok).toBe(false);
    const ok = codexImportBatch.validate({ entries: [MARA], pages: [PAGE], parentId: 'n_RSRCHFLDR1' }, tree);
    expect(ok.ok && ok.value.parentId).toBe('n_RSRCHFLDR1');
    // A chapter takes pages too: it is a folder, not the manuscript itself.
    expect(codexImportBatch.validate({ entries: [MARA], pages: [PAGE], parentId: CHAPTER_ONE }, tree).ok).toBe(true);
  });

  it('takes pages with no entries (every row imported as a page only), and refuses an import of nothing', () => {
    expect(codexImportBatch.validate({ entries: [], pages: [PAGE] }, makeSnapshot()).ok).toBe(true);
    expect(codexImportBatch.validate({ entries: [] }, makeSnapshot()).ok).toBe(false);
  });

  it('lifts the agent tool’s cap of 20: 600 entries validate, and the ceiling is stated', () => {
    const pages = Array.from({ length: 600 }, (_, i) => ({ title: `Person ${i}`, body: `Person${i} lives here.` }));
    const entries = pages.map((_, i) => ({ name: `Person${i}`, page: i, cite: { from: 0, to: `Person${i}`.length, quote: `Person${i}` } }));
    const result = codexImportBatch.validate({ entries, pages }, makeSnapshot());
    expect(result.ok).toBe(true);
    const over = codexImportBatch.validate({ entries: Array.from({ length: CODEX_IMPORT_BATCH_MAX + 1 }, () => MARA), pages: [PAGE] }, makeSnapshot());
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('limit-exceeded');
  });
});
