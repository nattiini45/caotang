/**
 * The writing-furniture descriptors' own checks — binder-filters §2, §5 and goals-progress §2.2, §4.
 *
 * The bus refuses a malformed filter or goal before any apply runs, and it returns the normalised value it checked, so the
 * store writes what the bus validated. Each refusal below is one rule the spec states, with the field it names.
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_REGISTRY, type ValidationNode, type ValidationSnapshot } from '../src/index.js';

const NODE = (overrides: Partial<ValidationNode> & { id: string; type: string }): ValidationNode => ({
  parentId: null,
  title: overrides.id,
  status: null,
  label: null,
  keywords: [],
  synopsis: '',
  notes: '',
  ...overrides,
});

/** A small project: the two roots, a folder, a scene under it, and a status and a label in the vocabulary. */
const SNAPSHOT: ValidationSnapshot = {
  manifest: {
    tree: [
      NODE({ id: 'root', type: 'root' }),
      NODE({ id: 'manuscript', type: 'folder', parentId: 'root', title: 'Manuscript' }),
      NODE({ id: 'research', type: 'folder', parentId: 'root', title: 'Research' }),
      NODE({ id: 'n_CHAPTERONE0', type: 'folder', parentId: 'manuscript', title: 'Chapter 1' }),
      NODE({ id: 'n_SCENEONE000', type: 'document', parentId: 'n_CHAPTERONE0', title: 'The Landing' }),
    ],
    vocabulary: { statuses: [{ id: 'draft' }], labels: [{ id: 'act-1' }] },
  },
  documents: new Map(),
};

const FILTER_ID = 'q_ABCDEFGHJK';
const GOAL_ID = 'g_ABCDEFGHJK';

function validateSave(params: Record<string, unknown>) {
  return COMMAND_REGISTRY['binder.saveFilter'].descriptor.validate(params, SNAPSHOT);
}

function validateGoal(params: Record<string, unknown>) {
  return COMMAND_REGISTRY['project.saveGoal'].descriptor.validate(params, SNAPSHOT);
}

function errorCodeOf(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('the four furniture descriptors carry the spec columns', () => {
  it('are project mutations, write-auto, with an exact inverse, and no agent-visible view class', () => {
    for (const name of ['binder.saveFilter', 'binder.deleteFilter', 'project.saveGoal', 'project.deleteGoal'] as const) {
      const descriptor = COMMAND_REGISTRY[name].descriptor;
      expect(descriptor.mutates).toBe('project');
      expect(descriptor.agentRisk).toBe('write-auto');
      expect(descriptor.undo).toBe('inverse');
    }
  });
});

describe('a vocabulary id the project does not hold', () => {
  it('says which vocabulary it was named in, so a plan can tell it from a shape error', () => {
    const missing = validateSave({ filter: { name: 'x', criteria: { statusId: 'final' } } });
    expect(missing.ok ? undefined : missing.error.details).toEqual({ unknownVocabulary: 'status' });
    const label = validateSave({ filter: { name: 'x', criteria: { labelId: 'act-9' } } });
    expect(label.ok ? undefined : label.error.details).toEqual({ unknownVocabulary: 'label' });
    const shape = validateSave({ filter: { name: 'x', criteria: { statusId: '' } } });
    expect(shape.ok ? undefined : shape.error.details).toBeUndefined();
    const meta = COMMAND_REGISTRY['binder.setMeta'].descriptor.validate({ nodeId: 'n_SCENEONE000', patch: { status: 'final' } }, SNAPSHOT);
    expect(meta.ok ? undefined : meta.error.details).toEqual({ unknownVocabulary: 'status' });
  });
});

describe('binder.saveFilter', () => {
  it('accepts a filter with a root and criteria, and returns the name trimmed and the criteria copied', () => {
    const result = validateSave({
      filter: { id: FILTER_ID, name: '  Drafts about the sea  ', root: 'research', criteria: { statusId: 'draft', keywordsAny: ['sea'] } },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        filter: { id: FILTER_ID, name: 'Drafts about the sea', root: 'research', criteria: { statusId: 'draft', keywordsAny: ['sea'] } },
      },
    });
  });

  it('accepts a filter with no id, because the store mints one', () => {
    expect(validateSave({ filter: { name: 'Long chapters', criteria: { minWords: 2_000 } } }).ok).toBe(true);
  });

  it('accepts the two date windows and the keyword match-all list (binder-filters §2.1)', () => {
    const result = validateSave({
      filter: { name: 'Recent', criteria: { keywordsAll: ['sea', 'grief'], modifiedWithinDays: 7, createdWithinDays: 30 } },
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a malformed id, a blank name and a name over sixty characters', () => {
    expect(errorCodeOf(validateSave({ filter: { id: 'f_BAD', name: 'x', criteria: {} } }))).toBe('invalid-params');
    expect(errorCodeOf(validateSave({ filter: { name: '   ', criteria: {} } }))).toBe('invalid-params');
    expect(errorCodeOf(validateSave({ filter: { name: 'x'.repeat(61), criteria: {} } }))).toBe('invalid-params');
  });

  it('refuses a root that is neither manuscript nor research', () => {
    expect(errorCodeOf(validateSave({ filter: { name: 'x', root: 'both', criteria: {} } }))).toBe('invalid-params');
  });

  it('refuses a criterion this build does not know, and a status that is not in the vocabulary', () => {
    expect(errorCodeOf(validateSave({ filter: { name: 'x', criteria: { colour: 'red' } } }))).toBe('invalid-params');
    expect(errorCodeOf(validateSave({ filter: { name: 'x', criteria: { statusId: 'final' } } }))).toBe('invalid-params');
  });

  it('refuses a tag list over thirty-two entries, a negative word bound, and a zero-day window', () => {
    const tags = Array.from({ length: 33 }, (_, i) => `t${i}`);
    expect(errorCodeOf(validateSave({ filter: { name: 'x', criteria: { keywordsAny: tags } } }))).toBe('invalid-params');
    expect(errorCodeOf(validateSave({ filter: { name: 'x', criteria: { minWords: -1 } } }))).toBe('invalid-params');
    expect(errorCodeOf(validateSave({ filter: { name: 'x', criteria: { createdWithinDays: 0 } } }))).toBe('invalid-params');
  });

  it('refuses a filter field the spec does not carry, with the field named', () => {
    const result = validateSave({ filter: { name: 'x', criteria: {}, colour: 'red' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('colour');
  });
});

describe('binder.deleteFilter', () => {
  it('takes a filter id, and refuses any other key', () => {
    expect(COMMAND_REGISTRY['binder.deleteFilter'].descriptor.validate({ filterId: FILTER_ID }, SNAPSHOT)).toEqual({
      ok: true,
      value: { filterId: FILTER_ID },
    });
    expect(
      COMMAND_REGISTRY['binder.deleteFilter'].descriptor.validate({ filterId: FILTER_ID, name: 'x' }, SNAPSHOT).ok,
    ).toBe(false);
  });
});

describe('project.saveGoal', () => {
  it('accepts the manuscript root and a folder, and returns the goal in the spec shape', () => {
    const result = validateGoal({ goal: { id: GOAL_ID, nodeId: 'manuscript', comparator: 'at-least', target: 12_000, deadline: '2026-10-31' } });
    expect(result).toEqual({
      ok: true,
      value: { goal: { id: GOAL_ID, nodeId: 'manuscript', comparator: 'at-least', target: 12_000, deadline: '2026-10-31' } },
    });
    expect(validateGoal({ goal: { nodeId: 'n_CHAPTERONE0', comparator: 'about', target: 2_000 } }).ok).toBe(true);
  });

  it('refuses a scene as a target (goals-progress §2.2: folder and root only)', () => {
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'n_SCENEONE000', comparator: 'at-least', target: 500 } }))).toBe('invalid-params');
  });

  it('refuses a target that is missing from the project', () => {
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'n_NOSUCHNODE', comparator: 'at-least', target: 500 } }))).toBe('invalid-params');
  });

  it('refuses a zero or fractional target, an unknown comparator, and a metric that is neither words nor characters', () => {
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 0 } }))).toBe('invalid-params');
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 1.5 } }))).toBe('invalid-params');
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'manuscript', comparator: 'roughly', target: 500 } }))).toBe('invalid-params');
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'manuscript', metric: 'pages', comparator: 'at-least', target: 500 } }))).toBe('invalid-params');
  });

  // goals-progress §9.2: `chars` is a metric a project goal may take. The validator takes words or characters.
  it('takes characters as well as words, and returns the metric only when it is characters', () => {
    const chars = validateGoal({ goal: { id: GOAL_ID, nodeId: 'manuscript', metric: 'chars', comparator: 'at-least', target: 90_000 } });
    expect(chars).toEqual({
      ok: true,
      value: { goal: { id: GOAL_ID, nodeId: 'manuscript', metric: 'chars', comparator: 'at-least', target: 90_000 } },
    });
    const words = validateGoal({ goal: { nodeId: 'manuscript', metric: 'words', comparator: 'at-least', target: 500 } });
    expect(words.ok && words.value).toEqual({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 500 } });
  });

  // goals-progress §9.3: a weekly or monthly goal is a session window on the manuscript.
  it('takes a weekly or monthly goal on the manuscript, as a minimum in words with no deadline', () => {
    const weekly = validateGoal({ goal: { nodeId: 'manuscript', kind: 'weekly', comparator: 'at-least', target: 7_000 } });
    expect(weekly).toEqual({ ok: true, value: { goal: { nodeId: 'manuscript', kind: 'weekly', comparator: 'at-least', target: 7_000 } } });
    expect(validateGoal({ goal: { nodeId: 'manuscript', kind: 'monthly', comparator: 'at-least', target: 30_000 } }).ok).toBe(true);
  });

  it('leaves out a project kind, which is the default, so a project goal keeps its shape', () => {
    const result = validateGoal({ goal: { nodeId: 'manuscript', kind: 'project', comparator: 'at-least', target: 500 } });
    expect(result.ok && result.value).toEqual({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 500 } });
  });

  it('refuses each rule a weekly or monthly goal breaks, and names the first one it breaks', () => {
    const weekly = (over: Record<string, unknown>) =>
      validateGoal({ goal: { nodeId: 'manuscript', kind: 'weekly', comparator: 'at-least', target: 7_000, ...over } });
    expect(weekly({ nodeId: 'n_CHAPTERONE0' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-params', message: expect.stringContaining('attaches to the manuscript root') },
    });
    expect(weekly({ metric: 'chars' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-params', message: expect.stringContaining('counts words, because a session records words') },
    });
    expect(weekly({ comparator: 'about' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-params', message: expect.stringContaining('is a minimum, so its comparator is at-least') },
    });
    expect(weekly({ deadline: '2026-10-31' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-params', message: expect.stringContaining('recurs, so it takes no deadline') },
    });
    // The folder rule comes first, so a goal that breaks two rules is refused for the one a writer meets first.
    expect(weekly({ nodeId: 'n_CHAPTERONE0', metric: 'chars' })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('attaches to the manuscript root') },
    });
  });

  // goals-progress §9.3: each weekly or monthly goal picks its own reset day.
  it('takes a reset weekday on a weekly goal and a reset day or "last" on a monthly goal, and returns it', () => {
    const goal = (kind: string, resetDay: unknown) =>
      validateGoal({ goal: { nodeId: 'manuscript', kind, comparator: 'at-least', target: 7_000, resetDay } });
    expect(goal('weekly', 0)).toEqual({
      ok: true,
      value: { goal: { nodeId: 'manuscript', kind: 'weekly', resetDay: 0, comparator: 'at-least', target: 7_000 } },
    });
    expect(goal('weekly', 6).ok).toBe(true);
    expect(goal('monthly', 1).ok).toBe(true);
    expect(goal('monthly', 28).ok).toBe(true);
    const last = goal('monthly', 'last');
    expect(last.ok && last.value.goal.resetDay).toBe('last');
    // null is the default, the same as leaving the key out.
    const unset = goal('monthly', null);
    expect(unset.ok && unset.value.goal).not.toHaveProperty('resetDay');
  });

  it('refuses a reset day the goal cannot use, at goal.resetDay', () => {
    const goal = (kind: string, resetDay: unknown) =>
      validateGoal({ goal: { nodeId: 'manuscript', kind, comparator: 'at-least', target: 7_000, resetDay } });
    expect(goal('weekly', 7)).toMatchObject({
      ok: false,
      error: { code: 'invalid-params', target: 'goal.resetDay', message: 'a weekly goal resets on a weekday, 0 (Sunday) to 6 (Saturday)' },
    });
    expect(goal('weekly', 'last')).toMatchObject({ ok: false, error: { target: 'goal.resetDay' } });
    expect(goal('monthly', 29)).toMatchObject({
      ok: false,
      error: { message: 'a monthly goal resets on a day from 1 to 28, or on "last" for the last day of the month' },
    });
    expect(goal('monthly', 0).ok).toBe(false);
    expect(goal('monthly', '15').ok).toBe(false);
    expect(goal('project', 1)).toMatchObject({ ok: false, error: { message: 'a project goal does not reset, so it takes no reset day' } });
  });

  it('refuses a kind that is not project, weekly or monthly', () => {
    expect(validateGoal({ goal: { nodeId: 'manuscript', kind: 'daily', comparator: 'at-least', target: 500 } })).toMatchObject({
      ok: false,
      error: { code: 'invalid-params', message: 'unknown kind "daily"' },
    });
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'manuscript', kind: 7, comparator: 'at-least', target: 500 } }))).toBe('invalid-params');
  });

  it('refuses a deadline that is not a real calendar day', () => {
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 500, deadline: '2026-02-30' } }))).toBe('invalid-params');
    expect(errorCodeOf(validateGoal({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 500, deadline: '31/10/2026' } }))).toBe('invalid-params');
  });

  it('keeps archived only when it is true, and drops an absent or false one', () => {
    const archived = validateGoal({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 500, archived: true } });
    expect(archived.ok && archived.value).toEqual({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 500, archived: true } });
    const notArchived = validateGoal({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 500, archived: false } });
    expect(notArchived.ok && notArchived.value).toEqual({ goal: { nodeId: 'manuscript', comparator: 'at-least', target: 500 } });
  });
});

describe('project.deleteGoal', () => {
  it('needs a goal id', () => {
    expect(COMMAND_REGISTRY['project.deleteGoal'].descriptor.validate({ goalId: GOAL_ID }, SNAPSHOT).ok).toBe(true);
    expect(COMMAND_REGISTRY['project.deleteGoal'].descriptor.validate({}, SNAPSHOT).ok).toBe(false);
  });
});
