/**
 * The v0.1 command registry, one descriptor per name —
 * [command-bus.md §9](docs/architecture/command-bus.md).
 *
 * §9 is the table; this file is it in code. Every limit a validator enforces is
 * quoted from the spec that states it, because a limit with no source is a
 * limit that rots:
 *
 * | Limit | Source |
 * |---|---|
 * | synopsis ≤ 2000, notes ≤ 50 000, keywords ≤ 32 × 64 chars | project-format §2 |
 * | `notes.append` text ≤ 2000 chars | agent-harness §3 row 6 |
 * | codex: ≤ 20 ops/batch, name ≤ 120, aliases ≤ 10 × 1–64, description ≤ 2000 | codex.md §7 / §2 |
 * | fixed roots are reserved and not deletable | project-format §2 |
 * | cycle check + manuscript-root invariant, in `validate` | command-bus §9 `binder.move` |
 *
 * **These are `validate` only — none of them has an effect in this package.** §3's
 * pipeline and the undo groups live in `pipeline.ts` and `undo.ts` (`execute()`,
 * the group store, the log); the three `view.*` applies ship because §2
 * makes their effect ephemeral UI state — they need no store, and they are the
 * pipeline's non-vacuous case. Every project apply is store-side, and by
 * necessity rather than by phase: §1 says the bus does not own project state.
 * The project applies (`inverse`, `compensable`, `codex.upsert`,
 * `project.deleteNode` and the rest) are in `packages/store/src/commands.ts`, and
 * `packages/store/test/commands.test.ts` asserts how many the store's
 * `createProjectCommandRegistry()` implements — measured, not counted here; the
 * names left without an exporter are the two exports. `registry.ts`'s `resolveCommand` still refuses any name
 * with no effect loudly, which for the bus is all of them, because §1 puts the
 * applies in the store.
 */

import { err, ok, type CommandError, type Result } from './result.js';
import type {
  McpInvokeParams,
  ShotCreateCommandParams,
  ShotSetMetaCommandParams,
  StoryboardCreateCommandParams,
  BinderCreateParams,
  BinderMoveParams,
  BinderRenameParams,
  BinderSetMetaParams,
  BinderSetSynopsisParams,
  CodexAttachParams,
  CodexUpsertOp,
  CodexUpsertParams,
  CoherenceSetFindingStatusParams,
  CoherenceSetSceneMetaParams,
  CommandDescriptor,
  DocWriteParams,
  EditorInsertParams,
  EditorReplaceRangeParams,
  ExportCompileParams,
  ExportCompileSelectionParams,
  MetaPatch,
  NotesAppendParams,
  NotesSetParams,
  ProjectDeleteNodeParams,
  ValidationNode,
  ValidationSnapshot,
  ViewSetActiveDocParams,
  ViewSetCorkboardScopeParams,
  ViewSetExpandedParams,
  ViewSetScrollParams,
  ViewSetSelectionParams,
} from './command.js';
import {
  HINT_READ_TREE,
  batchRefusal,
  changesNothing,
  cycleError,
  describe,
  documentLength,
  findNode,
  invalid,
  isContainer,
  isDescendantOf,
  isFixedRootId,
  isRecord,
  limitExceeded,
  notFound,
  notFoundError,
  optionalBoolean,
  optionalNonBlankString,
  optionalNullableString,
  optionalString,
  requireInteger,
  requireNode,
  requireDeclaredParams,
  requireNonBlankString,
  requireString,
  requireStringArray,
  showValue,
  toPerOpFailure,
} from './params.js';
import type { PerOpFailure } from './result.js';
import { recipeNameMissing } from './recipe-names.js';
import {
  COHERENCE_NOTE_LIMIT,
  COHERENCE_STATUSES,
  DISMISSAL_REASON_IDS,
  applySceneMetaPatch,
  coherenceNoteProblem,
  findingTransition,
  trimCoherenceNote,
  type CoherenceStatusName,
  type ScenePatch,
} from './coherence.js';

/**
 * project-format.md §2's node limits, **exported**, for the same
 * reason as the codex limits above: the manifest validator in `@caotang/store` quotes
 * the same numbers, and one constant is the only way the two cannot drift.
 */
export const SYNOPSIS_MAX = 2000;
export const KEYWORDS_MAX = 32;
export const KEYWORD_CHARS_MAX = 64;
const NOTES_MAX = 50_000;
const NOTES_APPEND_MAX = 2000;
const CODEX_BATCH_MAX = 20;

/**
 * codex.md §2's limits, **exported**.
 *
 * These numbers are quoted from the spec in two packages: here, where §7
 * refuses a batch that would produce an entry breaking them, and in
 * `@caotang/store`'s `validate.ts`, where §2's load-time contracts report the
 * same violations on a manifest that arrived from a hand edit, a sync conflict
 * or a foreign writer. `store` depends on `bus` and never the reverse, so this
 * is the only direction in which one of them can read the other — and one
 * constant is the whole point: two records of a limit is the drift species this
 * repo has paid for repeatedly (the docs/decisions.md harm; the `@likecoin` five-record
 * split; §9's Params column versus the accepted-key lists).
 *
 * `CODEX_TYPES` and `CODEX_POLICIES` are **not** re-exported from here and stay
 * local to each package: they are enum *membership*, and §2's answer to an
 * unknown member is a coercion that differs per surface — a refusal at the
 * command boundary, a coerced value on load. Same members, deliberately not the
 * same record, and `codex-enums-agree` in `packages/store/test/codex-manifest.test.ts`
 * holds the two member lists together.
 */
export const CODEX_NAME_MAX = 120;
export const CODEX_ALIASES_MAX = 10;
export const CODEX_ALIAS_CHARS_MAX = 64;
export const CODEX_DESCRIPTION_MAX = 2000;
export const CODEX_EXCLUDE_MAX = 20;
export const CODEX_EXCLUDE_CHARS_MAX = 64;
export const CODEX_SOURCES_MAX = 5;
/** codex.md §2: a citation's quote is a verbatim slice of at most 300 characters. */
export const CODEX_SOURCE_QUOTE_MAX = 300;
/**
 * video-prompt-pack.md §3 and A5: the visual references one entry carries. A command-side limit only: the loader keeps a
 * longer list, the same rule as `attachments`, so a hand-edited manifest is never refused for its length.
 */
export const CODEX_VISUAL_REFS_MAX = 10;
/**
 * The shape of an asset id (storyboard's `isAssetId`, and `ASSET_ID_PATTERN` in descriptors-project.ts). Repeated here
 * rather than imported: descriptors-project.ts imports this module, so the import would be a cycle.
 */
const VISUAL_REF_PATTERN = /^a_[0-9A-HJKMNP-TV-Z]{10}$/;
/**
 * The shape of a node id (project-format §2: `n_` and ten Crockford base32 chars). A node id is also a
 * filename, so the shape is a load-time contract: the store refuses a manifest that carries another shape.
 */
const NODE_ID_PATTERN = /^n_[0-9A-HJKMNP-TV-Z]{10}$/;
const CODEX_TYPES = ['character', 'location', 'object', 'lore', 'subplot', 'other'];
const CODEX_POLICIES = ['always', 'detected', 'manual', 'never'];

function rangeHint(length: number): string {
  return `offsets run 0-${length} in body coordinates - re-read the document for its current length`;
}

const PATCH_KEYS = ['status', 'label', 'keywords_add', 'keywords_remove'];

/**
 * `CodexUpsertOp`'s own fields, and nothing else.
 *
 * `codex.upsert` used to hand back the caller's array unchanged behind an
 * `as CodexUpsertOp[]` cast, so a `validate` that *accepted* an op could return
 * one carrying `origin`, `sources` or `updatedAt` — fields the type forbids and
 * no check reads. Every other descriptor builds its `ok` payload from named
 * fields; this narrows the same way, so the returned value is provably a
 * `CodexUpsertOp` rather than asserted to be one.
 *
 * `origin` is the load-bearing one: codex.md §2 makes provenance
 * harness-owned and ranks hand-authored above agent-inferred, so an agent must
 * not be able to stamp its own provenance by naming the field.
 *
 * **The field is *refused*, not dropped** — and this is the difference
 * the whole slice is about. `narrowCodexOp` was the last silent drop in the
 * package: an agent passing `origin: 'agent'` got back `ok` carrying an entry
 * stamped from `context.issuedBy`, i.e. a command that *reported success on a
 * provenance it did not set*. The refusal below replaces it. `narrowCodexOp`
 * survives as the narrowing it was written for — a defence in depth against a
 * `validateCodexOp` that forgot a field, not the thing enforcing the set.
 */
const CODEX_OP_KEYS = [
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
  // Citations, not provenance: the harness supplies the extraction's record of
  // where an entry's content came from (codex.md §2). `origin` stays refused.
  'sources',
  // The asset ids an entry's pack references carry (video-prompt-pack.md §3, A5). An update replaces the list, as `aliases` does.
  'visualRefs',
] as const;

function narrowCodexOp(op: Record<string, unknown>): CodexUpsertOp {
  const out: Record<string, unknown> = {};
  for (const key of CODEX_OP_KEYS) {
    if (op[key] !== undefined) out[key] = op[key];
  }
  return out as CodexUpsertOp;
}

/** node, doc — anything that must resolve before an op counts as valid. */
function existingNodeIds(snapshot: ValidationSnapshot): Set<string> {
  return new Set(snapshot.manifest.tree.map((n) => n.id));
}

function existingCodexIds(snapshot: ValidationSnapshot): Set<string> {
  return new Set((snapshot.manifest.codex ?? []).map((e) => e.id));
}

/** agent-harness §3 row 5: an invalid status/label "lists vocabulary". */
function vocabularyHint(kind: 'status' | 'label', valid: readonly string[]): string {
  return valid.length === 0
    ? `this project defines no ${kind} vocabulary yet — add one in Settings, or omit ${kind}`
    : `valid ${kind} ids: ${valid.join(', ')}`;
}

/**
 * The resulting keyword list, deduped case-insensitively (Scrivener-style free
 * tags, project-format §2). `keywords_remove` of something absent is **not** an
 * error: agent-harness §3 calls `meta.set` "idempotent by design".
 */
function resultingKeywords(node: ValidationNode, patch: MetaPatch): string[] {
  const removed = new Set((patch.keywords_remove ?? []).map((k) => k.toLowerCase()));
  const kept = node.keywords.filter((k) => !removed.has(k.toLowerCase()));
  const seen = new Set(kept.map((k) => k.toLowerCase()));
  for (const keyword of patch.keywords_add ?? []) {
    const key = keyword.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      kept.push(keyword);
    }
  }
  return kept;
}

function checkKeywordPatch(node: ValidationNode, patch: MetaPatch): Result<MetaPatch, CommandError> {
  const add = requireStringArray({ keywords_add: patch.keywords_add ?? [] }, 'keywords_add');
  if (!add.ok) return add;
  const remove = requireStringArray({ keywords_remove: patch.keywords_remove ?? [] }, 'keywords_remove');
  if (!remove.ok) return remove;

  for (const [i, keyword] of add.value.entries()) {
    if ([...keyword].length > KEYWORD_CHARS_MAX) {
      return limitExceeded(
        `params.patch.keywords_add[${i}] is ${[...keyword].length} characters, limit ${KEYWORD_CHARS_MAX}`,
        `shorten the keyword to ${KEYWORD_CHARS_MAX} characters`,
        `patch.keywords_add[${i}]`,
      );
    }
  }
  const resulting = resultingKeywords(node, patch);
  if (resulting.length > KEYWORDS_MAX) {
    return limitExceeded(
      `node "${node.id}" would hold ${resulting.length} keywords, limit ${KEYWORDS_MAX}`,
      `remove ${resulting.length - KEYWORDS_MAX} keyword(s) first, or send them as a second call`,
      'patch.keywords_add',
    );
  }
  return ok(patch);
}

/** Resolve a batch's node-id lists (attachTo / detachFrom) against the tree. */
function checkNodeIdList(
  snapshot: ValidationSnapshot,
  ids: string[],
  failures: PerOpFailure[],
  target: string,
): void {
  const known = existingNodeIds(snapshot);
  for (const id of ids) {
    if (!known.has(id)) {
      failures.push(toPerOpFailure(target, notFoundError(`no node with id "${id}"`, HINT_READ_TREE, id)));
    }
  }
}

/* ------------------------------------------------------------------ *
 * §9 — binder
 * ------------------------------------------------------------------ */

/**
 * A storyboard folder: a folder marked `kind: 'storyboard'`, which holds shots (storyboard.md §2.1). The placement rule
 * is the same in both directions and both binder commands check it: a shot sits in one, and one takes nothing else. A
 * scene left in a board is listed in the binder and never drawn on it, because the board draws only its shots.
 */
function isStoryboardFolder(node: ValidationNode): boolean {
  return node.type === 'folder' && node.kind === 'storyboard';
}

export const binderCreate: CommandDescriptor<BinderCreateParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('binder.create', params);
    if (!p.ok) return p;
    const parent = requireNode(snapshot, p.value, 'parentId');
    if (!parent.ok) return parent;
    // The tree root is the project, not a node in the view (ui-modules §2.1): a child placed directly under it is a
    // node the binder can never show, so it is refused here rather than created invisible (gap root-parent-invisible-nodes).
    if (parent.value.id === 'root') {
      return invalid(
        'the project root is not a place for a node: the binder shows only the manuscript and research, so a node made here would never appear',
        'create the node under "manuscript" or "research", or under a folder inside one of them',
        'parentId',
      );
    }
    if (!isContainer(parent.value)) {
      return invalid(
        `parent "${parent.value.id}" is a ${parent.value.type} and cannot hold children`,
        'only folders hold children — use binder.create with a folder parentId',
        'parentId',
      );
    }
    const type = requireString(p.value, 'type');
    if (!type.ok) return type;
    if (!(BINDER_CREATE_TYPES as readonly string[]).includes(type.value)) {
      return invalid(
        `params.type must be "folder", "document", "shot" or "dialogue", got "${type.value}"`,
        'folder and document are the prose types; shot and dialogue are the media-track types (storyboard.md, dialogue-narrative.md)',
        'type',
      );
    }
    const kind = optionalNonBlankString(p.value, 'kind', {
      blankHint: 'omit kind for a plain node of this type',
    });
    if (!kind.ok) return kind;
    const paired = pairCreateKind(type.value, kind.value);
    if (!paired.ok) return invalid(paired.message, paired.hint, 'kind');
    // A shot is a card in a storyboard, and only a storyboard folder holds one (storyboard.md §2.1).
    if (type.value === 'shot' && !isStoryboardFolder(parent.value)) {
      return invalid(
        `a shot must sit in a storyboard folder, and "${parent.value.id}" is not one`,
        'create a storyboard folder first (binder.create with type "folder" and kind "storyboard"), and create the shot inside it',
        'parentId',
      );
    }
    // The other direction: a storyboard folder holds shots and nothing else, so a scene, folder or dialogue is refused in one.
    if (type.value !== 'shot' && isStoryboardFolder(parent.value)) {
      return invalid(
        `"${parent.value.id}" is a storyboard, and a storyboard holds only shots, so a ${type.value} cannot be made in it`,
        'make the node beside the storyboard, under the same parent, and keep the storyboard for its shots',
        'parentId',
      );
    }
    // The chapter rule: a manuscript child is a chapter, so a new document
    // or dialogue is not made directly under the manuscript. The sentence is the binder's own (binder-model.ts `dropRefusalText`).
    // Only a new one is refused: a chapterless document an older project holds still loads, and moves, since an undo of its move into a
    // chapter must be able to put it back.
    if (parent.value.id === MANUSCRIPT_ID && (type.value === 'document' || type.value === 'dialogue')) {
      return invalid(
        type.value === 'document'
          ? CHAPTERLESS_DOCUMENT_REFUSAL
          : 'A dialogue goes inside a chapter, not directly under the manuscript.',
        'create a chapter first (binder.create with type "folder" under "manuscript"), then create it inside that chapter',
        'parentId',
      );
    }
    const title = requireNonBlankString(p.value, 'title');
    if (!title.ok) return title;
    return ok({
      parentId: parent.value.id,
      type: type.value as BinderCreateParams['type'],
      title: title.value,
      ...(paired.kind === undefined ? {} : { kind: paired.kind }),
    });
  },
};

/** The manuscript root's fixed id (project-format §2). */
const MANUSCRIPT_ID = 'manuscript';

/**
 * The refusal of a new document directly under the manuscript, in the binder's words (apps/desktop binder-model.ts `dropRefusalText`
 * `chapterless`), so the bus, the binder's buttons and a drop all say the same sentence.
 */
export const CHAPTERLESS_DOCUMENT_REFUSAL = 'A document goes inside a chapter, not directly under the manuscript.';

/** The node types `binder.create` takes: the two prose types, and the two media types (screenplay, branching dialogue, storyboard). */
const BINDER_CREATE_TYPES = ['folder', 'document', 'shot', 'dialogue'] as const;

/**
 * The kind a create carries, paired with its type. A dialogue container always carries `branching` (its graph-view
 * marker, dialogue-narrative.md §2.1), so an omitted kind is filled in rather than left for the store to guess.
 */
function pairCreateKind(
  type: string,
  kind: string | undefined,
): { ok: true; kind?: 'screenplay' | 'storyboard' | 'branching' } | { ok: false; message: string; hint: string } {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    folder: ['storyboard'],
    document: ['screenplay'],
    dialogue: ['branching'],
    shot: [],
  };
  const choices = allowed[type] ?? [];
  if (kind === undefined) {
    return type === 'dialogue' ? { ok: true, kind: 'branching' } : { ok: true };
  }
  if (!choices.includes(kind)) {
    return {
      ok: false,
      message: `kind "${kind}" does not go with type "${type}"`,
      hint:
        choices.length === 0
          ? 'a shot takes no kind — its type is its kind; omit kind'
          : `a ${type} takes ${choices.map((c) => `"${c}"`).join(' or ')}, or no kind at all`,
    };
  }
  return { ok: true, kind: kind as 'screenplay' | 'storyboard' | 'branching' };
}

export const binderMove: CommandDescriptor<BinderMoveParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('binder.move', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    // §9: "manuscript-root invariant" — the binder's fixed tier does not move.
    if (isFixedRootId(node.value.id)) {
      return invalid(
        `"${node.value.id}" is a fixed root and cannot be moved (agent-harness §3: "manuscript stays root")`,
        'move the nodes inside the fixed roots instead — the root, manuscript and research tier is reserved',
        'nodeId',
      );
    }
    const parent = requireNode(snapshot, p.value, 'newParentId');
    if (!parent.ok) return parent;
    // The same refusal binder.create gives: a node moved under the root is one the binder never shows.
    if (parent.value.id === 'root') {
      return invalid(
        'the project root is not a place for a node: the binder shows only the manuscript and research, so a node moved here would vanish from view',
        'move the node under "manuscript" or "research", or under a folder inside one of them',
        'newParentId',
      );
    }
    if (!isContainer(parent.value)) {
      return invalid(
        `new parent "${parent.value.id}" is a ${parent.value.type} and cannot hold children`,
        'move into a folder or the manuscript, not into a document',
        'newParentId',
      );
    }
    // The placement rules binder.create checks, applied to a move (storyboard.md §2.1): a shot moves into a storyboard
    // folder and nowhere else, and a storyboard folder takes shots only. A reorder inside the board passes both.
    if (node.value.type === 'shot' && !isStoryboardFolder(parent.value)) {
      return invalid(
        `a shot must sit in a storyboard folder, and "${parent.value.id}" is not one`,
        'move the shot into a storyboard folder, or leave it where it is',
        'newParentId',
      );
    }
    if (node.value.type !== 'shot' && isStoryboardFolder(parent.value)) {
      return invalid(
        `"${parent.value.id}" is a storyboard, and a storyboard holds only shots, so "${node.value.id}" (a ${node.value.type}) cannot move into it`,
        'move it beside the storyboard instead, and keep the storyboard for its shots',
        'newParentId',
      );
    }
    // The index counts the new parent's children *without* the moved node, the
    // count the store's `siblingOrderAt` takes. A position past the last sibling
    // is not refused: the store appends there (§2's gap encoding), so the
    // position is resolved here against the same sibling count and the apply is
    // handed the position the node will land at. The result and the digest then
    // name where the node went, instead of the position that was asked for.
    const siblings = snapshot.manifest.tree.filter(
      (sibling) => sibling.parentId === parent.value.id && sibling.id !== node.value.id,
    );
    const index = requireInteger(p.value, 'index', { min: 0 });
    if (!index.ok) return index;
    const position = Math.min(index.value, siblings.length);
    // §9: "Cycle check ... in validate". A move into the node itself or into any
    // of its own descendants would detach the subtree from the tree.
    if (isDescendantOf(snapshot, parent.value.id, node.value.id)) {
      return cycleError(
        `cannot move "${node.value.id}" into "${parent.value.id}", which is itself or a descendant of it`,
        'move the node to a sibling branch, or move the descendant out first',
        'newParentId',
      );
    }
    return ok({ nodeId: node.value.id, newParentId: parent.value.id, index: position });
  },
};

export const binderRename: CommandDescriptor<BinderRenameParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  // The two section roots cannot be renamed: ui-modules §2.3 says "Manuscript/research roots cannot be moved, renamed,
  // or deleted", and the binder shows them under those names. The bus refuses it too, so an agent's restructure rename
  // (agent-harness §9) cannot give a section a name the writer never sees (gap fixed-section-roots-renamable-on-bus).
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('binder.rename', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    if (node.value.id === 'manuscript' || node.value.id === 'research') {
      return invalid(
        `"${node.value.id}" is a section root and cannot be renamed (ui-modules §2.3)`,
        'rename the chapters, scenes or notes inside it instead; the two section names are fixed',
        'nodeId',
      );
    }
    const title = requireNonBlankString(p.value, 'title');
    if (!title.ok) return title;
    return ok({ nodeId: node.value.id, title: title.value });
  },
};

export const binderSetMeta: CommandDescriptor<BinderSetMetaParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  // §9: "Vocabulary-validated."
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('binder.setMeta', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    const patch = p.value['patch'];
    if (!isRecord(patch)) {
      return invalid(
        `params.patch must be an object, got ${patch === undefined ? 'nothing' : typeof patch}`,
        `pass a patch with any of: ${PATCH_KEYS.join(', ')}`,
        'patch',
      );
    }
    for (const key of Object.keys(patch)) {
      if (!(PATCH_KEYS as string[]).includes(key)) {
        return invalid(
          `params.patch.${key} is not a patch field`,
          `a patch carries only: ${PATCH_KEYS.join(', ')}`,
          `patch.${key}`,
        );
      }
    }
    const status = optionalNullableString(patch, 'status');
    if (!status.ok) return status;
    if (status.value !== undefined && status.value !== null) {
      const valid = snapshot.manifest.vocabulary.statuses.map((s) => s.id);
      if (!valid.includes(status.value)) {
        return invalid(
          `"${status.value}" is not a status in this project's vocabulary`,
          vocabularyHint('status', valid),
          'patch.status',
        );
      }
    }
    const label = optionalNullableString(patch, 'label');
    if (!label.ok) return label;
    if (label.value !== undefined && label.value !== null) {
      const valid = snapshot.manifest.vocabulary.labels.map((l) => l.id);
      if (!valid.includes(label.value)) {
        return invalid(
          `"${label.value}" is not a label in this project's vocabulary`,
          vocabularyHint('label', valid),
          'patch.label',
        );
      }
    }
    const typed: MetaPatch = {};
    if (status.value !== undefined) typed.status = status.value;
    if (label.value !== undefined) typed.label = label.value;
    if (patch['keywords_add'] !== undefined) typed.keywords_add = patch['keywords_add'] as string[];
    if (patch['keywords_remove'] !== undefined) {
      typed.keywords_remove = patch['keywords_remove'] as string[];
    }
    const keywords = checkKeywordPatch(node.value, typed);
    if (!keywords.ok) return keywords;
    // A patch with no field in it is not an idempotent no-op — it asks for
    // nothing at all, and `project.setMetadata` refuses exactly that shape.
    // (`dialogue.setMeta` counts the raw keys instead, so a patch of
    // `{ speaker: undefined }` passes there and normalizes to an empty patch —
    // the two checks are not the same check.) What the refusal enforces is the
    // shape, not the effect: a patch whose fields all match what the node
    // already holds stays accepted,
    // because agent-harness §3 makes meta.set "idempotent by design" and
    // `requireStringArray` keeps `keywords_add: []` a legitimate "nothing to
    // do" payload. Such a dispatch stamps nothing and mints no restore entry
    // (the store's `binderSetMeta` writes `updatedAt` only for a field it
    // actually changed), so neither the node's stamp nor the audit row claims a
    // change that did not happen — the row's own digest says "left ...
    // unchanged".
    if (Object.keys(typed).length === 0) {
      return changesNothing('the patch names no field to write, so it asks for nothing to change', `name at least one of: ${PATCH_KEYS.join(', ')}`, 'patch');
    }
    return ok({ nodeId: node.value.id, patch: typed });
  },
};

export const binderSetSynopsis: CommandDescriptor<BinderSetSynopsisParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('binder.setSynopsis', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    const synopsis = requireString(p.value, 'synopsis', SYNOPSIS_MAX);
    if (!synopsis.ok) return synopsis;
    return ok({ nodeId: node.value.id, synopsis: synopsis.value });
  },
};

/* ------------------------------------------------------------------ *
 * §9 — notes
 * ------------------------------------------------------------------ */

export const notesSet: CommandDescriptor<NotesSetParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('notes.set', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    const notes = requireString(p.value, 'notes', NOTES_MAX);
    if (!notes.ok) return notes;
    return ok({ nodeId: node.value.id, notes: notes.value });
  },
};

export const notesAppend: CommandDescriptor<NotesAppendParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('notes.append', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    // agent-harness §3 row 6: "note overflow → suggests `notes.replace`
    // (confirm-class)" — the overflow refusal is where that suggestion lives.
    const text = requireString(p.value, 'text', NOTES_APPEND_MAX);
    if (!text.ok) {
      if (text.error.code === 'limit-exceeded') {
        return err({ ...text.error, correctiveHint: 'use notes.replace (write-confirm) for content over 2k characters' });
      }
      return text;
    }
    const divider = optionalBoolean(p.value, 'divider');
    if (!divider.ok) return divider;
    return ok({
      nodeId: node.value.id,
      text: text.value,
      ...(divider.value === undefined ? {} : { divider: divider.value }),
    });
  },
};

/* ------------------------------------------------------------------ *
 * §9 — body writes
 * ------------------------------------------------------------------ */

/**
 * A node that holds a body: a document, or a dialogue container whose body is its Ink (dialogue-narrative.md §2.1).
 * `doc.write` and the autosave path write both, so both pass here.
 */
function requireDocumentNode(
  snapshot: ValidationSnapshot,
  p: Record<string, unknown>,
  key: string,
): Result<ValidationNode, CommandError> {
  const node = requireNode(snapshot, p, key);
  if (!node.ok) return node;
  if (node.value.type !== 'document' && node.value.type !== 'dialogue') {
    return invalid(
      `"${node.value.id}" is a ${node.value.type}, not a document — only document and dialogue nodes have a body`,
      'use binder.create with type "document" or "dialogue" first',
      key,
    );
  }
  return node;
}

/**
 * The project-relative path of a body node's file, for its kind.
 *
 * **The store's rule, restated**: `.ink` for a dialogue container, `.fountain`
 * for a screenplay document, `.md` for a prose document, all under `docs/`
 * (`@caotang/store`'s `bodyExtensionOf` and `bodyFile`). The bus cannot import
 * the store — the dependency runs store → bus — so the rule is copied here, and
 * `packages/store/test/bus-body-file.test.ts` pins the two together: a hint that
 * names a file the loader never writes sends an agent to repair a file that does
 * not exist.
 */
function bodyFilePath(node: ValidationNode): string {
  const extension = node.type === 'dialogue' ? 'ink' : node.kind === 'screenplay' ? 'fountain' : 'md';
  return `docs/${node.id}.${extension}`;
}

/**
 * The loaded body length an offset must fall inside, or a refusal.
 *
 * `because` names what the caller needed the body for: the editor commands need
 * it to bound their offsets, and `doc.write` needs it to know that the document
 * it is about to replace is one the loader could read at all — so the refusal
 * says the write, not offsets it never had.
 *
 * **The hint names the file, because the file is the surface that fixes this.**
 * The id already resolved in `requireDocumentNode` by the time this runs, so
 * §7's own rule — a `correctiveHint` names the surface that fixes the refusal —
 * cannot be satisfied by "list valid ids": a body is missing when the document's
 * file is not text the loader could read, and no id the caller passes changes
 * that.
 *
 * **The file is the node's own, for its kind.** A prose document's body is
 * `docs/<id>.md`, a screenplay's is `docs/<id>.fountain` and a dialogue
 * container's is `docs/<id>.ink` — so a hint that named `<id>.md` for all three
 * would send an agent to a file that does not hold the body. The message does
 * not name a *cause*: a body can be missing because the file is not UTF-8 text,
 * and because the runtime rehydrator had no body row for an id that resolved,
 * and the bus cannot tell the two apart.
 */
function requireLoadedBody(
  snapshot: ValidationSnapshot,
  node: ValidationNode,
  because = 'so its offsets cannot be validated',
): Result<number, CommandError> {
  const length = documentLength(snapshot, node.id);
  if (length === undefined) {
    return notFound(
      `document "${node.id}" has no body loaded — ${because}`,
      `the surface to fix is the document's own file, not this command's params: the body of "${node.id}" lives in "${bodyFilePath(node)}", and the loader could not read it as text; make sure that file holds UTF-8 text, then reload the project. The id itself resolved, so binder.read_tree cannot help here`,
      node.id,
    );
  }
  return ok(length);
}

/**
 * Parse §6's `expectedRevision` — **and nothing else**.
 *
 * The revision **comparison** lives in `pipeline.ts`, not here, and the pin in
 * `test/validate.test.ts` says `validate` does **not** compare — so this
 * helper's contract is: it parses, the pipeline compares.
 *
 * Keeping the parse here and the compare there is what makes the rule single.
 * A check inside `validate` would be a second implementation of "which commands
 * guard a revision", and `validate` is pure: it cannot express "refuse because
 * the world moved" as anything other than a second read of a snapshot it was
 * given before the caller could act on it.
 */
function expectedRevision(p: Record<string, unknown>): Result<number | undefined, CommandError> {
  if (p['expectedRevision'] === undefined) return ok(undefined);
  return requireInteger(p, 'expectedRevision', { min: 0 });
}

export const docWrite: CommandDescriptor<DocWriteParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  // §6: the one document-writing row of §9 that an agent may emit directly.
  guardsRevision: true,
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('doc.write', params);
    if (!p.ok) return p;
    const doc = requireDocumentNode(snapshot, p.value, 'docId');
    if (!doc.ok) return doc;
    // The params are checked before the loaded-body state check: a write that is
    // both malformed and to an unloaded document reports the defect its caller
    // must fix in params, rather than a state refusal that hides it. The
    // document's *existence* is checked before both — an id no node holds is a
    // state refusal whatever the body says — so a malformed write to an unknown
    // id still reports the unknown id first.
    const body = requireString(p.value, 'body');
    if (!body.ok) return body;
    const revision = expectedRevision(p.value);
    if (!revision.ok) return revision;
    // The same check the two editor commands make: a document whose file is not
    // UTF-8 opens with no body record while its node stays in the tree, and a
    // write to it would reach the apply and fail there as a defect rather than
    // as the refusal the loader already promised.
    const loaded = requireLoadedBody(snapshot, doc.value, 'so it cannot be written to');
    if (!loaded.ok) return loaded;
    return ok({
      docId: doc.value.id,
      body: body.value,
      ...(revision.value === undefined ? {} : { expectedRevision: revision.value }),
    });
  },
};

export const editorInsert: CommandDescriptor<EditorInsertParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'compensable',
  guardsRevision: true,
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('editor.insert', params);
    if (!p.ok) return p;
    const doc = requireDocumentNode(snapshot, p.value, 'docId');
    if (!doc.ok) return doc;
    const length = requireLoadedBody(snapshot, doc.value);
    if (!length.ok) return length;
    const offset = requireInteger(p.value, 'offset', {
      min: 0,
      max: length.value,
      maxHint: rangeHint(length.value),
    });
    if (!offset.ok) return offset;
    const text = requireString(p.value, 'text');
    if (!text.ok) return text;
    const revision = expectedRevision(p.value);
    if (!revision.ok) return revision;
    return ok({
      docId: doc.value.id,
      offset: offset.value,
      text: text.value,
      ...(revision.value === undefined ? {} : { expectedRevision: revision.value }),
    });
  },
};

export const editorReplaceRange: CommandDescriptor<EditorReplaceRangeParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'compensable',
  guardsRevision: true,
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('editor.replaceRange', params);
    if (!p.ok) return p;
    const doc = requireDocumentNode(snapshot, p.value, 'docId');
    if (!doc.ok) return doc;
    const length = requireLoadedBody(snapshot, doc.value);
    if (!length.ok) return length;
    const range = p.value['range'];
    if (!isRecord(range)) {
      return invalid(
        `params.range must be an object with from and to, got ${range === undefined ? 'nothing' : typeof range}`,
        'pass range as { from, to } in body coordinates (0-indexed, from ≤ to)',
        'range',
      );
    }
    const from = requireInteger(range, 'from', { min: 0, max: length.value, maxHint: rangeHint(length.value) });
    if (!from.ok) return from;
    const to = requireInteger(range, 'to', { min: 0, max: length.value, maxHint: rangeHint(length.value) });
    if (!to.ok) return to;
    if (from.value > to.value) {
      return invalid(
        `params.range.from (${from.value}) is past params.range.to (${to.value})`,
        'ranges run forward: from ≤ to',
        'range',
      );
    }
    const text = requireString(p.value, 'text');
    if (!text.ok) return text;
    const revision = expectedRevision(p.value);
    if (!revision.ok) return revision;
    return ok({
      docId: doc.value.id,
      range: { from: from.value, to: to.value },
      text: text.value,
      ...(revision.value === undefined ? {} : { expectedRevision: revision.value }),
    });
  },
};

/* ------------------------------------------------------------------ *
 * §9 — codex
 * ------------------------------------------------------------------ */

/**
 * One op of a `codex.write` batch. codex.md §7: the batch is "validated as a
 * whole **before** execution (all ids resolve, no case-insensitive name
 * collisions within batch or project, type enum valid)", and §7's error rule
 * is "Errors name the next corrective tool (unknown id → 'use `codex.read` with
 * query'; collision → names the existing entry)".
 *
 * The description limit is codex.md §2's **field contract** ("≤ 2000 chars"),
 * enforced here as a hard refusal. §7 also says an over-long description gets a
 * truncation "proposed in the card" — that rule is about the *card*, and this
 * slice's contract (§2's "a command that passes validation cannot fail
 * mid-apply") is that the value either validates or is refused, never silently
 * trimmed..
 */
function validateCodexOp(
  snapshot: ValidationSnapshot,
  op: unknown,
  target: string,
  failures: PerOpFailure[],
  projectNames: Map<string, { name: string; id: string }>,
): void {
  const push = <T>(refusal: Result<T, CommandError>): void => {
    if (!refusal.ok) failures.push(toPerOpFailure(target, refusal.error));
  };

  if (!isRecord(op)) {
    push(invalid(`entry must be an object, got ${op === undefined ? 'nothing' : typeof op}`));
    return;
  }
  // The op's closed key set, refused rather than narrowed away. Checked
  // **first**, before `action`, for the reason `requireDeclaredParams` documents:
  // an op carrying a misspelled key is told the misspelling, not walked through
  // the field errors of an op that was never valid.
  //
  // **It is a per-op failure, not a top-level refusal**, because codex.md §7
  // validates the batch as a whole and lists failures per-op — so a five-entry
  // batch with one bad key reports that key and the four good ops are named in
  // the same round trip, rather than the model discovering them one call at a
  // time.
  const undeclared = Object.keys(op).filter((key) => !(CODEX_OP_KEYS as readonly string[]).includes(key));
  if (undeclared.length > 0) {
    // **Pushed directly, not through `push`.** `push` stamps every failure with
    // the op index alone (`entries[0]`), which is right for a field failure and
    // wrong here: two undeclared keys on the same op are the same op, so the
    // target has to name the key to stay distinguishable — and it is also the
    // only way a caller learns *which* key on that op to delete.
    //
    // Note what this costs: `batchRefusal`'s own `correctiveHint` is generic on
    // purpose ("fix every listed op and resend the whole batch"), so the
    // specific one has to live on the per-op failure or it never reaches the
    // model. That is the shape §2 asks for, not a workaround.
    const r = invalid(
      `${undeclared.map((key) => `"${key}"`).join(', ')} ${undeclared.length === 1 ? 'is' : 'are'} not ${undeclared.length === 1 ? 'a field' : 'fields'} a codex.upsert entry carries`,
      // `origin` is named explicitly rather than lumped in with the rest: an
      // agent reaching for it is trying to stamp provenance, and codex.md §2 makes that
      // harness-owned. Saying so is the difference between a correction and a
      // retry.
      undeclared.includes('origin')
        ? `origin is set by the harness from who issued the command, not by the caller — an entry's fields are: ${CODEX_OP_KEYS.join(', ')}`
        : `an entry carries only: ${CODEX_OP_KEYS.join(', ')}`,
      undeclared[0],
    );
    if (!r.ok) failures.push(toPerOpFailure(`${target}.${undeclared[0]}`, r.error));
    return;
  }
  const action = op['action'];
  if (action !== 'create' && action !== 'update') {
    push(invalid(`action must be "create" or "update", got ${showValue(action)}`, 'pass action: "create" for a new entry, "update" with its id for an existing one', 'action'));
    return;
  }
  const id = op['id'];
  if (action === 'update') {
    if (typeof id !== 'string' || id.length === 0) {
      push(invalid('an update needs the id of the entry it updates', 'use codex.read with a query to find the id', 'id'));
      return;
    }
    if (!existingCodexIds(snapshot).has(id)) {
      push(notFound(`no codex entry with id "${id}"`, 'use codex.read with a query to find the entry', id));
      return;
    }
  } else if (id !== undefined) {
    // A create mints its own id (the store does, from the same generator as
    // every node and codex id). An id the caller sends on a create was accepted
    // and then dropped, which is the silent drop the closed params surface refuses for every other
    // field; so it is refused, and the message says which of the two cases it is.
    const taken = typeof id === 'string' ? snapshot.manifest.codex?.find((entry) => entry.id === id) : undefined;
    push(taken !== undefined
      ? invalid(
        `id "${id}" is already taken by "${taken.name}" — a create cannot reuse an existing entry's id`,
        `to change "${taken.name}", send action "update" with its id; a create takes no id`,
        'id',
      )
      : invalid(
        'a create mints its own id, so an id on a create is refused rather than dropped',
        'drop the id, or send action "update" with it to change an existing entry',
        'id',
      ));
  }

  const name = op['name'];
  if (name === undefined && action === 'create') {
    // codex.md §2: "Required, non-empty after trim." A nameless create is not
    // given an apply-side default; the rule is the validator's, and it is here.
    push(invalid(
      'name is required on create — codex.md §2 requires a non-empty name, and an entry without one cannot be found',
      'pass a name for the new entry',
      'name',
    ));
  }
  if (name !== undefined) {
    if (typeof name !== 'string') {
      push(invalid(`name must be a string, got ${typeof name}`));
    } else if (name.trim().length === 0) {
      // codex.md §2, verbatim: "**Required, non-empty after trim.**" Without this branch the
      // op validator checked the length ceiling and the case-insensitive
      // collision map but never this half, so an entry could be created with a
      // blank name and the map would treat it as a name like any other. The
      // per-op failure rather than a throw is §2's "list failures per-op".
      push(invalid(
        'name must not be blank',
        'codex.md §2 requires a non-empty name after trim — an entry is looked up by its name, and a blank one names nothing',
        'name',
      ));
    } else if ([...name].length > CODEX_NAME_MAX) {
      push(limitExceeded(`name is ${[...name].length} characters, limit ${CODEX_NAME_MAX}`, `shorten the name to ${CODEX_NAME_MAX} characters`, 'name'));
    } else {
      const key = name.toLowerCase();
      const existing = projectNames.get(key);
      if (existing !== undefined && existing.id !== id) {
        // codex.md §7: "collision → names the existing entry". Both the name and
        // the id: the model has to pick a new name, and the id is what makes the
        // collision unambiguous when two entries differ only in case.
        push(invalid(
          `name "${name}" collides with the existing entry "${existing.name}" (${existing.id}), case-insensitively`,
          'pick a name that is unique across the project — codex entry names are case-insensitively unique',
          'name',
        ));
      } else {
        projectNames.set(key, { name: existing?.name ?? name, id: typeof id === 'string' ? id : `pending:${target}` });
      }
    }
  }

  const aliases = op['aliases'];
  if (aliases !== undefined) {
    const list = requireStringArray(op, 'aliases', { maxItems: CODEX_ALIASES_MAX });
    if (!list.ok) {
      push(list);
    } else {
      for (const [i, alias] of list.value.entries()) {
        const length = [...alias].length;
        if (length < 1 || length > CODEX_ALIAS_CHARS_MAX) {
          push(invalid(`aliases[${i}] is ${length} characters, must be 1–${CODEX_ALIAS_CHARS_MAX}`, undefined, `aliases[${i}]`));
        }
      }
    }
  }

  const type = op['type'];
  if (type !== undefined && !CODEX_TYPES.includes(type as string)) {
    push(invalid(`type must be one of ${CODEX_TYPES.join(', ')}, got ${showValue(type)}`, 'v0.1 codex types are a closed enum — custom types are v0.2', 'type'));
  }

  const policy = op['includePolicy'];
  if (policy !== undefined && !CODEX_POLICIES.includes(policy as string)) {
    push(invalid(`includePolicy must be one of ${CODEX_POLICIES.join(', ')}, got ${showValue(policy)}`, undefined, 'includePolicy'));
  }

  const description = op['description'];
  if (description !== undefined) {
    if (typeof description !== 'string') {
      push(invalid(`description must be a string, got ${typeof description}`));
    } else if ([...description].length > CODEX_DESCRIPTION_MAX) {
      push(limitExceeded(`description is ${[...description].length} characters, limit ${CODEX_DESCRIPTION_MAX}`, `shorten the description to ${CODEX_DESCRIPTION_MAX} characters`, 'description'));
    }
  }

  const keywords = op['keywords'];
  if (keywords !== undefined) {
    const list = requireStringArray(op, 'keywords', { maxItems: KEYWORDS_MAX });
    if (!list.ok) {
      push(list);
    } else {
      for (const [i, keyword] of list.value.entries()) {
        if ([...keyword].length > KEYWORD_CHARS_MAX) {
          push(invalid(`keywords[${i}] is ${[...keyword].length} characters, limit ${KEYWORD_CHARS_MAX}`, undefined, `keywords[${i}]`));
        }
      }
    }
  }

  // codex.md §2: at most CODEX_SOURCES_MAX citations, each a real document with a
  // verbatim quote of ≤ 300 chars and in-range offsets. An update's citations are
  // appended to the entry's (an agent update appends a source), so the cap is
  // checked against what the entry already holds.
  const sources = op['sources'];
  if (sources !== undefined) {
    const existing = action === 'update' && typeof id === 'string'
      ? (snapshot.manifest.codex ?? []).find((entry) => entry.id === id)
      : undefined;
    const held = existing?.sources?.length ?? 0;
    if (!Array.isArray(sources)) {
      push(invalid(`sources must be an array of citations, got ${showValue(sources)}`, undefined, 'sources'));
    } else if (sources.length > CODEX_SOURCES_MAX || (action === 'update' && held + sources.length > CODEX_SOURCES_MAX)) {
      push(limitExceeded(
        `sources would hold ${action === 'update' ? held + sources.length : sources.length} citations, limit ${CODEX_SOURCES_MAX}`,
        `keep at most ${CODEX_SOURCES_MAX} citations per entry — cite the passages that matter most`,
        'sources',
      ));
    } else {
      for (const [i, citation] of sources.entries()) {
        const bad = citationProblem(snapshot, citation);
        if (bad !== undefined) push(invalid(`sources[${i}] ${bad}`, undefined, `sources[${i}]`));
      }
    }
  }

  // video-prompt-pack.md §3, A5: a visual reference is an asset id, as an import returns one. The bus cannot see the folder, so an
  // id that names no file is kept (the pack names it as missing, as it does for a shot's reference); only the shape and the count
  // are checked here. A repeated id is one reference: the bus checks the list as it was sent, repeats included, and the store keeps
  // each id once when it writes the entry (commands.ts). The harness's preview drops the repeats too, so the card shows what is saved.
  const visualRefs = op['visualRefs'];
  if (visualRefs !== undefined) {
    const list = requireStringArray(op, 'visualRefs', { maxItems: CODEX_VISUAL_REFS_MAX });
    if (!list.ok) {
      push(list);
    } else {
      for (const [i, ref] of list.value.entries()) {
        if (!VISUAL_REF_PATTERN.test(ref)) {
          push(invalid(
            `visualRefs[${i}] "${ref}" is not an asset id`,
            'a visual reference is an image in this project, named by its id (a_ and ten characters); pick the image in the codex panel',
            `visualRefs[${i}]`,
          ));
        }
      }
    }
  }

  const caseSensitive = op['caseSensitive'];
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
    push(invalid(`caseSensitive must be a boolean, got ${typeof caseSensitive}`, undefined, 'caseSensitive'));
  }

  // codex.md §2: exclude ≤ 20 phrases, each 1–64 chars — the same shape as
  // aliases, and held to it here rather than only on load (see the manifest
  // validator's exclude check, which this is the command-side twin of).
  const exclude = op['exclude'];
  if (exclude !== undefined) {
    const list = requireStringArray(op, 'exclude', { maxItems: CODEX_EXCLUDE_MAX });
    if (!list.ok) {
      push(list);
    } else {
      for (const [i, phrase] of list.value.entries()) {
        const length = [...phrase].length;
        if (length < 1 || length > CODEX_EXCLUDE_CHARS_MAX) {
          push(invalid(`exclude[${i}] is ${length} characters, must be 1–${CODEX_EXCLUDE_CHARS_MAX}`, undefined, `exclude[${i}]`));
        }
      }
    }
  }

  for (const key of ['attachTo', 'detachFrom'] as const) {
    const list = op[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      push(invalid(`${key} must be an array of node ids, got ${typeof list}`, undefined, key));
      continue;
    }
    const strings = requireStringArray(op, key);
    if (!strings.ok) {
      push(strings);
      continue;
    }
    checkNodeIdList(snapshot, strings.value, failures, target);
  }
}

/**
 * The first way a provenance citation breaks codex.md §2's `EntrySource` contract,
 * or `undefined` when it holds. A citation names a real document, quotes it
 * verbatim within the 300-character limit, and carries offsets that run forward
 * and point at that quote in the document's current body.
 */
function citationProblem(snapshot: ValidationSnapshot, citation: unknown): string | undefined {
  if (!isRecord(citation)) return `must be an object, got ${showValue(citation)}`;
  const { docId, quote, from, to, extractedAt } = citation;
  if (typeof docId !== 'string' || docId.length === 0) return 'needs a docId, the id of the manuscript document it quotes';
  if (!snapshot.documents.has(docId)) return `names "${docId}", which is not a document in this project`;
  if (typeof quote !== 'string') return 'needs a quote, a verbatim slice of that document';
  if ([...quote].length > CODEX_SOURCE_QUOTE_MAX) {
    return `quote is ${[...quote].length} characters, limit ${CODEX_SOURCE_QUOTE_MAX}`;
  }
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
    return `from must be a whole offset ≥ 0, got ${showValue(from)}`;
  }
  if (typeof to !== 'number' || !Number.isInteger(to) || to < from) {
    return `to must be a whole offset ≥ from, got ${showValue(to)}`;
  }
  if (typeof extractedAt !== 'string' || Number.isNaN(Date.parse(extractedAt))) {
    return 'extractedAt must be an ISO-8601 time';
  }
  // codex.md §2 defines `quote` as a verbatim slice of the body projection, and
  // the offsets are in the coordinate system edit-anchors.md §2 names: UTF-16
  // code units into the stored body, the units `String.prototype.slice` uses. A
  // citation that quotes text the document does not hold at its offsets is
  // evidence for nothing, and provenance feeds the canon ranking, so it is refused
  // with the same check an edit anchor gets.
  const body = snapshot.documents.get(docId)?.body ?? '';
  if (body.slice(from, to) !== quote) {
    return (
      `quote is not the text at [${from}, ${to}) of "${docId}" in its current body; ` +
      're-extract the citation from that document (doc.read) and resend it'
    );
  }
  return undefined;
}

export const codexUpsert: CommandDescriptor<CodexUpsertParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('codex.upsert', params);
    if (!p.ok) return p;
    const entries = p.value['entries'];
    if (!Array.isArray(entries)) {
      return invalid(
        `params.entries must be an array, got ${entries === undefined ? 'nothing' : typeof entries}`,
        'pass entries: [{ action, ...fields }]',
        'entries',
      );
    }
    if (entries.length > CODEX_BATCH_MAX) {
      return limitExceeded(
        `params.entries has ${entries.length} ops, limit ${CODEX_BATCH_MAX} per call`,
        `split the batch into calls of at most ${CODEX_BATCH_MAX} entries`,
        'entries',
      );
    }
    // "no case-insensitive name collisions within batch **or project**" — the
    // project's existing names seed the map, so one map catches both.
    const projectNames = new Map<string, { name: string; id: string }>();
    for (const entry of snapshot.manifest.codex ?? []) {
      projectNames.set(entry.name.toLowerCase(), { name: entry.name, id: entry.id });
    }
    const failures: PerOpFailure[] = [];
    for (const [i, op] of entries.entries()) {
      validateCodexOp(snapshot, op, `entries[${i}]`, failures, projectNames);
    }
    if (failures.length > 0) {
      return batchRefusal(failures, 'fix every listed op and resend the whole batch — nothing was written');
    }
    return ok({ entries: entries.filter(isRecord).map(narrowCodexOp) });
  },
};

export const codexAttach: CommandDescriptor<CodexAttachParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('codex.attach', params);
    if (!p.ok) return p;
    const entryId = requireString(p.value, 'entryId');
    if (!entryId.ok) return entryId;
    if (!existingCodexIds(snapshot).has(entryId.value)) {
      return notFound(
        `no codex entry with id "${entryId.value}"`,
        'use codex.read with a query to find the entry',
        'entryId',
      );
    }
    const attachTo = requireStringArray(p.value, 'attachTo');
    if (!attachTo.ok) return attachTo;
    const detachFrom = requireStringArray(p.value, 'detachFrom');
    if (!detachFrom.ok) return detachFrom;
    const known = existingNodeIds(snapshot);
    for (const [i, id] of attachTo.value.entries()) {
      if (!known.has(id)) {
        return notFound(`attachTo[${i}]: no node with id "${id}"`, HINT_READ_TREE, id);
      }
    }
    for (const [i, id] of detachFrom.value.entries()) {
      if (!known.has(id)) {
        return notFound(`detachFrom[${i}]: no node with id "${id}"`, HINT_READ_TREE, id);
      }
    }
    // A node named in **both** lists asks for two contradictory outcomes in one
    // command. Refused here rather than resolved by an apply-side order because
    // §5 makes this command's compensation the *exact* inverse, and an
    // unstated "attach first, detach wins" rule would decide the effect by
    // internal sequence instead of by what the caller wrote. The keyword patch
    // above is not in the same position: its precedence is already fixed, by
    // `resultingKeywords`, which computes the post-patch list to check the
    // keyword limit — so the apply has an order to match instead of one to pick.
    for (const id of attachTo.value) {
      if (detachFrom.value.includes(id)) {
        return invalid(
          `node "${id}" is in both attachTo and detachFrom, which asks for two opposite results`,
          'name a node in attachTo or in detachFrom, not both — attach the nodes you want attached, then detach the ones you do not',
          'attachTo',
        );
      }
    }
    return ok({ entryId: entryId.value, attachTo: attachTo.value, detachFrom: detachFrom.value });
  },
};

/* ------------------------------------------------------------------ *
 * §9 — export, deletion
 * ------------------------------------------------------------------ */

/**
 * The export format list, checked here so an unknown format is refused at
 * `validate`, before any apply is asked to compile it. The bus cannot import the
 * exporter, so this is a copy of the exporter's own `EXPORT_FORMATS` (in
 * packages/exporter/src/types.ts), and the exporter's test
 * (packages/exporter/test/export-formats.test.ts) imports this copy and asserts it
 * equals the exporter's. So every value this list accepts is one the exporter
 * renders. It is the prose formats (md, txt, docx, epub) and the media-track
 * formats the exporter ships (exporter.md §5, one-source compile): the screenplay
 * Fountain and FDX, the dialogue table and compiled Ink, the shot list, the
 * video prompt pack and the coherence report, with the dialogue table and the shot
 * list also as spreadsheets, the screenplay PDF and the storyboard contact sheet.
 * The list says what is compiled, not what is planned.
 */
export const EXPORT_FORMATS = [
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
  // The coherence report. Two names, appended after the ten above (ten + two = twelve).
  'coherence-md',
  'coherence-json',
  // The spreadsheet variants of the dialogue table and the shot list, then the screenplay PDF (screenplay.md §5.3). Appended after the twelve above (fifteen).
  'dialogue-xlsx',
  'shot-list-xlsx',
  'pdf',
  // The storyboard's contact sheet (storyboard.md §6), appended as the sixteenth.
  'contact-sheet-pdf',
] as const;

function exportFormatRefusal(format: string): Result<never, CommandError> | undefined {
  if ((EXPORT_FORMATS as readonly string[]).includes(format)) return undefined;
  // The wording is the exporter's own refusal (packages/exporter/src/errors.ts), so
  // a caller sees the same sentence whichever layer caught the format.
  return invalid(
    `${showValue(format)} is not an export format in this build. The formats are ${EXPORT_FORMATS.join(', ')}.`,
    `pass one of ${EXPORT_FORMATS.join(', ')}`,
    'format',
  );
}

export const exportCompile: CommandDescriptor<ExportCompileParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  // **The whole manuscript** — no scope field is declared,
  // and a scope field the caller passes (`includeRootIds`, `selection`) is
  // **refused**, not dropped as an `ok` carrying `format` alone. A
  // caller reaching for a scope field here is expressing an intent this name
  // cannot mean, and the refusal says so in one round trip instead of compiling
  // the whole manuscript for a request about a part of it — which is the one
  // outcome §9's two-row split exists to prevent.
  // Shape only. exporter.md §2's format enum joins the media track post-v0.1,
  // so the enum is the exporter's — but **"any string" is not the same claim as
  // "any non-blank string"**: `format: ''` and `format: '   '` name no format at
  // all, and the sibling `recipeName` one line below refuses a blank too. No enum
  // choice makes an empty format meaningful.
  // A recipe name is checked here too: a name the project does not hold is not-found at validate, before the exporter
  // would refuse it at apply, so the refusal comes back with the same corrective text as `recipe.delete`'s.
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('export.compile', params);
    if (!p.ok) return p;
    const format = requireNonBlankString(p.value, 'format');
    if (!format.ok) return format;
    const refused = exportFormatRefusal(format.value);
    if (refused !== undefined) return refused;
    const recipeName = optionalNonBlankString(p.value, 'recipeName', {
      blankHint: 'omit it to compile the manuscript as it stands',
    });
    if (!recipeName.ok) return recipeName;
    if (recipeName.value !== undefined) {
      const missing = recipeNameMissing(snapshot, recipeName.value, 'recipeName');
      if (missing !== undefined) return err(missing);
    }
    const templateId = optionalString(p.value, 'templateId');
    if (!templateId.ok) return templateId;
    // A prompt pack is written for one vendor template (exporter.md §5). The bus cannot list the installed templates (the video prompt
    // pack holds them, and the bus imports nothing), and its validation snapshot holds no recipe template, so the harness checks the id
    // against the list, with the recipe's template, before the card. Here only the shape the bus can see is refused: a pack that names
    // neither a template nor a recipe, which the apply would refuse as well.
    if (format.value === 'promptpack' && templateId.value === undefined && recipeName.value === undefined) {
      return invalid(
        'a prompt pack is written for one vendor template, and this compile names none',
        'name the vendor template in templateId, or name a recipe that names one',
        'templateId',
      );
    }
    return ok({
      format: format.value,
      ...(recipeName.value === undefined ? {} : { recipeName: recipeName.value }),
      ...(templateId.value === undefined ? {} : { templateId: templateId.value }),
    });
  },
};

export const exportCompileSelection: CommandDescriptor<ExportCompileSelectionParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  // **A part** — the sibling of `export.compile` above,
  // split by scope so neither call can mean the other.
  // `recipeName` supplies the options a part compiles with, so the dialog's title page, contents and author apply to a
  // single item. The recipe's own selection is not read: the part is the nodes it names.
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('export.compileSelection', params);
    if (!p.ok) return p;
    const includeRootIds = requireStringArray(p.value, 'includeRootIds');
    if (!includeRootIds.ok) return includeRootIds;
    if (includeRootIds.value.length === 0) {
      return invalid(
        'params.includeRootIds must name at least one node',
        'to compile the whole manuscript, use export.compile { format } instead',
        'includeRootIds',
      );
    }
    const format = requireNonBlankString(p.value, 'format');
    if (!format.ok) return format;
    const refused = exportFormatRefusal(format.value);
    if (refused !== undefined) return refused;
    const templateId = optionalString(p.value, 'templateId');
    if (!templateId.ok) return templateId;
    const recipeName = optionalNonBlankString(p.value, 'recipeName', {
      blankHint: 'omit it to export the part with no recipe',
    });
    if (!recipeName.ok) return recipeName;
    if (recipeName.value !== undefined) {
      const missing = recipeNameMissing(snapshot, recipeName.value, 'recipeName');
      if (missing !== undefined) return err(missing);
    }
    // The same shape refusal as export.compile's (above): a part's prompt pack names a vendor template, in templateId or through a recipe,
    // and the apply would refuse one that names neither.
    if (format.value === 'promptpack' && templateId.value === undefined && recipeName.value === undefined) {
      return invalid(
        'a prompt pack is written for one vendor template, and this compile names none',
        'name the vendor template in templateId, or name a recipe that names one',
        'templateId',
      );
    }
    return ok({
      includeRootIds: includeRootIds.value,
      format: format.value,
      ...(templateId.value === undefined ? {} : { templateId: templateId.value }),
      ...(recipeName.value === undefined ? {} : { recipeName: recipeName.value }),
    });
  },
};

export const projectDeleteNode: CommandDescriptor<ProjectDeleteNodeParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('project.deleteNode', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    // project-format §2: "Reserved ids: root, manuscript, research (fixed roots,
    // not deletable)". The agentRisk `never` above is the gate; this is the
    // format invariant, and it holds for the user path too.
    if (isFixedRootId(node.value.id)) {
      return invalid(
        `"${node.value.id}" is a fixed root and cannot be deleted (project-format §2)`,
        'delete the nodes inside it instead — the root, manuscript and research tier is reserved',
        'nodeId',
      );
    }
    return ok({ nodeId: node.value.id });
  },
};

/* ------------------------------------------------------------------ *
 * §9 — view commands
 * ------------------------------------------------------------------ */

/*
 * The three view commands validate **shape only**, never existence.
 *
 * `view.setSelection`'s job is to reflect what the user has selected, and a
 * selection legitimately outlives the thing selected: delete the selected node
 * through the UI and the selection is stale until the next click. A validator
 * that refused to clear a stale selection would leave the binder showing a
 * selection the user cannot dismiss — the refusal would be the bug. §2 also
 * records that these commands "skip undo registration and appear in the activity
 * log as non-undoable view events", so nothing downstream depends on the id
 * resolving.
 *
 * §9 gives their params as "various". The shapes below are the minimum that
 * makes each name mean what it says.
 */

export const viewSetSelection: CommandDescriptor<ViewSetSelectionParams> = {
  mutates: 'view',
  agentRisk: 'read',
  undo: 'none',
  validate: (params) => {
    const p = requireDeclaredParams('view.setSelection', params);
    if (!p.ok) return p;
    const nodeIds = requireStringArray(p.value, 'nodeIds');
    if (!nodeIds.ok) return nodeIds;
    return ok({ nodeIds: nodeIds.value });
  },
};

export const viewSetActiveDoc: CommandDescriptor<ViewSetActiveDocParams> = {
  mutates: 'view',
  agentRisk: 'read',
  undo: 'none',
  validate: (params) => {
    const p = requireDeclaredParams('view.setActiveDoc', params);
    if (!p.ok) return p;
    // A blank id is refused, not only an empty one: a length check alone would
    // refuse `docId: ''` and **accept `docId: '   '`**, a blank string accepted
    // where the sibling check refuses one. A focus
    // request naming three spaces is the same "no node was named" outcome the
    // empty-string refusal exists to stop, and it is the view command a user
    // reaches for first, so it is the one where a wrong id is least visible.
    const docId = requireNonBlankString(p.value, 'docId', {
      blankHint: 'pass the id of the document to focus',
    });
    if (!docId.ok) return docId;
    return ok({ docId: docId.value });
  },
};

export const viewSetScroll: CommandDescriptor<ViewSetScrollParams> = {
  mutates: 'view',
  agentRisk: 'read',
  undo: 'none',
  validate: (params) => {
    const p = requireDeclaredParams('view.setScroll', params);
    if (!p.ok) return p;
    // A blank id is refused, as `view.setActiveDoc` and `view.setExpanded` refuse
    // one: a scroll that names no node writes a junk key into the scroll map and
    // an audit row that reads "scrolled to offset 0" for nothing.
    const nodeId = requireNonBlankString(p.value, 'nodeId', {
      blankHint: 'pass the id of the node being scrolled',
    });
    if (!nodeId.ok) return nodeId;
    const offset = requireInteger(p.value, 'offset', { min: 0 });
    if (!offset.ok) return offset;
    return ok({ nodeId: nodeId.value, offset: offset.value });
  },
};

/*
 * The two view names the UI spec needs. Shape only, like the three
 * above — a folder that has since been deleted is a stale expansion flag, not a
 * refusal, and the binder ignores it at render time.
 */

export const viewSetExpanded: CommandDescriptor<ViewSetExpandedParams> = {
  mutates: 'view',
  agentRisk: 'read',
  undo: 'none',
  validate: (params) => {
    const p = requireDeclaredParams('view.setExpanded', params);
    if (!p.ok) return p;
    const nodeId = requireNonBlankString(p.value, 'nodeId', {
      blankHint: 'pass the id of the folder to expand or collapse',
    });
    if (!nodeId.ok) return nodeId;
    const expanded = p.value['expanded'];
    if (typeof expanded !== 'boolean') {
      return invalid(
        `params.expanded must be a boolean, got ${describe(expanded)}`,
        'pass expanded as true or false',
        'expanded',
      );
    }
    return ok({ nodeId: nodeId.value, expanded });
  },
};

export const viewSetCorkboardScope: CommandDescriptor<ViewSetCorkboardScopeParams> = {
  mutates: 'view',
  agentRisk: 'read',
  undo: 'none',
  validate: (params) => {
    const p = requireDeclaredParams('view.setCorkboardScope', params);
    if (!p.ok) return p;
    // `null` is a value with a meaning ("back to the manuscript"), not an absent
    // key, so it is read before the string rule that would refuse it.
    if (p.value['nodeId'] === null) return ok({ nodeId: null });
    const nodeId = requireNonBlankString(p.value, 'nodeId', {
      blankHint: 'pass the id of a container to show, or null to show the manuscript',
    });
    if (!nodeId.ok) return nodeId;
    return ok({ nodeId: nodeId.value });
  },
};

/* ------------------------------------------------------------------ *
 * The coherence module's two mutations (coherence.md §7.1). Their
 * rules live in `coherence.ts`, which the store applies with, so a
 * validated command cannot fail in its apply for a validation reason.
 * ------------------------------------------------------------------ */

/** The list-valued patch keys, each a list of non-blank ids (§7.1). */
const SCENE_LIST_KEYS = ['after_add', 'after_remove', 'expectedPresent_add', 'expectedPresent_remove'] as const;

/**
 * The coherence file's parts a validate reads, or a refusal when none is open. A project with
 * no coherence file has no findings and no declarations to change, so the command says so rather
 * than creating one as a side effect of a scene edit.
 */
function openCoherence(snapshot: ValidationSnapshot): Result<NonNullable<ValidationSnapshot['coherence']>, CommandError> {
  if (snapshot.coherence === undefined) {
    return notFound(
      'no coherence file is open for this project, so there are no findings or scene declarations to change',
      'open the project with its coherence file loaded: a project with no file loads as an empty one, and the first save creates the file',
    );
  }
  return ok(snapshot.coherence);
}

/**
 * `coherence.setSceneMeta` — writer-declared scene metadata (coherence.md §5.2, §7.1). Write-auto
 * for the agent, because the agent path to it is the Inspector and not a tool: no tool maps to it, so
 * an agent reaches it only through a plan or a composed tool. Undo is the exact inverse of the patch.
 */
export const coherenceSetSceneMeta: CommandDescriptor<CoherenceSetSceneMetaParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('coherence.setSceneMeta', params);
    if (!p.ok) return p;
    const docId = requireNonBlankString(p.value, 'docId');
    if (!docId.ok) return docId;
    // coherence.md §5.2: sceneMeta is keyed by binder node ids, documents and folders alike, since a folder
    // carries the window span `timeline.window` checks (§5.1). A dependency (`after`) still names a document.
    const node = findNode(snapshot, docId.value);
    if (node === undefined || (node.type !== 'document' && node.type !== 'folder')) {
      return notFound(`no document or folder with id "${docId.value}"`, HINT_READ_TREE, 'docId');
    }
    const coherence = openCoherence(snapshot);
    if (!coherence.ok) return coherence;
    const raw = p.value['patch'];
    if (!isRecord(raw)) {
      return invalid(`patch must be an object of scene fields, got ${describe(raw)}`, 'pass patch as an object with the fields to change', 'patch');
    }
    // The list keys are checked here, because the shared rule iterates them and a
    // number or a nested object is not a list it can iterate.
    for (const key of SCENE_LIST_KEYS) {
      const value = raw[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === '')) {
        return invalid(`${key} must be a list of ids, each a non-blank string, got ${showValue(value)}`, undefined, `patch.${key}`);
      }
    }
    const patch = raw as ScenePatch;
    const documentIds = new Set(snapshot.manifest.tree.filter((n) => n.type === 'document').map((n) => n.id));
    const result = applySceneMetaPatch(docId.value, coherence.value.sceneMeta[docId.value], patch, {
      entries: snapshot.manifest.codex ?? [],
      documentIds,
    });
    if (!result.ok) return invalid(result.error, undefined, 'patch');
    return ok({ docId: docId.value, patch });
  },
};

/**
 * `coherence.setFindingStatus` — one finding's status (coherence.md §6.3, §7.1). The bus gate refuses
 * the agent any status but `fixed` and refuses that dismissal outright (permission.ts); this validate
 * checks what every caller is held to: the finding exists, the status is one the file holds, a
 * dismissal names a reason from the picker, and the move is a transition the lifecycle allows.
 */
export const coherenceSetFindingStatus: CommandDescriptor<CoherenceSetFindingStatusParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('coherence.setFindingStatus', params);
    if (!p.ok) return p;
    const findingId = requireNonBlankString(p.value, 'findingId');
    if (!findingId.ok) return findingId;
    const status = p.value['status'];
    if (typeof status !== 'string' || !(COHERENCE_STATUSES as readonly string[]).includes(status)) {
      return invalid(`status must be one of ${COHERENCE_STATUSES.join(', ')}, got ${showValue(status)}`, undefined, 'status');
    }
    const coherence = openCoherence(snapshot);
    if (!coherence.ok) return coherence;
    const finding = coherence.value.findings.find((candidate) => candidate.id === findingId.value);
    if (finding === undefined) {
      return notFound(`no finding has id "${findingId.value}"`, 'use an id from a recent run report or the findings inbox', 'findingId');
    }
    const reason = p.value['reason'];
    if (status === 'dismissed') {
      if (typeof reason !== 'string' || !(DISMISSAL_REASON_IDS as readonly string[]).includes(reason)) {
        return invalid(
          `a dismissal needs a reason from the picker: ${DISMISSAL_REASON_IDS.join(', ')}; got ${showValue(reason)}`,
          undefined,
          'reason',
        );
      }
    } else if (reason !== undefined) {
      return invalid('reason is set only on a dismissal', 'drop reason, or set status to "dismissed"', 'reason');
    }
    const note = p.value['note'];
    if (note !== undefined && typeof note !== 'string') {
      return invalid(`note must be a string, got ${describe(note)}`, undefined, 'note');
    }
    const problem = coherenceNoteProblem(note);
    if (problem !== undefined) {
      return limitExceeded(`the note is ${problem}`, `shorten the note to ${COHERENCE_NOTE_LIMIT} characters`, 'note');
    }
    const transition = findingTransition(finding.status, status as CoherenceStatusName);
    if (!transition.ok) return invalid(transition.message, undefined, 'status');
    return ok({
      findingId: findingId.value,
      status: status as CoherenceStatusName,
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(trimCoherenceNote(note) === undefined ? {} : { note: trimCoherenceNote(note) as string }),
    });
  },
};

/**
 * `mcp.invoke` (extensibility.md §6). This is the bus's own floor, and the registry does not run it: the store
 * registry substitutes the descriptor `@caotang/mcp-client` builds, whose `validate` checks the call against the
 * live client (the server, its pin, the tools loaded this turn, the schema). It stays here so the name has its
 * row in the closed registry, with the closed key set and the per-call risk rule every `mcp.invoke` keeps.
 *
 * The risk is per call, and an external tool is never `write-auto` (extensibility §4 rule 2): a read the server
 * advertised as read-only and the user trusts is `read`, and everything else asks first.
 */
/**
 * The id a create mints, checked against the project the command is about: the
 * shape the loader accepts, and an id no node holds already.
 *
 * The shape is project-format §2's (`n_` and ten Crockford base32 chars), and a
 * node id is also a filename — so an id of another shape is a project that will
 * not load again. **The shape test is stateless input validation**: it describes
 * what the caller supplied, not what the project holds, so it runs
 * unconditionally — an id the loader would refuse on the next open is refused
 * here whatever the tree looks like. Only the taken check reads the tree: an id
 * the tree already holds is a node the create cannot take, and the plan can
 * refuse it before the apply does.
 */
function requireNewNodeId(
  snapshot: ValidationSnapshot,
  params: Record<string, unknown>,
): Result<string, CommandError> {
  const id = requireNonBlankString(params, 'id');
  if (!id.ok) return id;
  if (!NODE_ID_PATTERN.test(id.value)) {
    return invalid(
      `"${id.value}" is not a node id`,
      'a node id is "n_" and ten Crockford base32 characters',
      'id',
    );
  }
  if (snapshot.manifest.tree.some((node) => node.id === id.value)) {
    return invalid(
      `the tree already holds a node with id "${id.value}"`,
      'mint a fresh id for the node being created',
      'id',
    );
  }
  return ok(id.value);
}

/**
 * The node the id names, or a refusal naming the id that is not there.
 */
function requireNodeInTree(
  snapshot: ValidationSnapshot,
  id: string,
): Result<ValidationNode, CommandError> {
  const node = findNode(snapshot, id);
  if (node === undefined) return notFound(`no node with id "${id}"`, HINT_READ_TREE, id);
  return ok(node);
}

/**
 * `storyboard.create`, `shot.create` and `shot.setMeta` (storyboard.md §3.1). Each validates its closed key set and
 * its shape, and reads the snapshot for the state the command depends on: the folder the storyboard lands in, the
 * storyboard folder a shot lands in, the shot a metadata change names, and the id each create mints. The guards that
 * depend on what changed since the plan was made (a scene that moved, a shot whose metadata changed) run in the
 * apply, which the store registry supplies, because they read the storyboard module's own fields.
 *
 * These read `snapshot.manifest.tree` directly, like every other descriptor in this module. The manifest is a
 * required field of the snapshot, so a snapshot without one is a broken read seam — a partial projection, an adapter
 * defect — and not "no project state": it fails loudly here, the way `binder.move`'s sibling dereference does,
 * rather than silently standing every existence check down and letting a validated command fail mid-apply, which is
 * the §2 hole these checks exist to close.
 */
export const storyboardCreate: CommandDescriptor<StoryboardCreateCommandParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('storyboard.create', params);
    if (!p.ok) return p;
    const id = requireNewNodeId(snapshot, p.value);
    if (!id.ok) return id;
    const parentId = requireNonBlankString(p.value, 'parentId');
    if (!parentId.ok) return parentId;
    const parent = requireNodeInTree(snapshot, parentId.value);
    if (!parent.ok) return parent;
    // The placement rules binder.create enforces, enforced here too (gap
    // root-parent-invisible-nodes): a board under the project root is a node the
    // binder can never show, a non-container cannot hold one, and a storyboard
    // folder holds only shots. Existence alone would let a write-auto agent
    // command create an invisible or malformed board that apply — which checks
    // existence too, and nothing else — would happily land.
    if (parent.value.id === 'root') {
      return invalid(
        'the project root is not a place for a node: the binder shows only the manuscript and research, so a storyboard made here would never appear',
        'create the storyboard under "manuscript" or "research", or under a folder inside one of them',
        'parentId',
      );
    }
    if (!isContainer(parent.value)) {
      return invalid(
        `parent "${parent.value.id}" is a ${parent.value.type} and cannot hold children`,
        'only folders hold children — name a folder, or create one with binder.create first',
        'parentId',
      );
    }
    if (isStoryboardFolder(parent.value)) {
      return invalid(
        `"${parent.value.id}" is a storyboard, and a storyboard holds only shots, so another storyboard cannot be made in it`,
        'make the new board beside the other one, under the same parent',
        'parentId',
      );
    }
    const title = requireNonBlankString(p.value, 'title');
    if (!title.ok) return title;
    const scene = isRecord(p.value['scene']) ? p.value['scene'] : undefined;
    if (scene === undefined) {
      return invalid('scene must name the scene the plan was made against: its id, its parentId and its revision', undefined, 'scene');
    }
    const sceneId = requireNonBlankString(scene, 'id');
    if (!sceneId.ok) return sceneId;
    const sceneParent = requireNonBlankString(scene, 'parentId');
    if (!sceneParent.ok) return sceneParent;
    const revision = requireInteger(scene, 'revision', { min: 0 });
    if (!revision.ok) return revision;
    return ok({
      id: id.value,
      parentId: parentId.value,
      title: title.value,
      scene: { id: sceneId.value, parentId: sceneParent.value, revision: revision.value },
    });
  },
};

export const shotCreate: CommandDescriptor<ShotCreateCommandParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('shot.create', params);
    if (!p.ok) return p;
    const id = requireNewNodeId(snapshot, p.value);
    if (!id.ok) return id;
    const parentId = requireNonBlankString(p.value, 'parentId');
    if (!parentId.ok) return parentId;
    const parent = requireNodeInTree(snapshot, parentId.value);
    if (!parent.ok) return parent;
    // The placement rule of storyboard.md §2.1, as `binder.move` states it: a shot
    // sits in a storyboard folder.
    if (!isStoryboardFolder(parent.value)) {
      return invalid(
        `"${parent.value.id}" is not a storyboard folder, and a shot lives in one`,
        'name the storyboard folder the shot belongs to',
        'parentId',
      );
    }
    const title = requireNonBlankString(p.value, 'title');
    if (!title.ok) return title;
    if (!isRecord(p.value['stored'])) return invalid('stored must be the shot’s metadata object', undefined, 'stored');
    return ok({ id: id.value, parentId: parentId.value, title: title.value, stored: p.value['stored'] });
  },
};

export const shotSetMeta: CommandDescriptor<ShotSetMetaCommandParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('shot.setMeta', params);
    if (!p.ok) return p;
    const nodeId = requireNonBlankString(p.value, 'nodeId');
    if (!nodeId.ok) return nodeId;
    const node = requireNodeInTree(snapshot, nodeId.value);
    if (!node.ok) return node;
    if (node.value.type !== 'shot') {
      return invalid(
        `"${node.value.id}" is a ${node.value.type}, and only a shot holds these settings`,
        'choose the shot whose details to change',
        'nodeId',
      );
    }
    const stored = p.value['stored'];
    if (stored !== null && !isRecord(stored)) return invalid('stored must be the whole shot metadata object, or null to remove it', undefined, 'stored');
    if (!Object.prototype.hasOwnProperty.call(p.value, 'expect')) {
      return invalid('expect must be the stored value the plan read, or null when the shot had none', undefined, 'expect');
    }
    return ok({ nodeId: nodeId.value, stored: stored as Record<string, unknown> | null, expect: p.value['expect'] });
  },
};

export const mcpInvoke: CommandDescriptor<McpInvokeParams> = {
  mutates: 'none',
  agentRisk: 'write-confirm',
  undo: 'none',
  activitySource: 'mcp',
  // Its apply awaits the server, so the synchronous bus refuses it and `executeAsync` runs it (command-bus §3).
  asyncApply: true,
  agentRiskOf: (normalized) =>
    typeof normalized === 'object' && normalized !== null && (normalized as { readonly risk?: unknown }).risk === 'read-auto'
      ? 'read'
      : 'write-confirm',
  validate: (params) => {
    const p = requireDeclaredParams('mcp.invoke', params);
    if (!p.ok) return p;
    // The closed key set is all this floor checks. Its shape is the client's to check (see the header).
    return ok(p.value as unknown as McpInvokeParams);
  },
};
