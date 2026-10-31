/**
 * The screenplay scene-draft role, run end to end (screenplay.md §3 and §6). A draft of a screenplay scene is asked for in
 * Fountain, and a continue into its passage is asked for the Fountain only, with no heading. Each scenario runs through the real
 * loop and bus: the mock answers the draft with the Fountain it was given, and the scenario reads the role the request carried,
 * so a role that drifts from the scene's form fails here as well as in the role's own unit test.
 */

import { describe, expect, it } from 'vitest';

import { textOf } from '@caotang/gateway';
import { userTextOf, type MockScript } from '@caotang/gateway/mock';
import { addDocument, getBody, type ProjectState } from '@caotang/store';

import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { OPENED, makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { steps, transcript } from '../agent/scripts.js';

const LAMP = 'n_LAMP000001';
const KEEPER = 'n_KEEP000001';
const FOUNTAIN = ['INT. LIGHTHOUSE - NIGHT', '', 'The lamp gutters and goes out.', '', 'ELENA', '(low)', 'Is anyone there?'].join('\n');

/** A project with an empty screenplay scene, and one with a heading and a line of action, in the manuscript. */
function screenplayProject(): ProjectState {
  const state = makeState();
  addDocument(state, { id: LAMP, parentId: 'manuscript', title: 'The Lamp', kind: 'screenplay', body: '', now: OPENED });
  addDocument(state, { id: KEEPER, parentId: 'manuscript', title: 'The Keeper', kind: 'screenplay', body: 'INT. LIGHTHOUSE - NIGHT\n\nThe lamp gutters.', now: OPENED });
  return state;
}

/** Answers the draft whose brief is `brief` with `text`, and keeps the system message that request carried, in `roles`. */
function screenplayDraft(brief: string, text: string, roles: string[]): MockScript {
  return {
    match: (req) => req.responseFormat === 'text' && userTextOf(req).includes(brief),
    respond: (req) => {
      roles.push(textOf(req.messages.find((message) => message.role === 'system')?.content ?? ''));
      return { content: text };
    },
  };
}

describe('the screenplay scene-draft role, through the loop (screenplay.md §3, §6)', () => {
  it('asks a draft of an empty screenplay scene for Fountain, with the cue and heading forms the scene keeps', async () => {
    const roles: string[] = [];
    const intent = 'Draft the lighthouse scene.';
    const scenario: Scenario = {
      name: 'screenplay: draft asks for Fountain',
      category: 'single-op',
      intent,
      project: screenplayProject,
      gateway: () =>
        mockGateway([
          transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Lamp', instruction: 'The lamp fails.', mode: 'draft' }, expect: 'the scene is drafted' })]),
          screenplayDraft('Brief: The lamp fails.', FOUNTAIN, roles),
        ]),
      expect: {
        status: 'applied',
        trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok' }] },
        state: (state) => (getBody(state, LAMP) === FOUNTAIN ? [] : ['the scene does not hold the Fountain the model wrote']),
      },
    };
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toContain('Fountain');
    expect(roles[0]).toContain('UPPERCASE');
    expect(roles[0]).toContain('INT. or EXT.');
    expect(roles[0]).not.toContain('Output the prose only');
  });

  it('asks a continue into a screenplay scene for its Fountain only, with no scene heading', async () => {
    const roles: string[] = [];
    const intent = 'Carry on the keeper scene.';
    const continued = 'ELENA\nHold the light.';
    const scenario: Scenario = {
      name: 'screenplay: continue asks for the passage only',
      category: 'single-op',
      intent,
      project: screenplayProject,
      gateway: () =>
        mockGateway([
          transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Keeper', instruction: 'The keeper climbs.', mode: 'continue' }, expect: 'the scene goes on' })]),
          screenplayDraft('Brief: The keeper climbs.', continued, roles),
        ]),
      expect: {
        status: 'applied',
        trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok' }] },
        state: (state) =>
          getBody(state, KEEPER) === `INT. LIGHTHOUSE - NIGHT\n\nThe lamp gutters.\n\n${continued}` ? [] : ['the continue was not appended after the passage'],
      },
    };
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toContain('Output the Fountain only.');
    expect(roles[0]).toContain('Do not write a scene heading (INT. or EXT.)');
    expect(roles[0]).not.toContain('Keep its scene heading');
  });
});
