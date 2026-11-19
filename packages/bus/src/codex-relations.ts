import { isCodexDetailObject } from './codex-details.js';

export const CODEX_RELATION_MAX = 40;
export const CODEX_RELATION_LABEL_MAX = 60;
export const CODEX_RELATION_FIELDS = ['label'] as const;

export type CodexRelation = { id: string; targetId: string; label?: string };
type RelationPatch = { label?: string | null };
export type CodexRelationEdit =
  | ({ action: 'create'; targetId: string } & RelationPatch)
  | ({ action: 'update'; id: string } & RelationPatch)
  | { action: 'remove'; id: string };

export function codexRelationId(value: unknown): string | undefined {
  const id = isCodexDetailObject(value) ? value['id'] : undefined;
  return typeof id === 'string' && /^rel_[0-9A-HJKMNP-TV-Z]{10}$/.test(id) ? id : undefined;
}

export function relationLabelProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || [...value].length > CODEX_RELATION_LABEL_MAX) {
    return `must be nonblank text of at most ${CODEX_RELATION_LABEL_MAX} characters`;
  }
  return undefined;
}

export function readCodexRelation(value: unknown): CodexRelation | undefined {
  const id = codexRelationId(value);
  const targetId = isCodexDetailObject(value) ? value['targetId'] : undefined;
  if (id === undefined || typeof targetId !== 'string') return undefined;
  const relation: CodexRelation = { id, targetId };
  const label = isCodexDetailObject(value) ? value['label'] : undefined;
  if (typeof label === 'string' && relationLabelProblem(label) === undefined) relation.label = label;
  return relation;
}

export function relationEditProblem(
  value: unknown,
  facts: {
    readonly liveIds: readonly string[];
    readonly targets: readonly string[];
    readonly ownId: string;
    /** How many relations this batch may still add: the cap, minus what the entry holds, plus what the batch removes. */
    readonly remaining: number;
  },
): string | undefined {
  if (!isCodexDetailObject(value)) return 'must be an operation object';
  const { action, id } = value;
  if (action !== 'create' && action !== 'update' && action !== 'remove') return 'action must be create, update or remove';
  for (const key of Object.keys(value)) {
    if (key === 'action') continue;
    if (key === 'id' && action !== 'create') continue;
    if (key === 'targetId' && action === 'create') continue;
    if (action !== 'remove' && CODEX_RELATION_FIELDS.some((field) => field === key)) continue;
    return `unexpected field "${key}" for ${action}`;
  }
  if (action === 'create') {
    if (facts.remaining <= 0) return `an entry can hold at most ${CODEX_RELATION_MAX} relations`;
    const targetId = value['targetId'];
    if (typeof targetId !== 'string' || !facts.targets.includes(targetId)) return 'targetId must name an existing codex entry';
    if (targetId === facts.ownId) return 'an entry cannot relate to itself';
  } else if (typeof id !== 'string' || facts.liveIds.filter((candidate) => candidate === id).length !== 1) {
    return 'id must name one existing relation on this entry';
  }
  if (action !== 'remove') {
    const label = value['label'];
    if (label !== undefined) {
      if (label === null && action === 'create') return 'label must be text';
      if (label !== null) {
        const problem = relationLabelProblem(label);
        if (problem !== undefined) return `label ${problem}`;
      }
    }
    if (action === 'update' && !Object.hasOwn(value, 'label')) return 'provide a label to update';
  }
  return undefined;
}
