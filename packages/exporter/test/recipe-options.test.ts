/**
 * A recipe's options reach a compile through the bus, for the whole manuscript and for a part. The dialogue table's character
 * limit reaches its `charLimit` column (dialogue-narrative.md §4), and a part compiles with the recipe's options but not with the
 * recipe's selection (exporter.md §5). The bus is the path a user's click takes, so the checks read what the folder holds.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  DEFAULT_RECIPE_NAME,
  execute,
  type BusContext,
  type Command,
  type CommandError,
  type ExecutionOutcome,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import {
  createProjectCommandRegistry,
  MemoryArtifactFs,
  type ExportRecipe,
  type ProjectState,
} from '@caotang/store';
import { COLOUR_EMOJI_FORMATS, COLOUR_EMOJI_HINT, COLOUR_EMOJI_LABEL, colourEmojiDefault, createExporter, recipesOf, type ExporterService } from '../src/index.js';
import { COMPILED_AT, IDS, makeProject, PROJECT_NAME } from './fixture.js';
import { ASSETS, makeMediaProject } from './media-fixture.js';

type Dispatch = Result<ExecutionOutcome, CommandError>;

interface Rig {
  readonly state: ProjectState;
  readonly fs: MemoryArtifactFs;
  readonly exporter: ExporterService;
  readonly undo: UndoStore;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => Dispatch;
}

let serial = 0;

/** A bus over one project: the exporter, the store's registry and the undo store, as the desktop wires them. */
function rig(state: ProjectState): Rig {
  const fs = new MemoryArtifactFs();
  const clock = { now: () => COMPILED_AT };
  const exporter = createExporter({
    readState: () => state,
    artifacts: fs,
    clock,
    metadata: () => ({ author: 'Ada Lovelace' }),
    assets: () => ASSETS,
  });
  const registry = createProjectCommandRegistry({ clock, exporter: exporter.commandPort() });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  const run = (name: Command['name'], params: Record<string, unknown>): Dispatch => {
    serial += 1;
    const command = {
      id: `cmd_RECIPE${String(serial).padStart(6, '0')}`,
      name,
      params,
      issuedBy: 'user',
      createdAt: COMPILED_AT,
    } as Command;
    return execute(command, bus, registry);
  };
  return { state, fs, exporter, undo, run };
}

function okValue(outcome: Dispatch): ExecutionOutcome {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

/** A recipe as the manifest holds it: the exporter reads recipes from the state, and `recipe.save` is what writes them. */
function holdRecipe(state: ProjectState, recipe: ExportRecipe): void {
  const kept = (state.manifest.recipes ?? []).filter((held) => held.name !== recipe.name);
  state.manifest.recipes = [...kept, recipe];
}

// A project that predates recipes has no `recipes` key and holds the default (exporter.md §4). The exporter offers that
// default and the bus checks an export's recipe name against the same list, and both take the name from the bus's one constant.
describe('the default recipe a project that predates recipes holds (exporter.md §4)', () => {
  it('is the one recipe the exporter lists when none is stored, under the bus’s name for it', () => {
    const state = makeProject();
    delete state.manifest.recipes;
    expect(recipesOf(state).map((recipe) => recipe.name)).toEqual([DEFAULT_RECIPE_NAME]);
  });

  it('compiles by its name, which the bus accepts before the apply, and refuses a name the project does not hold', async () => {
    const state = makeProject();
    delete state.manifest.recipes;
    const r = rig(state);
    await r.exporter.ready();

    const outcome = okValue(r.run('export.compile', { format: 'md', recipeName: DEFAULT_RECIPE_NAME }));
    await r.exporter.idle();
    const output = (outcome.result as { output: string }).output;
    expect((r.fs.snapshot()[output] ?? '').trim().length, 'the default recipe wrote a manuscript').toBeGreaterThan(0);

    const refused = r.run('export.compile', { format: 'md', recipeName: 'Ghost' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ code: 'not-found', target: 'recipeName' });
  });

  it('is stored by a recipe save exactly as the exporter offered it before the save, template and all', () => {
    const state = makeProject();
    delete state.manifest.recipes;
    const offered = recipesOf(state).find((recipe) => recipe.name === DEFAULT_RECIPE_NAME);
    expect(offered?.templateId).toBe('default');

    okValue(rig(state).run('recipe.save', { name: 'Beta', includeRootIds: ['manuscript'], format: 'md' }));
    // Read through a function, since TypeScript narrows `recipes` to absent after the delete above.
    const stored = (): readonly ExportRecipe[] => state.manifest.recipes ?? [];
    expect(stored().find((recipe) => recipe.name === DEFAULT_RECIPE_NAME)).toEqual(offered);
  });

  it('a part compiles under the default too, because the part names the recipe whose options it takes', async () => {
    const state = makeProject();
    delete state.manifest.recipes;
    const r = rig(state);
    await r.exporter.ready();

    const outcome = okValue(
      r.run('export.compileSelection', { includeRootIds: [IDS.timetable], format: 'md', recipeName: DEFAULT_RECIPE_NAME }),
    );
    await r.exporter.idle();
    const output = (outcome.result as { output: string }).output;
    expect((r.fs.snapshot()[output] ?? '').trim().length, 'the part wrote its text').toBeGreaterThan(0);
  });
});

describe('a dialogue table under a recipe — the character limit reaches the charLimit column', () => {
  it('writes the recipe\'s limit into the charLimit column of every line, before the locale', async () => {
    const state = makeMediaProject();
    const r = rig(state);
    await r.exporter.ready();
    holdRecipe(state, { name: 'Subtitles', includeRootIds: ['manuscript'], format: 'dialogue-csv', options: { charLimit: 42 } });

    const outcome = okValue(r.run('export.compile', { format: 'dialogue-csv', recipeName: 'Subtitles' }));
    await r.exporter.idle();

    const output = (outcome.result as { output: string }).output;
    const lines = (r.fs.snapshot()[output] ?? '').trim().split('\r\n');
    expect(lines[0]).toBe('lineId,speaker,text,context,charLimit,locale');
    const rows = lines.slice(1);
    // The innkeeper's container holds its five keyed lines and choice labels, so there is a row to check.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.endsWith(',42,en'), row).toBe(true);
  });

  it('leaves the column empty when the recipe sets no limit, which is no limit', async () => {
    const state = makeMediaProject();
    const r = rig(state);
    await r.exporter.ready();
    holdRecipe(state, { name: 'Open', includeRootIds: ['manuscript'], format: 'dialogue-csv', options: {} });

    const outcome = okValue(r.run('export.compile', { format: 'dialogue-csv', recipeName: 'Open' }));
    await r.exporter.idle();

    const output = (outcome.result as { output: string }).output;
    const rows = (r.fs.snapshot()[output] ?? '').trim().split('\r\n').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.endsWith(',,en'), row).toBe(true);
  });
});

describe('a part under a recipe — the recipe\'s options apply, and its selection does not', () => {
  it('compiles the part with the recipe\'s title page, and only the part\'s nodes', async () => {
    const state = makeProject();
    const r = rig(state);
    await r.exporter.ready();
    // The recipe selects the whole manuscript, which holds four scenes; the part is one timetable.
    holdRecipe(state, { name: 'Beta read', includeRootIds: ['manuscript'], format: 'md', options: { titlePage: true, toc: false } });

    const outcome = okValue(r.run('export.compileSelection', { includeRootIds: [IDS.timetable], format: 'md', recipeName: 'Beta read' }));
    await r.exporter.idle();

    const digest = outcome.result as { output: string; sceneCount: number };
    expect(digest.sceneCount, 'the part holds one scene, not the four the recipe selects').toBe(1);
    const text = r.fs.snapshot()[digest.output] ?? '';
    expect(text, 'the recipe\'s title page is on the part').toContain(PROJECT_NAME);
    expect(text).toContain('Ferry at nine.');
  });

  it('names the part for what it holds, not for the recipe it compiled with', async () => {
    const state = makeProject();
    const r = rig(state);
    await r.exporter.ready();
    holdRecipe(state, { name: 'Beta read', includeRootIds: ['manuscript'], format: 'md', options: {} });

    const outcome = okValue(r.run('export.compileSelection', { includeRootIds: [IDS.timetable], format: 'md', recipeName: 'Beta read' }));
    await r.exporter.idle();

    expect((outcome.result as { output: string }).output).toBe('exports/Ferry timetable.md');
  });

  it('keeps the recipe off the file when a whole-manuscript compile does not name it, as before', async () => {
    const state = makeProject();
    const r = rig(state);
    await r.exporter.ready();
    holdRecipe(state, { name: 'Beta read', includeRootIds: ['manuscript'], format: 'md', options: {} });

    const outcome = okValue(r.run('export.compile', { format: 'md' }));
    await r.exporter.idle();

    // The whole manuscript without a recipe is named by the book's title, which is what a compile without a recipe always was.
    expect((outcome.result as { output: string }).output).toBe(`exports/${PROJECT_NAME}.md`);
  });
});

describe('paper frames — the contact sheet’s option, read by no other format (storyboard.md §6)', () => {
  /** What one format writes under a recipe carrying `options`, as text. */
  async function written(format: string, options: Record<string, unknown>): Promise<string> {
    const state = makeMediaProject();
    const r = rig(state);
    await r.exporter.ready();
    okValue(r.run('recipe.save', { name: 'Switch', includeRootIds: ['manuscript'], format, options }));
    const outcome = okValue(r.run('export.compile', { format, recipeName: 'Switch' }));
    await r.exporter.idle();
    return r.fs.snapshot()[(outcome.result as { output: string }).output] ?? '';
  }

  it('leaves every other format’s output the same with it on or off', async () => {
    for (const format of ['md', 'txt', 'fountain', 'ink-json', 'dialogue-csv', 'shot-list-csv', 'coherence-md'] as const) {
      const off = await written(format, {});
      expect(off.length, format).toBeGreaterThan(0);
      expect(await written(format, { paperFrames: true }), format).toBe(off);
    }
  });

  it('is saved by recipe.save, survives a read of the recipe, and is refused when it is not a boolean', () => {
    const r = rig(makeMediaProject());
    okValue(r.run('recipe.save', { name: 'Paper', includeRootIds: ['manuscript'], format: 'contact-sheet-pdf', options: { paperFrames: true } }));
    expect(recipesOf(r.state).find((recipe) => recipe.name === 'Paper')?.options).toEqual({ paperFrames: true });

    const refused = r.run('recipe.save', { name: 'Odd', includeRootIds: ['manuscript'], format: 'contact-sheet-pdf', options: { paperFrames: 'yes' } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('params.options.paperFrames must be true or false');
  });
});

// screenplay.md §5.3, storyboard.md §6: Colour emoji, the option both PDFs have.
describe('colourEmoji', () => {
  it('is saved by recipe.save with an explicit false kept, survives a read of the recipe, and is refused when it is not a boolean', () => {
    const r = rig(makeMediaProject());
    okValue(r.run('recipe.save', { name: 'Colour', includeRootIds: ['manuscript'], format: 'contact-sheet-pdf', options: { colourEmoji: false } }));
    expect(recipesOf(r.state).find((recipe) => recipe.name === 'Colour')?.options).toEqual({ colourEmoji: false });
    okValue(r.run('recipe.save', { name: 'Script', includeRootIds: ['manuscript'], format: 'pdf', options: { colourEmoji: true } }));
    expect(recipesOf(r.state).find((recipe) => recipe.name === 'Script')?.options).toEqual({ colourEmoji: true });

    const refused = r.run('recipe.save', { name: 'Odd', includeRootIds: ['manuscript'], format: 'pdf', options: { colourEmoji: 'yes' } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('params.options.colourEmoji must be true or false');
  });

  it('is on by default for the contact sheet only, and its words say what the default is for', () => {
    expect(colourEmojiDefault('contact-sheet-pdf')).toBe(true);
    expect(colourEmojiDefault('pdf')).toBe(false);
    expect(COLOUR_EMOJI_FORMATS).toEqual(['pdf', 'contact-sheet-pdf']);
    // The words are pinned: the Export dialog shows them, and the guide quotes them.
    expect(COLOUR_EMOJI_LABEL).toBe('Colour emoji: print emoji in colour, with their skin tones');
    expect(COLOUR_EMOJI_HINT.pdf).toBe(
      'Scripts are usually printed in black and white, so this is off unless you turn it on. Without colour a skin tone prints as the plain figure; colour is how to get skin tones.',
    );
    expect(COLOUR_EMOJI_HINT['contact-sheet-pdf']).toBe(
      'On by default, because a contact sheet is a picture to look at. Turn it off for black and white, where a skin tone prints as the plain figure; colour is how to get skin tones.',
    );
  });

  it('leaves every other format’s output the same with it on or off', async () => {
    for (const format of ['md', 'txt', 'fountain', 'ink-json', 'dialogue-csv', 'shot-list-csv', 'coherence-md'] as const) {
      const state = makeMediaProject();
      const r = rig(state);
      await r.exporter.ready();
      okValue(r.run('recipe.save', { name: 'On', includeRootIds: ['manuscript'], format, options: { colourEmoji: true } }));
      okValue(r.run('recipe.save', { name: 'Off', includeRootIds: ['manuscript'], format, options: {} }));
      const compiled = async (recipeName: string): Promise<string> => {
        const outcome = okValue(r.run('export.compile', { format, recipeName }));
        await r.exporter.idle();
        return r.fs.snapshot()[(outcome.result as { output: string }).output] ?? '';
      };
      const off = await compiled('Off');
      expect(off.length, format).toBeGreaterThan(0);
      expect(await compiled('On'), format).toBe(off);
    }
  });
});
