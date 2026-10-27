/**
 * Macros at run time (extensibility.md §10): `checkMacro` and `expandMacro` over the real registry, and the plan they make held against
 * the same plan submitted directly. The bus's own structural checks are in the bus's test; what is here is what needs the registry:
 * the tool exists and is native, a placeholder fits the field it stands in, the risk is the maximum over the steps, and a stale or
 * hand-edited macro is refused at run time with a message.
 */

import { MACRO_STEPS_MAX, type MacroStep, type ProjectMacro } from '@caotang/bus';
import { describe, expect, it } from 'vitest';

import { checkMacro, expandMacro, macroCommandName, macroIntent, macroRisk, registryMacroTools, type MacroRegistry, type RuleSet, type SourcedRule } from '../src/index.js';
import { PLAN_STEPS_MAX } from '../src/plan.js';
import { CHAPTER_ONE, callId, makeHarness, makeState, snapshotOf } from './fixtures.js';

const ID = 'm_7K2QX9M4A1';

const PARAMS = {
  kind: 'object' as const,
  description: 'The macro params.',
  properties: {
    chapter: { kind: 'string' as const, description: 'The chapter or scene.' },
    status: { kind: 'enum' as const, description: 'The status.', values: ['draft', 'revised', 'final'], default: 'revised' },
    note: { kind: 'string' as const, description: 'A note.' },
    count: { kind: 'integer' as const, description: 'A number.' },
    flag: { kind: 'boolean' as const, description: 'A switch.' },
  },
  required: ['chapter'],
};

function macro(overrides: Partial<ProjectMacro> = {}): ProjectMacro {
  return structuredClone({
    id: ID,
    slug: 'revise-chapter',
    name: 'Revise chapter',
    description: 'Marks a chapter revised and notes it.',
    params: PARAMS,
    steps: [
      { tool: 'meta.set', params: { targets: [{ $param: 'chapter' }], status: { $param: 'status' } }, expect: 'The chapter is marked.' },
      { tool: 'notes.append', params: { doc: { $param: 'chapter' }, text: 'Revised.' }, expect: 'A note is added.' },
    ],
    ...overrides,
  }) as ProjectMacro;
}

const step = (tool: string, params: Record<string, unknown>): MacroStep => ({ tool, params: params as MacroStep['params'], expect: 'Does it.' });

describe('checkMacro', () => {
  it('accepts a macro that fits the registry, and reports its risk and its tools', () => {
    const checked = checkMacro(macro());
    expect(checked).toMatchObject({ ok: true, value: { risk: 'write-auto', tools: ['meta.set', 'notes.append'] } });
  });

  it('keeps the plan ceiling the bus names for a macro', () => {
    expect(MACRO_STEPS_MAX).toBe(PLAN_STEPS_MAX);
  });

  it('names the macro and the step when a tool is not in this build', () => {
    const result = checkMacro(macro({ steps: [step('book.delete', {})] }));
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'steps[0].tool' } });
    if (!result.ok) expect(result.error.message).toContain('“Revise chapter” cannot run: step 1 names “book.delete”');
  });

  it('refuses the rows a macro may never name, each for the bus’s own reason', () => {
    for (const tool of ['agent.plan', 'tool.search', 'mcp__notion__search', 'macro.revise-chapter']) {
      const result = checkMacro(macro({ steps: [step(tool, {})] }));
      expect(result.ok, tool).toBe(false);
    }
  });

  it('refuses a row only an external host is served, and the protocol row', () => {
    expect(registryMacroTools().tool('scene.brief')).toBeUndefined();
    expect(registryMacroTools().tool('dialogue.apply')).toBeUndefined();
    expect(registryMacroTools().tool('agent.plan')).toBeUndefined();
    expect(registryMacroTools().tool('meta.set')).toMatchObject({ name: 'meta.set', risk: 'write-auto' });
    expect(checkMacro(macro({ steps: [step('scene.brief', {})] })).ok).toBe(false);
  });

  it('refuses a placeholder whose param cannot satisfy the field, with the field and both kinds named', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['notes.append', { doc: { $param: 'count' }, text: 'x' }],
      ['meta.set', { targets: ['x'], status: { $param: 'flag' } }],
      ['meta.set', { targets: { $param: 'chapter' } }],
      ['binder.restructure', { ops: { $param: 'chapter' } }],
    ];
    for (const [tool, params] of cases) {
      const result = checkMacro(macro({ steps: [step(tool, params)] }));
      expect(result, `${tool} ${JSON.stringify(params)}`).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    }
    const result = checkMacro(macro({ steps: [step('notes.append', { doc: { $param: 'count' }, text: 'x' })] }));
    if (!result.ok) {
      expect(result.error.message).toContain('“count”');
      expect(result.error.message).toContain('steps[0].params.doc');
      expect(result.error.message).toContain('whole number');
    }
  });

  it('refuses a placeholder in a field the tool does not name, and one that chooses a tagged operation', () => {
    expect(checkMacro(macro({ steps: [step('notes.append', { stray: { $param: 'chapter' }, doc: 'x', text: 'y' })] }))).toMatchObject({ ok: false });
    const chosen = checkMacro(macro({ steps: [step('binder.restructure', { ops: [{ action: { $param: 'chapter' }, node: 'x' }] })] }));
    expect(chosen).toMatchObject({ ok: false });
    if (!chosen.ok) expect(chosen.error.message).toContain('choose the operation');
  });

  it('checks a placeholder inside a tagged operation against that operation’s field', () => {
    const rename = (value: unknown) => macro({ steps: [step('binder.restructure', { ops: [{ action: 'rename', node: { $param: 'chapter' }, title: value }] })] });
    expect(checkMacro(rename({ $param: 'note' })).ok).toBe(true);
    expect(checkMacro(rename({ $param: 'count' })).ok).toBe(false);
  });

  it('takes a choice param for a field that takes one of the same values, and a string param for a text field', () => {
    const fake: MacroRegistry = {
      tool: (name) =>
        name === 'x.go'
          ? {
              name,
              risk: 'write-auto',
              params: {
                kind: 'object',
                description: 'x',
                properties: {
                  mode: { kind: 'enum', description: 'm', values: ['draft', 'revised'] },
                  free: { kind: 'string', description: 'f' },
                  either: { kind: 'union', description: 'u', options: [{ kind: 'integer', description: 'i' }, { kind: 'boolean', description: 'b' }] },
                },
                required: [],
              },
            }
          : undefined,
    };
    const ok = (params: Record<string, unknown>) => checkMacro(macro({ steps: [step('x.go', params)] }), fake).ok;
    expect(ok({ mode: { $param: 'status' } })).toBe(false);
    const narrow = macro({ params: { ...PARAMS, properties: { ...PARAMS.properties, status: { kind: 'enum', description: 's', values: ['draft', 'revised'] } } }, steps: [step('x.go', { mode: { $param: 'status' } })] });
    expect(checkMacro(narrow, fake).ok).toBe(true);
    expect(ok({ free: { $param: 'status' } })).toBe(true);
    expect(ok({ mode: { $param: 'chapter' } })).toBe(false);
    expect(ok({ either: { $param: 'flag' } })).toBe(true);
    expect(ok({ either: { $param: 'chapter' } })).toBe(false);
  });

  it('refuses a macro whose slug is a built-in command, so it never shadows one', () => {
    for (const slug of ['draft', 'help', 'compile', 'restore', 'context']) {
      const result = checkMacro(macro({ slug }));
      expect(result.ok, slug).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('built-in command');
    }
    expect(checkMacro(macro({ slug: 'drafts' })).ok).toBe(true);
  });

  it('refuses a hand-edited macro for what the bus refuses: 31 steps, an unknown param, a prototype key, an oversize payload, a script', () => {
    const many = Array.from({ length: 31 }, () => step('notes.append', { doc: 'x', text: 'y' }));
    expect(checkMacro(macro({ steps: many })).ok).toBe(false);
    expect(checkMacro(macro({ steps: [step('notes.append', { doc: { $param: 'ghost' }, text: 'y' })] })).ok).toBe(false);
    const proto = JSON.parse('{"doc": "x", "text": "y", "__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(checkMacro(macro({ steps: [step('notes.append', proto)] })).ok).toBe(false);
    expect(checkMacro(macro({ steps: [step('notes.append', { doc: 'x', text: 'y'.repeat(30_000) })] })).ok).toBe(false);
    expect(checkMacro({ ...macro(), script: 'return plan' } as ProjectMacro).ok).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses, and does not throw on, a param placed under a key that names an Object.prototype member', () => {
    for (const key of ['toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', 'isPrototypeOf']) {
      for (const [tool, fixed] of [['meta.set', { targets: ['x'] }], ['notes.append', { doc: 'x' }]] as const) {
        const hostile = macro({ steps: [step(tool, { ...fixed, [key]: { $param: 'note' } })] });
        const result = checkMacro(hostile);
        expect(result, `${tool} ${key}`).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
        if (!result.ok) expect(result.error.message).toContain('does not say what it takes');
        expect(expandMacro(hostile, { chapter: 'a' }).ok).toBe(false);
      }
    }
  });

  it('refuses a stale macro: a tool whose field changed shape since the macro was saved', () => {
    const was = macro({ steps: [step('notes.append', { doc: { $param: 'chapter' }, text: 'x' })] });
    expect(checkMacro(was).ok).toBe(true);
    const registry = registryMacroTools();
    const changed: MacroRegistry = {
      tool(name) {
        const tool = registry.tool(name);
        if (tool === undefined || name !== 'notes.append') return tool;
        return { ...tool, params: { ...tool.params, properties: { ...tool.params.properties, doc: { kind: 'integer', description: 'now a number' } } } };
      },
    };
    const result = checkMacro(was, changed);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    if (!result.ok) expect(result.error.message).toContain('“chapter”');
  });
});

describe('derived risk is the maximum over the steps', () => {
  const read = step('project.overview', {});
  const auto = step('notes.append', { doc: 'The Landing', text: 'x' });
  const confirm = step('binder.restructure', { ops: [{ action: 'rename', node: CHAPTER_ONE, title: 'Prologue' }] });
  const sets: [string, MacroStep[], 'read' | 'write-auto' | 'write-confirm'][] = [
    ['read', [read], 'read'],
    ['write-auto', [auto], 'write-auto'],
    ['write-confirm', [confirm], 'write-confirm'],
    ['read and write-auto', [read, auto], 'write-auto'],
    ['read and write-confirm', [confirm, read], 'write-confirm'],
    ['write-auto and write-confirm', [auto, confirm], 'write-confirm'],
    ['all three', [auto, read, confirm], 'write-confirm'],
  ];
  for (const [label, steps, risk] of sets) {
    it(`is ${risk} for ${label}`, () => {
      const m = macro({ steps });
      expect(macroRisk(m)).toMatchObject({ ok: true, value: risk });
      expect(checkMacro(m)).toMatchObject({ ok: true, value: { risk } });
    });
  }

  it('is never declared: a macro has no risk field to carry one', () => {
    expect(Object.keys(macro())).not.toContain('risk');
    expect(macroRisk({ ...macro(), risk: 'read', steps: [confirm] } as unknown as ProjectMacro)).toMatchObject({ ok: false });
  });
});

describe('expandMacro', () => {
  it('fills the placeholders with whole values and returns the plan, with the step order and the expect texts', () => {
    const plan = expandMacro(macro(), { chapter: 'Chapter 1', status: 'final' });
    expect(plan).toEqual({
      ok: true,
      value: {
        steps: [
          { tool: 'meta.set', params: { targets: ['Chapter 1'], status: 'final' }, expect: 'The chapter is marked.' },
          { tool: 'notes.append', params: { doc: 'Chapter 1', text: 'Revised.' }, expect: 'A note is added.' },
        ],
      },
    });
  });

  it('fills a default the writer left out, and drops the key of an optional param with neither', () => {
    const plan = expandMacro(macro({ steps: [step('notes.append', { doc: { $param: 'chapter' }, text: 'x' }), step('meta.set', { targets: ['x'], status: { $param: 'status' }, label: { $param: 'note' } })] }), { chapter: 'Chapter 1' });
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(plan.value.steps[1]?.params).toEqual({ targets: ['x'], status: 'revised' });
  });

  it('refuses a missing required param, a value of the wrong kind, a choice outside the values and a key the macro does not declare', () => {
    expect(expandMacro(macro(), {})).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(expandMacro(macro(), { chapter: 5 })).toMatchObject({ ok: false });
    expect(expandMacro(macro(), { chapter: 'a', status: 'archived' })).toMatchObject({ ok: false });
    const extra = expandMacro(macro(), { chapter: 'a', ghost: 1 });
    expect(extra).toMatchObject({ ok: false });
    if (!extra.ok) expect(extra.error.message).toContain('"ghost"');
  });

  it('treats a run value named for an Object.prototype member as undeclared, and a declared param of that name as not given', () => {
    const extra = expandMacro(macro(), { chapter: 'a', toString: 'x' });
    expect(extra).toMatchObject({ ok: false });
    if (!extra.ok) expect(extra.error.message).toContain('"toString"');
    const declared = macro({
      params: { ...PARAMS, properties: { ...PARAMS.properties, toString: { kind: 'string' as const, description: 'A param named like a method.' } } },
      steps: [step('notes.append', { doc: { $param: 'chapter' }, text: { $param: 'toString' } })],
    });
    expect(expandMacro(declared, { chapter: 'a' })).toMatchObject({ ok: false });
    expect(expandMacro(declared, { chapter: 'a', toString: 'hello' })).toMatchObject({ ok: true, value: { steps: [{ params: { doc: 'a', text: 'hello' } }] } });
  });

  it('refuses a missing optional param in a list, where a key cannot simply be dropped', () => {
    const inList = macro({ steps: [step('meta.set', { targets: [{ $param: 'chapter' }, { $param: 'note' }] })] });
    expect(expandMacro(inList, { chapter: 'a' })).toMatchObject({ ok: false });
    expect(expandMacro(inList, { chapter: 'a', note: 'b' })).toMatchObject({ ok: true });
  });

  it('holds no reference to the values it was given', () => {
    const given = { chapter: 'Chapter 1' };
    const plan = expandMacro(macro(), given);
    given.chapter = 'changed';
    expect(plan).toMatchObject({ ok: true, value: { steps: [{ params: { targets: ['Chapter 1'] } }, expect.anything()] } });
  });

  it('re-runs checkMacro, so a hand-edited macro is refused at run time and nothing is expanded', () => {
    expect(expandMacro(macro({ steps: [step('mcp__evil__run', {})] }), { chapter: 'a' }).ok).toBe(false);
    expect(expandMacro(macro({ steps: [step('agent.plan', { steps: [] })] }), { chapter: 'a' }).ok).toBe(false);
    expect(expandMacro(macro({ steps: [step('tool.search', { query: 'x' })] }), { chapter: 'a' }).ok).toBe(false);
    expect(expandMacro(macro({ steps: [step('macro.other', {})] }), { chapter: 'a' }).ok).toBe(false);
    expect(expandMacro(macro({ steps: [step('notes.append', { doc: { $param: 'count' }, text: 'x' })] }), { chapter: 'a', count: 1 }).ok).toBe(false);
  });

  it('does not let a value build a tool name, a second operation, or a string with another value in it', () => {
    const hostile = expandMacro(macro(), { chapter: 'x", "tool": "agent.plan' });
    expect(hostile).toMatchObject({ ok: true });
    if (!hostile.ok) return;
    expect(hostile.value.steps.map((entry) => entry.tool)).toEqual(['meta.set', 'notes.append']);
    expect(hostile.value.steps[1]?.params['doc']).toBe('x", "tool": "agent.plan');
    expect(hostile.value.steps[1]?.params['text']).toBe('Revised.');
  });

  it('names a macro’s turn by its slug and its name', () => {
    expect(macroCommandName('revise-chapter')).toBe('macro-revise-chapter');
    expect(macroCommandName('x'.repeat(40))).toHaveLength(32);
    expect(macroIntent({ name: 'Revise chapter' })).toBe('Run the macro “Revise chapter”');
  });
});

describe('a macro run is a plan run', () => {
  const given = { chapter: 'The Landing', status: 'final' };
  const direct = { steps: [step('meta.set', { targets: ['The Landing'], status: 'final' }), step('notes.append', { doc: 'The Landing', text: 'Revised.' })].map((entry, index) => ({ ...entry, expect: index === 0 ? 'The chapter is marked.' : 'A note is added.' })) };

  it('gets the same preflight as the expanded plan submitted directly', () => {
    const plan = expandMacro(macro(), given);
    if (!plan.ok) throw new Error(plan.error.message);
    expect(plan.value).toEqual(direct);
    const viaMacro = makeHarness().previewPlan(plan.value);
    const viaPlan = makeHarness().previewPlan(direct);
    expect(viaMacro).toEqual(viaPlan);
    expect(viaMacro.ok && viaMacro.value.ok).toBe(true);
  });

  it('runs in one undo group with the same effect and the same entries as the expanded plan run directly', () => {
    const plan = expandMacro(macro(), given);
    if (!plan.ok) throw new Error(plan.error.message);
    const outcomes = [plan.value, direct].map((subject) => {
      const state = makeState();
      const harness = makeHarness({}, state);
      const turn = { turnId: 'turn-m', callId: callId('plan') };
      const result = harness.executePlan(subject, turn);
      if (!result.ok) throw new Error(result.error.message);
      harness.endTurn(turn.turnId);
      const outcome = result.value;
      expect(outcome.status).toBe('applied');
      const groupId = outcome.status === 'applied' ? outcome.undoGroupId : undefined;
      const group = groupId === undefined ? undefined : harness.undo.group(groupId);
      return { snapshot: JSON.stringify([state.manifest.tree, [...state.documents.entries()]]), entries: group?.entries.map((entry) => entry.name), log: harness.log.entries().map((row) => row.command) };
    });
    expect(outcomes[0]?.entries?.length).toBeGreaterThan(1);
    expect(outcomes[0]?.entries).toEqual(outcomes[1]?.entries);
    expect(outcomes[0]?.log).toEqual(outcomes[1]?.log);
    expect(outcomes[0]?.snapshot).toBe(outcomes[1]?.snapshot);
  });

  it('is held to the project’s deny rules: a step into a locked chapter is refused in the preflight, as any plan step is', () => {
    const rules: SourcedRule[] = [{ effect: 'deny', tool: '*', scope: { subtree: CHAPTER_ONE }, access: 'write', source: 'project', note: 'Locked' }];
    const set: RuleSet = { rules };
    const harness = makeHarness({ rules: () => set });
    const plan = expandMacro(macro(), given);
    if (!plan.ok) throw new Error(plan.error.message);
    const preflight = harness.previewPlan(plan.value);
    if (!preflight.ok) throw new Error(preflight.error.message);
    expect(preflight.value.ok).toBe(false);
    expect(preflight.value.steps.map((entry) => entry.status)).toEqual(['refused', 'refused']);
    expect(preflight.value.steps[0]?.error?.code).toBe('permission-denied');
    const open = expandMacro(macro(), { chapter: 'The Friend' });
    if (!open.ok) throw new Error(open.error.message);
    const allowed = harness.previewPlan(open.value);
    expect(allowed.ok && allowed.value.ok).toBe(true);
  });

  it('follows the plan’s one deferral: a step that names what an earlier step creates is deferred, and one that names nothing anyone makes is refused', () => {
    const creates = macro({
      steps: [
        step('doc.import', { parent: CHAPTER_ONE, title: { $param: 'chapter' }, body: 'Fog.' }),
        step('meta.set', { targets: [{ $param: 'chapter' }], status: 'draft' }),
      ],
    });
    const plan = expandMacro(creates, { chapter: 'Lantern' });
    if (!plan.ok) throw new Error(plan.error.message);
    const preflight = makeHarness().previewPlan(plan.value);
    if (!preflight.ok) throw new Error(preflight.error.message);
    expect(preflight.value.steps.map((entry) => entry.status)).toEqual(['ready', 'deferred']);
    expect(preflight.value.ok).toBe(true);
    const alone = expandMacro(macro({ steps: [step('meta.set', { targets: [{ $param: 'chapter' }], status: 'draft' })] }), { chapter: 'Lantern' });
    if (!alone.ok) throw new Error(alone.error.message);
    const refused = makeHarness().previewPlan(alone.value);
    expect(refused.ok && refused.value.steps[0]?.status).toBe('refused');
  });

  it('refuses at preflight a step that names a node that is not there, and writes nothing', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const harness = makeHarness({}, state);
    const plan = expandMacro(macro(), { chapter: 'A chapter nobody wrote' });
    if (!plan.ok) throw new Error(plan.error.message);
    const preflight = harness.previewPlan(plan.value);
    expect(preflight.ok && preflight.value.ok).toBe(false);
    expect(snapshotOf(state)).toBe(before);
  });
});
