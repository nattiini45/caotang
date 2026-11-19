export const CODEX_DETAIL_KINDS = ['text', 'number', 'date', 'boolean'] as const;
export const CODEX_DETAIL_FIELDS_MAX = 256;
export const CODEX_DETAIL_FIELDS_PER_TYPE_MAX = 24;
export const CODEX_DETAIL_TEXT_MAX = 2000;
export const CODEX_DETAIL_DIFF_PREFIX = 'details.';

export type CodexDetailKind = (typeof CODEX_DETAIL_KINDS)[number];
export type CodexDetailValue = string | number | boolean;
export type CodexDetailChanges = Record<string, CodexDetailValue | null>;

export interface CodexDetailField {
  readonly type: string;
  readonly key: string;
  readonly label: string;
  readonly kind: CodexDetailKind;
}

export function isCodexDetailObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function readCodexDetailField(value: unknown): CodexDetailField | undefined {
  if (!isCodexDetailObject(value)) return undefined;
  const { type, key, label, kind } = value;
  if (typeof type !== 'string' || type !== type.trim() || type.length === 0 || type.length > 64 ||
      typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) ||
      key === 'constructor' || key === 'prototype' ||
      typeof label !== 'string' || label !== label.trim() || label.length === 0 || label.length > 80 ||
      !CODEX_DETAIL_KINDS.some((candidate) => candidate === kind)) return undefined;
  return { type, key, label, kind: kind as CodexDetailKind };
}

export function matchesCodexDetail(kind: CodexDetailKind, value: unknown): value is CodexDetailValue {
  switch (kind) {
    case 'text':
      return typeof value === 'string' && value.length <= CODEX_DETAIL_TEXT_MAX;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
      const date = new Date(value + 'T00:00:00.000Z');
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
  }
}
