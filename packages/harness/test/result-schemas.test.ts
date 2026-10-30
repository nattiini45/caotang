/**
 * Every callable row declares what its result holds (agent-harness §3, "Result schemas"), the declaration is derived the way the
 * params schema is, and the tests hold every tool to it: a value that does not match fails with the JSON path, and production
 * never runs that check.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ok, toResultSchema } from '@caotang/bus';
import * as mcpClient from '@caotang/mcp-client';

import { createAgentPorts, createHarness, TOOL_NAMES, type ToolPort } from '../src/index.js';
import { framedResult, type SubagentResult } from '../src/agent/subagent.js';
import { RESULT_CLOSED, RESULT_SPECS } from '../src/results.js';
import { assertResult, resultFailures, withResultChecks } from '../src/testing.js';
import { LANDING, clock, makeHarness, makeState, run, valueOf } from './fixtures.js';

vi.mock('@caotang/mcp-client', async (importOriginal) => {
  const original = await importOriginal<typeof mcpClient>();
  return { ...original, validateArguments: vi.fn(original.validateArguments) };
});

const CALLABLE = TOOL_NAMES.filter((name) => name !== 'agent.plan');

describe('the registry declares a result for every callable row', () => {
  const listing = makeHarness().tools();

  it('gives each callable row a result spec and the schema derived from it, and the plan protocol none', () => {
    expect(Object.keys(RESULT_SPECS).sort()).toEqual([...CALLABLE].sort());
    for (const tool of listing.filter((item) => item.callable)) {
      const spec = RESULT_SPECS[tool.name as keyof typeof RESULT_SPECS];
      expect(tool.resultSchema, tool.name).toEqual(toResultSchema(spec, RESULT_CLOSED.has(tool.name as keyof typeof RESULT_SPECS)));
    }
    expect(listing.find((item) => item.name === 'agent.plan')?.resultSchema).toBeUndefined();
  });

  it('closes the thirteen callable v0.1 rows and tool.search, and leaves the rest open', () => {
    const v01 = listing.filter((item) => item.surface === 'v0.1' && item.callable).map((item) => item.name);
    expect(v01).toHaveLength(13);
    expect([...RESULT_CLOSED].sort()).toEqual([...v01, 'tool.search'].sort());
    for (const tool of listing.filter((item) => item.callable)) {
      expect((tool.resultSchema as { additionalProperties: boolean }).additionalProperties, tool.name).toBe(!RESULT_CLOSED.has(tool.name as keyof typeof RESULT_SPECS));
    }
  });

  it('lists the open rows, which is the checklist this change carries', () => {
    const open = CALLABLE.filter((name) => !RESULT_CLOSED.has(name)).sort();
    expect(open).toEqual([
      'agent.delegate',
      'codex.import',
      'coherence.review',
      'coherence.scan',
      'coherence.setFindingStatus',
      'dialogue.apply',
      'dialogue.brief',
      'dialogue.draft',
      'dialogue.table',
      'doc.import',
      'filter.save',
      'goal.save',
      'instructions.propose',
      'memory.read',
      'memory.write',
      'notes.replace',
      'prompt.draft',
      'prompt.variant',
      'scene.apply',
      'scene.brief',
      'shots.annotate',
      'shots.derive',
      'skill.load',
      'synopsis.set',
      'vocabulary.upsert',
    ]);
  });

  it('declares an open row so that a key it does not list is allowed at every level', () => {
    const open = listing.find((item) => item.name === 'coherence.scan')?.resultSchema as { additionalProperties: boolean; properties: { groups: { items: { additionalProperties: boolean } } } };
    expect(open.additionalProperties).toBe(true);
    expect(open.properties.groups.items.additionalProperties).toBe(true);
  });
});

describe('a result that drifts from its declaration fails with the JSON path', () => {
  const tools = makeHarness().tools();

  it('names the path of a declared field a tool no longer returns', () => {
    const harness = makeHarness();
    const { data } = valueOf(run(harness, 'project.overview', {}));
    const { session: _session, ...without } = data;
    expect(resultFailures(tools, 'project.overview', data)).toEqual([]);
    expect(resultFailures(tools, 'project.overview', without)).toEqual(['/session is required']);
    expect(() => assertResult(tools, 'project.overview', without)).toThrow(/project\.overview returned a result that does not match its declared schema[\s\S]*\/session is required/);
  });

  it('names the path of a nested field, and of a field of the wrong type', () => {
    const { data } = valueOf(run(makeHarness(), 'binder.read_tree', {}));
    const nodes = (data as { nodes: Record<string, unknown>[] }).nodes;
    const broken = { ...data, nodes: nodes.map((node, index) => (index === 0 ? { ...node, title: 7, parentId: undefined } : node)) };
    expect(resultFailures(tools, 'binder.read_tree', broken)).toEqual(['/nodes/0/parentId is required', '/nodes/0/title must be string']);
  });

  it('refuses a key a closed row does not list, and allows it in an open row', () => {
    const { data } = valueOf(run(makeHarness(), 'notes.append', { doc: LANDING, text: 'More.' }));
    expect(resultFailures(tools, 'notes.append', { ...data, extra: 1 })).toEqual(['/extra is not allowed']);
    expect(resultFailures(tools, 'filter.save', { id: null, name: 'x', extra: 1 })).toEqual([]);
  });

  it('fails the call itself when a wired tool returns the wrong shape', () => {
    const broken: ToolPort = () => ok({ data: { entries: [] }, summary: 'read the codex', affected: [] });
    const harness = makeHarness({ ports: { 'codex.read': broken } });
    expect(() => run(harness, 'codex.read', {})).toThrow(/codex\.read returned a result[\s\S]*\/total is required[\s\S]*\/truncated is required/);
  });

  it('checks the steps of a plan, and the answers of an external caller', () => {
    const broken: ToolPort = () => ok({ data: { entries: [] }, summary: 'read the codex', affected: [] });
    const harness = makeHarness({ ports: { 'codex.read': broken } });
    expect(() => harness.executePlan({ steps: [{ tool: 'codex.read', params: {}, expect: 'the codex is read' }] }, { turnId: 'plan-turn', callId: 'plan-1' })).toThrow(/codex\.read returned a result/);
    expect(() => harness.external.call({ name: 'codex.read', callId: 'ext-1', params: {} }, { turnId: 'ext-turn' })).toThrow(/codex\.read returned a result/);
  });

  it('holds a delegated agent’s answer to its row, which the loop builds without a call', () => {
    const result: SubagentResult = {
      agent: 'reader',
      agentPath: 'session.turn-1/reader#1',
      status: 'done',
      summary: 'Read one document.',
      proposedSteps: [{ tool: 'meta.set', params: { targets: [LANDING], status: 'draft' }, expect: 'the status is set' }],
      read: [LANDING],
      usage: { modelCalls: 2, promptTokens: 400, completionTokens: 60 },
      dropped: [],
    };
    expect(resultFailures(tools, 'agent.delegate', framedResult(result))).toEqual([]);
    expect(resultFailures(tools, 'agent.delegate', { ...framedResult(result), status: 'lost' })).toEqual(['/status must be one of "done", "partial", "failed"']);
  });
});

describe('the declared schemas hold a call to the plain wire', () => {
  it('reads an undefined value as an absent key, as JSON does, and a null only where the spec allows it', () => {
    const tools = makeHarness().tools();
    const data = { id: undefined, name: 'x' };
    expect(resultFailures(tools, 'filter.save', data)).toEqual(['/id is required']);
    expect(resultFailures(tools, 'filter.save', { id: null, name: 'x' })).toEqual([]);
    expect(resultFailures(tools, 'filter.save', { id: 3, name: 'x' })).toEqual(['/id must be string or null']);
    expect(resultFailures(tools, 'filter.save', { id: null, name: null })).toEqual(['/name must be string']);
  });
});

describe('production does not re-validate native results', () => {
  const validate = vi.mocked(mcpClient.validateArguments);
  beforeEach(() => validate.mockClear());

  it('runs calls, plans and an external caller’s calls with the validator never invoked', () => {
    const state = makeState();
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    expect(harness.call({ name: 'project.overview', callId: 'p-1', params: {} }, { turnId: 't' }).ok).toBe(true);
    expect(harness.call({ name: 'doc.read', callId: 'p-2', params: { doc: LANDING } }, { turnId: 't' }).ok).toBe(true);
    expect(harness.call({ name: 'notes.append', callId: 'p-3', params: { doc: LANDING, text: 'A line.' } }, { turnId: 't' }).ok).toBe(true);
    const plan = harness.executePlan({ steps: [{ tool: 'binder.read_tree', params: {}, expect: 'the tree is read' }] }, { turnId: 't2', callId: 'plan-p' });
    expect(plan.ok && plan.value.status).toBe('applied');
    expect(harness.external.call({ name: 'project.overview', callId: 'p-4', params: {} }, { turnId: 'x' }).ok).toBe(true);
    expect(validate).not.toHaveBeenCalled();
  });

  it('keeps the checker out of every source file the app runs: only testing.ts and the eval runner import it', () => {
    const root = resolve(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    const importers = files
      .filter((file) => /from '(?:\.\.?\/)+testing\.js'/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(root.length + 1).replace(/\\/g, '/'));
    expect(importers).toEqual(['agent/eval.ts']);
    const callers = files
      .filter((file) => readFileSync(file, 'utf8').includes('validateArguments('))
      .map((file) => file.slice(root.length + 1).replace(/\\/g, '/'));
    expect(callers).toEqual(['testing.ts']);
  });
});

describe('withResultChecks', () => {
  it('hands back the same state, log and registry, so a test reads the project through it as through the harness', () => {
    const inner = createHarness({ state: makeState(), clock: clock.now });
    const checked = withResultChecks(inner);
    expect(checked.state).toBe(inner.state);
    expect(checked.log).toBe(inner.log);
    expect(checked.tools()).toBe(inner.tools());
  });
});
