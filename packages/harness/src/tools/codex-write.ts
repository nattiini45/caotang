/**
 * `codex.write` — agent-harness.md §3 row 13, write-confirm, one undo group.
 *
 * **How a batch becomes commands.** A create, and its attach or detach, travel in
 * one `codex.upsert` op: the bus mints the new entry's id inside that command, so
 * the attachment has to be part of the same op. An update's field changes go in
 * the same `codex.upsert`. An update's attach and detach go as their own
 * `codex.attach` commands, which the bus records as exact inverses (command-bus §9:
 * "also composed inside `codex.write` batches"). An update with nothing to change
 * sends no upsert at all, because the bus stamps `updatedAt` on every update, and
 * a no-op update must not leave a timestamp behind.
 *
 * **Over-long descriptions are refused, with the proposed truncation.** codex.md
 * §7 says a truncation is *proposed*, never silent. So a description over 2000
 * characters fails the batch, and the failure carries the first 2000 characters as
 * `details.proposals[]`. The caller can resend the call with that text, or drop
 * it. Nothing is cut here.
 *
 * **Two sizes of the same diff.** `preview.entries` is the plan card's: each
 * entry's old→new diff with the full text, because a card that hides what it asks
 * to write is the thing codex.md §7 forbids. The response carries each text value
 * cut to a 200-character preview, and only as many diffs as fit its cap, with the
 * number left out stated (`diffsOmitted`).
 */

import {
  CODEX_ALIAS_CHARS_MAX,
  CODEX_ALIASES_MAX,
  CODEX_DESCRIPTION_MAX,
  CODEX_DETAIL_DIFF_PREFIX,
  CODEX_EXCLUDE_CHARS_MAX,
  CODEX_EXCLUDE_MAX,
  CODEX_NAME_MAX,
  CODEX_REFERENCE_FIELDS,
  CODEX_REFERENCE_MAX,
  CODEX_RELATION_MAX,
  readCodexReference,
  readCodexRelation,
  CODEX_VISUAL_REFS_MAX,
  ok,
  type CommandError,
  type Result,
} from '@caotang/bus';
import { CODEX_INCLUDE_POLICIES, type ProjectState } from '@caotang/store';

import { failure, invalidParams, limitExceeded, notFound, refusal } from '../errors.js';
import { capOf } from '../metadata.js';
import { param, type ObjectSpec } from '../schema.js';
import { fitsCap } from '../tokens.js';
import type { CallParams, CommandDone, PreparedCall, PreparedCommand, PrepareContext, ToolValue } from '../types.js';
import { codePointLength, firstCodePoints, isRecord } from '../util.js';
import { batchRefusal, checkCommand, policyFlags } from './common.js';

/** codex.md §7: at most 20 entries per call. */
const CODEX_BATCH_MAX = 20;
/** codex.md §2: a description is at most 2000 characters. Enforced here as a refusal with a proposal. */
const DESCRIPTION_MAX = CODEX_DESCRIPTION_MAX;
const PREVIEW_CHARS = 200;

const CREATE_KEYS = ['action', 'name', 'aliases', 'type', 'description', 'includePolicy', 'caseSensitive', 'exclude', 'attachTo', 'detachFrom', 'visualRefs', 'details', 'referenceEdits'];

export const codexWriteParams: ObjectSpec = param.object(
  'Codex writes.',
  {
    entries: param.list(
      'Validate the whole batch before writing.',
      param.object(
        'One entry.',
        {
          action: param.choice('Create or update.', ['create', 'update']),
          id: param.string('The id of the entry to update. Required for an update; not set on a create.', { nonBlank: true }),
          name: param.string(`The entry name, at most ${CODEX_NAME_MAX} characters. Required on a create.`, {
            nonBlank: true,
            maxLength: CODEX_NAME_MAX,
          }),
          aliases: param.list(
            `Other names the entry is found by, at most ${CODEX_ALIASES_MAX}.`,
            param.string('One alias.', { nonBlank: true, maxLength: CODEX_ALIAS_CHARS_MAX }),
            { maxItems: CODEX_ALIASES_MAX },
          ),
          type: param.string('Built-in or project-defined entry type.', { nonBlank: true }),
          description: param.string(
            `The entry description. At most ${DESCRIPTION_MAX} characters; a longer one fails the batch with a proposed truncation.`,
          ),
          includePolicy: param.choice(
            'When the entry is included in the context of a generation call.',
            [...CODEX_INCLUDE_POLICIES],
          ),
          caseSensitive: param.boolean('Whether the name and aliases match case-sensitively.'),
          details: param.freeObject('Details by key; null clears.'),
          referenceEdits: param.list(
            'External refs.',
            param.freeObject('action: create/update/remove; title on create; id on update/remove; url/publisher/date/quote (date YYYY-MM-DD, null clears).'),
            { minItems: 1, maxItems: CODEX_REFERENCE_MAX },
          ),
          relationEdits: param.list(
            'Entry links.',
            param.freeObject('create: targetId; update/remove: id; label, null clears.'),
            { minItems: 1, maxItems: CODEX_RELATION_MAX },
          ),
          exclude: param.list(
            `Phrases in which matches are ignored, at most ${CODEX_EXCLUDE_MAX}.`,
            param.string('One excluded phrase.', { nonBlank: true, maxLength: CODEX_EXCLUDE_CHARS_MAX }),
            { maxItems: CODEX_EXCLUDE_MAX },
          ),
          attachTo: param.list('Binder node ids to attach the entry to.', param.string('One node id.', { nonBlank: true })),
          detachFrom: param.list('Binder node ids to detach the entry from.', param.string('One node id.', { nonBlank: true })),
          visualRefs: param.list(
            'Project image ids; replaces the list.',
            param.string('One image asset id.', { nonBlank: true }),
            { maxItems: CODEX_VISUAL_REFS_MAX },
          ),
        },
        ['action'],
      ),
      { minItems: 1, maxItems: CODEX_BATCH_MAX },
    ),
  },
  ['entries'],
);

interface Proposal {
  readonly index: number;
  readonly name: string;
  readonly length: number;
  readonly limit: number;
  readonly proposedDescription: string;
}

function preview(text: string): string {
  return codePointLength(text) > PREVIEW_CHARS ? `${firstCodePoints(text, PREVIEW_CHARS)}…` : text;
}

function definedFields(entry: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (entry[key] !== undefined) out[key] = entry[key];
  return out;
}

/**
 * A create's diff for the plan card: every field the new entry will hold, whole (codex.md §7: "create =
 * full proposed content"), the node it attaches to, and the flags the writer must see before approving.
 * The response gets a shortened copy (`shortenDiff`), never this one.
 */
function createDiff(entry: Record<string, unknown>): Record<string, unknown> {
  const attach = Array.isArray(entry['attachTo']) ? (entry['attachTo'] as string[]) : [];
  const flags = policyFlags(undefined, entry['includePolicy']);
  return {
    action: 'create',
    name: entry['name'],
    ...definedFields(entry, ['type', 'description', 'aliases', 'includePolicy', 'caseSensitive', 'exclude', 'visualRefs', 'details', 'referenceEdits']),
    ...(attach.length === 0 ? {} : { attach }),
    ...(flags.length === 0 ? {} : { flags }),
  };
}

/**
 * The entry with its picture list as the store will keep it: a picture named twice is one reference (video-prompt-pack.md §3). The
 * preview and the upsert both read this copy, so the plan card shows the list the store saves, and not the repeats the store drops.
 */
function withoutRepeatPictures(entry: Record<string, unknown>): Record<string, unknown> {
  const refs = entry['visualRefs'];
  return Array.isArray(refs) ? { ...entry, visualRefs: [...new Set(refs as unknown[])] } : entry;
}

function existingEntry(state: ProjectState, id: string) {
  return (state.manifest.codex ?? []).find((entry) => entry.id === id);
}

export function prepareCodexWrite(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const entries = Array.isArray(params['entries']) ? (params['entries'] as readonly unknown[]) : [];
  const failures: { target: string; error: CommandError }[] = [];
  const proposals: Proposal[] = [];

  /** The upsert's ops, and the input index each came from, so a bus failure can name the caller's entry. */
  const upsertOps: Record<string, unknown>[] = [];
  const upsertInput: number[] = [];
  const attachCommands: { index: number; params: Record<string, unknown> }[] = [];
  const diffs: Record<string, unknown>[] = [];

  for (const [index, raw] of entries.entries()) {
    const target = `entries[${index}]`;
    if (!isRecord(raw)) {
      failures.push({ target, error: invalidParams(`${target} must be an object`, 'pass each entry as an object', target) });
      continue;
    }
    const entry = withoutRepeatPictures(raw);
    const attachTo = Array.isArray(entry['attachTo']) ? (entry['attachTo'] as string[]) : [];
    const detachFrom = Array.isArray(entry['detachFrom']) ? (entry['detachFrom'] as string[]) : [];

    if (entry['action'] === 'create') {
      if (entry['id'] !== undefined) {
        failures.push({
          target,
          error: invalidParams(
            `${target}.id is set on a create, but a create mints its own id`,
            'drop id — the id is assigned when the entry is written. To change an existing entry, send an update with its id',
            `${target}.id`,
          ),
        });
        continue;
      }
      if (typeof entry['name'] !== 'string') {
        failures.push({
          target,
          error: invalidParams(
            `${target}.name is required on a create`,
            'pass a non-blank name — codex.md §2 requires one, and an entry is looked up by its name',
            `${target}.name`,
          ),
        });
        continue;
      }
    }

    if (entry['action'] === 'update') {
      const id = entry['id'];
      if (typeof id !== 'string') {
        failures.push({
          target,
          error: invalidParams(`${target}.id is required on an update`, 'use codex.read with a query to find the entry id', `${target}.id`),
        });
        continue;
      }
      if (existingEntry(state, id) === undefined) {
        failures.push({
          target,
          error: notFound(`no codex entry with id "${id}"`, 'use codex.read with a query to find the entry', `${target}.id`),
        });
        continue;
      }
    }

    const both = attachTo.filter((id) => detachFrom.includes(id));
    if (both.length > 0) {
      failures.push({
        target,
        error: invalidParams(
          `node "${both[0]}" is in both attachTo and detachFrom, which asks for two opposite results`,
          'name a node in attachTo or in detachFrom, not both',
          `${target}.attachTo`,
        ),
      });
      continue;
    }

    const description = entry['description'];
    if (typeof description === 'string' && codePointLength(description) > DESCRIPTION_MAX) {
      const name = typeof entry['name'] === 'string' ? entry['name'] : existingEntry(state, String(entry['id']))?.name ?? '';
      const proposal: Proposal = {
        index,
        name,
        length: codePointLength(description),
        limit: DESCRIPTION_MAX,
        proposedDescription: firstCodePoints(description, DESCRIPTION_MAX),
      };
      proposals.push(proposal);
      failures.push({
        target: `${target}.description`,
        error: limitExceeded(
          `the description is ${proposal.length} characters, limit ${DESCRIPTION_MAX}`,
          `resend with a description of at most ${DESCRIPTION_MAX} characters — the proposed truncation is in details.proposals`,
          `${target}.description`,
        ),
      });
      continue;
    }

    if (entry['action'] === 'create') {
      upsertOps.push({ action: 'create', ...definedFields(entry, CREATE_KEYS.filter((key) => key !== 'action')) });
      upsertInput.push(index);
      diffs.push(createDiff(entry));
      continue;
    }

    // An update: its field changes go in the upsert, its attachments as codex.attach.
    const id = String(entry['id']);
    const fields = definedFields(entry, ['name', 'aliases', 'type', 'description', 'includePolicy', 'caseSensitive', 'exclude', 'visualRefs', 'details', 'referenceEdits', 'relationEdits']);
    if (isRecord(fields['details']) && Object.keys(fields['details']).length === 0) delete fields['details'];
    const before = existingEntry(state, id);
    const changes: { field: string; from: string; to: string }[] = [];
    for (const [field, value] of Object.entries(fields)) {
      if (field === 'details' && isRecord(value)) {
        for (const [key, next] of Object.entries(value)) {
          const old = Object.hasOwn(before?.details ?? {}, key) ? before?.details?.[key] : undefined;
          changes.push({ field: `${CODEX_DETAIL_DIFF_PREFIX}${key}`, from: JSON.stringify(old ?? null), to: JSON.stringify(next) });
        }
        continue;
      }
      if (field === 'relationEdits' && Array.isArray(value)) {
        const edits = value.filter(isRecord).map((edit) => {
          const existing = before?.relations?.map(readCodexRelation).find((relation) => relation?.id === edit['id']);
          const target = typeof edit['targetId'] === 'string' ? state.manifest.codex?.find((candidate) => candidate.id === edit['targetId'])?.name : undefined;
          return { ...definedFields(edit, ['action', 'targetId', 'label']), ...(existing === undefined ? {} : { previousTarget: existing.targetId }), ...(target === undefined ? {} : { targetName: target }) };
        });
        changes.push({ field: 'relations', from: 'null', to: JSON.stringify(edits) });
        continue;
      }
      if (field === 'referenceEdits' && Array.isArray(value)) {
        const edits = value.filter(isRecord).map((edit) => {
          const existing = before?.references?.map(readCodexReference).find((reference) => reference?.id === edit['id']);
          return { ...definedFields(edit, ['action', ...CODEX_REFERENCE_FIELDS]), ...(existing === undefined ? {} : { previousTitle: existing.title }) };
        });
        const held = (before?.references ?? []).flatMap((reference) => {
          const read = readCodexReference(reference);
          return read === undefined ? [] : [read];
        });
        changes.push({ field: 'references', from: JSON.stringify(held), to: JSON.stringify(edits) });
        continue;
      }
      const old = before === undefined ? undefined : (before as unknown as Record<string, unknown>)[field];
      changes.push({ field, from: JSON.stringify(old ?? null), to: JSON.stringify(value) });
    }
    if (Object.keys(fields).length > 0) {
      upsertOps.push({ action: 'update', id, ...fields });
      upsertInput.push(index);
    }
    if (attachTo.length > 0 || detachFrom.length > 0) {
      attachCommands.push({ index, params: { entryId: id, attachTo, detachFrom } });
    }
    const policy = fields['includePolicy'] === undefined ? [] : policyFlags(before?.includePolicy, fields['includePolicy']);
    diffs.push({
      action: 'update',
      id,
      name: before?.name ?? '',
      changes,
      ...(attachTo.length > 0 ? { attach: attachTo } : {}),
      ...(detachFrom.length > 0 ? { detach: detachFrom } : {}),
      ...(policy.length === 0 ? {} : { flags: policy }),
    });
  }

  if (failures.length > 0) {
    const batch = batchRefusal(failures, entries.length, 'fix every listed entry and resend the whole batch — nothing was written');
    return failure({
      ...batch,
      details: { ...batch.details, ...(proposals.length === 0 ? {} : { proposals }) },
    }) as Result<PreparedCall, CommandError>;
  }

  const commands: PreparedCommand[] = [];
  if (upsertOps.length > 0) {
    const upsert = { entries: upsertOps };
    const checked = checkCommand(context, 'codex.upsert', upsert);
    if (!checked.ok) {
      const inner = checked.error.details?.['failures'];
      const mapped = Array.isArray(inner)
        ? (inner as { target: string; code: CommandError['code']; message: string; correctiveHint?: string }[]).map((failureRow) => {
            const position = Number(/^entries\[(\d+)\]/.exec(failureRow.target)?.[1] ?? 0);
            const input = upsertInput[position] ?? position;
            return {
              target: `entries[${input}]`,
              error: refusal(failureRow.code, failureRow.message, {
                ...(failureRow.correctiveHint === undefined ? {} : { correctiveHint: failureRow.correctiveHint }),
              }),
            };
          })
        : [{ target: 'entries', error: checked.error }];
      return failure(batchRefusal(mapped, entries.length, 'fix every listed entry and resend the whole batch — nothing was written')) as Result<
        PreparedCall,
        CommandError
      >;
    }
    commands.push({ name: 'codex.upsert', params: upsert });
  }
  for (const attach of attachCommands) {
    const checked = checkCommand(context, 'codex.attach', attach.params);
    if (!checked.ok) {
      return failure(
        batchRefusal(
          [{ target: `entries[${attach.index}]`, error: checked.error }],
          entries.length,
          'fix every listed entry and resend the whole batch — nothing was written',
        ),
      ) as Result<PreparedCall, CommandError>;
    }
    commands.push({ name: 'codex.attach', params: attach.params });
  }

  return ok({
    commands,
    preview: { entries: diffs },
    finish: (done: readonly CommandDone[]) => finishCodexWrite(done, diffs),
  });
}

function createdIds(done: readonly CommandDone[]): string[] {
  const upsert = done.find((entry) => entry.name === 'codex.upsert');
  const created = isRecord(upsert?.outcome.result) ? upsert.outcome.result['created'] : undefined;
  return Array.isArray(created) ? created.filter((id): id is string => typeof id === 'string') : [];
}

function updatedIds(done: readonly CommandDone[]): string[] {
  const upsert = done.find((entry) => entry.name === 'codex.upsert');
  const updated = isRecord(upsert?.outcome.result) ? upsert.outcome.result['updated'] : undefined;
  return Array.isArray(updated) ? updated.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * The diff as the caller sees it: every text value cut to a preview. The plan card
 * got the full diff from `preview`; the response is what the model reads back.
 */
function shortenDiff(diff: Record<string, unknown>): Record<string, unknown> {
  const changes = Array.isArray(diff['changes'])
    ? (diff['changes'] as { field: string; from: string; to: string }[]).map((change) => ({
        ...change,
        from: preview(change.from),
        to: preview(change.to),
      }))
    : undefined;
  return {
    ...diff,
    ...(typeof diff['description'] === 'string' ? { description: preview(diff['description']) } : {}),
    ...(changes === undefined ? {} : { changes }),
  };
}

function finishCodexWrite(done: readonly CommandDone[], diffs: readonly Record<string, unknown>[]): Result<ToolValue, CommandError> {
  const created = createdIds(done);
  const updated = updatedIds(done);
  const attached = done.filter((entry) => entry.name === 'codex.attach').length;
  const affected = done.flatMap((entry) => [...entry.outcome.affected]);
  const undoGroupId = done[0]?.outcome.undoGroupId;
  // A batch of twenty long entries can still exceed the response cap, so the diffs
  // are kept only while they fit, and the number left out is stated.
  const shown: Record<string, unknown>[] = diffs.map(shortenDiff);
  const cap = capOf('codex.write');
  let kept = shown.length;
  while (kept > 0 && !fitsCap({ created, updated, attachmentChanges: attached, diffs: shown.slice(0, kept) }, cap)) kept -= 1;
  const omitted = shown.length - kept;
  return ok({
    data: {
      created,
      updated,
      attachmentChanges: attached,
      diffs: shown.slice(0, kept),
      ...(omitted === 0 ? {} : { diffsOmitted: omitted }),
    },
    summary: `wrote ${created.length + updated.length} codex ${created.length + updated.length === 1 ? 'entry' : 'entries'} (${created.length} created, ${updated.length} updated)`,
    affected,
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
    ...(omitted === 0
      ? {}
      : { notes: [`${omitted} of the ${shown.length} entry diffs are left out of this response to keep it within its cap. The plan card and the activity log hold them in full.`] }),
  });
}
