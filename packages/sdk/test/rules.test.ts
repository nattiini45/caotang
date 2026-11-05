/**
 * The project's own agent rules hold in the SDK (agent-harness.md §4, "Rules"), not only in the app and the MCP server.
 *
 * A folder's `caotang.json` may say the agent may not read a subtree, may not write one, or must ask first. `openProject` reads
 * that list and holds every turn and every `call()` to it: a read-deny keeps the node out of every model request, a deny write
 * refuses the step, and an `ask` write reaches the caller as a card (which the built-in policies answer as they answer any card).
 * A rules file that cannot be read fails closed: changes are refused with a reason, and reads still work.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '@caotang/harness';

import { openProject, type ApprovalPolicy, type CaotangProject, type OpenOptions } from '../src/index.js';
import { endpoint, TEST_PROFILE } from './endpoint.js';
import { FRIEND, LANDING, STORM, folderBytes, seedProject } from './fixture.js';
import { removeDir, tempDir } from './support.js';

let root = '';
beforeEach(async () => {
  root = tempDir('rules');
  await seedProject(root);
});
afterEach(() => removeDir(root));

/** Writes the `agent` object into the project's manifest, as a writer's file would carry it. */
function setAgent(agent: unknown): void {
  const path = join(root, 'caotang.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  manifest['agent'] = agent;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The read-deny the writer set in the app's binder: every tool, this subtree, read. */
const DENY_LANDING = {
  rules: [{ effect: 'deny', tool: '*', scope: { subtree: LANDING }, access: 'read', note: 'Private scene' }],
};

async function open(options: Partial<OpenOptions> = {}): Promise<CaotangProject> {
  return openProject({ root, provider: 'mock', ...options });
}

async function eventsOf(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

/** Every body the provider was sent, as one searchable string: the system prompt, the conversation and the tool results. */
function bodiesOf(bodies: readonly string[]): string {
  return bodies.join('\n\n');
}

describe('a read-deny in the project file', () => {
  it('refuses a read of the withheld document, names the rule, and never reveals its title or text', async () => {
    setAgent(DENY_LANDING);
    await using project = await open({ approval: 'read-only' });

    const denied = await project.call('doc.read', { doc: LANDING });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('the read-deny let the document through');
    expect(denied.error.code).toBe('permission-denied');
    expect(denied.error.message).toContain('Private scene');
    expect(denied.error.message).not.toContain('The Landing');
    expect(denied.error.message).not.toContain('The ferry was late');

    // The other scene is not in the rule's scope and reads as usual.
    const allowed = await project.call('doc.read', { doc: STORM });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error(allowed.error.message);
    expect(JSON.stringify(allowed.value.data)).toContain('The lamp failed');
  });

  it('keeps the withheld scene out of every model request of a turn, system prompt and tool results alike', async () => {
    setAgent(DENY_LANDING);
    let calls = 0;
    const scripted = endpoint((_request, kind) => {
      if (kind !== 'planner') return { kind: 'text', text: 'A scene.' };
      calls += 1;
      // First the binder tree, whose result joins the next request's conversation; then a plain reply.
      return calls === 1
        ? { kind: 'step', tool: 'binder.read_tree', params: { root: 'manuscript', depth: 3 }, expect: 'the manuscript tree' }
        : { kind: 'text', text: JSON.stringify({ reply: 'The manuscript has two scenes.' }) };
    });
    // The whole request body, so a tool result in the conversation is searched too (the endpoint helper records only system and user).
    const bodies: string[] = [];
    const fetchRecording: typeof fetch = (input, init) => {
      bodies.push(String(init?.body ?? ''));
      return scripted.fetch(input, init);
    };
    await using project = await open({
      approval: 'read-only',
      provider: { profile: TEST_PROFILE, apiKey: 'sk-rules-123456' },
      fetch: fetchRecording,
    });

    const report = await project.run('Summarize the whole manuscript.').report;
    expect(bodies.length).toBe(2);
    const sent = bodiesOf(bodies);
    expect(sent).not.toContain('The Landing');
    expect(sent).not.toContain(LANDING);
    expect(sent).not.toContain('The ferry was late');
    // The tree the second request carries proves the search would have found a title that was not withheld.
    expect(sent).toContain('The Storm');
    expect(report.status).not.toBe('failed');
  });
});

describe('a write-deny in the project file', () => {
  it('refuses the step that writes the locked scene, and writes nothing', async () => {
    setAgent({ rules: [{ effect: 'deny', tool: 'synopsis.fill', scope: { subtree: LANDING }, access: 'write', note: 'Locked' }] });
    const before = folderBytes(root);
    await using project = await open({ approval: 'approve-all', write: true });

    const events = await eventsOf(project.run('Fill the synopses.', { plan: { steps: [{ tool: 'synopsis.fill', params: { docs: [LANDING], source: 'text', max_words: 20 }, expect: 'a synopsis' }] } }));
    const text = JSON.stringify(events);
    expect(text).toContain('Locked');
    expect(text).toContain('permission-denied');
    await project.close();
    expect(folderBytes(root)).toEqual(before);
  });
});

describe('an ask rule in the project file', () => {
  const ASK_SYNOPSIS = { rules: [{ effect: 'ask', tool: 'synopsis.fill' }] };
  // The Landing is one of the two scenes the demo provider drafts a synopsis for, so the card has a proposal to show.
  const PLAN = { steps: [{ tool: 'synopsis.fill', params: { docs: [LANDING], source: 'text', max_words: 20 }, expect: 'a synopsis' }] };

  it('never auto-applies under the headless policies that cancel every card', async () => {
    setAgent(ASK_SYNOPSIS);
    const before = folderBytes(root);
    for (const approval of ['read-only', 'auto'] as const satisfies readonly ApprovalPolicy[]) {
      await using project = await open({ approval, write: true });
      const report = await project.run('Fill the synopsis.', { plan: PLAN }).report;
      expect(report.status).toBe('cancelled');
      expect(report.askBack?.code).toBe('needs_input');
    }
    expect(folderBytes(root)).toEqual(before);
  });

  it('makes a write-auto call a card, which the headless policies cancel', async () => {
    // Without the rule this step is a write-auto call that runs at once, so the cancellation is the rule's.
    setAgent({ rules: [{ effect: 'ask', tool: 'meta.set' }] });
    const before = folderBytes(root);
    const plan = { steps: [{ tool: 'meta.set', params: { targets: [FRIEND], status: 'revised' }, expect: 'the scene is revised' }] };
    await using project = await open({ approval: 'auto', write: true });
    const report = await project.run('Mark the scene revised.', { plan }).report;
    expect(report.status).toBe('cancelled');
    expect(report.askBack?.code).toBe('needs_input');
    await project.close();
    expect(folderBytes(root)).toEqual(before);
  });

  it('writes when the caller approves the card, as it does any card', async () => {
    setAgent(ASK_SYNOPSIS);
    const before = folderBytes(root);
    await using project = await open({ approval: 'approve-all', write: true });
    const report = await project.run('Fill the synopsis.', { plan: PLAN }).report;
    expect(report.status).toBe('applied');
    await project.close();
    expect(folderBytes(root)).not.toEqual(before);
  });
});

describe('rules that cannot be read', () => {
  const UNREADABLE: readonly (readonly [string, unknown])[] = [
    ['a rules value that is not a list', { rules: 'nope' }],
    ['a rule with no tool', { rules: [{ effect: 'deny' }] }],
    ['an agent value that is an array', [{ rules: [] }]],
  ];

  it.each(UNREADABLE)('refuses a write with a named reason and leaves the folder unchanged: %s', async (_label, agent) => {
    setAgent(agent);
    const before = folderBytes(root);
    await using project = await open({ approval: 'approve-all', write: true });

    // A write-auto step: no model call is needed, so the refusal is the rule's rather than a provider's.
    const events = await eventsOf(project.run('Mark the scene revised.', { plan: { steps: [{ tool: 'meta.set', params: { targets: [FRIEND], status: 'revised' }, expect: 'the scene is revised' }] } }));
    const text = JSON.stringify(events);
    expect(text).toContain('the rules could not be read');
    expect(text).toContain('permission-denied');
    await project.close();
    expect(folderBytes(root)).toEqual(before);
  });

  it.each(UNREADABLE)('still reads: %s', async (_label, agent) => {
    setAgent(agent);
    await using project = await open({ approval: 'read-only' });
    const read = await project.call('doc.read', { doc: STORM });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.error.message);
    expect(JSON.stringify(read.value.data)).toContain('The lamp failed');
  });
});
