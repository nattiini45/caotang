/**
 * scene.draft on a screenplay scene drafts Fountain (screenplay.md §3 and §6): the role text the model is given names the form, the
 * preview shows that role, and a draft run through the loop is asked for in that role. A prose scene keeps the prose role.
 */

import { describe, expect, it } from 'vitest';

import { type ChatRequest } from '@caotang/gateway';
import { userTextOf, type MockScript } from '@caotang/gateway/mock';
import { addDocument, getBody, type ProjectState } from '@caotang/store';

import { createAgentPorts, createAgentSession, createContextPort, scenePromptPreview, type Decision, type PendingCard } from '../../src/index.js';
import { sceneRole } from '../../src/agent/drafting.js';
import { checkedHarness, clock, makeState, OPENED } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { steps, transcript } from './scripts.js';

const INTENT = 'Draft the lighthouse scene.';
const SCENE = 'n_LAMP000001';
const PROSE = 'n_FERRY00001';
const BRIEF = 'Show the lamp failing as the boat comes in.';
const FOUNTAIN = ['INT. LIGHTHOUSE - NIGHT', '', 'The lamp gutters and goes out.', '', 'ELENA', '(low)', 'Is anyone there?', ''].join('\n');

/** A project with a screenplay scene and a prose scene in the manuscript. */
function withScenes(): ProjectState {
  const state = makeState();
  addDocument(state, { id: SCENE, parentId: 'manuscript', title: 'The Lamp', kind: 'screenplay', body: '', now: OPENED });
  addDocument(state, { id: PROSE, parentId: 'manuscript', title: 'The Ferry', body: 'It rained over the harbour.', now: OPENED });
  return state;
}

describe('the scene draft role names the document kind (screenplay.md §3, §6)', () => {
  it('asks a screenplay scene for Fountain, with the cue and heading forms the scene must keep', () => {
    const role = sceneRole(undefined, 'screenplay');
    expect(role).toContain('Fountain');
    expect(role).toContain('UPPERCASE');
    expect(role).toContain('INT. or EXT.');
    expect(role).not.toContain('Output the prose only');
  });

  it('asks a screenplay passage for its Fountain only, with no heading, for continue and rewrite_selection', () => {
    // A passage of a scene that has its heading: a second heading in the middle of the scene is a defect (screenplay.md §3).
    for (const mode of ['continue', 'rewrite_selection'] as const) {
      const role = sceneRole(undefined, 'screenplay', mode);
      expect(role).toContain('Fountain');
      expect(role).toContain('Do not write a scene heading (INT. or EXT.)');
      expect(role).not.toContain('Keep its scene heading');
      expect(role).not.toContain('Write the screenplay scene described below');
      expect(role).toContain('Output the Fountain only.');
    }
    expect(sceneRole(undefined, 'screenplay', 'continue')).toContain('the text that carries on from the end of the scene');
    expect(sceneRole(undefined, 'screenplay', 'rewrite_selection')).toContain('the replacement for the selected text');
  });

  it('keeps the whole-scene heading role for a screenplay draft, and the prose role for a passage of a prose scene', () => {
    expect(sceneRole(undefined, 'screenplay', 'draft')).toBe(sceneRole(undefined, 'screenplay'));
    expect(sceneRole(undefined, 'screenplay', 'draft')).toContain('Keep its scene heading (INT. or EXT.)');
    expect(sceneRole(undefined, 'prose', 'continue')).toContain('Output the prose only');
  });

  it('keeps the prose role for a prose scene, and for a scene with no kind', () => {
    expect(sceneRole(undefined)).toBe(sceneRole(undefined, 'prose'));
    expect(sceneRole(undefined)).toContain('Output the prose only');
    expect(sceneRole(undefined)).not.toContain('Fountain');
  });

  it('keeps the word aim on either role', () => {
    expect(sceneRole(300, 'screenplay')).toContain('Aim for about 300 words.');
    expect(sceneRole(300)).toContain('Aim for about 300 words.');
  });

  it('shows the Fountain role in the preview of a screenplay scene, and the prose role in the preview of a prose scene', () => {
    const state = withScenes();
    const screenplay = scenePromptPreview(state, SCENE, { mode: 'draft', instruction: BRIEF });
    const prose = scenePromptPreview(state, PROSE, { mode: 'draft', instruction: BRIEF });
    expect(screenplay?.payload[0]?.content).toContain('Fountain');
    expect(prose?.payload[0]?.content).toContain('Output the prose only');
    expect(prose?.payload[0]?.content).not.toContain('Fountain');
  });

  it('shows the passage role, not the whole-scene role, in the preview of a continue of a screenplay scene', () => {
    const state = withScenes();
    const continued = scenePromptPreview(state, SCENE, { mode: 'continue', instruction: BRIEF });
    expect(continued?.payload[0]?.content).toContain('Do not write a scene heading (INT. or EXT.)');
    expect(continued?.payload[0]?.content).not.toContain('Keep its scene heading');
  });
});

describe('a scene draft of a screenplay scene, through the loop', () => {
  it('is asked for in the Fountain role, and an approved draft is written into the scene', async () => {
    const state = withScenes();
    const roles: string[] = [];
    // The drafting call for the brief: the system message it was given is recorded, and the Fountain text is its reply.
    const drafting: MockScript = {
      match: (req: ChatRequest) => req.responseFormat === 'text' && userTextOf(req).includes(`Brief: ${BRIEF}`),
      respond: (req: ChatRequest) => {
        roles.push(req.messages[0]?.content ?? '');
        return { content: FOUNTAIN };
      },
    };
    const gateway = await mockGateway([
      transcript(INTENT, [steps({ tool: 'scene.draft', params: { doc: SCENE, instruction: BRIEF, mode: 'draft' }, expect: 'the scene holds the draft' })]),
      drafting,
    ]);
    const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const pending: PendingCard[] = [];
    const decision: Decision = { action: 'approve' };
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async (card) => {
        pending.push(card);
        return decision;
      },
      emit: () => undefined,
      sessionId: 'screenplay-draft',
    });
    const report = await session.submit(INTENT);

    expect(roles).toHaveLength(1);
    expect(roles[0]).toContain('Fountain');
    expect(roles[0]).not.toContain('Output the prose only');
    expect(report.steps.find((step) => step.tool === 'scene.draft')?.status).toBe('done');
    expect(getBody(state, SCENE)).toBe(FOUNTAIN.trim());
  });

  it('is asked for a continuation in the passage role, with no scene heading, when the mode is continue', async () => {
    const state = withScenes();
    const roles: string[] = [];
    const drafting: MockScript = {
      match: (req: ChatRequest) => req.responseFormat === 'text' && userTextOf(req).includes(`Brief: ${BRIEF}`),
      respond: (req: ChatRequest) => {
        roles.push(req.messages[0]?.content ?? '');
        return { content: 'ELENA\nIs anyone there?' };
      },
    };
    const gateway = await mockGateway([
      transcript(INTENT, [steps({ tool: 'scene.draft', params: { doc: SCENE, instruction: BRIEF, mode: 'continue' }, expect: 'the scene carries on' })]),
      drafting,
    ]);
    const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      emit: () => undefined,
      sessionId: 'screenplay-continue',
    });
    await session.submit(INTENT);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toContain('Do not write a scene heading (INT. or EXT.)');
    expect(roles[0]).not.toContain('Keep its scene heading');
  });

  it('keeps the prose role for a scene draft of a prose scene', async () => {
    const state = withScenes();
    const roles: string[] = [];
    const drafting: MockScript = {
      match: (req: ChatRequest) => req.responseFormat === 'text' && userTextOf(req).includes(`Brief: ${BRIEF}`),
      respond: (req: ChatRequest) => {
        roles.push(req.messages[0]?.content ?? '');
        return { content: 'The lamp went out.' };
      },
    };
    const gateway = await mockGateway([
      transcript(INTENT, [steps({ tool: 'scene.draft', params: { doc: PROSE, instruction: BRIEF, mode: 'continue' }, expect: 'the scene continues' })]),
      drafting,
    ]);
    const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      emit: () => undefined,
      sessionId: 'prose-draft',
    });
    await session.submit(INTENT);
    expect(roles[0]).toContain('Output the prose only');
    expect(roles[0]).not.toContain('Fountain');
  });
});
