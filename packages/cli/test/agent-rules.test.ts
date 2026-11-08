/**
 * `caotang agent` holds the project's own agent rules (agent-harness.md §4, "Rules"), the same rules the app and the MCP server hold
 * a host to. A folder's `caotang.json` may say the agent may not read a scene, may not write one, or must ask first; this file runs
 * the command line against a copy of the committed fixture project and checks each of those on the text a person (or a script) sees.
 */

import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExitCode } from '../src/output.js';
import { runAgent } from '../src/run-agent.js';
import { capture, folderBytes, removeDir, seedProject, tempDir } from './support.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/continuity-project', import.meta.url));
const SHORE = 'n_8M3RY1N5B2';
const HARBOUR = 'n_7K2QX9M4A1';
const SHORE_TEXT = 'Elena watched the sea.';
const HARBOUR_TEXT = 'Gulls only.';

let root = '';
let plans = 0;
beforeEach(() => {
  root = tempDir('agent-rules');
  cpSync(FIXTURE, root, { recursive: true });
});
afterEach(() => removeDir(root));

/** Writes the `agent` object into the project's manifest, as a writer's file would carry it. */
function setAgent(project: string, agent: unknown): void {
  const path = join(project, 'caotang.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  manifest['agent'] = agent;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A plan file beside the project, holding one step per call. */
function planFile(project: string, steps: readonly { tool: string; params: object; expect: string }[]): string {
  plans += 1;
  const path = join(project, '..', `caotang-plan-${process.pid}-${plans}.json`);
  writeFileSync(path, JSON.stringify({ steps }));
  return path;
}

async function agent(project: string, args: readonly string[]): Promise<{ code: ExitCode; out: string; err: string }> {
  const io = capture();
  const code = await runAgent([...args, '--mock', '--project', project], io);
  return { code, out: io.out.join(''), err: io.err.join('') };
}

const docRead = (doc: string): { tool: string; params: object; expect: string } => ({ tool: 'doc.read', params: { doc }, expect: 'the scene' });

describe('a read-deny in the project file', () => {
  const READ_BOTH = [docRead(SHORE), docRead(HARBOUR)];

  it('lets the plan read both scenes when no rule withholds one, which proves the control run can see them', async () => {
    const run = await agent(root, ['-p', 'read it', '--permission', 'read-only', '--plan-file', planFile(root, READ_BOTH), '--output-format', 'json']);
    expect(run.code, run.err).toBe(ExitCode.Ok);
    expect(run.out).toContain(SHORE_TEXT);
    expect(run.out).toContain(HARBOUR_TEXT);
  });

  it('refuses the withheld scene by its rule’s note, leaks nothing about it, and still reads the other one', async () => {
    setAgent(root, { rules: [{ effect: 'deny', tool: '*', scope: { subtree: SHORE }, access: 'read', note: 'Private scene' }] });
    const before = folderBytes(root);
    const run = await agent(root, ['-p', 'read it', '--permission', 'read-only', '--plan-file', planFile(root, READ_BOTH), '--output-format', 'json']);

    const seen = `${run.out}\n${run.err}`;
    expect(seen).not.toContain(SHORE_TEXT);
    expect(seen).not.toContain('The Shore');
    expect(seen).toContain('Private scene');
    expect(seen).toContain(HARBOUR_TEXT);
    expect(folderBytes(root)).toEqual(before);
  });
});

describe('a write-deny in the project file', () => {
  it('refuses the step that writes the locked scene, names the rule, and leaves its file byte-identical', async () => {
    setAgent(root, { rules: [{ effect: 'deny', tool: 'synopsis.fill', scope: { subtree: SHORE }, access: 'write', note: 'Locked' }] });
    const before = folderBytes(root);
    const plan = planFile(root, [{ tool: 'synopsis.fill', params: { docs: [SHORE], source: 'text', max_words: 20 }, expect: 'a synopsis' }]);
    const run = await agent(root, ['-p', 'Fill the synopsis.', '--permission', 'approve-all', '--approve-tools', 'synopsis.fill', '--write', '--plan-file', plan]);

    expect(`${run.out}\n${run.err}`).toContain('Locked');
    expect(run.code).not.toBe(ExitCode.Ok);
    expect(folderBytes(root)).toEqual(before);
  });
});

describe('an ask rule in the project file', () => {
  // The demo provider drafts synopses for The Landing and The Storm, so these runs use a project that has them.
  let project = '';
  beforeEach(async () => {
    project = tempDir('agent-rules-ask');
    await seedProject(project);
  });
  afterEach(() => removeDir(project));

  const LANDING = 'n_BEACH00001';
  const askPlan = (): string => planFile(project, [{ tool: 'synopsis.fill', params: { docs: [LANDING], source: 'text', max_words: 20 }, expect: 'a synopsis' }]);

  it('never auto-applies under --permission auto: the card is cancelled and nothing is written', async () => {
    setAgent(project, { rules: [{ effect: 'ask', tool: 'synopsis.fill' }] });
    const before = folderBytes(project);
    const run = await agent(project, ['-p', 'Fill the synopsis.', '--permission', 'auto', '--write', '--plan-file', askPlan()]);

    expect(run.code).toBe(ExitCode.NeedsInput);
    expect(`${run.out}\n${run.err}`).toContain('needs_input');
    expect(folderBytes(project)).toEqual(before);
  });

  it('makes a write-auto call a card: under auto it is cancelled, and a write-auto step never runs unattended', async () => {
    // Without the rule this step runs at once under auto, so the refusal is the rule's and not the policy's.
    setAgent(root, { rules: [{ effect: 'ask', tool: 'meta.set' }] });
    const before = folderBytes(root);
    const plan = planFile(root, [{ tool: 'meta.set', params: { targets: [HARBOUR], status: 'revised' }, expect: 'the scene is revised' }]);
    const run = await agent(root, ['-p', 'Mark it revised.', '--permission', 'auto', '--write', '--plan-file', plan]);

    expect(run.code).toBe(ExitCode.NeedsInput);
    expect(folderBytes(root)).toEqual(before);
  });

  it('writes when the card is approved as shown', async () => {
    setAgent(project, { rules: [{ effect: 'ask', tool: 'synopsis.fill' }] });
    const before = folderBytes(project);
    const run = await agent(project, ['-p', 'Fill the synopsis.', '--permission', 'approve-all', '--approve-tools', 'synopsis.fill', '--write', '--plan-file', askPlan()]);

    expect(run.code, run.err).toBe(ExitCode.Ok);
    expect(folderBytes(project)).not.toEqual(before);
  });
});

describe('rules that cannot be read', () => {
  const UNREADABLE: readonly (readonly [string, unknown])[] = [
    ['a rules value that is not a list', { rules: 'nope' }],
    ['a rule with no tool', { rules: [{ effect: 'deny' }] }],
    ['an agent value that is an array', [{ rules: [] }]],
  ];

  it.each(UNREADABLE)('refuses a write with a named reason and changes nothing: %s', async (_label, agentValue) => {
    setAgent(root, agentValue);
    const before = folderBytes(root);
    const plan = planFile(root, [{ tool: 'synopsis.fill', params: { docs: [SHORE], source: 'text', max_words: 20 }, expect: 'a synopsis' }]);
    const run = await agent(root, ['-p', 'Fill the synopses.', '--permission', 'approve-all', '--approve-tools', 'synopsis.fill', '--write', '--plan-file', plan]);

    const seen = `${run.out}\n${run.err}`;
    expect(seen).toContain('the rules could not be read');
    expect(run.code).not.toBe(ExitCode.Ok);
    expect(folderBytes(root)).toEqual(before);
  });

  it('still reads', async () => {
    setAgent(root, { rules: 'nope' });
    const run = await agent(root, ['-p', 'read it', '--permission', 'read-only', '--plan-file', planFile(root, [docRead(HARBOUR)]), '--output-format', 'json']);
    expect(run.code, run.err).toBe(ExitCode.Ok);
    expect(run.out).toContain(HARBOUR_TEXT);
  });

  it('lets a valid-rules project write, the positive control the refusals are measured against', async () => {
    setAgent(root, { rules: [{ effect: 'deny', tool: '*', scope: { subtree: SHORE }, access: 'read' }] });
    const before = folderBytes(root);
    const plan = planFile(root, [{ tool: 'meta.set', params: { targets: [HARBOUR], status: 'revised' }, expect: 'the scene is revised' }]);
    const run = await agent(root, ['-p', 'Mark it revised.', '--permission', 'approve-all', '--write', '--plan-file', plan]);

    expect(run.code, run.err).toBe(ExitCode.Ok);
    expect(folderBytes(root)).not.toEqual(before);
  });
});
