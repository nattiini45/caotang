/**
 * Project export: the validators of the project block, the recipes, the vocabulary and the cover import
 * (`descriptors-project.ts`). Each refusal is checked for its code and for the field it names, and each accepted value
 * for the normalized form the apply will store. A validator is pure, so the snapshot is built here and never written.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTHOR_MAX,
  CHAR_LIMIT_MAX,
  DEFAULT_RECIPE_NAME,
  PROJECT_TITLE_MAX,
  RECIPE_NAME_MAX,
  VOCABULARY_NAME_MAX,
  normalizeIsbn,
  projectCommands,
  type ValidationSnapshot,
} from '../src/index.js';
import { makeSnapshot, MANUSCRIPT } from './fixtures.js';

/** The base snapshot, with the project-export parts the validators read: the vocabulary's names, the recipes, and the project name. */
function snapshot(extra: { recipes?: { name: string; includeRootIds?: readonly string[] }[] } = {}): ValidationSnapshot {
  const base = makeSnapshot();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      vocabulary: {
        statuses: [
          { id: 'draft', name: 'Draft' },
          { id: 'final', name: 'Final' },
        ],
        labels: [{ id: 'act-1', name: 'Act 1' }],
      },
      recipes: extra.recipes ?? [{ name: 'Manuscript', includeRootIds: [MANUSCRIPT] }],
      project: { name: 'The Lighthouse Keeper' },
    },
  };
}

/** The outcome of a validator as a plain result, for the assertions below. */
type Outcome = { ok: true; value: unknown } | { ok: false; code: string; target?: string; message: string };

function check(fn: (params: unknown, snap: ValidationSnapshot) => { ok: boolean }, params: unknown, snap = snapshot()): Outcome {
  const result = fn(params, snap) as { ok: boolean; value?: unknown; error?: { code: string; target?: string; message: string } };
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, code: result.error?.code ?? '', target: result.error?.target, message: result.error?.message ?? '' };
}

describe('normalizeIsbn — the check digit and the ONIX form (epub-metadata.md)', () => {
  it('accepts an ISBN-13 with a valid check digit, with or without hyphens, as urn:isbn: and thirteen digits', () => {
    expect(normalizeIsbn('9780306406157')).toBe('urn:isbn:9780306406157');
    expect(normalizeIsbn('978-0-306-40615-7')).toBe('urn:isbn:9780306406157');
    expect(normalizeIsbn(' 978 0 306 40615 7 ')).toBe('urn:isbn:9780306406157');
  });

  it('refuses an ISBN-13 whose check digit is wrong', () => {
    expect(normalizeIsbn('978-0-306-40615-8')).toBeUndefined();
  });

  it('converts an ISBN-10 to ISBN-13, because the EPUB refines meta names the ONIX code for ISBN-13', () => {
    expect(normalizeIsbn('0-306-40615-2')).toBe('urn:isbn:9780306406157');
    // A final X is the check value ten, and the ISBN-13 check digit is recomputed for the 978 prefix.
    expect(normalizeIsbn('097522980X')).toBe('urn:isbn:9780975229804');
  });

  it('refuses text that is not an ISBN, with no placeholder value', () => {
    expect(normalizeIsbn('not an isbn')).toBeUndefined();
    expect(normalizeIsbn('12345')).toBeUndefined();
  });
});

describe('project.rename', () => {
  it('accepts a title and trims it', () => {
    const out = check(projectCommands.projectRename.validate, { title: '  The Lantern Keeper  ' });
    expect(out).toEqual({ ok: true, value: { title: 'The Lantern Keeper' } });
  });

  it('refuses a blank title, and a title longer than the limit', () => {
    expect(check(projectCommands.projectRename.validate, { title: '   ' })).toMatchObject({ ok: false, code: 'invalid-params' });
    expect(check(projectCommands.projectRename.validate, { title: 'x'.repeat(PROJECT_TITLE_MAX + 1) })).toMatchObject({ ok: false });
  });

  it('refuses a key it does not declare, naming it', () => {
    expect(check(projectCommands.projectRename.validate, { title: 'A', owner: 'me' })).toMatchObject({ ok: false, code: 'invalid-params' });
  });
});

describe('project.setMetadata', () => {
  it('normalizes the author, the language and the ISBN it is given', () => {
    const out = check(projectCommands.projectSetMetadata.validate, {
      patch: { author: '  Ada Writer ', language: 'en-GB', isbn: '0-306-40615-2' },
    });
    expect(out).toEqual({
      ok: true,
      value: { patch: { author: 'Ada Writer', language: 'en-GB', isbn: 'urn:isbn:9780306406157' } },
    });
  });

  it('turns a blank author and a blank ISBN into null, which clears the field', () => {
    const out = check(projectCommands.projectSetMetadata.validate, { patch: { author: '  ', isbn: '' } });
    expect(out).toEqual({ ok: true, value: { patch: { author: null, isbn: null } } });
  });

  it('refuses a language tag that is not BCP-47, and names the field', () => {
    const out = check(projectCommands.projectSetMetadata.validate, { patch: { language: 'english please' } });
    expect(out).toMatchObject({ ok: false, code: 'invalid-params', target: 'patch.language' });
  });

  it('refuses a language cleared to null: the language is required and always has a value', () => {
    expect(check(projectCommands.projectSetMetadata.validate, { patch: { language: null } })).toMatchObject({ ok: false });
  });

  it('refuses an ISBN with a bad check digit, naming the field', () => {
    const out = check(projectCommands.projectSetMetadata.validate, { patch: { isbn: '978-0-306-40615-8' } });
    expect(out).toMatchObject({ ok: false, target: 'patch.isbn' });
  });

  it('refuses a patch key that is not a project field, and an empty patch', () => {
    expect(check(projectCommands.projectSetMetadata.validate, { patch: { title: 'X' } })).toMatchObject({ ok: false, target: 'patch.title' });
    expect(check(projectCommands.projectSetMetadata.validate, { patch: {} })).toMatchObject({ ok: false });
  });

  it('accepts a cover by a well-formed asset id, and null to remove it, and refuses anything else', () => {
    expect(check(projectCommands.projectSetMetadata.validate, { patch: { coverAssetId: 'a_ABCDEFGHJK' } })).toEqual({
      ok: true,
      value: { patch: { coverAssetId: 'a_ABCDEFGHJK' } },
    });
    expect(check(projectCommands.projectSetMetadata.validate, { patch: { coverAssetId: null } })).toEqual({
      ok: true,
      value: { patch: { coverAssetId: null } },
    });
    expect(check(projectCommands.projectSetMetadata.validate, { patch: { coverAssetId: 'cover.png' } })).toMatchObject({ ok: false });
  });

  it('refuses an author longer than the limit', () => {
    expect(check(projectCommands.projectSetMetadata.validate, { patch: { author: 'x'.repeat(AUTHOR_MAX + 1) } })).toMatchObject({ ok: false });
  });
});

describe('project.importAsset', () => {
  it('accepts a staging id for the cover, and refuses any other target', () => {
    expect(check(projectCommands.projectImportAsset.validate, { stagingId: 'stg_ABC', target: 'cover' })).toEqual({
      ok: true,
      value: { stagingId: 'stg_ABC', target: 'cover' },
    });
    expect(check(projectCommands.projectImportAsset.validate, { stagingId: 'stg_ABC', target: 'shot' })).toMatchObject({
      ok: false,
      target: 'target',
    });
  });

  it('is never refused by the gate for a writer, and is asynchronous, so it is dispatched through executeAsync', () => {
    expect(projectCommands.projectImportAsset.asyncApply).toBe(true);
    expect(projectCommands.projectImportAsset.undo).toBe('inverse');
  });
});

describe('vocabulary.upsert', () => {
  it('creates a term with a trimmed name and a lower-case colour', () => {
    const out = check(projectCommands.vocabularyUpsert.validate, { kind: 'label', name: ' Act 2 ', color: '#D9A44A' });
    expect(out).toEqual({ ok: true, value: { kind: 'label', name: 'Act 2', color: '#d9a44a' } });
  });

  it('refuses a name another term already has, ignoring case, and names the clash', () => {
    const out = check(projectCommands.vocabularyUpsert.validate, { kind: 'label', name: 'act 1', color: '#000000' });
    expect(out).toMatchObject({ ok: false, code: 'invalid-params', target: 'name' });
  });

  it('lets a term keep its own name when it is renamed in place', () => {
    const out = check(projectCommands.vocabularyUpsert.validate, { kind: 'label', id: 'act-1', name: 'Act 1', color: '#000000' });
    expect(out).toMatchObject({ ok: true });
  });

  it('refuses an update of a term that does not exist, with not-found', () => {
    expect(check(projectCommands.vocabularyUpsert.validate, { kind: 'status', id: 'nope', name: 'X', color: '#000000' })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
  });

  it('refuses a colour that is not a six-digit hex value, and a name longer than the limit', () => {
    expect(check(projectCommands.vocabularyUpsert.validate, { kind: 'label', name: 'Blue', color: 'blue' })).toMatchObject({ ok: false, target: 'color' });
    expect(
      check(projectCommands.vocabularyUpsert.validate, { kind: 'label', name: 'x'.repeat(VOCABULARY_NAME_MAX + 1), color: '#000000' }),
    ).toMatchObject({ ok: false });
  });

  it('refuses a vocabulary that is neither status nor label', () => {
    expect(check(projectCommands.vocabularyUpsert.validate, { kind: 'tag', name: 'X', color: '#000000' })).toMatchObject({ ok: false, target: 'kind' });
  });
});

describe('vocabulary.remove', () => {
  it('accepts a term that exists', () => {
    expect(check(projectCommands.vocabularyRemove.validate, { kind: 'status', id: 'final' })).toEqual({
      ok: true,
      value: { kind: 'status', id: 'final' },
    });
  });

  it('refuses a term that does not exist, with not-found', () => {
    expect(check(projectCommands.vocabularyRemove.validate, { kind: 'label', id: 'nope' })).toMatchObject({ ok: false, code: 'not-found' });
  });
});

describe('recipe.save', () => {
  it('accepts a recipe over nodes that exist, and keeps the options it sets', () => {
    const out = check(projectCommands.recipeSave.validate, {
      name: 'Beta read',
      includeRootIds: [MANUSCRIPT],
      format: 'epub',
      options: { titlePage: false, toc: true, author: ' A. Writer ' },
    });
    expect(out).toEqual({
      ok: true,
      value: {
        name: 'Beta read',
        includeRootIds: [MANUSCRIPT],
        format: 'epub',
        options: { titlePage: false, toc: true, author: 'A. Writer' },
      },
    });
  });

  it('refuses a format this build does not compile, naming the field', () => {
    expect(check(projectCommands.recipeSave.validate, { name: 'X', includeRootIds: [MANUSCRIPT], format: 'rtf' })).toMatchObject({
      ok: false,
      target: 'format',
    });
  });

  it('refuses a selection of a node that is not in the project, with not-found', () => {
    expect(check(projectCommands.recipeSave.validate, { name: 'X', includeRootIds: ['n_NOPE000000'], format: 'md' })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
  });

  it('refuses a recipe that selects nothing, a blank name, and a name over the limit', () => {
    expect(check(projectCommands.recipeSave.validate, { name: 'X', includeRootIds: [], format: 'md' })).toMatchObject({ ok: false });
    expect(check(projectCommands.recipeSave.validate, { name: '  ', includeRootIds: [MANUSCRIPT], format: 'md' })).toMatchObject({ ok: false });
    expect(check(projectCommands.recipeSave.validate, { name: 'x'.repeat(RECIPE_NAME_MAX + 1), includeRootIds: [MANUSCRIPT], format: 'md' })).toMatchObject({
      ok: false,
    });
  });

  it('refuses an option it does not know, rather than dropping it, and a wrong option type', () => {
    expect(
      check(projectCommands.recipeSave.validate, { name: 'X', includeRootIds: [MANUSCRIPT], format: 'md', options: { cover: true } }),
    ).toMatchObject({ ok: false, target: 'options.cover' });
    expect(
      check(projectCommands.recipeSave.validate, { name: 'X', includeRootIds: [MANUSCRIPT], format: 'md', options: { toc: 'yes' } }),
    ).toMatchObject({ ok: false, target: 'options.toc' });
  });

  // dialogue-narrative.md §4: the dialogue table's character limit is a recipe option, a whole number from one to the bus's cap.
  it('keeps a character limit the dialogue table reads, and refuses one that is not a whole number in range', () => {
    const save = (charLimit: unknown) =>
      check(projectCommands.recipeSave.validate, {
        name: 'Subtitles',
        includeRootIds: [MANUSCRIPT],
        format: 'dialogue-csv',
        options: { charLimit },
      });
    expect(save(42)).toEqual({
      ok: true,
      value: { name: 'Subtitles', includeRootIds: [MANUSCRIPT], format: 'dialogue-csv', options: { charLimit: 42 } },
    });
    expect(save(CHAR_LIMIT_MAX)).toMatchObject({ ok: true });
    for (const bad of [0, -1, 1.5, CHAR_LIMIT_MAX + 1, '42', null]) {
      expect(save(bad), String(bad)).toMatchObject({ ok: false, target: 'options.charLimit' });
    }
  });

  // screenplay.md §5.3: the screenplay PDF's scene numbers (off, left, right, both) and its (MORE)/(CONT'D) switch are recipe options.
  it('keeps the screenplay PDF’s scene numbers and continuation switch, and refuses a placement it does not know', () => {
    const save = (options: Record<string, unknown>) =>
      check(projectCommands.recipeSave.validate, { name: 'Shooting script', includeRootIds: [MANUSCRIPT], format: 'pdf', options });
    for (const sceneNumbers of ['off', 'left', 'right', 'both']) {
      expect(save({ sceneNumbers, continued: false })).toEqual({
        ok: true,
        value: { name: 'Shooting script', includeRootIds: [MANUSCRIPT], format: 'pdf', options: { sceneNumbers, continued: false } },
      });
    }
    for (const bad of ['center', 'LEFT', true, 1, null]) {
      expect(save({ sceneNumbers: bad }), String(bad)).toMatchObject({ ok: false, target: 'options.sceneNumbers' });
    }
    expect(save({ continued: 'yes' })).toMatchObject({ ok: false, target: 'options.continued' });
  });
});

describe('recipe.delete', () => {
  it('accepts a recipe the project holds', () => {
    expect(check(projectCommands.recipeDelete.validate, { name: 'Manuscript' })).toEqual({ ok: true, value: { name: 'Manuscript' } });
  });

  it('refuses a recipe the project does not hold, with not-found', () => {
    expect(check(projectCommands.recipeDelete.validate, { name: 'Ghost' })).toMatchObject({ ok: false, code: 'not-found' });
  });
});

describe('recipeNameMissing (exporter.md §2, the check an export that names a recipe makes before its apply)', () => {
  it('is no refusal for a recipe the project holds', () => {
    expect(projectCommands.recipeNameMissing(snapshot(), 'Manuscript')).toBeUndefined();
  });

  it('is a not-found refusal for a recipe the project does not hold, naming the param the caller read it from', () => {
    expect(projectCommands.recipeNameMissing(snapshot(), 'Ghost')).toMatchObject({ code: 'not-found', target: 'name' });
    expect(projectCommands.recipeNameMissing(snapshot(), 'Ghost', 'recipeName')).toMatchObject({
      code: 'not-found',
      target: 'recipeName',
    });
  });

  // exporter.md §4: a project that predates recipes has no `recipes` key and holds the default. The export check must agree with the
  // list the exporter offers, or an export of the default is refused as not-found before the compile it was offered for.
  it('holds the default recipe when the manifest has no recipes array, so an export may name it, and no other name', () => {
    const base = makeSnapshot();
    const bare: ValidationSnapshot = { ...base, manifest: { ...base.manifest, recipes: undefined } };
    expect(DEFAULT_RECIPE_NAME).toBe('Manuscript');
    expect(projectCommands.recipeNameMissing(bare, DEFAULT_RECIPE_NAME)).toBeUndefined();
    expect(projectCommands.recipeNameMissing(bare, 'Ghost')).toMatchObject({ code: 'not-found', target: 'name' });
  });

  // The default a project holds without storing it can be deleted: the delete's apply stores the list first and then removes the
  // default, so the saved list is empty afterwards (store commands-project.ts). Refusing it here would leave the writer no way to
  // remove a recipe they never saved.
  it('accepts recipe.delete of the default when no recipes array is stored, because the apply stores the default before it removes it', () => {
    const base = makeSnapshot();
    const bare: ValidationSnapshot = { ...base, manifest: { ...base.manifest, recipes: undefined } };
    expect(check(projectCommands.recipeDelete.validate, { name: DEFAULT_RECIPE_NAME }, bare)).toEqual({
      ok: true,
      value: { name: DEFAULT_RECIPE_NAME },
    });
  });

  it('still deletes a stored recipe by name, and refuses a name neither stored nor the default', () => {
    expect(check(projectCommands.recipeDelete.validate, { name: 'Manuscript' })).toMatchObject({ ok: true });
    expect(check(projectCommands.recipeDelete.validate, { name: 'Ghost' })).toMatchObject({ ok: false, code: 'not-found' });
    const base = makeSnapshot();
    const bare: ValidationSnapshot = { ...base, manifest: { ...base.manifest, recipes: undefined } };
    expect(check(projectCommands.recipeDelete.validate, { name: 'Ghost' }, bare)).toMatchObject({ ok: false, code: 'not-found' });
  });
});

describe('the descriptors are the ones the registry holds', () => {
  it('names seven, each with a validator and a risk the gate reads', () => {
    const names = Object.keys(projectCommands.PROJECT_DESCRIPTORS);
    expect(names).toHaveLength(7);
    for (const name of names) {
      const descriptor = projectCommands.PROJECT_DESCRIPTORS[name as keyof typeof projectCommands.PROJECT_DESCRIPTORS];
      expect(typeof descriptor.validate, name).toBe('function');
      expect(['read', 'write-auto', 'write-confirm', 'never'], name).toContain(descriptor.agentRisk);
    }
  });
});
