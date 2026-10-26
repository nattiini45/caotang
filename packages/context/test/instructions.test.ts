/**
 * Layer LI, the writer's instructions (context-assembly §2): where it sits, what it carries and leaves out, the cap that is said out loud,
 * and the total-budget pass that never drops it. The prompt bytes for a project with no instructions are pinned by the other goldens.
 */
import { describe, expect, it } from 'vitest';

import { parseAgentFiles, serializeMemoryFile } from '@caotang/store';

import {
  LAYER_IDS,
  assemble,
  buildPreview,
  type AgentTask,
  type AssembledPrompt,
  type AssemblyTool,
  type LayerId,
} from '../src/index.js';
import { FOCUS_ID, IDS, INSTRUCTIONS_TEXT, MEMORY_INDEX_TEXT, buildApp, withInstructions } from './fixtures.js';

const CONTINUE: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

const META: AgentTask = { tool: 'meta', instruction: 'Summarise the project.' };

function layer(assembled: AssembledPrompt, id: LayerId) {
  const report = assembled.layers.find((candidate) => candidate.id === id);
  if (report === undefined) throw new Error(`no ${id} report`);
  return report;
}

const userOf = (assembled: AssembledPrompt): string => assembled.messages[1]?.content ?? '';

/** A file of `lines` numbered lines of about fifty characters, so its token size is easy to work out. */
const numbered = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `Rule ${String(i + 1).padStart(3, '0')}: keep the voice dry, always.`).join('\n');

describe('LI renders between L0 and L1', () => {
  it('puts the file and the index under their own headings, ahead of the project summary, in the user message', () => {
    const assembled = assemble(CONTINUE, withInstructions(buildApp()));
    const user = userOf(assembled);
    expect(user.startsWith('# Instructions\n')).toBe(true);
    expect(user.indexOf('## CAOTANG.md')).toBeLessThan(user.indexOf('## Memory index'));
    expect(user.indexOf('## Memory index')).toBeLessThan(user.indexOf('# Project'));
    expect(user).toContain(INSTRUCTIONS_TEXT);
    expect(user).toContain(MEMORY_INDEX_TEXT.trimEnd());
    expect(assembled.messages[0]?.content).not.toContain('British spelling');
    expect(layer(assembled, 'LI')).toMatchObject({ included: true, name: 'Instructions', baseBudget: 1_500, budget: 1_500 });
    expect(layer(assembled, 'LI').kept.map((item) => item.label)).toEqual(['CAOTANG.md', 'memory/MEMORY.md']);
  });

  it('is in every profile, the metadata tools included, when the project has instructions', () => {
    const tasks: Record<AssemblyTool, AgentTask> = {
      'scene.draft': CONTINUE,
      'dialogue.draft': META,
      'continuity.scan': { tool: 'continuity.scan', instruction: 'Find drift.', scope: [IDS.ch1, IDS.ch2] },
      'synopsis.fill': { tool: 'synopsis.fill', instruction: 'Summarise.', focus: FOCUS_ID },
      delegate: { tool: 'delegate', instruction: 'Brief.', scope: [IDS.ch1] },
      meta: META,
    };
    for (const [tool, task] of Object.entries(tasks)) {
      const assembled = assemble(task, withInstructions(buildApp()));
      expect(layer(assembled, 'LI').included, tool).toBe(true);
      expect(userOf(assembled).startsWith('# Instructions\n'), tool).toBe(true);
    }
  });

  it('is absent from a project with no instructions and no memory index, whose prompt is what it was before the layer', () => {
    const assembled = assemble(META, buildApp());
    expect(layer(assembled, 'LI')).toMatchObject({ included: false, tokens: 0 });
    expect(userOf(assembled)).not.toContain('Instructions');
    expect(userOf(assembled).startsWith('# Project\n')).toBe(true);
    // A file with nothing but blank lines is no file.
    const blank = withInstructions(buildApp(), { instructions: '\n  \n', index: '\n' });
    expect(layer(assemble(META, blank), 'LI').included).toBe(false);
  });

  it('sends the index alone when there is no CAOTANG.md, and the file alone when there is no index', () => {
    const app = buildApp();
    app.state.agentFiles = { index: MEMORY_INDEX_TEXT, memory: [], declined: new Map(), unreadable: [] };
    const indexOnly = userOf(assemble(META, app));
    expect(indexOnly).toContain('## Memory index');
    expect(indexOnly).not.toContain('## CAOTANG.md');

    const fileOnly = userOf(assemble(META, withInstructions(buildApp(), { index: '' })));
    expect(fileOnly).toContain('## CAOTANG.md');
    expect(fileOnly).not.toContain('## Memory index');
  });

  it('leaves out the index line of a note the load declined or could not read, and keeps the lines of the notes it read', () => {
    const index = [
      '- [Dialogue tags](style-dialogue.md) (style): Use "said" for tags.',
      '- [Secret plan](secret-plan.md) (reference): The killer is the butler',
      '- [Odd bytes](odd-bytes.md) (reference): The killer is the cook',
    ].join('\n');
    const parsed = parseAgentFiles(
      {
        'memory/MEMORY.md': index,
        'memory/style-dialogue.md': serializeMemoryFile({
          slug: 'style-dialogue',
          type: 'style',
          title: 'Dialogue tags',
          body: 'Use "said" for tags.',
          modified: '2026-10-01T10:00:00.000Z',
          origin: 'writer',
        }),
        'memory/secret-plan.md': 'The killer is the butler',
      },
      ['memory/odd-bytes.md'],
    );
    expect(parsed.files.declined.has('memory/secret-plan.md')).toBe(true);
    const app = buildApp();
    app.state.agentFiles = parsed.files;
    const user = userOf(assemble(META, app));
    expect(user).toContain('Dialogue tags');
    for (const hidden of ['Secret plan', 'The killer is the butler', 'Odd bytes', 'The killer is the cook']) expect(user).not.toContain(hidden);

    // With only declined lines left, the layer has no index to send, and no heading for it.
    const only = buildApp();
    only.state.agentFiles = { ...parsed.files, index: '- [Secret plan](secret-plan.md) (reference): The killer is the butler\n' };
    expect(userOf(assemble(META, only))).not.toContain('## Memory index');
    expect(layer(assemble(META, only), 'LI').included).toBe(false);
    // The snapshot's own index is held to the same rule.
    const override = { ...app, memoryIndex: index };
    expect(userOf(assemble(META, override))).not.toContain('Secret plan');
  });

  it('reads a very long index line in one pass, and finds the first link target on a line that has odd brackets before it', () => {
    const parsed = parseAgentFiles({ 'memory/MEMORY.md': '', 'memory/secret-plan.md': 'The killer is the butler' }, []);
    expect(parsed.files.declined.has('memory/secret-plan.md')).toBe(true);
    const hostile = '](' .repeat(200_000);
    const app = buildApp();
    app.state.agentFiles = {
      ...parsed.files,
      index: `- [Kept](ok.md): shown\n- [Secret plan]( ](secret-plan.md) (reference): hidden\n${hostile}`,
    };
    const started = Date.now();
    const user = userOf(assemble(META, app));
    expect(Date.now() - started).toBeLessThan(2000);
    // A target with white space is not a target, so the first real link on the second line names the declined note.
    expect(user).not.toContain('hidden');
    expect(user).toContain('Kept');
  });

  it('names AGENTS.md when that is the file read', () => {
    const user = userOf(assemble(META, withInstructions(buildApp(), { path: 'AGENTS.md' })));
    expect(user).toContain('## AGENTS.md');
    expect(user).not.toContain('## CAOTANG.md');
  });

  it('takes the snapshot’s own fields over the project’s', () => {
    const app = withInstructions(buildApp());
    const user = userOf(assemble(META, { ...app, instructions: { source: 'AGENTS.md', text: 'Only this.' }, memoryIndex: '- [A](a.md) (style)' }));
    expect(user).toContain('## AGENTS.md\nOnly this.');
    expect(user).toContain('- [A](a.md) (style)');
    expect(user).not.toContain('British spelling');
  });

  it('is still sent when a rule withholds part of the project', () => {
    const app = withInstructions({ ...buildApp(), withheld: new Set([IDS.ch1]) });
    expect(userOf(assemble(META, app))).toContain(INSTRUCTIONS_TEXT);
  });
});

describe('LI is a pure function of the files', () => {
  it('gives the same bytes for CRLF and LF text, and ignores the blank lines at the end', () => {
    const lf = userOf(assemble(META, withInstructions(buildApp(), { instructions: 'One.\nTwo.\n\n' })));
    const crlf = userOf(assemble(META, withInstructions(buildApp(), { instructions: 'One.\r\nTwo.\r\n' })));
    expect(crlf).toBe(lf);
  });

  it('carries no date, and nothing of the topic files’ front matter', () => {
    const topic = { slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'Use "said".', origin: 'agent', sourceTurn: 'turn_9' } as const;
    const first = withInstructions(buildApp());
    first.state.agentFiles = { ...first.state.agentFiles, memory: [{ ...topic, modified: '2026-10-01T10:00:00.000Z' }] };
    const user = userOf(assemble(CONTINUE, first));
    expect(user).not.toContain('2026-10-01');
    expect(user).not.toContain('turn_9');
    expect(user).not.toContain('modified');

    const later = withInstructions(buildApp());
    later.state.agentFiles = { ...later.state.agentFiles, memory: [{ ...topic, modified: '2027-01-01T00:00:00.000Z' }] };
    expect(userOf(assemble(CONTINUE, later))).toBe(user);
  });
});

describe('LI over its cap', () => {
  it('sends whole lines up to the cap, and says how much was sent in the drop, the note and the preview', () => {
    const app = withInstructions(buildApp(), { instructions: numbered(100), index: '' });
    const assembled = assemble(META, app, { layerBudgets: { LI: 300 } });
    const li = layer(assembled, 'LI');
    expect(li.tokens).toBeLessThanOrEqual(300);
    const sent = userOf(assembled)
      .split('\n')
      .filter((line) => line.startsWith('Rule '));
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.length).toBeLessThan(100);
    // Whole lines: the last one sent is a whole line of the file.
    expect(sent[sent.length - 1]).toBe(`Rule ${String(sent.length).padStart(3, '0')}: keep the voice dry, always.`);

    const reason = li.drops[0]?.reason;
    expect(reason).toMatchObject({ kind: 'instructions-cap', file: 'CAOTANG.md' });
    if (reason?.kind !== 'instructions-cap') throw new Error('not an instructions-cap drop');
    expect(reason.totalTokens).toBe(Math.ceil(numbered(100).length / 4));
    expect(reason.sentTokens).toBeLessThanOrEqual(300);
    const sentence = `CAOTANG.md is ${reason.totalTokens.toLocaleString('en-US')} tokens; the first ${reason.sentTokens.toLocaleString('en-US')} were sent`;
    expect(li.dropped).toEqual([`CAOTANG.md: ${sentence}`]);
    expect(li.notes).toEqual([`${sentence}.`]);

    const preview = buildPreview(assembled).layers.find((item) => item.id === 'LI');
    expect(preview?.notes).toEqual([`${sentence}.`]);
    expect(preview?.drops.map((drop) => drop.text)).toEqual([sentence]);
  });

  it('sends the whole file and records nothing when it fits', () => {
    const li = layer(assemble(META, withInstructions(buildApp())), 'LI');
    expect(li.drops).toEqual([]);
    expect(li.notes).toEqual([]);
  });

  it('shares the cap: a long CAOTANG.md leaves the index nothing, and the index drop says it sent none', () => {
    const app = withInstructions(buildApp(), { instructions: numbered(200) });
    const assembled = assemble(META, app, { layerBudgets: { LI: 200 } });
    expect(userOf(assembled)).not.toContain('## Memory index');
    expect(layer(assembled, 'LI').drops.map((drop) => drop.label)).toEqual(['CAOTANG.md', 'memory/MEMORY.md']);
    expect(layer(assembled, 'LI').notes[1]).toMatch(/^memory\/MEMORY\.md is \d+ tokens; the first 0 were sent\.$/u);
  });

  it('keeps the default cap at 1,500 tokens, and compact does not halve it', () => {
    const assembled = assemble({ ...CONTINUE, compact: true }, withInstructions(buildApp(), { instructions: numbered(400) }));
    expect(layer(assembled, 'LI').baseBudget).toBe(1_500);
    expect(layer(assembled, 'LI').tokens).toBeLessThanOrEqual(1_500);
    expect(layer(assembled, 'LI').tokens).toBeGreaterThan(1_400);
  });
});

describe('the total-budget pass never drops LI', () => {
  it('cuts the turns, the codex and the story, and leaves the instructions whole, with the prompt over budget', () => {
    const app = withInstructions(buildApp());
    const assembled = assemble(CONTINUE, app, { contextBudget: 700 });
    expect(assembled.overBudget).toBe(true);
    expect(userOf(assembled)).toContain(INSTRUCTIONS_TEXT);
    expect(layer(assembled, 'LI').drops).toEqual([]);
    expect(layer(assembled, 'LI').tokens).toBe(layer(assemble(CONTINUE, app), 'LI').tokens);
  });

  it('reaches the budget by cutting the layers that may be cut, with LI counted in the total', () => {
    const app = withInstructions(buildApp());
    const free = assemble(CONTINUE, app);
    const tight = assemble(CONTINUE, app, { contextBudget: free.estimate.promptTokens - 150 });
    expect(tight.overBudget).toBe(false);
    expect(tight.estimate.promptTokens).toBeLessThanOrEqual(free.estimate.promptTokens - 150);
    expect(userOf(tight)).toContain(INSTRUCTIONS_TEXT);
    expect(layer(tight, 'LI').drops).toEqual([]);
  });

  it('does not raise a tool’s total by the cap of a layer that is not sent', () => {
    const scan: AgentTask = { tool: 'continuity.scan', instruction: 'Find drift.', scope: [IDS.ch1, IDS.ch2] };
    const without = assemble(scan, buildApp());
    const withFile = assemble(scan, withInstructions(buildApp()));
    expect(withFile.totalBudget - without.totalBudget).toBe(1_500);
  });
});

describe('LAYER_IDS', () => {
  it('has LI second, so every report and every byLayer record follows it', () => {
    expect(LAYER_IDS).toEqual(['L0', 'LI', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
    const assembled = assemble(META, withInstructions(buildApp()));
    expect(Object.keys(assembled.estimate.byLayer)).toEqual([...LAYER_IDS]);
    expect(assembled.estimate.byLayer.LI).toBeGreaterThan(0);
  });
});
