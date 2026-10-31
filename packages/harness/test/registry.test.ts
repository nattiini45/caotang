/**
 * The registry as a whole: every tool joined to its metadata row, every schema
 * derived and closed, and the three refusals a caller can get without touching a
 * tool (an unknown name, a direct call to the plan protocol, and a call with no
 * turn or callId).
 */

import { describe, expect, it } from 'vitest';

import { TOOL_METADATA, TOOL_NAMES, createHarness } from '../src/index.js';
import { makeHarness, makeState } from './fixtures.js';

describe('the registry joins every tool to its metadata', () => {
  const harness = makeHarness();
  const listing = harness.tools();

  it('returns the same listing for repeated reads, so a plan with many steps does not rebuild it per step', () => {
    expect(harness.tools()).toBe(listing);
    expect(harness.tools()[0]).toBe(listing[0]);
  });

  // Beyond the fourteen and doc.import: codex.import (the import verb beside doc.import,
  // codex.md §2 provenance) and the coherence module's three tools (coherence.md §7), each its own row;
  // tool.search (the Tier-2 gateway, extensibility §5), and the storyboard
  // module's two and the prompt-pack module's two tools (storyboard.md §4, video-prompt-pack.md §6); and
  // the dialogue module's two (dialogue-narrative.md §7), which register because the module imports the bus and
  // not the harness. The spec's media-track count is twenty-three (14 + coherence 3 + storyboard 2 + prompt-pack 2 +
  // dialogue 2, agent-harness.md §10). The registry also carries doc.import, codex.import and tool.search, which that
  // count leaves out, the seven allowlisted bus primitives (issue #56, and issue #71's `memory.write` and `instructions.propose`), the skills row (`skill.load`, extensibility §10), the memory read (`memory.read`, context-assembly §2 LI) and the delegation row (`agent.delegate`, agent-harness §2), and the four external-only rows of the host-model pairs (`scene.brief`, `scene.apply`, `dialogue.brief`, `dialogue.apply`, agent-harness §3), so it holds forty.
  it('lists all forty rows, in the metadata table’s order', () => {
    expect(listing.map((item) => item.name)).toEqual([...TOOL_NAMES]);
    expect(listing).toHaveLength(40);
  });

  // Two of the coherence tools are wired to the engine by default (coherence.scan and
  // coherence.setFindingStatus). coherence.review stays unwired: its model call is async and a port is
  // synchronous, so the review is refused as not wired until an app supplies a provider-backed port.
  // tool.search (a read, wired with no server connected) and shots.annotate (wired, because the
  // store registry carries the shot commands) are wired too. The three model-backed or proposal-backed tools stay unwired by
  // default, as coherence.review does: shots.derive needs a proposal the loop stages, and prompt.draft and
  // prompt.variant need a model. dialogue.draft is the same kind (it writes the loop's staged Ink), and dialogue.table
  // is a read that is wired by default.
  it('makes agent.plan the one name that is not callable, and the model-backed port tools, `skill.load` (wired only where an app supplies its skills) and `agent.delegate` (wired by the agent ports), the ones not wired', () => {
    expect(listing.filter((item) => !item.callable).map((item) => item.name)).toEqual(['agent.plan']);
    expect(listing.filter((item) => !item.wired).map((item) => item.name).sort()).toEqual(
      [
        'agent.delegate',
        'agent.plan',
        'codex.read',
        'continuity.scan',
        'coherence.review',
        'dialogue.apply',
        'dialogue.brief',
        'dialogue.draft',
        'prompt.draft',
        'prompt.variant',
        'scene.apply',
        'scene.brief',
        'scene.draft',
        'shots.derive',
        'skill.load',
        'synopsis.fill',
      ].sort(),
    );
  });

  // Deferral is about context: the planner declares the core rows on every request and a deferred row once a search or a preload
  // loads it (agent-harness §3). Each module declares its own rows' class, so this pins the registry's sum of them.
  it('gives every row a load class: the 13 callable v0.1 rows, agent.plan and tool.search are core, and every other extension row is deferred', () => {
    for (const meta of TOOL_METADATA) expect(['core', 'deferred'], meta.name).toContain(meta.load);
    expect(TOOL_METADATA.filter((meta) => meta.load === 'core').map((meta) => meta.name)).toEqual([
      'project.overview',
      'binder.read_tree',
      'doc.read',
      'notes.read',
      'meta.set',
      'notes.append',
      'synopsis.fill',
      'scene.draft',
      'binder.restructure',
      'continuity.scan',
      'export.compile',
      'codex.read',
      'codex.write',
      'agent.plan',
      'tool.search',
    ]);
    expect(TOOL_METADATA.filter((meta) => meta.load === 'deferred').map((meta) => meta.name)).toEqual([
      'doc.import',
      'codex.import',
      'coherence.scan',
      'coherence.review',
      'coherence.setFindingStatus',
      'shots.derive',
      'shots.annotate',
      'prompt.draft',
      'prompt.variant',
      'dialogue.draft',
      'dialogue.table',
      'skill.load',
      'memory.read',
      'agent.delegate',
      'scene.brief',
      'scene.apply',
      'dialogue.brief',
      'dialogue.apply',
      'notes.replace',
      'synopsis.set',
      'vocabulary.upsert',
      'filter.save',
      'goal.save',
      'memory.write',
      'instructions.propose',
    ]);
    // A deferred row is found by name, description or keyword, so each carries a module word to be found by.
    for (const meta of TOOL_METADATA.filter((row) => row.load === 'deferred')) expect(meta.keywords?.length, meta.name).toBeGreaterThan(0);
  });

  it('gives every tool a closed, object-rooted JSON Schema derived from its params', () => {
    for (const item of listing) {
      expect(item.schema['type'], item.name).toBe('object');
      expect(item.schema['additionalProperties'], item.name).toBe(false);
    }
    // project.overview takes no params, so its closed object has no properties at all.
    const overview = listing.find((item) => item.name === 'project.overview');
    expect(overview?.schema['properties']).toEqual({});
  });

  it('gives the port tools their real schemas, not a placeholder', () => {
    const draft = listing.find((item) => item.name === 'scene.draft');
    const properties = draft?.schema['properties'] as Record<string, { type?: string }>;
    // include_forward_outline is the opt-in of context-assembly §4, declared on scene.draft beside the rest.
    expect(Object.keys(properties).sort()).toEqual(['doc', 'include_forward_outline', 'instruction', 'mode', 'selection', 'target_words']);
    expect(draft?.schema['required']).toEqual(['doc', 'instruction']);
  });

  it('agrees with the metadata table on every field of every row', () => {
    for (const meta of TOOL_METADATA) {
      const item = listing.find((candidate) => candidate.name === meta.name);
      expect(item).toMatchObject({
        risk: meta.risk,
        undoable: meta.undoable,
        response_token_cap: meta.response_token_cap,
        descriptionVersion: meta.descriptionVersion,
        surface: meta.surface,
      });
    }
  });

  it('exposes no tool for the writer’s batch codex import: the agent imports through codex.import, capped at 20 (codex.md §7.1)', () => {
    expect(listing.map((item) => item.name)).toContain('codex.import');
    expect(listing.some((item) => /importbatch|import_batch/i.test(item.name))).toBe(false);
    expect(TOOL_NAMES.some((name) => /importbatch|import_batch/i.test(name))).toBe(false);
  });
});

describe('the refusals that come before any tool runs', () => {
  const harness = makeHarness();
  const turn = { turnId: 'turn-registry' };

  it('refuses an unknown tool name, and lists the names that exist', () => {
    const result = harness.call({ name: 'book.delete', callId: 'c1', params: {} }, turn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-found');
    expect(result.error.message).toContain('"book.delete" is not a tool in this build');
    expect(result.error.correctiveHint).toContain('project.overview');
    expect(result.error.correctiveHint).not.toContain('agent.plan');
  });

  it('refuses a direct call to agent.plan and points at the plan protocol', () => {
    const result = harness.call({ name: 'agent.plan', callId: 'c2', params: {} }, turn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-params');
    expect(result.error.message).toContain('executePlan');
  });

  it('refuses a call with no turnId, and names what the turn is for', () => {
    const result = harness.call({ name: 'project.overview', callId: 'c3', params: {} }, { turnId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('turnId is required');
  });

  it('refuses a call with no callId, because a replay could not be recognised without one', () => {
    const result = harness.call({ name: 'project.overview', callId: '  ', params: {} }, turn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('callId is required');
  });

  it('refuses a source that is neither native nor mcp', () => {
    const result = harness.call(
      { name: 'project.overview', callId: 'c4', params: {} },
      { turnId: 'turn-registry', source: 'web' as unknown as 'native' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('source must be "native" or "mcp"');
  });
});

describe('a harness over an empty project', () => {
  it('builds without a registry argument, using the store’s own', () => {
    const harness = createHarness({ state: makeState() });
    expect(harness.registry['binder.create'].apply).toBeDefined();
  });
});
