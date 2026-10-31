/**
 * `codex.import` — a write-confirm registry extension beside `doc.import` (codex.md §2, §7).
 *
 * **Why a separate verb.** `codex.write` stamps every entry it creates `origin: 'agent'`. The
 * cost is that a writer's own imported worldbuilding would come in
 * as the agent's drafts. Canon ranks by origin (codex.md §2, coherence.md §4.3), so an import stamped `agent` would
 * lose to the writer's canon it is. This verb carries the `import` provenance on the bus command
 * this tool builds (`PreparedCommand.provenance`, command-bus §2), so the caller's params never name
 * the origin: an op that tried would be refused by `codex.upsert`'s closed key set.
 *
 * **Shape.** Create-only, at most 20 entries per call. Each entry becomes one `codex.upsert` create
 * op that also attaches it to the one document its text was imported into, with one citation into
 * that document. The whole batch is one `codex.upsert`, so one undo group removes the whole import.
 *
 * **The citation.** The first passage of the attached document that names the entry (its name, then
 * its aliases, in order), taken verbatim, at most 300 characters, with UTF-16 offsets into the body
 * projection: the coordinate system codex.md §2 and edit-anchors.md §2 share, and the one the bus's
 * `citationProblem` checks against the document's current body. "Names" is codex.md §4's sense: a Latin
 * name matches only on word boundaries, the entry's case mode applies, and an exclusion phrase drops the
 * occurrences inside it. A document that names the entry nowhere has no passage to cite, so the entry is
 * refused rather than cited to text it does not hold.
 *
 * **What is refused, per entry, before anything runs.** A name or alias equal (case-insensitively) to
 * an existing entry's name or alias, which names the entry it collides with: an import never merges
 * (codex.md §7). A name or alias that collides with another entry in the same batch. An `attachTo`
 * that is not a document of the project. A document in which the entry is named nowhere, by codex.md
 * §4's rules. A document not stored in Unicode NFC, whose offsets cannot be matched to the entry's text
 * (refused rather than cited wrongly). The bus's own checks (lengths, the closed key set, the citation's
 * offsets) run after these, on the same ops.
 *
 * **The plan card and the response.** The card carries each entry whole (every field it will hold, the
 * full citation, and the `always` flag where the policy calls for one, codex.md §7). The response carries
 * the same diffs with their long text cut to a preview, and only as many as fit its cap.
 */

import {
  CODEX_ALIAS_CHARS_MAX,
  CODEX_ALIASES_MAX,
  CODEX_DESCRIPTION_MAX,
  CODEX_EXCLUDE_CHARS_MAX,
  CODEX_EXCLUDE_MAX,
  CODEX_NAME_MAX,
  CODEX_SOURCE_QUOTE_MAX,
  ok,
  type CommandError,
  type Result,
} from '@caotang/bus';
import { atWordBoundary, caseFold, canonical, compileCodex, countMentions, type Phrase } from '@caotang/codex';
import { CODEX_INCLUDE_POLICIES, CODEX_TYPES, type CodexEntry, type ProjectState } from '@caotang/store';

import { importScanSentence, scanImport } from '../agent/untrusted.js';
import { failure, invalidParams, notFound, refusal } from '../errors.js';
import { capOf } from '../metadata.js';
import { param, type ObjectSpec } from '../schema.js';
import { fitsCap } from '../tokens.js';
import type { CallParams, CommandDone, PreparedCall, PreparedCommand, PrepareContext, ToolValue } from '../types.js';
import { codePointLength, firstCodePoints, isRecord } from '../util.js';
import { batchRefusal, checkCommand, policyFlags } from './common.js';

/** codex.md §7's batch ceiling, as codex.write holds it. */
const CODEX_IMPORT_MAX = 20;
/** codex.md §2's citation limit, read from the bus so the two cannot drift. */
const QUOTE_MAX = CODEX_SOURCE_QUOTE_MAX;
const PREVIEW_CHARS = 200;

export const codexImportParams: ObjectSpec = param.object(
  'The codex entries to import, as one batch. Each is created as the writer’s own canon and attached to the document it cites.',
  {
    entries: param.list(
      'Entries to import: at most 20 per call, create-only. Each is validated before any of them is written.',
      param.object(
        'One imported codex entry: a new entry, attached to the document its text came from.',
        {
          name: param.string(`The entry name, at most ${CODEX_NAME_MAX} characters. Required, and unique across the codex.`, {
            nonBlank: true,
            maxLength: CODEX_NAME_MAX,
          }),
          aliases: param.list(
            `Other names the entry is found by, at most ${CODEX_ALIASES_MAX}. None may equal another entry's name or alias.`,
            param.string('One alias.', { nonBlank: true, maxLength: CODEX_ALIAS_CHARS_MAX }),
            { maxItems: CODEX_ALIASES_MAX },
          ),
          type: param.choice('The entry type.', [...CODEX_TYPES]),
          description: param.string(`The entry description. At most ${CODEX_DESCRIPTION_MAX} characters.`),
          includePolicy: param.choice('When the entry is included in the context of a generation call.', [...CODEX_INCLUDE_POLICIES]),
          caseSensitive: param.boolean('Whether the name and aliases match case-sensitively.'),
          exclude: param.list(
            `Phrases in which matches are ignored, at most ${CODEX_EXCLUDE_MAX}.`,
            param.string('One excluded phrase.', { nonBlank: true, maxLength: CODEX_EXCLUDE_CHARS_MAX }),
            { maxItems: CODEX_EXCLUDE_MAX },
          ),
          attachTo: param.list(
            'The one document the entry is attached to and cites: the document its full text was imported into. Required.',
            param.string('A document id.', { nonBlank: true }),
            { minItems: 1, maxItems: 1 },
          ),
        },
        ['name', 'attachTo'],
      ),
      { minItems: 1, maxItems: CODEX_IMPORT_MAX },
    ),
  },
  ['entries'],
);

/** One existing term (a name or an alias) and the entry that holds it, keyed by its lowercase form. */
interface Holder {
  readonly name: string;
  readonly id: string;
}

/**
 * Every name and alias the codex holds. Names are seeded first, so that an alias which happens to
 * equal another entry's name is reported against the name's owner, the way codex.md §2 resolves it.
 */
function existingTerms(state: ProjectState): Map<string, Holder> {
  const terms = new Map<string, Holder>();
  const entries = state.manifest.codex ?? [];
  for (const entry of entries) terms.set(entry.name.toLowerCase(), { name: entry.name, id: entry.id });
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const key = alias.toLowerCase();
      if (!terms.has(key)) terms.set(key, { name: entry.name, id: entry.id });
    }
  }
  return terms;
}

function definedFields(entry: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (entry[key] !== undefined) out[key] = entry[key];
  return out;
}

function preview(text: string): string {
  return codePointLength(text) > PREVIEW_CHARS ? `${firstCodePoints(text, PREVIEW_CHARS)}…` : text;
}

/** A half-open span of UTF-16 units, `[from, to)`. */
type Span = readonly [number, number];

/**
 * The spans one needle occupies in one text, by codex.md §4's rules: every occurrence in the surface its
 * case mode reads, kept only where a Latin needle sits on word boundaries. This is detect.ts's `spansOf`,
 * which that package keeps private, so it is rebuilt here over the helpers the package exports. The engine's
 * own `countMentions` is the authority on whether an entry is named (see `locatePassage`), and a test holds
 * this copy to it. The surfaces have the body's own length, so an offset found in them is an offset into
 * the body.
 */
function spansOf(surfaces: { readonly canon: string; readonly folded: string }, phrase: Phrase): Span[] {
  const haystack = phrase.caseSensitive ? surfaces.canon : surfaces.folded;
  const spans: Span[] = [];
  for (let at = haystack.indexOf(phrase.value); at !== -1; at = haystack.indexOf(phrase.value, at + 1)) {
    const end = at + phrase.value.length;
    if (phrase.latin && !atWordBoundary(haystack, at, end)) continue;
    spans.push([at, end]);
  }
  return spans;
}

/**
 * How many UTF-16 units from `from` hold at most `count` code points. It walks code points, so a
 * surrogate pair is never split, and the result is the length the bus's `body.slice(from, to)` check
 * needs.
 */
function utf16Span(body: string, from: number, count: number): number {
  let index = from;
  let taken = 0;
  while (index < body.length && taken < count) {
    const code = body.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    taken += 1;
  }
  return index - from;
}

/** A citation's place in its document: the offsets the bus checks, and the verbatim text they hold. */
export interface Passage {
  readonly from: number;
  readonly to: number;
  readonly quote: string;
}

/**
 * The first passage of `body` that names the entry, by the codex engine's rules (codex.md §4): the
 * boundary rule for a Latin term, the entry's case mode, and its exclusion phrases judged at each match
 * site (K6). `countMentions` decides whether the entry is named at all, so a refusal here agrees with
 * the detector. Terms are tried in order, the name first and then the aliases, and each yields its first
 * surviving occurrence. The quote runs from that occurrence, at most `QUOTE_MAX` code points, and the
 * offsets are into `body`, the coordinate system the bus's citation check reads.
 *
 * The surfaces are the body's own canonical form, so the offsets are valid only for a body already in
 * Unicode NFC, where canonical form changes no length. The caller refuses any other body (`nfcProblem`).
 */
export function locatePassage(body: string, probe: CodexEntry): Passage | undefined {
  const compiled = compileCodex([probe]);
  if ((countMentions(body, compiled).get(probe.id) ?? 0) === 0) return undefined;
  const canon = canonical(body);
  const surfaces = { canon, folded: caseFold(canon) };
  const excluded = compiled.exclusions.flatMap((phrase) => spansOf(surfaces, phrase));
  for (const term of compiled.terms) {
    for (const [start, end] of spansOf(surfaces, term)) {
      if (excluded.some(([from, to]) => from <= start && end <= to)) continue;
      const to = start + utf16Span(body, start, QUOTE_MAX);
      return { from: start, to, quote: body.slice(start, to) };
    }
  }
  return undefined;
}

/** The refusal for a body the citation cannot be located in, or `undefined` when it can. */
export function nfcProblem(body: string): string | undefined {
  return body.normalize('NFC') === body
    ? undefined
    : 'is not stored in Unicode NFC, so its text cannot be matched to the entry at the offsets the citation needs; normalise the document to NFC and resend';
}

export function prepareCodexImport(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const entries = Array.isArray(params['entries']) ? (params['entries'] as readonly unknown[]) : [];
  const failures: { target: string; error: CommandError }[] = [];
  /** The upsert's ops, and the input index each came from, so a bus failure can name the caller's entry. */
  const ops: Record<string, unknown>[] = [];
  const opInput: number[] = [];
  /** One plan-card diff per accepted entry, in full. */
  const cards: Record<string, unknown>[] = [];
  const taken = existingTerms(state);
  /** The terms this batch has already claimed, so a later entry cannot take them. */
  const claimed = new Map<string, string>();
  const stamp = new Date((context.clock ?? Date.now)()).toISOString();

  for (const [index, raw] of entries.entries()) {
    const target = `entries[${index}]`;
    if (!isRecord(raw)) {
      failures.push({ target, error: invalidParams(`${target} must be an object`, 'pass each entry as an object', target) });
      continue;
    }
    const name = typeof raw['name'] === 'string' ? raw['name'] : '';
    const aliases = Array.isArray(raw['aliases']) ? raw['aliases'].filter((alias): alias is string => typeof alias === 'string') : [];
    const attachTo = Array.isArray(raw['attachTo']) ? raw['attachTo'] : [];
    const docId = typeof attachTo[0] === 'string' ? attachTo[0] : undefined;
    const terms = [name, ...aliases].filter((term) => term.trim() !== '');

    if (name.trim() === '') {
      failures.push({ target, error: invalidParams(`${target}.name is required — an entry is found by its name`, 'pass a non-blank name for the entry', `${target}.name`) });
      continue;
    }

    const node = docId === undefined ? undefined : state.manifest.tree.find((candidate) => candidate.id === docId);
    if (docId === undefined || node === undefined || node.type !== 'document') {
      failures.push({
        target: `${target}.attachTo`,
        error: notFound(
          docId === undefined ? `${target}.attachTo names no document` : `no document with id "${docId}" to attach "${name}" to`,
          'use binder.read_tree to find the document the entry\'s full text was imported into',
          `${target}.attachTo`,
        ),
      });
      continue;
    }

    // Create-only: a term already held, by the codex or by this batch, is a collision, never a merge.
    let collision: string | undefined;
    for (const term of terms) {
      const key = term.toLowerCase();
      const holder = taken.get(key);
      if (holder !== undefined) {
        collision = `"${term}" collides with the existing entry "${holder.name}" (${holder.id}), case-insensitively; an import never merges into an entry`;
        break;
      }
      const sibling = claimed.get(key);
      if (sibling !== undefined) {
        collision = `"${term}" collides with "${sibling}" in this same batch, case-insensitively`;
        break;
      }
    }
    if (collision !== undefined) {
      failures.push({
        target,
        error: invalidParams(collision, 'pick a name and aliases no existing entry or other entry in this batch holds; codex.write updates an entry that already exists', target),
      });
      continue;
    }

    const body = state.documents.get(docId)?.body ?? '';
    const unlocatable = nfcProblem(body);
    if (unlocatable !== undefined) {
      failures.push({
        target: `${target}.attachTo`,
        error: invalidParams(`"${node.title}" ${unlocatable}`, 'normalise the document to NFC, then resend the batch', `${target}.attachTo`),
      });
      continue;
    }
    // The engine reads only these four fields of an entry, so a probe carries them and nothing else.
    const exclude = Array.isArray(raw['exclude']) ? (raw['exclude'] as unknown[]).filter((phrase): phrase is string => typeof phrase === 'string') : [];
    const probe = { id: 'probe', name, aliases, caseSensitive: raw['caseSensitive'] === true, exclude } as CodexEntry;
    const cited = locatePassage(body, probe);
    if (cited === undefined) {
      failures.push({
        target: `${target}.attachTo`,
        error: invalidParams(
          `"${node.title}" names "${name}" nowhere, and none of its aliases, so there is no passage to cite for the entry`,
          'import the text that names this entry into a document with doc.import first, then attach the entry to that document',
          `${target}.attachTo`,
        ),
      });
      continue;
    }

    ops.push({
      action: 'create',
      name,
      ...definedFields(raw, ['aliases', 'type', 'description', 'includePolicy', 'caseSensitive', 'exclude']),
      attachTo: [docId],
      sources: [{ docId, quote: cited.quote, from: cited.from, to: cited.to, extractedAt: stamp }],
    });
    opInput.push(index);
    for (const term of terms) claimed.set(term.toLowerCase(), name);
    // The card carries the whole proposal and the whole quote (codex.md §7); the response gets a shortened copy.
    const flags = policyFlags(undefined, raw['includePolicy']);
    cards.push({
      action: 'create',
      name,
      ...definedFields(raw, ['type', 'description', 'aliases', 'includePolicy', 'caseSensitive', 'exclude']),
      attach: docId,
      citation: { docId, title: node.title, from: cited.from, to: cited.to, quote: cited.quote },
      ...(flags.length === 0 ? {} : { flags }),
    });
  }

  if (failures.length > 0) {
    return failure(batchRefusal(failures, entries.length, 'fix every listed entry and resend the whole batch — nothing was written')) as Result<
      PreparedCall,
      CommandError
    >;
  }

  const upsert = { entries: ops };
  const checked = checkCommand(context, 'codex.upsert', upsert);
  if (!checked.ok) {
    // The bus's per-op failures name the position in `ops`; map each back to the caller's entry.
    const inner = checked.error.details?.['failures'];
    const mapped = Array.isArray(inner)
      ? (inner as { target: string; code: CommandError['code']; message: string; correctiveHint?: string }[]).map((row) => {
          const position = Number(/^entries\[(\d+)\]/.exec(row.target)?.[1] ?? 0);
          const input = opInput[position] ?? position;
          return {
            target: `entries[${input}]`,
            error: refusal(row.code, row.message, { ...(row.correctiveHint === undefined ? {} : { correctiveHint: row.correctiveHint }) }),
          };
        })
      : [{ target: 'entries', error: checked.error }];
    return failure(batchRefusal(mapped, entries.length, 'fix every listed entry and resend the whole batch — nothing was written')) as Result<
      PreparedCall,
      CommandError
    >;
  }

  // The provenance is the tool's: it travels on the command envelope, and no param of the caller reaches it.
  const commands: PreparedCommand[] = [{ name: 'codex.upsert', params: upsert, provenance: 'import' }];
  // The entries are stored as given; the scan tells the writer, on the card and in the result, what in them reads like instructions to a model (issue #54).
  const scan = scanImport(
    cards.flatMap((card, index) => [
      { where: `entries[${index}].name`, text: String(card['name'] ?? '') },
      { where: `entries[${index}].description`, text: typeof card['description'] === 'string' ? card['description'] : '' },
      { where: `entries[${index}].citation`, text: (card['citation'] as { readonly quote: string }).quote },
    ]),
  );
  return ok({
    commands,
    preview: { entries: cards, ...(scan.total === 0 ? {} : { scan }) },
    finish: (done: readonly CommandDone[]) => finishCodexImport(done, cards, scan),
  });
}

/**
 * The diff as the caller sees it: the description and the citation's quote cut to a preview. The plan
 * card got the whole text from `preview`, and the response is what the model reads back.
 */
function shortenImportDiff(card: Record<string, unknown>): Record<string, unknown> {
  const citation = card['citation'] as { readonly quote: string } & Record<string, unknown>;
  return {
    ...card,
    ...(typeof card['description'] === 'string' ? { description: preview(card['description']) } : {}),
    citation: { ...citation, quote: preview(citation.quote) },
  };
}

function finishCodexImport(done: readonly CommandDone[], cards: readonly Record<string, unknown>[], scan: ReturnType<typeof scanImport>): Result<ToolValue, CommandError> {
  const upsert = done.find((entry) => entry.name === 'codex.upsert');
  const result = upsert?.outcome.result;
  const created = isRecord(result) && Array.isArray(result['created'])
    ? (result['created'] as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
  const undoGroupId = upsert?.outcome.undoGroupId;
  // A batch of twenty long citations can still exceed the response cap, so diffs are kept only while
  // they fit, and the number left out is stated. The plan card carried them in full.
  const shown = cards.map(shortenImportDiff);
  const cap = capOf('codex.import');
  let kept = shown.length;
  while (kept > 0 && !fitsCap({ created, diffs: shown.slice(0, kept) }, cap)) kept -= 1;
  const omitted = shown.length - kept;
  const scanSentence = importScanSentence('The imported entries', scan);
  return ok({
    data: {
      created,
      attached: created.length,
      origin: 'import',
      diffs: shown.slice(0, kept),
      ...(omitted === 0 ? {} : { diffsOmitted: omitted }),
      ...(scan.total === 0 ? {} : { scan }),
    },
    summary: `imported ${created.length} codex ${created.length === 1 ? 'entry' : 'entries'} as the writer's own canon, each citing its document`,
    affected: upsert?.outcome.affected ?? [],
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
    ...(omitted === 0 && scanSentence === undefined
      ? {}
      : {
          notes: [
            ...(omitted === 0 ? [] : [`${omitted} of the ${shown.length} entry diffs are left out of this response to keep it within its cap. The plan card and the activity log hold them in full.`]),
            ...(scanSentence === undefined ? [] : [scanSentence]),
          ],
        }),
  });
}
