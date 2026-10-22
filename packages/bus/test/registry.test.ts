/**
 * The registry, checked against [command-bus.md §9](docs/architecture/command-bus.md)
 * itself.
 *
 * The two halves of this file are the two directions a closed set can drift:
 * `COMMAND_NAMES` can grow past what §9 lists, and §9 can grow past what the
 * code registers. The first is caught by the type system (`CommandRegistry` is a
 * mapped type over `CommandName`, so a name with no entry does not compile); the
 * second is caught here, by **reading the spec's table out of the file** and
 * comparing it column by column.
 *
 * A guard whose subject is a document has to read that document. A hand-copied
 * duplicate of §9's table would only prove the copy still matches itself — and a
 * stale number would still pass as current.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_NAMES,
  COMMAND_REGISTRY,
  DECLARED_PARAMS,
  FIXED_ROOT_IDS,
  VARIOUS_PARAM_NAMES,
  VIEW_COMMAND_NAMES,
  buildRegistry,
  isCommandName,
  isFixedRootId,
  lookupCommand,
  registeredNames,
  resolveCommand,
} from '../src/index.js';
import type { CommandName, ValidationSnapshot } from '../src/index.js';
import {
  CHAPTER_ONE,
  CHAPTER_TWO,
  CODEX_ENTRY,
  MANUSCRIPT,
  REVISION,
  THE_LANDING,
  makeSnapshot,
} from './fixtures.js';

const specPath = resolve(__dirname, '../../../docs/architecture/command-bus.md');
const descriptorsPath = resolve(__dirname, '../src/descriptors.ts');

/**
 * Every name the registry holds beyond §9's table. **Empty:** §9 tabulates all 42 names in `COMMAND_NAMES`.
 * The arithmetic, stated once: 36 table rows name 38 commands (the view row names three), and four more rows
 * (`shot.importImage`, and the script imports `screenplay.import`, `dialogue.importInk`, `dialogue.setMeta`)
 * make 40 rows and **42 names**. A name added to `COMMAND_NAMES` must get its §9 row in the same change. The stale check below
 * stays: a name listed here that §9 also tabulates fails it.
 */
const UNTABULATED_NAMES: readonly string[] = [];

interface SpecRow {
  name: string;
  agentRisk: string;
  undo: string;
  /** §9's "Params (essentials)" cell, verbatim — backticks and all. */
  params: string;
}

/**
 * §9's rows, read from the spec.
 *
 * Only the **first cell** of each row is scanned: the Notes column legitimately
 * backticks *other* command and tool names (`binder.restructure`, `codex.write`,
 * `scene.draft`), and those are names the registry must not contain. The final
 * view row packs three names into one cell, so every backticked name in cell 0
 * counts.
 */
function readSpecRegistry(): SpecRow[] {
  const spec = readFileSync(specPath, 'utf8');
  const heading = '## 9. v0.1 command registry';
  const at = spec.indexOf(heading);
  // **Asserted on `indexOf`, not on the slice — the finding.** This read the
  // slice and checked `section.length > 0`, but `String.slice(-1)` on a miss
  // returns the file's **last character**, so `section.length` is 1 and the
  // assertion named "§9 not found in command-bus.md" could never fail. A renamed
  // or deleted §9 therefore reported itself 200 lines later as
  // "expected length 18, got 0" — a message about the row count, in a different
  // test, naming neither the spec nor the heading. `indexOf` is the one value
  // that is `-1` exactly when the heading is absent.
  expect(at, '§9 not found in command-bus.md').toBeGreaterThanOrEqual(0);
  const section = spec.slice(at);
  const rows: SpecRow[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    // Split on unescaped pipes only: §9's params column contains `type: 'folder'\|'document'`,
    // and a naive split shifts every later column by one.
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    const first = cells[1] ?? '';
    const names = [...first.matchAll(/`([a-z][a-zA-Z]*\.[a-zA-Z]+)`/g)].map((m) => m[1] ?? '');
    if (names.length === 0) continue;
    // "never (direct)" and "compensable (delete artifact)" are the enum plus a
    // gloss; `project.deleteNode`'s risk is emphasised in the spec as **never**.
    const strip = (cell: string | undefined): string =>
      (cell ?? '').replace(/\*\*/g, '').replace(/\s*\(.*\)$/, '');
    const agentRisk = strip(cells[3]);
    const undo = strip(cells[4]);
    const params = cells[2] ?? '';
    for (const name of names) rows.push({ name, agentRisk, undo, params });
  }
  return rows;
}

/**
 * §9's Params cell → the **top-level** key names of its `{a, b: Type, c?}` literal.
 *
 * `undefined` for a cell that is not a literal — today the three view rows, whose
 * params §9 states as the word "various". The exemption is earned by that word,
 * not by a name list, and the set of exempt rows is asserted separately, so a
 * future row that says "various" fails instead of joining a silent hole.
 *
 * **Keys, not types.** `type: 'folder'\|'document'` and `entries: CodexUpsert[]`
 * are read for their key alone. §9 is a *key* contract; its types live in
 * command.ts and codex.md, and comparing them here would be inventing a type
 * system the spec does not have. `CodexUpsert[]` is the one shape in this column
 * that is not expanded at all — see the `CodexUpsertOp` gap, which has its own
 * build row rather than being folded in here.
 */
function specParamKeys(cell: string): string[] | undefined {
  // **Backticks first, and this is load-bearing.** Every Params cell in §9 is a
  // code span, so a parser that forgot to strip them sees no literal, returns
  // `undefined` for *every* row, and reports an all-exempt, perfectly clean
  // table. That is not hypothetical — it is what this file's own first draft
  // did, and the exempt-count assertion below is the control that caught it.
  const trimmed = cell.replace(/`/g, '').replace(/\*\*/g, '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;

  // Split on commas at nesting depth 0, so `patch: {status?, label?}` stays one
  // part and contributes the key `patch` rather than four nested ones.
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of trimmed.slice(1, -1)) {
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return parts.map((part) =>
    part
      .trim()
      // `entries: CodexUpsert[]` → `entries`; the annotation after the colon is
      // the type, which this guard does not compare.
      .split(':')[0]!.trim()
      .replace(/\?$/, '')
      .replace(/\[\]$/, ''),
  );
}

/**
 * One valid value per §9 param key — **test data, not a second key list.**
 *
 * The keys come from the spec and the payload is built from them, so a key §9
 * gains with no sample value fails at the coverage assertion below rather than as
 * a confusing parity diff. A key that is absent from a command's own row is
 * simply never looked up.
 *
 * This is the default every row shares. A key that means something else in another
 * row, or that only one row names, has its own value in `ROW_SAMPLE` below, and the
 * row's value wins: `kind` is a node kind for `binder.create` and a `status`|`label`
 * for `vocabulary.*`; `id` is a new node for `storyboard.create` and a term for
 * `vocabulary.upsert`; `nodeId` must be a shot for `shot.setMeta`.
 */
const PARAM_SAMPLE: Record<string, unknown> = {
  parentId: MANUSCRIPT,
  newParentId: CHAPTER_TWO,
  nodeId: THE_LANDING,
  docId: THE_LANDING,
  entryId: CODEX_ENTRY,
  index: 0,
  offset: 0,
  type: 'document',
  // With `type: 'document'` above, a screenplay is the kind that pairs (binder.create takes it; storyboard.md §2.1).
  kind: 'screenplay',
  title: 'A New Scene',
  synopsis: 'A synopsis.',
  notes: 'Some notes.',
  text: 'Some text.',
  divider: true,
  body: 'A new body.',
  expectedRevision: REVISION,
  range: { from: 0, to: 0 },
  patch: { status: 'draft', label: 'act-1', keywords_add: ['sea'], keywords_remove: ['grief'], style: 'section' },
  entries: [{ action: 'create', name: 'Someone New' }],
  attachTo: [CHAPTER_ONE],
  detachFrom: [],
  includeRootIds: [MANUSCRIPT],
  format: 'md',
  recipeName: 'novel',
  templateId: 'manuscript',
  // A saved recipe's name (`recipe.save`, `recipe.delete`) and its options (`recipe.save`).
  name: 'novel',
  options: { titlePage: true, toc: true, author: 'Ada Writer' },
};

/**
 * Ids that no default fixture holds. `BOARD_ID` is a storyboard folder and `SHOT_ID` a shot in it (`STORYBOARD_STATE`
 * below); the `NEW_*` ids are the ones a create makes.
 */
const BOARD_ID = 'n_8D6XJ4CR2M';
const SHOT_ID = 'n_2B9PQ5FK7N';
const NEW_BOARD_ID = 'n_6T3ZKW8A5R';
const NEW_SHOT_ID = 'n_4M7GHT3VZ9';
/** A coherence finding and a run, and a saved filter and a goal, for the rows whose validate reads them. */
const FINDING_ID = 'f_3RWK8NQ2TD';
const RUN_ID = 'r_9WQ3KD7M2X';
const FILTER_ID = 'q_7K2QX9M4A1';
const GOAL_ID = 'g_7K2QX9M4A1';
/** A dialogue container, for `dialogue.setMeta`, whose validate refuses any other node. */
const DIALOGUE_ID = 'n_7J4VQ9XK2D';

/**
 * A row's own values, merged over `PARAM_SAMPLE`. Every key here is one §9 declares for that row, and the inverse
 * tripwire below asserts it. `view.setSelection` has no entry: §9 says "various" for it, and its one key is supplied
 * where the refusal test needs it.
 */
const ROW_SAMPLE: Partial<Record<CommandName, Record<string, unknown>>> = {
  // The chapter rule: a new document goes inside a chapter, so the create's parent is one.
  'binder.create': { parentId: CHAPTER_ONE },
  'view.setExpanded': { nodeId: CHAPTER_ONE, expanded: true },
  'view.setCorkboardScope': { nodeId: CHAPTER_ONE },
  'coherence.setSceneMeta': {
    patch: { pov: CODEX_ENTRY, dayOffset: 2, durationDays: 1, expectedPresent_add: [CODEX_ENTRY], timelineMode: 'flashback' },
  },
  'coherence.setFindingStatus': {
    findingId: FINDING_ID,
    status: 'dismissed',
    reason: 'intentional',
    note: 'Deliberate in the flashback.',
  },
  'coherence.discardRun': { runId: RUN_ID },
  'mcp.invoke': {
    serverKey: 'research-tools',
    toolName: 'search_archive',
    args: { query: 'lighthouse' },
    expectedPins: ['c3f9a1e07b'],
  },
  'storyboard.create': {
    id: NEW_BOARD_ID,
    parentId: CHAPTER_ONE,
    title: 'The Landing — Shots',
    scene: { id: THE_LANDING, parentId: CHAPTER_ONE, revision: REVISION },
  },
  'shot.create': { id: NEW_SHOT_ID, parentId: BOARD_ID, title: 'Shot 2', stored: { shotSize: 'MS', durationSec: 4 } },
  'shot.setMeta': {
    nodeId: SHOT_ID,
    stored: { shotSize: 'CU', durationSec: 3 },
    expect: { shotSize: 'MS', durationSec: 4 },
  },
  'project.rename': { title: 'The Lighthouse Keeper, Revised' },
  'project.setMetadata': {
    patch: { author: 'Ada Writer', language: 'en-GB', isbn: '978-3-16-148410-0', coverAssetId: 'a_7K2QX9M4A1' },
  },
  'project.importAsset': { stagingId: 'stg_ABCDEF0123', target: 'cover' },
  'vocabulary.upsert': { kind: 'status', id: 'draft', name: 'Draft', color: '#3fa66a' },
  'vocabulary.remove': { kind: 'status', id: 'final' },
  'binder.saveFilter': {
    filter: { name: 'Sea Scenes', root: 'manuscript', criteria: { keywordsAny: ['sea'], statusId: 'draft' } },
  },
  'binder.deleteFilter': { filterId: FILTER_ID },
  'project.saveGoal': { goal: { nodeId: MANUSCRIPT, comparator: 'at-least', target: 50000, deadline: '2026-12-31' } },
  'project.deleteGoal': { goalId: GOAL_ID },
  // The four newest rows of §9. Each carries only the keys its own row declares (the inverse tripwire below).
  'shot.importImage': { nodeId: SHOT_ID, stagingId: 'stg_ABCDEF0123' },
  'screenplay.import': { format: 'fountain' },
  'dialogue.importInk': { containers: [{ title: 'The Harbour', body: 'Mara: The boats are in.' }] },
  'dialogue.setMeta': { nodeId: DIALOGUE_ID, patch: { engineTarget: 'ink-json', autoLineIds: true, locBaseline: 'en-GB' } },
};

/**
 * The project state a row's validate reads and the default fixture lacks, each built with `makeSnapshot`. Rows that need
 * the same state share one snapshot. A row with no entry validates against `makeSnapshot()`, as every other row does.
 */
const COHERENCE_STATE = makeSnapshot({
  coherence: { findings: [{ id: FINDING_ID, status: 'open' }], sceneMeta: {}, runs: [{ id: RUN_ID }] },
});
const STORYBOARD_STATE = makeSnapshot({
  extraNodes: [
    { id: BOARD_ID, parentId: CHAPTER_ONE, type: 'folder', kind: 'storyboard', title: 'The Landing — Shots' },
    { id: SHOT_ID, parentId: BOARD_ID, type: 'shot', title: 'Shot 1' },
  ],
});
const RECIPE_STATE = makeSnapshot({ recipes: [{ name: 'novel', includeRootIds: [MANUSCRIPT] }] });
const DIALOGUE_STATE = makeSnapshot({
  extraNodes: [{ id: DIALOGUE_ID, parentId: CHAPTER_ONE, type: 'dialogue', title: 'The Harbour' }],
});
const ROW_STATE: Partial<Record<CommandName, ValidationSnapshot>> = {
  'coherence.setSceneMeta': COHERENCE_STATE,
  'coherence.setFindingStatus': COHERENCE_STATE,
  'coherence.discardRun': COHERENCE_STATE,
  'shot.create': STORYBOARD_STATE,
  'shot.setMeta': STORYBOARD_STATE,
  'dialogue.setMeta': DIALOGUE_STATE,
  'recipe.delete': RECIPE_STATE,
  // Both export names check a recipe name the project holds, and the sample names the recipe this state holds.
  'export.compile': RECIPE_STATE,
  'export.compileSelection': RECIPE_STATE,
};

/** A row's sample: the shared default, with the row's own values over it. */
function rowSample(name: CommandName): Record<string, unknown> {
  return { ...PARAM_SAMPLE, ...(ROW_SAMPLE[name] ?? {}) };
}

/** The snapshot a row validates against: its own state when it names one, the default otherwise. */
function snapshotFor(name: CommandName): ValidationSnapshot {
  return ROW_STATE[name] ?? makeSnapshot();
}

describe('§9 the closed v0.1 registry', () => {
  const specRows = readSpecRegistry();

  it('parses all 42 command names out of §9 — so a broken parse fails, not passes', () => {
    // 42: the 38 names of the first 36 rows, and the four rows after them. The count is a
    // claim about the parse, not about the registry — if §9's table loses a row this fails, which is the whole point of asserting
    // it separately.
    expect(specRows).toHaveLength(42);
    expect(new Set(specRows.map((r) => r.name)).size).toBe(42);
  });

  it('registers exactly the names §9 tabulates, in §9 order, plus the stated exceptions', () => {
    expect(registeredNames()).toEqual([...specRows.map((r) => r.name), ...UNTABULATED_NAMES]);
    expect(Object.keys(COMMAND_REGISTRY).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it('holds the exceptions to exactly the names §9 does not tabulate, which is none', () => {
    const tabulated = new Set(specRows.map((r) => r.name));
    // The arithmetic, stated once: 42 names in COMMAND_NAMES, all of them tabulated, so the exception list is empty.
    expect(COMMAND_NAMES, '42 names: every one tabulated in §9').toHaveLength(42);
    expect(specRows.length + UNTABULATED_NAMES.length).toBe(COMMAND_NAMES.length);
    for (const name of UNTABULATED_NAMES) {
      // A stale exception is a red test, not a silent allowance: once §9 lists the
      // name, the exception has to be deleted in the same change.
      expect(tabulated.has(name), `${name} is now in §9 — remove it from the exceptions in this file`).toBe(false);
    }
    // And the registry holds no name beyond §9's table.
    const beyond = COMMAND_NAMES.filter((name) => !tabulated.has(name));
    expect([...beyond].sort()).toEqual([...UNTABULATED_NAMES].sort());
  });

  it("carries §9's own agentRisk and undo columns into every descriptor", () => {
    for (const row of specRows) {
      const entry = COMMAND_REGISTRY[row.name as keyof typeof COMMAND_REGISTRY];
      expect(entry, `no registry entry for ${row.name}`).toBeDefined();
      expect(
        entry?.descriptor.agentRisk,
        `${row.name} agentRisk`,
      ).toBe(row.agentRisk);
      expect(entry?.descriptor.undo, `${row.name} undo`).toBe(row.undo);
    }
  });

  it('marks the five view commands as ephemeral, and the other thirty-six as project state', () => {
    // §9's view rows say these commands are never persisted and carry no undo, which is `mutates: 'view'` and
    // `undo: 'none'`. The five view commands are the three original ones and the two binder/corkboard names, ephemeral
    // UI state by the same definition. `mutates: 'none'` is the v0.2 `mcp.invoke` row's (extensibility §6: externals
    // are not project state), so it is held apart. The arithmetic is asserted, not implied: 42 names are
    // 5 view + 1 mcp.invoke + 36 project mutations.
    const view = [
      'view.setSelection',
      'view.setActiveDoc',
      'view.setScroll',
      'view.setExpanded',
      'view.setCorkboardScope',
    ] as const;
    for (const name of view) {
      const entry = COMMAND_REGISTRY[name];
      expect(entry.descriptor.mutates, `${name} mutates`).toBe('view');
      expect(entry.descriptor.undo, `${name} undo`).toBe('none');
    }
    expect(COMMAND_REGISTRY['mcp.invoke'].descriptor.mutates, 'mcp.invoke mutates').toBe('none');
    expect(COMMAND_REGISTRY['mcp.invoke'].descriptor.undo, 'mcp.invoke undo').toBe('none');
    const project = COMMAND_NAMES.filter((name) => !(view as readonly string[]).includes(name) && name !== 'mcp.invoke');
    expect(project, 'the project names: 42 less five view names and mcp.invoke').toHaveLength(36);
    for (const name of project) {
      expect(COMMAND_REGISTRY[name].descriptor.mutates, `${name} mutates`).toBe('project');
    }
  });

  it('gives every command a validate, and every one is a function (not a placeholder)', () => {
    for (const name of COMMAND_NAMES) {
      const entry = COMMAND_REGISTRY[name];
      expect(typeof entry.descriptor.validate, `${name} validate`).toBe('function');
    }
  });

  it('isCommandName narrows only the closed set', () => {
    expect(isCommandName('binder.create')).toBe(true);
    expect(isCommandName('export.compile')).toBe(true);
    expect(isCommandName('export.compileSelection')).toBe(true);
    expect(isCommandName('binder.restructure')).toBe(false);
    // `mcp.invoke` is in the closed set as the v0.2 exception above, so it narrows true.
    expect(isCommandName('mcp.invoke')).toBe(true);
    expect(isCommandName('')).toBe(false);
  });
});

/**
 * The harness above read `cells[1]`, `cells[3]` and
 * `cells[4]` and left `cells[2]` — §9's **Params (essentials)** column — unread,
 * so the `CommandParams` map could drift from §9 without anything going red.
 *
 * **What "the code's accepted-key list" means here, stated exactly.** It is the
 * key set of a *successful* `validate` payload — the same observation a review used for
 * the `codex.upsert` narrowing, and the only one a `validate` can make: a
 * descriptor reads `params[key]` and returns a payload built from named fields,
 * so what a caller *passed* is not observable and what *survived* is.
 *
 * **The seam this leaves, named rather than implied.** An undeclared key that a
 * descriptor *accepts and drops* is invisible here — `binder.rename {nodeId,
 * title, order: 99}` still emits `{nodeId, title}` and stays green. That is
 * And refusing it is the decision; this guard makes
 * the key list it will trust trustworthy, which is what the row says it is for.
 *
 * **The second seam, measured — and this instrument is structurally
 * blind to it.** The payload below is *built from §9's own parse*, so the accepted
 * set and the emitted set shrink together: **a key that leaves §9 is invisible
 * here whenever the descriptor treats that key as optional.** Measured, both
 * ways, same file: dropping `title` from `binder.rename`'s cell reds this suite —
 * but on the *refusal* branch (`params.title must be a string`), because that
 * descriptor requires the key — while dropping the optional `divider` from
 * `notes.append` leaves this suite **green**, and what caught that one was
 * `PARAM_SAMPLE` below: the test's own sample values, not the comparison this
 * file exists to make. So sensitivity to spec-side rot is not a property of this
 * guard; it is inherited from whether the descriptor happens to require the key.
 * **Build the `DECLARED_PARAMS` comparison closes it from the code side**, and
 * that is why it is closed at all — it landed eight hours later, and this comment
 * is the one a reader would have trusted in between.
 *
 * **Measured before the guard existed, when §9 had eighteen names and fifteen literals: all fifteen rows already agreed.** So this
 * is not a fix for a live drift — it is the missing half of a closed set: the code conformed and nothing would have said
 * so. The mutations below are what make it more than a comment.
 */
describe("§9's Params column against the code's accepted keys", () => {
  const specRows = readSpecRegistry();
  const withKeys = specRows.filter((r) => specParamKeys(r.params) !== undefined);
  const exempt = specRows.filter((r) => specParamKeys(r.params) === undefined);

  it('parses thirty-nine key lists and three "various" rows — the parse cannot be vacuous', () => {
    // **The control, and it earns its place by having already been needed.**
    // `specParamKeys` reads `undefined` for any cell that is not a `{…}` literal.
    // §9 writes every real Params cell as a backtick code span, so a parser that
    // forgets to strip the backticks returns `undefined` for all forty-two rows,
    // the parity loop below iterates over nothing, and the suite stays green
    // while guarding nothing at all. That is precisely what the first draft of
    // this guard did during this build; the numbers here are what made it loud.
    // 42 names less the view row's three, which are exempt, leave 39 with a literal (42 - 3 = 39).
    expect(specRows).toHaveLength(42);
    expect(withKeys).toHaveLength(39);
    expect(exempt.map((r) => r.name)).toEqual(['view.setSelection', 'view.setActiveDoc', 'view.setScroll']);
    // …and the exemption is earned by the word "various", not by a hardcoded name.
    for (const row of exempt) expect(row.params).toBe('various');
  });

  it('covers every key §9 declares, and invents none', () => {
    const declared = [...new Set(withKeys.flatMap((r) => specParamKeys(r.params)!))].sort();
    // A key is sampled when the shared default names it, or a row's own sample does.
    const sampled = new Set([
      ...Object.keys(PARAM_SAMPLE),
      ...Object.values(ROW_SAMPLE).flatMap((own) => Object.keys(own ?? {})),
    ]);
    expect(
      declared.filter((key) => !sampled.has(key)),
      'a §9 key with no sample value would be silently uncompared',
    ).toEqual([]);
    // **The inverse tripwire, and it is the one that matters for rot.** A sample
    // carrying a key §9 does not declare is a hand-written key list creeping into
    // the test — the fifth copy of §9's column that review named as the trap this
    // whole obligation exists to avoid. The shared default is held to §9's column
    // as a whole; a row's own sample is held to that row's declared keys.
    expect(Object.keys(PARAM_SAMPLE).filter((key) => !declared.includes(key))).toEqual([]);
    for (const [name, own] of Object.entries(ROW_SAMPLE)) {
      const row = withKeys.find((r) => r.name === name);
      expect(row, `${name} has a row sample, so §9 must spell its Params out as a literal`).toBeDefined();
      const rowKeys = specParamKeys(row!.params)!;
      expect(
        Object.keys(own ?? {}).filter((key) => !rowKeys.includes(key)),
        `${name} carries a sample key that its own §9 row does not declare`,
      ).toEqual([]);
    }
    // And every row is sampled in full: a §9 key its payload would carry as `undefined` is a parity diff that says nothing.
    for (const row of withKeys) {
      const sample = rowSample(row.name as CommandName);
      expect(
        specParamKeys(row.params)!.filter((key) => !(key in sample)),
        `${row.name} has no sample for a key §9 declares`,
      ).toEqual([]);
    }
  });

  it('emits exactly the keys §9 declares, for every one of the thirty-nine rows', () => {
    for (const row of withKeys) {
      const name = row.name as CommandName;
      const keys = specParamKeys(row.params)!;
      const sample = rowSample(name);
      const payload: Record<string, unknown> = {};
      for (const key of keys) payload[key] = sample[key];

      const entry = COMMAND_REGISTRY[name];
      expect(entry, `no registry entry for ${row.name}`).toBeDefined();
      const result = entry!.descriptor.validate(payload, snapshotFor(name));
      // A refusal means §9 declares a key the descriptor will not accept — the
      // other direction of the same drift, and the one a key-set diff would miss.
      expect(result.ok, `${row.name} refused a payload carrying exactly §9's keys: ${result.ok ? '' : result.error.message}`).toBe(true);
      if (!result.ok) continue;

      expect(
        Object.keys(result.value as object).sort(),
        `${row.name} key set`,
      ).toEqual([...keys].sort());
    }
  });

  it("holds binder.setMeta's nested patch literal to §9's five fields", () => {
    // §9 spells this one out inline — `patch: {status?, label?, keywords_add?,
    // keywords_remove?, style?}` — and this test reads that literal and no other. The
    // top-level parser deliberately does not see nested keys. §9 now has three more
    // nested literals in the same column (`project.setMetadata`'s `patch`,
    // `binder.saveFilter`'s `filter` and `project.saveGoal`'s `goal`), and none of
    // them is compared to its code list here.
    const row = withKeys.find((r) => r.name === 'binder.setMeta')!;
    const nested = row.params.match(/patch:\s*\{([^}]*)\}/);
    expect(nested, `binder.setMeta's nested patch literal not found in §9: ${row.params}`).not.toBeNull();
    const declared = (nested![1] ?? '')
      .split(',')
      .map((p) => p.trim().replace(/\?$/, ''))
      .sort();

    // **`PATCH_KEYS` read out of the code, not typed out here.** This is the one
    // place in §9's column where the code holds a *closed* list of its own, and
    // that list is the drift vector in the direction the payload cannot show: a
    // key added to `PATCH_KEYS` is accepted at runtime but never reaches the
    // emitted patch, so an emitted-keys comparison stays green while the
    // accepted surface widens past the spec. Reading it out of the file is the
    // same discipline as reading §9 out of the file, and it is what keeps this
    // from becoming a second hand-written copy of the list it checks.
    const descriptorsSrc = readFileSync(descriptorsPath, 'utf8');
    const patchKeysDecl = descriptorsSrc.match(/const PATCH_KEYS = \[([^\]]*)\]/);
    expect(patchKeysDecl, 'PATCH_KEYS not found in descriptors.ts').not.toBeNull();
    const accepted = [...(patchKeysDecl![1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
    expect(accepted, 'the patch fields binder.setMeta accepts').toEqual(declared);

    // …and the list is genuinely enforced, so the comparison above is not
    // describing a constant nothing reads.
    const refusal = COMMAND_REGISTRY['binder.setMeta'].descriptor.validate(
      { nodeId: THE_LANDING, patch: { [`${declared[0]}_extra`]: 'x' } },
      makeSnapshot(),
    );
    expect(refusal.ok, `an undeclared patch field must be refused`).toBe(false);
    if (!refusal.ok) expect(refusal.error.message).toContain('is not a patch field');

    // …and the narrowing still holds: a full patch emits exactly those keys.
    const result = COMMAND_REGISTRY['binder.setMeta'].descriptor.validate(
      { nodeId: THE_LANDING, patch: rowSample('binder.setMeta')['patch'] },
      makeSnapshot(),
    );
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(Object.keys((result.value as { patch: object }).patch).sort()).toEqual(declared);
  });
});

/**
 * **An undeclared params key is refused, not silently
 * dropped.** The suite above proves §9's keys *reach* the payload; this one proves
 * the converse — a key §9 does not declare **cannot be sent at all**.
 *
 * ## Why the table is compared to the spec and not to the code
 *
 * `DECLARED_PARAMS` is a hand-written table, so comparing it to a hand-written
 * expectation would prove only that the table matches itself. §9 is read out of
 * the file by the same `readSpecRegistry` / `specParamKeys` pair the suite above
 * already uses, so **the authority is the document** and the table is the thing
 * held to it. That is the same discipline as the suite above, and it is why this is
 * an extension of that parser rather than a new one — a fifth copy of §9's column
 * would be one more copy to drift.
 *
 * ## What each assertion is for, because three of them can pass vacuously
 *
 * - **The exempt count.** `DECLARED_PARAMS` covers all 42 names, but §9 gives only
 *   39 a literal; the three `view.*` rows are declared here alone. If §9 ever stops
 *   saying "various", or a fourth row does, the counts disagree and it fails rather
 *   than silently widening what the spec constrains.
 * - **The per-name comparison.** Thirty-five names, compared **as sets** — §9's
 *   column is unordered prose and a diff on order would report rot that is not
 *   there.
 * - **The refusal itself, per name.** The table agreeing with §9 is a static
 *   claim; the behaviour is a separate one, and a table nothing reads would pass
 *   every comparison above.
 */
describe("§9's closed key set, and the refusal that enforces it", () => {
  const specRows = readSpecRegistry();
  const withKeys = specRows.filter((r) => specParamKeys(r.params) !== undefined);
  const exempt = specRows.filter((r) => specParamKeys(r.params) === undefined);

  it('declares a key set for all 42 names — the closed set cannot have a hole', () => {
    // 42 = every name §9 tabulates (see UNTABULATED_NAMES above, which is empty).
    expect(Object.keys(DECLARED_PARAMS).sort()).toEqual([...COMMAND_NAMES].sort());
    for (const name of COMMAND_NAMES) {
      expect(DECLARED_PARAMS[name].length, `${name} declares no keys`).toBeGreaterThan(0);
      // No duplicates: a repeated key would make the set smaller than it reads.
      expect(new Set(DECLARED_PARAMS[name]).size, `${name} repeats a key`).toBe(DECLARED_PARAMS[name].length);
    }
  });

  it('declares exactly the keys §9 declares, for the thirty-nine rows §9 spells out', () => {
    expect(withKeys).toHaveLength(39);
    for (const row of withKeys) {
      const name = row.name as CommandName;
      // §9 names `kind` on binder.create (command-bus §9 was widened with the media track), so no key is exempt here.
      expect(
        [...DECLARED_PARAMS[name]].sort(),
        `${name}: DECLARED_PARAMS against §9's Params column`,
      ).toEqual([...specParamKeys(row.params)!].sort());
    }
  });

  it('declares the three "various" rows here, and names exactly those three', () => {
    // The exemption is earned by the word in §9, not by a name list — the same
    // control the suite above uses, so a fourth "various" row fails both.
    for (const row of exempt) expect(row.params).toBe('various');
    expect([...VARIOUS_PARAM_NAMES].sort()).toEqual(exempt.map((r) => r.name).sort());
    expect(VARIOUS_PARAM_NAMES).toHaveLength(3);
    // And each of the three is genuinely declared, not left to the read-view.
    for (const name of VARIOUS_PARAM_NAMES) expect(DECLARED_PARAMS[name].length).toBeGreaterThan(0);
  });

  it('refuses an undeclared key for every one of the 42 §9 names, naming the key', () => {
    // **The behavioural half.** For each name: a payload built from §9's own
    // keys that validates, and the same payload plus one unknown key that does
    // not. A table nothing reads fails the second half only.
    for (const row of specRows) {
      const name = row.name as CommandName;
      const entry = COMMAND_REGISTRY[name];
      const declared = DECLARED_PARAMS[name];
      const sample = rowSample(name);
      const snapshot = snapshotFor(name);

      // The declared keys first: if these do not validate, the refusal below
      // would pass for the wrong reason (a payload refused for an unrelated
      // defect is still a refusal).
      const good: Record<string, unknown> = {};
      for (const key of declared) {
        // `nodeIds` is named by no §9 literal (the view row says "various"), so no row sample carries it: the one
        // value it can take is supplied here, and only here.
        good[key] = sample[key] ?? (name === 'view.setSelection' ? [THE_LANDING] : undefined);
      }
      const accepted = entry.descriptor.validate(good, snapshot);
      expect(
        accepted.ok,
        `${name} must accept a payload carrying exactly its declared keys: ${accepted.ok ? '' : accepted.error.message}`,
      ).toBe(true);

      const bad = { ...good, __undeclared__: 'x' };
      const refused = entry.descriptor.validate(bad, snapshot);
      expect(refused.ok, `${name} must refuse an undeclared key`).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code, `${name} refusal code`).toBe('invalid-params');
      expect(refused.error.message, `${name} refusal names the key`).toContain('"__undeclared__"');
      // §7: the corrective surface, not a bare code — the model needs the set.
      expect(refused.error.correctiveHint, `${name} hint lists the accepted keys`).toContain(declared[0]!);
    }
  });

  it('names the accepted keys in the hint, and the command in the message', () => {
    // The exact case this guards: `binder.rename` used to answer `ok` with
    // `{nodeId, title}` and no complaint at all.
    const refused = COMMAND_REGISTRY['binder.rename'].descriptor.validate(
      { nodeId: THE_LANDING, title: 'A New Name', order: 99 },
      makeSnapshot(),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toBe('binder.rename takes no param "order"');
    expect(refused.error.target).toBe('order');
    expect(refused.error.correctiveHint).toContain('binder.rename accepts only: nodeId, title');
  });

  it('refuses several undeclared keys at once, naming every one', () => {
    // One round trip, not one per key: a model that has to resubmit per typo is
    // the failure mode §2's per-op listing exists to prevent.
    const refused = COMMAND_REGISTRY['binder.rename'].descriptor.validate(
      { nodeId: THE_LANDING, title: 'X', order: 1, parentId: 'x' },
      makeSnapshot(),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain('"order"');
    expect(refused.error.message).toContain('"parentId"');
    expect(refused.error.message).toContain('takes no params');
  });

  it('refuses an undeclared key set to undefined — presence, not value', () => {
    // `{nodeId, title, order: undefined}` is a caller that believes it is
    // sending an ordering instruction. A declared optional key (`expectedRevision?`,
    // `divider?`) may of course be absent; an *undeclared* one may not be present
    // at all, or the emitted payload stops meaning what was submitted.
    const refused = COMMAND_REGISTRY['binder.rename'].descriptor.validate(
      { nodeId: THE_LANDING, title: 'X', order: undefined },
      makeSnapshot(),
    );
    expect(refused.ok, 'an undeclared key present as undefined must still be refused').toBe(false);
  });

  it('still accepts a declared optional key that is absent', () => {
    // The counterpart, so the rule above cannot be satisfied by refusing anything
    // shaped like an optional: `doc.write` declares `expectedRevision?`.
    const withoutRevision = COMMAND_REGISTRY['doc.write'].descriptor.validate(
      { docId: THE_LANDING, body: 'New body.' },
      makeSnapshot(),
    );
    expect(withoutRevision.ok, withoutRevision.ok ? '' : withoutRevision.error.message).toBe(true);

    const withDivider = COMMAND_REGISTRY['notes.append'].descriptor.validate(
      { nodeId: THE_LANDING, text: 'More.' },
      makeSnapshot(),
    );
    expect(withDivider.ok, withDivider.ok ? '' : withDivider.error.message).toBe(true);
  });

  it('binds the refusal to the command that owns the key, not a shared list', () => {
    // A key valid for one name and not another: `format` belongs to the two
    // export names, `nodeId` to none of them. If the check ran against a union
    // of every declared key, both of these would be accepted.
    const compile = COMMAND_REGISTRY['export.compile'].descriptor.validate(
      { format: 'md', nodeId: THE_LANDING },
      makeSnapshot(),
    );
    expect(compile.ok, 'export.compile must refuse a binder key').toBe(false);

    const rename = COMMAND_REGISTRY['binder.rename'].descriptor.validate(
      { nodeId: THE_LANDING, title: 'X', format: 'markdown' },
      makeSnapshot(),
    );
    expect(rename.ok, 'binder.rename must refuse an export key').toBe(false);
  });

  it('still refuses a non-object params — the shape check is not lost', () => {
    // The reason the two checks are one function: the combined helper must not
    // have replaced §2's own refusal.
    for (const bad of [null, undefined, 'a string', 42, ['an', 'array']]) {
      const refused = COMMAND_REGISTRY['binder.rename'].descriptor.validate(bad, makeSnapshot());
      expect(refused.ok, `params ${JSON.stringify(bad) ?? String(bad)} must be refused`).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.message).toContain('params must be an object');
    }
  });

  it('runs the key check BEFORE the field checks, so a typo is not a cascade', () => {
    // `titl` is a misspelling of a key this command does declare. The useful
    // refusal is "no param named titl"; the useless one walks the caller through
    // "params.title must be a string, got undefined" for a payload that was never
    // going to validate.
    const refused = COMMAND_REGISTRY['binder.rename'].descriptor.validate(
      { nodeId: THE_LANDING, titl: 'A New Name' },
      makeSnapshot(),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain('"titl"');
    expect(refused.error.message).not.toContain('must be a string');
  });
});

/**
 * The codex half of the same obligation, and the one that is not cosmetic.
 *
 * `codex.upsert`'s ops went through `narrowCodexOp`, which **dropped** an
 * undeclared op key on the floor. That was the most consequential silent drop in
 * the package: codex.md §2 makes `origin` harness-owned and load-bearing (hand-authored
 * outranks agent-inferred, so it decides which entry is canon), so an agent
 * passing `origin: 'agent'` was told `ok` about an entry stamped from
 * `context.issuedBy` — a success reported for a write that did not happen.
 *
 * **It is a per-op failure, not a top-level refusal**, because codex.md §7
 * validates the batch as a whole and §2 requires failures listed per-op. The test
 * asserts that, because a top-level refusal would report one bad op and hide the
 * other four from the model.
 */
describe('codex.upsert — an undeclared op key is a per-op refusal', () => {
  it('refuses `origin`, and the hint says who owns provenance', () => {
    const refused = COMMAND_REGISTRY['codex.upsert'].descriptor.validate(
      { entries: [{ action: 'create', name: 'Someone New', origin: 'agent' }] },
      makeSnapshot(),
    );
    expect(refused.ok, 'an op carrying origin must be refused').toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain('"origin"');
    expect(refused.error.message).toContain('codex.upsert entry');
    // The specific hint lives on the **per-op** failure: `batchRefusal`'s own
    // top-level hint is generic on purpose ("fix every listed op and resend the
    // whole batch"), so asserting against the top-level one would be asserting
    // the generic text and pass for the wrong reason.
    const failure = refused.error.details?.failures?.[0];
    expect(failure?.target).toBe('entries[0].origin');
    // The hint has to answer the question the caller was actually asking.
    expect(failure?.correctiveHint).toContain('harness');
  });

  it('lists every failing op, so a batch with one bad key names the good ones too', () => {
    const refused = COMMAND_REGISTRY['codex.upsert'].descriptor.validate(
      {
        entries: [
          { action: 'create', name: 'Fine', origin: 'agent' },
          { action: 'create', name: 'Also Fine' },
          { action: 'create', name: 'Bad Key', updatedAt: 'yesterday' },
        ],
      },
      makeSnapshot(),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const failures = refused.error.details?.failures ?? [];
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.target)).toEqual(['entries[0].origin', 'entries[2].updatedAt']);
  });

  it('accepts an op carrying every declared field, so the rule is not a blanket refusal', () => {
    const accepted = COMMAND_REGISTRY['codex.upsert'].descriptor.validate(
      {
        entries: [
          {
            action: 'create',
            name: 'Someone New',
            aliases: ['The New One'],
            type: 'character',
            description: 'A description.',
            includePolicy: 'detected',
            caseSensitive: false,
            exclude: ['Nothing'],
            keywords: ['sea'],
          },
        ],
      },
      makeSnapshot(),
    );
    expect(accepted.ok, accepted.ok ? '' : accepted.error.message).toBe(true);
  });

  it('keeps narrowCodexOp in place as defence in depth, not as the enforcement', () => {
    // The emitted op is still narrowed to the declared fields. If the key check
    // above were deleted, this narrowing would still hold — and the payload would
    // still be *silently* missing the field, which is the defect the key check exists to
    // remove. Asserting only the narrowing is asserting the old behaviour.
    const result = COMMAND_REGISTRY['codex.upsert'].descriptor.validate(
      { entries: [{ action: 'create', name: 'Someone New' }] },
      makeSnapshot(),
    );
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(Object.keys((result.value as { entries: object[] }).entries[0]!).sort()).toEqual(['action', 'name']);
  });
});

describe('one lookup, and the half-built state', () => {
  it('buildRegistry returns an independent table, not a shared singleton', () => {
    const first = buildRegistry();
    const second = buildRegistry();
    expect(first).not.toBe(second);
    expect(first['binder.rename']).not.toBe(second['binder.rename']);
    expect(first['binder.rename'].descriptor).toBe(COMMAND_REGISTRY['binder.rename'].descriptor);
  });

  it('lookupCommand returns the entry for every registered name', () => {
    for (const name of COMMAND_NAMES) {
      const found = lookupCommand(name);
      expect(found.ok, `${name} should be found`).toBe(true);
    }
  });

  it('lookupCommand refuses an unknown name with a refusal, not a crash', () => {
    const found = lookupCommand('binder.explode' as 'binder.create');
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe('not-found');
    expect(found.error.message).toContain('"binder.explode" is not a v0.1 command');
    // The corrective hint has to be usable: it lists the closed set.
    expect(found.error.correctiveHint).toContain('binder.create');
    expect(found.error.correctiveHint).toContain('project.deleteNode');
  });

  it('a registered name with no implementation is refused, and refuses to throw', () => {
    // docs/decisions.md acceptance criterion.
    //
    // The claim that matters is not "everything is refused" — the `view.*`
    // applies are in the bus — it is "**a name without an implementation is
    // refused**", so the set is derived from the registry rather than asserted
    // as a round number, and the control
    // below keeps the derivation from passing on an empty set.
    const withoutApply = COMMAND_NAMES.filter((name) => COMMAND_REGISTRY[name].apply === undefined);
    expect(withoutApply.length).toBeGreaterThan(0);

    for (const name of withoutApply) {
      let result: ReturnType<typeof resolveCommand> | undefined;
      expect(() => {
        result = resolveCommand(name);
      }, `${name} must not throw`).not.toThrow();
      expect(result?.ok, `${name} has no apply, so it must be refused`).toBe(false);
    }
  });

  it('the unimplemented set is exactly the thirty-seven names that are not the view family', () => {
    // The control for the test above: the five view names are the only ones the bus's own registry gives an apply, so the
    // refused set is exactly the other 37 (42 less five).
    const withApply = COMMAND_NAMES.filter((name) => COMMAND_REGISTRY[name].apply !== undefined);
    expect(withApply).toHaveLength(5);
    expect(new Set(withApply)).toEqual(new Set(VIEW_COMMAND_NAMES));
    expect(COMMAND_NAMES.length - withApply.length, '42 names less the five view applies').toBe(37);
    expect(COMMAND_REGISTRY['export.compile'].apply).toBeUndefined();
  });

  it('the refusal is model-facing: prose naming the command, a hint, and zero partial effects', () => {
    const resolved = resolveCommand('export.compile');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    const { error } = resolved;
    // §7: "never a bare code" — the message is prose, not the code repeated.
    expect(error.message).not.toBe(error.code);
    expect(error.message).toContain('export.compile');
    expect(error.message).toContain('nothing was written');
    // §4: a refusal names the corrective surface.
    expect(error.correctiveHint).toContain('do not retry export.compile');
    expect(error.correctiveHint).toContain('not available in this build');
  });

  it('export.compile is registered with a real descriptor and still no effect', () => {
    // Delegated 3: the name ships now, the effect with the exporter, and
    // omitting the row would make §9's closed set a lie.
    const found = lookupCommand('export.compile');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.descriptor.agentRisk).toBe('write-confirm');
    expect(found.value.descriptor.undo).toBe('compensable');
    expect(found.value.apply).toBeUndefined();
  });

  it('the refused path and the found path differ, so the guard is not a no-op', () => {
    // A guard that returns the same thing either way would pass every case above
    // while constraining nothing. `lookupCommand` succeeds where `resolveCommand`
    // refuses: same name, same registry, two different answers.
    const looked = lookupCommand('binder.rename');
    const resolved = resolveCommand('binder.rename');
    expect(looked.ok).toBe(true);
    expect(resolved.ok).toBe(false);
    if (looked.ok) expect(looked.value.apply).toBeUndefined();
  });
});

describe('the descriptor a command is reached through', () => {
  it('is the same object whether reached by lookup or by table index', () => {
    const found = lookupCommand('binder.setSynopsis');
    if (!found.ok) throw new Error('binder.setSynopsis must be registered');
    expect(found.value).toBe(COMMAND_REGISTRY['binder.setSynopsis']);
  });

  it('reserves exactly the three fixed roots project-format §2 names', () => {
    // project-format §2: "Reserved ids: `root`, `manuscript`, `research`
    // (fixed roots, not deletable)". The bus declares this list itself because
    // the dependency runs store → bus; the canonical copy is `packages/store`'s
    // FIXED_ROOT_IDS, and the two must not drift apart silently.
    expect(FIXED_ROOT_IDS).toEqual(['root', 'manuscript', 'research']);
    for (const id of FIXED_ROOT_IDS) expect(isFixedRootId(id), id).toBe(true);
    for (const id of [THE_LANDING, CHAPTER_ONE, 'manuscripts', '']) {
      expect(isFixedRootId(id), id).toBe(false);
    }
  });
});
