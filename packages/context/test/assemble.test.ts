/**
 * `assemble` as a whole (context-assembly §4): it is pure, it refuses contract violations
 * and does not refuse empty fields, its report covers every layer, and the focus report
 * says what text was sent.
 */
import { describe, expect, it } from 'vitest';

import {
  ANTECEDENT_CHARS,
  ContextError,
  DEFAULT_CONTINUATION_CHARS,
  LAYER_IDS,
  assemble,
  toChatMessages,
  type AgentTask,
  type AssembledPrompt,
  type ContextConfig,
  type LayerId,
} from '../src/index.js';
import { formatCount } from '../src/text.js';
import {
  CH3,
  FOCUS_ID,
  IDS,
  LONG_FOCUS,
  TAIL,
  buildApp,
  longApp,
  longChapter,
  selectionOfFocus,
} from './fixtures.js';
import { textOf } from '@caotang/gateway';

const CONTINUE: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene: Elena argues with Captain Hale about the lighthouse light.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

function layer(assembled: AssembledPrompt, id: LayerId) {
  const report = assembled.layers.find((candidate) => candidate.id === id);
  if (report === undefined) throw new Error(`no ${id} report`);
  return report;
}

function codeOf(run: () => unknown): string | 'no error' {
  try {
    run();
    return 'no error';
  } catch (error) {
    return error instanceof ContextError ? error.code : 'not a ContextError';
  }
}

describe('purity and determinism (§4)', () => {
  it('gives the same result for the same inputs, every time', () => {
    const first = assemble(CONTINUE, buildApp());
    const second = assemble(CONTINUE, buildApp());
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not change the app state it reads', () => {
    const app = buildApp();
    const before = JSON.stringify(app.state.manifest);
    assemble(CONTINUE, app);
    expect(JSON.stringify(app.state.manifest)).toBe(before);
  });

  it('gives the same bytes whatever order the app built its tree and codex in', () => {
    const forward = assemble(CONTINUE, buildApp());
    const shuffled = assemble(CONTINUE, buildApp({ shuffled: true }));
    expect(shuffled.messages).toEqual(forward.messages);
    expect(shuffled.layers).toEqual(forward.layers);
  });

  it('hands out copies of the messages, so a caller cannot change the assembly it sends', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const copy = toChatMessages(assembled);
    copy[1] = { role: 'user', content: 'changed' };
    expect(assembled.messages[1]?.content).not.toBe('changed');
  });
});

describe('the refusals (§1): contract violations throw, empty fields do not', () => {
  const app = buildApp();

  it('refuses a scene without a focus', () => {
    expect(codeOf(() => assemble({ tool: 'scene.draft', instruction: 'x', mode: 'draft' }, app))).toBe('missing-focus');
    expect(codeOf(() => assemble({ tool: 'synopsis.fill', instruction: 'x' }, app))).toBe('missing-focus');
  });

  it('refuses a focus that is not a node in the project', () => {
    expect(codeOf(() => assemble({ ...CONTINUE, focus: 'n_nowhere' }, app))).toBe('unknown-focus');
  });

  it('refuses a focus that is a folder, not a document', () => {
    expect(codeOf(() => assemble({ ...CONTINUE, focus: IDS.act1 }, app))).toBe('focus-not-document');
  });

  it('refuses a rewrite with no selection, or an empty one', () => {
    expect(codeOf(() => assemble({ ...CONTINUE, mode: 'rewrite_selection' }, app))).toBe('missing-selection');
    expect(
      codeOf(() => assemble({ ...CONTINUE, mode: 'rewrite_selection', selection: { from: 0, to: 0, exact: '' } }, app)),
    ).toBe('missing-selection');
  });

  it('refuses a continuity scope that names something other than a document', () => {
    expect(codeOf(() => assemble({ tool: 'continuity.scan', instruction: 'x', scope: ['n_nowhere'] }, app))).toBe(
      'unknown-scope',
    );
    expect(codeOf(() => assemble({ tool: 'continuity.scan', instruction: 'x', scope: [IDS.act1] }, app))).toBe(
      'unknown-scope',
    );
  });

  it('does not refuse a meta tool, which has no focus to need', () => {
    expect(codeOf(() => assemble({ tool: 'meta', instruction: 'x' }, app))).toBe('no error');
  });

  it('does not refuse an empty focus document; it sends the stand-in', () => {
    expect(codeOf(() => assemble({ tool: 'scene.draft', instruction: 'x', mode: 'draft', focus: IDS.ch4 }, app))).toBe(
      'no error',
    );
  });
});

describe('the report (§4)', () => {
  it('reports every layer, L0 to L7, in order', () => {
    const assembled = assemble(CONTINUE, buildApp());
    expect(assembled.layers.map((report) => report.id)).toEqual([...LAYER_IDS]);
    expect(Object.keys(assembled.estimate.byLayer)).toEqual([...LAYER_IDS]);
  });

  it('counts the prompt in the estimate the ledger uses: ceil of the characters over four', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const chars = assembled.messages.reduce((sum, message) => sum + textOf(message.content).length, 0);
    expect(assembled.estimate.promptTokens).toBe(Math.ceil(chars / 4));
  });

  it('reports the sum of its layer tokens within rounding: one token per layer at most', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const sum = Object.values(assembled.estimate.byLayer).reduce((total, tokens) => total + tokens, 0);
    expect(Math.abs(sum - assembled.estimate.promptTokens)).toBeLessThanOrEqual(LAYER_IDS.length);
  });

  it('is not over budget at the defaults, for any tool', () => {
    for (const task of [
      CONTINUE,
      { tool: 'continuity.scan', instruction: 'x', scope: [IDS.ch1, IDS.ch2, IDS.ch3] } as const,
      { tool: 'synopsis.fill', instruction: 'x', focus: FOCUS_ID } as const,
      { tool: 'meta', instruction: 'x' } as const,
    ]) {
      expect(assemble(task, buildApp()).overBudget).toBe(false);
    }
  });

  it('uses the total budget the config names, and the 12k default otherwise', () => {
    expect(assemble(CONTINUE, buildApp()).totalBudget).toBe(12_000);
    expect(assemble(CONTINUE, buildApp(), { contextBudget: 5_000 }).totalBudget).toBe(5_000);
    const continuity = assemble({ tool: 'continuity.scan', instruction: 'x', scope: [IDS.ch1] }, buildApp());
    expect(continuity.totalBudget).toBe(33_000);
  });

  it('copies the model limits, so the preview needs nothing else', () => {
    const config: ContextConfig = { model: { contextWindow: 8_000, maxOutputTokens: 1_000 } };
    expect(assemble(CONTINUE, buildApp(), config).model).toEqual({ contextWindow: 8_000, maxOutputTokens: 1_000 });
    expect(assemble(CONTINUE, buildApp()).model).toEqual({});
  });
});

describe('the focus report (§5)', () => {
  it('continue: the last 3,000 characters that were sent, their length and their opening', () => {
    const focus = assemble(CONTINUE, buildApp()).focus;
    expect(focus?.mode).toBe('continue');
    expect(focus?.title).toBe('Chapter 3');
    expect(focus?.chars).toBe(DEFAULT_CONTINUATION_CHARS);
    expect(focus?.documentChars).toBe(CH3.length);
    expect(focus?.head).toBe(TAIL.slice(0, 120));
  });

  it('continue: a long chapter sends 3,000 characters, though the layers above pass budget up', () => {
    const assembled = assemble({ ...CONTINUE, focus: LONG_FOCUS }, longApp(33_488));
    expect(layer(assembled, 'L5').budget).toBeGreaterThan(2_000);
    expect(assembled.focus?.chars).toBe(DEFAULT_CONTINUATION_CHARS);
    expect(assembled.focus?.documentChars).toBe(33_488);
  });

  it('continue: with focusFlowUp, the tail takes four characters per token passed up, up to the body', () => {
    const assembled = assemble({ ...CONTINUE, focus: LONG_FOCUS }, longApp(33_488), { focusFlowUp: true });
    const carry = (layer(assembled, 'L5').budget ?? 0) - 2_000;
    expect(assembled.focus?.chars).toBe(Math.min(33_488, DEFAULT_CONTINUATION_CHARS + 4 * carry));
    expect(assembled.focus?.chars).toBeGreaterThan(DEFAULT_CONTINUATION_CHARS);
  });

  it('draft: no document text sent, and the stand-in named', () => {
    const focus = assemble({ tool: 'scene.draft', instruction: 'x', mode: 'draft', focus: IDS.ch4 }, buildApp()).focus;
    expect(focus).toMatchObject({ mode: 'draft', chars: 0, head: '', documentChars: 0 });
  });

  it('rewrite_selection: the selection, and the 1,500 characters before it', () => {
    const selection = selectionOfFocus();
    const focus = assemble({ ...CONTINUE, mode: 'rewrite_selection', selection }, buildApp()).focus;
    expect(focus?.mode).toBe('rewrite_selection');
    expect(focus?.chars).toBe(ANTECEDENT_CHARS + selection.exact.length);
    expect(focus?.head).toBe(CH3.slice(selection.from - ANTECEDENT_CHARS, selection.from - ANTECEDENT_CHARS + 120));
  });

  it('rewrite_selection, with focusFlowUp: the antecedent takes the flowed-in budget, up to the whole text before it', () => {
    const selection = { from: 29_290, to: 29_310, exact: longChapter(33_488).slice(29_290, 29_310) };
    const assembled = assemble(
      { ...CONTINUE, focus: LONG_FOCUS, mode: 'rewrite_selection', selection },
      longApp(33_488),
      { focusFlowUp: true },
    );
    const carry = (layer(assembled, 'L5').budget ?? 0) - 2_000;
    expect(assembled.focus?.chars).toBe(Math.min(selection.from, ANTECEDENT_CHARS + 4 * carry) + selection.exact.length);
  });

  it('full: the whole document for synopsis.fill', () => {
    const focus = assemble({ tool: 'synopsis.fill', instruction: 'x', focus: FOCUS_ID }, buildApp()).focus;
    expect(focus).toMatchObject({ mode: 'full', chars: CH3.length });
    expect(formatCount(CH3.length)).toMatch(/^\d{1,3}(,\d{3})*$/);
  });

  it('is absent for a call with no single focus document', () => {
    expect(assemble({ tool: 'meta', instruction: 'x' }, buildApp()).focus).toBeUndefined();
    expect(
      assemble({ tool: 'continuity.scan', instruction: 'x', scope: [IDS.ch1] }, buildApp()).focus,
    ).toBeUndefined();
  });
});

describe('the result shape', () => {
  it('is a plain object a caller can hand to a log or a fixture', () => {
    const assembled: AssembledPrompt = assemble(CONTINUE, buildApp());
    const round = JSON.parse(JSON.stringify(assembled)) as AssembledPrompt;
    expect(round.messages).toEqual(assembled.messages);
    expect(round.layers.map((report) => report.id)).toEqual([...LAYER_IDS]);
  });
});
