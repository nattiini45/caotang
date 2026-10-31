/**
 * The script and dialogue descriptors' own checks — screenplay.md §2.2, dialogue-narrative.md §2.1 and §4.
 *
 * Each refusal below is one rule the spec or the binder states, and each acceptance checks what the validator hands on:
 * the store applies what the bus validated, so the normalised value is the contract.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  DIALOGUE_IMPORT_CONTAINERS_MAX,
  DIALOGUE_IMPORT_TEXT_MAX,
  SCREENPLAY_IMPORT_TEXT_MAX,
  SCREENPLAY_IMPORT_SEEDS_MAX,
  type ValidationNode,
  type ValidationSnapshot,
} from '../src/index.js';

const NODE = (overrides: Partial<ValidationNode> & { id: string; type: string }): ValidationNode => ({
  parentId: null,
  title: overrides.id,
  status: null,
  label: null,
  keywords: [],
  synopsis: '',
  notes: '',
  ...overrides,
});

/**
 * A project with the two roots, a prose folder, a storyboard folder, a screenplay document, a dialogue container, and one
 * codex character the speaker check can name.
 */
const SNAPSHOT: ValidationSnapshot = {
  manifest: {
    tree: [
      NODE({ id: 'root', type: 'root' }),
      NODE({ id: 'manuscript', type: 'folder', parentId: 'root', title: 'Manuscript' }),
      NODE({ id: 'research', type: 'folder', parentId: 'root', title: 'Research' }),
      NODE({ id: 'n_CHAPTERONE0', type: 'folder', parentId: 'manuscript', title: 'Chapter 1' }),
      NODE({ id: 'n_BOARDONE000', type: 'folder', parentId: 'manuscript', title: 'Board', kind: 'storyboard' }),
      NODE({ id: 'n_SCENEONE000', type: 'document', parentId: 'n_CHAPTERONE0', title: 'The Landing', kind: 'screenplay' }),
      NODE({ id: 'n_DIALOGUE000', type: 'dialogue', parentId: 'manuscript', title: 'The Cellar', kind: 'branching' }),
    ],
    vocabulary: { statuses: [{ id: 'draft' }], labels: [{ id: 'act-1' }] },
    codex: [{ id: 'c_ALICE00001', name: 'Alice' }],
  },
  documents: new Map(),
};

const FOUNTAIN = 'INT. HOUSE - DAY\n\nAlice waves.\n';

function validateImport(params: Record<string, unknown>) {
  return COMMAND_REGISTRY['screenplay.import'].descriptor.validate(params, SNAPSHOT);
}

function validateInk(params: Record<string, unknown>) {
  return COMMAND_REGISTRY['dialogue.importInk'].descriptor.validate(params, SNAPSHOT);
}

function validateMeta(params: Record<string, unknown>) {
  return COMMAND_REGISTRY['dialogue.setMeta'].descriptor.validate(params, SNAPSHOT);
}

function codeOf(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('screenplay.import', () => {
  it('accepts a Fountain file and resolves the parent to the manuscript when none is named', () => {
    const result = validateImport({ format: 'fountain', text: FOUNTAIN });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ format: 'fountain', text: FOUNTAIN, parentId: 'manuscript' });
  });

  it('accepts an FDX file under a named folder', () => {
    const result = validateImport({ format: 'fdx', text: '<FinalDraft/>', parentId: 'n_CHAPTERONE0' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.parentId).toBe('n_CHAPTERONE0');
  });

  it('refuses a format it does not read, and names the two it does', () => {
    const result = validateImport({ format: 'pdf', text: FOUNTAIN });
    expect(codeOf(result)).toBe('invalid-params');
    if (!result.ok) expect(result.error.message).toContain('"fountain" or "fdx"');
  });

  it('refuses a blank file, because it has no scene to import', () => {
    expect(codeOf(validateImport({ format: 'fountain', text: '   \n' }))).toBe('invalid-params');
  });

  it('refuses a file over the size limit', () => {
    const text = 'a'.repeat(SCREENPLAY_IMPORT_TEXT_MAX + 1);
    expect(codeOf(validateImport({ format: 'fountain', text }))).toBe('limit-exceeded');
  });

  it('refuses a parent that does not exist, and the project root', () => {
    expect(codeOf(validateImport({ format: 'fountain', text: FOUNTAIN, parentId: 'n_NOSUCHNODE' }))).toBe('not-found');
    expect(codeOf(validateImport({ format: 'fountain', text: FOUNTAIN, parentId: 'root' }))).toBe('invalid-params');
  });

  it('refuses a document as the parent, because a document holds no children', () => {
    expect(codeOf(validateImport({ format: 'fountain', text: FOUNTAIN, parentId: 'n_SCENEONE000' }))).toBe('invalid-params');
  });

  it('refuses a storyboard as the parent, because a storyboard holds only shots', () => {
    const result = validateImport({ format: 'fountain', text: FOUNTAIN, parentId: 'n_BOARDONE000' });
    expect(codeOf(result)).toBe('invalid-params');
    if (!result.ok) expect(result.error.message).toContain('storyboard');
  });

  // Issue #265: the cast and location rows the writer ticked in the Final Draft import dialog ride on the one command.
  it('accepts codex rows, trimmed, and drops a blank description', () => {
    const result = validateImport({
      format: 'fdx',
      text: '<FinalDraft/>',
      codex: [
        { name: ' ANNA ', type: 'character', description: 'a pilot' },
        { name: 'STATION', type: 'location', description: '  ' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.codex).toEqual([
        { name: 'ANNA', type: 'character', description: 'a pilot' },
        { name: 'STATION', type: 'location' },
      ]);
    }
  });

  it('carries a row\'s include policy, and refuses one the codex does not have', () => {
    const result = validateImport({ format: 'fdx', text: '<FinalDraft/>', codex: [{ name: 'ANNA', type: 'character', includePolicy: 'manual' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.codex).toEqual([{ name: 'ANNA', type: 'character', includePolicy: 'manual' }]);
    expect(codeOf(validateImport({ format: 'fdx', text: '<FinalDraft/>', codex: [{ name: 'ANNA', type: 'character', includePolicy: 'sometimes' }] }))).toBe('invalid-params');
  });

  it('reads an empty codex list as none', () => {
    const result = validateImport({ format: 'fdx', text: '<FinalDraft/>', codex: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect('codex' in result.value).toBe(false);
  });

  it('refuses a codex row of another type, a blank name, an unknown key, a long description or too many rows', () => {
    const base = { format: 'fdx', text: '<FinalDraft/>' };
    expect(codeOf(validateImport({ ...base, codex: 'ANNA' }))).toBe('invalid-params');
    expect(codeOf(validateImport({ ...base, codex: [{ name: 'GUN', type: 'object' }] }))).toBe('invalid-params');
    expect(codeOf(validateImport({ ...base, codex: [{ name: '  ', type: 'character' }] }))).toBe('invalid-params');
    expect(codeOf(validateImport({ ...base, codex: [{ name: 'ANNA', type: 'character', aliases: ['A'] }] }))).toBe('invalid-params');
    expect(codeOf(validateImport({ ...base, codex: [{ name: 'ANNA', type: 'character', description: 'x'.repeat(2001) }] }))).toBe('invalid-params');
    const many = Array.from({ length: SCREENPLAY_IMPORT_SEEDS_MAX + 1 }, (_, i) => ({ name: `EXTRA ${i}`, type: 'character' }));
    expect(codeOf(validateImport({ ...base, codex: many }))).toBe('limit-exceeded');
  });

  it('refuses a key the command does not declare', () => {
    expect(codeOf(validateImport({ format: 'fountain', text: FOUNTAIN, title: 'x' }))).toBe('invalid-params');
  });
});

describe('dialogue.importInk', () => {
  const CONTAINERS = [
    { title: 'Greeting', body: '=== Greeting ===\nHello.\n-> END\n' },
    { title: 'Farewell', body: '=== Farewell ===\nBye.\n-> END\n' },
  ];

  it('accepts the planned containers in order, under the manuscript when no parent is named', () => {
    const result = validateInk({ containers: CONTAINERS });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.parentId).toBe('manuscript');
      expect(result.value.containers).toEqual(CONTAINERS);
    }
  });

  it('refuses an import with no containers, because there is nothing to create', () => {
    expect(codeOf(validateInk({ containers: [] }))).toBe('invalid-params');
  });

  it('refuses containers that are not a list', () => {
    expect(codeOf(validateInk({ containers: 'a story' }))).toBe('invalid-params');
  });

  it('refuses more containers than one call may create', () => {
    const many = Array.from({ length: DIALOGUE_IMPORT_CONTAINERS_MAX + 1 }, (_, i) => ({ title: `K${i}`, body: 'x' }));
    expect(codeOf(validateInk({ containers: many }))).toBe('limit-exceeded');
  });

  it('refuses a container field that is not title or body', () => {
    const result = validateInk({ containers: [{ title: 'Greeting', body: 'x', lineId: 'l_1' }] });
    expect(codeOf(result)).toBe('invalid-params');
    if (!result.ok) expect(result.error.target).toBe('containers[0].lineId');
  });

  it('refuses a container with a blank title or a blank body', () => {
    expect(codeOf(validateInk({ containers: [{ title: '  ', body: 'x' }] }))).toBe('invalid-params');
    expect(codeOf(validateInk({ containers: [{ title: 'Greeting', body: '' }] }))).toBe('invalid-params');
  });

  it('refuses Ink text over the import limit, summed over the containers', () => {
    const half = 'a'.repeat(Math.floor(DIALOGUE_IMPORT_TEXT_MAX / 2) + 1);
    expect(codeOf(validateInk({ containers: [{ title: 'A', body: half }, { title: 'B', body: half }] }))).toBe('limit-exceeded');
  });

  it('refuses a parent that is a storyboard', () => {
    expect(codeOf(validateInk({ containers: CONTAINERS, parentId: 'n_BOARDONE000' }))).toBe('invalid-params');
  });
});

describe('dialogue.setMeta', () => {
  it('accepts a patch on a dialogue container, and keeps null as a clearing instruction', () => {
    const result = validateMeta({
      nodeId: 'n_DIALOGUE000',
      patch: { speaker: 'c_ALICE00001', engineTarget: 'yarn-csv', autoLineIds: true, locBaseline: 'en-GB' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        nodeId: 'n_DIALOGUE000',
        patch: { speaker: 'c_ALICE00001', engineTarget: 'yarn-csv', autoLineIds: true, locBaseline: 'en-GB' },
      });
    }
    const cleared = validateMeta({ nodeId: 'n_DIALOGUE000', patch: { speaker: null, locBaseline: null } });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.patch).toEqual({ speaker: null, locBaseline: null });
  });

  it('refuses a node that is not a dialogue container', () => {
    const result = validateMeta({ nodeId: 'n_SCENEONE000', patch: { autoLineIds: true } });
    expect(codeOf(result)).toBe('invalid-params');
    if (!result.ok) expect(result.error.message).toContain('dialogue container');
  });

  it('refuses an empty patch and a patch key that is not a setting', () => {
    expect(codeOf(validateMeta({ nodeId: 'n_DIALOGUE000', patch: {} }))).toBe('invalid-params');
    const unknown = validateMeta({ nodeId: 'n_DIALOGUE000', patch: { status: 'draft' } });
    expect(codeOf(unknown)).toBe('invalid-params');
    if (!unknown.ok) expect(unknown.error.target).toBe('patch.status');
  });

  it('refuses a speaker that is not a codex entry', () => {
    expect(codeOf(validateMeta({ nodeId: 'n_DIALOGUE000', patch: { speaker: 'c_NOBODY0000' } }))).toBe('not-found');
  });

  it('refuses an engine target the dialogue package does not name', () => {
    expect(codeOf(validateMeta({ nodeId: 'n_DIALOGUE000', patch: { engineTarget: 'twine' } }))).toBe('invalid-params');
  });

  it('refuses a line-id flag that is not a boolean', () => {
    expect(codeOf(validateMeta({ nodeId: 'n_DIALOGUE000', patch: { autoLineIds: 'yes' } }))).toBe('invalid-params');
  });

  it('refuses a locale that is not a language code', () => {
    expect(codeOf(validateMeta({ nodeId: 'n_DIALOGUE000', patch: { locBaseline: 'english please' } }))).toBe('invalid-params');
    expect(codeOf(validateMeta({ nodeId: 'n_DIALOGUE000', patch: { locBaseline: '   ' } }))).toBe('invalid-params');
  });
});
