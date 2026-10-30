/**
 * The byte-stable golden prompts (context-assembly §4; the requirement is that
 * assembled-prompt fixtures stay byte-stable). Each case assembles one call on the fixture project and compares the
 * result, byte for byte, with the committed file under `test/golden/`.
 *
 * A golden changes only on purpose. Set `CAOTANG_UPDATE_GOLDEN=1` to rewrite them, then read the
 * diff: a golden change is a change to what the model is sent, and it should be reviewed as one.
 *
 * The goldens are Markdown, not `.txt`. `.gitattributes` pins `.md` to LF on every platform, so
 * the bytes are the same on a Windows checkout with `autocrlf` and on Linux.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assemble, type AgentTask, type AssembledPrompt, type ContextConfig } from '../src/index.js';
import { FOCUS_ID, IDS, buildApp, selectionOfFocus, withInstructions } from './fixtures.js';

const GOLDEN_DIR = resolve(__dirname, 'golden');
const UPDATE = process.env['CAOTANG_UPDATE_GOLDEN'] === '1';

interface GoldenCase {
  readonly name: string;
  readonly describe: string;
  readonly task: AgentTask;
  readonly config?: ContextConfig;
  /** The project carries CAOTANG.md and a memory index (layer LI). */
  readonly instructions?: boolean;
}

const appOf = (c: GoldenCase, shuffled = false) => (c.instructions === true ? withInstructions(buildApp({ shuffled })) : buildApp({ shuffled }));

const CASES: readonly GoldenCase[] = [
  {
    name: 'scene-continue',
    describe: 'scene.draft, continue, the focus chapter after two earlier ones',
    task: {
      tool: 'scene.draft',
      instruction: 'Write the next scene: Elena argues with Captain Hale about the lighthouse light.',
      mode: 'continue',
      focus: FOCUS_ID,
      params: { doc: FOCUS_ID, mode: 'continue', target_words: 900 },
    },
  },
  {
    name: 'scene-draft-empty',
    describe: 'scene.draft, draft, an empty focus: the synopsis and notes stand in',
    task: { tool: 'scene.draft', instruction: 'Draft the storm chapter.', mode: 'draft', focus: IDS.ch4 },
  },
  {
    name: 'scene-rewrite',
    describe: 'scene.draft, rewrite_selection, with the selection in the middle of the chapter',
    task: {
      tool: 'scene.draft',
      instruction: 'Rewrite this line more tersely.',
      mode: 'rewrite_selection',
      focus: FOCUS_ID,
      selection: selectionOfFocus(),
    },
  },
  {
    name: 'scene-continue-forward',
    describe: 'scene.draft, continue, with the forward outline asked for',
    task: {
      tool: 'scene.draft',
      instruction: 'Write the next scene and set up the storm.',
      mode: 'continue',
      focus: FOCUS_ID,
      includeForwardOutline: true,
      params: { doc: FOCUS_ID, mode: 'continue' },
    },
  },
  {
    name: 'scene-continue-tiny-codex',
    describe: 'scene.draft, continue, the codex held to thirty tokens: the drop list is the golden',
    task: {
      tool: 'scene.draft',
      instruction: 'Write the next scene: Elena argues with Captain Hale about the lighthouse light.',
      mode: 'continue',
      focus: FOCUS_ID,
      params: { doc: FOCUS_ID, mode: 'continue' },
    },
    config: { layerBudgets: { L2: 30 } },
  },
  {
    name: 'scene-continue-always-overflow',
    describe: 'scene.draft, continue, the codex held to ten tokens, which the always entry alone exceeds: it is sent whole',
    task: {
      tool: 'scene.draft',
      instruction: 'Write the next scene: Elena argues with Captain Hale about the lighthouse light.',
      mode: 'continue',
      focus: FOCUS_ID,
      params: { doc: FOCUS_ID, mode: 'continue' },
    },
    config: { layerBudgets: { L2: 10 } },
  },
  {
    name: 'synopsis-fill',
    describe: 'synopsis.fill, the whole focus document, structure, no codex',
    task: { tool: 'synopsis.fill', instruction: 'Write a synopsis of this chapter in one paragraph.', focus: FOCUS_ID },
  },
  {
    name: 'continuity-scan',
    describe: 'continuity.scan over Act I, every document of the scope in order',
    task: {
      tool: 'continuity.scan',
      instruction: 'Find continuity drift between these chapters.',
      scope: [IDS.ch1, IDS.ch2, IDS.ch3],
    },
  },
  {
    name: 'meta',
    describe: 'a metadata tool: system, project summary and task only',
    task: { tool: 'meta', instruction: 'Summarise the project in two sentences.' },
  },
  {
    name: 'scene-continue-instructions',
    describe: 'scene.draft, continue, with CAOTANG.md and a memory index: layer LI sits between the system prompt and the project summary',
    instructions: true,
    task: {
      tool: 'scene.draft',
      instruction: 'Write the next scene: Elena argues with Captain Hale about the lighthouse light.',
      mode: 'continue',
      focus: FOCUS_ID,
      params: { doc: FOCUS_ID, mode: 'continue', target_words: 900 },
    },
  },
  {
    name: 'scene-continue-instructions-capped',
    describe: 'scene.draft, continue, LI held to ninety tokens: whole lines up to the cap, and the drop and the note say how much was sent',
    instructions: true,
    config: { layerBudgets: { LI: 90 } },
    task: {
      tool: 'scene.draft',
      instruction: 'Write the next scene.',
      mode: 'continue',
      focus: FOCUS_ID,
      params: { doc: FOCUS_ID, mode: 'continue' },
    },
  },
  {
    name: 'meta-instructions',
    describe: 'a metadata tool on a project with instructions: LI is in the metadata profile too',
    instructions: true,
    task: { tool: 'meta', instruction: 'Summarise the project in two sentences.' },
  },
];

/** The golden file: a summary of the report, then the two messages, each in a fenced block. */
function renderGolden(c: GoldenCase, assembled: AssembledPrompt): string {
  const rows = assembled.layers.map(
    (layer) =>
      `| ${layer.id} | ${layer.included ? 'yes' : 'no'} | ${layer.baseBudget ?? '-'} | ${layer.budget ?? '-'} | ${layer.tokens} | ${layer.kept.length} | ${layer.dropped.length} |`,
  );
  return [
    `# Golden prompt: ${c.name}`,
    '',
    c.describe + '.',
    '',
    `Prompt: ${assembled.estimate.promptTokens} tokens against a total budget of ${assembled.totalBudget}; over budget: ${assembled.overBudget ? 'yes' : 'no'}.`,
    '',
    `User parts: ${assembled.parts.map((part) => `${part.layer}${part.cacheBoundary === true ? ' (cache boundary)' : ''}`).join(', ')}.`,
    '',
    '| layer | included | base | budget | tokens | kept | dropped |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## System message',
    '',
    '```text',
    assembled.messages[0]?.content ?? '',
    '```',
    '',
    '## User message',
    '',
    '```text',
    assembled.messages[1]?.content ?? '',
    '```',
    '',
  ].join('\n');
}

describe('the golden prompts', () => {
  for (const golden of CASES) {
    it(`${golden.name} matches its committed golden, byte for byte`, () => {
      const path = resolve(GOLDEN_DIR, `${golden.name}.md`);
      const actual = renderGolden(golden, assemble(golden.task, appOf(golden), golden.config));
      if (UPDATE) writeFileSync(path, actual);
      expect(existsSync(path), `missing golden ${path}: run with CAOTANG_UPDATE_GOLDEN=1`).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(actual);
    });

    it(`${golden.name} is the same golden whatever order the fixture was built in`, () => {
      const path = resolve(GOLDEN_DIR, `${golden.name}.md`);
      const shuffled = renderGolden(golden, assemble(golden.task, appOf(golden, true), golden.config));
      expect(shuffled).toBe(renderGolden(golden, assemble(golden.task, appOf(golden), golden.config)));
      if (existsSync(path)) expect(readFileSync(path, 'utf8')).toBe(shuffled);
    });
  }
});
