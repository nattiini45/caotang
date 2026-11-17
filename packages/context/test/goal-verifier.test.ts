import { expect, it } from 'vitest';
import { textOf } from '@caotang/gateway';

import { assemble, type AgentTask } from '../src/index.js';
import { buildApp, FOCUS_ID } from './fixtures.js';

const task: AgentTask = {
  tool: 'goal.verify',
  instruction: 'Check only the supplied changes against the rubric.',
  params: { rubric: 'Keep the departure time consistent.', excerpts: [{ before: 'The ferry left at noon.', after: 'The ferry left at noon the next day.' }] },
};

it('assembles only the verifier task without inheriting actor or project context', () => {
  const app = buildApp();
  const prompt = assemble(task, {
    ...app,
    instructions: { source: 'CAOTANG.md', text: 'UNSENT_STANDING_INSTRUCTIONS' },
    memoryIndex: 'UNSENT_MEMORY_INDEX',
    tools: [{ name: 'UNSENT_ACTOR_TOOL', signature: 'UNSENT_ACTOR_TOOL()' }],
    turns: [{ turnId: 'actor-turn', intent: 'UNSENT_ACTOR_INTENT', outcome: 'UNSENT_ACTOR_OUTCOME' }],
    sessionSummary: { version: 1, covers: { from: 'actor-turn', to: 'actor-turn', turns: 1 }, text: 'UNSENT_SESSION_SUMMARY', origin: 'auto', external: false, readPolicy: 'original' },
  });
  const sent = prompt.messages.map(message => textOf(message.content)).join('\n');
  expect(prompt.layers.filter(layer => layer.included).map(layer => layer.id)).toEqual(['L0', 'L7']);
  expect(sent).toContain('Keep the departure time consistent.');
  expect(sent).toContain('The ferry left at noon the next day.');
  expect(sent).not.toContain('UNSENT_');
  expect(sent).not.toContain('Elena');
  expect(sent).not.toContain(app.state.manifest.project.name);
});

it('does not activate inherited layers through conversation, focus, scope or pins', () => {
  const app = buildApp();
  const plain = assemble(task, app);
  const inherited = assemble({
    ...task,
    conversation: true,
    focus: FOCUS_ID,
    scope: [FOCUS_ID],
    includeForwardOutline: true,
    overrides: { include: [{ kind: 'doc', id: FOCUS_ID }] },
  }, app);
  expect(inherited.messages).toEqual(plain.messages);
  expect(inherited.layers.filter(layer => layer.included).map(layer => layer.id)).toEqual(['L0', 'L7']);
});
