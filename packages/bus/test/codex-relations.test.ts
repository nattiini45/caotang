import { describe, expect, it } from 'vitest';
import {
  CODEX_RELATION_LABEL_MAX,
  CODEX_RELATION_MAX,
  codexRelationId,
  readCodexRelation,
  relationEditProblem,
} from '../src/index.js';

const facts = (over: Partial<{ liveIds: string[]; targets: string[]; ownId: string; remaining: number }> = {}) => ({
  liveIds: ['rel_0000000001'],
  targets: ['c_0000000001', 'c_0000000002'],
  ownId: 'c_0000000001',
  remaining: 1,
  ...over,
});

describe('the relation id and record', () => {
  it('accepts a generated rel_ id and refuses anything else', () => {
    expect(codexRelationId({ id: 'rel_7K3M2Q8XZC' })).toBe('rel_7K3M2Q8XZC');
    expect(codexRelationId({ id: 'ref_7K3M2Q8XZC' })).toBeUndefined();
    expect(codexRelationId({ id: 'rel_short' })).toBeUndefined();
    expect(codexRelationId('rel_7K3M2Q8XZC')).toBeUndefined();
  });

  it('reads a target and an optional label, and keeps an unknown key out of the record', () => {
    expect(readCodexRelation({ id: 'rel_7K3M2Q8XZC', targetId: 'c_0000000002', label: 'ally', extra: 1 }))
      .toEqual({ id: 'rel_7K3M2Q8XZC', targetId: 'c_0000000002', label: 'ally' });
    expect(readCodexRelation({ id: 'rel_7K3M2Q8XZC', targetId: 'c_0000000002' }))
      .toEqual({ id: 'rel_7K3M2Q8XZC', targetId: 'c_0000000002' });
    expect(readCodexRelation({ id: 'rel_7K3M2Q8XZC' })).toBeUndefined();
  });
});

describe('a relation edit is checked before anything is written', () => {
  it('creates only against a live entry that is not this one', () => {
    expect(relationEditProblem({ action: 'create', targetId: 'c_0000000002' }, facts())).toBeUndefined();
    expect(relationEditProblem({ action: 'create', targetId: 'c_0000000001' }, facts())).toBe('an entry cannot relate to itself');
    expect(relationEditProblem({ action: 'create', targetId: 'c_NOSUCHENTRY' }, facts())).toBe('targetId must name an existing codex entry');
    expect(relationEditProblem({ action: 'create' }, facts())).toBe('targetId must name an existing codex entry');
  });

  it('holds the per-entry cap at its boundary', () => {
    expect(relationEditProblem({ action: 'create', targetId: 'c_0000000002' }, facts({ remaining: 1 }))).toBeUndefined();
    expect(relationEditProblem({ action: 'create', targetId: 'c_0000000002' }, facts({ remaining: 0 })))
      .toContain(`at most ${CODEX_RELATION_MAX} relations`);
  });

  it('updates and removes only an id the entry already holds', () => {
    expect(relationEditProblem({ action: 'update', id: 'rel_0000000001', label: 'rival' }, facts())).toBeUndefined();
    expect(relationEditProblem({ action: 'update', id: 'rel_0000000001', label: null }, facts())).toBeUndefined();
    expect(relationEditProblem({ action: 'update', id: 'rel_0000000001' }, facts())).toBe('provide a label to update');
    expect(relationEditProblem({ action: 'remove', id: 'rel_0000000002' }, facts())).toBe('id must name one existing relation on this entry');
    expect(relationEditProblem({ action: 'remove', id: 'rel_0000000001' }, facts())).toBeUndefined();
  });

  it('refuses a field the action does not carry', () => {
    expect(relationEditProblem({ action: 'remove', id: 'rel_0000000001', label: 'ally' }, facts()))
      .toBe('unexpected field "label" for remove');
    expect(relationEditProblem({ action: 'update', id: 'rel_0000000001', targetId: 'c_0000000002', label: 'x' }, facts()))
      .toBe('unexpected field "targetId" for update');
    expect(relationEditProblem({ action: 'remove', id: 'rel_0000000001', targetId: 'c_0000000002' }, facts()))
      .toBe('unexpected field "targetId" for remove');
  });

  it('bounds the label', () => {
    expect(relationEditProblem({ action: 'create', targetId: 'c_0000000002', label: 'x'.repeat(CODEX_RELATION_LABEL_MAX) }, facts())).toBeUndefined();
    expect(relationEditProblem({ action: 'create', targetId: 'c_0000000002', label: 'x'.repeat(CODEX_RELATION_LABEL_MAX + 1) }, facts()))
      .toContain('at most');
    expect(relationEditProblem({ action: 'create', targetId: 'c_0000000002', label: '  ' }, facts())).toBe('label must be nonblank text of at most 60 characters');
    expect(relationEditProblem({ action: 'create', targetId: 'c_0000000002', label: null }, facts())).toBe('label must be text');
  });
});
