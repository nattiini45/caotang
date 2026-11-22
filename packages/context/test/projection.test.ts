import { describe, expect, it } from 'vitest';

import { addDocument, nodeById, type CodexEntry } from '@caotang/store';

import { assemble } from '../src/assemble.js';
import { deserializeContextConfig, projectContextInput } from '../src/projection.js';
import type { AgentTask, AppSnapshot, ContextConfig } from '../src/types.js';
import { buildApp, entry, FOCUS_ID, IDS, scopeApp, selectionOfFocus, withInstructions } from './fixtures.js';

function workerAssemble(task: AgentTask, app: AppSnapshot, config: ContextConfig = {}) {
  const projected = projectContextInput(task, app, config);
  const cloned = structuredClone(projected);
  return assemble(cloned.task, cloned.app, deserializeContextConfig(cloned.config));
}

const sceneTask = (mode: 'draft' | 'continue' | 'rewrite_selection', extra: Partial<AgentTask> = {}): AgentTask => ({
  tool: 'scene.draft',
  instruction: 'Write the next beat.',
  focus: FOCUS_ID,
  mode,
  ...(mode === 'rewrite_selection' ? { selection: selectionOfFocus() } : {}),
  ...extra,
});

describe('worker projection parity', () => {
  const cases: { name: string; task: AgentTask; app?: AppSnapshot; config?: ContextConfig }[] = [
    { name: 'scene.draft draft', task: sceneTask('draft') },
    { name: 'scene.draft continue', task: sceneTask('continue') },
    { name: 'scene.draft rewrite_selection', task: sceneTask('rewrite_selection') },
    { name: 'scene.draft forward outline', task: sceneTask('continue', { includeForwardOutline: true }) },
    { name: 'scene.draft compact', task: sceneTask('continue', { compact: true }) },
    { name: 'synopsis.fill', task: { tool: 'synopsis.fill', instruction: 'Summarise.', focus: FOCUS_ID } },
    { name: 'meta', task: { tool: 'meta', instruction: 'What is this project about?' } },
    { name: 'meta conversation', task: { tool: 'meta', instruction: 'Hello.', conversation: true } },
    { name: 'continuity.scan whole manuscript', task: { tool: 'continuity.scan', instruction: 'Scan.', scope: undefined } },
    { name: 'delegate no scope', task: { tool: 'delegate', instruction: 'Read along.' } },
  ];

  for (const { name, task, app, config } of cases) {
    it(`${name} assembles byte-identically from the projected clone`, () => {
      const snapshot = app ?? buildApp();
      expect(workerAssemble(task, snapshot, config)).toEqual(assemble(task, snapshot, config));
    });
  }

  it('continuity.scan with an explicit scope matches', () => {
    const { app, ids } = scopeApp(6);
    const task: AgentTask = { tool: 'continuity.scan', instruction: 'Scan.', scope: ids.slice(0, 4) };
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('continuity.scan over the document limit with withheld scope entries reads the same body window', () => {
    const { app, ids } = scopeApp(25);
    const withSet: AppSnapshot = { ...app, withheld: new Set(ids.slice(0, 5)) };
    const task: AgentTask = { tool: 'continuity.scan', instruction: 'Scan.', scope: ids };
    expect(workerAssemble(task, withSet)).toEqual(assemble(task, withSet));
  });

  it('continuity.scan whole manuscript over the limit with withheld documents reads the same body window', () => {
    const { app, ids } = scopeApp(25);
    const withSet: AppSnapshot = { ...app, withheld: new Set(ids.slice(0, 5)) };
    const task: AgentTask = { tool: 'continuity.scan', instruction: 'Scan.', scope: undefined };
    expect(workerAssemble(task, withSet)).toEqual(assemble(task, withSet));
  });

  it('request pins over the pin limit with a withheld pin read the same excerpt window', () => {
    const { app, ids } = scopeApp(6);
    const withSet: AppSnapshot = { ...app, withheld: new Set(ids.slice(0, 1)) };
    const task: AgentTask = {
      tool: 'scene.draft',
      instruction: 'Write.',
      focus: ids[5],
      mode: 'continue',
      overrides: { include: ids.slice(0, 5).map((id) => ({ kind: 'doc' as const, id })) },
    };
    expect(workerAssemble(task, withSet)).toEqual(assemble(task, withSet));
  });

  it('delegate with a scope matches', () => {
    const { app, ids } = scopeApp(4);
    const task: AgentTask = { tool: 'delegate', instruction: 'Read.', scope: ids };
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('a shuffled project matches', () => {
    const app = buildApp({ shuffled: true });
    const task = sceneTask('continue');
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('request pins and exclusions match', () => {
    const app = buildApp();
    const task = sceneTask('continue', {
      overrides: {
        include: [{ kind: 'doc', id: IDS.ch1 }, { kind: 'doc', id: IDS.ch2 }, { kind: 'doc', id: IDS.ch5 }, { kind: 'codex', id: app.state.manifest.codex?.[0]?.id ?? '' }],
        exclude: [{ kind: 'doc', id: IDS.ch2 }],
      },
    });
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('withheld nodes and their attached-only codex match, including the drop report', () => {
    const app = buildApp();
    const withheld = new Set([IDS.ch1, IDS.act2]);
    const withSet: AppSnapshot = { ...app, withheld };
    const task = sceneTask('continue');
    expect(workerAssemble(task, withSet)).toEqual(assemble(task, withSet));
  });

  it('a withheld focus is refused the same way', () => {
    const app = buildApp();
    const withSet: AppSnapshot = { ...app, withheld: new Set([FOCUS_ID]) };
    const task = sceneTask('continue');
    expect(() => workerAssemble(task, withSet)).toThrow();
    expect(() => assemble(task, withSet)).toThrow();
  });

  it('instructions and the memory index match', () => {
    const app = withInstructions(buildApp());
    const task = sceneTask('continue');
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('a local restore-time formatter matches through the serialized timestamps', () => {
    const app = buildApp();
    const turns = [
      { turnId: 't1', intent: 'Earlier.', restoredAt: 1_700_000_000_000, readPolicy: 'p1' },
      { turnId: 't2', intent: 'Latest.', restoredAt: 1_700_000_060_000, restoredFromStep: 2, readPolicy: 'p1' },
    ];
    const withTurns: AppSnapshot = { ...app, turns, readPolicy: 'p1' };

    const config: ContextConfig = { formatTime: (ms) => `at-${new Date(ms).toISOString().slice(11, 16)}-local` };
    const task = sceneTask('continue');
    expect(workerAssemble(task, withTurns, config)).toEqual(assemble(task, withTurns, config));
  });

  it('hidden and rewound turns, and a withheld summary, match', () => {
    const app = buildApp();
    const turns = [
      { turnId: 't0', intent: 'Hidden.', hidden: true, readPolicy: 'old' },
      { turnId: 't1', intent: 'Rewound.', rewound: true, readPolicy: 'old' },
      { turnId: 't2', intent: 'Kept.', outcome: 'Did a thing.', readPolicy: 'p1' },
    ];
    const withTurns: AppSnapshot = {
      ...app,
      turns,
      readPolicy: 'p1',
      sessionSummary: { version: 1, covers: { from: 't2', to: 't2', turns: 1 }, text: 'A summary.', origin: 'auto', external: false, readPolicy: 'old' },
    };
    const task = sceneTask('continue');
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });

  it('a dialogue container focus matches', () => {
    const app = buildApp();
    addDocument(app.state, { parentId: 'manuscript', title: 'Branch', body: '-> start\nMara: The fog is lifting.\n-> END', id: 'n_dlg' });
    const node = nodeById(app.state, 'n_dlg');
    if (node !== undefined) node.type = 'dialogue';
    const task: AgentTask = { tool: 'dialogue.draft', instruction: 'Brief: continue.', focus: 'n_dlg' };
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('a dialogue.draft speaker-only candidate carries its description and matches', () => {
    const app = buildApp();
    const speaker = entry('Sable', { includePolicy: 'detected', type: 'character', description: 'SABLE-SPEAKER-DESCRIPTION', exclude: ['Sable'] });
    app.state.manifest.codex = [...(app.state.manifest.codex ?? []), speaker];
    addDocument(app.state, { parentId: 'manuscript', title: 'Branch', body: '-> start\nSable: The fog is lifting.\n-> END', id: 'n_dlg' });
    const node = nodeById(app.state, 'n_dlg');
    if (node !== undefined) node.type = 'dialogue';
    const task: AgentTask = { tool: 'dialogue.draft', instruction: 'Brief: continue.', focus: 'n_dlg' };
    const projected = projectContextInput(task, app, {});
    expect(JSON.stringify(projected)).toContain('SABLE-SPEAKER-DESCRIPTION');
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });
});

describe('worker projection reads only eligible content', () => {

  function defineTrap(target: object, key: string, label: string): void {
    Object.defineProperty(target, key, { get: () => { throw new Error(`read denied content: ${label}`); }, enumerable: true, configurable: true });
  }

  it('never reads a withheld node body/synopsis/notes, a Never description, provenance, topics or declined text', () => {
    const app = buildApp();
    const state = app.state;
    const withheldDoc = nodeById(state, IDS.ch1);
    if (withheldDoc === undefined) throw new Error('fixture missing ch1');

    defineTrap(withheldDoc, 'synopsis', 'withheld synopsis');
    defineTrap(withheldDoc, 'notes', 'withheld notes');
    const ch1Record = state.documents.get(IDS.ch1);
    if (ch1Record !== undefined) defineTrap(ch1Record, 'body', 'withheld body');

    const neverEntry = entry('Never Rule', { includePolicy: 'never', description: 'secret' });
    defineTrap(neverEntry, 'description', 'never description');

    const sourced = entry('Sourced', { description: 'ok' });
    defineTrap(sourced, 'sources', 'provenance');
    state.manifest.codex = [...(state.manifest.codex ?? []), neverEntry, sourced];

    state.agentFiles = {
      instructions: { path: 'CAOTANG.md', text: 'Write well.' },
      index: '- [Note](note.md) (style): a line.',
      memory: [{ slug: 'note', type: 'style', title: 'Note', body: 'topic text', modified: '2026-01-01', origin: 'agent' }],
      declined: new Map([['memory/broken.md', 'declined text']]),
      unreadable: [],
    };
    defineTrap(state.agentFiles.memory[0] as object, 'body', 'memory topic');
    const declinedHolder = state.agentFiles.declined as Map<string, string>;
    const originalGet = declinedHolder.get.bind(declinedHolder);
    declinedHolder.get = (key: string) => { if (key === 'memory/broken.md') throw new Error('read denied content: declined text'); return originalGet(key); };

    const withSet: AppSnapshot = { ...app, withheld: new Set([IDS.ch1]) };
    const task = sceneTask('continue');
    expect(() => projectContextInput(task, withSet, {})).not.toThrow();
  });

  it('does not transfer unused bodies, withheld content, Never descriptions, provenance, topics or declined text', () => {
    const app = buildApp();
    const state = app.state;

    for (const node of state.manifest.tree) if (node.type === 'document') state.manifest.derived.wordCounts[node.id] = 5;
    const neverEntry = entry('Never Rule', { includePolicy: 'never', description: 'NEVER-DESCRIPTION-TEXT' });
    const sourced = entry('Sourced', { description: 'ok', sources: [{ quote: 'PROVENANCE-QUOTE' }] as CodexEntry['sources'] });
    state.manifest.codex = [...(state.manifest.codex ?? []), neverEntry, sourced];
    state.agentFiles = {
      instructions: { path: 'CAOTANG.md', text: 'Write well.' },
      index: '- [Note](note.md) (style): a line.',
      memory: [{ slug: 'note', type: 'style', title: 'Note', body: 'TOPIC-BODY-TEXT', modified: '2026-01-01', origin: 'agent' }],
      declined: new Map([['memory/broken.md', 'DECLINED-TEXT']]),
      unreadable: [],
    };
    const withheld = new Set([IDS.ch1]);
    const withSet: AppSnapshot = { ...app, withheld };
    const task = sceneTask('continue');
    const projected = projectContextInput(task, withSet, {});
    const json = JSON.stringify(projected);

    expect(projected.app.state.documents.has(FOCUS_ID)).toBe(true);
    expect(projected.app.state.documents.has(IDS.notes)).toBe(false);
    expect(projected.app.state.documents.has(IDS.ch1)).toBe(false);
    expect(json).not.toContain('NEVER-DESCRIPTION-TEXT');
    expect(json).not.toContain('PROVENANCE-QUOTE');
    expect(json).not.toContain('TOPIC-BODY-TEXT');
    expect(json).not.toContain('DECLINED-TEXT');
    expect(json).not.toContain('Fog rolls in at dusk');

    const withheldNode = projected.app.state.manifest.tree.find((node) => node.id === IDS.ch1);
    expect(withheldNode?.synopsis).toBe('');
    expect(withheldNode?.title).toBe('Chapter 1');

    expect(() => structuredClone(projected)).not.toThrow();
  });

  it('carries a missing L1 count as a number, not the body it came from', () => {
    const app = buildApp();
    const state = app.state;

    state.manifest.derived.wordCounts = {};
    const task = sceneTask('continue');
    const projected = projectContextInput(task, app, {});
    const sync = assemble(task, app, {});
    const worker = assemble(projected.task, projected.app, deserializeContextConfig(projected.config));
    expect(worker).toEqual(sync);

    expect([...projected.app.state.documents.keys()]).toEqual([FOCUS_ID]);
    expect(Object.keys(projected.app.state.manifest.derived.wordCounts).length).toBeGreaterThan(1);
  });
});

describe('worker projection history reads only the recent window', () => {
  function defineTrap(target: object, key: string, label: string): void {
    Object.defineProperty(target, key, { get: () => { throw new Error(`read denied content: ${label}`); }, enumerable: true, configurable: true });
  }
  const turn = (turnId: string, outcome: string, extra: Record<string, unknown> = {}) => ({ turnId, intent: `Intent ${turnId}.`, outcome, readPolicy: 'p1', ...extra });

  it('does not read an older turn outcome outside the recent window, and stays byte-identical', () => {
    const app = buildApp();
    const turns = [turn('t_old', 'OLD-OUTCOME'), turn('t_mid', 'MID-OUTCOME'), turn('t_new', 'NEW-OUTCOME')];
    defineTrap(turns[0] as object, 'outcome', 'older turn outcome');
    const withTurns: AppSnapshot = { ...app, turns, readPolicy: 'p1' };
    const task = sceneTask('continue');
    expect(() => projectContextInput(task, withTurns, {})).not.toThrow();
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });

  it('does not transfer older turns’ outcomes or older activity rows', () => {
    const app = buildApp();
    const turns = [turn('t_old', 'OLD-OUTCOME-TEXT'), turn('t_mid', 'MID-OUTCOME-TEXT'), turn('t_new', 'NEW-OUTCOME-TEXT')];
    const activity = [
      { at: 0, command: 'doc.write', issuedBy: 'agent' as const, source: 'native' as const, turnId: 't_old', undoGroupId: 'g_old', affected: [], summary: 'OLD-ROW-TEXT' },
      { at: 1, command: 'doc.write', issuedBy: 'agent' as const, source: 'native' as const, turnId: 't_new', undoGroupId: 'g_new', affected: [], summary: 'NEW-ROW-TEXT' },
    ];
    const withTurns: AppSnapshot = { ...app, turns, activity, readPolicy: 'p1' };
    const task = sceneTask('continue');
    const projected = projectContextInput(task, withTurns, {});
    const json = JSON.stringify(projected);
    expect(json).not.toContain('OLD-OUTCOME-TEXT');
    expect(json).not.toContain('OLD-ROW-TEXT');
    expect(json).toContain('NEW-ROW-TEXT');
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });

  it('a current-policy activity row affecting a withheld node is scrubbed without reading its summary', () => {
    const app = buildApp();
    const turns = [turn('t1', 'Do something.')];
    const row = { at: 0, command: 'doc.write', issuedBy: 'agent' as const, source: 'native' as const, turnId: 't1', affected: [{ nodeId: IDS.ch1, title: 'Chapter 1' }, { nodeId: IDS.ch2, title: 'Chapter 2' }], summary: 'SECRET-ROW-SUMMARY' };
    defineTrap(row, 'summary', 'withheld-part row summary');
    const withTurns: AppSnapshot = { ...app, turns, activity: [row], readPolicy: 'p1', withheld: new Set([IDS.ch1]) };
    const task = sceneTask('continue');
    expect(() => projectContextInput(task, withTurns, {})).not.toThrow();
    const projected = projectContextInput(task, withTurns, {});
    expect(JSON.stringify(projected)).not.toContain('SECRET-ROW-SUMMARY');
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });

  it('a covered summary’s older turns keep their ids but not their outcomes', () => {
    const app = buildApp();
    const turns = [turn('t_a', 'A-OUTCOME'), turn('t_b', 'B-OUTCOME'), turn('t_c', 'C-OUTCOME'), turn('t_d', 'D-OUTCOME')];
    defineTrap(turns[0] as object, 'outcome', 'covered turn outcome');
    defineTrap(turns[1] as object, 'outcome', 'covered turn outcome');
    const withTurns: AppSnapshot = {
      ...app,
      turns,
      readPolicy: 'p1',
      sessionSummary: { version: 1, covers: { from: 't_a', to: 't_b', turns: 2 }, text: 'A summary.', origin: 'auto', external: false, readPolicy: 'p1' },
    };
    const task = sceneTask('continue');
    expect(() => projectContextInput(task, withTurns, {})).not.toThrow();
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });

  it('an invalid summary stays byte-identical', () => {
    const app = buildApp();
    const turns = [turn('t_a', 'A-OUTCOME'), turn('t_b', 'B-OUTCOME'), turn('t_c', 'C-OUTCOME')];
    const summary = { version: 1 as const, covers: { from: 't_gone', to: 't_gone', turns: 1 }, text: 'A summary.', origin: 'auto' as const, external: false, readPolicy: 'p1' };
    defineTrap(summary, 'text', 'invalid summary text');
    const withTurns: AppSnapshot = { ...app, turns, readPolicy: 'p1', sessionSummary: summary };
    const task = sceneTask('continue');
    expect(() => projectContextInput(task, withTurns, {})).not.toThrow();
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });

  it('a changed read policy scrubs blocked outcomes without reading them, and stays byte-identical', () => {
    const app = buildApp();
    const turns = [turn('t_old', 'OLD-BLOCKED', { readPolicy: 'old' }), turn('t_new', 'NEW-BLOCKED', { readPolicy: 'old' })];
    defineTrap(turns[0] as object, 'outcome', 'blocked older outcome');
    defineTrap(turns[1] as object, 'outcome', 'blocked recent outcome');
    const activity = [
      { at: 0, command: 'doc.write', issuedBy: 'agent' as const, source: 'native' as const, turnId: 't_new', undoGroupId: 'g_new', affected: [], summary: 'BLOCKED-ROW' },
    ];
    defineTrap(activity[0] as object, 'summary', 'blocked row summary');
    const withTurns: AppSnapshot = { ...app, turns, activity, readPolicy: 'p1' };
    const task = sceneTask('continue');
    expect(() => projectContextInput(task, withTurns, {})).not.toThrow();
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });

  it('a blocked session summary keeps its place without reading its text', () => {
    const app = buildApp();
    const turns = [turn('t_a', 'A-OUTCOME'), turn('t_b', 'B-OUTCOME')];
    const summary = { version: 1 as const, covers: { from: 't_a', to: 't_a', turns: 1 }, text: 'SUMMARY-TEXT', origin: 'auto' as const, external: false, readPolicy: 'old' };
    defineTrap(summary, 'text', 'blocked summary text');
    const withTurns: AppSnapshot = { ...app, turns, readPolicy: 'p1', sessionSummary: summary };
    const task = sceneTask('continue');
    expect(() => projectContextInput(task, withTurns, {})).not.toThrow();
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });

  it('a long history with a custom keep window stays byte-identical', () => {
    const app = buildApp();
    const turns = Array.from({ length: 12 }, (_, i) => turn(`t_${i}`, `OUTCOME-${i}`));
    const withTurns: AppSnapshot = { ...app, turns, readPolicy: 'p1', sessionKeepTurns: 3 };
    const task = sceneTask('continue');
    expect(workerAssemble(task, withTurns)).toEqual(assemble(task, withTurns));
  });
});

describe('worker projection reads only eligible node and codex content', () => {
  function defineTrap(target: object, key: string, label: string): void {
    Object.defineProperty(target, key, { get: () => { throw new Error(`read denied content: ${label}`); }, enumerable: true, configurable: true });
  }

  it('never reads descriptions when the tool has no codex layer or codex pins', () => {
    const app = buildApp();
    for (const candidate of app.state.manifest.codex ?? []) defineTrap(candidate, 'description', 'inactive codex layer');
    const task: AgentTask = { tool: 'meta', instruction: 'Hello.' };
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('preserves the detector fallback for an unknown include policy', () => {
    const app = buildApp();
    const candidate = entry('Lantern Keeper', { includePolicy: 'future-policy' as never, description: 'A distinctive fictional keeper.' });
    app.state.manifest.codex = [...(app.state.manifest.codex ?? []), candidate];
    const task = sceneTask('continue', { instruction: 'Continue with Lantern Keeper.' });
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
    expect(workerAssemble(task, app).parts.some((part) => part.layer === 'L2' && part.text.includes('A distinctive fictional keeper.'))).toBe(true);
  });

  it('does not read forward or research synopses the call does not send, and stays byte-identical', () => {
    const app = buildApp();
    const forward = nodeById(app.state, IDS.ch5);
    const research = nodeById(app.state, IDS.notes);
    if (forward === undefined || research === undefined) throw new Error('fixture missing nodes');
    defineTrap(forward, 'synopsis', 'forward synopsis');
    defineTrap(research, 'synopsis', 'research synopsis');
    const task = sceneTask('continue');
    expect(() => projectContextInput(task, app, {})).not.toThrow();
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('reads forward synopses when the call asks for the forward outline', () => {
    const app = buildApp();
    const task = sceneTask('continue', { includeForwardOutline: true });
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('does not read or transfer a request-excluded document’s synopsis', () => {
    const app = buildApp();
    const excluded = nodeById(app.state, IDS.ch1);
    if (excluded === undefined) throw new Error('fixture missing ch1');
    defineTrap(excluded, 'synopsis', 'excluded synopsis');
    const task = sceneTask('continue', { overrides: { exclude: [{ kind: 'doc', id: IDS.ch1 }] } });
    const projected = projectContextInput(task, app, {});
    const node = projected.app.state.manifest.tree.find((n) => n.id === IDS.ch1);
    expect(node?.synopsis).toBe('');
    expect(JSON.stringify(projected)).not.toContain('Elena reaches the harbor town');
  });

  it('request-excluded documents still assemble byte-identically', () => {
    const app = buildApp();
    const task = sceneTask('continue', { overrides: { exclude: [{ kind: 'doc', id: IDS.ch1 }, { kind: 'doc', id: IDS.ch2 }] } });
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('a request-excluded always codex entry still assembles byte-identically', () => {
    const app = buildApp();
    const excludedEntry = entry('Standing Rule', { includePolicy: 'always', description: 'EXCLUDED-ALWAYS-DESCRIPTION' });
    app.state.manifest.codex = [...(app.state.manifest.codex ?? []), excludedEntry];
    const task = sceneTask('continue', { overrides: { exclude: [{ kind: 'codex', id: excludedEntry.id }] } });
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('a request-excluded detected codex entry still assembles byte-identically', () => {
    const app = buildApp();
    const mentioned = entry('Zeppelin', { includePolicy: 'detected', description: 'ZEPPELIN-DESCRIPTION' });
    app.state.manifest.codex = [...(app.state.manifest.codex ?? []), mentioned];
    const task = sceneTask('continue', { instruction: 'Write about the Zeppelin.', overrides: { exclude: [{ kind: 'codex', id: mentioned.id }] } });
    expect(workerAssemble(task, app)).toEqual(assemble(task, app));
  });

  it('task and config envelopes carry only declared fields, byte-identical', () => {
    const app = buildApp();
    const task = sceneTask('rewrite_selection', {
      overrides: { include: [{ kind: 'doc', id: IDS.ch1, futureRefField: 'FUTURE-REF' } as never], exclude: [] },
      params: { target_words: 500 },
    });
    (task.selection as unknown as Record<string, unknown>)['futureSelectionField'] = 'FUTURE-SELECTION';
    defineTrap(task as object, 'futureTaskField', 'future task field');
    const config = {
      layerBudgets: { L2: 100, FUTURE_LAYER: 999999 },
      responseFormat: { jsonSchemaHint: { type: 'object' }, futureFormatField: 'FUTURE-FORMAT' },
    } as unknown as ContextConfig;
    const withInstr: AppSnapshot = { ...app, instructions: { source: 'CAOTANG.md', text: 'Write well.', futureInstrField: 'FUTURE-INSTR' } as never };
    expect(() => projectContextInput(task, withInstr, config)).not.toThrow();
    const projected = projectContextInput(task, withInstr, config);
    const json = JSON.stringify(projected);
    for (const secret of ['FUTURE-REF', 'FUTURE-SELECTION', 'FUTURE-FORMAT', 'FUTURE-INSTR', '999999']) expect(json).not.toContain(secret);
    expect(projected.config.layerBudgets).toEqual({ L2: 100 });
    expect(projected.config.responseFormat).toEqual({ jsonSchemaHint: { type: 'object' } });
    expect(projected.app.instructions).toEqual({ source: 'CAOTANG.md', text: 'Write well.' });
    expect(workerAssemble(task, withInstr, config)).toEqual(assemble(task, withInstr, config));
  });
});
