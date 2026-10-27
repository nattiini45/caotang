import { expect, test } from '@playwright/test';
import type { ProjectMacro } from '../../packages/bus/src/index.js';
import { expandMacro, type PlanStep } from '../../packages/harness/src/index.js';

import { savesAsMacro, newTurnView, type TurnView } from '../../apps/desktop/src/app/agent-model.js';
import {
  fieldsOf,
  leafKey,
  leavesOf,
  macroFromPlan,
  macroRows,
  paramNameFor,
  pathLabel,
  slugFromName,
  stepLines,
  valuesOf,
} from '../../apps/desktop/src/app/macro-model.js';

const PLAN: PlanStep[] = [
  { tool: 'meta.set', params: { targets: ['The Landing'], status: 'final' }, expect: 'The Landing is marked final.' },
  { tool: 'notes.append', params: { doc: 'The Landing', text: 'Revised.' }, expect: 'A note is added.' },
];

const FORM = { name: 'Revise a scene', description: 'Marks a scene final and notes it.', slug: '' };

function keyOf(step: number, ...path: (string | number)[]): string {
  return leafKey({ step, path });
}

test('a slug comes from a name, within its length, and a param name from where a value sits', () => {
  expect(slugFromName('Revise a scene')).toBe('revise-a-scene');
  expect(slugFromName('  --Ünï: 2nd pass!  ')).toBe('n-2nd-pass');
  expect(slugFromName('???')).toBe('');
  expect(slugFromName('x'.repeat(80))).toHaveLength(40);
  expect(paramNameFor(['targets', 0])).toBe('targets');
  expect(paramNameFor(['criteria', 'status-id'])).toBe('status_id');
  expect(paramNameFor([0])).toBe('value');
});

test('the values of a plan that can be marked are found in lists and objects, with where each sits', () => {
  const leaves = leavesOf([{ params: { targets: ['a', 'b'], status: 'final', n: 3, flag: true, none: null, deep: { x: { y: 'z' } } } }]);
  expect(leaves.map((leaf) => pathLabel(leaf.path))).toEqual(['targets[1]', 'targets[2]', 'status', 'n', 'flag', 'deep.x.y']);
  expect(leaves.map((leaf) => leaf.value)).toEqual(['a', 'b', 'final', 3, true, 'z']);
});

test('a plan card with marked values becomes a macro that, run as it stands, reproduces the plan', () => {
  const made = macroFromPlan(PLAN, FORM, {
    [keyOf(0, 'targets', 0)]: 'scene',
    [keyOf(1, 'doc')]: 'scene',
    [keyOf(0, 'status')]: 'status',
  });
  if (!('draft' in made)) throw new Error(made.problem);
  expect(made.draft.slug).toBe('revise-a-scene');
  expect(Object.keys(made.draft.params.properties)).toEqual(['scene', 'status']);
  expect(made.draft.params.properties['scene']).toMatchObject({ kind: 'string', default: 'The Landing', nonBlank: true });
  expect(made.draft.params.properties['status']).toMatchObject({ kind: 'string', default: 'final' });
  expect(made.draft.steps[0]?.params).toEqual({ targets: [{ $param: 'scene' }], status: { $param: 'status' } });
  expect(made.draft.steps[1]?.params).toEqual({ doc: { $param: 'scene' }, text: 'Revised.' });

  const macro: ProjectMacro = { id: 'm_7K2QX9M4A1', ...made.draft };
  const same = expandMacro(macro, {});
  expect(same.ok && same.value.steps).toEqual(PLAN);
  const other = expandMacro(macro, { scene: 'The Storm', status: 'draft' });
  expect(other.ok && other.value.steps[0]?.params).toEqual({ targets: ['The Storm'], status: 'draft' });
});

test('a macro with nothing marked is a fixed sequence, and still reproduces the plan', () => {
  const made = macroFromPlan(PLAN, FORM, {});
  if (!('draft' in made)) throw new Error(made.problem);
  expect(made.draft.params.properties).toEqual({});
  const run = expandMacro({ id: 'm_7K2QX9M4A1', ...made.draft }, {});
  expect(run.ok && run.value.steps).toEqual(PLAN);
});

test('a value takes the kind of the field it stands in: a choice, a number', () => {
  const steps: PlanStep[] = [
    { tool: 'binder.restructure', params: { ops: [{ action: 'rename', node: 'n_CHAPTR0001', title: 'Prologue' }] }, expect: 'Renamed.' },
    { tool: 'export.compile', params: { format: 'md', selection: { root: 'manuscript' } }, expect: 'Compiled.' },
  ];
  const made = macroFromPlan(steps, { ...FORM, name: 'Rename and compile' }, { [keyOf(0, 'ops', 0, 'title')]: 'title', [keyOf(1, 'format')]: 'format' });
  if (!('draft' in made)) throw new Error(made.problem);
  expect(made.draft.params.properties['title']).toMatchObject({ kind: 'string', default: 'Prologue' });
  const format = made.draft.params.properties['format'];
  expect(format?.kind).toBe('enum');
  if (format?.kind === 'enum') expect(format.values).toContain('md');
});

test('marking leaves out what cannot be saved, each with a reason in words', () => {
  const none = macroFromPlan(PLAN, { ...FORM, name: '   ' }, {});
  expect('problem' in none && none.problem).toContain('name');
  const clash = macroFromPlan(PLAN, FORM, { [keyOf(0, 'targets', 0)]: 'x', [keyOf(0, 'status')]: 'x' });
  expect('problem' in clash && clash.problem).toContain('two different values');
  const bad = macroFromPlan(PLAN, FORM, { [keyOf(0, 'status')]: 'not a name' });
  expect('problem' in bad && bad.problem).toContain('not a param name');
  const slug = macroFromPlan(PLAN, { ...FORM, slug: 'Bad Slug' }, {});
  expect('problem' in slug && slug.problem).toContain('slug');
  const tag = macroFromPlan(
    [{ tool: 'binder.restructure', params: { ops: [{ action: 'rename', node: 'n_CHAPTR0001', title: 'P' }] }, expect: 'x' }],
    FORM,
    { [keyOf(0, 'ops', 0, 'action')]: 'action' },
  );
  expect('problem' in tag && tag.problem).toContain('choose the operation');
  const unknown = macroFromPlan([{ tool: 'book.delete', params: { title: 'x' }, expect: 'x' }], FORM, { [keyOf(0, 'title')]: 'title' });
  expect('problem' in unknown).toBe(true);
  const builtin = macroFromPlan(PLAN, { ...FORM, name: 'Draft', slug: 'draft' }, {});
  expect('problem' in builtin && builtin.problem).toContain('built-in command');
});

test('the run form asks for each value the macro declares, with the default it starts at, and reads them back typed', () => {
  const macro: ProjectMacro = {
    id: 'm_7K2QX9M4A1',
    slug: 'form',
    name: 'Form',
    description: '',
    params: {
      kind: 'object',
      description: 'p',
      properties: {
        scene: { kind: 'string', description: 'The scene', default: 'The Landing' },
        status: { kind: 'enum', description: 'Status', values: ['draft', 'final'], default: 'final' },
        count: { kind: 'integer', description: 'How many' },
        loud: { kind: 'boolean', description: 'Loud' },
      },
      required: ['scene'],
    },
    steps: [{ tool: 'notes.append', params: { doc: { $param: 'scene' }, text: 'x' }, expect: 'Adds a note.' }],
  };
  const fields = fieldsOf(macro);
  expect(fields.map((field) => [field.name, field.kind, field.required, field.initial])).toEqual([
    ['scene', 'string', true, 'The Landing'],
    ['status', 'enum', false, 'final'],
    ['count', 'integer', false, ''],
    ['loud', 'boolean', false, 'false'],
  ]);
  expect(valuesOf(fields, {})).toEqual({ values: { scene: 'The Landing', status: 'final', loud: false } });
  expect(valuesOf(fields, { scene: 'The Storm', count: '3', loud: 'true' })).toEqual({ values: { scene: 'The Storm', status: 'final', count: 3, loud: true } });
  expect(valuesOf(fields, { scene: '   ' })).toEqual({ problem: '“The scene” needs a value.' });
  expect(valuesOf(fields, { count: '2.5' })).toEqual({ problem: '“How many” needs a whole number.' });
  expect(stepLines(macro, { scene: 'The Storm' })).toEqual({ lines: [{ tool: 'notes.append', expect: 'Adds a note.', params: '{"doc":"The Storm","text":"x"}' }] });
  // The default fills a value the run was not given; a required value with no default is the run's problem.
  expect(stepLines(macro, {})).toMatchObject({ lines: [{ params: '{"doc":"The Landing","text":"x"}' }] });
  const bare = { ...macro, params: { ...macro.params, properties: { scene: { kind: 'string' as const, description: 'The scene' } } } };
  expect(stepLines(bare, {})).toMatchObject({ problem: expect.stringContaining('required') });
});

test('the list says where each macro stands: its risk, or why it cannot run now', () => {
  const fits: ProjectMacro = { id: 'm_7K2QX9M4A1', slug: 'ok', name: 'Fits', description: '', params: { kind: 'object', description: 'p', properties: {}, required: [] }, steps: [{ tool: 'notes.append', params: { doc: 'x', text: 'y' }, expect: 'z' }] };
  const stale: ProjectMacro = { ...fits, id: 'm_ABCDEFGHJK', slug: 'stale', name: 'Stale', steps: [{ tool: 'book.delete', params: {}, expect: 'z' }] };
  const [first, second] = macroRows([fits, stale]);
  expect(first).toMatchObject({ problem: null, risk: 'write-auto' });
  expect(second?.risk).toBeNull();
  expect(second?.problem).toContain('“Stale” cannot run');
});

test('Save as macro is offered under a plan the writer approved and the agent ran, and nowhere else', () => {
  const base = newTurnView('t1', 'Do it');
  const card = { id: 'c', turnId: 't1', kind: 'plan' as const, revision: 0, previewRevision: 0, from: 0, approvable: true, canAcceptCut: false, cut: false, steps: [{ index: 0, origin: 0, tool: 'meta.set', expect: 'x', risk: 'write-auto', params: {}, status: 'done' as const, badges: [], stale: false, cut: false }] };
  const report = (decision: 'approved' | 'auto' | 'cancelled', status = 'applied') =>
    ({ status, cards: [{ kind: 'plan', tools: ['meta.set'], decision, edits: 0, retries: 0 }] }) as unknown as TurnView['report'];
  const turn = (patch: Partial<TurnView>): TurnView => ({ ...base, plan: card, report: report('approved'), ...patch });
  expect(savesAsMacro(turn({}))).toBe(true);
  expect(savesAsMacro(turn({ report: report('auto') }))).toBe(false);
  expect(savesAsMacro(turn({ report: report('cancelled', 'cancelled') }))).toBe(false);
  expect(savesAsMacro(turn({ report: null }))).toBe(false);
  expect(savesAsMacro(turn({ plan: null }))).toBe(false);
  expect(savesAsMacro(turn({ command: 'macro-revise' }))).toBe(false);
  expect(savesAsMacro(turn({ plan: { ...card, steps: [{ ...card.steps[0]!, status: 'refused' as const }] } }))).toBe(false);
});
