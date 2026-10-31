import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@lingui/core';
import { emptyTaskList, headerRefOf, phraseFor, TASK_PHRASES, type PlanCardView, type PlanStepView, type StatusCard, type TaskList } from '@caotang/harness';
import { delegationViewOf, draftCheckOf, formatElapsed, MODE_HINTS, newTurnView, phaseLabel, proposedByWords, reduceTurn, spendLine } from '../src/app/agent-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';
import { renderRef, WRITER_VALUE_KEYS } from '../src/i18n/render-ref.js';

beforeEach(activateEnglish);
afterEach(activateEnglish);

function step(index = 0): PlanStepView {
  return { index, origin: index, tool: 'scene.draft', expect: 'Keep this instruction.', risk: 'write-confirm', params: { doc: 'الفصل' }, status: 'ready', badges: [], stale: false, cut: false };
}

function plan(steps: readonly PlanStepView[]): PlanCardView {
  return { id: 'plan', turnId: 'turn', kind: 'plan', revision: 0, previewRevision: 0, from: 0, steps, approvable: true, canAcceptCut: false, cut: false };
}

describe('agent interface language', () => {
  it('ships every fixed and document-specific tool phrase in the real catalogue', async () => {
    await activateCatalogue('en-XA');
    for (const tool of Object.keys(TASK_PHRASES)) {
      for (const params of [{}, { doc: 'الفصل' }]) {
        const phrase = phraseFor(tool, params);
        for (const ref of [phrase.contentRef, phrase.activeFormRef]) {
          expect(ref, tool).toBeDefined();
          expect(Object.hasOwn(i18n.messages, ref!.id), ref!.id).toBe(true);
          expect(renderRef(ref!), ref!.id).toContain('⟦');
        }
      }
    }
  });

  it('translates the active phrase as well as the header frame while keeping the English task list intact', async () => {
    const phrase = phraseFor('scene.draft', { doc: 'الفصل' });
    const running: TaskList = { ...emptyTaskList('turn'), phase: 'running', items: [{ ...phrase, key: 'draft', state: 'in_progress' }] };
    const waiting: TaskList = { ...running, phase: 'awaiting-approval', track: { ...running.track, awaiting: { kind: 'confirm', steps: 1, content: phrase.content, contentRef: phrase.contentRef } } };
    const render = (ref: Parameters<typeof renderRef>[0]): string => renderRef(ref, { userValues: WRITER_VALUE_KEYS });
    await activateCatalogue('en-XA');
    for (const list of [running, waiting]) {
      const line = renderRef(headerRefOf(list, render)!);
      expect(line).not.toContain('Drafting');
      expect(line).not.toContain('Draft “');
      expect(line).toContain('\u2068الفصل\u2069');
      expect(line).not.toContain('\u2068\u2068');
    }
    expect(running.items[0]?.activeForm).toBe('Drafting “الفصل”');
    expect(waiting.track.awaiting?.content).toBe('Draft “الفصل”');
  });

  it('reformats live phase, permission hints and each budget metric without changing the turn', async () => {
    const turn = reduceTurn(newTurnView('turn', 'Keep my intent.'), {
      type: 'budget', turnId: 'turn',
      spend: { modelCalls: 2, promptTokens: 3000, completionTokens: 120, estimatedTokens: 0, steps: 1, activeMs: 83000, costUsd: 0.125 },
      limits: { maxTokens: 50000, maxCostUsd: 1, maxSteps: 5, maxActiveMs: 600000 },
    });
    const original = structuredClone(turn);
    expect(spendLine(turn.run, 'en-US')).toBe('3,120 of 50,000 tokens · $0.1250 of $1.0000 · 1 of 5 steps · 1:23 of 10:00 worked');
    await activateCatalogue('en-XA');
    for (const phase of ['started', 'planning', 'awaiting-approval', 'running', 'retrying', 'done', 'failed', 'cancelled', 'idle'] as const) expect(phaseLabel(phase)).toContain('⟦');
    for (const hint of Object.values(MODE_HINTS)) expect(hint).toContain('⟦');
    for (const metric of spendLine(turn.run, 'de-DE')!.split(' · ')) expect(metric).toContain('⟦');
    expect(spendLine(turn.run, 'de-DE')).toContain('3.120');
    expect(formatElapsed(1500)).toContain('⟦');
    expect(formatElapsed(83000)).toContain('⟦');
    expect(turn).toEqual(original);
    activateEnglish();
    expect(phaseLabel('running')).toBe('Applying');
    expect(MODE_HINTS.ask).toBe('Every plan and confirm card waits for your decision.');
  });

  it('translates delegation frames and trace references but preserves briefs, results and scope', async () => {
    const card: StatusCard = {
      id: 'call', callId: 'call', turnId: 'turn', tool: 'agent.delegate', risk: 'read', status: 'done',
      args: { brief: 'Who knows?', scope: ['الفصل'] },
      delegation: { agent: 'reader', agentPath: 'turn/reader#1', reserved: 2, outcome: 'done', proposed: 1, result: 'Writer-facing model prose.', trace: [
        { callId: 'read', agentPath: 'turn/reader#1', tool: 'doc.read', params: { doc: 'الفصل' }, outcome: 'ok' },
      ] },
    };
    const original = structuredClone(card);
    await activateCatalogue('en-XA');
    const view = delegationViewOf(card)!;
    for (const text of [view.title, view.reserved, view.standing, view.proposed, proposedByWords({ ...step(), proposedBy: 'reader' })]) expect(text).toContain('⟦');
    for (const part of view.trace[0]!.text.split(' — ')) expect(part).toContain('⟦');
    expect(view.trace[0]?.text).toContain('\u2068الفصل\u2069');
    expect(view.brief).toBe('Who knows?');
    expect(view.result).toBe('Writer-facing model prose.');
    expect(view.scope).toEqual(['الفصل']);
    expect(card).toEqual(original);
  });

  it('translates each approval barrier without changing whether a draft is safe to approve', async () => {
    await activateCatalogue('en-XA');
    const ghost = { callId: 'draft', docTitle: 'الفصل', docId: 'scene', text: 'Unchanged manuscript.', words: 2, cut: false };
    const base = { card: plan([step()]), ghosts: [ghost], sceneOf: () => ({ docId: 'scene', title: 'الفصل' }), onScreen: () => false, previewed: () => false };
    for (const args of [base, { ...base, ghosts: [] }, { ...base, sceneOf: () => null }, { ...base, card: plan([step(), step(1)]), previewed: () => true }]) {
      const check = draftCheckOf(args);
      expect(check.blocked).toContain('⟦');
      if (args.ghosts.length > 0) expect(check.blocked).toContain('\u2068الفصل\u2069');
    }
    expect(draftCheckOf({ ...base, previewed: () => true }).blocked).toBeNull();
    expect(draftCheckOf({ ...base, card: plan([{ ...step(), status: 'refused' }]), ghosts: [] }).blocked).toBeNull();
    expect(ghost.text).toBe('Unchanged manuscript.');
  });
});
