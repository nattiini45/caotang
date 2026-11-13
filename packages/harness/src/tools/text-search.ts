import { ok, type CommandError, type Result } from '@caotang/bus';
import { createLexicalIndex, type HitPosition, type LexicalIndex, type SearchHit, type SearchState, type UnitField } from '@caotang/retrieval';
import { failure, invalidParams } from '../errors.js';
import { param } from '../schema.js';
import { fitsCap } from '../tokens.js';
import type { CallParams, ToolValue } from '../types.js';

const fields: readonly UnitField[] = ['body', 'synopsis', 'notes', 'codex'];
const positions: readonly HitPosition[] = ['manuscript', 'before-focus', 'focus', 'after-focus', 'research', 'codex'];
const indexes = new WeakMap<SearchState, LexicalIndex>();
export const TEXT_SEARCH_CAP = 4_000;

export const textSearchParams = param.object('Search current project text locally, without a provider request.', {
  query: param.string('Words to find, with optional quoted adjacent-token phrases. No stemming or fuzzy matching.', { nonBlank: true, maxLength: 500 }),
  scope: param.list('Binder node ids; folders expand to their descendants. Omit for the whole project, including eligible codex.', param.string('A binder node id.', { nonBlank: true }), { maxItems: 100, unique: true }),
  fields: param.list('Fields to search; omit for all four.', param.choice('A project text field.', fields), { minItems: 1, maxItems: 4, unique: true }),
  limit: param.integer('The most hits to return, default 8 and at most 25.', { minimum: 1, maximum: 25, default: 8 }),
  excludeAfter: param.string('A focus document id: omit later manuscript passages but keep research.', { nonBlank: true }),
  focus: param.string('A document id for before/focus/after labels only.', { nonBlank: true }),
}, ['query']);

const snippetSpec = param.object('A bounded exact excerpt with offsets in the original field.', {
  text: param.string('The original text, not normalized text.'),
  from: param.integer('Inclusive UTF-16 field offset.'),
  to: param.integer('Exclusive UTF-16 field offset.'),
}, ['text', 'from', 'to']);
const hitSpec = param.object('One lexical match, with a body range suitable for a follow-up doc.read.', {
  nodeId: param.string('The binder node or codex entry id.'),
  title: param.string('The current node title or codex name.'),
  field: param.choice('The matched field.', fields),
  from: param.integer('The start of the full source unit.'),
  to: param.integer('The end of the full source unit.'),
  revision: param.integer('The source revision; codex uses a deterministic text fingerprint.'),
  rank: param.integer('One-based result rank.'),
  score: param.number('BM25 score rounded to six decimal places.'),
  matched: param.list('The matched folded query terms.', param.string('A folded word.')),
  snippet: snippetSpec,
  position: param.choice('Location relative to focus, or manuscript, research or codex.', positions),
}, ['nodeId', 'title', 'field', 'from', 'to', 'revision', 'rank', 'score', 'matched', 'snippet', 'position']);

export const textSearchResult = param.object('Ranked local lexical results under the response cap.', {
  hits: param.list('Whole ranked hit records.', hitSpec),
  total: param.integer('Matching visible units before the limit and cap.'),
  truncated: param.boolean('The limit or response cap omitted matching units.'),
  hint: param.string('What to try when there are no results.'),
}, ['hits', 'total', 'truncated']);

export type TextSearchHit = Omit<SearchHit, 'unit'> & Pick<SearchHit['unit'], 'nodeId' | 'field' | 'from' | 'to' | 'revision'>;
export type TextSearchData = { readonly hits: readonly TextSearchHit[]; readonly total: number; readonly truncated: boolean; readonly hint?: string };

export const textSearchPort = (params: CallParams, context: { readonly state: SearchState; readonly withheld?: ReadonlySet<string> }): Result<ToolValue, CommandError> => {
  const state = context.state;
  const scope = params['scope'] as readonly string[] | undefined;
  if (scope?.some((id) => !state.manifest.tree.some((node) => node.id === id))) return failure(invalidParams('A search scope id is not in this project.', 'use binder.read_tree for current node ids', 'scope'));
  for (const key of ['focus', 'excludeAfter'] as const) {
    if (params[key] !== undefined && !state.manifest.tree.some((node) => node.id === params[key] && node.type === 'document' && !context.withheld?.has(node.id))) return failure(invalidParams('The search focus is not a readable document.', 'use a current readable document id', key));
  }
  let index = indexes.get(state);
  if (index === undefined) { index = createLexicalIndex(); indexes.set(state, index); }
  const matches = index.search(state, params['query'] as string, {
    limit: params['limit'] as number,
    fields: params['fields'] as readonly UnitField[] | undefined,
    scope,
    focus: params['focus'] as string | undefined,
    excludeAfter: params['excludeAfter'] as string | undefined,
    excluded: context.withheld,
  });
  const total = index.stats.matches;
  const hits: TextSearchHit[] = [];
  const hint = total === 0 ? 'Try fewer words, or codex.read for names.' : undefined;
  const data = (): TextSearchData => ({ hits: [...hits], total, truncated: hits.length < total, ...(hint === undefined ? {} : { hint }) });
  const answer = (): ToolValue => ({ data: data(), summary: `found ${hits.length} lexical passages`, affected: [] });
  for (const match of matches) {
    const { unit, ...rest } = match;
    hits.push({ ...rest, nodeId: unit.nodeId, field: unit.field, from: unit.from, to: unit.to, revision: unit.revision });
    if (!fitsCap(answer(), TEXT_SEARCH_CAP) || !fitsCap({ tool: 'text.search', ok: true, data: data() }, TEXT_SEARCH_CAP)) { hits.pop(); break; }
  }
  if (hits.length === 0 && total > 0) return failure(invalidParams('A search hit is too large for the response cap. No hit was skipped.', 'narrow the scope or inspect the document directly', 'scope'));
  return ok(answer());
};
