/**
 * The prompt manifest golden (agent-harness §9): every text Caotang sends a model that is not the writer's own, hashed, with the
 * full text beside it in `prompt-manifest.md`. The planner's system message on both wires, the native tool declarations, every
 * draft role, the review prompts, the delegated agents' roles, and the description of every registry row.
 *
 * Two failures, so the reason is plain. A text changed: read the diff of `prompt-manifest.md`, then rewrite both files with
 * `CAOTANG_UPDATE_GOLDEN=1` and review them like a context golden. A tool's description changed and its `descriptionVersion` did
 * not: the failure names the tool, and `CAOTANG_UPDATE_GOLDEN=1` refuses to rewrite until the version is bumped (metadata.ts).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractionPrompt, verificationPrompt } from '@caotang/coherence';

import { DERIVE_SCHEMA_HINT, deriveRole } from '../../src/agent/storyboard-model.js';
import { continuityRole, dialogueRole, sceneRole, synopsisRole } from '../../src/agent/drafting.js';
import { MORE_TOOLS_LINE, TOOL_METADATA, SUBAGENT_SPECS, createProductHarness, plannerSystem, plannerSystemNative, plannerToolDefs } from '../../src/index.js';
import { makeState } from '../fixtures.js';

const DIR = __dirname;
const JSON_PATH = resolve(DIR, 'prompt-manifest.json');
const MD_PATH = resolve(DIR, 'prompt-manifest.md');
const UPDATE = process.env['CAOTANG_UPDATE_GOLDEN'] === '1';

interface ManifestEntry {
  readonly id: string;
  readonly sha256: string;
  readonly descriptionVersion?: number;
}

interface Source {
  readonly id: string;
  readonly text: string;
  readonly descriptionVersion?: number;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The harness a desktop host builds, with the review wired, so the planner lists the rows it lists in the app. */
function productTools() {
  const harness = createProductHarness({
    state: makeState(),
    ports: 'agent',
    coherence: {
      model: () => ({
        model: 'manifest',
        complete: () => Promise.reject(new Error('the manifest never asks a model')),
      }),
    },
  });
  return harness.tools();
}

const lines = (rows: readonly unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n');

/** A fixed input for the review prompts, so their text is the template and nothing else. */
const BLOCK = {
  pairId: 'p1',
  category: 'physical' as const,
  a: { docId: 'd1', from: 0, to: 4, quote: 'blue', before: 'Her eyes were ', after: '.' },
  b: { docId: 'd2', from: 0, to: 5, quote: 'green', before: 'Her eyes were ', after: '.' },
};

function sources(): readonly Source[] {
  const tools = productTools();
  const extraction = extractionPrompt({ docId: 'd1', title: 'Title', body: 'Body.', categories: ['physical'], codex: '', storySoFar: '' });
  const verification = verificationPrompt([BLOCK]);
  const out: Source[] = [
    { id: 'planner.system.json', text: plannerSystem(tools) },
    { id: 'planner.system.native', text: plannerSystemNative(tools) },
    { id: 'planner.more-tools-line', text: MORE_TOOLS_LINE },
    { id: 'planner.tools.native.all', text: lines(plannerToolDefs(tools, [], [], true)) },
    { id: 'draft.scene.prose', text: sceneRole() },
    { id: 'draft.scene.prose.target', text: sceneRole(120) },
    { id: 'draft.scene.screenplay.draft', text: sceneRole(120, 'screenplay', 'draft') },
    { id: 'draft.scene.screenplay.continue', text: sceneRole(120, 'screenplay', 'continue') },
    { id: 'draft.scene.screenplay.rewrite_selection', text: sceneRole(120, 'screenplay', 'rewrite_selection') },
    { id: 'draft.dialogue', text: dialogueRole(12) },
    { id: 'draft.synopsis', text: synopsisRole(40) },
    { id: 'draft.continuity.all-aspects', text: continuityRole([]) },
    { id: 'draft.continuity.timeline', text: continuityRole(['timeline']) },
    { id: 'draft.derive.key-shots', text: deriveRole('key-shots') },
    { id: 'draft.derive.full-coverage', text: deriveRole('full-coverage') },
    { id: 'draft.derive.schema', text: JSON.stringify(DERIVE_SCHEMA_HINT) },
    { id: 'review.extraction.system', text: extraction.system },
    { id: 'review.extraction.schema', text: JSON.stringify(extraction.jsonSchemaHint) },
    { id: 'review.verification.system', text: verification.system },
    { id: 'review.verification.schema', text: JSON.stringify(verification.jsonSchemaHint) },
    ...Object.values(SUBAGENT_SPECS).map((spec): Source => ({ id: `subagent.${spec.name}`, text: spec.system, descriptionVersion: spec.descriptionVersion })),
    ...TOOL_METADATA.map((meta): Source => ({ id: `tool.${meta.name}`, text: meta.description, descriptionVersion: meta.descriptionVersion })),
  ];
  return out;
}

function entriesOf(all: readonly Source[]): readonly ManifestEntry[] {
  return all.map((source) => ({ id: source.id, sha256: sha256(source.text), ...(source.descriptionVersion === undefined ? {} : { descriptionVersion: source.descriptionVersion }) }));
}

/** The full texts, one block each. A tilde fence, because a prompt may carry a backtick fence of its own. */
function markdownOf(all: readonly Source[], entries: readonly ManifestEntry[]): string {
  const blocks = all.map((source, index) => {
    const entry = entries[index] as ManifestEntry;
    const version = entry.descriptionVersion === undefined ? '' : ` (descriptionVersion ${entry.descriptionVersion})`;
    if (source.text.includes('~~~~')) throw new Error(`${source.id} holds a tilde fence`);
    return [`## ${source.id}${version}`, '', `sha256 ${entry.sha256}`, '', '~~~~text', source.text, '~~~~'].join('\n');
  });
  return [
    '# Prompt manifest',
    '',
    'Every text Caotang sends a model that is not the writer\'s own, as `prompt-manifest.test.ts` builds it. Rewrite with `CAOTANG_UPDATE_GOLDEN=1`;',
    'a changed text is reviewed like a context golden (CONTRIBUTING.md, "Prompts and evals").',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

function committed(): readonly ManifestEntry[] {
  return existsSync(JSON_PATH) ? (JSON.parse(readFileSync(JSON_PATH, 'utf8')) as readonly ManifestEntry[]) : [];
}

/** The tools whose description hash differs from the committed one while their descriptionVersion is the same. Pure, so it is tested. */
function unbumped(before: readonly ManifestEntry[], after: readonly ManifestEntry[]): readonly string[] {
  const old = new Map(before.map((entry) => [entry.id, entry]));
  return after
    .filter((entry) => {
      const was = old.get(entry.id);
      return was !== undefined && entry.descriptionVersion !== undefined && was.sha256 !== entry.sha256 && was.descriptionVersion === entry.descriptionVersion;
    })
    .map((entry) => entry.id);
}

const unbumpedMessage = (ids: readonly string[]): string =>
  `${ids.map((id) => `${id} changed its text and kept descriptionVersion`).join('; ')}: bump descriptionVersion in the row (metadata.ts) so an eval can say which wording it ran against`;

const WAS = committed();
const ALL = sources();
const NOW = entriesOf(ALL);

describe('the prompt manifest golden', () => {
  if (UPDATE) {
    it('rewrites the manifest, unless a description changed without its descriptionVersion', () => {
      const stale = unbumped(WAS, NOW);
      if (stale.length > 0) throw new Error(unbumpedMessage(stale));
      writeFileSync(JSON_PATH, `${JSON.stringify(NOW, null, 2)}\n`);
      writeFileSync(MD_PATH, markdownOf(ALL, NOW));
    });
    return;
  }

  it('covers every registered tool, each with a descriptionVersion', () => {
    for (const meta of TOOL_METADATA) {
      const entry = WAS.find((candidate) => candidate.id === `tool.${meta.name}`);
      expect(entry, `${meta.name} is missing from prompt-manifest.json: rewrite it with CAOTANG_UPDATE_GOLDEN=1`).toBeDefined();
      expect(entry?.descriptionVersion).toBe(meta.descriptionVersion);
    }
  });

  it('no description changed without a descriptionVersion bump', () => {
    const stale = unbumped(WAS, NOW);
    expect(stale, unbumpedMessage(stale)).toEqual([]);
  });

  it('no prompt text changed', () => {
    const changed = NOW.filter((entry) => WAS.find((was) => was.id === entry.id)?.sha256 !== entry.sha256).map((entry) => entry.id);
    const gone = WAS.filter((was) => !NOW.some((entry) => entry.id === was.id)).map((was) => was.id);
    expect({ changed, gone }, 'a prompt changed: read the diff of prompt-manifest.md, then CAOTANG_UPDATE_GOLDEN=1').toEqual({ changed: [], gone: [] });
    expect(NOW).toEqual(WAS);
  });

  it('keeps the full texts beside the hashes', () => {
    expect(readFileSync(MD_PATH, 'utf8')).toBe(markdownOf(ALL, NOW));
  });

  it('names the tool when a description changes and its version does not', () => {
    const edited = NOW.map((entry) => (entry.id === 'tool.scene.draft' ? { ...entry, sha256: sha256('a reworded description') } : entry));
    expect(unbumped(NOW, edited)).toEqual(['tool.scene.draft']);
    expect(unbumpedMessage(unbumped(NOW, edited))).toContain('tool.scene.draft changed its text and kept descriptionVersion');
    const bumped = edited.map((entry) => (entry.id === 'tool.scene.draft' ? { ...entry, descriptionVersion: (entry.descriptionVersion ?? 0) + 1 } : entry));
    expect(unbumped(NOW, bumped)).toEqual([]);
  });
});
