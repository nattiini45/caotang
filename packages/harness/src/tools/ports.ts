/**
 * The port tools' params. Each tool declares its params here, so the registry, its schema and the MCP
 * listing are complete whether or not an implementation has been injected (agent-harness §3, codex.md §7).
 *
 * The implementations live elsewhere. `codex.read`, `scene.draft`, `synopsis.fill`, `continuity.scan`,
 * `shots.derive`, `prompt.draft` and `prompt.variant` are in `agent/ports.ts`, and the app injects them through `createAgentPorts`. `shots.annotate` is in
 * `tools/storyboard.ts`, wired where the store registry carries the shot commands. A port tool with no
 * injected implementation is refused with the not-wired error, and `ToolListing.wired` reports that, so a
 * caller sees the refusal before it calls the tool.
 *
 * `refine` is written for `scene.draft` because its cross-field rule is a
 * property of the call, not of the provider. The validator runs on every call,
 * so a `rewrite_selection` with no anchor is refused before the port is reached.
 */

import { DEFAULT_MAX_OUTPUT_TOKENS } from '@caotang/context';
import { CODEX_INCLUDE_POLICIES, CODEX_TYPES } from '@caotang/store';

import { param, type ObjectSpec } from '../schema.js';
import { charBudget } from '../tokens.js';
import type { CallParams } from '../types.js';
import { invalidParams } from '../errors.js';
import type { CommandError } from '@caotang/bus';

const CODEX_LIST_MAX = 100;

export const codexReadParams: ObjectSpec = param.object(
  'How to find codex entries.',
  {
    query: param.string('A case-insensitive substring to match against names, aliases and descriptions.', { nonBlank: true }),
    type: param.choice('Only entries of this type, or all.', [...CODEX_TYPES, 'all'], { default: 'all' }),
    includePolicy: param.choice('Only entries with this policy, or all.', [...CODEX_INCLUDE_POLICIES, 'all'], { default: 'all' }),
    id: param.string('An exact entry id. Returns that entry with its full description.', { nonBlank: true }),
    limit: param.integer(`How many entries to return: 1 to ${CODEX_LIST_MAX}.`, {
      minimum: 1,
      maximum: CODEX_LIST_MAX,
      default: 25,
    }),
  },
  [],
);

const ANCHOR_TEXT_MAX = 2000;
const ANCHOR_CONTEXT_MAX = 32;

/** edit-anchors.md §2's `TextAnchor`, as the call carries it. */
export const textAnchorSpec = param.object(
  'A range in the body projection, captured from the editor selection.',
  {
    from: param.integer('Start offset, 0-indexed, inclusive.', { minimum: 0 }),
    to: param.integer('End offset, exclusive. Greater than from.', { minimum: 0 }),
    exact: param.string(`The text between from and to, 1 to ${ANCHOR_TEXT_MAX} characters.`, { maxLength: ANCHOR_TEXT_MAX }),
    prefix: param.string(`Up to ${ANCHOR_CONTEXT_MAX} characters before from.`, { maxLength: ANCHOR_CONTEXT_MAX }),
    suffix: param.string(`Up to ${ANCHOR_CONTEXT_MAX} characters after to.`, { maxLength: ANCHOR_CONTEXT_MAX }),
    capturedRevision: param.integer('The document revision when the anchor was captured.', { minimum: 0 }),
  },
  ['from', 'to', 'exact', 'prefix', 'suffix', 'capturedRevision'],
);

export const sceneDraftParams: ObjectSpec = param.object(
  'The document to draft into, the brief, and how to write.',
  {
    doc: param.string('The document: a title, or an id.', { nonBlank: true }),
    instruction: param.string('The creative brief.', { nonBlank: true }),
    target_words: param.integer('The length to aim for, in words.', { minimum: 1 }),
    mode: param.choice(
      'draft replaces an empty body; continue appends; rewrite_selection replaces the anchored range.',
      ['draft', 'continue', 'rewrite_selection'],
      { default: 'draft' },
    ),
    selection: textAnchorSpec,
    include_forward_outline: param.boolean(
      'Include the synopses of the later scenes in the drafting context. Off by default; turn it on when the draft must lead into what follows.',
      { default: false },
    ),
  },
  ['doc', 'instruction'],
);

/**
 * `rewrite_selection` names a range, and a range is an anchor. Without one the
 * call has nothing to rewrite, and a malformed anchor is refused here rather than
 * at apply time.
 */
export function refineSceneDraft(params: CallParams): CommandError | undefined {
  const mode = typeof params['mode'] === 'string' ? params['mode'] : 'draft';
  const anchor = params['selection'] as { from: number; to: number; exact: string } | undefined;
  if (mode === 'rewrite_selection' && anchor === undefined) {
    return invalidParams(
      'mode rewrite_selection needs a selection anchor, and none was given',
      'select text in the editor first, or pass a selection anchor',
      'params.selection',
    );
  }
  if (anchor !== undefined) {
    if (anchor.to <= anchor.from) {
      return invalidParams(
        `selection.to (${anchor.to}) must be greater than selection.from (${anchor.from})`,
        'an anchor covers at least one character: to is exclusive',
        'params.selection.to',
      );
    }
    // Offsets are UTF-16 code units (edit-anchors §2), so the text is measured the same way.
    if (anchor.exact.length !== anchor.to - anchor.from) {
      return invalidParams(
        `selection.exact is ${anchor.exact.length} characters, but from to to spans ${anchor.to - anchor.from}`,
        'capture the anchor again: exact must be the text between from and to',
        'params.selection.exact',
      );
    }
  }
  return undefined;
}

/** context-assembly §3: continuity.scan checks at most this many documents in one call. */
export const CONTINUITY_MAX_DOCS = 20;

/** One synopsis.fill call drafts one synopsis per document, one model call each, so it names at most this many. */
export const SYNOPSIS_MAX_DOCS = 20;

export const synopsisFillParams: ObjectSpec = param.object(
  'The documents to draft synopses for, and how.',
  {
    docs: param.list(
      `Documents to draft a synopsis for: a title or an id each, at most ${SYNOPSIS_MAX_DOCS} per call.`,
      param.string('One document: a title, or an id.', { nonBlank: true }),
      { minItems: 1, maxItems: SYNOPSIS_MAX_DOCS },
    ),
    source: param.choice('What to draft from: the text, the notes, or both.', ['text', 'notes', 'both'], { default: 'both' }),
    max_words: param.integer('The longest synopsis to draft, in words.', { minimum: 1, default: 50 }),
  },
  ['docs'],
);

export const continuityScanParams: ObjectSpec = param.object(
  'Which documents to check, and for what.',
  {
    scope: param.list(
      `Documents to check: titles or ids, at most ${CONTINUITY_MAX_DOCS}. Omit for the whole manuscript, which must hold ${CONTINUITY_MAX_DOCS} documents or fewer.`,
      param.string('One document: a title, or an id.', { nonBlank: true }),
      { maxItems: CONTINUITY_MAX_DOCS },
    ),
    aspects: param.list(
      'What to check: timeline, characters, props or custom. Omit for all of them.',
      param.choice('One aspect.', ['timeline', 'characters', 'props', 'custom']),
      { unique: true },
    ),
  },
  [],
);

/* ------------------------------------------------------------------ *
 * The host-model pairs (agent-harness §3, "External-only rows"). A brief takes the arguments of the in-app tool it stands for, so a
 * host that knows `scene.draft` knows `scene.brief`; an apply takes the host's reply and the handle the brief minted.
 * ------------------------------------------------------------------ */

/** The longest reply an apply takes: the output limit a model call is held to in the app (context's `DEFAULT_MAX_OUTPUT_TOKENS`), as characters. */
export const BRIEF_REPLY_MAX_CHARS = charBudget(DEFAULT_MAX_OUTPUT_TOKENS);

const BRIEF_ID = param.string('The briefId the brief returned. A brief expires after 30 minutes, or when the text it was made from changes.', { nonBlank: true });

const REPLY_OVERFLOW = 'write a shorter passage, apply it, and ask for a new brief to carry on from where it ends';

export const sceneBriefParams: ObjectSpec = sceneDraftParams;

export const sceneApplyParams: ObjectSpec = param.object(
  'The text you wrote, where it goes, and the brief it answers.',
  {
    doc: param.string('The document of the brief: a title, or an id.', { nonBlank: true }),
    text: param.string(`The text, at most ${BRIEF_REPLY_MAX_CHARS} characters: the prose (or Fountain) only, with no preamble.`, {
      nonBlank: true,
      maxLength: BRIEF_REPLY_MAX_CHARS,
      overflowHint: REPLY_OVERFLOW,
    }),
    mode: param.choice(
      'The mode of the brief. draft replaces an empty body; continue appends; rewrite_selection replaces the anchored range.',
      ['draft', 'continue', 'rewrite_selection'],
      { default: 'draft' },
    ),
    selection: textAnchorSpec,
    briefId: BRIEF_ID,
  },
  ['doc', 'text', 'briefId'],
);

export const dialogueBriefParams: ObjectSpec = param.object(
  'The container, the brief, and where the draft goes.',
  {
    doc: param.string('The dialogue container, by title or id.', { nonBlank: true }),
    instruction: param.string('The creative brief for the beats.', { nonBlank: true }),
    fromBeats: param.list(
      'Knot or stitch ids to continue from. The draft goes after the last one. Omit to append at the end.',
      param.string('A knot id, or knot.stitch.', { nonBlank: true }),
      { maxItems: 20, unique: true },
    ),
    target_lines: param.integer('A hint for the drafting prompt: about how many spoken lines to write.', { minimum: 1, maximum: 200 }),
  },
  ['doc', 'instruction'],
);

export const dialogueApplyParams: ObjectSpec = param.object(
  'The Ink you wrote, where it goes, and the brief it answers.',
  {
    doc: param.string('The container of the brief, by title or id.', { nonBlank: true }),
    ink: param.string(`The Ink, at most ${BRIEF_REPLY_MAX_CHARS} characters: the Ink only, with no commentary and no code fence.`, {
      nonBlank: true,
      maxLength: BRIEF_REPLY_MAX_CHARS,
      overflowHint: REPLY_OVERFLOW,
    }),
    fromBeats: param.list(
      'The knot or stitch ids of the brief. The Ink goes after the last one. Omit to append at the end.',
      param.string('A knot id, or knot.stitch.', { nonBlank: true }),
      { maxItems: 20, unique: true },
    ),
    briefId: BRIEF_ID,
  },
  ['doc', 'ink', 'briefId'],
);
