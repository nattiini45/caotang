import type { ContextOverrides, ContextRef } from '@caotang/harness';
import type { ProjectState } from '@caotang/store';

export interface ContextChoice extends ContextRef {
  readonly label: string;
}

export const contextKey = (ref: ContextRef): string => `${ref.kind}:${ref.id}`;

export function copyContext(overrides: ContextOverrides | undefined): ContextOverrides | undefined {
  if (overrides === undefined) return undefined;
  return {
    ...(overrides.include === undefined ? {} : { include: overrides.include.map((ref) => ({ kind: ref.kind, id: ref.id })) }),
    ...(overrides.exclude === undefined ? {} : { exclude: overrides.exclude.map((ref) => ({ kind: ref.kind, id: ref.id })) }),
  };
}

export function contextChoices(state: ProjectState, hidden: ReadonlySet<string>): ContextChoice[] {
  return [
    ...state.manifest.tree.filter((node) => node.type === 'document' && !hidden.has(node.id)).map((node) => ({ kind: 'doc' as const, id: node.id, label: node.title })),
    ...(state.manifest.codex ?? []).filter((entry) => entry.includePolicy !== 'never' && !(entry.attachments.length > 0 && entry.attachments.every((id) => hidden.has(id))))
      .map((entry) => ({ kind: 'codex' as const, id: entry.id, label: entry.name })),
  ].sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : contextKey(a) < contextKey(b) ? -1 : 1);
}

export function chooseContext(overrides: ContextOverrides, ref: ContextRef, choice: 'pin' | 'exclude' | 'remove'): ContextOverrides {
  const key = contextKey(ref);
  const include = (overrides.include ?? []).filter((item) => contextKey(item) !== key);
  const exclude = (overrides.exclude ?? []).filter((item) => contextKey(item) !== key);
  if (choice === 'pin' && (ref.kind !== 'doc' || new Set(include.filter((item) => item.kind === 'doc').map((item) => item.id)).size < 3)) include.push({ kind: ref.kind, id: ref.id });
  if (choice === 'exclude') exclude.push({ kind: ref.kind, id: ref.id });
  return { include, exclude };
}
