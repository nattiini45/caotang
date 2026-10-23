/**
 * The bus primitives exposed as deferred tools (agent-harness §3, "Primitives as deferred tools"): that each row takes its class
 * from its command, that the types and the runtime keep the never-exposed commands out, that every call goes through the ordinary
 * gate and the bus's validate, and what each of the five does.
 */

import {
  COMMAND_NAMES,
  COMMAND_REGISTRY,
  CRITERIA_KEYS,
  DECLARED_PARAMS,
  HARD_DENIED,
  VIEW_COMMAND_NAMES,
  hardDenyClass,
  type CommandName,
} from '@caotang/bus';
import { describe, expect, it } from 'vitest';

import { createAgentPorts, plannerToolDefs, TOOL_METADATA, type ToolMetadata } from '../src/index.js';
import { NEVER_EXPOSED, primitiveTool, type ExposablePrimitive, type NeverExposed, type PrimitiveToolSpec } from '../src/tools/primitive.js';
import { PRIMITIVE_TOOLS } from '../src/tools/primitive-tools.js';
import { CHAPTER_ONE, LANDING, STORM, makeHarness, makeState, refusalOf, run, snapshotOf, valueOf } from './fixtures.js';

const FIRST_WAVE = ['notes.replace', 'synopsis.set', 'vocabulary.upsert', 'filter.save', 'goal.save'];

const rowFor = (name: string): ToolMetadata => {
  const row = TOOL_METADATA.find((meta) => meta.name === name);
  if (row === undefined) throw new Error(`no row ${name}`);
  return row;
};

function nodeOf(state: ReturnType<typeof makeState>, id: string) {
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

describe('the allowlist', () => {
  it('is exactly the five tools the owner approved, each a deferred extension row outside the always-loaded set', () => {
    expect(PRIMITIVE_TOOLS.map((tool) => tool.meta.name)).toEqual(FIRST_WAVE);
    for (const name of FIRST_WAVE) {
      expect(rowFor(name)).toMatchObject({ surface: 'extension', load: 'deferred' });
      expect(rowFor(name).keywords?.length).toBeGreaterThan(0);
    }
    const tools = makeHarness({ ports: createAgentPorts() }).tools();
    const core = plannerToolDefs(tools, [], []).map((def) => def.name);
    for (const name of FIRST_WAVE) expect(core).not.toContain(name);
  });

  it('takes each tool’s risk and undo from its command’s descriptor, and its text carries the class sentence for that risk', () => {
    for (const tool of PRIMITIVE_TOOLS) {
      const descriptor = COMMAND_REGISTRY[tool.command].descriptor;
      expect(tool.meta.risk, tool.meta.name).toBe(descriptor.agentRisk);
      expect(tool.meta.undoable, tool.meta.name).toBe(descriptor.undo !== 'none');
      expect(tool.meta.description.endsWith(tool.meta.risk === 'write-confirm' ? 'Requires user confirmation.' : 'Applies automatically within an approved turn.')).toBe(true);
    }
    expect(PRIMITIVE_TOOLS.map((tool) => [tool.meta.name, tool.meta.risk])).toEqual([
      ['notes.replace', 'write-confirm'],
      ['synopsis.set', 'write-auto'],
      ['vocabulary.upsert', 'write-confirm'],
      ['filter.save', 'write-auto'],
      ['goal.save', 'write-auto'],
    ]);
  });

});

/** A spec that stands for `command`, for the compile-time and runtime refusals below. */
function specFor<C extends ExposablePrimitive>(command: C): PrimitiveToolSpec<C> {
  return {
    tool: 'notes.replace',
    command,
    description: 'x',
    descriptionVersion: 1,
    keywords: [],
    response_token_cap: 1,
    params: { kind: 'object', description: 'x', properties: {}, required: [] },
    toCommand: () => ({ ok: true, value: {} }),
    report: () => ({ data: {}, summary: '' }),
  };
}

describe('a spec has no risk of its own', () => {
  it('does not compile with one, so a tool cannot state a class that differs from its command’s', () => {
    // @ts-expect-error the risk is the descriptor's; a spec has no field to state one in
    const stated = () => primitiveTool({ ...specFor('notes.set'), risk: 'write-auto' });
    expect(stated().meta.risk).toBe('write-confirm');
  });
});

describe('never-exposed commands', () => {
  it('cannot be named by a spec: each is a compile error, and each is refused at runtime too', () => {
    const attempts: (() => unknown)[] = [
      // @ts-expect-error a delete is never a tool
      () => primitiveTool(specFor('project.deleteNode')),
      // @ts-expect-error a delete is never a tool
      () => primitiveTool(specFor('binder.deleteFilter')),
      // @ts-expect-error a delete is never a tool
      () => primitiveTool(specFor('project.deleteGoal')),
      // @ts-expect-error a delete is never a tool
      () => primitiveTool(specFor('recipe.delete')),
      // @ts-expect-error a delete is never a tool
      () => primitiveTool(specFor('vocabulary.remove')),
      // @ts-expect-error a delete is never a tool
      () => primitiveTool(specFor('coherence.discardRun')),
      // @ts-expect-error a delete is never a tool
      () => primitiveTool(specFor('coherence.removeKnowledgeFact')),
      // @ts-expect-error a document body is written by the editor and drafting tools
      () => primitiveTool(specFor('doc.write')),
      // @ts-expect-error a document body is written by the editor and drafting tools
      () => primitiveTool(specFor('editor.insert')),
      // @ts-expect-error a document body is written by the editor and drafting tools
      () => primitiveTool(specFor('editor.replaceRange')),
      // @ts-expect-error the view commands are the app's, not the project's
      () => primitiveTool(specFor('view.setSelection')),
      // @ts-expect-error the view commands are the app's, not the project's
      () => primitiveTool(specFor('view.setActiveDoc')),
      // @ts-expect-error the view commands are the app's, not the project's
      () => primitiveTool(specFor('view.setScroll')),
      // @ts-expect-error the view commands are the app's, not the project's
      () => primitiveTool(specFor('view.setExpanded')),
      // @ts-expect-error the view commands are the app's, not the project's
      () => primitiveTool(specFor('view.setCorkboardScope')),
      // @ts-expect-error a staging command takes a file the writer chose
      () => primitiveTool(specFor('project.importAsset')),
      // @ts-expect-error a staging command takes a file the writer chose
      () => primitiveTool(specFor('shot.importImage')),
      // @ts-expect-error a staging command takes files the writer chose
      () => primitiveTool(specFor('shot.importImages')),
      // @ts-expect-error an external call rides its own gateway
      () => primitiveTool(specFor('mcp.invoke')),
      // @ts-expect-error a resource is read when the writer picks it, never on a tool's behalf
      () => primitiveTool(specFor('mcp.readResource')),
      // @ts-expect-error a skill is an instruction the agent will read, so the agent never writes one
      () => primitiveTool(specFor('skill.import')),
      // @ts-expect-error a skill is an instruction the agent will read, so the agent never writes one
      () => primitiveTool(specFor('skill.write')),
      // @ts-expect-error a skill is an instruction the agent will read, so the agent never writes one
      () => primitiveTool(specFor('skill.delete')),
      // @ts-expect-error a skill is an instruction the agent will read, so the agent never writes one
      () => primitiveTool(specFor('skill.setEnabled')),
    ];
    expect(attempts.length).toBe(NEVER_EXPOSED.length);
    for (const attempt of attempts) expect(attempt).toThrow();
  });

  it('covers every never-class command, every hard-denied name, every view command and every delete or staging command', () => {
    const listed = new Set<string>(NEVER_EXPOSED);
    const never = COMMAND_NAMES.filter((name) => COMMAND_REGISTRY[name].descriptor.agentRisk === 'never');
    expect(never.length).toBeGreaterThan(0);
    for (const name of never) expect(listed.has(name), name).toBe(true);
    for (const name of Object.keys(HARD_DENIED)) expect(listed.has(name), name).toBe(true);
    for (const name of VIEW_COMMAND_NAMES) expect(listed.has(name), name).toBe(true);
    for (const name of COMMAND_NAMES) {
      if (/(?:^|\.)(?:delete|discard|remove)/i.test(name) || DECLARED_PARAMS[name].includes('stagingId')) {
        expect(listed.has(name), name).toBe(true);
      }
    }
  });

  it('is excluded from ExposablePrimitive, and every first-wave command is in it', () => {
    type Overlap = Extract<ExposablePrimitive, NeverExposed>;
    const none: [Overlap] extends [never] ? true : false = true;
    expect(none).toBe(true);
    for (const tool of PRIMITIVE_TOOLS) expect((NEVER_EXPOSED as readonly string[]).includes(tool.command)).toBe(false);
  });

  it('holds for every entry at runtime: not hard-denied, not never-class', () => {
    for (const tool of PRIMITIVE_TOOLS) {
      const command: CommandName = tool.command;
      expect(hardDenyClass(command), tool.meta.name).toBeUndefined();
      expect(COMMAND_REGISTRY[command].descriptor.agentRisk, tool.meta.name).not.toBe('never');
    }
  });
});

describe('the params of each tool', () => {
  const SAMPLES: Readonly<Record<string, Record<string, unknown>>> = {
    'notes.replace': { doc: 'The Landing', notes: 'New notes.' },
    'synopsis.set': { doc: 'The Landing', synopsis: 'A synopsis.' },
    'vocabulary.upsert': { kind: 'status', name: 'In Review', color: '#3fa66a' },
    'filter.save': { name: 'Short', root: 'manuscript', criteria: { text: 'ferry' }, id: 'q_0123456789' },
    'goal.save': { node: 'Chapter 1', comparator: 'at-least', target: 1000, id: 'g_0123456789' },
  };

  it('map onto keys the command declares, never beyond DECLARED_PARAMS', () => {
    const harness = makeHarness();
    void harness;
    const state = makeState();
    for (const tool of PRIMITIVE_TOOLS) {
      const mapped = tool.prepare(SAMPLES[tool.meta.name] ?? {}, { state, registry: COMMAND_REGISTRY });
      expect(mapped.ok, tool.meta.name).toBe(true);
      if (!mapped.ok) continue;
      const first = mapped.value.commands[0];
      expect(first?.name).toBe(tool.command);
      const keys = Object.keys(typeof first?.params === 'function' ? {} : (first?.params ?? {}));
      for (const key of keys) expect(DECLARED_PARAMS[tool.command], `${tool.meta.name}: ${key}`).toContain(key);
    }
  });

  it('refuse a key the tool does not declare as invalid-params, naming the accepted set', () => {
    for (const tool of PRIMITIVE_TOOLS) {
      const error = refusalOf(run(makeHarness(), tool.meta.name, { ...SAMPLES[tool.meta.name], nodeId: STORM }, { permission: { confirmed: true } }));
      expect(error.code, tool.meta.name).toBe('invalid-params');
      expect(error.message).toContain('nodeId');
      for (const key of Object.keys(tool.params.properties)) expect(`${error.message} ${error.correctiveHint ?? ''}`, tool.meta.name).toContain(key);
    }
  });

  it('declare the filter criteria the bus knows, and no others', () => {
    const filter = PRIMITIVE_TOOLS.find((tool) => tool.meta.name === 'filter.save');
    const criteria = filter?.params.properties['criteria'];
    expect(criteria?.kind).toBe('object');
    if (criteria?.kind !== 'object') return;
    expect(Object.keys(criteria.properties).sort()).toEqual([...CRITERIA_KEYS].sort());
  });
});

describe('every call goes through the ordinary gate', () => {
  it('refuses a write-confirm tool as a bare call, and a write-auto tool needs nothing', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const harness = makeHarness({}, state);
    for (const [name, params] of [
      ['notes.replace', { doc: LANDING, notes: 'x' }],
      ['vocabulary.upsert', { kind: 'status', name: 'In Review', color: '#3fa66a' }],
    ] as const) {
      const error = refusalOf(run(harness, name, params));
      expect(error.code, name).toBe('permission-denied');
      expect(error.risk).toBe('write-confirm');
    }
    expect(snapshotOf(state)).toBe(before);
    expect(valueOf(run(harness, 'synopsis.set', { doc: LANDING, synopsis: 'A line.' })).summary).toContain('set the synopsis');
  });

  it('refuses the write-auto tools from an external caller that has not opened writes, as it refuses meta.set', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const harness = makeHarness({}, state);
    const error = refusalOf(run(harness, 'synopsis.set', { doc: LANDING, synopsis: 'x' }, { source: 'mcp' }));
    expect(error.code).toBe('permission-denied');
    expect(snapshotOf(state)).toBe(before);
  });

  it('shows the bus’s own refusal when the command’s validate says no, and writes nothing', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(run(makeHarness({}, state), 'filter.save', { name: 'Bad', criteria: { statusId: 'nope' } }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('"nope" is not a status in this project');
    expect(snapshotOf(state)).toBe(before);
  });
});

describe('notes.replace', () => {
  it('replaces the notes behind a confirmation, previews old and new, and undoes to the exact bytes', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const old = nodeOf(state, LANDING).notes;

    const preview = harness.previewPlan({ steps: [{ tool: 'notes.replace', params: { doc: 'The Landing', notes: 'Rewritten.\n\nSecond paragraph.' }, expect: 'the notes are rewritten' }] });
    if (!preview.ok) throw new Error('expected a preflight');
    expect(preview.value.steps[0]?.preview).toEqual({ doc: 'The Landing', before: old, after: 'Rewritten.\n\nSecond paragraph.' });
    expect(snapshotOf(state)).toBe(before);

    const done = valueOf(run(harness, 'notes.replace', { doc: LANDING, notes: 'Rewritten.\n\nSecond paragraph.' }, { permission: { confirmed: true } }));
    expect(nodeOf(state, LANDING).notes).toBe('Rewritten.\n\nSecond paragraph.');
    expect(done.summary).toContain('"The Landing"');
    expect(done.affected.map((row) => row.nodeId)).toEqual([LANDING]);
    expect(harness.undo.undo(done.undoGroupId ?? '').ok).toBe(true);
    expect(nodeOf(state, LANDING).notes).toBe(old);
    expect(snapshotOf(state)).toBe(before);
  });

  it('clears the notes with an empty string, and refuses a folder and notes over the limit', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    valueOf(run(harness, 'notes.replace', { doc: LANDING, notes: '' }, { permission: { confirmed: true } }));
    expect(nodeOf(state, LANDING).notes).toBe('');
    expect(refusalOf(run(harness, 'notes.replace', { doc: CHAPTER_ONE, notes: 'x' }, { permission: { confirmed: true } })).message).toContain('is a folder, not a document');
    expect(refusalOf(run(harness, 'notes.replace', { doc: LANDING, notes: 'x'.repeat(50_001) }, { permission: { confirmed: true } })).code).toBe('limit-exceeded');
  });

  it('is the tool the notes.append overflow refusal names', () => {
    const error = refusalOf(run(makeHarness(), 'notes.append', { doc: LANDING, text: 'x'.repeat(2001) }));
    expect(error.correctiveHint).toContain('notes.replace');
    expect(error.correctiveHint).toContain('tool.search');
    expect(error.correctiveHint).not.toContain('v0.2');
  });
});

describe('synopsis.set', () => {
  it('sets the synopsis of a document or a folder and undoes to the exact bytes', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const done = valueOf(run(harness, 'synopsis.set', { doc: 'Chapter 1', synopsis: 'Elena arrives.' }));
    expect(nodeOf(state, CHAPTER_ONE).synopsis).toBe('Elena arrives.');
    harness.undo.undo(done.undoGroupId ?? '');
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a synopsis over the bus’s limit', () => {
    expect(refusalOf(run(makeHarness(), 'synopsis.set', { doc: LANDING, synopsis: 'x'.repeat(2001) })).code).toBe('limit-exceeded');
  });
});

describe('vocabulary.upsert', () => {
  it('adds a status behind a confirmation, returns its id, and undoes', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const done = valueOf(run(harness, 'vocabulary.upsert', { kind: 'status', name: 'In Review', color: '#3FA66A' }, { permission: { confirmed: true } }));
    expect(done.data).toMatchObject({ kind: 'status', id: 'in-review', added: true });
    expect(state.manifest.vocabulary.statuses.map((term) => term.id)).toContain('in-review');
    harness.undo.undo(done.undoGroupId ?? '');
    expect(snapshotOf(state)).toBe(before);
  });

  it('renames a term by its id, and refuses a duplicate name', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    valueOf(run(harness, 'vocabulary.upsert', { kind: 'label', id: 'act-1', name: 'First act', color: '#8a8a8a' }, { permission: { confirmed: true } }));
    expect(state.manifest.vocabulary.labels.find((term) => term.id === 'act-1')?.name).toBe('First act');
    expect(refusalOf(run(harness, 'vocabulary.upsert', { kind: 'label', name: 'act 2', color: '#8a8a8a' }, { permission: { confirmed: true } })).message).toContain('already exists');
  });

  it('is usable by meta.set in the same approved plan, and the later step waits in the preview', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const plan = {
      steps: [
        { tool: 'vocabulary.upsert', params: { kind: 'status', name: 'In Review', color: '#3fa66a' }, expect: 'the status In Review exists' },
        { tool: 'meta.set', params: { targets: [LANDING], status: 'in-review' }, expect: 'The Landing is In Review' },
      ],
    };
    const preview = harness.previewPlan(plan);
    if (!preview.ok) throw new Error('expected a preflight');
    expect(preview.value.ok).toBe(true);
    expect(preview.value.steps.map((step) => step.status)).toEqual(['ready', 'deferred']);

    const outcome = harness.executePlan(plan, { turnId: 'turn-vocab', callId: 'plan-vocab' });
    expect(outcome.ok && outcome.value.status).toBe('applied');
    expect(nodeOf(state, LANDING).status).toBe('in-review');
  });

  it('does not defer a status no earlier step adds', () => {
    const preview = makeHarness().previewPlan({
      steps: [{ tool: 'meta.set', params: { targets: [LANDING], status: 'in-review' }, expect: 'x' }],
    });
    if (!preview.ok) throw new Error('expected a preflight');
    expect(preview.value.steps[0]?.status).toBe('refused');
  });

  it('fails the plan at the later step when the earlier step named another term', () => {
    const state = makeState();
    const outcome = makeHarness({}, state).executePlan(
      {
        steps: [
          { tool: 'vocabulary.upsert', params: { kind: 'status', name: 'In Review', color: '#3fa66a' }, expect: 'added' },
          { tool: 'meta.set', params: { targets: [LANDING], status: 'in-revision' }, expect: 'set' },
        ],
      },
      { turnId: 'turn-vocab-2', callId: 'plan-vocab-2' },
    );
    expect(outcome.ok && outcome.value.status).toBe('failed');
  });
});

describe('filter.save', () => {
  it('saves a filter, lists it in the overview, changes it by id, and undoes', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const first = valueOf(run(harness, 'filter.save', { name: 'Drafts', root: 'manuscript', criteria: { statusId: 'draft', minWords: 1 } }));
    const id = String(first.data['id']);
    expect(id).toMatch(/^q_/);
    expect(state.manifest.filters?.[0]).toMatchObject({ id, name: 'Drafts', root: 'manuscript', criteria: { statusId: 'draft', minWords: 1 } });
    const overview = valueOf(run(harness, 'project.overview', {}));
    expect(overview.data['filters']).toEqual([{ id, name: 'Drafts' }]);

    const second = valueOf(run(harness, 'filter.save', { id, name: 'Drafts again', criteria: {} }));
    expect(state.manifest.filters?.length).toBe(1);
    expect(state.manifest.filters?.[0]?.name).toBe('Drafts again');
    harness.undo.undo(second.undoGroupId ?? '');
    harness.undo.undo(first.undoGroupId ?? '');
    // The furniture inverse leaves the emptied list in the manifest, as the store's own undo does.
    expect(state.manifest.filters).toEqual([]);
    delete state.manifest.filters;
    expect(snapshotOf(state)).toBe(before);
  });
});

describe('goal.save', () => {
  it('sets a goal on a folder by title, changes it by id, and undoes', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const first = valueOf(run(harness, 'goal.save', { node: 'Chapter 1', comparator: 'at-least', target: 1000, deadline: '2026-12-31' }));
    const id = String(first.data['id']);
    expect(state.manifest.goals?.[0]).toMatchObject({ id, nodeId: CHAPTER_ONE, comparator: 'at-least', target: 1000, deadline: '2026-12-31' });
    const changed = valueOf(run(harness, 'goal.save', { id, node: 'Chapter 1', comparator: 'about', target: 1200 }));
    expect(state.manifest.goals?.length).toBe(1);
    expect(state.manifest.goals?.[0]).toMatchObject({ comparator: 'about', target: 1200 });
    harness.undo.undo(changed.undoGroupId ?? '');
    harness.undo.undo(first.undoGroupId ?? '');
    expect(state.manifest.goals).toEqual([]);
    delete state.manifest.goals;
    expect(snapshotOf(state)).toBe(before);
  });

  it('sets a weekly goal on the manuscript, and refuses a document as the node and a weekly goal off the manuscript', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    valueOf(run(harness, 'goal.save', { node: 'manuscript', kind: 'weekly', resetDay: 1, comparator: 'at-least', target: 3000 }));
    expect(state.manifest.goals?.[0]).toMatchObject({ kind: 'weekly', resetDay: 1 });
    expect(refusalOf(run(harness, 'goal.save', { node: LANDING, comparator: 'at-least', target: 10 })).message).toContain('is a document, not a folder or the manuscript');
    expect(refusalOf(run(harness, 'goal.save', { node: 'Chapter 1', kind: 'weekly', comparator: 'at-least', target: 10 })).message).toContain('attaches to the manuscript root');
  });
});
