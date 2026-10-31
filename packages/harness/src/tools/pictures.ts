/**
 * The agent's picture tools (pictures.md §8.1): list, view, annotate, attach, import, place and transcribe.
 *
 * The list reads the registry; annotate and attach map onto `asset.setMeta`, `asset.setLinkMeta`, `asset.link` and
 * `asset.unlink`; import maps onto `asset.import`, which awaits the host's file write and so runs from an async port;
 * place composes the never-exposed `editor.insert` primitive under the grant the writer's confirmation gives it
 * (`PreparedCommand.inherit`). Transcribe is the model-backed async port of `tools/transcription.ts`: the loop stages
 * its plan, generates only after approval, and the reviewed pages publish through the single `asset.transcribe` command.
 *
 * **The module is self-contained until the registry takes it.** `PICTURE_TOOL_NAMES`, `PICTURE_TOOL_METADATA` and
 * `PICTURE_DEFINITIONS` are what `metadata.ts` and `table.ts` join; `ACCEPT_EDITS_TOOLS` takes `pictures.annotate` and
 * `pictures.attach` and not the other four (pictures.md §8.1).
 */

// i18n: model-facing

import {
  describePictureUse,
  err,
  ok,
  picturesUsesSnapshot,
  type CommandError,
  type ExecutionOutcome,
  type Result,
  type ValidationSnapshot,
} from '@caotang/bus';
import { imageLimitsFor, type ChatMessage, type ImagePart, type RouteImageLimits } from '@caotang/gateway';
import {
  ASSETS_DIR,
  ASSET_LINK_ROLES,
  PICTURE_LIMITS,
  PLACEMENT_SIZES,
  assetFileName,
  captureParagraphAnchor,
  collectUses,
  encodePlacementTitle,
  isAssetId,
  isLinkId,
  linksToAsset,
  normalizeBlockText,
  paragraphBlocks,
  placeLink,
  readPictureHeader,
  removeLink,
  sha256Hex,
  sniffPicture,
  type AssetTarget,
  type ParagraphBlock,
  type PictureMime,
  type ReadAssetLink,
  type ReadAssetRecord,
} from '@caotang/pictures';
import { getBody, getRevision, type ProjectState, type TreeNode } from '@caotang/store';

import { invalidParams, limitExceeded, notFound, refusal } from '../errors.js';
import type { ToolMetadata } from '../metadata.js';
import { resolveNode, DOCUMENT, TARGET } from '../resolve.js';
import { param, type ObjectSpec, type TaggedSpec } from '../schema.js';
import { charBudget } from '../tokens.js';
import type {
  AsyncToolPort,
  CallParams,
  PortContext,
  PortToolName,
  PrepareFn,
  PreparedCall,
  PreparedCommand,
} from '../types.js';
import { batchRefusal, checkCommand } from './common.js';
import { transcriptionParams } from './transcription.js';

export const PICTURE_TOOL_NAMES = [
  'pictures.list',
  'pictures.view',
  'pictures.annotate',
  'pictures.attach',
  'pictures.import',
  'pictures.place',
  'pictures.transcribe',
] as const;

export type PictureToolName = (typeof PICTURE_TOOL_NAMES)[number];

/** A metadata row in `ToolMetadata`'s shape, named by a picture tool until `metadata.ts` adds the names to `ToolName`. */
export type PictureToolMetadata = Omit<ToolMetadata, 'name'> & { readonly name: PictureToolName };

/** pictures.md §8.1: a view is at most four pictures, at most 1,568 px on the long side. */
export const VIEW_MAX_PICTURES = 4;
export const VIEW_MAX_EDGE = 1568;
/** pictures.md §8.1: an annotate or attach batch is at most 50. */
export const PICTURE_BATCH_MAX = 50;
const LIST_CAP = 6000;
const LIST_LIMIT_MAX = 100;
const LIST_LIMIT_DEFAULT = 25;
const QUOTE_MAX = 200;
const TAGS_MAX = PICTURE_LIMITS.tags;

const AUTO_SENTENCE = 'Applies automatically within an approved turn.';
const CONFIRM_SENTENCE = 'Requires user confirmation.';

export const PICTURE_TOOL_METADATA: readonly PictureToolMetadata[] = [
  {
    name: 'pictures.list',
    risk: 'read',
    undoable: false,
    response_token_cap: LIST_CAP,
    descriptionVersion: 1,
    description:
      'List the project’s pictures from its registry: id, caption, alt text, tags, size, where each is placed (placements with their ids, notes and, for a paragraph, the quote it is pinned to) and its other uses. Narrow it by target (a document or folder title or id, or "project") or by tag. Text only: it never shows the picture itself, use pictures.view for that. Read-only. At most 100 per call; a long answer is cut and says how many it left out, so narrow it with target or tag.',
    surface: 'extension',
    load: 'deferred',
    keywords: ['picture', 'image', 'asset', 'registry', 'placement', 'caption', 'alt'],
  },
  {
    name: 'pictures.view',
    risk: 'read',
    undoable: false,
    response_token_cap: 1500,
    descriptionVersion: 1,
    description:
      'Look at one to four pictures by id. When the active model accepts images, they are attached to the next message as the pictures themselves, at most 1568 px on the long side. Otherwise you get each picture’s caption, alt text and transcription as text, with a note that you are not seeing the picture. A host that cannot resize sends a picture only when its stored bytes are already within the limits, and refuses a larger one with its size and what to do; it never says it shrank a picture it did not. Read-only. Read the ids with pictures.list.',
    surface: 'extension',
    load: 'deferred',
    keywords: ['picture', 'image', 'look', 'see', 'caption', 'transcription'],
  },
  {
    name: 'pictures.annotate',
    risk: 'write-auto',
    undoable: true,
    response_token_cap: 1000,
    descriptionVersion: 1,
    description: `Set or clear the caption, alt text, decorative flag and tags of pictures, or the note of a placement, in one batch of at most ${PICTURE_BATCH_MAX} items. Pass a picture id (a_…) for caption, alt, decorative and tags, or a placement id (l_…) for its note; an empty string, an empty list or false clears a field. The whole batch is checked first, so one bad item writes nothing, and one Undo reverses it. ${AUTO_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['picture', 'image', 'caption', 'alt', 'tags', 'note', 'decorative', 'describe'],
  },
  {
    name: 'pictures.attach',
    risk: 'write-auto',
    undoable: true,
    response_token_cap: 1000,
    descriptionVersion: 1,
    description: `Place pictures on the project, on a binder item or on one paragraph of a document, and remove placements by id: at most ${PICTURE_BATCH_MAX} of each per call. A paragraph is named by a short quote from it, and a quote that fits more than one paragraph is refused with the paragraphs it fits, so quote more of the one you mean. The whole batch is checked first, and one Undo reverses it. ${AUTO_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['picture', 'image', 'attach', 'link', 'unlink', 'place', 'card', 'reference', 'paragraph'],
  },
  {
    name: 'pictures.import',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 600,
    descriptionVersion: 1,
    description: `Save a picture the app has already staged (a drop, a paste or an image a tool returned) into the project by its staging id, with an optional caption, alt text, source and placements. It cannot make or fetch bytes, and an unknown or already-used staging id is refused. ${CONFIRM_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['picture', 'image', 'import', 'staged', 'save', 'upload'],
  },
  {
    name: 'pictures.place',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 800,
    descriptionVersion: 1,
    description: `Insert a picture into a document’s body as an inline image, before or after the paragraph a quote names. The card shows a ghost of the result, nothing is written until the writer confirms, and a document that changed since the call was prepared is refused. One Undo restores the body. ${CONFIRM_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['picture', 'image', 'inline', 'insert', 'place', 'figure', 'illustration'],
  },
  {
    name: 'pictures.transcribe',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 1200,
    descriptionVersion: 1,
    description: `Transcribe one to 100 handwritten page pictures by id. The card shows the pages, output target, language, request batches and cost before anything is sent. into is new-document by default, or searchable to keep the text only on the picture records. language is an optional hint. secondRead names another vision route explicitly as {profileId, model?}; never use it to repeat the primary route silently. Generated pages stay unreviewed until the writer selects and edits them in the review gate, then one command publishes the batch and one Undo reverses it. ${CONFIRM_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['picture', 'image', 'transcribe', 'handwriting', 'handwritten', 'ocr', 'text', 'page'],
  },
];

/* ------------------------------------------------------------------ *
 * Small readers over untrusted params (already shape-checked by the schema)
 * ------------------------------------------------------------------ */

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : {};

const text = (source: Readonly<Record<string, unknown>>, key: string): string => {
  const value = source[key];
  return typeof value === 'string' ? value : '';
};

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const lead = (value: string, chars: number): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars).trimEnd()}…`;
};

const recordsOf = (state: ProjectState): readonly ReadAssetRecord[] => (state.manifest.assets ?? []) as readonly ReadAssetRecord[];
const linksIn = (state: ProjectState): readonly ReadAssetLink[] => (state.manifest.assetLinks ?? []) as readonly ReadAssetLink[];

function titleOf(state: ProjectState, nodeId: string): string {
  return state.manifest.tree.find((node) => node.id === nodeId)?.title ?? nodeId;
}

/* ------------------------------------------------------------------ *
 * Targets: the one shape list, attach and import share
 * ------------------------------------------------------------------ */

function targetParams(what: string): TaggedSpec {
  return param.tagged(what, 'kind', {
    project: param.object('The project as a whole.', {}),
    node: param.object('One binder item.', {
      doc: param.string('The document or folder: a title, or an id. An ambiguous title lists its candidates.', { nonBlank: true }),
    }, ['doc']),
    paragraph: param.object('One paragraph of a document, named by a quote from it.', {
      doc: param.string('The document: a title, or an id.', { nonBlank: true }),
      anchor: param.string(`A short quote from the paragraph, at most ${QUOTE_MAX} characters, exactly as the document reads. It must fit one paragraph only.`, {
        nonBlank: true,
        maxLength: QUOTE_MAX,
      }),
    }, ['doc', 'anchor']),
  });
}

interface FoundParagraph {
  readonly block: ParagraphBlock;
  readonly body: string;
  readonly revision: number;
  readonly node: TreeNode;
}

/**
 * The one paragraph a quote names. A quote the whole of one paragraph wins over longer paragraphs that merely contain it; otherwise it
 * must be inside exactly one. More than one is refused with every paragraph it fits, because picking one is a guess the writer would
 * find out about only when the picture sat in the wrong place.
 */
function findParagraph(state: ProjectState, node: TreeNode, quote: string, path: string): Result<FoundParagraph, CommandError> {
  const body = getBody(state, node.id);
  const wanted = normalizeBlockText(quote);
  if (wanted === '') return err(invalidParams(`${path} must not be blank`, 'quote a few words from the paragraph', path));
  const blocks = paragraphBlocks(body);
  const whole = blocks.filter((block) => normalizeBlockText(block.text) === wanted);
  const inside = whole.length > 0 ? whole : blocks.filter((block) => normalizeBlockText(block.text).includes(wanted));
  const first = inside[0];
  if (first === undefined) {
    return err(
      notFound(
        `no paragraph of "${node.title}" contains "${lead(quote, 60)}"`,
        'read the document with doc.read and quote words from one paragraph exactly as they appear; a quote cannot span two paragraphs',
        path,
      ),
    );
  }
  if (inside.length > 1) {
    return err(
      refusal('invalid-params', `"${lead(quote, 60)}" fits ${inside.length} paragraphs of "${node.title}": ${inside.map((block) => `paragraph ${block.ordinal + 1} (“${lead(block.text, 50)}”)`).join(', ')}. It was not guessed.`, {
        target: path,
        correctiveHint: 'quote more of the paragraph you mean, enough to tell it from the others',
        details: { candidates: inside.map((block) => ({ paragraph: block.ordinal + 1, lead: lead(block.text, 80) })) },
      }),
    );
  }
  return ok({ block: first, body, revision: getRevision(state, node.id), node });
}

function resolveTarget(state: ProjectState, raw: unknown, path: string): Result<AssetTarget, CommandError> {
  const spec = record(raw);
  switch (spec['kind']) {
    case 'project':
      return ok({ kind: 'project' });
    case 'node': {
      const node = resolveNode(state, text(spec, 'doc'), TARGET, 'document or folder', `${path}.doc`);
      return node.ok ? ok({ kind: 'node', nodeId: node.value.id }) : err(node.error);
    }
    case 'paragraph': {
      const node = resolveNode(state, text(spec, 'doc'), DOCUMENT, 'document', `${path}.doc`);
      if (!node.ok) return err(node.error);
      const found = findParagraph(state, node.value, text(spec, 'anchor'), `${path}.anchor`);
      if (!found.ok) return found;
      const anchor = captureParagraphAnchor(found.value.body, found.value.block.start, found.value.revision);
      if (anchor === undefined) return err(notFound(`"${node.value.title}" has no text to anchor a picture to`, 'place the picture on the document itself with kind "node"', path));
      return ok({ kind: 'paragraph', nodeId: node.value.id, anchor });
    }
    default:
      return err(invalidParams(`${path}.kind must be project, node or paragraph`, 'name where the picture goes', `${path}.kind`));
  }
}

/** A stored target in the words the model reads: the node by title, a paragraph by its quote. */
function describeTarget(state: ProjectState, target: ReadAssetLink['target']): Readonly<Record<string, unknown>> {
  const shape = target as { kind: string; nodeId?: string; anchor?: { exact?: string }; orphaned?: true; moved?: true };
  if (shape.kind === 'project') return { kind: 'project' };
  if (shape.nodeId === undefined) return { kind: shape.kind };
  const doc = { id: shape.nodeId, title: titleOf(state, shape.nodeId) };
  if (shape.kind === 'node') return { kind: 'node', doc };
  return {
    kind: shape.kind,
    doc,
    ...(typeof shape.anchor?.exact === 'string' ? { quote: lead(shape.anchor.exact, 80) } : {}),
    ...(shape.orphaned === true ? { orphaned: true } : {}),
    ...(shape.moved === true ? { moved: true } : {}),
  };
}

const pictureRecordOf = (state: ProjectState, assetId: string): ReadAssetRecord | undefined => recordsOf(state).find((candidate) => candidate.id === assetId);

function unknownPicture(assetId: string, path: string): CommandError {
  return notFound(`there is no picture "${assetId}"`, 'read the ids with pictures.list', path);
}

/* ------------------------------------------------------------------ *
 * pictures.list
 * ------------------------------------------------------------------ */

export const picturesListParams: ObjectSpec = param.object(
  'Which pictures to list.',
  {
    target: param.string('Only pictures placed at this document or folder (a title or an id, a paragraph of it counting), or "project" for the project as a whole.', { nonBlank: true }),
    tag: param.string('Only pictures carrying this tag.', { nonBlank: true, maxLength: PICTURE_LIMITS.tagLength }),
    limit: param.integer(`At most this many pictures, default ${LIST_LIMIT_DEFAULT}.`, { minimum: 1, maximum: LIST_LIMIT_MAX }),
  },
  [],
);

function summaryOfPicture(state: ProjectState, picture: ReadAssetRecord, uses: ReturnType<typeof collectUses>, snapshot: ValidationSnapshot): Readonly<Record<string, unknown>> {
  const links = linksToAsset(linksIn(state), picture.id).map((link) => ({
    id: link.id,
    role: link.role,
    target: describeTarget(state, link.target),
    ...(link.note === undefined ? {} : { note: lead(link.note, 200) }),
  }));
  const others = (uses.get(picture.id) ?? []).filter((use) => use.kind !== 'link').map((use) => describePictureUse(snapshot, use));
  return {
    id: picture.id,
    mime: picture.mime,
    bytes: picture.bytes,
    ...(picture.width === undefined || picture.height === undefined ? {} : { width: picture.width, height: picture.height }),
    ...(picture.caption === undefined ? {} : { caption: picture.caption }),
    ...(picture.alt === undefined ? {} : { alt: picture.alt }),
    ...(picture.decorative === true ? { decorative: true } : {}),
    ...(picture.tags === undefined || picture.tags.length === 0 ? {} : { tags: picture.tags }),
    ...(picture.source?.label === undefined ? {} : { source: picture.source.label }),
    ...(picture.transcription?.text === undefined ? {} : { transcribed: true }),
    links,
    ...(others.length === 0 ? {} : { uses: others }),
  };
}

export const prepareList: PrepareFn = (params, context) => {
  const { state } = context;
  const wantedTag = typeof params['tag'] === 'string' ? params['tag'].trim().toLowerCase() : undefined;
  const limit = typeof params['limit'] === 'number' ? params['limit'] : LIST_LIMIT_DEFAULT;

  let scope: { readonly project: true } | { readonly nodeId: string } | undefined;
  if (typeof params['target'] === 'string') {
    if (params['target'].trim().toLowerCase() === 'project') scope = { project: true };
    else {
      const node = resolveNode(state, params['target'], () => true, 'binder item', 'params.target');
      if (!node.ok) return err(node.error);
      scope = { nodeId: node.value.id };
    }
  }

  const snapshot: ValidationSnapshot = state;
  const uses = collectUses(picturesUsesSnapshot(snapshot));
  const placedAt = (picture: ReadAssetRecord): boolean => {
    if (scope === undefined) return true;
    if ('project' in scope) {
      return linksToAsset(linksIn(state), picture.id).some((link) => link.target.kind === 'project') || (uses.get(picture.id) ?? []).some((use) => use.kind === 'cover');
    }
    const { nodeId } = scope;
    const linked = linksToAsset(linksIn(state), picture.id).some((link) => (link.target as { nodeId?: string }).nodeId === nodeId);
    return linked || (uses.get(picture.id) ?? []).some((use) => (use.kind === 'inline' || use.kind === 'shot' || use.kind === 'comic-panel') && use.nodeId === nodeId);
  };

  const matching = recordsOf(state).filter(
    (picture) => placedAt(picture) && (wantedTag === undefined || (picture.tags ?? []).some((tag) => tag.toLowerCase() === wantedTag)),
  );

  // The cap is on the whole answer, so pictures are added whole until the budget is spent and the rest is counted, never cut mid-picture.
  const budget = charBudget(LIST_CAP) - 600;
  const shown: Readonly<Record<string, unknown>>[] = [];
  let spent = 0;
  for (const picture of matching.slice(0, limit)) {
    const entry = summaryOfPicture(state, picture, uses, snapshot);
    const size = JSON.stringify(entry).length;
    if (spent + size > budget && shown.length > 0) break;
    shown.push(entry);
    spent += size;
  }
  const omitted = matching.length - shown.length;
  const notes = omitted > 0 ? [`${omitted} of ${matching.length} matching pictures are not shown; narrow the list with target or tag, or ask again with a smaller limit`] : [];

  return ok({
    commands: [],
    finish: () =>
      ok({
        data: { pictures: shown, total: matching.length, shown: shown.length, omitted, library: recordsOf(state).length },
        summary:
          matching.length === 0
            ? 'no pictures match'
            : `${shown.length} of ${matching.length} ${matching.length === 1 ? 'picture' : 'pictures'}`,
        affected: [],
        ...(notes.length === 0 ? {} : { notes }),
      }),
  });
};

/* ------------------------------------------------------------------ *
 * pictures.annotate
 * ------------------------------------------------------------------ */

export const picturesAnnotateParams: ObjectSpec = param.object(
  'The pictures or placements to describe, and what to set on each.',
  {
    items: param.list(
      `One entry per picture or placement. At most ${PICTURE_BATCH_MAX} per call.`,
      param.object(
        'One picture (a_ id) or one placement (l_ id), and the fields to change. A field left out stays as it is.',
        {
          id: param.string('A picture id (a_…), or a placement id (l_…) for a note.', { nonBlank: true, maxLength: 64 }),
          caption: param.string(`The caption, at most ${PICTURE_LIMITS.caption} characters. An empty string clears it. Pictures only.`, { maxLength: PICTURE_LIMITS.caption }),
          alt: param.string(`The alt text, at most ${PICTURE_LIMITS.alt} characters: what the picture shows, for a reader who cannot see it. An empty string clears it. Pictures only.`, { maxLength: PICTURE_LIMITS.alt }),
          decorative: param.boolean('True marks the picture as decoration with no alt text to read; false clears the mark. Pictures only.'),
          tags: param.list(
            `The picture’s tags, replacing its current ones, at most ${TAGS_MAX}. An empty list clears them. Pictures only.`,
            param.string('One tag.', { nonBlank: true, maxLength: PICTURE_LIMITS.tagLength }),
            { maxItems: TAGS_MAX },
          ),
          note: param.string(`A placement’s note, at most ${PICTURE_LIMITS.note} characters. An empty string clears it. Placements only.`, { maxLength: PICTURE_LIMITS.note }),
        },
        ['id'],
      ),
      { minItems: 1, maxItems: PICTURE_BATCH_MAX },
    ),
  },
  ['items'],
);

const PICTURE_FIELDS = ['caption', 'alt', 'decorative', 'tags'] as const;

export const prepareAnnotate: PrepareFn = (params, context) => {
  const { state } = context;
  const items = list(params['items']);
  const failures: { target: string; error: CommandError }[] = [];
  const commands: PreparedCommand[] = [];
  const planned: { id: string; kind: 'picture' | 'placement'; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> }[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of items.entries()) {
    const path = `items[${index}]`;
    const item = record(raw);
    const id = text(item, 'id');
    const refuse = (message: string, hint: string): void => {
      failures.push({ target: path, error: invalidParams(message, hint, `${path}.id`) });
    };
    if (seen.has(id)) {
      refuse(`${path} repeats "${id}", which an earlier item already changes`, 'send one entry for each picture or placement, with every field in it');
      continue;
    }
    seen.add(id);

    if (isAssetId(id)) {
      if (item['note'] !== undefined) {
        refuse(`${path}: a note belongs to a placement, not to the picture "${id}"`, 'use the placement’s l_ id from pictures.list to set its note');
        continue;
      }
      const patch: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const current = pictureRecordOf(state, id);
      for (const field of PICTURE_FIELDS) {
        const value = item[field];
        if (value === undefined) continue;
        const stored = field === 'decorative' ? (value === true ? true : null) : Array.isArray(value) ? (value.length === 0 ? null : value) : value === '' ? null : value;
        patch[field] = stored;
        before[field] = current?.[field] ?? null;
        after[field] = stored;
      }
      if (Object.keys(patch).length === 0) {
        refuse(`${path} changes nothing for "${id}"`, 'name at least one of caption, alt, decorative or tags');
        continue;
      }
      const command = { assetId: id, patch };
      const checked = checkCommand(context, 'asset.setMeta', command);
      if (!checked.ok) {
        failures.push({ target: path, error: checked.error });
        continue;
      }
      commands.push({ name: 'asset.setMeta', params: command });
      planned.push({ id, kind: 'picture', fields: Object.keys(patch), before, after });
    } else if (isLinkId(id)) {
      if (PICTURE_FIELDS.some((field) => item[field] !== undefined) || item['note'] === undefined) {
        refuse(`${path}: a placement "${id}" carries only a note`, 'send note for a placement, or the picture’s a_ id for caption, alt, decorative and tags');
        continue;
      }
      const note = text(item, 'note');
      const command = { linkId: id, patch: { note: note === '' ? null : note } };
      const checked = checkCommand(context, 'asset.setLinkMeta', command);
      if (!checked.ok) {
        failures.push({ target: path, error: checked.error });
        continue;
      }
      commands.push({ name: 'asset.setLinkMeta', params: command });
      const held = linksIn(state).find((link) => link.id === id);
      planned.push({ id, kind: 'placement', fields: ['note'], before: { note: held?.note ?? null }, after: { note: command.patch.note } });
    } else {
      refuse(`${path}.id "${id}" is neither a picture id (a_…) nor a placement id (l_…)`, 'read the ids with pictures.list');
    }
  }

  if (failures.length > 0) {
    return err(batchRefusal(failures, items.length, 'fix every listed item and resend the whole call — nothing was written'));
  }

  return ok({
    commands,
    preview: { changes: planned.map(({ id, kind, before, after }) => ({ id, kind, before, after })) },
    finish: (done) => {
      const affected = done.flatMap((entry) => [...entry.outcome.affected]);
      const group = done[0]?.outcome.undoGroupId;
      return ok({
        data: { changed: planned.map(({ id, kind, fields }) => ({ id, kind, fields })) },
        summary: `described ${planned.length} ${planned.length === 1 ? 'item' : 'items'}`,
        affected,
        ...(group === undefined ? {} : { undoGroupId: group }),
      });
    },
  } satisfies PreparedCall);
};

/* ------------------------------------------------------------------ *
 * pictures.attach
 * ------------------------------------------------------------------ */

export const picturesAttachParams: ObjectSpec = param.object(
  'The placements to make and the placements to remove.',
  {
    attach: param.list(
      `Placements to make, at most ${PICTURE_BATCH_MAX}.`,
      param.object(
        'One picture, and where it goes.',
        {
          assetId: param.string('The picture id (a_…).', { nonBlank: true, maxLength: 64 }),
          to: targetParams('Where the picture goes: the project, a binder item, or one paragraph of a document.'),
          role: param.choice('What the placement is. A card is the one picture a binder item shows on its card. Default reference.', ASSET_LINK_ROLES),
          note: param.string(`A note about this placement, at most ${PICTURE_LIMITS.note} characters.`, { maxLength: PICTURE_LIMITS.note }),
        },
        ['assetId', 'to'],
      ),
      { maxItems: PICTURE_BATCH_MAX },
    ),
    detach: param.list(
      `Placement ids (l_…) to remove, at most ${PICTURE_BATCH_MAX}. The picture stays in the library.`,
      param.string('One placement id.', { nonBlank: true, maxLength: 64 }),
      { maxItems: PICTURE_BATCH_MAX },
    ),
  },
  [],
);

export function refineAttach(params: CallParams): CommandError | undefined {
  if (list(params['attach']).length + list(params['detach']).length > 0) return undefined;
  return invalidParams('pictures.attach has nothing to do: pass attach, detach or both', 'name a placement to make or to remove, then resend', 'params');
}

export const prepareAttach: PrepareFn = (params, context) => {
  const { state } = context;
  const detach = list(params['detach']);
  const attach = list(params['attach']);
  const failures: { target: string; error: CommandError }[] = [];
  const commands: PreparedCommand[] = [];
  const plan: { op: 'detach' | 'attach'; label: string }[] = [];
  // Each op is checked against the links as the ops before it leave them, so a batch that places a picture twice, or two cards on one item, is refused whole.
  let projected: readonly ReadAssetLink[] = linksIn(state);
  const seen = new Set<string>();

  for (const [index, raw] of detach.entries()) {
    const path = `detach[${index}]`;
    const linkId = typeof raw === 'string' ? raw : '';
    if (seen.has(linkId)) {
      failures.push({ target: path, error: invalidParams(`${path} repeats "${linkId}"`, 'name each placement once', path) });
      continue;
    }
    seen.add(linkId);
    const command = { linkId };
    const checked = checkCommand(context, 'asset.unlink', command, { manifest: { ...state.manifest, assetLinks: projected }, documents: state.documents } as ValidationSnapshot);
    if (!checked.ok) {
      failures.push({ target: path, error: checked.error });
      continue;
    }
    const removed = removeLink(projected, linkId);
    if (removed.ok) projected = removed.value.links as ReadAssetLink[];
    commands.push({ name: 'asset.unlink', params: command });
    plan.push({ op: 'detach', label: linkId });
  }

  for (const [index, raw] of attach.entries()) {
    const path = `attach[${index}]`;
    const item = record(raw);
    const assetId = text(item, 'assetId');
    if (!isAssetId(assetId) || pictureRecordOf(state, assetId) === undefined) {
      failures.push({ target: path, error: unknownPicture(assetId, `${path}.assetId`) });
      continue;
    }
    const target = resolveTarget(state, item['to'], `${path}.to`);
    if (!target.ok) {
      failures.push({ target: path, error: target.error });
      continue;
    }
    const command: Record<string, unknown> = {
      assetId,
      target: target.value,
      ...(typeof item['role'] === 'string' ? { role: item['role'] } : {}),
      ...(typeof item['note'] === 'string' && item['note'] !== '' ? { note: item['note'] } : {}),
    };
    const checked = checkCommand(context, 'asset.link', command, { manifest: { ...state.manifest, assetLinks: projected }, documents: state.documents } as ValidationSnapshot);
    if (!checked.ok) {
      failures.push({ target: path, error: checked.error });
      continue;
    }
    const placed = placeLink(projected, {
      assetId,
      target: target.value,
      ...(command['role'] === undefined ? {} : { role: command['role'] as (typeof ASSET_LINK_ROLES)[number] }),
    });
    if (placed.ok) projected = placed.value.links as ReadAssetLink[];
    commands.push({ name: 'asset.link', params: command });
    plan.push({ op: 'attach', label: assetId });
  }

  if (failures.length > 0) {
    return err(batchRefusal(failures, detach.length + attach.length, 'fix every listed entry and resend the whole call — nothing was written'));
  }

  return ok({
    commands,
    finish: (done) => {
      const placed = done
        .filter((entry) => entry.name === 'asset.link')
        .map((entry, index) => ({ assetId: plan.filter((step) => step.op === 'attach')[index]?.label, linkId: record(entry.outcome.result)['linkId'] }));
      const removed = done.filter((entry) => entry.name === 'asset.unlink').length;
      const group = done[0]?.outcome.undoGroupId;
      return ok({
        data: { placed, removed },
        summary: `placed ${placed.length} and removed ${removed} ${removed === 1 ? 'placement' : 'placements'}`,
        affected: done.flatMap((entry) => [...entry.outcome.affected]),
        ...(group === undefined ? {} : { undoGroupId: group }),
      });
    },
  } satisfies PreparedCall);
};

/* ------------------------------------------------------------------ *
 * pictures.place
 * ------------------------------------------------------------------ */

export const picturesPlaceParams: ObjectSpec = param.object(
  'The picture, the document and the paragraph it goes beside.',
  {
    assetId: param.string('The picture id (a_…).', { nonBlank: true, maxLength: 64 }),
    doc: param.string('The prose document: a title, or an id.', { nonBlank: true }),
    anchor: param.string(`A short quote from the paragraph the picture goes beside, at most ${QUOTE_MAX} characters, exactly as the document reads. It must fit one paragraph only.`, {
      nonBlank: true,
      maxLength: QUOTE_MAX,
    }),
    position: param.choice('Before or after that paragraph. Default after.', ['before', 'after'], { default: 'after' }),
    size: param.choice('How large it prints. Default full.', PLACEMENT_SIZES),
    revision: param.integer('The revision of the document you read the quote from, when you have one. The call is refused if the document has moved on.', { minimum: 0 }),
  },
  ['assetId', 'doc', 'anchor'],
);

/** Markdown reads the alt slot as one line of plain text, so brackets and line breaks are removed from it. */
const altOf = (value: string): string => value.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

const PROSE_REFUSED_KINDS: ReadonlySet<string> = new Set(['screenplay', 'branching']);

export const preparePlace: PrepareFn = (params, context) => {
  const { state } = context;
  const assetId = text(params, 'assetId');
  const picture = isAssetId(assetId) ? pictureRecordOf(state, assetId) : undefined;
  if (picture === undefined) return err(unknownPicture(assetId, 'params.assetId'));

  const node = resolveNode(state, text(params, 'doc'), DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return err(node.error);
  if (node.value.kind !== undefined && PROSE_REFUSED_KINDS.has(node.value.kind)) {
    return err(invalidParams(`"${node.value.title}" is a ${node.value.kind}, which has no inline pictures`, 'place the picture on a prose document, or attach it to this one with pictures.attach', 'params.doc'));
  }

  const found = findParagraph(state, node.value, text(params, 'anchor'), 'params.anchor');
  if (!found.ok) return err(found.error);
  const { block, body, revision } = found.value;

  // The revision the call was written against: a document that has moved on is refused here, before any card, and the same number
  // rides on the insert so the bus refuses it again if the body changes between this check and the write.
  if (typeof params['revision'] === 'number' && params['revision'] !== revision) {
    return err(
      refusal('revision-conflict', `"${node.value.title}" is at revision ${revision}, not ${params['revision']}, so the quote may no longer sit where you read it`, {
        target: 'params.revision',
        correctiveHint: 'read the document again with doc.read, quote the paragraph from what it holds now, and resend',
      }),
    );
  }

  const decorative = picture.decorative === true;
  const alt = decorative ? '' : altOf(picture.alt ?? picture.caption ?? '');
  const size = typeof params['size'] === 'string' ? (params['size'] as (typeof PLACEMENT_SIZES)[number]) : undefined;
  const title = encodePlacementTitle({ caption: altOf(picture.caption ?? ''), ...(size === undefined ? {} : { size }), decorative });
  const file = assetFileName(picture.id, picture.mime as PictureMime);
  const markdown = `![${alt}](../${ASSETS_DIR}/${file}${title === null ? '' : ` "${title}"`})`;

  const before = params['position'] === 'before';
  const offset = before ? block.start : block.end;
  const inserted = before ? `${markdown}\n\n` : `\n\n${markdown}`;
  const command = { docId: node.value.id, offset, text: inserted, expectedRevision: revision };

  // The bus's own validate, so a refusal is the one the write would have made.
  const checked = checkCommand(context, 'editor.insert', command);
  if (!checked.ok) return err(checked.error);

  const neighbour = before ? paragraphBlocks(body)[block.ordinal - 1] : paragraphBlocks(body)[block.ordinal + 1];
  const ghost = {
    kind: 'inline-image',
    position: before ? 'before' : 'after',
    markdown,
    paragraph: lead(block.text, 160),
    ...(neighbour === undefined ? {} : { neighbour: lead(neighbour.text, 80) }),
  };

  return ok({
    commands: [{ name: 'editor.insert', params: command, inherit: 'write-confirm' }],
    preview: {
      doc: { id: node.value.id, title: node.value.title },
      picture: { id: picture.id, ...(picture.caption === undefined ? {} : { caption: picture.caption }), ...(alt === '' ? {} : { alt }) },
      revision,
      ghost,
    },
    finish: (done) => {
      const outcome = done[0]?.outcome;
      return ok({
        data: { doc: { id: node.value.id, title: node.value.title }, picture: picture.id, position: ghost.position, inserted: markdown },
        summary: `placed ${picture.id} ${ghost.position} a paragraph of "${node.value.title}"`,
        affected: outcome === undefined ? [] : [...outcome.affected],
        ...(outcome?.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
      });
    },
  } satisfies PreparedCall);
};

/* ------------------------------------------------------------------ *
 * pictures.import (async port)
 * ------------------------------------------------------------------ */

export const picturesImportParams: ObjectSpec = param.object(
  'The staged picture to save, and what to record about it.',
  {
    stagingId: param.string('The staging id the app gave the picture, from a drop, a paste or a tool result. It cannot be made up, and it can be used once.', { nonBlank: true, maxLength: 64 }),
    links: param.list(
      'Where to place the picture once it is saved, at most 50.',
      targetParams('One placement: the project, a binder item, or one paragraph of a document.'),
      { maxItems: 50 },
    ),
    caption: param.string(`The caption, at most ${PICTURE_LIMITS.caption} characters.`, { maxLength: PICTURE_LIMITS.caption }),
    alt: param.string(`The alt text, at most ${PICTURE_LIMITS.alt} characters.`, { maxLength: PICTURE_LIMITS.alt }),
    source: param.object(
      'Where the picture came from.',
      {
        kind: param.choice('How it arrived.', ['import', 'paste', 'mcp', 'scan', 'agent']),
        label: param.string(`A short label, at most ${PICTURE_LIMITS.label} characters.`, { maxLength: PICTURE_LIMITS.label }),
        server: param.string('The tool server that returned it, for kind mcp.', { maxLength: PICTURE_LIMITS.label }),
        tool: param.string('The tool that returned it, for kind mcp.', { maxLength: PICTURE_LIMITS.label }),
      },
      ['kind'],
    ),
  },
  ['stagingId'],
);

interface ImportedItem {
  readonly assetId?: unknown;
  readonly path?: unknown;
  readonly created?: unknown;
  readonly linkIds?: unknown;
}

export const importPort: AsyncToolPort = async (params, context) => {
  const links: AssetTarget[] = [];
  for (const [index, raw] of list(params['links']).entries()) {
    const target = resolveTarget(context.state, raw, `links[${index}]`);
    if (!target.ok) return err(target.error);
    links.push(target.value);
  }
  const command: Record<string, unknown> = {
    stagingId: text(params, 'stagingId'),
    ...(links.length === 0 ? {} : { links }),
    ...(typeof params['caption'] === 'string' ? { caption: params['caption'] } : {}),
    ...(typeof params['alt'] === 'string' ? { alt: params['alt'] } : {}),
    ...(params['source'] === undefined ? {} : { source: params['source'] }),
  };

  const applied = await context.dispatchAsync('asset.import', command);
  if (!applied.ok) return err(applied.error);
  const outcome: ExecutionOutcome = applied.value;
  const result = record(outcome.result);
  const first = (Array.isArray(result['items']) ? result['items'][0] : result) as ImportedItem | undefined;
  const created = first?.created === true;
  return ok({
    data: {
      assetId: first?.assetId,
      path: first?.path,
      created,
      placements: first?.linkIds ?? [],
    },
    summary: created ? `saved the picture as ${String(first?.assetId)}` : `the same picture was already in the project as ${String(first?.assetId)}`,
    affected: [...outcome.affected],
    ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
  });
};

/* ------------------------------------------------------------------ *
 * pictures.view (async port, host-dependent)
 * ------------------------------------------------------------------ */

export const picturesViewParams: ObjectSpec = param.object(
  'The pictures to look at.',
  {
    assetIds: param.list(
      `One to ${VIEW_MAX_PICTURES} picture ids (a_…).`,
      param.string('One picture id.', { nonBlank: true, maxLength: 64 }),
      { minItems: 1, maxItems: VIEW_MAX_PICTURES, unique: true },
    ),
    maxPx: param.integer(`The longest side to send, in pixels, at most ${VIEW_MAX_EDGE}. Default ${VIEW_MAX_EDGE}. Smaller is cheaper and shows less detail.`, { minimum: 64, maximum: VIEW_MAX_EDGE }),
  },
  ['assetIds'],
);

export interface ViewedPicture {
  readonly bytes: Uint8Array;
  readonly mime: PictureMime;
  readonly width: number;
  readonly height: number;
}

/**
 * What `pictures.view` needs from the host. The harness has no decoder, no file access and no idea which model the turn runs on, so
 * each is the host's to say. Without a host the tool is not wired and is refused as such.
 */
export interface PictureViewHost {
  /** Whether the active model for this turn accepts image parts (the route's `caps.vision`). */
  readonly vision: () => boolean;
  /** One stored picture's bytes, by its project path (`assets/a_….png`), or `undefined` when the file is not there. */
  readonly readBytes: (path: string) => Promise<Uint8Array | undefined>;
  /**
   * Shrinks a picture so its long edge is at most `longEdge` (the resize-on-decode path). A host that cannot decode leaves it out,
   * and the tool then follows the non-resizing rule: stored bytes within the limits, or a refusal.
   */
  readonly resize?: (picture: ViewedPicture, longEdge: number) => Promise<ViewedPicture>;
  /** The transport's image limits for the active route. Default: the gateway's route-agnostic row. */
  readonly limits?: () => RouteImageLimits;
  /**
   * Hands the turn's loop the images to send. An image part is valid only on a `user` message (the gateway's rule), so the tool result
   * cannot carry one: the loop sends them in a user message after the tool results (`pictureViewMessage`).
   */
  readonly deliver: (turnId: string, images: readonly ImagePart[]) => void;
}

const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

function viewSummary(picture: ReadAssetRecord): Readonly<Record<string, unknown>> {
  return {
    id: picture.id,
    ...(picture.caption === undefined ? {} : { caption: picture.caption }),
    ...(picture.alt === undefined ? {} : { alt: picture.alt }),
    ...(picture.decorative === true ? { decorative: true } : {}),
    ...(picture.transcription?.text === undefined ? {} : { transcription: lead(picture.transcription.text, 1500) }),
  };
}

function tooBig(message: string, hint: string): Result<never, CommandError> {
  return err(limitExceeded(message, hint, 'assetIds'));
}

const CANNOT_SHRINK_REMEDY =
  'this host cannot shrink a picture: open the project in the Caotang app and store a working copy of it, or import a copy within the limit, then view it again';

export function viewPort(host: PictureViewHost): AsyncToolPort {
  return async (params: CallParams, context: PortContext) => {
    const ids = list(params['assetIds']).filter((id): id is string => typeof id === 'string');
    const maxPx = typeof params['maxPx'] === 'number' ? Math.min(params['maxPx'], VIEW_MAX_EDGE) : VIEW_MAX_EDGE;
    const pictures: ReadAssetRecord[] = [];
    for (const [index, id] of ids.entries()) {
      const found = isAssetId(id) ? pictureRecordOf(context.state, id) : undefined;
      if (found === undefined) return err(unknownPicture(id, `assetIds[${index}]`));
      pictures.push(found);
    }
    const summaries = pictures.map(viewSummary);

    if (!host.vision()) {
      const undescribed = pictures.filter((picture) => picture.caption === undefined && picture.alt === undefined && picture.transcription?.text === undefined);
      const notes = [
        'The active model does not accept images, so you are reading each picture’s stored description and not the picture itself. Do not describe what it looks like beyond what is written here.',
        ...(undescribed.length === 0 ? [] : [`${undescribed.map((picture) => picture.id).join(', ')} ${undescribed.length === 1 ? 'has' : 'have'} no caption, alt text or transcription, so there is nothing to read for ${undescribed.length === 1 ? 'it' : 'them'}`]),
      ];
      return ok({
        data: { pictures: summaries, images: 'none: text only' },
        summary: `read the descriptions of ${pictures.length} ${pictures.length === 1 ? 'picture' : 'pictures'}, as text`,
        affected: [],
        notes,
      });
    }

    const limits = host.limits?.() ?? imageLimitsFor(undefined);
    const parts: ImagePart[] = [];
    const sent: Readonly<Record<string, unknown>>[] = [];
    let total = 0;
    for (const [index, picture] of pictures.entries()) {
      const where = `assetIds[${index}]`;
      const file = assetFileName(picture.id, picture.mime as PictureMime);
      if (picture.file !== file) {
        return err(refusal('invalid-params', `the record of ${picture.id} names the file "${picture.file}", not ${file}, so it was not read`, { target: where, correctiveHint: 'the registry entry is damaged: ask the writer to check the picture in the Pictures board' }));
      }
      const stored = await host.readBytes(`${ASSETS_DIR}/${file}`);
      if (stored === undefined) {
        return err(notFound(`the file of ${picture.id} is missing from the project’s assets`, 'ask the writer to relink the picture, or read its description with pictures.list', where));
      }
      const sniffed = sniffPicture(stored);
      if (!sniffed.ok || sniffed.mime !== picture.mime) {
        return err(refusal('invalid-params', `the bytes of ${picture.id} are not the ${picture.mime} its record says, so it was not sent`, { target: where, correctiveHint: 'the file is damaged or was replaced: ask the writer to import it again' }));
      }
      const header = readPictureHeader(stored, sniffed.mime);
      if (!header.ok) {
        return tooBig(`the size of ${picture.id} could not be read from its file, so it could not be checked against the ${maxPx} px long edge and was not sent`, CANNOT_SHRINK_REMEDY);
      }

      let shown: ViewedPicture = { bytes: stored, mime: sniffed.mime, width: header.displayWidth, height: header.displayHeight };
      let how = 'as stored';
      const edge = Math.max(header.displayWidth, header.displayHeight);
      if (edge > maxPx) {
        if (host.resize === undefined) {
          return tooBig(
            `${picture.id} is ${header.displayWidth} × ${header.displayHeight} px, and its long edge of ${edge} px is over the ${maxPx} px that can be sent, so it was not sent. This host cannot shrink a picture.`,
            CANNOT_SHRINK_REMEDY,
          );
        }
        const resized = await host.resize(shown, maxPx);
        if (Math.max(resized.width, resized.height) > maxPx) {
          return tooBig(`${picture.id} came back from the host at ${resized.width} × ${resized.height} px, over the ${maxPx} px that can be sent, so it was not sent`, 'ask for a smaller maxPx, or tell the writer the host could not shrink the picture');
        }
        shown = resized;
        how = `downscaled from ${header.displayWidth} × ${header.displayHeight} to ${resized.width} × ${resized.height} px`;
      }
      if (shown.bytes.length > limits.maxImageBytes) {
        return tooBig(
          `${picture.id} is ${kib(shown.bytes.length)} (${shown.bytes.length} bytes) ${how === 'as stored' ? 'as stored' : 'after shrinking'}, over the ${kib(limits.maxImageBytes)} (${limits.maxImageBytes} bytes) one picture may be sent, so it was not sent`,
          how === 'as stored' && host.resize === undefined ? CANNOT_SHRINK_REMEDY : 'ask for a smaller maxPx, or tell the writer to import a smaller copy',
        );
      }
      total += shown.bytes.length;
      if (total > limits.maxTotalBytes) {
        return tooBig(`these pictures are ${kib(total)} together, over the ${kib(limits.maxTotalBytes)} one message may carry, so none was sent`, 'view them one or two at a time');
      }
      const label = picture.caption ?? picture.alt;
      parts.push({
        type: 'image',
        mime: shown.mime,
        bytes: shown.bytes,
        hash: await sha256Hex(shown.bytes),
        size: shown.bytes.length,
        ...(label === undefined ? {} : { caption: label }),
      });
      sent.push({ id: picture.id, width: shown.width, height: shown.height, bytes: shown.bytes.length, sent: how });
    }

    host.deliver(context.turnId, parts);
    return ok({
      data: { pictures: summaries, images: sent },
      summary: `${parts.length === 1 ? 'one picture' : `${parts.length} pictures`} attached to the next message, ${sent.every((entry) => entry['sent'] === 'as stored') ? 'as stored' : 'some shrunk'}`,
      affected: [],
      notes: ['The pictures follow this result in the next message, in the order asked.'],
    });
  };
}

/**
 * Where a host collects the images `pictures.view` produced until the loop sends them. The loop takes a turn's images after it has
 * pushed that turn's tool results and sends them in one user message (`pictureViewMessage`): the gateway refuses an image on any other role.
 */
export interface PictureOutbox {
  readonly deliver: (turnId: string, images: readonly ImagePart[]) => void;
  /** Takes and clears what was delivered for a turn, in delivery order. */
  readonly take: (turnId: string) => readonly ImagePart[];
}

export function createPictureOutbox(): PictureOutbox {
  const held = new Map<string, ImagePart[]>();
  return {
    deliver: (turnId, images) => {
      held.set(turnId, [...(held.get(turnId) ?? []), ...images]);
    },
    take: (turnId) => {
      const taken = held.get(turnId) ?? [];
      held.delete(turnId);
      return taken;
    },
  };
}

/** The user message that carries the images a view produced. The text names each so the model can tell them apart. */
export function pictureViewMessage(images: readonly ImagePart[]): ChatMessage {
  const names = images.map((image, index) => `${index + 1}. ${image.caption ?? 'no caption'}`).join('\n');
  return { role: 'user', content: [{ type: 'text', text: `The pictures pictures.view returned, in the order asked:\n${names}` }, ...images] };
}

/* ------------------------------------------------------------------ *
 * What the registry joins
 * ------------------------------------------------------------------ */

/** The async ports of the picture tools. `pictures.import` needs only the bus; `pictures.view` is wired when a host says how to read and show a picture. */
export function picturePorts(host?: PictureViewHost): Readonly<Partial<Record<PortToolName, AsyncToolPort>>> {
  return {
    'pictures.import': importPort,
    ...(host === undefined ? {} : { 'pictures.view': viewPort(host) }),
  };
}

type PictureDefinition =
  | { readonly kind: 'native'; readonly params: ObjectSpec; readonly prepare: PrepareFn; readonly refine?: (params: CallParams) => CommandError | undefined }
  | { readonly kind: 'port'; readonly port: PortToolName; readonly params: ObjectSpec };

/** The registry definitions, in `table.ts`'s `Definition` shape, keyed by tool name. */
export const PICTURE_DEFINITIONS: Readonly<Record<PictureToolName, PictureDefinition>> = {
  'pictures.list': { kind: 'native', params: picturesListParams, prepare: prepareList },
  'pictures.view': { kind: 'port', port: 'pictures.view', params: picturesViewParams },
  'pictures.annotate': { kind: 'native', params: picturesAnnotateParams, prepare: prepareAnnotate },
  'pictures.attach': { kind: 'native', params: picturesAttachParams, prepare: prepareAttach, refine: refineAttach },
  'pictures.import': { kind: 'port', port: 'pictures.import', params: picturesImportParams },
  'pictures.place': { kind: 'native', params: picturesPlaceParams, prepare: preparePlace },
  'pictures.transcribe': { kind: 'port', port: 'pictures.transcribe', params: transcriptionParams },
};

/** The write-auto tools `ACCEPT_EDITS_TOOLS` takes (pictures.md §8.1). The other four are not in it. */
export const PICTURE_ACCEPT_EDITS_TOOLS: readonly PictureToolName[] = ['pictures.annotate', 'pictures.attach'];
