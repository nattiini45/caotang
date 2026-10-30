/**
 * The cache-stable split of the user message (context-assembly §2, "Cache boundary"; §5, "Cache forecast"; issue #86).
 *
 * The user message is one part per layer, then a trailing Status part with L1's volatile lines. The last of LI, L1 and L2 the
 * call includes is marked as the cache boundary, and typing in the focus document leaves every byte before it unchanged.
 */

import { setBody } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { assemble, buildPreview, toChatMessages, type AgentTask, type AppSnapshot, type ContextConfig } from '../src/index.js';
import { CH3, FOCUS_ID, buildApp } from './fixtures.js';

const CONTINUE: AgentTask = { tool: 'scene.draft', instruction: 'Continue the scene.', focus: FOCUS_ID, mode: 'continue' };
const META: AgentTask = { tool: 'meta', instruction: 'Summarise the project.' };

/** The system message and the user parts through the boundary: the bytes a provider can reuse. */
function prefixOf(task: AgentTask, app: AppSnapshot): string {
  const assembled = assemble(task, app);
  const parts = assembled.messages[1]?.parts ?? [];
  const at = parts.findIndex((part) => part.cacheBoundary === true);
  expect(at).toBeGreaterThanOrEqual(0);
  return [assembled.messages[0]?.content ?? '', ...parts.slice(0, at + 1).map((part) => part.text)].join('\u0000');
}

describe('the user message as parts', () => {
  it('joins its parts to its content, one part per layer, with the Status part last', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const user = assembled.messages[1];
    expect(user?.parts?.map((part) => part.text).join('\n\n')).toBe(user?.content);
    expect(assembled.parts.map((part) => part.layer)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'status']);
    const status = assembled.parts.at(-1)?.text ?? '';
    expect(status).toMatch(/^# Status\nDocuments: \d+\. Words: [\d,]+\.\nSession: 412 words today, target 1,000\.$/);
    // The volatile lines are no longer in L1.
    expect(assembled.parts[0]?.text).not.toMatch(/Words:|Session:/);
  });

  it('marks the boundary after L2 on a draft call and after L1 on a meta call (the planner)', () => {
    expect(assemble(CONTINUE, buildApp()).parts.filter((part) => part.cacheBoundary === true).map((part) => part.layer)).toEqual(['L2']);
    expect(assemble(META, buildApp()).parts.filter((part) => part.cacheBoundary === true).map((part) => part.layer)).toEqual(['L1']);
    expect(assemble({ tool: 'synopsis.fill', instruction: 'x', focus: FOCUS_ID }, buildApp()).parts.find((part) => part.cacheBoundary)?.layer).toBe('L1');
  });

  it('carries the parts through toChatMessages', () => {
    const assembled = assemble(META, buildApp());
    expect(toChatMessages(assembled)[1]?.parts).toEqual(assembled.messages[1]?.parts);
  });
});

describe('typing in the focus document between two turns', () => {
  it('leaves the bytes before the boundary unchanged, while the word count after it moves', () => {
    const before = buildApp();
    const after = buildApp();
    // Words the codex does not know: new prose with no mention in it.
    setBody(after.state, FOCUS_ID, `${CH3}\n\nThe kettle ticked as it cooled, and nobody spoke for a while.`);
    for (const task of [CONTINUE, META]) {
      expect(prefixOf(task, after)).toBe(prefixOf(task, before));
      expect(assemble(task, after).messages[1]?.content).not.toBe(assemble(task, before).messages[1]?.content);
    }
  });

  it('also keeps the prefix when only today\'s words change', () => {
    const app = buildApp();
    const later: AppSnapshot = { ...app, session: { todayWords: 999, target: 1_000 } };
    expect(prefixOf(META, later)).toBe(prefixOf(META, app));
  });
});

describe('the cache forecast in the preview', () => {
  const priced = (cache?: NonNullable<ContextConfig['model']>['cache']): ContextConfig => ({
    model: { pricePer1k: { prompt: 0.002, completion: 0.01 }, ...(cache === undefined ? {} : { cache }) },
  });

  it('names the reusable prefix and the layers likely served from the cache', () => {
    const preview = buildPreview(assemble(CONTINUE, buildApp(), priced({ readMultiplier: 0.1, minTokens: 0 })));
    expect(preview.cache?.readMultiplier).toBe(0.1);
    expect(preview.cache?.prefixTokens).toBeGreaterThan(0);
    expect(preview.layers.filter((layer) => layer.likelyCached === true).map((layer) => layer.id)).toEqual(['L0', 'L1', 'L2']);
    // A single call writes its prefix: it is priced in full.
    expect(preview.cost?.cachedTokens).toBeUndefined();
  });

  it('says nothing when the model has no priced cache, or the prefix is under its minimum', () => {
    expect(buildPreview(assemble(CONTINUE, buildApp(), priced())).cache).toBeUndefined();
    const small = buildPreview(assemble(CONTINUE, buildApp(), priced({ readMultiplier: 0.1, minTokens: 1_000_000 })));
    expect(small.cache).toBeUndefined();
    expect(small.layers.some((layer) => layer.likelyCached === true)).toBe(false);
  });
});
