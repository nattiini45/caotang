/**
 * The additive MessageRefs on the turn's task list (i18n.md §6.1; I7). The English lines stay what
 * the header and checklist show today; every row also carries a stable id and an English template.
 */
import { describe, expect, it } from 'vitest';

import { TASK_PHRASES, TOOL_NAMES, costLineRef, emptyTaskList, phraseFor, reduceTaskList, type AgentEvent, type PlanStepView } from '../../src/index.js';

describe('task-list message references', () => {
  it('gives every tool phrase a content and active-form reference with a stable, namespaced id', () => {
    const ids = new Set<string>();
    for (const tool of TOOL_NAMES) {
      const phrase = TASK_PHRASES[tool]({});
      expect(phrase.contentRef, tool).toBeDefined();
      expect(phrase.activeFormRef, tool).toBeDefined();
      for (const ref of [phrase.contentRef!, phrase.activeFormRef!]) {
        expect(ref.id.startsWith('harness.progress.'), `${tool}: ${ref.id}`).toBe(true);
        expect(ids.has(ref.id), `${tool}: duplicate id ${ref.id}`).toBe(false);
        ids.add(ref.id);
        expect(ref.message.trim()).not.toBe('');
        expect(ref.message).not.toContain('${');
      }
    }
  });

  it('carries the values a plan step names, through the fold into its item', () => {
    const step: PlanStepView = {
      index: 0,
      origin: 1,
      tool: 'scene.draft',
      expect: 'a draft',
      risk: 'write-confirm',
      params: { doc: 'The Landing' },
      status: 'ready',
      badges: [],
      stale: false,
      cut: false,
    };
    const event: AgentEvent = {
      type: 'plan',
      turnId: 't1',
      card: {
        id: 'c1',
        turnId: 't1',
        kind: 'plan',
        revision: 1,
        previewRevision: 1,
        from: 0,
        steps: [step],
        approvable: true,
        canAcceptCut: false,
        cut: false,
      },
    };
    const list = reduceTaskList(emptyTaskList('t1'), event);
    const item = list.items[0];
    expect(item?.contentRef).toMatchObject({ id: 'harness.progress.sceneDraft.content', values: { doc: 'The Landing' } });
    expect(item?.activeFormRef).toMatchObject({ id: 'harness.progress.sceneDraft.active' });
  });

  it('gives the plan cost line a reference whose English is the card’s sentence', () => {
    const ref = costLineRef({ promptUsd: 0.01, completionUsd: 0.02, totalUsd: 0.03, includesThinking: true });
    expect(ref?.id).toBe('harness.plan.costThinking');
    expect(ref?.values).toEqual({ total: '$0.0300', prompt: '$0.0100', reply: '$0.0200' });
    expect(ref?.message).toBe('About {total} (prompt {prompt}, reply {reply} including thinking).');
    expect(phraseFor('scene.draft', { doc: 'The Landing' }).contentRef?.values).toEqual({ doc: 'The Landing' });
  });
});
