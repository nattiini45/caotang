/**
 * The writer's instructions and the agent's memory in whole turns (context-assembly.md §2, layer LI; agent-harness §3 and §4): a rule in
 * CAOTANG.md reaches the drafting call's prompt, a memory write needs a confirm card and lands in one undo group that a restore removes,
 * a refused or cancelled card writes nothing, and no permission mode approves a card that changes what every later request says. The
 * model is the mock provider; nothing here needs a key.
 */

import { describe, expect, it } from 'vitest';

import { DEMO_INSTRUCTIONS, DEMO_INTENTS, DRAFT_PREFIX, demoScripts } from '@caotang/gateway/mock';
import { agentFileTexts, type ProjectState } from '@caotang/store';

import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { modePolicy } from '../../src/agent/mode.js';
import { makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { prose, steps, transcript } from '../agent/scripts.js';

const RULE = 'No semicolons in dialogue.';

/** The fixture project with a CAOTANG.md and one memory note, as a project opened from a folder that has them. */
function withFiles(): ProjectState {
  const state = makeState();
  state.agentFiles = {
    instructions: { path: 'CAOTANG.md', text: `British spelling.\n${RULE}\n` },
    index: '- [Scene endings](process-endings.md) (process): End on a line of dialogue.\n',
    memory: [
      { slug: 'process-endings', type: 'process', title: 'Scene endings', body: 'End on a line of dialogue.', modified: '2026-10-01T10:00:00.000Z', origin: 'writer' },
    ],
    declined: new Map(),
    unreadable: [],
  };
  return state;
}

const memoryOf = (state: ProjectState): string[] => state.agentFiles.memory.map((note) => note.slug);

const scenarios: Scenario[] = [
  {
    name: 'an instruction in CAOTANG.md reaches the planner and scene.draft’s prompt, ahead of the project summary',
    category: 'codex',
    intent: 'Draft the storm.',
    project: withFiles,
    gateway: () =>
      mockGateway([
        transcript('Draft the storm.', [
          steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'Elena watches the lamp fail.', mode: 'continue' }, expect: 'The Storm continues' }),
        ]),
        prose('Brief: Elena watches the lamp fail.', 'She watches it go.'),
      ]),
    expect: {
      status: 'applied',
      requests: [
        { includes: ['# Instructions', '## CAOTANG.md', RULE, '## Memory index', 'Scene endings'] },
        { system: DRAFT_PREFIX, includes: ['Brief: Elena watches the lamp fail.', '# Instructions', RULE, 'British spelling.'] },
      ],
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
    },
  },
  {
    name: 'a project with no instructions sends none: the drafting call carries no Instructions heading',
    category: 'codex',
    intent: 'Draft the storm.',
    project: makeState,
    gateway: () =>
      mockGateway([
        transcript('Draft the storm.', [
          steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'Elena watches the lamp fail.', mode: 'continue' }, expect: 'The Storm continues' }),
        ]),
        prose('Brief: Elena watches the lamp fail.', 'She watches it go.'),
      ]),
    expect: {
      status: 'applied',
      requests: [{ system: DRAFT_PREFIX, includes: ['Brief: Elena watches the lamp fail.'], excludes: ['# Instructions'] }],
    },
  },
  {
    name: 'a memory write needs a confirm card, lands in one undo group, and a restore removes it',
    category: 'permission',
    intent: 'Remember that I never want semicolons in dialogue.',
    project: withFiles,
    gateway: () =>
      mockGateway([
        transcript('Remember that I never want semicolons in dialogue.', [
          steps({ tool: 'tool.search', params: { query: 'remember memory note' }, expect: 'the memory tools are loaded' }),
          steps({
            tool: 'memory.write',
            params: { title: 'Dialogue punctuation', type: 'style', body: 'No semicolons in dialogue.' },
            expect: 'the note is saved',
          }),
        ]),
      ]),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['memory.write'], decision: 'approved' }] },
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'tool.search', outcome: 'ok' },
          { tool: 'memory.write', outcome: 'ok', params: { title: 'Dialogue punctuation' } },
        ],
      },
      reached: { 'memory.write': 'search' },
      summaryIncludes: ['saved the memory note "Dialogue punctuation"'],
      // The turn is reversed after it ran, and the project is byte-equal to what it was: the note, its file and its index line are gone.
      restores: true,
      state: (state) => (memoryOf(state).join() === 'process-endings' ? [] : [`the restored notes are ${memoryOf(state).join()}`]),
    },
  },
  {
    name: 'a memory write the writer cancels at the card writes nothing',
    category: 'permission',
    intent: 'Remember that I never want semicolons in dialogue.',
    project: withFiles,
    preload: ['memory.write'],
    gateway: () =>
      mockGateway([
        transcript('Remember that I never want semicolons in dialogue.', [
          steps({ tool: 'memory.write', params: { title: 'Dialogue punctuation', type: 'style', body: 'No semicolons in dialogue.' }, expect: 'the note is saved' }),
        ]),
      ]),
    decisions: [{ action: 'cancel' }],
    expect: {
      status: 'cancelled',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['memory.write'], decision: 'cancelled' }] },
      trace: { matcher: 'strict', calls: [] },
      state: (state) => (memoryOf(state).join() === 'process-endings' ? [] : ['a note was written although the card was cancelled']),
    },
  },
  {
    name: 'a memory note titled with a codex name is refused whenever the card is approved, and writes nothing',
    category: 'permission',
    intent: 'Remember that Elena is left-handed.',
    project: withFiles,
    preload: ['memory.write'],
    gateway: () =>
      mockGateway([
        transcript('Remember that Elena is left-handed.', [
          steps({ tool: 'memory.write', params: { title: 'Elena', type: 'reference', body: 'Elena is left-handed.' }, expect: 'the note is saved' }),
        ]),
      ]),
    expect: {
      // The bus refuses the title each time the card is approved (the refusal names codex.write: tools-agent-files.test.ts), so the turn
      // stops on a card that cannot be applied, and nothing was written.
      status: 'failed',
      trace: { matcher: 'strict', calls: [] },
      state: (state) => (memoryOf(state).join() === 'process-endings' ? [] : ['a note was written although its title is a codex name']),
    },
  },
  {
    name: 'a proposed CAOTANG.md waits for the card, applies once approved, and a restore puts the file back',
    category: 'permission',
    intent: 'Write down my house style.',
    project: withFiles,
    gateway: () =>
      mockGateway([
        transcript('Write down my house style.', [
          steps({ tool: 'tool.search', params: { query: 'instructions house style' }, expect: 'the instructions tool is loaded' }),
          steps({ tool: 'instructions.propose', params: { text: 'British spelling.\nPast tense, close third person on Mara.\n' }, expect: 'CAOTANG.md says it' }),
        ]),
      ]),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['instructions.propose'], decision: 'approved' }] },
      reached: { 'instructions.propose': 'search' },
      summaryIncludes: ['changed CAOTANG.md'],
      restores: true,
      state: (state) => (state.agentFiles.instructions?.text === `British spelling.\n${RULE}\n` ? [] : [`CAOTANG.md reads ${JSON.stringify(state.agentFiles.instructions?.text)}`]),
    },
  },
];

describe('the writer’s instructions and the agent’s memory in a turn', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const result = await evaluate(scenario);
      expect(result.failures).toEqual([]);
    });
  }

  it('the restore check reads the agent files: a note left behind would be a different project', () => {
    const before = agentFileTexts(withFiles().agentFiles);
    const after = withFiles();
    after.agentFiles = { ...after.agentFiles, memory: [] };
    expect(agentFileTexts(after.agentFiles)).not.toEqual(before);
  });
});

describe('Initialise from this project, on the built-in demo provider', () => {
  const scenario = (decisions: Scenario['decisions']): Scenario => ({
    name: 'demo: a first CAOTANG.md',
    category: 'demo',
    intent: DEMO_INTENTS.instructions,
    // The panel's button loads the row for the turn, so the planner needs no search.
    preload: ['instructions.propose'],
    project: makeState,
    gateway: () => mockGateway(demoScripts),
    ...(decisions === undefined ? {} : { decisions }),
    expect: { status: 'applied' },
  });

  it('proposes one canned CAOTANG.md behind one confirm card, writes it once approved, and a restore removes it', async () => {
    const result = await evaluate({
      ...scenario(undefined),
      expect: {
        status: 'applied',
        cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['instructions.propose'], decision: 'approved' }] },
        trace: { matcher: 'strict', calls: [{ tool: 'instructions.propose', outcome: 'ok' }] },
        reached: { 'instructions.propose': 'preload' },
        maxModelCalls: 1,
        restores: true,
        state: (state) => (state.agentFiles.instructions === undefined ? [] : ['CAOTANG.md survived the restore']),
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.run.before).not.toContain('CAOTANG.md');
  });

  it('holds the canned text it writes', async () => {
    const result = await evaluate({ ...scenario(undefined), expect: { status: 'applied', reached: { 'instructions.propose': 'preload' }, state: (state) => (state.agentFiles.instructions?.text === DEMO_INSTRUCTIONS ? [] : [`CAOTANG.md reads ${JSON.stringify(state.agentFiles.instructions?.text)}`]) } });
    expect(result.failures).toEqual([]);
  });

  it('writes nothing when the writer cancels the card', async () => {
    const result = await evaluate({
      ...scenario([{ action: 'cancel' }]),
      expect: { status: 'cancelled', state: (state) => (state.agentFiles.instructions === undefined ? [] : ['CAOTANG.md was written although the card was cancelled']) },
    });
    expect(result.failures).toEqual([]);
  });
});

describe('no permission mode approves a change to what every later request says', () => {
  const card = (tools: string[]) => ({ tools, external: false });

  it('refuses memory.write and instructions.propose in Accept edits and in Auto, and still approves what those modes approved', () => {
    for (const mode of ['accept-edits', 'auto'] as const) {
      const policy = modePolicy(mode);
      expect(policy.approves(card(['memory.write'])), `${mode} memory.write`).toBe(false);
      expect(policy.approves(card(['instructions.propose'])), `${mode} instructions.propose`).toBe(false);
      expect(policy.approves(card(['notes.replace', 'memory.write'])), `${mode} a card holding one`).toBe(false);
      expect(policy.approves(card(['notes.replace'])), `${mode} notes.replace`).toBe(true);
    }
    expect(modePolicy('auto').approves(card(['binder.restructure']))).toBe(true);
  });
});
