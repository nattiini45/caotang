import { REQUEST_PIN_REASON, type ContextOverrides, type ContextRef, type PreviewLayer } from '@caotang/harness';
import type { ProjectState } from '@caotang/store';

export type ContextChoice = ContextRef & { readonly label: string } & (
  { readonly kind: 'doc'; readonly path: readonly string[] } |
  { readonly kind: 'codex'; readonly entryType: string }
);

export const contextKey = (ref: ContextRef): string => `${ref.kind}:${ref.id}`;

export function droppedContextPins(layers: readonly PreviewLayer[], pinned: readonly ContextRef[] = []) {
  const requested = new Set(pinned.map(contextKey));
  const kept = new Set(layers.flatMap((layer) => (layer.kept ?? []).filter((item) => item.ref !== undefined && item.reason === REQUEST_PIN_REASON)
    .map((item) => contextKey(item.ref!))));
  return [...new Map(layers.flatMap((layer) => layer.drops.filter((drop) => drop.ref !== undefined && requested.has(contextKey(drop.ref)) && !kept.has(contextKey(drop.ref)))
    .map((drop) => [contextKey(drop.ref!), drop] as const))).values()];
}

export function copyContext(overrides: ContextOverrides | undefined): ContextOverrides | undefined {
  if (overrides === undefined) return undefined;
  return {
    ...(overrides.include === undefined ? {} : { include: overrides.include.map((ref) => ({ kind: ref.kind, id: ref.id })) }),
    ...(overrides.exclude === undefined ? {} : { exclude: overrides.exclude.map((ref) => ({ kind: ref.kind, id: ref.id })) }),
  };
}

export function contextChoices(state: ProjectState, hidden: ReadonlySet<string>): ContextChoice[] {
  const nodes = new Map(state.manifest.tree.map((node) => [node.id, node]));
  return [
    ...state.manifest.tree.filter((node) => node.type === 'document' && !hidden.has(node.id)).map((node) => {
      const path: string[] = [];
      const seen = new Set([node.id]);
      for (let parent = nodes.get(node.parentId ?? ''); parent !== undefined && !seen.has(parent.id); parent = nodes.get(parent.parentId ?? '')) {
        seen.add(parent.id);
        if (parent.parentId !== null && !hidden.has(parent.id)) path.unshift(parent.title);
      }
      return { kind: 'doc' as const, id: node.id, label: node.title, path };
    }),
    ...(state.manifest.codex ?? []).filter((entry) => entry.includePolicy !== 'never' && !(entry.attachments.length > 0 && entry.attachments.every((id) => hidden.has(id))))
      .map((entry) => ({ kind: 'codex' as const, id: entry.id, label: entry.name, entryType: entry.type })),
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
