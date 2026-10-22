/**
 * `caotang agent` in process: the demo provider, a scripted endpoint behind the fetch seam, and a real project folder in a temporary
 * directory. The built bundle is run as a process in binary.test.ts.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEMO_INTENTS } from '@caotang/gateway/mock';
import { LOCK_FILE } from '@caotang/sdk';
import { runCli as runMcp } from '@caotang/mcp-server';

import { DRAFT_THE_FRIEND, endpoint } from '../../sdk/test/endpoint.js';
import { AGENT_USAGE } from '../src/agent-args.js';
import { main } from '../src/cli.js';
import { ExitCode, type AgentResultJson } from '../src/output.js';
import { runAgent } from '../src/run-agent.js';
import { capture, folderBytes, FRIEND, jsonLines, removeDir, seedProject, tempDir } from './support.js';

let root = '';
beforeEach(async () => {
  root = tempDir('agent');
  await seedProject(root);
});
afterEach(() => removeDir(root));

const MOCK = ['--mock', '--project'] as const;

describe('the demo provider, read-only by default', () => {
  it('prints the reply of a read and exits 0, with nothing written', async () => {
    const before = folderBytes(root);
    const io = capture();
    const code = await runAgent(['-p', DEMO_INTENTS.continuity, ...MOCK, root], io);
    expect(code).toBe(0);
    expect(io.out.join('')).toMatch(/\S/);
    expect(folderBytes(root)).toEqual(before);
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it('exits 4 on an intent that needs a write-confirm card, names the step on stderr, and leaves the folder byte-identical', async () => {
    const before = folderBytes(root);
    const io = capture();
    const code = await runAgent(['-p', DEMO_INTENTS.draftScene, ...MOCK, root], io);
    expect(code).toBe(ExitCode.NeedsInput);
    expect(io.err.join('')).toContain('needs_input');
    expect(io.err.join('')).toContain('scene.draft');
    expect(io.err.join('')).toContain('decision: cancel');
    expect(folderBytes(root)).toEqual(before);
  });

  it('reads the intent from stdin with -p -', async () => {
    const io = capture({ stdin: `${DEMO_INTENTS.continuity}\n` });
    expect(await runAgent(['-p', '-', ...MOCK, root], io)).toBe(0);
    expect(io.out.join('')).toMatch(/\S/);
  });

  it('resolves --project against the working directory, and uses the working directory without it', async () => {
    const io = capture({ cwd: root });
    expect(await runAgent(['-p', DEMO_INTENTS.continuity, '--mock'], io)).toBe(0);
    const other = capture({ cwd: dirname(root) });
    expect(await runAgent(['-p', DEMO_INTENTS.continuity, '--mock', '--project', basename(root)], other)).toBe(0);
  });
});

describe('--output-format json', () => {
  it('writes exactly one object to stdout, matching AgentResultJson, and nothing else', async () => {
    const io = capture();
    const code = await runAgent(['-p', DEMO_INTENTS.continuity, ...MOCK, root, '--output-format', 'json'], io);
    expect(code).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(io.out[0]?.endsWith('\n')).toBe(true);
    const result = JSON.parse(io.out[0] ?? '') as AgentResultJson;
    expect(Object.keys(result).sort()).toEqual(['changes', 'exitCode', 'permission', 'project', 'provider', 'report', 'type', 'version', 'written']);
    expect(result).toMatchObject({ type: 'result', version: 1, permission: 'read-only', written: false, changes: [], exitCode: 0, provider: { preset: 'mock' } });
    expect(result.project).toBe(root);
    expect(result.report.status).toBe('replied');
    expect(result.report.tokens).toBeDefined();
  });

  it('carries the exit code, the report’s ask-back and no changes for a cancelled card', async () => {
    const io = capture();
    const code = await runAgent(['-p', DEMO_INTENTS.draftScene, ...MOCK, root, '--output-format', 'json'], io);
    expect(code).toBe(4);
    const result = JSON.parse(io.out.join('')) as AgentResultJson;
    expect(result.exitCode).toBe(4);
    expect(result.report.status).toBe('cancelled');
    expect(result.report.askBack?.code).toBe('needs_input');
    expect(result.report.cards[0]).toMatchObject({ decision: 'cancelled' });
  });
});

describe('--output-format stream-json', () => {
  it('writes a start line, event lines, a decision line for each card and a result line, each parsing on its own', async () => {
    const io = capture();
    const code = await runAgent(['-p', DEMO_INTENTS.draftScene, ...MOCK, root, '--output-format', 'stream-json'], io);
    expect(code).toBe(4);
    const lines = jsonLines(io.out);
    expect(lines[0]).toMatchObject({ type: 'start', version: 1, project: root, permission: 'read-only' });
    expect(lines[lines.length - 1]).toMatchObject({ type: 'result', exitCode: 4 });
    const events = lines.filter((line) => line['type'] === 'event');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((line) => typeof (line['event'] as { type?: unknown }).type === 'string')).toBe(true);
    expect(events.some((line) => (line['event'] as { type: string }).type === 'report')).toBe(true);
    const decisions = lines.filter((line) => line['type'] === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: 'confirm', action: 'cancel', reason: 'the "read-only" policy approves no card' });
    expect(typeof decisions[0]?.['turnId']).toBe('string');
    expect(new Set(lines.map((line) => line['type']))).toEqual(new Set(['start', 'event', 'decision', 'result']));
  });

  it('writes a read’s stream with no decision line, since it showed no card', async () => {
    const io = capture();
    await runAgent(['-p', DEMO_INTENTS.continuity, ...MOCK, root, '--output-format', 'stream-json'], io);
    expect(jsonLines(io.out).some((line) => line['type'] === 'decision')).toBe(false);
  });
});

describe('approve-all', () => {
  it('without --write exits 0, lists the changes in text mode as a diff, and leaves the folder byte-identical', async () => {
    const before = folderBytes(root);
    const io = capture();
    const code = await runAgent(['-p', DEMO_INTENTS.draftScene, ...MOCK, root, '--permission', 'approve-all'], io);
    expect(code).toBe(0);
    expect(io.out.join('')).toContain(`+++ b/docs/${FRIEND}.md`);
    expect(io.err.join('')).toContain('nothing was written');
    expect(folderBytes(root)).toEqual(before);
  });

  it('without --write lists changes[] in json mode, with written false', async () => {
    const before = folderBytes(root);
    const io = capture();
    expect(await runAgent(['-p', DEMO_INTENTS.draftScene, ...MOCK, root, '--permission', 'approve-all', '--output-format', 'json'], io)).toBe(0);
    const result = JSON.parse(io.out.join('')) as AgentResultJson;
    expect(result.written).toBe(false);
    expect(result.changes.map((change) => change.path)).toContain(`docs/${FRIEND}.md`);
    expect(result.report.status).toBe('applied');
    expect(folderBytes(root)).toEqual(before);
  });

  it('with --write saves the folder, says so, and lists the same changes', async () => {
    const before = folderBytes(root);
    const io = capture();
    const code = await runAgent(['-p', DEMO_INTENTS.draftScene, ...MOCK, root, '--permission', 'approve-all', '--write', '--output-format', 'json'], io);
    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('')) as AgentResultJson;
    expect(result.written).toBe(true);
    expect(result.changes.map((change) => change.path)).toContain(`docs/${FRIEND}.md`);
    const after = folderBytes(root);
    expect(after).not.toEqual(before);
    expect(Buffer.from(after[`docs/${FRIEND}.md`] ?? '', 'base64').toString('utf8')).toMatch(/\S/);
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it('in text mode with --write says how many files it wrote', async () => {
    const io = capture();
    await runAgent(['-p', DEMO_INTENTS.draftScene, ...MOCK, root, '--permission', 'approve-all', '--write'], io);
    expect(io.err.join('')).toMatch(/wrote \d+ files?/);
  });
});

describe('auto', () => {
  it('cancels a write-confirm card, as read-only does, and exits 4', async () => {
    const before = folderBytes(root);
    const io = capture();
    expect(await runAgent(['-p', DEMO_INTENTS.draftScene, ...MOCK, root, '--permission', 'auto', '--write'], io)).toBe(4);
    expect(folderBytes(root)).toEqual(before);
  });
});

describe('--approve-tools', () => {
  const plan = (tools: readonly string[]): string => {
    const steps = [
      { tool: 'synopsis.fill', params: { docs: ['The Landing', 'The Storm'], source: 'text', max_words: 30 }, expect: 'both scenes have a synopsis' },
      { tool: 'binder.restructure', params: { ops: [{ action: 'rename', node: FRIEND, title: 'The Guest' }] }, expect: 'The Friend is renamed' },
    ].filter((step) => tools.includes(step.tool));
    const path = join(root, '..', `plan-${tools.join('-')}.json`);
    writeFileSync(path, JSON.stringify({ steps }));
    return path;
  };

  it('cancels a card that also holds binder.restructure when only synopsis.fill is listed, and the decision line says why', async () => {
    const before = folderBytes(root);
    const io = capture();
    const code = await runAgent(
      ['-p', 'Fill the synopses and rename.', ...MOCK, root, '--permission', 'approve-all', '--approve-tools', 'synopsis.fill', '--plan-file', plan(['synopsis.fill', 'binder.restructure']), '--output-format', 'stream-json'],
      io,
    );
    expect(code).toBe(ExitCode.NeedsInput);
    const decisions = jsonLines(io.out).filter((line) => line['type'] === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: 'cancel' });
    expect(decisions[0]?.['reason']).toContain('binder.restructure is not in the approved tools');
    expect(folderBytes(root)).toEqual(before);
  });

  it('approves a card made only of listed tools', async () => {
    const io = capture();
    const code = await runAgent(
      ['-p', 'Fill the synopses.', ...MOCK, root, '--permission', 'approve-all', '--approve-tools', 'synopsis.fill', '--plan-file', plan(['synopsis.fill']), '--output-format', 'json'],
      io,
    );
    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('')) as AgentResultJson;
    expect(result.report.status).toBe('applied');
    expect(result.report.cards[0]).toMatchObject({ decision: 'approved', tools: ['synopsis.fill'] });
  });

  it('approves the mixed card when both tools are listed', async () => {
    const io = capture();
    expect(
      await runAgent(
        ['-p', 'Fill and rename.', ...MOCK, root, '--permission', 'approve-all', '--approve-tools', 'synopsis.fill,binder.restructure', '--plan-file', plan(['synopsis.fill', 'binder.restructure'])],
        io,
      ),
    ).toBe(0);
  });

  it('exits 2 for a plan file that is missing or is not JSON, and for a plan with no steps it ends as a failed turn', async () => {
    const missing = capture();
    expect(await runAgent(['-p', 'x', ...MOCK, root, '--plan-file', join(root, 'nope.json')], missing)).toBe(2);
    expect(missing.err.join('')).toContain('cannot be read');
    const path = join(root, '..', 'not-json.json');
    writeFileSync(path, '{ nope');
    const broken = capture();
    expect(await runAgent(['-p', 'x', ...MOCK, root, '--plan-file', path], broken)).toBe(2);
    expect(broken.err.join('')).toContain('is not JSON');
  });
});

describe('a folder another writer holds', () => {
  it('exits 3 while caotang-mcp serve holds it, names the lock, and writes nothing to stdout', async () => {
    let stop: () => Promise<void> = () => Promise.resolve();
    let stopped: () => void = () => undefined;
    let serverIsUp: () => void = () => undefined;
    const up = new Promise<void>((resolve) => (serverIsUp = resolve));
    const serving = runMcp(['serve', '--project', root, '--stdio'], {
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
      // The server waits here once it holds the folder and is serving.
      untilDone: (close) =>
        new Promise<void>((resolve) => {
          stop = close;
          stopped = resolve;
          serverIsUp();
        }),
    });
    await up;
    try {
      const io = capture();
      expect(await runAgent(['-p', DEMO_INTENTS.continuity, ...MOCK, root], io)).toBe(ExitCode.Locked);
      expect(io.err.join('')).toContain(LOCK_FILE);
      expect(io.out).toEqual([]);
    } finally {
      await stop();
      stopped();
      expect(await serving).toBe(0);
    }
  }, 30_000);
});

describe('usage and project errors', () => {
  it('exits 2 with the usage on stderr and nothing on stdout for a bad command line', async () => {
    const io = capture();
    expect(await runAgent(['--mock'], io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toContain(AGENT_USAGE);
    expect(io.err.join('')).toContain('-p <intent> is required');
  });

  it('exits 2 for a folder with no project, and for an empty intent on stdin', async () => {
    const empty = tempDir('empty');
    try {
      const io = capture();
      expect(await runAgent(['-p', 'x', ...MOCK, empty], io)).toBe(2);
      expect(io.err.join('')).toContain('no Caotang project');
      expect(readdirSync(empty)).toEqual([]);
    } finally {
      removeDir(empty);
    }
    const blank = capture({ stdin: '  \n' });
    expect(await runAgent(['-p', '-', ...MOCK, root], blank)).toBe(2);
  });

  it('prints the usage on stdout for --help and exits 0', async () => {
    const io = capture();
    expect(await runAgent(['--help'], io)).toBe(0);
    expect(io.out.join('')).toBe(AGENT_USAGE);
  });

  it('exits 2 when a provider that needs a key has none, and names the variable', async () => {
    const io = capture();
    expect(await runAgent(['-p', 'x', '--provider', 'openai', '--project', root], io)).toBe(2);
    expect(io.err.join('')).toContain('CAOTANG_API_KEY');
    expect(io.out).toEqual([]);
  });
});

describe('the key', () => {
  const KEY = 'sk-live-0123456789abcdefSECRET';

  /** Every file under the project, as text. */
  const filesOf = (): string[] =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));

  const ARGS = ['-p', 'Draft the opening scene of The Friend.', '--provider', 'generic', '--base-url', 'https://llm.example.test/v1', '--model', 'test-model', '--project'] as const;

  it('goes to the provider’s endpoint from the variable --key-env names, and appears in no stdout, stderr or project file', async () => {
    const scripted = endpoint((_request, kind) => (kind === 'planner' ? DRAFT_THE_FRIEND : { kind: 'text', text: 'The friend arrives by boat, soaked.' }));
    for (const format of ['text', 'json', 'stream-json'] as const) {
      // A fresh folder for each format: the scene is drafted into the first.
      await seedProject(root);
      const io = capture({ env: { MY_KEY: KEY }, fetch: scripted.fetch });
      const code = await runAgent([...ARGS, root, '--key-env', 'MY_KEY', '--permission', 'approve-all', '--write', '--output-format', format], io);
      expect(code, io.err.join('')).toBe(0);
      const seen = JSON.stringify([io.out, io.err, filesOf()]);
      expect(seen).not.toContain(KEY);
      expect(seen).toContain('soaked');
    }
    expect(scripted.requests.length).toBeGreaterThan(0);
    expect(scripted.requests.every((request) => request.url.startsWith('https://llm.example.test/'))).toBe(true);
    expect(scripted.requests.every((request) => request.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('appears nowhere when the provider refuses it and echoes it back, and the turn needs input', async () => {
    const scripted = endpoint(() => ({ kind: 'error', status: 401, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}.` } }) }));
    const io = capture({ env: { CAOTANG_API_KEY: KEY }, fetch: scripted.fetch });
    const code = await runAgent([...ARGS, root, '--output-format', 'json'], io);
    expect(code).toBe(ExitCode.NeedsInput);
    expect(JSON.stringify([io.out, io.err, filesOf()])).not.toContain(KEY);
  });
});

describe('signals', () => {
  /** A provider that never answers until the request is aborted. */
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init?.signal?.aborted === true) abort();
      init?.signal?.addEventListener('abort', abort, { once: true });
    });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s ends the turn, releases the lock and exits %i', async (name, expected) => {
    const controller = new AbortController();
    let stoppedBy: 'SIGINT' | 'SIGTERM' | undefined;
    const io = capture({ fetch: hanging, signal: controller.signal, stoppedBy: () => stoppedBy });
    setTimeout(() => {
      stoppedBy = name;
      controller.abort();
    }, 200);
    const before = folderBytes(root);
    const code = await runAgent(['-p', 'Check the manuscript for continuity problems.', '--provider', 'generic', '--base-url', 'https://llm.example.test/v1', '--model', 'm', '--project', root], io);
    expect(code).toBe(expected);
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
    expect(folderBytes(root)).toEqual(before);
  }, 30_000);
});

describe('the router', () => {
  it('prints its usage for no command or --help, and refuses an unknown command with exit 2', async () => {
    const io = { ...capture(), untilDone: () => Promise.resolve() };
    expect(await main([], io)).toBe(0);
    expect(io.out.join('')).toContain('usage: caotang agent');
    const bad = { ...capture(), untilDone: () => Promise.resolve() };
    expect(await main(['frobnicate'], bad)).toBe(2);
    expect(bad.err.join('')).toContain('unknown command "frobnicate"');
  });

  it('forwards `mcp serve` to the MCP server’s command line: it holds the folder and stops when told to', async () => {
    const io = { ...capture(), untilDone: (stop: () => Promise<void>) => stop() };
    expect(await main(['mcp', 'serve', '--project', root, '--stdio'], io)).toBe(0);
    expect(io.err.join('')).toContain('caotang-mcp');
    expect(io.out).toEqual([]);
  });

  it('forwards `agent` to the agent command', async () => {
    const io = { ...capture(), untilDone: () => Promise.resolve() };
    expect(await main(['agent', '-p', DEMO_INTENTS.continuity, ...MOCK, root], io)).toBe(0);
  });
});
