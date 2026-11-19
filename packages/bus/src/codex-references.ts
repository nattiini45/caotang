import { isCodexDetailObject, matchesCodexDetail } from './codex-details.js';

export const CODEX_REFERENCE_MAX = 24;
export const CODEX_REFERENCE_TITLE_MAX = 160;
export const CODEX_REFERENCE_PUBLISHER_MAX = 160;
export const CODEX_REFERENCE_URL_MAX = 2048;
export const CODEX_REFERENCE_QUOTE_MAX = 1000;
export const CODEX_REFERENCE_FIELDS = ['title', 'url', 'publisher', 'date', 'quote'] as const;

export type CodexReferenceFields = { title: string; url?: string; publisher?: string; date?: string; quote?: string };
type ReferencePatch = { title?: string; url?: string | null; publisher?: string | null; date?: string | null; quote?: string | null };
export type CodexReference = CodexReferenceFields & { id: string };
export type CodexReferenceEdit =
  | ({ action: 'create'; id?: never; title: string } & ReferencePatch)
  | ({ action: 'update'; id: string } & ReferencePatch)
  | { action: 'remove'; id: string };

export function codexReferenceId(value: unknown): string | undefined {
  const id = isCodexDetailObject(value) ? value['id'] : undefined;
  return typeof id === 'string' && /^ref_[0-9A-HJKMNP-TV-Z]{10}$/.test(id) ? id : undefined;
}

export function externalReferenceUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value) || /\s/u.test(value) || [...value].some((character) => character <= ' ' || character === '\x7f') ||
    value.length > CODEX_REFERENCE_URL_MAX) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '') return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

export function referenceFieldProblem(key: (typeof CODEX_REFERENCE_FIELDS)[number], value: unknown): string | undefined {
  if (key !== 'title' && value === null) return undefined;
  const max = key === 'title' ? CODEX_REFERENCE_TITLE_MAX : key === 'publisher' ? CODEX_REFERENCE_PUBLISHER_MAX
    : key === 'url' ? CODEX_REFERENCE_URL_MAX : key === 'quote' ? CODEX_REFERENCE_QUOTE_MAX : 10;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) return `must be nonblank text of at most ${max} characters`;
  if (key === 'date' && !matchesCodexDetail('date', value)) return 'must be a real date in YYYY-MM-DD';
  if (key === 'url' && externalReferenceUrl(value) === undefined) return 'must be an HTTP or HTTPS address without credentials';
  return undefined;
}

export function readCodexReference(value: unknown): CodexReference | undefined {
  const id = codexReferenceId(value);
  if (id === undefined || !isCodexDetailObject(value) || typeof value.title !== 'string' ||
    referenceFieldProblem('title', value.title) !== undefined) return undefined;
  const reference: CodexReference = { id, title: value.title };
  for (const key of ['url', 'publisher', 'date', 'quote'] as const) {
    const field = value[key];
    if (typeof field === 'string' && referenceFieldProblem(key, field) === undefined) reference[key] = field;
  }
  return reference;
}

export function referenceEditProblem(value: unknown, liveIds: string[], currentCount: number): string | undefined {
  if (!isCodexDetailObject(value)) return 'must be an operation object';
  const { action, id } = value;
  if (action !== 'create' && action !== 'update' && action !== 'remove') return 'action must be create, update or remove';
  for (const key of Object.keys(value)) {
    if (key === 'action') continue;
    if (key === 'id' && action !== 'create') continue;
    if (action !== 'remove' && CODEX_REFERENCE_FIELDS.some((field) => field === key)) continue;
    return `unexpected field "${key}" for ${action}`;
  }
  if (action === 'create') {
    if (currentCount >= CODEX_REFERENCE_MAX) return `an entry can hold at most ${CODEX_REFERENCE_MAX} references`;
  } else if (typeof id !== 'string' || liveIds.filter((candidate) => candidate === id).length !== 1) {
    return 'id must name one existing reference on this entry';
  }
  if (action !== 'remove') {
    const fields = CODEX_REFERENCE_FIELDS.filter((key) => Object.hasOwn(value, key));
    if (action === 'create' && !fields.includes('title')) return 'title is required';
    if (fields.length === 0) return 'provide at least one field to update';
    for (const key of fields) {
      const problem = referenceFieldProblem(key, value[key]);
      if (problem !== undefined) return `${key} ${problem}`;
    }
  }
  return undefined;
}
