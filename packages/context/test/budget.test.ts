/**
 * Per-layer budgets, the flow-up of unused budget, compact, and the scope limit
 * (context-assembly §2, §3, §7; agent-harness row 10). Each expectation is worked out from
 * the spec's numbers, and the fixture's sizes are read from the fixture, not from output.
 */
import { describe, expect, it } from 'vitest';

import { addDocument, type ProjectState } from '@caotang/store';

import {
  DEFAULT_CONTINUATION_CHARS,
  LAYER_IDS,
  SCOPE_DOCUMENT_LIMIT,
  assemble,
  buildPreview,
  profileFor,
  type AgentTask,
  type AppSnapshot,
  type AssembledPrompt,
  type AssemblyTool,
  type ContextConfig,
  type LayerId,
} from '../src/index.js';
import { LONG_FOCUS, buildApp, FOCUS_ID, IDS, heavyAlwaysApp, longApp, scopeApp, withInstructions } from './fixtures.js';

const CONTINUE: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

/** The dialogue container the dialogue.draft task is focused on: a container of the fixture's manuscript, with its Ink as its body. */
const DIALOGUE_ID = 'n_dialogue';
const DIALOGUE_INK = ['=== opening ===', 'Elena: The ferry is late again.', '-> arrival', '', '=== arrival ===', 'A bird sings from the rafters.', '-> END'].join('\n');

/**
 * The fixture's project with one dialogue container in its manuscript (dialogue-narrative §7). The container is the focus of
 * dialogue.draft, so the invariant suites below assemble that tool over a real container, not a stand-in.
 */
function dialogueApp(): AppSnapshot {
  const app = buildApp();
  const state: ProjectState = app.state;
  addDocument(state, { id: DIALOGUE_ID, parentId: 'manuscript', title: 'Harbour talk', type: 'dialogue', body: DIALOGUE_INK, now: new Date('2026-10-01T10:00:00.000Z') });
  return app;
}

const DIALOGUE: AgentTask = { tool: 'dialogue.draft', instruction: 'Brief: A thank-you.', focus: DIALOGUE_ID };

/**
 * One task per tool the invariant suites assemble: every tool of the assembly, dialogue.draft included (its layers and budgets are
 * the same invariants as the others, so it runs in both suites over its own container).
 */
const TASKS: Readonly<Record<AssemblyTool, AgentTask>> = {
  'scene.draft': CONTINUE,
  'continuity.scan': { tool: 'continuity.scan', instruction: 'Find drift.', scope: [IDS.ch1, IDS.ch2, IDS.ch3] },
  'synopsis.fill': { tool: 'synopsis.fill', instruction: 'Summarise.', focus: FOCUS_ID },
  meta: { tool: 'meta', instruction: 'Summarise the project.' },
  'dialogue.draft': DIALOGUE,
  delegate: { tool: 'delegate', instruction: 'Brief: who knows about the wall?', scope: [IDS.ch1, IDS.ch2] },
};

/** The project each tool is assembled over: the dialogue container for dialogue.draft, the fixture's manuscript for the rest. */
function appFor(tool: AssemblyTool): AppSnapshot {
  return tool === 'dialogue.draft' ? dialogueApp() : buildApp();
}

function layer(assembled: AssembledPrompt, id: LayerId) {
  const report = assembled.layers.find((candidate) => candidate.id === id);
  if (report === undefined) throw new Error(`no ${id} report`);
  return report;
}

function included(assembled: AssembledPrompt): LayerId[] {
  return assembled.layers.filter((report) => report.included).map((report) => report.id);
}

describe('the layers each tool assembles (§3)', () => {
  it('scene.draft assembles the full stack, with LI when the project has instructions', () => {
    expect(included(assemble(TASKS['scene.draft'], withInstructions(buildApp())))).toEqual([...LAYER_IDS]);
    expect(included(assemble(TASKS['scene.draft'], buildApp()))).toEqual(LAYER_IDS.filter((id) => id !== 'LI'));
  });

  it('continuity.scan assembles L2 expanded, L4 expanded and the scope tails, without structure or turns', () => {
    expect(included(assemble(TASKS['continuity.scan'], buildApp()))).toEqual(['L0', 'L1', 'L2', 'L4', 'L5', 'L7']);
  });

  it('delegate assembles a fresh context: the scope tails and the layers around them, and never the recent turns', () => {
    const assembled = assemble(TASKS.delegate, buildApp());
    expect(included(assembled)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L7']);
    expect(layer(assembled, 'L6').included).toBe(false);
    // The fixture's turns are in the app and reach no part of the prompt.
    expect(assembled.messages.map((message) => message.content).join('\n')).not.toContain('Tighten the opening of chapter 3');
  });

  it('synopsis.fill assembles the structure and the full document, without codex, story or turns', () => {
    expect(included(assemble(TASKS['synopsis.fill'], buildApp()))).toEqual(['L0', 'L1', 'L3', 'L5', 'L7']);
  });

  it('the metadata tools assemble system, project and task only', () => {
    expect(included(assemble(TASKS.meta, buildApp()))).toEqual(['L0', 'L1', 'L7']);
  });

  it('gives each capped layer the base budget §2 names', () => {
    const scene = assemble(TASKS['scene.draft'], buildApp());
    expect(scene.layers.map((report) => report.baseBudget)).toEqual([
      undefined,
      1_500,
      1_500,
      1_000,
      1_200,
      2_000,
      2_000,
      1_500,
      undefined,
    ]);
    const continuity = assemble(TASKS['continuity.scan'], buildApp());
    expect(layer(continuity, 'L2').baseBudget).toBe(2_500);
    expect(layer(continuity, 'L4').baseBudget).toBe(6_000);
    expect(layer(continuity, 'L5').baseBudget).toBe(SCOPE_DOCUMENT_LIMIT * 1_000 + 1_000);
    const fill = assemble(TASKS['synopsis.fill'], buildApp());
    expect(layer(fill, 'L5').baseBudget).toBe(25_000);
  });

  it('pins every per-tool codex, story and synopsis budget the reserved fit leaves alone', () => {
    const budgetOf = (tool: AssemblyTool, id: LayerId) => profileFor(tool).budgets[id];
    expect(budgetOf('scene.draft', 'L2')).toBe(1_000);
    expect(budgetOf('continuity.scan', 'L2')).toBe(2_500);
    expect(budgetOf('continuity.scan', 'L4')).toBe(6_000);
    expect(budgetOf('synopsis.fill', 'L3')).toBe(1_200);
    expect(budgetOf('synopsis.fill', 'L5')).toBe(25_000);
    expect(profileFor('synopsis.fill').layers).not.toContain('L2');
    expect(budgetOf('synopsis.fill', 'L2')).toBeUndefined();
  });

  it('keeps the profile tables and the assembled reports in agreement', () => {
    for (const tool of Object.keys(TASKS) as AssemblyTool[]) {
      const profile = profileFor(tool);
      const assembled = assemble(TASKS[tool], withInstructions(appFor(tool)));
      expect(included(assembled)).toEqual(LAYER_IDS.filter((id) => profile.layers.includes(id)));
      // LI is in every profile, the metadata tools' included, and a project with no instructions has no such layer.
      expect(profile.layers).toContain('LI');
      expect(included(assemble(TASKS[tool], appFor(tool)))).toEqual(LAYER_IDS.filter((id) => id !== 'LI' && profile.layers.includes(id)));
    }
  });
});

describe('compact (§7): halves L2 and L4', () => {
  it('halves the base budgets of the codex and the story so far', () => {
    const compact = assemble({ ...CONTINUE, compact: true }, buildApp());
    expect(layer(compact, 'L2').baseBudget).toBe(500);
    expect(layer(compact, 'L4').baseBudget).toBe(1_000);
    expect(layer(compact, 'L3').baseBudget).toBe(1_200);
    expect(layer(compact, 'L5').baseBudget).toBe(2_000);
  });

  it('halves the expanded continuity budgets too', () => {
    const compact = assemble({ ...TASKS['continuity.scan'], compact: true }, buildApp());
    expect(layer(compact, 'L2').baseBudget).toBe(1_250);
    expect(layer(compact, 'L4').baseBudget).toBe(3_000);
  });
});

describe('a config override replaces a capped layer budget (D3)', () => {
  it('uses the override, and ignores it for a layer the tool does not assemble', () => {
    const assembled = assemble(CONTINUE, buildApp(), { layerBudgets: { L2: 77 } });
    expect(layer(assembled, 'L2').baseBudget).toBe(77);
    const meta = assemble(TASKS.meta, buildApp(), { layerBudgets: { L2: 77 } });
    expect(layer(meta, 'L2').included).toBe(false);
    expect(layer(meta, 'L2').baseBudget).toBeUndefined();
  });
});

describe('flow-up of unused budget (§3): L3 into L4, L4 into L5', () => {
  it('passes the unused part of the structure budget up to the story so far', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const structure = layer(assembled, 'L3');
    const story = layer(assembled, 'L4');
    expect(story.budget).toBe(2_000 + (1_200 - structure.tokens));
    expect(story.budget).toBeGreaterThan(story.baseBudget ?? 0);
  });

  it('passes the unused part of the story budget up to the focus', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const story = layer(assembled, 'L4');
    const focus = layer(assembled, 'L5');
    expect(focus.budget).toBe(2_000 + ((story.budget ?? 0) - story.tokens));
  });

  it('moves nothing when the layers above hold exactly their budgets', () => {
    const assembled = assemble(CONTINUE, buildApp(), { layerBudgets: { L3: 0, L4: 0 } });
    expect(layer(assembled, 'L4').budget).toBe(0);
    expect(layer(assembled, 'L5').budget).toBe(2_000);
  });

  it('flows past a layer the tool does not assemble: synopsis.fill passes the structure budget to the document', () => {
    const assembled = assemble(TASKS['synopsis.fill'], buildApp());
    const structure = layer(assembled, 'L3');
    expect(layer(assembled, 'L5').budget).toBe(25_000 + (1_200 - structure.tokens));
  });

  it('does not flow budget into a layer it does not take part in', () => {
    const assembled = assemble(CONTINUE, buildApp());
    // L2 and L6 take no flow-up: their budgets are their base budgets.
    expect(layer(assembled, 'L2').budget).toBe(1_000);
    expect(layer(assembled, 'L6').budget).toBe(1_500);
  });

  it('keeps the continuation tail at its nominal length by default, whatever the layers above leave unused', () => {
    const grown = assemble({ ...CONTINUE, focus: LONG_FOCUS }, longApp(33_488));
    expect(layer(grown, 'L5').budget).toBeGreaterThan(2_000);
    expect(grown.focus?.chars).toBe(DEFAULT_CONTINUATION_CHARS);
  });

  it('lets the continuation tail grow into the unused story budget when focusFlowUp is on', () => {
    const task: AgentTask = { ...CONTINUE, focus: LONG_FOCUS };
    const app = longApp(33_488);
    const grown = assemble(task, app, { focusFlowUp: true });
    const held = assemble(task, app, { focusFlowUp: true, layerBudgets: { L3: 0, L4: 0 } });
    expect(layer(grown, 'L5').tokens).toBeGreaterThan(layer(held, 'L5').tokens);
    expect(held.focus?.chars).toBe(DEFAULT_CONTINUATION_CHARS);
  });
});

describe('every capped layer holds its budget (§2)', () => {
  const configs: readonly { readonly name: string; readonly config: ContextConfig; readonly compact: boolean }[] = [
    { name: 'the defaults', config: {}, compact: false },
    { name: 'compact', config: {}, compact: true },
    {
      name: 'tiny budgets',
      config: { layerBudgets: { L2: 40, L3: 40, L4: 40, L5: 120, L6: 30 } },
      compact: false,
    },
  ];

  for (const { name, config, compact } of configs) {
    it(`under ${name}: no capped layer except L1 is over its budget`, () => {
      for (const tool of Object.keys(TASKS) as AssemblyTool[]) {
        const assembled = assemble({ ...TASKS[tool], compact }, appFor(tool), config);
        for (const report of assembled.layers) {
          if (!report.included || report.budget === undefined || report.id === 'L1') continue;
          expect(report.tokens, `${tool} ${report.id}`).toBeLessThanOrEqual(report.budget);
        }
      }
    });
  }
});

describe('the scope limit (agent-harness row 10)', () => {
  it('sends the first twenty documents of the scope and names the rest as dropped', () => {
    const { app, ids } = scopeApp(22);
    const assembled = assemble({ tool: 'continuity.scan', instruction: 'Find drift.', scope: ids }, app);
    const focus = layer(assembled, 'L5');
    expect(focus.kept.map((item) => item.label)).toHaveLength(SCOPE_DOCUMENT_LIMIT);
    expect(focus.drops.map((drop) => drop.label)).toEqual(['Part 21', 'Part 22']);
    expect(focus.drops.map((drop) => drop.reason)).toEqual([
      { kind: 'scope-limit', limit: SCOPE_DOCUMENT_LIMIT },
      { kind: 'scope-limit', limit: SCOPE_DOCUMENT_LIMIT },
    ]);
    expect(focus.drops[0]?.text).toBe('beyond the 20-document scope limit; split the scope');
    expect(focus.notes).toEqual([
      'The scope holds 22 documents; the first 20 are sent. Split the scope to cover the rest.',
    ]);
  });

  it('sends the synopses of the documents past the window in the story so far, so a long scope is not blind past twenty', () => {
    const { app } = scopeApp(25);
    const assembled = assemble({ tool: 'continuity.scan', instruction: 'Find drift.' }, app);
    expect(assembled.focus).toBeUndefined();
    const story = layer(assembled, 'L4');
    expect(story.included).toBe(true);
    expect(story.kept.map((item) => item.label)).toEqual(['Part 21', 'Part 22', 'Part 23', 'Part 24', 'Part 25']);
    expect(story.kept.every((item) => item.reason === 'scope document past the tail window; synopsis only')).toBe(true);
    expect(story.tokens).toBeLessThanOrEqual(story.budget ?? 0);
    const text = assembled.messages[1]?.content ?? '';
    expect(text).toContain('## Part 21 (document)\nSynopsis 21.');
    expect(text).not.toContain('Text of part 21.');
  });

  it('sends no synopses for a scope that fits the window and starts at the first manuscript document', () => {
    const { app, ids } = scopeApp(20);
    const story = layer(assemble({ tool: 'continuity.scan', instruction: 'Find drift.', scope: ids }, app), 'L4');
    expect(story.kept).toEqual([]);
    expect(story.notes).toEqual([]);
  });

  it('takes the story leading into a scope that starts later in the manuscript', () => {
    const { app, ids } = scopeApp(25);
    const second = ids.slice(5);
    const story = layer(assemble({ tool: 'continuity.scan', instruction: 'Find drift.', scope: second }, app), 'L4');
    expect(story.kept.map((item) => item.label)).toEqual(['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5']);
    expect(story.kept.every((item) => item.reason === 'earlier scene')).toBe(true);
  });

  it('puts the story leading into the scope before the synopses past its window, both in manuscript order', () => {
    // Thirty documents, and a scope of the last twenty-five (Parts 6 to 30). Its first twenty, Parts 6
    // to 25, are the window; Parts 26 to 30 are past it. Parts 1 to 5 lead into the scope.
    const { app, ids } = scopeApp(30);
    const story = layer(assemble({ tool: 'continuity.scan', instruction: 'Find drift.', scope: ids.slice(5) }, app), 'L4');
    expect(story.kept.map((item) => item.label)).toEqual([
      'Part 1',
      'Part 2',
      'Part 3',
      'Part 4',
      'Part 5',
      'Part 26',
      'Part 27',
      'Part 28',
      'Part 29',
      'Part 30',
    ]);
  });
});

describe('the codex reservation in the preview (context-assembly A3, §5)', () => {
  it('names the overflow in the codex drop list when the always entries do not fit, not a bare budget cut', () => {
    const preview = buildPreview(assemble(CONTINUE, heavyAlwaysApp(4, 1_200)));
    const overflow = preview.codex.dropped.filter((drop) => drop.reason.startsWith("the codex's always entries need"));
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.reason).toMatch(/^the codex's always entries need [\d,]+ tokens; the layer's budget is 1,000$/);
    expect(preview.codex.dropped.filter((drop) => /^dropped budget/.test(drop.reason)).map((drop) => drop.name)).toEqual([
      'Captain Hale',
      'Elena',
      'Mara',
    ]);
    const layerPreview = preview.layers.find((candidate) => candidate.id === 'L2');
    expect(layerPreview?.notes).toHaveLength(1);
    expect(layerPreview?.drops.some((drop) => drop.reason.kind === 'reserve-overflow')).toBe(true);
  });

  it('holds the continuity scan to its 2,500-token codex budget the same way', () => {
    const assembled = assemble(TASKS['continuity.scan'], heavyAlwaysApp(9, 1_200));
    const codex = layer(assembled, 'L2');
    expect(codex.baseBudget).toBe(2_500);
    expect(codex.drops.filter((drop) => drop.reason.kind === 'reserve-overflow')).toHaveLength(1);
  });
});
