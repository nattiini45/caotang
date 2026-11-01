/**
 * The §9 validators.
 *
 * Every refusal asserted here is a refusal some spec *names*: §9's Notes column,
 * project-format §2's field limits, agent-harness §3's tool contracts, codex.md
 * §2/§7. The limit boundaries are tested on **both** sides (2000 accepted /
 * 2001 refused), because a limit tested only from the refusing side passes
 * whether the comparison is `>` or `>=` — it does not prove where the edge is.
 *
 * §2's load-bearing invariant is that `validate` is **pure and total**, and
 * purity is asserted at the bottom of this file against a real snapshot.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  DEFAULT_RECIPE_NAME,
  EXPORT_FORMATS,
  KEYWORDS_MAX,
  KEYWORD_CHARS_MAX,
  SYNOPSIS_MAX,
  type CommandError,
  type CommandName,
  type Result,
  type ValidationSnapshot,
} from '../src/index.js';
import {
  BODY,
  CHAPTER_ONE,
  CHAPTER_TWO,
  CODEX_ENTRY,
  MANUSCRIPT,
  REVISION,
  RESEARCH,
  ROOT,
  THE_LANDING,
  UNKNOWN_ID,
  makeSnapshot,
  nodeWithKeywords,
} from './fixtures.js';

const snapshot = makeSnapshot();

function validate(
  name: CommandName,
  params: unknown,
  against: ValidationSnapshot = snapshot,
): Result<never, CommandError> {
  return COMMAND_REGISTRY[name].descriptor.validate(params, against) as Result<never, CommandError>;
}

function refusal(result: Result<never, CommandError>): CommandError {
  if (result.ok) throw new Error('expected a refusal, got an acceptance');
  return result.error;
}

/** The position a validated `binder.move` carries — the helper's type is the refusal half. */
function indexOf(result: Result<never, CommandError>): number {
  if (!result.ok) throw new Error(`expected an acceptance, got a refusal: ${result.error.message}`);
  return (result.value as { readonly index: number }).index;
}

const repeat = (char: string, n: number): string => char.repeat(n);

describe('binder.create', () => {
  it('accepts a document under a folder and normalizes the resolved parent', () => {
    const r = validate('binder.create', { parentId: CHAPTER_ONE, type: 'document', title: 'The Storm' });
    expect(r.ok).toBe(true);
  });

  it('refuses a type outside the five node types the binder creates', () => {
    const e = refusal(validate('binder.create', { parentId: CHAPTER_ONE, type: 'script', title: 'X' }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('type must be "folder", "document", "shot", "dialogue" or "comic-page"');
    expect(e.target).toBe('type');
  });

  it('refuses the project root as the parent, because the binder would never show the node', () => {
    // gap root-parent-invisible-nodes: the root passed `isContainer`, so a document under it was created and then
    // vanished from the binder's rows. The refusal names the two places a node can go.
    const e = refusal(validate('binder.create', { parentId: ROOT, type: 'document', title: 'Lost' }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('project root');
    expect(e.correctiveHint).toContain('"manuscript" or "research"');
    expect(e.target).toBe('parentId');
  });

  it('takes a screenplay document and a storyboard folder, and refuses a kind that does not go with its type', () => {
    expect(validate('binder.create', { parentId: CHAPTER_ONE, type: 'document', title: 'Scene', kind: 'screenplay' }).ok).toBe(true);
    expect(validate('binder.create', { parentId: CHAPTER_ONE, type: 'folder', title: 'Board', kind: 'storyboard' }).ok).toBe(true);
    const e = refusal(validate('binder.create', { parentId: CHAPTER_ONE, type: 'folder', title: 'Board', kind: 'screenplay' }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('does not go with type "folder"');
    expect(e.target).toBe('kind');
  });

  it('gives a dialogue container its branching kind when none is named, and returns the normalized params', () => {
    expect(validate('binder.create', { parentId: CHAPTER_ONE, type: 'dialogue', title: 'Duel' })).toMatchObject({
      ok: true,
      value: { parentId: CHAPTER_ONE, type: 'dialogue', title: 'Duel', kind: 'branching' },
    });
  });

  it('takes a shot only inside a storyboard folder, and refuses one anywhere else', () => {
    const board = {
      id: 'n_BOARD00001',
      parentId: CHAPTER_ONE,
      type: 'folder',
      kind: 'storyboard',
      title: 'Board',
    };
    const withBoard = makeSnapshot({ tree: [...snapshot.manifest.tree, board as never] });
    expect(validate('binder.create', { parentId: 'n_BOARD00001', type: 'shot', title: 'Shot 1' }, withBoard).ok).toBe(true);
    const e = refusal(validate('binder.create', { parentId: CHAPTER_ONE, type: 'shot', title: 'Shot 1' }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('must sit in a storyboard folder');
    expect(e.target).toBe('parentId');
  });

  it('refuses a kind on a shot, because a shot is already its own kind', () => {
    const e = refusal(validate('binder.create', { parentId: CHAPTER_ONE, type: 'shot', title: 'S', kind: 'storyboard' }));
    expect(e.message).toContain('kind "storyboard" does not go with type "shot"');
    expect(e.correctiveHint).toContain('a shot takes no kind');
    expect(e.target).toBe('kind');
  });

  it('refuses an unknown parent with §7\'s own corrective hint', () => {
    const e = refusal(validate('binder.create', { parentId: UNKNOWN_ID, type: 'folder', title: 'X' }));
    expect(e.code).toBe('not-found');
    expect(e.correctiveHint).toBe('use binder.read_tree to list valid ids');
    expect(e.target).toBe(UNKNOWN_ID);
  });

  it('refuses a document as the parent — only the root and folders hold children', () => {
    const e = refusal(validate('binder.create', { parentId: THE_LANDING, type: 'folder', title: 'X' }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('cannot hold children');
  });

  it('refuses a blank title and a non-object params', () => {
    expect(refusal(validate('binder.create', { parentId: CHAPTER_ONE, type: 'folder', title: '   ' })).message)
      .toContain('must not be blank');
    expect(refusal(validate('binder.create', 'nope')).message).toContain('params must be an object');
  });
});

describe('binder.move — §9: "Cycle check + manuscript-root invariant in validate"', () => {
  it('accepts a move between siblings', () => {
    expect(validate('binder.move', { nodeId: CHAPTER_TWO, newParentId: CHAPTER_ONE, index: 0 }).ok).toBe(true);
  });

  it('refuses a move into the node itself, as a cycle', () => {
    const e = refusal(validate('binder.move', { nodeId: CHAPTER_ONE, newParentId: CHAPTER_ONE, index: 0 }));
    expect(e.code).toBe('cycle');
    expect(e.message).toContain('which is itself or a descendant of it');
  });

  it('refuses a move into a descendant of the node, as a cycle', () => {
    const nested = makeSnapshot({
      tree: [
        ...snapshot.manifest.tree,
        { id: 'n_SUBFOLDER001', parentId: CHAPTER_ONE, type: 'folder', title: 'Sub', status: null, label: null, keywords: [], synopsis: '', notes: '' },
      ],
    });
    const e = refusal(validate('binder.move', { nodeId: CHAPTER_ONE, newParentId: 'n_SUBFOLDER001', index: 0 }, nested));
    expect(e.code).toBe('cycle');
  });

  it('refuses to move a fixed root — the manuscript-root invariant', () => {
    for (const id of [ROOT, MANUSCRIPT, RESEARCH]) {
      const e = refusal(validate('binder.move', { nodeId: id, newParentId: CHAPTER_ONE, index: 0 }));
      expect(e.code, id).toBe('invalid-params');
      expect(e.message, id).toContain('fixed root and cannot be moved');
      expect(e.message, id).toContain('manuscript stays root');
      expect(e.correctiveHint, id).toContain('reserved');
    }
  });

  it('refuses the project root as the new parent, for the same reason binder.create does', () => {
    const e = refusal(validate('binder.move', { nodeId: CHAPTER_ONE, newParentId: ROOT, index: 0 }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('project root');
    expect(e.target).toBe('newParentId');
  });

  it('refuses a document as the new parent, and a negative index', () => {
    expect(refusal(validate('binder.move', { nodeId: CHAPTER_ONE, newParentId: THE_LANDING, index: 0 })).message)
      .toContain('cannot hold children');
    expect(refusal(validate('binder.move', { nodeId: CHAPTER_ONE, newParentId: MANUSCRIPT, index: -1 })).message)
      .toContain('must be ≥ 0');
  });

  // The index counts the siblings of the new parent *without* the moved node, the
  // count the store's `siblingOrderAt` takes. A position past the last sibling is
  // not refused — the store appends there — so the bus resolves the position
  // against the same count and hands the apply the position the node lands at.
  it('resolves an index past the last sibling to the position the node lands at', () => {
    // Chapter one holds one child, so the positions among its children are 0 and 1.
    expect(indexOf(validate('binder.move', { nodeId: CHAPTER_TWO, newParentId: CHAPTER_ONE, index: 9 }))).toBe(1);
  });

  it('keeps an index that names a position, and accepts the append the binder sends', () => {
    expect(indexOf(validate('binder.move', { nodeId: CHAPTER_TWO, newParentId: CHAPTER_ONE, index: 0 }))).toBe(0);
    expect(indexOf(validate('binder.move', { nodeId: CHAPTER_TWO, newParentId: CHAPTER_ONE, index: 1 }))).toBe(1);
  });

  it('counts the moved node out of the siblings it is placed among', () => {
    // The Landing is the only child of chapter one, so the only position among
    // its siblings is 0: the count is the siblings without the moved node.
    expect(indexOf(validate('binder.move', { nodeId: THE_LANDING, newParentId: CHAPTER_ONE, index: 4 }))).toBe(0);
  });
});

describe('the placement rule for shots and storyboards (storyboard.md §2.1)', () => {
  const BOARD = 'n_BOARD00001';
  const SHOT = 'n_SHOT0000001';
  const node = (fields: Record<string, unknown>): never => ({ status: null, label: null, keywords: [], synopsis: '', notes: '', ...fields }) as never;
  // A storyboard under chapter one with one shot in it: the two ends of every placement this block checks.
  const withBoard = makeSnapshot({
    tree: [
      ...snapshot.manifest.tree,
      node({ id: BOARD, parentId: CHAPTER_ONE, type: 'folder', kind: 'storyboard', title: 'Board' }),
      node({ id: SHOT, parentId: BOARD, type: 'shot', title: 'Shot 1' }),
    ],
  });

  it('refuses a shot moved into a plain folder, because a shot lives in a storyboard only', () => {
    const e = refusal(validate('binder.move', { nodeId: SHOT, newParentId: CHAPTER_ONE, index: 0 }, withBoard));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('must sit in a storyboard folder');
    expect(e.target).toBe('newParentId');
  });

  it('refuses a scene moved into a storyboard, because a storyboard holds only shots', () => {
    const e = refusal(validate('binder.move', { nodeId: THE_LANDING, newParentId: BOARD, index: 0 }, withBoard));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('a storyboard holds only shots');
    expect(e.target).toBe('newParentId');
  });

  it('refuses a folder moved into a storyboard, as the same rule for any node that is not a shot', () => {
    expect(refusal(validate('binder.move', { nodeId: CHAPTER_TWO, newParentId: BOARD, index: 0 }, withBoard)).message).toContain(
      'a storyboard holds only shots',
    );
  });

  it('accepts a shot moved within its board, which is the reorder the card buttons send', () => {
    expect(validate('binder.move', { nodeId: SHOT, newParentId: BOARD, index: 0 }, withBoard).ok).toBe(true);
  });

  it('refuses a scene, a folder or a dialogue made inside a storyboard, and accepts a shot there', () => {
    const under = (type: string, kind?: string) => ({ parentId: BOARD, type, title: 'X', ...(kind === undefined ? {} : { kind }) });
    expect(refusal(validate('binder.create', under('document', 'screenplay'), withBoard)).message).toContain('a storyboard holds only shots');
    expect(refusal(validate('binder.create', under('folder'), withBoard)).message).toContain('a storyboard holds only shots');
    expect(refusal(validate('binder.create', under('dialogue'), withBoard)).message).toContain('a storyboard holds only shots');
    expect(validate('binder.create', under('shot'), withBoard).ok).toBe(true);
  });
});

describe('binder.rename', () => {
  it('accepts a rename and refuses a blank title or an unknown node', () => {
    expect(validate('binder.rename', { nodeId: THE_LANDING, title: 'The Landing (revised)' }).ok).toBe(true);
    expect(refusal(validate('binder.rename', { nodeId: THE_LANDING, title: '' })).message).toContain('must not be blank');
    expect(refusal(validate('binder.rename', { nodeId: UNKNOWN_ID, title: 'X' })).code).toBe('not-found');
  });

  it('refuses to rename the manuscript and research section roots, and renames their children', () => {
    // gap fixed-section-roots-renamable-on-bus: ui-modules §2.3 forbids it, and the binder shows the two names.
    for (const id of [MANUSCRIPT, RESEARCH]) {
      const e = refusal(validate('binder.rename', { nodeId: id, title: 'Book' }));
      expect(e.code, id).toBe('invalid-params');
      expect(e.message, id).toContain('section root and cannot be renamed');
      expect(e.target, id).toBe('nodeId');
    }
    expect(validate('binder.rename', { nodeId: CHAPTER_ONE, title: 'Part One' }).ok).toBe(true);
  });

  it('leaves the project root\'s title alone: the section refusal reaches manuscript and research only', () => {
    // ui-modules §2.3 names the manuscript and research roots, and the root is the project, not a section. Refusing
    // its rename would be a rule the spec does not state, so this pins that the new refusal does not widen to it.
    expect(validate('binder.rename', { nodeId: ROOT, title: 'Book One' }).ok).toBe(true);
  });
});

describe('binder.setMeta — §9: "Vocabulary-validated"', () => {
  it('accepts a status and a label from the vocabulary', () => {
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { status: 'revised' } }).ok).toBe(true);
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { label: 'act-2' } }).ok).toBe(true);
  });

  it('accepts a scene style on a document, null to clear it, and refuses an unknown one with the valid styles', () => {
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { style: 'section' } }).ok).toBe(true);
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { style: 'normal' } }).ok).toBe(true);
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { style: null } }).ok).toBe(true);
    const e = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { style: 'verse' } }));
    expect(e.code).toBe('invalid-params');
    expect(e.correctiveHint).toContain('normal, section');
  });

  it('refuses a scene style on a folder, which is not exported as a scene', () => {
    const e = refusal(validate('binder.setMeta', { nodeId: CHAPTER_ONE, patch: { style: 'section' } }));
    expect(e.message).toContain('only a document has a scene style');
  });

  it('refuses an unknown status and lists the valid ids in the hint', () => {
    // agent-harness §3 row 5: "Invalid status/label → lists vocabulary".
    const e = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { status: 'polished' } }));
    expect(e.code).toBe('invalid-params');
    expect(e.correctiveHint).toContain('draft, revised, final');
  });

  it('refuses an unknown label, listing the valid ones', () => {
    const e = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { label: 'act-9' } }));
    expect(e.message).toContain('is not a label');
    expect(e.correctiveHint).toContain('act-1, act-2');
  });

  it('refuses a patch that is not an object, and a patch field that is not one', () => {
    expect(refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: 'draft' })).message)
      .toContain('params.patch must be an object');
    const typo = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keyword_add: ['x'] } }));
    expect(typo.message).toContain('params.patch.keyword_add is not a patch field');
    expect(typo.correctiveHint).toContain('keywords_add');
  });

  it('refuses an empty patch — it names no field, and the two sibling patch commands refuse one too', () => {
    // `dialogue.setMeta` and `project.setMetadata` both refuse a patch that
    // carries no field. The refusal is the shape's: a patch with a field that
    // matches what the node holds is the documented idempotent path below, and
    // the store stamps nothing for a dispatch that writes no value.
    const e = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: {} }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('names no field');
    expect(e.correctiveHint).toContain('status');
    expect(e.target).toBe('patch');
    expect(e.details?.changesNothing).toBe(true);
  });

  it('refuses a keyword over 64 chars, and a node that would exceed 32', () => {
    // project-format §2: "Max 32 per node, each ≤ 64 chars".
    const long = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_add: [repeat('a', 65)] } }));
    expect(long.code).toBe('limit-exceeded');
    const full = makeSnapshot({ tree: [nodeWithKeywords(Array.from({ length: 32 }, (_, i) => `k${i}`))] });
    const over = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_add: ['one-more'] } }, full));
    expect(over.code).toBe('limit-exceeded');
    expect(over.message).toContain('would hold 33 keywords');
  });

  it('keeps idempotence: removing an absent keyword is accepted, adding a present one does not duplicate', () => {
    // agent-harness §3 makes meta.set "idempotent by design", and params.ts keeps
    // `keywords_add: []` a legitimate "nothing to do" payload: a patch whose
    // fields all match what the node holds is accepted, and the store's apply
    // stamps nothing and reports "left ... unchanged" for it.
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_remove: ['not-there'] } }).ok).toBe(true);
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_add: ['SEA'] } }).ok).toBe(true);
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_add: [] } }).ok).toBe(true);
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { status: 'draft' } }).ok).toBe(true);
  });

  // The case-insensitive dedupe is what makes the 32-keyword
  // cap mean *"32 distinct tags"* rather than *"32 strings"*, and the cap is the only
  // place the rule is observable: at two keywords the count is the same either way.
  // This was unpinned — `resultingKeywords` made case-sensitive leaves **all 500
  // tests green**, and the pair above cannot see it, because it asserts `.ok` on a
  // node nowhere near the limit. Its subject is the *rule*, not the limit: both
  // sides are asserted here so the edge is tested from acceptance and refusal,
  // which is what a comparison-only rule needs.
  it('counts a case-variant of a present keyword as present, at the 32 limit', () => {
    const full = makeSnapshot({ tree: [nodeWithKeywords(Array.from({ length: 32 }, (_, i) => `k${i}`))] });

    // Accepted: 'K0' is the keyword `k0`, so the node still holds 32. A rule that
    // compared the strings exactly would count 33 and refuse a legitimate command.
    const sameTag = validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_add: ['K0'] } }, full);
    expect(sameTag.ok, sameTag.ok ? '' : refusal(sameTag).message).toBe(true);

    // Refused, from the same node: a genuinely new tag really is the 33rd.
    const newTag = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_add: ['new'] } }, full));
    expect(newTag.code).toBe('limit-exceeded');
    expect(newTag.message).toContain('would hold 33 keywords');
  });

  it('frees the slot when a removal names a case-variant of a present keyword', () => {
    // The other half of the same rule, and it needed its own test: making
    // `resultingKeywords`' *removal* case-sensitive also leaves all 500 green,
    // because the add side was doing the work in the first test. Both halves are
    // one rule in the code and two in the suite, which is how one of them goes
    // unpinned while the other looks covered.
    const full = makeSnapshot({ tree: [nodeWithKeywords(Array.from({ length: 32 }, (_, i) => `k${i}`))] });

    // 'K0' is `k0`, so removing it and adding a new tag is a swap at 32 — accepted.
    const swap = validate('binder.setMeta', {
      nodeId: THE_LANDING,
      patch: { keywords_remove: ['K0'], keywords_add: ['new'] },
    }, full);
    expect(swap.ok, swap.ok ? '' : refusal(swap).message).toBe(true);

    // Refused, from the same node: removing a tag that is not there frees nothing,
    // so the addition really is the 33rd.
    const noSwap = refusal(validate('binder.setMeta', {
      nodeId: THE_LANDING,
      patch: { keywords_remove: ['absent'], keywords_add: ['new'] },
    }, full));
    expect(noSwap.code).toBe('limit-exceeded');
    expect(noSwap.message).toContain('would hold 33 keywords');
  });

  // Project-format §2 types the node fields as "vocabulary id **or null**",
  // and §5 asks this command for the *exact* inverse — so `null` has to be a
  // value the patch can carry, or the first status a node is ever given has an
  // inverse the command family cannot express.
  it('accepts null as a clear, and normalizes it through as null rather than dropping it', () => {
    const cleared = COMMAND_REGISTRY['binder.setMeta'].descriptor.validate(
      { nodeId: THE_LANDING, patch: { status: null } },
      snapshot,
    );
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('expected an acceptance');
    // A validator that accepted the clear and returned `{ patch: {} }` would pass
    // an acceptance-only test and make the clear unreachable at apply time.
    expect(cleared.value.patch.status).toBeNull();
    expect(Object.keys(cleared.value.patch)).toEqual(['status']);
    expect(COMMAND_REGISTRY['binder.setMeta'].descriptor.validate(
      { nodeId: THE_LANDING, patch: { label: null } },
      snapshot,
    ).ok).toBe(true);
  });

  it('still refuses a non-string, non-null status — null widened the value, not the type', () => {
    const e = refusal(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { status: 42 } }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('must be a string');
  });

  it('keeps absence distinct from a clear: an untouched field is absent, not null', () => {
    const labelOnly = COMMAND_REGISTRY['binder.setMeta'].descriptor.validate(
      { nodeId: THE_LANDING, patch: { label: 'act-2' } },
      snapshot,
    );
    if (!labelOnly.ok) throw new Error('expected an acceptance');
    // If absence normalized to null, every inverse patch would clear the fields it
    // never touched, and one undo would wipe a sibling's status.
    expect(Object.keys(labelOnly.value.patch)).toEqual(['label']);
    expect('status' in labelOnly.value.patch).toBe(false);
  });
});

describe('binder.setSynopsis, notes.set, notes.append — the format and tool limits', () => {
  it('holds the synopsis edge at exactly 2000 characters', () => {
    expect(validate('binder.setSynopsis', { nodeId: THE_LANDING, synopsis: repeat('s', 2000) }).ok).toBe(true);
    const e = refusal(validate('binder.setSynopsis', { nodeId: THE_LANDING, synopsis: repeat('s', 2001) }));
    expect(e.code).toBe('limit-exceeded');
    expect(e.message).toContain('is 2001 characters, limit 2000');
  });

  it('holds the notes edge at exactly 50 000 characters', () => {
    expect(validate('notes.set', { nodeId: THE_LANDING, notes: repeat('n', 50_000) }).ok).toBe(true);
    expect(refusal(validate('notes.set', { nodeId: THE_LANDING, notes: repeat('n', 50_001) })).code)
      .toBe('limit-exceeded');
  });

  it('holds the notes.append edge at 2k and points at notes.replace on overflow', () => {
    // agent-harness §3 row 6: "note overflow → suggests notes.replace (confirm-class)".
    expect(validate('notes.append', { nodeId: THE_LANDING, text: repeat('t', 2000) }).ok).toBe(true);
    const e = refusal(validate('notes.append', { nodeId: THE_LANDING, text: repeat('t', 2001) }));
    expect(e.code).toBe('limit-exceeded');
    expect(e.correctiveHint).toBe('use notes.replace (write-confirm) for content over 2k characters');
  });

  it('accepts the divider flag and refuses a non-boolean one', () => {
    expect(validate('notes.append', { nodeId: THE_LANDING, text: 'x', divider: false }).ok).toBe(true);
    expect(refusal(validate('notes.append', { nodeId: THE_LANDING, text: 'x', divider: 'yes' })).message)
      .toContain('must be a boolean');
  });
});

describe('doc.write and the editor primitives', () => {
  it('accepts a full-body write to a document and refuses a folder', () => {
    expect(validate('doc.write', { docId: THE_LANDING, body: 'new text' }).ok).toBe(true);
    const e = refusal(validate('doc.write', { docId: CHAPTER_ONE, body: 'new text' }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain('is a folder, not a document');
    expect(e.correctiveHint).toContain('binder.create');
  });

  it('accepts a body write to a dialogue container, because its Ink body is written the same way', () => {
    // The Ink editor saves through session.autosave, which is doc.write.
    const dialogue = { id: 'n_DIALOGUE01', parentId: CHAPTER_ONE, type: 'dialogue', kind: 'branching', title: 'Duel' };
    const withDialogue = makeSnapshot({
      tree: [...snapshot.manifest.tree, dialogue as never],
      bodies: { n_DIALOGUE01: '=== start ===\nHello.\n-> END\n' },
    });
    expect(validate('doc.write', { docId: 'n_DIALOGUE01', body: '=== start ===\nHi.\n-> END\n' }, withDialogue).ok).toBe(true);
  });

  it('does NOT compare expectedRevision here — §6 landed in the pipeline, and this pins that boundary', () => {
    // The comparison is in `pipeline.ts`, between the §4 gate and `apply` — so
    // this assertion is a *standing* claim about where the rule does NOT live. A `validate` that started comparing would
    // give §6 two implementations of "which commands guard a revision", and this
    // is the test that would say so.
    expect(validate('doc.write', { docId: THE_LANDING, body: 'x', expectedRevision: 999 }).ok).toBe(true);
    expect(refusal(validate('doc.write', { docId: THE_LANDING, body: 'x', expectedRevision: 1.5 })).message)
      .toContain('must be an integer');
  });

  it('bounds an insert offset by the loaded body, on both edges', () => {
    expect(validate('editor.insert', { docId: THE_LANDING, offset: 0, text: 'A' }).ok).toBe(true);
    expect(validate('editor.insert', { docId: THE_LANDING, offset: BODY.length, text: 'A' }).ok).toBe(true);
    const e = refusal(validate('editor.insert', { docId: THE_LANDING, offset: BODY.length + 1, text: 'A' }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain(`must be ≤ ${BODY.length}`);
  });

  it('refuses an insert whose document has no loaded body, rather than guessing the bound', () => {
    const unloaded = makeSnapshot({ bodies: {} });
    const e = refusal(validate('editor.insert', { docId: THE_LANDING, offset: 0, text: 'A' }, unloaded));
    expect(e.code).toBe('not-found');
    expect(e.message).toContain('no body loaded');
    // The id already resolved in requireDocumentNode, so "list valid ids" would
    // send the caller in circles: the hint names the file, the surface that fixes it.
    expect(e.correctiveHint).toContain('file');
    expect(e.correctiveHint).not.toContain('binder.read_tree to list');
  });

  it('refuses a write to a document whose body is not loaded, as the editor commands do', () => {
    // A document file that is not UTF-8 opens with no body record while its node
    // stays in the tree: the write would reach the apply and fail there as an
    // internal defect instead of as the refusal the loader had already promised.
    const unloaded = makeSnapshot({ bodies: {} });
    const e = refusal(validate('doc.write', { docId: THE_LANDING, body: 'new text' }, unloaded));
    expect(e.code).toBe('not-found');
    expect(e.message).toContain('no body loaded');
    expect(e.correctiveHint).toContain('file');
    expect(e.correctiveHint).not.toContain('binder.read_tree to list');
  });

  it('reports the param defect of a malformed write even when the document has no loaded body', () => {
    // The loaded-body refusal is a state refusal; a body of the wrong type is a
    // defect in the params the caller must fix. The param check runs first, so a
    // write that is both malformed and to an unloaded document is not reduced to
    // the state half alone.
    const unloaded = makeSnapshot({ bodies: {} });
    const e = refusal(validate('doc.write', { docId: THE_LANDING, body: 42 }, unloaded));
    expect(e.code).toBe('invalid-params');
    expect(e.target).toBe('body');
  });

  it('requires a forward range inside the body', () => {
    expect(validate('editor.replaceRange', { docId: THE_LANDING, range: { from: 0, to: 5 }, text: 'x' }).ok).toBe(true);
    const backwards = refusal(validate('editor.replaceRange', { docId: THE_LANDING, range: { from: 6, to: 2 }, text: 'x' }));
    expect(backwards.message).toContain('is past params.range.to');
    const past = refusal(validate('editor.replaceRange', { docId: THE_LANDING, range: { from: 0, to: BODY.length + 1 }, text: 'x' }));
    expect(past.code).toBe('invalid-params');
    expect(refusal(validate('editor.replaceRange', { docId: THE_LANDING, range: 5, text: 'x' })).message)
      .toContain('params.range must be an object');
  });
});

describe('codex.upsert — codex.md §7, validated as a whole before execution', () => {
  const create = (fields: Record<string, unknown> = {}) => [
    { action: 'create', name: 'Kestrel', type: 'character', description: 'The lighthouse keeper.', ...fields },
  ];

  it('accepts a well-formed create', () => {
    expect(validate('codex.upsert', { entries: create() }).ok).toBe(true);
  });

  it('refuses a batch over 20 ops', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ action: 'create', name: `Entry ${i}` }));
    const e = refusal(validate('codex.upsert', { entries: many }));
    expect(e.code).toBe('limit-exceeded');
    expect(e.message).toContain('21 ops, limit 20');
  });

  it('refuses an update whose id does not resolve, naming codex.read', () => {
    // codex.md §7: "unknown id → 'use codex.read with query'".
    const e = refusal(validate('codex.upsert', { entries: [{ action: 'update', id: 'c_NOPE' }] }));
    const failure = e.details?.failures?.[0];
    expect(e.code).toBe('invalid-params');
    expect(failure?.code).toBe('not-found');
    expect(failure?.correctiveHint).toBe('use codex.read with a query to find the entry');
    expect(failure?.target).toBe('entries[0]');
  });

  it('lists EVERY failing op, not just the first — §2: "list failures per-op"', () => {
    const e = refusal(
      validate('codex.upsert', {
        entries: [
          { action: 'create', name: 'Fine', type: 'character' },
          { action: 'create', name: 'Bad', type: 'not-a-type' },
          { action: 'update', id: 'c_MISSING' },
          { action: 'create', name: 'Also fine', type: 'object' },
        ],
      }),
    );
    const failures = e.details?.failures ?? [];
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.target)).toEqual(['entries[1]', 'entries[2]']);
    expect(e.message).toContain('2 of the submitted ops failed');
    expect(e.correctiveHint).toContain('nothing was written');
  });

  it('refuses a case-insensitive name collision, inside the batch and against the project', () => {
    const withinBatch = refusal(
      validate('codex.upsert', { entries: [{ action: 'create', name: 'Kestrel' }, { action: 'create', name: 'kestrel' }] }),
    );
    expect(withinBatch.details?.failures?.[0]?.message).toContain('collides');

    // The fixture's project codex already holds "Elena".
    const againstProject = refusal(validate('codex.upsert', { entries: create({ name: 'eLeNa' }) }));
    expect(againstProject.details?.failures?.[0]?.message).toContain('collides with the existing entry "Elena"');
  });

  it('holds the codex field limits on both edges', () => {
    expect(validate('codex.upsert', { entries: create({ name: repeat('n', 120) }) }).ok).toBe(true);
    expect(refusal(validate('codex.upsert', { entries: create({ name: repeat('n', 121) }) })).details?.failures?.[0]?.code)
      .toBe('limit-exceeded');
    expect(validate('codex.upsert', { entries: create({ description: repeat('d', 2000) }) }).ok).toBe(true);
    expect(refusal(validate('codex.upsert', { entries: create({ description: repeat('d', 2001) }) })).details?.failures?.[0]?.message)
      .toContain('limit 2000');
    // The alias **lower** edge is carried by the blank rule. The 1–64 ceiling
    // still holds on the upper edge, and the empty string is still refused — but
    // it is now refused as the blank it is, by `requireStringArray`, with a
    // message naming the index. Both edges stay tested, because a limit tested
    // only from the refusing side passes whether the comparison is `>` or `>=`.
    expect(refusal(validate('codex.upsert', { entries: create({ aliases: [repeat('a', 65)] }) })).details?.failures?.[0]?.message)
      .toContain('must be 1–64');
    expect(validate('codex.upsert', { entries: create({ aliases: [repeat('a', 64)] }) }).ok).toBe(true);
    const blankAlias = refusal(validate('codex.upsert', { entries: create({ aliases: [''] }) })).details?.failures?.[0];
    expect(blankAlias?.code).toBe('invalid-params');
    expect(blankAlias?.message).toContain('must not be blank');
  });

  it('refuses a node id in attachTo that does not resolve', () => {
    const e = refusal(validate('codex.upsert', { entries: create({ attachTo: [UNKNOWN_ID] }) }));
    expect(e.details?.failures?.[0]?.code).toBe('not-found');
    expect(e.details?.failures?.[0]?.correctiveHint).toBe('use binder.read_tree to list valid ids');
  });

  it('requires action, and an id on every update', () => {
    expect(refusal(validate('codex.upsert', { entries: [{ name: 'No action' }] })).details?.failures?.[0]?.message)
      .toContain('action must be "create" or "update"');
    expect(refusal(validate('codex.upsert', { entries: [{ action: 'update' }] })).details?.failures?.[0]?.message)
      .toContain('an update needs the id');
  });

  // A create must carry a name.
  // codex.md §2 says a name is "Required, non-empty after trim", and a create
  // with no name would write `name: ''`, which the next load would refuse. The apply
  // is still total, so a refusal here is the only thing standing between a
  // nameless op and a nameless entry.
  it('refuses a create with no name, and a blank one, and says which op', () => {
    const missing = refusal(validate('codex.upsert', { entries: [{ action: 'create', type: 'character' }] }));
    expect(missing.code).toBe('invalid-params');
    expect(missing.details?.failures?.[0]?.target).toBe('entries[0]');
    expect(missing.details?.failures?.[0]?.message).toContain('name is required on create');

    const blank = refusal(validate('codex.upsert', { entries: [{ action: 'create', name: '   ' }] }));
    expect(blank.details?.failures?.[0]?.message).toContain('name must not be blank');
  });

  it('leaves a name alone on an update that omits it', () => {
    expect(validate('codex.upsert', { entries: [{ action: 'update', id: CODEX_ENTRY, description: 'Renamed nothing.' }] }).ok)
      .toBe(true);
  });

  // A create that names an id is refused whether or not the id is taken. The
  // store mints every new id, so an id the caller sends on a create was being
  // accepted and then dropped — the silent drop the closed params surface refuses for every other
  // field. Refusing it is the one answer that does not lie about what was written.
  it('refuses a create that carries an id, naming the entry when the id is taken', () => {
    const taken = refusal(validate('codex.upsert', { entries: [{ action: 'create', id: CODEX_ENTRY, name: 'Fresh' }] }));
    expect(taken.details?.failures?.[0]?.message).toContain('already taken by "Elena"');
    expect(taken.details?.failures?.[0]?.correctiveHint).toContain('action "update"');

    const fresh = refusal(validate('codex.upsert', { entries: [{ action: 'create', id: 'c_FRESH00000', name: 'Fresh' }] }));
    expect(fresh.details?.failures?.[0]?.message).toContain('a create mints its own id');
  });

  // A citation is a real document's verbatim slice (codex.md §2,
  // `EntrySource`). The op carries them, the command checks each, and an update's
  // citations are counted against the entry's own so the cap is on the entry.
  it('holds each provenance citation to the EntrySource contract, and caps the entry at five', () => {
    // The quote is the fixture body's own text, at offsets that name it (codex.md §2).
    const good = { docId: THE_LANDING, quote: BODY, from: 0, to: BODY.length, extractedAt: '2026-10-01T00:00:00.000Z' };
    expect(validate('codex.upsert', { entries: create({ sources: [good] }) }).ok).toBe(true);

    const unknownDoc = refusal(validate('codex.upsert', { entries: create({ sources: [{ ...good, docId: UNKNOWN_ID }] }) }));
    expect(unknownDoc.details?.failures?.[0]?.message).toContain('is not a document in this project');

    const longQuote = refusal(validate('codex.upsert', { entries: create({ sources: [{ ...good, quote: repeat('q', 301) }] }) }));
    expect(longQuote.details?.failures?.[0]?.message).toContain('limit 300');
    // The limit is inclusive: a body holding exactly 300 characters, quoted in full, is accepted.
    const atLimit = makeSnapshot({ bodies: { [THE_LANDING]: repeat('q', 300) } });
    expect(validate('codex.upsert', { entries: create({ sources: [{ ...good, quote: repeat('q', 300), from: 0, to: 300 }] }) }, atLimit).ok).toBe(true);

    const backwards = refusal(validate('codex.upsert', { entries: create({ sources: [{ ...good, from: 9, to: 3 }] }) }));
    expect(backwards.details?.failures?.[0]?.message).toContain('to must be a whole offset ≥ from');

    // codex.md §2 defines the quote as a verbatim slice of the body at the offsets it
    // gives. Text the document does not hold there is refused, and the refusal names
    // the mismatch and the way out. "returns" sits at [6, 13) of the fixture body.
    const fabricated = refusal(validate('codex.upsert', { entries: create({ sources: [{ ...good, quote: 'A ship sank at dawn.', from: 0, to: 20 }] }) }));
    expect(fabricated.details?.failures?.[0]?.message).toContain('is not the text at [0, 20)');
    expect(fabricated.details?.failures?.[0]?.message).toContain('re-extract');
    const wrongOffsets = refusal(validate('codex.upsert', { entries: create({ sources: [{ ...good, quote: 'returns', from: 0, to: 7 }] }) }));
    expect(wrongOffsets.details?.failures?.[0]?.message).toContain('is not the text at [0, 7)');
    expect(validate('codex.upsert', { entries: create({ sources: [{ ...good, quote: 'returns', from: 6, to: 13 }] }) }).ok).toBe(true);

    const six = Array.from({ length: 6 }, () => good);
    const tooMany = refusal(validate('codex.upsert', { entries: create({ sources: six }) }));
    expect(tooMany.details?.failures?.[0]?.message).toContain('limit 5');

    // The fixture entry holds none; five new ones on an update are the most it takes.
    expect(validate('codex.upsert', { entries: [{ action: 'update', id: CODEX_ENTRY, sources: six.slice(0, 5) }] }).ok).toBe(true);
    const onTop = refusal(validate('codex.upsert', { entries: [{ action: 'update', id: CODEX_ENTRY, sources: six }] }));
    expect(onTop.details?.failures?.[0]?.message).toContain('limit 5');
  });

  // codex.md §2: exclude ≤ 20 phrases, each ≤ 64 chars. The limits were on the
  // manifest validator only, so an over-long exclude phrase was accepted by the
  // command and refused on the next load. Both edges, as the other limits are.
  it('holds the exclude limits on both edges, on the command side', () => {
    const phrases = (n: number, len: number) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(len, 'x'));
    expect(validate('codex.upsert', { entries: create({ exclude: phrases(20, 5) }) }).ok).toBe(true);
    const tooMany = refusal(validate('codex.upsert', { entries: create({ exclude: phrases(21, 5) }) }));
    expect(tooMany.details?.failures?.[0]?.message).toContain('21 entries, limit 20');
    expect(validate('codex.upsert', { entries: create({ exclude: [repeat('e', 64)] }) }).ok).toBe(true);
    const tooLong = refusal(validate('codex.upsert', { entries: create({ exclude: [repeat('e', 65)] }) }));
    expect(tooLong.details?.failures?.[0]?.message).toContain('must be 1–64');
    const blank = refusal(validate('codex.upsert', { entries: create({ exclude: ['  '] }) }));
    expect(blank.details?.failures?.[0]?.message).toContain('must not be blank');
  });

  // validate is pure and total (command-bus §2). JSON.stringify throws on a
  // BigInt and on a cycle, and three of this descriptor's refusal messages were
  // built with it, so a model sending `type: 1n` got a raw TypeError instead of
  // the refusal the field deserves. The message names what it got, without
  // serialising it.
  it('is total over BigInt and circular values: a refusal, never a TypeError', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    const hostile: Record<string, unknown>[] = [
      { action: 1n },
      { action: 'create', name: 'X', type: 1n },
      { action: 'create', name: 'X', type: loop },
      { action: 'create', name: 'X', includePolicy: 2n },
      { action: 'create', name: 'X', includePolicy: loop },
      { action: 'create', name: 'X', aliases: [loop] },
      { action: 'create', name: 'X', exclude: [3n] },
      { action: 'update', id: 5n },
    ];
    for (const op of hostile) {
      let result: Result<never, CommandError> | undefined;
      expect(() => {
        result = validate('codex.upsert', { entries: [op] });
      }).not.toThrow();
      expect(refusal(result as Result<never, CommandError>).code).toBe('invalid-params');
    }
    expect(refusal(validate('codex.upsert', { entries: [{ action: 1n }] })).details?.failures?.[0]?.message)
      .toContain('got a bigint');
  });

  // `codex.upsert` used to return the caller's array behind an
  // `as CodexUpsertOp[]` cast, so an op that *passed* validation came back
  // carrying `origin`, `sources` and `updatedAt` — fields CodexUpsertOp does not
  // declare and no check reads. Asserted on both sides, like the limit edges
  // above: the undeclared keys must be gone AND every declared key must survive,
  // so a narrowing that dropped real data would fail here too.
  const CODEX_OP_FIELDS = [
    'action',
    'id',
    'name',
    'aliases',
    'type',
    'description',
    'includePolicy',
    'caseSensitive',
    'exclude',
    'attachTo',
    'detachFrom',
    'keywords',
  ];

  it('returns ops narrowed to CodexUpsertOp, so an unvalidated field cannot cross the boundary', () => {
    const accepted = (r: Result<never, CommandError>): Record<string, unknown> => {
      if (!r.ok) throw new Error(`expected an acceptance, got ${JSON.stringify(r.error)}`);
      return r.value as unknown as Record<string, unknown>;
    };
    const firstOp = (r: Result<never, CommandError>): Record<string, unknown> =>
      (accepted(r)['entries'] as Record<string, unknown>[])[0]!;

    expect(
      Object.keys(
        firstOp(
          validate('codex.upsert', {
            entries: [
              // An update, not a create: the all-fields op has to carry `id`, and a
              // create that names one is refused (see "refuses a create that carries
              // an id"). The fixture entry is the one it updates.
              {
                action: 'update',
                id: CODEX_ENTRY,
                name: 'Wren',
                aliases: ['Wrennie'],
                type: 'character',
                description: 'The bird.',
                includePolicy: 'detected',
                caseSensitive: false,
                exclude: ['pigeon'],
                attachTo: [THE_LANDING],
                detachFrom: [],
                keywords: ['sea'],
              },
            ],
          }),
        ),
      ).sort(),
    ).toEqual([...CODEX_OP_FIELDS].sort());

    // codex.md §2: provenance is harness-owned. Naming the field must not smuggle it
    // through a `validate` that never read it.
    //
    // **This is a refusal, not a drop.** The test used to assert that
    // the three fields came back absent — which is true of a drop and equally
    // true of a refusal, so it could not tell the two apart. The narrowing above
    // still holds for an op that validates; what changed is that an op carrying
    // these keys no longer validates at all, so the op that *could* have carried
    // a forged `origin` never reaches an apply.
    const refused = validate('codex.upsert', {
      entries: [
        {
          action: 'create',
          name: 'Wren',
          type: 'character',
          origin: 'agent',
          sources: [{ kind: 'book', ref: 'p.1' }],
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });
    expect(refused.ok, 'an op carrying origin/updatedAt must be refused, not narrowed').toBe(false);
    if (refused.ok) return;
    const failure = refused.error.details?.failures?.[0];
    // **`sources` is no longer among the undeclared keys.** It is a
    // declared field now — the extraction's citations, which the harness supplies —
    // so its own check refuses this shape instead: `kind`/`ref` is not an
    // EntrySource, and the failure says so. `origin` stays refused as undeclared.
    expect(failure?.message).not.toContain('"sources"');
    // Every forbidden field named in one round trip, addressed per-op.
    for (const undeclared of ['origin', 'updatedAt']) {
      expect(failure?.message, undeclared).toContain(`"${undeclared}"`);
    }
    expect(failure?.target).toBe('entries[0].origin');

    // The narrowing is still real for an op that *does* validate — asserted
    // separately above, on the all-fields op, so this pair brackets the change:
    // declared keys pass through narrowed, undeclared keys are refused.
    const clean = firstOp(
      validate('codex.upsert', {
        entries: [{ action: 'create', name: 'Wren', type: 'character' }],
      }),
    );
    expect(Object.keys(clean).sort()).toEqual(['action', 'name', 'type']);
  });
});

describe('codex.attach', () => {
  it('accepts a valid attach and refuses an unknown entry or node', () => {
    expect(validate('codex.attach', { entryId: CODEX_ENTRY, attachTo: [THE_LANDING], detachFrom: [] }).ok).toBe(true);
    const noEntry = refusal(validate('codex.attach', { entryId: 'c_NOPE', attachTo: [], detachFrom: [] }));
    expect(noEntry.code).toBe('not-found');
    expect(noEntry.correctiveHint).toBe('use codex.read with a query to find the entry');
    expect(refusal(validate('codex.attach', { entryId: CODEX_ENTRY, attachTo: [UNKNOWN_ID], detachFrom: [] })).message)
      .toContain('attachTo[0]');
  });

  // §5 asks for the *exact* inverse, and an id in both lists would have its
  // effect decided by an apply-side order the caller never wrote.
  it('refuses a node named in both lists, and says which node and how to fix it', () => {
    const e = refusal(validate('codex.attach', {
      entryId: CODEX_ENTRY,
      attachTo: [CHAPTER_ONE, THE_LANDING],
      detachFrom: [THE_LANDING],
    }));
    expect(e.code).toBe('invalid-params');
    expect(e.message).toContain(`"${THE_LANDING}" is in both attachTo and detachFrom`);
    expect(e.correctiveHint).toContain('not both');
    // The disjoint half of the same command is still accepted — a refusal that
    // caught the whole shape rather than the overlap would be over-correction.
    expect(validate('codex.attach', {
      entryId: CODEX_ENTRY,
      attachTo: [CHAPTER_ONE],
      detachFrom: [THE_LANDING],
    }).ok).toBe(true);
  });
});

describe('export.compile, export.compileSelection and project.deleteNode', () => {
  // The limits the store's manifest validator quotes are exported from here, so one
  // constant is the record of each. The numbers are project-format §2's
  // and exporter.md §2's, and a change to either is a change to the spec first.
  it('exports the synopsis, keyword and format limits the spec states', () => {
    expect(SYNOPSIS_MAX).toBe(2000);
    expect(KEYWORDS_MAX).toBe(32);
    expect(KEYWORD_CHARS_MAX).toBe(64);
    expect(EXPORT_FORMATS).toEqual([
      'md',
      'txt',
      'docx',
      'epub',
      'fountain',
      'fdx',
      'ink-json',
      'dialogue-csv',
      'shot-list-csv',
      'promptpack',
      // The coherence report, as Markdown and JSON. Ten formats before it.
      'coherence-md',
      'coherence-json',
      // The dialogue table and the shot list as spreadsheets. Then the screenplay PDF: fifteen.
      'dialogue-xlsx',
      'shot-list-xlsx',
      'pdf',
      // The storyboard contact sheet (storyboard.md §6), the sixteenth.
      'contact-sheet-pdf',
      // The comic PDF (comics.md §5), the seventeenth.
      'comic-pdf',
      // The timeline's exports (timeline.md §8), the eighteenth to twenty-first.
      'timeline-csv',
      'timeline-xlsx',
      'timeline-svg',
      'timeline-pdf',
      // The comic's raster formats (comics.md §5), the twenty-second and twenty-third.
      'cbz',
      'comic-epub',
    ]);
  });

  // The format enum is the exporter's, but the bus holds a copy of the exporter's list, and every value in
  // it has a renderer, so a format none of them ships is refused at validate — before an
  // apply is asked to write a file it cannot compile. The copy is checked against the
  // exporter's list in packages/exporter/test/export-formats.test.ts, which imports this
  // one. The list is closed, and the two names share it. `rtf` is the probe for a
  // format nothing ships, and `docx-pdf` for a name that only looks like one.
  it('accepts every format the bus lists on both names, and refuses any other', () => {
    for (const format of EXPORT_FORMATS) {
      // A prompt pack names its vendor template (the refusal without one is its own test, below).
      const template = format === 'promptpack' ? { templateId: 'a-vendor' } : {};
      expect(validate('export.compile', { format, ...template }).ok, format).toBe(true);
      expect(validate('export.compileSelection', { includeRootIds: ['n1'], format, ...template }).ok, format).toBe(true);
    }
    const formats = EXPORT_FORMATS.join(', ');
    for (const unshipped of ['rtf', 'docx-pdf']) {
      for (const name of ['export.compile', 'export.compileSelection'] as const) {
        const params = name === 'export.compile' ? { format: unshipped } : { includeRootIds: ['n1'], format: unshipped };
        const e = refusal(validate(name, params));
        expect(e.code, `${name} ${unshipped}`).toBe('invalid-params');
        expect(e.target, `${name} ${unshipped}`).toBe('format');
        expect(e.message, `${name} ${unshipped}`).toContain(`"${unshipped}" is not an export format in this build. The formats are ${formats}.`);
        expect(e.correctiveHint, `${name} ${unshipped}`).toBe(`pass one of ${formats}`);
      }
    }
  });

  it('export.compile returns exactly its declared keys, built from named fields', () => {
    // The shape half of the whole/part split. Every call here passes only
    // declared keys, so this asserts the payload is *built* — and it cannot see
    // the narrowing being removed, which is what the next test is for.
    const whole = validate('export.compile', { format: 'docx' });
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(Object.keys(whole.value).sort()).toEqual(['format']);

    // A recipe name is checked against the project's recipes, so the snapshot has to hold the one the call names.
    const withRecipe = makeSnapshot({ recipes: [{ name: 'paperback draft' }] });
    const named = validate('export.compile', { format: 'docx', recipeName: 'paperback draft' }, withRecipe);
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(Object.keys(named.value).sort()).toEqual(['format', 'recipeName']);

    // A blank recipe name is a refusal, not a silent trim to ''.
    expect(refusal(validate('export.compile', { format: 'docx', recipeName: '  ' })).code).toBe('invalid-params');
  });

  it('export.compile refuses a prompt pack that names neither a vendor template nor a recipe, at validate', () => {
    // The bus cannot list the installed templates, and its snapshot holds no recipe template, so it refuses the shape it can see:
    // no template and no recipe. The harness checks an id against the list, with the recipe's template, before the card.
    const bare = refusal(validate('export.compile', { format: 'promptpack' }));
    expect(bare.code).toBe('invalid-params');
    expect(bare.target).toBe('templateId');
    expect(bare.message).toContain('vendor template');
    expect(validate('export.compile', { format: 'promptpack', templateId: 'a-vendor' }).ok).toBe(true);
    const withRecipe = makeSnapshot({ recipes: [{ name: 'pack' }] });
    expect(validate('export.compile', { format: 'promptpack', recipeName: 'pack' }, withRecipe).ok).toBe(true);
  });

  it('export.compileSelection refuses a prompt pack that names neither a vendor template nor a recipe, at validate, as export.compile does', () => {
    // The same shape check as export.compile's (above): a part's pack with no template and no recipe is refused here, not at apply.
    const part = { includeRootIds: ['n1'], format: 'promptpack' };
    const bare = refusal(validate('export.compileSelection', part));
    expect(bare.code).toBe('invalid-params');
    expect(bare.target).toBe('templateId');
    expect(bare.message).toContain('vendor template');
    expect(validate('export.compileSelection', { ...part, templateId: 'a-vendor' }).ok).toBe(true);
    const withRecipe = makeSnapshot({ recipes: [{ name: 'pack' }] });
    expect(validate('export.compileSelection', { ...part, recipeName: 'pack' }, withRecipe).ok).toBe(true);
  });

  it('export.compile refuses a recipe name the project does not hold as not-found, before any apply', () => {
    const missing = refusal(validate('export.compile', { format: 'docx', recipeName: 'Ghost' }));
    expect(missing).toMatchObject({ code: 'not-found', target: 'recipeName' });
    expect(missing.message).toContain('there is no saved recipe named "Ghost"');
  });

  it('an export names the default recipe of a project that stores no recipes array, because the exporter offers it (exporter.md §4)', () => {
    // makeSnapshot() stores no recipes array, which is a project that predates recipes: the default is the one it holds.
    const bare = makeSnapshot();
    expect(bare.manifest.recipes).toBeUndefined();
    expect(validate('export.compile', { format: 'docx', recipeName: DEFAULT_RECIPE_NAME }, bare).ok).toBe(true);
    const part = { includeRootIds: ['n1'], format: 'docx', recipeName: DEFAULT_RECIPE_NAME };
    expect(validate('export.compileSelection', part, bare).ok).toBe(true);
    expect(refusal(validate('export.compile', { format: 'docx', recipeName: 'Ghost' }, bare))).toMatchObject({
      code: 'not-found',
      target: 'recipeName',
    });
  });

  it('export.compileSelection takes a recipe for the part\'s options, and refuses a recipe the project does not hold', () => {
    const withRecipe = makeSnapshot({ recipes: [{ name: 'beta read' }] });
    const named = validate('export.compileSelection', { includeRootIds: ['n1'], format: 'docx', recipeName: 'beta read' }, withRecipe);
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(Object.keys(named.value).sort()).toEqual(['format', 'includeRootIds', 'recipeName']);
    expect(refusal(validate('export.compileSelection', { includeRootIds: ['n1'], format: 'docx', recipeName: 'Ghost' }))).toMatchObject({
      code: 'not-found',
      target: 'recipeName',
    });
    expect(refusal(validate('export.compileSelection', { includeRootIds: ['n1'], format: 'docx', recipeName: '  ' })).code).toBe(
      'invalid-params',
    );
  });

  it('no scope field can come back on export.compile\'s payload, whatever the caller passed', () => {
    // The narrowing IS the split's guarantee, and the mutation that removes it is
    // The own finding replayed one command over: `ok(p.value as
    // ExportCompileParams)` — the caller's object behind a cast, which is how
    // `codex.upsert` let `origin`/`sources`/`updatedAt` through. That mutant was
    // invisible to every other case in this file, because each of them passes no
    // key the narrowing could drop.
    //
    // Deliberately written to hold under BOTH accepted outcomes rather than to
    // pin one: the refuse-vs-drop fork for an undeclared key is the decision,
    // so a refusal satisfies this trivially and a payload with no scope field in
    // it satisfies it substantively. Reverting the narrowing to a cast fails
    // exactly here and leaves the rest of the suite green.
    const scopeFields = ['includeRootIds', 'selection', 'docFilter'];
    for (const extra of [{ includeRootIds: ['n1', 'n2'] }, { selection: 'manuscript' }, { docFilter: 'nope' }]) {
      const r = validate('export.compile', { format: 'docx', ...extra });
      if (r.ok) {
        for (const field of scopeFields) {
          expect(
            Object.keys(r.value),
            `${field} survived onto export.compile's payload from ${JSON.stringify(extra)}`,
          ).not.toContain(field);
        }
      } else {
        // The other half of "either answer is acceptable": a refusal is a
        // structured refusal, not a throw and not a success.
        expect(r.error.code).toBe('invalid-params');
      }
    }
  });

  it('export.compileSelection is a part, and an empty selection points back at the sibling', () => {
    const part = validate('export.compileSelection', { includeRootIds: ['n1', 'n2'], format: 'md' });
    expect(part.ok).toBe(true);
    if (!part.ok) return;
    expect(Object.keys(part.value).sort()).toEqual(['format', 'includeRootIds']);

    // Empty is the dangerous case: it would otherwise compile nothing and call it
    // success, so the hint names the command that does mean "the whole thing".
    const empty = refusal(validate('export.compileSelection', { includeRootIds: [], format: 'md' }));
    expect(empty.code).toBe('invalid-params');
    expect(empty.correctiveHint).toContain('export.compile');
    expect(refusal(validate('export.compileSelection', { includeRootIds: 'manuscript', format: 'md' })).code).toBe('invalid-params');
    expect(refusal(validate('export.compileSelection', { includeRootIds: [42], format: 'md' })).target).toBe('includeRootIds[0]');
  });

  it('deletes a document but refuses all three fixed roots — project-format §2', () => {
    expect(validate('project.deleteNode', { nodeId: THE_LANDING }).ok).toBe(true);
    for (const id of [ROOT, MANUSCRIPT, RESEARCH]) {
      const e = refusal(validate('project.deleteNode', { nodeId: id }));
      expect(e.code, id).toBe('invalid-params');
      expect(e.message, id).toContain('fixed root and cannot be deleted');
    }
  });
});

describe('the three view commands validate shape only', () => {
  it('accepts a stale selection id — a validator that refused it would be the bug', () => {
    expect(validate('view.setSelection', { nodeIds: [THE_LANDING, UNKNOWN_ID] }).ok).toBe(true);
    expect(validate('view.setActiveDoc', { docId: UNKNOWN_ID }).ok).toBe(true);
    expect(validate('view.setScroll', { nodeId: UNKNOWN_ID, offset: 900 }).ok).toBe(true);
  });

  it('still refuses a malformed shape', () => {
    expect(refusal(validate('view.setSelection', { nodeIds: THE_LANDING })).message).toContain('must be an array of strings');
    // This message is deliberate: a `length === 0` check would say
    // "must not be empty" while `'   '` passed. Both are "must not
    // be blank" now, and the case below is the one that says so.
    expect(refusal(validate('view.setActiveDoc', { docId: '' })).message).toContain('must not be blank');
    expect(refusal(validate('view.setScroll', { nodeId: THE_LANDING, offset: -1 })).message).toContain('must be ≥ 0');
  });
});

// The title is scoped to what this block demonstrates: the parent, id and shot
// state a plan names. `storyboard.create`'s scene anchor is only shape-checked
// here — a scene that changed or moved since the plan is refused by the apply
// (`scene-changed`/`scene-moved`, storyboard's commands.ts), not at validate.
describe('the three storyboard commands read the snapshot, so a plan whose target is gone cannot pass validate', () => {
  const BOARD = 'n_BD00000001';
  const SHOT = 'n_SH00000001';
  const NEW_BOARD = 'n_NB00000001';
  const NEW_SHOT = 'n_NS00000001';
  // A storyboard folder with one shot in it: the two ends of every placement
  // these three commands check.
  const withBoard = makeSnapshot({
    extraNodes: [
      { id: BOARD, parentId: CHAPTER_ONE, type: 'folder', kind: 'storyboard', title: 'The Landing — Shots' },
      { id: SHOT, parentId: BOARD, type: 'shot', title: 'Shot 1' },
    ],
  });
  const scene = { id: THE_LANDING, parentId: CHAPTER_ONE, revision: REVISION };

  it('refuses a storyboard whose parent is gone, before the plan can promise it', () => {
    const e = refusal(validate('storyboard.create', { id: NEW_BOARD, parentId: UNKNOWN_ID, title: 'Shots', scene }));
    expect(e.code).toBe('not-found');
    // The bus names the node that is missing, not the key it was named by.
    expect(e.target).toBe(UNKNOWN_ID);
    expect(e.message).toContain('no node with id');
  });

  it('refuses a storyboard whose id is already in the tree', () => {
    const e = refusal(validate('storyboard.create', { id: THE_LANDING, parentId: CHAPTER_ONE, title: 'Shots', scene }));
    expect(e.code).toBe('invalid-params');
    expect(e.target).toBe('id');
  });

  it('refuses a storyboard parent the binder could never show or that cannot hold one', () => {
    // The placement rules binder.create enforces, enforced here too: a board
    // under the project root is a node the binder never shows, a document
    // cannot hold children, and a storyboard folder holds only shots.
    const root = refusal(validate('storyboard.create', { id: NEW_BOARD, parentId: ROOT, title: 'Shots', scene }));
    expect(root.code).toBe('invalid-params');
    expect(root.target).toBe('parentId');
    expect(root.message).toContain('never appear');
    const doc = refusal(validate('storyboard.create', { id: NEW_BOARD, parentId: THE_LANDING, title: 'Shots', scene }));
    expect(doc.code).toBe('invalid-params');
    expect(doc.target).toBe('parentId');
    expect(doc.message).toContain('cannot hold children');
    const inBoard = refusal(validate('storyboard.create', { id: NEW_BOARD, parentId: BOARD, title: 'Shots', scene }, withBoard));
    expect(inBoard.code).toBe('invalid-params');
    expect(inBoard.target).toBe('parentId');
    expect(inBoard.message).toContain('holds only shots');
  });

  it('refuses a minted id that is not a node id, because the project would not load again', () => {
    // A node id is also a filename (project-format §2), so the shape is a
    // load-time contract and the store refuses such a manifest on the next open.
    const e = refusal(validate('storyboard.create', { id: 'board-1', parentId: CHAPTER_ONE, title: 'Shots', scene }));
    expect(e.code).toBe('invalid-params');
    expect(e.target).toBe('id');
  });

  it('refuses a shot whose parent is gone, and one whose parent is not a storyboard folder', () => {
    const gone = refusal(validate('shot.create', { id: NEW_SHOT, parentId: UNKNOWN_ID, title: 'Shot 2', stored: {} }, withBoard));
    expect(gone.code).toBe('not-found');
    expect(gone.target).toBe(UNKNOWN_ID);
    const notABoard = refusal(validate('shot.create', { id: NEW_SHOT, parentId: CHAPTER_ONE, title: 'Shot 2', stored: {} }, withBoard));
    expect(notABoard.code).toBe('invalid-params');
    expect(notABoard.target).toBe('parentId');
  });

  it('refuses a shot whose id is already in the tree', () => {
    const e = refusal(validate('shot.create', { id: SHOT, parentId: BOARD, title: 'Shot 2', stored: {} }, withBoard));
    expect(e.code).toBe('invalid-params');
    expect(e.target).toBe('id');
  });

  it('refuses a shot.setMeta for a shot that is gone, and for a node that is not a shot', () => {
    const gone = refusal(validate('shot.setMeta', { nodeId: UNKNOWN_ID, stored: { shotSize: 'CU' }, expect: null }, withBoard));
    expect(gone.code).toBe('not-found');
    const notAShot = refusal(validate('shot.setMeta', { nodeId: THE_LANDING, stored: { shotSize: 'CU' }, expect: null }, withBoard));
    expect(notAShot.code).toBe('invalid-params');
    expect(notAShot.target).toBe('nodeId');
  });

  it('still accepts the three commands with a live parent and a fresh id', () => {
    expect(validate('storyboard.create', { id: NEW_BOARD, parentId: CHAPTER_ONE, title: 'Shots', scene }).ok).toBe(true);
    expect(validate('shot.create', { id: NEW_SHOT, parentId: BOARD, title: 'Shot 2', stored: {} }, withBoard).ok).toBe(true);
    expect(validate('shot.setMeta', { nodeId: SHOT, stored: { shotSize: 'CU' }, expect: null }, withBoard).ok).toBe(true);
  });

  it('fails closed on a malformed snapshot, exactly like the rest of the module', () => {
    // The manifest is a required field of the snapshot, so a snapshot without one
    // is a broken read seam — a partial projection or an adapter defect — and not
    // "no project state". These three commands dereference `manifest.tree` the way
    // `binder.move` and `doc.write` do, so the defect surfaces loudly instead of
    // silently standing every existence check down and letting a validated command
    // fail mid-apply — the §2 hole these checks exist to close.
    const none = {} as unknown as ValidationSnapshot;
    expect(() => validate('storyboard.create', { id: NEW_BOARD, parentId: UNKNOWN_ID, title: 'Shots', scene }, none)).toThrow();
    expect(() => validate('shot.create', { id: NEW_SHOT, parentId: UNKNOWN_ID, title: 'Shot 2', stored: {} }, none)).toThrow();
    expect(() => validate('shot.setMeta', { nodeId: UNKNOWN_ID, stored: { shotSize: 'CU' }, expect: null }, none)).toThrow();
    expect(() => validate('binder.move', { nodeId: THE_LANDING, newParentId: CHAPTER_ONE, index: 0 }, none)).toThrow();
  });
});

describe('§2: validate is pure', () => {
  it('leaves the snapshot byte-identical after a full pass over every command', () => {
    const live = makeSnapshot();
    const before = structuredClone(live);
    validate('binder.create', { parentId: CHAPTER_ONE, type: 'document', title: 'New' }, live);
    validate('binder.move', { nodeId: CHAPTER_TWO, newParentId: CHAPTER_ONE, index: 0 }, live);
    validate('binder.setMeta', { nodeId: THE_LANDING, patch: { status: 'final', keywords_add: ['new-tag'] } }, live);
    validate('binder.setSynopsis', { nodeId: THE_LANDING, synopsis: 'x' }, live);
    validate('notes.append', { nodeId: THE_LANDING, text: 'x' }, live);
    validate('doc.write', { docId: THE_LANDING, body: 'x' }, live);
    validate('editor.insert', { docId: THE_LANDING, offset: 2, text: 'x' }, live);
    validate('editor.replaceRange', { docId: THE_LANDING, range: { from: 0, to: 2 }, text: 'x' }, live);
    validate('codex.upsert', { entries: [{ action: 'create', name: 'Temp', type: 'lore' }] }, live);
    validate('codex.attach', { entryId: CODEX_ENTRY, attachTo: [THE_LANDING], detachFrom: [] }, live);
    expect(live).toEqual(before);
  });

  it('never throws, whatever it is handed', () => {
    const hostile: unknown[] = [undefined, null, 42, 'string', [], { nodeId: {} }, { patch: { status: 7 } }];
    for (const name of Object.keys(COMMAND_REGISTRY) as CommandName[]) {
      for (const params of hostile) {
        expect(() => validate(name, params), `${name} with ${JSON.stringify(params) ?? 'undefined'}`).not.toThrow();
      }
    }
  });

  it('every refusal is prose, never a bare code — §7', () => {
    const live = makeSnapshot();
    const cases: [CommandName, unknown][] = [
      ['binder.create', { parentId: UNKNOWN_ID, type: 'folder', title: 'x' }],
      ['binder.move', { nodeId: CHAPTER_ONE, newParentId: CHAPTER_ONE, index: 0 }],
      ['binder.setMeta', { nodeId: THE_LANDING, patch: { status: 'nope' } }],
      ['binder.setSynopsis', { nodeId: THE_LANDING, synopsis: repeat('s', 2001) }],
      ['notes.append', { nodeId: THE_LANDING, text: repeat('t', 2001) }],
      ['doc.write', { docId: CHAPTER_ONE, body: 'x' }],
      ['editor.insert', { docId: THE_LANDING, offset: 999, text: 'x' }],
      ['codex.upsert', { entries: [{ action: 'update', id: 'c_NOPE' }] }],
      ['codex.attach', { entryId: 'c_NOPE', attachTo: [], detachFrom: [] }],
      ['project.deleteNode', { nodeId: MANUSCRIPT }],
    ];
    for (const [name, params] of cases) {
      const e = refusal(validate(name, params, live));
      expect(e.message, `${name} message`).not.toBe(e.code);
      expect(e.message.length, `${name} message length`).toBeGreaterThan(20);
      expect(e.correctiveHint, `${name} hint`).toBeTruthy();
    }
  });
});

describe('the revision counter the bus reads', () => {
  it('is the one the runtime store keeps, per project-format §4', () => {
    expect(snapshot.documents.get(THE_LANDING)?.revision).toBe(REVISION);
  });
});

/**
 * A blank string is refused wherever it names nothing.**
 *
 * `includeRootIds: ['']` was once **accepted**, because
 * `requireStringArray` had no blank check. The rule lives in the helper, so these cases are not one command's tests — they are the
 * helper's, and the first case in each group is the one that was accepted.
 *
 * **Every case here failed before this slice and each is asserted from the
 * refusing side and the accepting side**, because the shape of the bug was a
 * check that existed and was too narrow: `''` refused, `'   '` accepted. A test
 * written only for `''` would have been green before the fix.
 */
describe('a blank string names nothing, so it is a refusal', () => {
  it("includeRootIds holding one blank id is the empty list's own twin", () => {
    // The reason `[]` is refused is that it compiles nothing and calls it
    // success. `['']` reaches the same outcome one token over.
    for (const blank of ['', '   ', '\t', '\n']) {
      const e = refusal(validate('export.compileSelection', { includeRootIds: [blank], format: 'md' }));
      expect(e.code, JSON.stringify(blank)).toBe('invalid-params');
      expect(e.target, JSON.stringify(blank)).toBe('includeRootIds[0]');
      expect(e.message, JSON.stringify(blank)).toContain('must not be blank');
      expect(e.correctiveHint, JSON.stringify(blank)).toBeTruthy();
    }
  });

  it('the blank is refused at its own index, so the payload never comes back shorter than it went in', () => {
    const e = refusal(validate('export.compileSelection', { includeRootIds: ['n1', '  '], format: 'md' }));
    expect(e.target).toBe('includeRootIds[1]');
    // And the accepted neighbour is untouched — a refusal that caught the whole
    // list would be over-correction.
    expect(validate('export.compileSelection', { includeRootIds: ['n1', 'n2'], format: 'md' }).ok).toBe(true);
  });

  it('the empty-list refusal keeps its own message — the two rules answer different questions', () => {
    const empty = refusal(validate('export.compileSelection', { includeRootIds: [], format: 'md' }));
    expect(empty.message).toContain('must name at least one node');
    expect(empty.correctiveHint).toContain('export.compile');
  });

  it('the helper, so the five other list fields are covered by construction rather than by a row each', () => {
    const lists: [CommandName, unknown][] = [
      ['codex.attach', { entryId: CODEX_ENTRY, attachTo: ['  '], detachFrom: [] }],
      ['codex.attach', { entryId: CODEX_ENTRY, attachTo: [], detachFrom: [''] }],
      ['codex.upsert', { entries: [{ action: 'create', name: 'X', type: 'lore', aliases: ['   '] }] }],
      ['codex.upsert', { entries: [{ action: 'create', name: 'X', type: 'lore', keywords: [''] }] }],
      ['codex.upsert', { entries: [{ action: 'create', name: 'X', type: 'lore', exclude: [''] }] }],
      ['binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_add: [''] } }],
      ['binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_remove: ['   '] } }],
      ['view.setSelection', { nodeIds: [''] }],
    ];
    for (const [name, params] of lists) {
      const e = refusal(validate(name, params));
      expect(e.code, name).toBe('invalid-params');
      expect(e.message, name).toContain('must not be blank');
      expect(e.correctiveHint, name).toBeTruthy();
    }
  });

  it('an empty list is still accepted — "nothing to do" is an instruction, and only includeRootIds forbids it', () => {
    expect(validate('codex.attach', { entryId: CODEX_ENTRY, attachTo: [], detachFrom: [] }).ok).toBe(true);
    expect(validate('binder.setMeta', { nodeId: THE_LANDING, patch: { keywords_add: [] } }).ok).toBe(true);
  });

  it('a blank format is refused on both names, where the sibling recipeName already refused one', () => {
    for (const name of ['export.compile', 'export.compileSelection'] as const) {
      const params = name === 'export.compile' ? { format: '   ' } : { includeRootIds: ['n1'], format: '' };
      const e = refusal(validate(name, params));
      expect(e.code, name).toBe('invalid-params');
      expect(e.target, name).toBe('format');
      expect(e.message, name).toContain('must not be blank');
    }
    // A *named* format that is not one of the four is refused, as the test above
    // states; the blank refusal is the same check's first half.
    expect(validate('export.compile', { format: 'a-format-the-exporter-has-not-declared' }).ok).toBe(false);
    expect(validate('export.compileSelection', { includeRootIds: ['n1'], format: 'md' }).ok).toBe(true);
  });

  it('view.setActiveDoc refused "" and accepted "   " — the row title, in the view command a user reaches for first', () => {
    for (const blank of ['', '   ']) {
      const e = refusal(validate('view.setActiveDoc', { docId: blank }));
      expect(e.code, JSON.stringify(blank)).toBe('invalid-params');
      expect(e.target, JSON.stringify(blank)).toBe('docId');
      expect(e.correctiveHint, JSON.stringify(blank)).toContain('the id of the document');
    }
    // A real id is untouched — view state is shape-only by §9 and stays so.
    expect(validate('view.setActiveDoc', { docId: UNKNOWN_ID }).ok).toBe(true);
  });

  it('view.setScroll refused a blank node id, as its two sibling view commands do', () => {
    // A scroll that names no node writes a junk key into the scroll map and an
    // audit row that reads "scrolled to offset 0" for nothing.
    for (const blank of ['', '   ']) {
      const e = refusal(validate('view.setScroll', { nodeId: blank, offset: 0 }));
      expect(e.code, JSON.stringify(blank)).toBe('invalid-params');
      expect(e.target, JSON.stringify(blank)).toBe('nodeId');
      expect(e.correctiveHint, JSON.stringify(blank)).toContain('the id of the node');
    }
    // A real id is untouched — view state is shape-only by §9 and stays so.
    expect(validate('view.setScroll', { nodeId: UNKNOWN_ID, offset: 900 }).ok).toBe(true);
  });

  it("codex.upsert's name is refused blank, because codex.md §2 states it", () => {
    for (const blank of ['', '   ']) {
      const e = refusal(validate('codex.upsert', { entries: [{ action: 'create', name: blank, type: 'lore' }] }));
      expect(e.code, JSON.stringify(blank)).toBe('invalid-params');
      expect(JSON.stringify(e.details), JSON.stringify(blank)).toContain('must not be blank');
      expect(JSON.stringify(e.details), JSON.stringify(blank)).toContain('codex.md');
    }
    // The ceiling and the collision map still do their own jobs.
    expect(validate('codex.upsert', { entries: [{ action: 'create', name: 'The Salt Road', type: 'lore' }] }).ok).toBe(true);
  });

  it('an empty string is still a legitimate value where the spec calls it one', () => {
    // The counterweight, and the reason the rule is per-field and not a blanket
    // one in `requireString`: "clear this field" is an instruction, and a blanket
    // blank rule would make it uncallable. If this case ever fails, the blank rule has
    // become a rule about strings rather than about names.
    expect(validate('notes.set', { nodeId: THE_LANDING, notes: '' }).ok).toBe(true);
    expect(validate('binder.setSynopsis', { nodeId: THE_LANDING, synopsis: '' }).ok).toBe(true);
    expect(validate('doc.write', { docId: THE_LANDING, body: '' }).ok).toBe(true);
    expect(validate('notes.append', { nodeId: THE_LANDING, text: '' }).ok).toBe(true);
  });
});
