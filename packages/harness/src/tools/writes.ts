/**
 * The two write tools the spec marks `write-auto`: `meta.set` and `notes.append`
 * (agent-harness §3 rows 5–6, §4 "Auto").
 *
 * Both validate the whole batch through the bus's own `validate` in `prepare`, so
 * a batch with one bad target writes nothing and says which target it was.
 */

import { ok, type CommandError, type Result } from '@caotang/bus';

import { failure, invalidParams } from '../errors.js';
import { resolveNode, TARGET, DOCUMENT } from '../resolve.js';
import { param, type ObjectSpec } from '../schema.js';
import type { CallParams, PreparedCall, PrepareContext, PreparedCommand } from '../types.js';
import { batchRefusal, checkCommand, titleOf } from './common.js';

/** agent-harness §3 row 5: at most 50 targets. Over that, the caller splits the call. */
const META_TARGETS_MAX = 50;
const KEYWORDS_MAX = 32;
const KEYWORD_CHARS_MAX = 64;
/** agent-harness §3 row 6: `notes.append` carries at most 2000 characters. */
const NOTES_APPEND_MAX = 2000;

export const metaSetParams: ObjectSpec = param.object(
  'The documents or folders to change, and the metadata to set on each.',
  {
    targets: param.list(
      'Documents or folders to change: a title or an id each. At most 50 per call.',
      param.string('One target: a title, or an id.', { nonBlank: true }),
      { minItems: 1, maxItems: META_TARGETS_MAX },
    ),
    status: param.string('A status id from the project vocabulary.', { nonBlank: true }),
    label: param.string('A label id from the project vocabulary.', { nonBlank: true }),
    keywords_add: param.list(
      'Keywords to add to each target. A keyword already present is left as it is.',
      param.string('One keyword.', { nonBlank: true, maxLength: KEYWORD_CHARS_MAX }),
      { maxItems: KEYWORDS_MAX },
    ),
    keywords_remove: param.list(
      'Keywords to remove from each target. A keyword not present is ignored.',
      param.string('One keyword.', { nonBlank: true, maxLength: KEYWORD_CHARS_MAX }),
      { maxItems: KEYWORDS_MAX },
    ),
  },
  ['targets'],
);

export function refineMetaSet(params: CallParams): CommandError | undefined {
  const sets = ['status', 'label', 'keywords_add', 'keywords_remove'].some((key) => params[key] !== undefined);
  if (sets) return undefined;
  return invalidParams(
    'meta.set has nothing to set: pass at least one of status, label, keywords_add or keywords_remove',
    'name the metadata to change, then resend',
    'params',
  );
}

export function prepareMetaSet(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const refs = Array.isArray(params['targets']) ? (params['targets'] as readonly string[]) : [];

  const failures: { target: string; error: CommandError }[] = [];
  const nodeIds: string[] = [];
  for (const [index, ref] of refs.entries()) {
    const node = resolveNode(state, ref, TARGET, 'document or folder', `targets[${index}]`);
    if (!node.ok) {
      failures.push({ target: `targets[${index}]`, error: node.error });
      continue;
    }
    if (!nodeIds.includes(node.value.id)) nodeIds.push(node.value.id);
  }

  // The patch is built from the keys the caller sent, so an absent key stays
  // absent and the bus leaves that field alone (`binder.setMeta`'s rule).
  const patch: Record<string, unknown> = {};
  if (typeof params['status'] === 'string') patch['status'] = params['status'];
  if (typeof params['label'] === 'string') patch['label'] = params['label'];
  if (Array.isArray(params['keywords_add'])) patch['keywords_add'] = [...(params['keywords_add'] as string[])];
  if (Array.isArray(params['keywords_remove'])) patch['keywords_remove'] = [...(params['keywords_remove'] as string[])];

  const commands: PreparedCommand[] = [];
  for (const [index, nodeId] of nodeIds.entries()) {
    const command = { nodeId, patch };
    const checked = checkCommand(context, 'binder.setMeta', command);
    if (!checked.ok) {
      failures.push({ target: `targets[${index}]`, error: checked.error });
      continue;
    }
    commands.push({ name: 'binder.setMeta', params: command });
  }

  if (failures.length > 0) {
    return failure(
      batchRefusal(failures, refs.length, 'fix every listed target and resend the whole call — nothing was written'),
    ) as Result<PreparedCall, CommandError>;
  }

  return ok({
    commands,
    finish: (done) => {
      const changed = done.flatMap((entry) => [...entry.outcome.affected]);
      const names = changed.map((node) => `"${node.title}"`).join(', ');
      return ok({
        data: { changed: changed.map((node) => ({ id: node.nodeId, title: node.title })), patch },
        summary: `set metadata on ${changed.length} ${changed.length === 1 ? 'node' : 'nodes'}: ${names}`,
        affected: changed,
        ...(done[0]?.outcome.undoGroupId === undefined ? {} : { undoGroupId: done[0].outcome.undoGroupId }),
      });
    },
  });
}

export const notesAppendParams: ObjectSpec = param.object(
  'The document, and the text to append to its notes.',
  {
    doc: param.string('The document: a title, or an id. An ambiguous title lists its candidates.', { nonBlank: true }),
    text: param.string(`The text to append, at most ${NOTES_APPEND_MAX} characters.`, {
      nonBlank: true,
      maxLength: NOTES_APPEND_MAX,
      overflowHint:
        'split the text into calls of at most 2000 characters each, or rewrite the whole notes with notes.replace, which asks the writer to confirm — call tool.search for notes.replace to load it',
    }),
  },
  ['doc', 'text'],
);

export function prepareNotesAppend(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const ref = typeof params['doc'] === 'string' ? params['doc'] : '';
  const node = resolveNode(state, ref, DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return failure(node.error) as Result<PreparedCall, CommandError>;

  const text = typeof params['text'] === 'string' ? params['text'] : '';
  const command = { nodeId: node.value.id, text, divider: true };
  const checked = checkCommand(context, 'notes.append', command);
  if (!checked.ok) return failure(checked.error) as Result<PreparedCall, CommandError>;

  return ok({
    commands: [{ name: 'notes.append', params: command }],
    finish: (done) => {
      const outcome = done[0]?.outcome;
      return ok({
        data: { doc: { id: node.value.id, title: titleOf(state, node.value.id) }, appended: text.length },
        summary: `appended ${text.length} characters to the notes of "${node.value.title}"`,
        affected: outcome === undefined ? [] : [...outcome.affected],
        ...(outcome?.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
      });
    },
  });
}
