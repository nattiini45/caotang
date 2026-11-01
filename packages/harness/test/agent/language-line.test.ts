/**
 * The language line on the request the model receives (i18n §6.1): appended to the final system message after the role
 * replaces it, measured at the gateway, pinned at the turn's start, and absent when a host pins no language.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest, Gateway } from '@caotang/gateway';

import {
  PLANNER_SYSTEM_PREFIX,
  appendLanguageLine,
  createAgentSession,
  createContextPort,
  languageDirective,
  withLanguages,
  type LanguagePolicy,
} from '../../src/index.js';
import { makeHarness, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, steps, transcript } from './scripts.js';
import { textOf } from '@caotang/gateway';

const GERMAN_UI_ENGLISH_BOOK: LanguagePolicy = { ui: 'de', project: 'en' };
const ENGLISH_UI_JAPANESE_BOOK: LanguagePolicy = { ui: 'en', project: 'ja' };

describe('the directive', () => {
  it('names both languages in English and keeps the evidence rule', () => {
    expect(languageDirective(GERMAN_UI_ENGLISH_BOOK)).toBe(
      "Write messages to the writer (plan titles, step summaries, questions, findings' explanations, notes) in German. Write manuscript, synopsis and codex text in English. Quote evidence exactly as written.",
    );
    expect(languageDirective(ENGLISH_UI_JAPANESE_BOOK)).toContain('in English. Write manuscript, synopsis and codex text in Japanese.');
  });

  it('falls back to the tag when the runtime has no name for it', () => {
    expect(languageDirective({ ui: 'not a tag', project: 'en' })).toContain('in not a tag.');
  });

  it('leaves a system message alone when no policy is pinned', () => {
    expect(appendLanguageLine('System text.', undefined)).toBe('System text.');
  });
});

describe('the assembled prompt', () => {
  it('carries the line after the role, and L0 and the estimate are measured on what is sent', () => {
    const state = makeState();
    const request = { task: { tool: 'meta' as const, instruction: 'Request: hello' }, role: `${PLANNER_SYSTEM_PREFIX} role text.` };
    const plain = createContextPort({ state: () => state }).assemble(request);
    const pinned = createContextPort({ state: () => state }).assemble({ ...request, languages: GERMAN_UI_ENGLISH_BOOK });

    const system = textOf(pinned.messages[0]?.content ?? '');
    expect(system.startsWith(`${PLANNER_SYSTEM_PREFIX} role text.`)).toBe(true);
    expect(system.endsWith(languageDirective(GERMAN_UI_ENGLISH_BOOK))).toBe(true);
    expect(pinned.messages.slice(1)).toEqual(plain.messages.slice(1));
    const l0 = (call: typeof plain) => call.prompt.layers.find((layer) => layer.id === 'L0')?.tokens ?? 0;
    expect(l0(pinned)).toBeGreaterThan(l0(plain));
    expect(pinned.prompt.estimate.promptTokens).toBeGreaterThan(plain.prompt.estimate.promptTokens);
  });

  it('is not applied to a prompt whose first message is not the system message', () => {
    const prompt = { messages: [{ role: 'user' as const, content: 'hello' }], layers: [], estimate: { promptTokens: 1, byLayer: {} } };
    expect(withLanguages(prompt as never, GERMAN_UI_ENGLISH_BOOK)).toBe(prompt);
  });
});

describe('the request at the gateway', () => {
  async function runTurns(
    policies: () => LanguagePolicy | undefined,
    intents: readonly string[],
    onPlannerCall?: (count: number) => void,
  ): Promise<{ planner: ChatRequest[][] }> {
    const state = makeState();
    const harness = makeHarness({}, state);
    const seen: ChatRequest[] = [];
    const scripts = intents.map((intent) =>
      transcript(intent, [steps({ tool: 'binder.read_tree', params: { root: 'manuscript' }, expect: 'the tree is read' }), answer('Nothing to change.')], seen),
    );
    const base = await mockGateway(scripts);
    let plannerCalls = 0;
    const gateway: Gateway = {
      ...base,
      complete: (request, signal) => {
        if (textOf(request.messages[0]?.content ?? '').startsWith(PLANNER_SYSTEM_PREFIX) === true) {
          plannerCalls += 1;
          onPlannerCall?.(plannerCalls);
        }
        return base.complete(request, signal);
      },
    };
    const planner: ChatRequest[][] = [];
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state: () => state }),
      languages: policies,
      decide: async () => ({ action: 'approve' }),
      sessionId: 'lang',
    });
    for (const intent of intents) {
      const before = seen.length;
      await session.submit(intent);
      planner.push(seen.slice(before));
    }
    return { planner };
  }

  const systemOf = (request: ChatRequest | undefined): string => textOf(request?.messages[0]?.content ?? '');

  it('sends German-UI / English-book and English-UI / Japanese-book on the planner request, and nothing else changes', async () => {
    const intent = 'List the tree.';
    const german = await runTurns(() => GERMAN_UI_ENGLISH_BOOK, [intent]);
    const japanese = await runTurns(() => ENGLISH_UI_JAPANESE_BOOK, [intent]);
    const none = await runTurns(() => undefined, [intent]);

    const baseSystem = systemOf(none.planner[0]?.[0]);
    expect(systemOf(german.planner[0]?.[0])).toBe(`${baseSystem}\n\n${languageDirective(GERMAN_UI_ENGLISH_BOOK)}`);
    expect(systemOf(japanese.planner[0]?.[0])).toBe(`${baseSystem}\n\n${languageDirective(ENGLISH_UI_JAPANESE_BOOK)}`);
    expect(none.planner[0]?.[0]?.messages.slice(1)).toEqual(german.planner[0]?.[0]?.messages.slice(1));
  });

  it('keeps the policy a turn started with when the interface language changes during it, and uses the new one on the next turn', async () => {
    let current: LanguagePolicy = GERMAN_UI_ENGLISH_BOOK;
    const first = 'List the tree once.';
    const second = 'List the tree twice.';
    const { planner } = await runTurns(
      () => current,
      [first, second],
      (count) => {
        // The writer switches the language as the first turn's second request is about to be sent.
        if (count === 2) current = ENGLISH_UI_JAPANESE_BOOK;
      },
    );
    const firstTurn = planner[0] ?? [];
    expect(firstTurn.length).toBeGreaterThanOrEqual(2);
    for (const request of firstTurn) expect(systemOf(request).endsWith(languageDirective(GERMAN_UI_ENGLISH_BOOK))).toBe(true);
    for (const request of planner[1] ?? []) expect(systemOf(request).endsWith(languageDirective(ENGLISH_UI_JAPANESE_BOOK))).toBe(true);
  });
});
