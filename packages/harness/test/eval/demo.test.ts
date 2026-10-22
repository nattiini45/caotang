/**
 * The three zero-key demo intents of context-assembly.md §6, run end to end on the mock provider.
 * Each is a full turn through the real loop, the real bus and the real gateway path: the intent,
 * the model's scripted replies, the cards the user decides, the project's final state, and the
 * tokens the turn spent. A demo that passes here is one the first-run wizard can show with no key.
 */

import { describe, expect, it } from 'vitest';

import { LLM_CATEGORIES, extractionPrompt, verificationPrompt, type PairBlock } from '@caotang/coherence';
import { DEMO_INTENTS, DRAFT_PREFIX, EXTRACTOR_PREFIX, VERIFIER_PREFIX, createMockProvider, demoScripts } from '@caotang/gateway/mock';
import type { ProjectState } from '@caotang/store';

import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { FRIEND, LANDING, STORM, makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';

const demo = (name: string, scenario: Omit<Scenario, 'gateway' | 'category' | 'name'>): Scenario => ({
  ...scenario,
  name,
  category: 'demo',
  gateway: () => mockGateway(demoScripts),
});

/**
 * What a reader of the project sees: every body, with its revision, and every binder node's words.
 * Not `snapshotOf`, because a fresh project mints a fresh project id, and a comparison across two
 * projects must not depend on it.
 */
function contentOf(state: ProjectState): string {
  return JSON.stringify({
    bodies: [...state.documents.entries()].map(([id, record]) => [id, record.body, record.revision]),
    nodes: state.manifest.tree.map((node) => [node.id, node.title, node.synopsis, node.status, node.label, node.keywords, node.notes]),
  });
}

describe('the zero-key demo intents, end to end', () => {
  it('drafts the opening scene of The Friend behind one confirm card, and the draft is in the document', async () => {
    const scenario = demo('demo: draft a scene', {
      intent: DEMO_INTENTS.draftScene,
      project: makeState,
      expect: {
        status: 'applied',
        summaryIncludes: ['The Friend'],
        cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
        trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok', params: { doc: 'The Friend', mode: 'draft' } }] },
        requests: [
          // The drafting call carries the brief and the codex entry the brief mentions (codex.md §4–§6).
          { system: DRAFT_PREFIX, includes: ['Brief: The friend arrives by boat', '## Elena (character)'] },
        ],
        // Two model calls: the planner (which carries every callable, wired tool's schema) and the drafter. The ceiling
        // holds that budget. The planner sees the description and schema of every callable, wired tool on each request, so
        // the wired set is what the ceiling tracks, not prompt bloat: codex.import, coherence.scan and
        // coherence.setFindingStatus; scene.draft's include_forward_outline param (one boolean costs 54 tokens there);
        // shots.derive, prompt.draft and prompt.variant (about 750 tokens); dialogue.draft wired to the agent ports (about
        // 350 tokens); export.compile's description and recipeName parameter; and codex.write's `visualRefs`. Measured at
        // 8314 with all of them, so 8400.
        maxTokens: 8400,
        maxModelCalls: 2,
        state: (state) => {
          const body = state.documents.get(FRIEND)?.body ?? '';
          return body.startsWith('The ferry came in on the evening tide') ? [] : [`The Friend should hold the draft, but its body is ${JSON.stringify(body.slice(0, 40))}`];
        },
      },
    });
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    expect(result.run.report.undoGroupId).toBeDefined();
  });

  it('fills the synopses of Chapter 1 behind one batched card, and reports each change', async () => {
    const scenario = demo('demo: fill synopses', {
      intent: DEMO_INTENTS.fillSynopses,
      project: makeState,
      expect: {
        status: 'applied',
        cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['synopsis.fill'], decision: 'approved' }] },
        trace: { matcher: 'strict', calls: [{ tool: 'synopsis.fill', outcome: 'ok' }] },
        requests: [
          { system: DRAFT_PREFIX, includes: ['Document "The Landing":'] },
          { system: DRAFT_PREFIX, includes: ['Document "The Storm":'] },
        ],
        state: (state) => {
          const landing = state.manifest.tree.find((node) => node.id === LANDING)?.synopsis ?? '';
          const storm = state.manifest.tree.find((node) => node.id === STORM)?.synopsis ?? '';
          const failures: string[] = [];
          if (!landing.startsWith('Elena comes back')) failures.push(`The Landing synopsis is ${JSON.stringify(landing)}`);
          if (!storm.startsWith('A storm takes the lamp')) failures.push(`The Storm synopsis is ${JSON.stringify(storm)}`);
          return failures;
        },
      },
    });
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
  });

  it('checks the manuscript for continuity problems as a read: no card, the findings in the reply and in the Findings inbox, and nothing written', async () => {
    const before = contentOf(makeState());
    let inbox = -1;
    const scenario = demo('demo: continuity check', {
      intent: DEMO_INTENTS.continuity,
      project: makeState,
      expect: {
        status: 'replied',
        cards: { matcher: 'strict', items: [] },
        trace: { matcher: 'strict', calls: [{ tool: 'coherence.scan', outcome: 'ok' }] },
        // The demo's scripted turn names the deferred row directly: the preflight checks it as it checks any step.
        reached: { 'coherence.scan': 'preflight' },
        maxModelCalls: 3,
        state: (state) => {
          inbox = state.coherence?.findings.length ?? 0;
          return contentOf(state) === before ? [] : ['a read changed the project'];
        },
      },
    });
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    // The reply counts what the scan put in the inbox, so the two agree: the scan's findings are the ones the writer reads.
    expect(inbox).toBeGreaterThan(0);
    expect(result.run.report.text).toContain(`Found ${inbox} continuity ${inbox === 1 ? 'finding' : 'findings'}`);
  });

  it('reviews the manuscript for contradictions with the model review: its card, approved, puts the contradiction in the inbox, and the text is left alone', async () => {
    const before = contentOf(makeState());
    let inbox = -1;
    const scenario = demo('demo: model review', {
      intent: DEMO_INTENTS.review,
      project: makeState,
      coherence: true,
      expect: {
        status: 'applied',
        cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['coherence.review'], decision: 'approved' }] },
        trace: { matcher: 'strict', calls: [{ tool: 'coherence.review', outcome: 'ok' }] },
        reached: { 'coherence.review': 'preflight' },
        maxModelCalls: 2,
        state: (state) => {
          inbox = state.coherence?.findings.length ?? 0;
          return contentOf(state) === before ? [] : ['the review changed the text, which it must never do'];
        },
      },
    });
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    // The review's one contradiction is in the inbox, where the Findings tab shows it.
    expect(inbox).toBe(1);
  });

  it('the review’s prompts the demo answers are the coherence module’s own, so the scripts and the prompts cannot drift apart', async () => {
    // The demo scripts read the markers in each user message, so the prompts are sent through them, and the replies must come back.
    const provider = createMockProvider({ scripts: [...demoScripts] });
    const extraction = extractionPrompt({ docId: STORM, title: 'The Storm', body: 'Rain.\n\n***\n\nThe lamp failed.', categories: LLM_CATEGORIES, codex: '', storySoFar: '' });
    expect(extraction.system.startsWith(EXTRACTOR_PREFIX)).toBe(true);
    expect(extraction.user).toContain(`Focus document "The Storm" (docId: ${STORM}):\n--- BEGIN DOCUMENT ---\nRain.`);
    const extracted = await provider.completeOnce({
      messages: [
        { role: 'system', content: extraction.system },
        { role: 'user', content: extraction.user },
      ],
    });
    const spans = (JSON.parse(extracted.content) as { spans: { docId: string; quote: string }[] }).spans;
    expect(spans, 'the extraction script read the focus document from its markers').toHaveLength(1);
    expect(spans[0]?.docId).toBe(STORM);

    const pair: PairBlock = {
      pairId: 'p1',
      category: 'timeline-plot',
      a: { docId: STORM, from: 20, to: 35, quote: 'The lamp failed.', before: 'Rain.\n\n***\n\n', after: '' },
      b: { docId: FRIEND, from: 0, to: 4, quote: 'Rain', before: '', after: '.' },
    };
    const verification = verificationPrompt([pair]);
    expect(verification.system.startsWith(VERIFIER_PREFIX)).toBe(true);
    expect(verification.user).toContain('[pair p1] category: timeline-plot');
    const judged = await provider.completeOnce({
      messages: [
        { role: 'system', content: verification.system },
        { role: 'user', content: verification.user },
      ],
    });
    const verdicts = (JSON.parse(judged.content) as { verdicts: { pairId: string; verdict: string }[] }).verdicts;
    expect(verdicts.map((verdict) => verdict.pairId), 'the verification script read the [pair] blocks').toEqual(['p1']);
  });
});
