import * as codexText from '@caotang/codex';
import type { ProjectState, TreeNode } from '@caotang/store';

export type UnitField = 'body' | 'synopsis' | 'notes' | 'codex';
type SearchNode = Pick<TreeNode, 'id' | 'parentId' | 'type' | 'title' | 'order' | 'synopsis' | 'notes'>;
export interface SearchState {
  readonly manifest: Pick<ProjectState['manifest'], 'codex'> & { readonly tree: readonly SearchNode[]; readonly project: Pick<ProjectState['manifest']['project'], 'language'> };
  readonly documents: ProjectState['documents'];
}
export type HitPosition = 'manuscript' | 'before-focus' | 'focus' | 'after-focus' | 'research' | 'codex';
export interface SearchUnit {
  readonly id: string;
  readonly nodeId: string;
  readonly field: UnitField;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly revision: number;
}
export interface SearchHit {
  readonly unit: SearchUnit;
  readonly title: string;
  readonly rank: number;
  readonly score: number;
  readonly matched: readonly string[];
  readonly snippet: { readonly text: string; readonly from: number; readonly to: number };
  readonly position: HitPosition;
}
export interface SearchOptions {
  readonly limit?: number;
  readonly fields?: readonly UnitField[];
  readonly scope?: readonly string[];
  readonly excludeAfter?: string;
  readonly focus?: string;
  readonly excluded?: ReadonlySet<string>;
}
export interface LexicalIndexStats {
  readonly units: number;
  readonly terms: number;
  readonly documentPasses: number;
  readonly matches: number;
}
export interface LexicalIndex {
  search(state: SearchState, query: string, options?: SearchOptions): readonly SearchHit[];
  bumpCodexRevision(): number;
  readonly stats: LexicalIndexStats;
}

interface Token { readonly term: string; readonly from: number; readonly to: number }
interface IndexedUnit { readonly unit: SearchUnit; readonly tokens: readonly Token[]; readonly counts: ReadonlyMap<string, number> }
interface CachedNode { readonly body: string; readonly synopsis: string; readonly notes: string; readonly revision: number; readonly units: readonly IndexedUnit[] }
const FIELDS: readonly UnitField[] = ['body', 'synopsis', 'notes', 'codex'];
const { canonical, caseFold } = codexText;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const fold = (text: string): string => caseFold(canonical(text));
const boundary = (text: string, at: number): number => at > 0 && /[\uDC00-\uDFFF]/.test(text[at] ?? '') ? at - 1 : at;

function passages(text: string): readonly [number, number][] {
  const paragraphs: [number, number][] = [];
  let from = 0;
  for (const separator of text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
    if (separator.index > from) paragraphs.push([from, separator.index]);
    from = separator.index + separator[0].length;
  }
  if (from < text.length) paragraphs.push([from, text.length]);
  const result: [number, number][] = [];
  let pending: [number, number] | undefined;
  for (const [start, end] of paragraphs) {
    if (pending !== undefined && end - pending[0] > 800) { result.push(pending); pending = undefined; }
    if (end - start <= 1600) {
      pending = [pending?.[0] ?? start, end];
      continue;
    }
    for (let cursor = start; cursor < end;) {
      let next = Math.min(cursor + 800, end);
      if (next < end) {
        const space = cursor + text.slice(cursor, next).lastIndexOf(' ');
        if (space > cursor + 400) next = space;
      }
      next = boundary(text, next);
      result.push([cursor, next]);
      cursor = next;
    }
  }
  if (pending !== undefined) result.push(pending);
  return result;
}

function binderOrder(tree: readonly SearchNode[]): readonly SearchNode[] {
  const children = new Map<string | null, SearchNode[]>();
  for (const node of tree) {
    const group = children.get(node.parentId) ?? [];
    group.push(node);
    children.set(node.parentId, group);
  }
  for (const group of children.values()) group.sort((a, b) => a.order - b.order || compare(a.id, b.id));
  const result: SearchNode[] = [];
  const seen = new Set<string>();
  const stack = [...(children.get(null) ?? [])].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
    stack.push(...[...(children.get(node.id) ?? [])].reverse());
  }
  return result;
}

export function searchCandidates(state: SearchState, options: SearchOptions = {}): { readonly ordered: readonly SearchNode[]; readonly eligible: readonly SearchNode[]; readonly research: ReadonlySet<string> } {
  const ordered = binderOrder(state.manifest.tree);
  const roots = options.scope === undefined ? undefined : new Set(options.scope);
  const scope = new Set<string>();
  const research = new Set<string>();
  for (const node of ordered) {
    if (node.id === 'research' || research.has(node.parentId ?? '')) research.add(node.id);
    if (roots?.has(node.id) || scope.has(node.parentId ?? '')) scope.add(node.id);
  }
  const afterIndex = ordered.findIndex((node) => node.id === options.excludeAfter);
  const eligible = options.fields?.every((field) => field === 'codex') ? [] : ordered.filter((node, index) => !options.excluded?.has(node.id) && (roots === undefined || scope.has(node.id)) && (afterIndex < 0 || index <= afterIndex || research.has(node.id)));
  return { ordered, eligible, research };
}

function contentRevision(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

export function createLexicalIndex(config: { readonly locale?: string; readonly k1?: number; readonly b?: number } = {}): LexicalIndex {
  const k1 = config.k1 ?? 1.2;
  const b = config.b ?? 0.75;
  if (!Number.isFinite(k1) || k1 <= 0 || !Number.isFinite(b) || b < 0 || b > 1) throw new RangeError('Invalid BM25 parameters.');
  const docs = new Map<string, CachedNode>();
  const codex = new Map<string, IndexedUnit>();
  let locale: string | undefined;
  let segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  let codexRevision = 0;
  let documentPasses = 0;
  let stats: LexicalIndexStats = { units: 0, terms: 0, documentPasses: 0, matches: 0 };
  const tokenize = (text: string): Token[] => Array.from(segmenter.segment(text)).filter((segment) => segment.isWordLike).map((segment) => ({ term: fold(segment.segment), from: segment.index, to: segment.index + segment.segment.length }));
  const indexUnit = (nodeId: string, field: UnitField, from: number, to: number, text: string, revision: number): IndexedUnit => {
    const tokens = tokenize(text);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token.term, (counts.get(token.term) ?? 0) + 1);
    return { unit: { id: `${nodeId}:${field}:${from}`, nodeId, field, from, to, text, revision }, tokens, counts };
  };

  return {
    get stats() { return { ...stats }; },
    bumpCodexRevision() { codex.clear(); return ++codexRevision; },
    search(state, query, options = {}) {
      const nextLocale = config.locale ?? state.manifest.project.language;
      if (nextLocale !== locale) {
        try { segmenter = new Intl.Segmenter(nextLocale || undefined, { granularity: 'word' }); }
        catch { segmenter = new Intl.Segmenter(undefined, { granularity: 'word' }); }
        locale = nextLocale;
        docs.clear();
        codex.clear();
      }
      const { ordered, eligible, research } = searchCandidates(state, options);
      const nodes = new Map(ordered.map((node) => [node.id, node]));
      const order = new Map(ordered.map((node, index) => [node.id, index]));
      const focus = order.get(options.focus ?? options.excludeAfter ?? '');
      const visible = new Set(eligible.map((node) => node.id));
      for (const id of docs.keys()) if (!visible.has(id)) docs.delete(id);
      const corpus: IndexedUnit[] = [];
      for (const node of eligible) {
        const document = state.documents.get(node.id);
        const body = document?.body ?? '';
        const revision = document?.revision ?? 0;
        let cached = docs.get(node.id);
        if (cached === undefined || cached.revision !== revision || cached.body !== body || cached.synopsis !== node.synopsis || cached.notes !== node.notes) {
          const units: IndexedUnit[] = [];
          for (const [from, to] of passages(body)) units.push(indexUnit(node.id, 'body', from, to, body.slice(from, to), revision));
          for (const field of ['synopsis', 'notes'] as const) if (node[field] !== '') units.push(indexUnit(node.id, field, 0, node[field].length, node[field], revision));
          cached = { body, revision, synopsis: node.synopsis, notes: node.notes, units };
          docs.set(node.id, cached);
          if (node.type === 'document') documentPasses += 1;
        }
        corpus.push(...cached.units);
      }
      const visibleCodex = new Set<string>();
      const codexNames = new Map<string, string>();
      if (options.scope === undefined) for (const entry of [...(state.manifest.codex ?? [])].sort((a, b) => compare(a.id, b.id))) {
        if (entry.includePolicy === 'never' || options.excluded?.has(entry.id)) continue;
        visibleCodex.add(entry.id);
        codexNames.set(entry.id, entry.name);
        const text = [entry.name, ...entry.aliases, entry.description].join('\n');
        let indexed = codex.get(entry.id);
        if (indexed?.unit.text !== text) { indexed = indexUnit(entry.id, 'codex', 0, text.length, text, contentRevision(text)); codex.set(entry.id, indexed); }
        corpus.push(indexed!);
      }
      for (const id of codex.keys()) if (!visibleCodex.has(id)) codex.delete(id);
      const units = corpus.filter((item) => item.tokens.length > 0 && (options.fields === undefined || options.fields.includes(item.unit.field)));
      const frequencies = new Map<string, number>();
      let totalLength = 0;
      for (const item of units) {
        totalLength += item.tokens.length;
        for (const term of item.counts.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      }
      stats = { units: units.length, terms: frequencies.size, documentPasses, matches: 0 };
      const clauses = [...query.matchAll(/"([^"]+)"|([^"\s]+(?:\s+[^"\s]+)*)/g)];
      const phrases = clauses.filter((match) => match[1] !== undefined).map((match) => tokenize(match[1]!).map((token) => token.term)).filter((phrase) => phrase.length > 0);
      const terms = [...new Set(tokenize(query).map((token) => token.term))].sort(compare);
      if (terms.length === 0 || units.length === 0) return [];
      const average = totalLength / units.length;
      const matches: Omit<SearchHit, 'rank'>[] = [];
      for (const item of units) {
        if (phrases.some((phrase) => !item.tokens.some((_, index) => phrase.every((term, offset) => item.tokens[index + offset]?.term === term)))) continue;
        const matched = terms.filter((term) => item.counts.has(term));
        if (matched.length === 0) continue;
        let score = 0;
        for (const term of matched) {
          const df = frequencies.get(term)!;
          const tf = item.counts.get(term)!;
          score += Math.log(1 + (units.length - df + 0.5) / (df + 0.5)) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * item.tokens.length / average));
        }
        const first = item.tokens.find((token) => matched.includes(token.term))!.from;
        const start = boundary(item.unit.text, Math.max(0, first - 100));
        const end = boundary(item.unit.text, Math.min(item.unit.text.length, start + 300));
        const index = order.get(item.unit.nodeId)!;
        const position: HitPosition = item.unit.field === 'codex' ? 'codex' : research.has(item.unit.nodeId) ? 'research' : focus === undefined ? 'manuscript' : index === focus ? 'focus' : index < focus ? 'before-focus' : 'after-focus';
        const title = nodes.get(item.unit.nodeId)?.title ?? codexNames.get(item.unit.nodeId) ?? '';
        matches.push({ unit: item.unit, title, score: Math.round(score * 1e6) / 1e6, matched, snippet: { text: item.unit.text.slice(start, end), from: item.unit.from + start, to: item.unit.from + end }, position });
      }
      matches.sort((a, z) => z.score - a.score || (order.get(a.unit.nodeId) ?? Infinity) - (order.get(z.unit.nodeId) ?? Infinity) || FIELDS.indexOf(a.unit.field) - FIELDS.indexOf(z.unit.field) || a.unit.from - z.unit.from || compare(a.unit.nodeId, z.unit.nodeId));
      stats = { ...stats, matches: matches.length };
      return matches.slice(0, Math.max(0, Math.min(25, options.limit ?? 8))).map((hit, index) => ({ ...hit, rank: index + 1 }));
    },
  };
}
