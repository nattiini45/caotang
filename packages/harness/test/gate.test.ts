/**
 * The source tag, the issuedBy and turnId every harness row carries, the tool-level
 * permission matrix, and the hard-deny check that the tool-level gate depends on.
 */

import { HARD_DENIED, HARD_DENY_CLASSES } from '@caotang/bus';
import { addDocument, addNode } from '@caotang/store';
import { VIDEO_TEMPLATE_IDS } from '@caotang/video-prompt-pack';
import { describe, expect, it } from 'vitest';

import { createAgentPorts, TOOL_METADATA, TOOL_NAMES } from '../src/index.js';
import { LANDING, LANDING_BODY, makeHarness, makeState, refusalOf, run, runAsync, snapshotOf, valueOf } from './fixtures.js';

describe('the activity source', () => {
  it('stamps every row a native call writes as native, the default', () => {
    const harness = makeHarness();
    run(harness, 'meta.set', { targets: [LANDING], status: 'final' }, { turnId: 'turn-n' });
    expect(harness.log.entries().map((entry) => entry.source)).toEqual(['native']);
  });

  it('stamps every row a call from the mcp surface writes as mcp, and leaves the bus’s own record alone', () => {
    // The project has opted in to external writes: without that, the call is refused and writes no row.
    const harness = makeHarness({ externalWrites: true });
    run(harness, 'meta.set', { targets: [LANDING], status: 'final' }, { turnId: 'turn-m', source: 'mcp' });
    expect(harness.log.entries().map((entry) => entry.source)).toEqual(['mcp']);
    expect(harness.log.entries()[0]?.issuedBy).toBe('agent');
  });

  it('keeps native and mcp rows apart in the one shared log', () => {
    const harness = makeHarness({ externalWrites: true });
    run(harness, 'meta.set', { targets: [LANDING], status: 'final' }, { turnId: 'turn-a' });
    run(harness, 'notes.append', { doc: LANDING, text: 'Via MCP.' }, { turnId: 'turn-b', source: 'mcp' });
    expect(harness.log.entries().map((entry) => entry.source)).toEqual(['native', 'mcp']);
  });
});

describe('the rows a harness call writes', () => {
  it('carries issuedBy agent, the turn, the call, and the undo group on every row', () => {
    const harness = makeHarness();
    run(harness, 'meta.set', { targets: [LANDING], status: 'final' }, { turnId: 'turn-rows', callId: 'call-rows' });
    const [row] = harness.log.entries();
    expect(row).toMatchObject({ issuedBy: 'agent', turnId: 'turn-rows', callId: 'call-rows:0', command: 'binder.setMeta' });
    expect(row?.undoGroupId).toBeDefined();
  });

  it('gives each command of a call its own callId, derived from the call’s', () => {
    const harness = makeHarness();
    run(harness, 'meta.set', { targets: [LANDING, 'The Storm'], status: 'final' }, { turnId: 'turn-ids', callId: 'call-ids' });
    expect(harness.log.entries().map((entry) => entry.callId)).toEqual(['call-ids:0', 'call-ids:1']);
  });
});

/** A picture the place tool can resolve, so its permission gate rather than its preparation is what answers. */
function gateState() {
  const state = makeState();
  state.manifest.assets = [
    {
      id: 'a_0000000001',
      file: 'a_0000000001.png',
      mime: 'image/png',
      sha256: '0'.repeat(64),
      bytes: 24,
      width: 1,
      height: 1,
      source: { kind: 'import' },
      createdAt: '2026-10-08T09:00:00.000Z',
    },
  ];
  // The comic tools prepare their real targets before the bus gate answers. Give them one valid book, page and linked script,
  // just as the other fixtures give their commands resolvable targets.
  const now = new Date(1_700_000_000_000);
  const book = addNode(state, { parentId: 'manuscript', title: 'Comic', kind: 'comic', now, id: 'n_COMIC000001' });
  const page = addNode(state, { parentId: book.id, title: 'Page 1', type: 'comic-page', now, id: 'n_COMICPAGE01' });
  page.comicPage = { size: 'us', panels: [] };
  const script = addDocument(state, {
    parentId: book.id,
    title: 'Script',
    kind: 'comic-script',
    body: 'Page 1\n\nPanel 1\n\nELENA: The ferry is late.',
    now,
    id: 'n_COMICSCRIPT',
  });
  book.comic = { scriptDocId: script.id };
  return state;
}

describe('the tool-level permission matrix', () => {
  const writeConfirm = TOOL_METADATA.filter((meta) => meta.risk === 'write-confirm').map((meta) => meta.name);
  const writeAuto = TOOL_METADATA.filter((meta) => meta.risk === 'write-auto').map((meta) => meta.name);

  // The extensions add two write-confirm tools (codex.import, coherence.review) and one write-auto tool
  // (coherence.setFindingStatus, restricted to `fixed` by the coherence tool's own rule); the
  // storyboard and prompt-pack modules' write tools: shots.derive and prompt.draft (write-confirm), and the
  // write-auto shots.annotate; and the dialogue module's dialogue.draft (write-confirm,
  // dialogue-narrative.md §7); its read, dialogue.table, is not in either list. The allowlisted bus primitives add
  // notes.replace, vocabulary.upsert and timeline.edit (write-confirm), and synopsis.set, filter.save and goal.save (write-auto).
  it('lists the write-confirm and write-auto tools the matrix covers', () => {
    expect(writeConfirm.sort()).toEqual([
      'binder.restructure',
      'codex.import',
      'codex.write',
      'coherence.review',
      'comic.derive',
      'comic.scriptFromPages',
      'dialogue.draft',
      'doc.import',
      'export.compile',
      'notes.replace',
      'pictures.import',
      'pictures.place',
      'pictures.transcribe',
      'prompt.draft',
      'scene.draft',
      'shots.derive',
      'synopsis.fill',
      'timeline.edit',
      'vocabulary.upsert',
    ]);
    expect(writeAuto.sort()).toEqual(['coherence.setFindingStatus', 'comic.letter', 'filter.save', 'goal.save', 'meta.set', 'notes.append', 'pictures.annotate', 'pictures.attach', 'shots.annotate', 'synopsis.set']);
  });

  it('refuses every write-confirm tool when neither a plan nor a confirmation is present, and names the tool', async () => {
    // The LLM-backed ports are injected here, so the gate, not the not-wired refusal, is what answers.
    // A port with no implementation is refused as not wired first: `coherence.review` has no default port
    // (its model call is async), and `shots.derive` and `prompt.draft` need a staged proposal or a model, so they
    // are injected for this matrix the same way the LLM ports are.
    const implemented = () => ({ ok: true as const, value: { data: {}, summary: '', affected: [] } });
    const harness = makeHarness(
      {
        ports: {
          'scene.draft': implemented,
          'synopsis.fill': implemented,
          'coherence.review': implemented,
          'shots.derive': implemented,
          'prompt.draft': implemented,
          'dialogue.draft': implemented,
        },
        asyncPorts: { 'pictures.import': async () => implemented(), 'pictures.transcribe': async () => implemented() },
      },
      gateState(),
    );
    for (const name of writeConfirm) {
      const outcome = name === 'pictures.import' || name === 'pictures.transcribe' ? await runAsync(harness, name, minimalParams(name)) : run(harness, name, minimalParams(name));
      const error = refusalOf(outcome);
      expect(error.code, name).toBe('permission-denied');
      expect(error.message, name).toContain(`"${name}" is a write-confirm tool`);
    }
  });

  it('lets a write-auto tool through with no approval at all', () => {
    const harness = makeHarness();
    expect(valueOf(run(harness, 'meta.set', { targets: [LANDING], status: 'draft' })).undoGroupId).toBeDefined();
    expect(valueOf(run(harness, 'notes.append', { doc: LANDING, text: 'Hello.' })).undoGroupId).toBeDefined();
  });

  it('refuses the protocol row as a tool call, whatever approval it is given', () => {
    const error = refusalOf(run(makeHarness(), 'agent.plan', { steps: [] }, { permission: { approvedPlan: true } }));
    expect(error.code).toBe('invalid-params');
  });
});

describe('a delegated agent’s calls (agent-harness §2, "Delegate")', () => {
  const approved = { approvedPlan: true, confirmed: true } as const;

  it('refuses every tool that is not a read when the turn names an agent path, whatever approval rides on it, and writes nothing', async () => {
    const state = gateState();
    const implemented = () => ({ ok: true as const, value: { data: {}, summary: '', affected: [] } });
    const harness = makeHarness(
      {
        ports: {
          'scene.draft': implemented,
          'synopsis.fill': implemented,
          'coherence.review': implemented,
          'shots.derive': implemented,
          'prompt.draft': implemented,
          'dialogue.draft': implemented,
        },
        asyncPorts: { 'pictures.import': async () => implemented(), 'pictures.transcribe': async () => implemented() },
      },
      state,
    );
    const before = snapshotOf(state);
    // Every write-confirm tool, and the two write-auto tools whose params fit in a line: the gate is what answers, not the closed-set check.
    const writes: [string, Record<string, unknown>][] = [
      ...TOOL_METADATA.filter((meta) => meta.risk === 'write-confirm').map((meta): [string, Record<string, unknown>] => [meta.name, minimalParams(meta.name)]),
      ['meta.set', { targets: [LANDING], status: 'final' }],
      ['notes.append', { doc: LANDING, text: 'Hello.' }],
    ];
    expect(writes.length).toBeGreaterThan(10);
    for (const [name, params] of writes) {
      const context = { agentPath: 'turn-1/reader#1', permission: approved };
      const outcome = name === 'pictures.import' || name === 'pictures.transcribe' ? await runAsync(harness, name, params, context) : run(harness, name, params, context);
      const error = refusalOf(outcome);
      expect(error.code, name).toBe('permission-denied');
      expect(error.message, name).toContain('a delegated agent can only read; return the change as a proposed step');
    }
    expect(snapshotOf(state)).toBe(before);
    expect(harness.log.length).toBe(0);
  });

  it('still answers a read under an agent path, and the same write runs for the parent turn that holds the approval', () => {
    const harness = makeHarness();
    expect(valueOf(run(harness, 'doc.read', { doc: LANDING }, { agentPath: 'turn-2/reader#1' })).data).toBeDefined();
    expect(valueOf(run(harness, 'meta.set', { targets: [LANDING], status: 'final' }, { permission: approved })).undoGroupId).toBeDefined();
  });

  it('does not let an external tool be called from an agent path', async () => {
    const harness = makeHarness();
    const outcome = await harness.callExternal({ name: 'mcp__server__tool', callId: 'ext-1', params: {} }, { turnId: 'turn-3', agentPath: 'turn-3/general#1' });
    expect(outcome.ok ? undefined : outcome.error.code).toBe('permission-denied');
  });

  it('answers a direct agent.delegate call with the refusal that it runs inside a turn, or as not wired where the agent ports are absent', () => {
    const wired = makeHarness({ ports: createAgentPorts() });
    const direct = refusalOf(run(wired, 'agent.delegate', { agent: 'reader', brief: 'Read the harbor chapters.' }));
    expect(direct.code).toBe('invalid-params');
    expect(direct.message).toContain('runs inside an agent turn');
    const bare = refusalOf(run(makeHarness(), 'agent.delegate', { agent: 'reader', brief: 'Read the harbor chapters.' }));
    expect(bare.message).toContain('no implementation in this build');
  });
});

describe('the hard-deny list the tool names are checked against', () => {
  it('shares no name with the bus’s hard-denied commands, so the tool-level gate never reads a deny it does not own', () => {
    const hardDenied = Object.keys(HARD_DENIED);
    expect(hardDenied).toEqual(['project.deleteNode']);
    expect(TOOL_NAMES.filter((name) => hardDenied.includes(name))).toEqual([]);
    expect(HARD_DENY_CLASSES).toContain('deletion');
  });

  it('exposes no tool that deletes, because deletion is UI-only (agent-harness §3)', () => {
    expect(TOOL_NAMES.some((name) => /delete/i.test(name))).toBe(false);
  });
});

describe('a refused call', () => {
  it('leaves the project and the log exactly as they were', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    run(harness, 'binder.restructure', { ops: [{ action: 'rename', node: LANDING, title: 'X' }] });
    expect(snapshotOf(state)).toBe(before);
    expect(harness.log.length).toBe(0);
  });
});

/** The smallest params that pass the closed-set check for each write-confirm tool, so the gate is what refuses. */
function minimalParams(name: string): Record<string, unknown> {
  switch (name) {
    case 'binder.restructure':
      return { ops: [{ action: 'rename', node: LANDING, title: 'X' }] };
    case 'codex.write':
      return { entries: [{ action: 'create', name: 'Mara' }] };
    case 'codex.import':
      // A name the landing document names, so the citation resolves and the gate is what answers.
      return { entries: [{ name: 'ferry', attachTo: [LANDING] }] };
    case 'coherence.review':
      return { scope: { mode: 'full' } };
    case 'doc.import':
      return { parent: 'Chapter 1', title: 'Import', body: 'x' };
    case 'notes.replace':
      return { doc: LANDING, notes: 'x' };
    case 'vocabulary.upsert':
      return { kind: 'status', name: 'In Review', color: '#3fa66a' };
    case 'timeline.edit':
      return { ops: [{ op: 'move', nodeId: LANDING, newParentId: 'Chapter 2', index: 0 }] };
    case 'export.compile':
      return { selection: { root: 'manuscript' }, format: 'md' };
    case 'scene.draft':
      return { doc: LANDING, instruction: 'Write.' };
    case 'synopsis.fill':
      return { docs: [LANDING] };
    case 'shots.derive':
      return { doc: LANDING };
    case 'dialogue.draft':
      // A container the landing document stands in for: the gate, not the closed-set check, answers.
      return { doc: LANDING, instruction: 'Write.' };
    case 'prompt.draft':
      // A shot id the storyboard tools would name, and a vendor template the package installs.
      return { shots: ['n_SHOT0000001'], vendor: VIDEO_TEMPLATE_IDS[0] };
    case 'pictures.import':
      return { stagingId: 'stg_ABCDEF0123' };
    case 'pictures.place':
      return { assetId: 'a_0000000001', doc: LANDING, anchor: LANDING_BODY };
    case 'pictures.transcribe':
      return { assetIds: ['a_0000000001'] };
    case 'comic.derive':
    case 'comic.scriptFromPages':
      return { book: 'Comic' };
    default:
      return {};
  }
}
