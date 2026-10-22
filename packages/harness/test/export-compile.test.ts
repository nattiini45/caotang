/**
 * `export.compile` — write-confirm, dispatching the whole-manuscript command or the
 * part command the bus splits them into. The applies are not in this build, so the
 * tests run against a registry whose two export applies are recorded fakes, and one
 * test runs against the real registry to show the honest refusal.
 */

import { EXPORT_FORMATS, type ApplyContext, type CommandName } from '@caotang/bus';
import { createProjectCommandRegistry, type ProjectState } from '@caotang/store';
import { VIDEO_TEMPLATE_IDS } from '@caotang/video-prompt-pack';
import { describe, expect, it } from 'vitest';

import { createHarness } from '../src/index.js';
import { CHAPTER_ONE, LANDING, STORM, clock, makeState, refusalOf, run, snapshotOf, valueOf } from './fixtures.js';

const CONFIRMED = { confirmed: true } as const;

interface Captured {
  readonly name: CommandName;
  readonly params: Record<string, unknown>;
  readonly undoLabels: string[];
}

/** A registry whose export applies record what they were asked, and register a compensation as §5 requires. */
function recordingRegistry(captured: Captured[]) {
  const base = createProjectCommandRegistry({ clock });
  const apply = (name: CommandName) => (_state: unknown, params: Record<string, unknown>, context: ApplyContext) => {
    captured.push({ name, params, undoLabels: [] });
    context.undo.compensate(`delete the ${String(params['format'])} export`, () => {});
    context.report({ affected: [], summary: `compiled to ${String(params['format'])}` });
    return { artifact: `export.${String(params['format'])}` };
  };
  return {
    ...base,
    'export.compile': { descriptor: base['export.compile'].descriptor, apply: apply('export.compile') },
    'export.compileSelection': { descriptor: base['export.compileSelection'].descriptor, apply: apply('export.compileSelection') },
  } as typeof base;
}

describe('export.compile', () => {
  it('compiles the whole manuscript through export.compile, which takes no scope', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: makeState(), registry: recordingRegistry(captured), clock: clock.now });
    const outcome = valueOf(run(harness, 'export.compile', { selection: { root: 'manuscript' }, format: 'md' }, { permission: CONFIRMED }));
    expect(captured).toEqual([{ name: 'export.compile', params: { format: 'md' }, undoLabels: [] }]);
    expect(outcome.data['scope']).toBe('manuscript');
    // The whole manuscript is the node compiled, so the outcome names it, rather than an empty list of nodes.
    expect(outcome.data['includeRootIds']).toEqual(['manuscript']);
    expect(outcome.data['result']).toEqual({ artifact: 'export.md' });
    expect(outcome.undoGroupId).toBeDefined();
  });

  it('compiles a part through export.compileSelection, naming the chapter and every node under it', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: makeState(), registry: recordingRegistry(captured), clock: clock.now });
    const outcome = valueOf(run(harness, 'export.compile', { selection: { root: CHAPTER_ONE }, format: 'txt' }, { permission: CONFIRMED }));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.name).toBe('export.compileSelection');
    expect(captured[0]?.params['includeRootIds']).toEqual([CHAPTER_ONE, LANDING, STORM]);
    expect(outcome.data['scope']).toBe('part');
  });

  it('names only the node itself when includeSubtrees is false, for a document', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: makeState(), registry: recordingRegistry(captured), clock: clock.now });
    valueOf(run(harness, 'export.compile', { selection: { root: LANDING, includeSubtrees: false }, format: 'md' }, { permission: CONFIRMED }));
    expect(captured[0]?.params['includeRootIds']).toEqual([LANDING]);
  });

  it('passes a template through as the bus’s templateId', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: makeState(), registry: recordingRegistry(captured), clock: clock.now });
    valueOf(run(harness, 'export.compile', { selection: { root: 'manuscript' }, format: 'docx', template: 'novel-a4' }, { permission: CONFIRMED }));
    expect(captured[0]?.params).toEqual({ format: 'docx', templateId: 'novel-a4' });
  });

  it('refuses a folder compiled without its subtree, rather than exporting nothing', () => {
    const error = refusalOf(run(createHarness({ state: makeState(), clock: clock.now }), 'export.compile', { selection: { root: CHAPTER_ONE, includeSubtrees: false }, format: 'md' }, { permission: CONFIRMED }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('has no text of its own');
  });

  it('refuses the project root as a part, and names the manuscript', () => {
    const error = refusalOf(run(createHarness({ state: makeState(), clock: clock.now }), 'export.compile', { selection: { root: 'root' }, format: 'md' }, { permission: CONFIRMED }));
    expect(error.correctiveHint).toContain('manuscript');
  });

  it('refuses an unknown root, naming binder.read_tree', () => {
    const error = refusalOf(run(createHarness({ state: makeState(), clock: clock.now }), 'export.compile', { selection: { root: 'The Void' }, format: 'md' }, { permission: CONFIRMED }));
    expect(error.code).toBe('not-found');
    expect(error.correctiveHint).toContain('binder.read_tree');
  });

  it('refuses a format this build does not ship, and names the ones it does', () => {
    // `rtf` is the probe for a format nothing ships.
    const error = refusalOf(run(createHarness({ state: makeState(), clock: clock.now }), 'export.compile', { selection: { root: 'manuscript' }, format: 'rtf' }, { permission: CONFIRMED }));
    expect(error.message).toContain(`must be one of ${EXPORT_FORMATS.join(', ')}`);
  });

  it('offers the agent every format the bus lists, the media formats included, and no others', () => {
    for (const format of EXPORT_FORMATS) {
      const captured: Captured[] = [];
      const harness = createHarness({ state: makeState(), registry: recordingRegistry(captured), clock: clock.now });
      // A prompt pack is written for a vendor template, so it is offered with one (the refusal without one is below).
      const template = format === 'promptpack' ? VIDEO_TEMPLATE_IDS[0] : undefined;
      valueOf(run(harness, 'export.compile', { selection: { root: 'manuscript' }, format, ...(template === undefined ? {} : { template }) }, { permission: CONFIRMED }));
      expect(captured[0]?.params['format'], format).toBe(format);
    }
  });

  it('is refused without a plan or a confirmation, because it writes files', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(run(createHarness({ state, clock: clock.now }), 'export.compile', { selection: { root: 'manuscript' }, format: 'md' }));
    expect(error.code).toBe('permission-denied');
    expect(snapshotOf(state)).toBe(before);
  });

  it('reports the bus’s own refusal, unchanged, when the real registry has no export apply in this build', () => {
    const error = refusalOf(
      run(createHarness({ state: makeState(), clock: clock.now }), 'export.compile', { selection: { root: 'manuscript' }, format: 'md' }, { permission: CONFIRMED }),
    );
    expect(error.code).toBe('internal');
    expect(error.message).toContain('registered but has no implementation in this build');
  });
});

describe('export.compile through a saved recipe, and the prompt pack’s vendor template', () => {
  /** A project with two recipes: one that names a chapter and its scenes, and one that names the manuscript. */
  function withRecipes(): ProjectState {
    const state = makeState();
    state.manifest.recipes = [
      { name: 'Chapter one', includeRootIds: [CHAPTER_ONE, LANDING, STORM], format: 'docx', templateId: 'novel-a4', options: { titlePage: false } },
      { name: 'Beta read', includeRootIds: ['manuscript'], format: 'md', options: { toc: true } },
    ];
    return state;
  }

  it('compiles through a recipe with no selection, and the recipe names the manuscript', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: withRecipes(), registry: recordingRegistry(captured), clock: clock.now });
    const outcome = valueOf(run(harness, 'export.compile', { format: 'md', recipeName: 'Beta read' }, { permission: CONFIRMED }));
    expect(captured).toEqual([{ name: 'export.compile', params: { format: 'md', recipeName: 'Beta read' }, undoLabels: [] }]);
    expect(outcome.data['scope']).toBe('manuscript');
    expect(outcome.data['recipe']).toBe('Beta read');
    // The recipe names the manuscript, so the outcome lists the manuscript the recipe compiled, not an empty selection.
    expect(outcome.data['includeRootIds']).toEqual(['manuscript']);
  });

  it('compiles through a recipe with no selection that names a part, and reports the part it names', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: withRecipes(), registry: recordingRegistry(captured), clock: clock.now });
    const outcome = valueOf(run(harness, 'export.compile', { format: 'docx', recipeName: 'Chapter one' }, { permission: CONFIRMED }));
    expect(captured[0]).toEqual({ name: 'export.compile', params: { format: 'docx', recipeName: 'Chapter one' }, undoLabels: [] });
    expect(outcome.data['scope']).toBe('part');
    expect(outcome.data['includeRootIds']).toEqual([CHAPTER_ONE, LANDING, STORM]);
  });

  it('compiles a part with a recipe through the part command, which takes the recipe for its options only', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: withRecipes(), registry: recordingRegistry(captured), clock: clock.now });
    valueOf(run(harness, 'export.compile', { selection: { root: CHAPTER_ONE }, format: 'txt', recipeName: 'Beta read' }, { permission: CONFIRMED }));
    expect(captured).toEqual([
      { name: 'export.compileSelection', params: { includeRootIds: [CHAPTER_ONE, LANDING, STORM], format: 'txt', recipeName: 'Beta read' }, undoLabels: [] },
    ]);
  });

  it('refuses a manuscript selection with a recipe that names a part, and says how to go on', () => {
    const error = refusalOf(
      run(createHarness({ state: withRecipes(), clock: clock.now }), 'export.compile', { selection: { root: 'manuscript' }, format: 'md', recipeName: 'Chapter one' }, { permission: CONFIRMED }),
    );
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('names a part of the book');
    expect(error.correctiveHint).toContain('leave selection out');
  });

  it('refuses a recipe name the project does not hold, and names the ones it holds', () => {
    const error = refusalOf(run(createHarness({ state: withRecipes(), clock: clock.now }), 'export.compile', { format: 'md', recipeName: 'Paperback' }, { permission: CONFIRMED }));
    expect(error.code).toBe('not-found');
    expect(error.correctiveHint).toContain('"Beta read"');
  });

  it('refuses a call that names neither a selection nor a recipe, because it would compile nothing', () => {
    const error = refusalOf(run(createHarness({ state: makeState(), clock: clock.now }), 'export.compile', { format: 'md' }, { permission: CONFIRMED }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('name a selection or a saved recipe');
  });

  it('accepts the default recipe by name in a project that stores no recipes', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: makeState(), registry: recordingRegistry(captured), clock: clock.now });
    valueOf(run(harness, 'export.compile', { format: 'md', recipeName: 'Manuscript' }, { permission: CONFIRMED }));
    expect(captured[0]?.params).toEqual({ format: 'md', recipeName: 'Manuscript' });
  });

  it('refuses a prompt pack that names no vendor template, at preflight, so nothing is applied and its card is not approved', () => {
    const captured: Captured[] = [];
    const harness = createHarness({ state: makeState(), registry: recordingRegistry(captured), clock: clock.now });
    const error = refusalOf(run(harness, 'export.compile', { selection: { root: 'manuscript' }, format: 'promptpack' }, { permission: CONFIRMED }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('vendor template');
    expect(error.correctiveHint).toContain(VIDEO_TEMPLATE_IDS[0] ?? '');
    expect(captured).toEqual([]);
  });

  it('refuses a prompt pack that names a template which is not installed, and lists the installed ones', () => {
    const error = refusalOf(
      run(createHarness({ state: makeState(), clock: clock.now }), 'export.compile', { selection: { root: 'manuscript' }, format: 'promptpack', template: 'no-such-vendor' }, { permission: CONFIRMED }),
    );
    expect(error.message).toContain('"no-such-vendor" is not an installed vendor template');
    expect(error.correctiveHint).toContain(VIDEO_TEMPLATE_IDS.join(', '));
  });

  it('sends a prompt pack’s vendor template on the command, for the whole manuscript and for a part', () => {
    const vendor = VIDEO_TEMPLATE_IDS[1] ?? VIDEO_TEMPLATE_IDS[0] ?? '';
    const captured: Captured[] = [];
    const harness = createHarness({ state: makeState(), registry: recordingRegistry(captured), clock: clock.now });
    valueOf(run(harness, 'export.compile', { selection: { root: 'manuscript' }, format: 'promptpack', template: vendor }, { permission: CONFIRMED }));
    valueOf(run(harness, 'export.compile', { selection: { root: CHAPTER_ONE }, format: 'promptpack', template: vendor }, { permission: CONFIRMED }));
    expect(captured.map((call) => [call.name, call.params['templateId']])).toEqual([
      ['export.compile', vendor],
      ['export.compileSelection', vendor],
    ]);
  });

  it('takes a prompt pack’s vendor template from the recipe when the call names none', () => {
    const state = makeState();
    state.manifest.recipes = [{ name: 'Pack', includeRootIds: ['manuscript'], format: 'promptpack', templateId: VIDEO_TEMPLATE_IDS[0] }];
    const captured: Captured[] = [];
    const harness = createHarness({ state, registry: recordingRegistry(captured), clock: clock.now });
    valueOf(run(harness, 'export.compile', { format: 'promptpack', recipeName: 'Pack' }, { permission: CONFIRMED }));
    expect(captured[0]?.params).toEqual({ format: 'promptpack', recipeName: 'Pack' });
  });
});
