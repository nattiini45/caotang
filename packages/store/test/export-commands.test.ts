/**
 * The two export applies — `export.compile` and `export.compileSelection` — in the
 * store's registry.
 *
 * The store must not import the exporter (the exporter imports the store), so these
 * tests drive the applies through a **recording port** that implements the same
 * structural shape. What they pin is the store's half of the contract: what the apply
 * asks the port for, what it registers for undo, what it reports, and what it refuses
 * to do before the port is asked. The exporter's own tests (`packages/exporter`)
 * prove the port itself writes the artifact and that the undo removes it.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_REGISTRY,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type CommandName,
  type UndoStore,
} from '@caotang/bus';

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  serializeManifest,
  type ProjectState,
} from '../src/index.js';
import type {
  ExportCommandDigest,
  ExportCommandOutcome,
  ExportCommandPort,
  ExportCommandRequest,
} from '../src/commands.js';

const OPENED = new Date('2026-10-02T15:00:00.000Z');
const TICK = 1_760_000_000_000;
const clock = { now: () => TICK };

const CHAPTER = 'n_CHAPTER01';
const LANDING = 'n_LANDING01';
const BLANK = 'n_BLANK0001';

function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  state.manifest.project.id = 'p_9XK2M4Q7RZ';
  addFolder(state, { parentId: 'manuscript', title: 'Chapter One', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'The Landing', body: 'The ferry was late.', now: OPENED, id: LANDING });
  addDocument(state, { parentId: CHAPTER, title: 'Blank', body: '', now: OPENED, id: BLANK });
  // The recipe the export tests name, with the options a recipe carries (a title page and a dialogue character limit). A name the
  // project does not hold is refused at validate, so the tests that compile with a recipe need it here.
  state.manifest.recipes = [
    ...(state.manifest.recipes ?? []),
    { name: 'Beta read', includeRootIds: ['manuscript'], format: 'md', options: { titlePage: true, charLimit: 42 } },
  ];
  return state;
}

const DIGEST: ExportCommandDigest = {
  format: 'md',
  output: 'exports/The Lighthouse Keeper.md',
  chapterCount: 1,
  sceneCount: 1,
  blockCount: 4,
  wordCount: 4,
  skippedDocs: ['Chapter One → Blank'],
  tocIncluded: true,
  notes: ['skipped: Chapter One → Blank (empty)'],
};

/** A port that records what it was asked and counts how often its restore is run. */
function recordingPort(options: { digest?: ExportCommandDigest; refuse?: string } = {}) {
  const requests: ExportCommandRequest[] = [];
  let restores = 0;
  const port: ExportCommandPort = {
    compile(_state, request): ExportCommandOutcome {
      requests.push(request);
      if (options.refuse !== undefined) throw new Error(options.refuse);
      return {
        digest: options.digest ?? DIGEST,
        restoreLabel: `delete ${(options.digest ?? DIGEST).output}`,
        restore: () => {
          restores += 1;
        },
      };
    },
  };
  return { port, requests, restores: () => restores };
}

interface Harness {
  readonly state: ProjectState;
  readonly bus: BusContext<ProjectState>;
  readonly undo: UndoStore;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  run(name: CommandName, params: Record<string, unknown>): ReturnType<typeof execute>;
}

let serial = 0;

function harness(port?: ExportCommandPort): Harness {
  const state = makeState();
  const registry = createProjectCommandRegistry({
    clock,
    ...(port === undefined ? {} : { exporter: port }),
  });
  const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
    permission: { approvedPlan: true },
  };
  return {
    state,
    bus,
    undo,
    registry,
    run(name, params) {
      serial += 1;
      const command = {
        id: `cmd_EXPORT${String(serial).padStart(4, '0')}`,
        name,
        params,
        issuedBy: 'user',
        createdAt: TICK,
      } as Command;
      return execute(command, bus, registry);
    },
  };
}

describe('registration — the two names are implemented only with an exporter', () => {
  it('leaves both names descriptor-only, and refused, when no exporter is injected', () => {
    const registry = createProjectCommandRegistry({ clock });
    expect(registry['export.compile'].apply).toBeUndefined();
    expect(registry['export.compileSelection'].apply).toBeUndefined();
    const implemented = Object.values(registry).filter((entry) => entry.apply !== undefined);
    // Everything but the two export names (commands.test.ts). The three coherence applies (two mutations and the run
    // discard) are among them, since they need no exporter; project export adds six and saved filters and goals four:
    // 21 + 6 + 4 = 31. The script imports add three more (the two imports and the container settings): 31 + 3 = 34.
    // The skill commands add three more (`skill.write`, `skill.delete`, `skill.setEnabled`): 34 + 3 = 37. The three knowledge commands add three more: 37 + 3 = 40.
    // The agent's files add three more (`project.setInstructions`, `memory.write`, `memory.forget`): 40 + 3 = 43.
    // The macros add two more (`macro.save`, `macro.delete`): 43 + 2 = 45.
    // The hooks add two more (`hook.save`, `hook.delete`): 45 + 2 = 47.
    // The picture registry adds one (`asset.setMeta`; the two imports need the asset port): 47 + 1 = 48.
    expect(implemented).toHaveLength(48);
  });

  it('implements both names once an exporter is injected, and nothing else changes', () => {
    const registry = createProjectCommandRegistry({ clock, exporter: recordingPort().port });
    expect(typeof registry['export.compile'].apply).toBe('function');
    expect(typeof registry['export.compileSelection'].apply).toBe('function');
    const implemented = Object.values(registry).filter((entry) => entry.apply !== undefined);
    // The exporter adds exactly the two export applies to the forty-eight above (48 + 2).
    expect(implemented).toHaveLength(50);
    // The descriptors are the bus's own, unchanged: the store adds an apply, never a rule.
    expect(registry['export.compile'].descriptor).toBe(COMMAND_REGISTRY['export.compile'].descriptor);
  });
});

describe('export.compile — the whole manuscript', () => {
  it('asks the port for the manuscript, with the format, the recipe, the template and the clock', () => {
    const { port, requests } = recordingPort();
    const h = harness(port);
    h.run('export.compile', { format: 'docx', recipeName: 'Beta read', templateId: 'default' });

    expect(requests).toEqual([
      { selection: { kind: 'manuscript' }, format: 'docx', recipeName: 'Beta read', templateId: 'default', at: TICK },
    ]);
  });

  it('returns the port\'s digest as the outcome, not a blob or a path it made up', () => {
    const h = harness(recordingPort().port);
    const result = h.run('export.compile', { format: 'md' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toEqual(DIGEST);
  });

  it('registers a compensable undo whose restore is the port\'s, and runs it once on undo', () => {
    const { port, restores } = recordingPort();
    const h = harness(port);
    const result = h.run('export.compile', { format: 'md' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const group = h.undo.group(result.value.undoGroupId ?? '');
    expect(group?.entries).toEqual([
      expect.objectContaining({ kind: 'compensable', name: 'export.compile', label: 'delete exports/The Lighthouse Keeper.md' }),
    ]);
    expect(restores()).toBe(0);

    const undone = h.undo.undo(result.value.undoGroupId ?? '');
    expect(undone.ok && undone.value.failures).toEqual([]);
    expect(restores()).toBe(1);
    expect(h.undo.group(result.value.undoGroupId ?? '')).toBeUndefined();
  });

  it('writes a §8 row with a digest that counts what was compiled and what was skipped, and no affected node', () => {
    const h = harness(recordingPort().port);
    h.run('export.compile', { format: 'md' });
    const row = h.bus.log.entries()[0];
    expect(row?.command).toBe('export.compile');
    expect(row?.affected).toEqual([]);
    expect(row?.summary).toBe(
      'compiled 1 chapter and 1 scene (4 words) as md to exports/The Lighthouse Keeper.md; skipped 1 empty document',
    );
  });

  it('does not change the project: an export is derived output, and the project is what it was', () => {
    const h = harness(recordingPort().port);
    const before = JSON.stringify({ manifest: h.state.manifest, documents: [...h.state.documents] });
    h.run('export.compile', { format: 'md' });
    const after = JSON.stringify({ manifest: h.state.manifest, documents: [...h.state.documents] });
    expect(after).toBe(before);
  });
});

describe('export.compileSelection — a part', () => {
  it('asks the port for exactly the nodes named, in the order named', () => {
    const { port, requests } = recordingPort();
    const h = harness(port);
    h.run('export.compileSelection', { includeRootIds: [LANDING, CHAPTER], format: 'txt' });

    expect(requests).toEqual([
      { selection: { kind: 'nodes', includeRootIds: [LANDING, CHAPTER] }, format: 'txt', templateId: undefined, at: TICK },
    ]);
  });

  it('registers the same kind of compensation as the whole-manuscript compile', () => {
    const h = harness(recordingPort().port);
    const result = h.run('export.compileSelection', { includeRootIds: [CHAPTER], format: 'md' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.undo.group(result.value.undoGroupId ?? '')?.entries[0]).toMatchObject({ kind: 'compensable', name: 'export.compileSelection' });
  });
});

// A part compiles with a recipe's options, and the recipe's own selection is not read for a part (exporter.md §5).
describe('export.compileSelection with a recipe — the part, with the recipe\'s options', () => {
  it('asks the port for the nodes named and the recipe named, and never for the recipe\'s selection', () => {
    const { port, requests } = recordingPort();
    const h = harness(port);
    const result = h.run('export.compileSelection', { includeRootIds: [LANDING], format: 'md', recipeName: 'Beta read' });
    expect(result.ok).toBe(true);
    expect(requests).toEqual([
      { selection: { kind: 'nodes', includeRootIds: [LANDING] }, format: 'md', recipeName: 'Beta read', at: TICK },
    ]);
  });

  it('refuses a recipe the project does not hold as not-found, before the port is asked anything', () => {
    const { port, requests } = recordingPort();
    const h = harness(port);
    const result = h.run('export.compileSelection', { includeRootIds: [LANDING], format: 'md', recipeName: 'Ghost' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'not-found', target: 'recipeName' });
    expect(requests).toEqual([]);
  });
});

// The dialogue table's character limit is a recipe option (dialogue-narrative.md §4). It is saved, serialized and restored by undo.
describe('recipe.save — the character limit is a recipe option', () => {
  it('saves the limit, writes it to the manifest, and restores the limit a replacing save took out', () => {
    const h = harness();
    const first = h.run('recipe.save', {
      name: 'Subtitles',
      includeRootIds: ['manuscript'],
      format: 'dialogue-csv',
      options: { charLimit: 42 },
    });
    expect(first.ok).toBe(true);
    expect(h.state.manifest.recipes?.find((recipe) => recipe.name === 'Subtitles')?.options).toEqual({ charLimit: 42 });
    expect(serializeManifest(h.state.manifest)).toContain('"charLimit": 42');

    const replaced = h.run('recipe.save', { name: 'Subtitles', includeRootIds: ['manuscript'], format: 'dialogue-csv', options: { titlePage: false } });
    expect(replaced.ok).toBe(true);
    expect(h.state.manifest.recipes?.find((recipe) => recipe.name === 'Subtitles')?.options).toEqual({ titlePage: false });
    if (!replaced.ok) return;
    const undone = h.undo.undo(replaced.value.undoGroupId ?? '');
    expect(undone.ok && undone.value.failures).toEqual([]);
    expect(h.state.manifest.recipes?.find((recipe) => recipe.name === 'Subtitles')?.options).toEqual({ charLimit: 42 });
  });

  it('refuses a limit that is not a whole number in range, and the manifest keeps what it had', () => {
    const h = harness();
    const result = h.run('recipe.save', { name: 'Bad', includeRootIds: ['manuscript'], format: 'dialogue-csv', options: { charLimit: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'invalid-params', target: 'options.charLimit' });
    expect(h.state.manifest.recipes?.some((recipe) => recipe.name === 'Bad')).toBe(false);
  });
});

describe('refusals — the port is not asked, or it refuses before anything is written', () => {
  it('refuses an empty selection by validation, before the port is asked anything', () => {
    const { port, requests } = recordingPort();
    const h = harness(port);
    const result = h.run('export.compileSelection', { includeRootIds: [], format: 'md' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-params');
    expect(requests).toEqual([]);
    expect(h.bus.log.length).toBe(0);
  });

  it('turns a port that throws into an internal error, with no log row and no undo group', () => {
    const h = harness(recordingPort({ refuse: 'the exporter lost its byte binding mid-compile' }).port);
    const result = h.run('export.compile', { format: 'docx' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('the exporter lost its byte binding mid-compile');
    expect(h.bus.log.length).toBe(0);
    expect(h.undo.groups()).toHaveLength(0);
  });

  // A format this build does not compile is caller-fixable, so the bus validator refuses
  // it (packages/bus/src/descriptors.ts, `EXPORT_FORMATS`) before the apply, and the port
  // is never asked. This was an `it.fails` while the check lived only in the exporter.
  it('a format this build does not compile is invalid-params, refused before the port is asked', () => {
    const { port, requests } = recordingPort();
    const h = harness(port);
    const result = h.run('export.compile', { format: 'rtf' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(requests).toEqual([]);
    expect(result.error.code).toBe('invalid-params');
    expect(result.error.correctiveHint ?? '', 'the hint names the formats that exist').toBeTruthy();
    expect(result.error.correctiveHint ?? '').not.toContain('defect in the apply');
    expect(h.bus.log.length).toBe(0);
  });

  it('a registry with no exporter refuses both names loudly, as the bus refuses any unimplemented name', () => {
    const h = harness();
    const result = h.run('export.compile', { format: 'md' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('has no implementation in this build');
    expect(h.bus.log.length).toBe(0);
  });
});
