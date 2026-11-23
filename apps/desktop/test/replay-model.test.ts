/**
 * The Replay… dialog's model (agent-harness §8.1): which modes a turn is offered in and why not, which destinations are real, and how
 * the estimate, the stop and the comparison are said. The engine's own behaviour is `packages/harness/test/agent/replay.test.ts`'s;
 * this is the app's half, where a writer's words and refusals live.
 */

import { describe, expect, it } from 'vitest';

import { ReplayRefusal } from '@caotang/harness';
import type { ProfileView } from '@caotang/gateway';

import {
  defaultMode,
  destinationsOf,
  draftRows,
  estimateLine,
  headlineOf,
  modeOffers,
  refusalText,
  stepLine,
  stopText,
  tokensLine,
} from '../src/app/replay-model.js';
import { ReplaySnapshots } from '../src/app/replay-snapshots.js';
import { sampleProjectState } from '../src/app/demo.js';

function profile(over: Partial<ProfileView> & { readonly id: string }): ProfileView {
  return { name: over.id, kind: 'endpoint', baseUrl: 'https://example.test', defaultModel: 'some-model', isActive: false, hasKey: true, ...over } as ProfileView;
}

describe('the modes a turn is offered in', () => {
  it('offers all three when the turn has a kept request, a starting state and a destination', () => {
    const offers = modeOffers({ hasCall: true, hasSnapshot: true, hasDestination: true });
    expect(offers.map((offer) => [offer.mode, offer.refused === undefined])).toEqual([['call', true], ['turn', true], ['cassette', true]]);
    expect(defaultMode(offers)).toBe('call');
  });

  it('says why a turn with no starting state cannot be re-run, and offers no mode at all', () => {
    const offers = modeOffers({ hasCall: true, hasSnapshot: false, hasDestination: true });
    expect(offers.map((offer) => offer.mode)).toEqual(['call', 'turn', 'cassette']);
    for (const offer of offers) expect(offer.refused).toContain('Turn traces on');
  });

  it('offers a cassette with no provider saved, because it answers from the recording and costs nothing', () => {
    const offers = modeOffers({ hasCall: false, hasSnapshot: true, hasDestination: false });
    expect(offers[0]?.refused).toContain('no single request');
    expect(offers[1]?.refused).toContain('No provider is saved');
    expect(offers[2]?.refused).toBeUndefined();
    expect(defaultMode(offers)).toBe('cassette');
  });

  it('refuses a call replay with no provider too: it sends a request, so it needs somewhere to send it', () => {
    const offers = modeOffers({ hasCall: true, hasSnapshot: true, hasDestination: false });
    expect(offers.map((offer) => [offer.mode, offer.refused === undefined])).toEqual([['call', false], ['turn', false], ['cassette', true]]);
    expect(offers[0]?.refused).toContain('No provider is saved');
    // A call replay needs no starting state, so its own reason is the only one it gives.
    expect(offers[0]?.refused).not.toContain('Turn traces on');
  });

  it('refuses every mode without the starting state, the call mode included, because the engine checks the rules on it', () => {
    // The app always supplies the project's rules, and the engine refuses a call replay without a state to check a recorded prompt
    // against them (#819): offering one would guarantee a refusal at the end of a run the writer already paid for.
    const offers = modeOffers({ hasCall: true, hasSnapshot: false, hasDestination: true });
    expect(offers.map((offer) => [offer.mode, offer.refused === undefined])).toEqual([['call', false], ['turn', false], ['cassette', false]]);
    expect(offers[0]?.refused).toContain('Turn traces on');
  });

  it('gives a call replay its own reason when the recording kept no whole request, even with a provider saved', () => {
    const offers = modeOffers({ hasCall: false, hasSnapshot: true, hasDestination: true });
    expect(offers[0]?.refused).toContain('no single request');
    expect(offers[1]?.refused).toBeUndefined();
  });
});

describe('the destinations a replay may be sent to', () => {
  it('lists saved real profiles only, never the demo profile', () => {
    const destinations = destinationsOf([profile({ id: 'p1', name: 'OpenRouter' }), profile({ id: 'demo', name: 'Demo', kind: 'mock' }), profile({ id: 'p2', name: 'Local', defaultModel: 'llama' })]);
    expect(destinations.map((destination) => [destination.label, destination.model])).toEqual([['OpenRouter', 'some-model'], ['Local', 'llama']]);
  });

  it('takes the model the writer picked for a profile when one is given', () => {
    const destinations = destinationsOf([profile({ id: 'p1' })], () => 'picked-model');
    expect(destinations[0]?.model).toBe('picked-model');
  });
});

describe('the estimate before anything is spent', () => {
  it('names the calls, the prompt tokens, the bound and the price', () => {
    // The price is the app's own money format (plan-preview's `formatUsd`), so it reads as it does on a card.
    expect(estimateLine({ modelCalls: 3, promptTokens: 12_340, maxCompletionTokens: 24_000, costUsd: 0.0734 })).toBe(
      '3 model calls: 12,340 prompt tokens, at most 24,000 back; $0.0734.',
    );
    expect(estimateLine({ modelCalls: 1, promptTokens: 10, maxCompletionTokens: 20, costUsd: 0.00001 })).toContain('under');
  });

  it('says the cost is unknown rather than showing a zero, when the model has no price row', () => {
    expect(estimateLine({ modelCalls: 2, promptTokens: 1, maxCompletionTokens: 2 })).toContain('no price row');
  });

  it('prices a cassette at nothing, because it makes no call', () => {
    // The engine's own estimate for a cassette is zero on every count; the line says so instead of a bound and a price.
    expect(estimateLine({ modelCalls: 0, promptTokens: 0, maxCompletionTokens: 0 })).toBe('From the recording, so no model call and no cost.');
  });
});

describe('where a replay stopped', () => {
  it('says a mismatched card stopped before anything changed and quotes the engine', () => {
    const text = stopText({ reason: 'decision-mismatch', detail: 'The replay proposed scene.draft where the recording had synopsis.fill.' });
    expect(text).toContain('nobody approved the like of them');
    expect(text).toContain('scene.draft where the recording had synopsis.fill');
  });

  it('says an outside tool is never re-run', () => {
    expect(stopText({ reason: 'external-tool', detail: 'mcp__story__search is an external tool.' })).toContain('never re-runs one');
  });

  it('says a cassette miss is a prompt that no longer matches the recording', () => {
    expect(stopText({ reason: 'cassette-miss', detail: 'message 2 (user) changed.' })).toContain('did not match the recording');
  });
});

describe('the comparison', () => {
  it('reads one step as what the recording ran, what the replay ran and which params moved', () => {
    expect(stepLine({ index: 0, original: { tool: 'synopsis.fill' }, replay: { tool: 'synopsis.fill' }, changedParams: ['max_words'] })).toBe(
      'Step 1: synopsis.fill → synopsis.fill (max_words changed)',
    );
    expect(stepLine({ index: 1, original: { tool: 'meta.set' }, changedParams: [] })).toBe('Step 2: meta.set → nothing');
  });

  it('reads both sides’ tokens and the replay’s cost', () => {
    expect(
      tokensLine({
        original: { promptTokens: 1_000, completionTokens: 500, modelCalls: 1 },
        replay: { promptTokens: 2_000, completionTokens: 400, modelCalls: 2, costUsd: 0.0123 },
      }),
    ).toBe('Recording: 1,000 prompt + 500 back over 1; replay: 2,000 + 400 over 2 ($0.0123).');
  });

  it('names each draft by its title, its field and the words each side wrote', () => {
    const rows = draftRows([
      { title: 'The Storm', field: 'body', original: 'Rain.', replay: 'Rain. The lamp failed.', words: { original: 1, replay: 5 } },
      { title: 'The Storm', field: 'synopsis', original: '', replay: 'A storm.', words: { original: 0, replay: 2 } },
    ]);
    expect(rows.map((row) => [row.title, row.field, row.words])).toEqual([['The Storm', 'text', '1 → 5 words'], ['The Storm', 'synopsis', '0 → 2 words']]);
    expect(rows[1]?.original).toBe('');
  });

  it('heads a turn replay with how it ended and a call replay with the answer', () => {
    expect(headlineOf({ mode: 'cassette', report: { status: 'applied', summary: 'set 1 synopsis' } })).toBe('applied: set 1 synopsis');
    expect(headlineOf({ mode: 'call', reply: { content: '  A storm takes the lamp.  ' } })).toBe('A storm takes the lamp.');
    expect(headlineOf({ mode: 'call', reply: { content: '   ' } })).toBe('The model answered with no text.');
  });
});

describe('a refusal says which way to replay instead', () => {
  it('quotes the engine’s own words, and is quiet about anything that is not a refusal', () => {
    expect(refusalText(new ReplayRefusal('no-target', 'Choose the profile to replay on first.'))).toBe('Choose the profile to replay on first.');
    expect(refusalText(new Error('the network went away'))).toBeUndefined();
  });
});

describe('the starting states kept for a turn', () => {
  it('keeps a copy, not the live state, so a later change cannot rewrite it', () => {
    const state = sampleProjectState();
    const kept = new ReplaySnapshots();
    kept.keep('turn-1', state);
    const before = kept.of('turn-1');

    state.manifest.project.name = 'Renamed later';

    expect(before?.manifest.project.name).toBe('Sample manuscript');
    expect(kept.has('turn-1')).toBe(true);
  });

  it('keeps the last five turns in the tab and evicts the oldest', () => {
    const kept = new ReplaySnapshots();
    const state = sampleProjectState();
    for (let index = 1; index <= 7; index += 1) kept.keep(`turn-${index}`, state);

    expect(kept.has('turn-1')).toBe(false);
    expect(kept.has('turn-2')).toBe(false);
    expect(kept.has('turn-3')).toBe(true);
    expect(kept.has('turn-7')).toBe(true);
  });

  it('clears every kept state at once', () => {
    const kept = new ReplaySnapshots();
    kept.keep('turn-1', sampleProjectState());
    kept.clear();
    expect(kept.of('turn-1')).toBeUndefined();
  });
});
