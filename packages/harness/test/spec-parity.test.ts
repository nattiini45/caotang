/**
 * The metadata table, checked against [agent-harness.md §3](../../../docs/architecture/agent-harness.md)
 * itself. The spec's rows are read out of the file, not copied, for the reason
 * `packages/bus/test/registry.test.ts` gives: a hand-copied table only proves the
 * copy still matches itself.
 *
 * Checked: the fourteen names and their order, the risk column, the undo column,
 * and each response cap the spec states in prose. The caps the spec does not state
 * are this package's choices and are asserted to exist, not to be any value.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { profileFor } from '@caotang/context';

import { TOOL_METADATA, TOOL_NAMES, metadataFor } from '../src/index.js';

const specPath = resolve(__dirname, '../../../docs/architecture/agent-harness.md');

interface SpecRow {
  readonly number: number;
  readonly name: string;
  readonly risk: string;
  readonly undo: string;
  readonly semantics: string;
}

function readSpecTable(): SpecRow[] {
  const spec = readFileSync(specPath, 'utf8');
  const start = spec.indexOf('## 3. Tool registry');
  const end = spec.indexOf('**Explicitly NOT agent tools');
  // Asserted on the indices, not on the slice: a slice from a miss is the file's
  // tail, and a test that reads it reports the wrong thing.
  expect(start, '§3 not found in agent-harness.md').toBeGreaterThanOrEqual(0);
  expect(end, '§3 end marker not found').toBeGreaterThan(start);
  const rows: SpecRow[] = [];
  for (const line of spec.slice(start, end).split('\n')) {
    if (!line.startsWith('|')) continue;
    // Unescaped pipes only: the Params column contains `\|` alternatives.
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const number = Number(cells[1]);
    if (!Number.isInteger(number) || number < 1) continue;
    // `binder.read_tree` carries an underscore, so the class is wider than the bus's.
    const name = /`([a-z][a-zA-Z._]*)`/.exec(cells[2] ?? '')?.[1] ?? '';
    rows.push({
      number,
      name,
      risk: (cells[3] ?? '').replace(/\*\*/g, ''),
      undo: cells[6] ?? '',
      semantics: cells[5] ?? '',
    });
  }
  return rows;
}

describe('§3 of agent-harness.md, read from the file', () => {
  const rows = readSpecTable();

  it('has the frozen fourteen rows, numbered 1 to 14', () => {
    expect(rows.map((row) => row.number)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
  });

  it('names the same tools in the same order as the registry', () => {
    expect(rows.map((row) => row.name)).toEqual(TOOL_NAMES.slice(0, 14));
  });

  it('gives every frozen row the metadata the spec says it has', () => {
    for (const row of rows) {
      const meta = metadataFor(row.name);
      expect(meta, `no metadata row for ${row.name}`).toBeDefined();
      if (meta === undefined) continue;
      // The spec's risk column names the three tool risks; agent.plan's row is `meta`.
      const expectedRisk = row.name === 'agent.plan' ? 'meta' : row.risk;
      expect(meta.risk, `risk of ${row.name}`).toBe(expectedRisk);
      // §3's Undo column: "—" and "n/a" are no undo; every named compensation is undoable.
      const undoable = !(row.undo.trim() === '—' || row.undo.trim() === 'n/a');
      expect(meta.undoable, `undoable of ${row.name}`).toBe(undoable);
    }
  });

  it('states the response caps it gives in prose, and the registry carries exactly those', () => {
    const stated = rows
      .map((row) => ({ name: row.name, match: /[Cc]ap ~?(\d+)k tokens/.exec(row.semantics) }))
      .filter((entry) => entry.match !== null);
    expect(stated.map((entry) => entry.name).sort()).toEqual(['binder.read_tree', 'codex.read', 'doc.read']);
    for (const entry of stated) {
      const expected = Number(entry.match?.[1]) * 1000;
      expect(metadataFor(entry.name)?.response_token_cap, `cap of ${entry.name}`).toBe(expected);
    }
  });
});

describe('the metadata table as a whole', () => {
  // Four extension rows follow doc.import: codex.import (codex.md §2 provenance) and the coherence
  // module's three tools (coherence.md §7, registry 14 → 17). The v0.1 surface is still the frozen 14.
  it('keeps agent.plan in the table as the fourteenth row, and marks the extensions as the only rows beyond it', () => {
    expect(metadataFor('agent.plan')?.risk).toBe('meta');
    const extensions = TOOL_METADATA.filter((meta) => meta.surface === 'extension').map((meta) => meta.name);
    // Then tool.search (extensibility §5), then the storyboard and prompt-pack modules' tools. Each is an
    // extension row, so none can be mistaken for part of the frozen v0.1 surface. The dialogue module's two rows close the
    // list (dialogue-narrative.md §7).
    expect(extensions).toEqual([
      'doc.import',
      'codex.import',
      'coherence.scan',
      'coherence.review',
      'coherence.setFindingStatus',
      'tool.search',
      'shots.derive',
      'shots.annotate',
      'prompt.draft',
      'prompt.variant',
      'dialogue.draft',
      'dialogue.table',
    ]);
    expect(TOOL_METADATA.filter((meta) => meta.surface === 'v0.1')).toHaveLength(14);
  });

  it('gives every row a non-empty description, a positive cap and a descriptionVersion of at least 1', () => {
    for (const meta of TOOL_METADATA) {
      expect(meta.description.trim().length, meta.name).toBeGreaterThan(40);
      expect(meta.response_token_cap, meta.name).toBeGreaterThan(0);
      expect(meta.descriptionVersion, meta.name).toBeGreaterThanOrEqual(1);
    }
  });

  it('declares doc.import as write-confirm and undoable, as the lead decided', () => {
    const meta = metadataFor('doc.import');
    expect(meta?.risk).toBe('write-confirm');
    expect(meta?.undoable).toBe(true);
  });
});

describe('the per-tool context budgets, checked against context-assembly.md §3', () => {
  const spec = readFileSync(resolve(__dirname, '../../../docs/architecture/context-assembly.md'), 'utf8');
  const line = spec.split('\n').find((candidate) => candidate.startsWith('- Per-tool defaults:'));

  /** The tokens a spec figure like `2.5k` or `25k` names. */
  const tokens = (figure: string): number => Math.round(Number(figure.replace('k', '')) * 1_000);
  const figure = (pattern: RegExp): number => {
    const match = pattern.exec(line ?? '');
    expect(match, `${pattern} not found in the per-tool defaults`).not.toBeNull();
    return tokens(match?.[1] ?? '');
  };

  it('finds the per-tool defaults line', () => {
    expect(line).toBeDefined();
  });

  it('continuity.scan expands L2 and L4 to the figures the spec states', () => {
    expect(profileFor('continuity.scan').budgets.L2).toBe(figure(/L2 expanded \((\d+(?:\.\d+)?k)\)/));
    expect(profileFor('continuity.scan').budgets.L4).toBe(figure(/L4 expanded \((\d+(?:\.\d+)?k)\)/));
  });

  it('synopsis.fill holds the full document at the stated cap, with L3 and no L2', () => {
    expect(profileFor('synopsis.fill').budgets.L5).toBe(figure(/L5 full doc \(cap (\d+(?:\.\d+)?k)\)/));
    expect(profileFor('synopsis.fill').layers).toContain('L3');
    expect(profileFor('synopsis.fill').layers).not.toContain('L2');
  });

  it('the metadata tools are L0, L1 and L7 only', () => {
    expect(profileFor('meta').layers).toEqual(['L0', 'L1', 'L7']);
  });
});
