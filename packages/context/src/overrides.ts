import { getBody, type ProjectState } from '@caotang/store';
import { newBlock, type Block } from './block.js';
import { dropRecord } from './drops.js';
import { compareText } from './text.js';
import { synopsisOf, type TreeIndex } from './tree.js';
import { REQUEST_PIN_REASON, type ContextOverrides, type ContextRef, type DropRecord } from './types.js';

export function overrideIds(overrides: ContextOverrides | undefined, choice: 'include' | 'exclude', kind: ContextRef['kind']): Set<string> {
  return new Set(overrides?.[choice]?.filter((ref) => ref.kind === kind).map((ref) => ref.id));
}

export function excludeStory(block: Block, excluded: ReadonlySet<string>, drops: DropRecord[]): Block {
  if (excluded.size === 0) return block;
  const positions = new Map<number, number>();
  const items = block.items.filter((item, index) => {
    if (item.ref?.kind === 'doc' && excluded.has(item.ref.id)) {
      drops.push(dropRecord(item.label, { kind: 'writer-excluded' }, item.group, item.ref));
      return false;
    }
    positions.set(index, positions.size);
    return true;
  });
  return newBlock({ ...block, items, display: block.display.flatMap((index) => positions.has(index) ? [positions.get(index)!] : []) });
}

export function pinnedDocuments(overrides: ContextOverrides | undefined, tree: TreeIndex, state: ProjectState): { block: Block; drops: DropRecord[] } {
  const excluded = overrideIds(overrides, 'exclude', 'doc');
  const drops: DropRecord[] = [];
  const nodes = [...overrideIds(overrides, 'include', 'doc')].sort(compareText).flatMap((id) => {
    const node = tree.nodes.get(id);
    if (node?.type !== 'document') return [];
    if (excluded.has(id)) {
      drops.push(dropRecord(node.title, { kind: 'writer-excluded' }, 'pin', { kind: 'doc', id }));
      return [];
    }
    return [node];
  });
  const items = nodes.slice(0, 3).map((node) => ({
    ref: { kind: 'doc' as const, id: node.id },
    label: node.title,
    reason: REQUEST_PIN_REASON,
    body: `## ${node.title} (pinned excerpt)\nSynopsis: ${synopsisOf(node)}\n\nFirst 1,500 body characters:\n${getBody(state, node.id).slice(0, 1_500)}`,
    protected: false,
    group: 'pin',
  }));
  drops.push(...nodes.slice(3).map((node) => dropRecord(node.title, { kind: 'pin-limit', limit: 3 }, 'pin', { kind: 'doc', id: node.id })));
  return { block: newBlock({ id: 'L5', header: '## Pinned document excerpts', empty: '', items, display: items.map((_, index) => index) }), drops };
}
