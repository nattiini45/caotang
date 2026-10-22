/**
 * The command line: the flags it accepts, the ones it refuses, and the run sequence a
 * `serve` goes through — the token printed once, the lock taken and released, and the
 * exit codes that tell an operator what went wrong.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquireProjectLock, DEFAULT_PORT, parseServeArgs, runCli, UsageError, type RunIo } from '../src/index.js';
import { HAND_WRITTEN_DOC, HAND_WRITTEN_DOC_NAME, brokenFolder, removeDir, seedProject, tempDir } from './support.js';

function captureIo(env: NodeJS.ProcessEnv = {}): { io: RunIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: RunIo = {
    env,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    // Stops at once: a serve starts, prints its start lines, and shuts down again.
    untilDone: async (stop) => {
      await stop();
    },
  };
  return { io, out, err };
}

describe('parseServeArgs', () => {
  it('reads a serve command with its defaults: read-only, the default port, the default token variable', () => {
    expect(parseServeArgs(['serve', '--project', '/srv/books/a'])).toEqual({
      project: '/srv/books/a',
      allowWrites: false,
      port: DEFAULT_PORT,
      tokenEnv: 'CAOTANG_MCP_TOKEN',
      stdio: false,
    });
  });

  it('reads every flag it names', () => {
    expect(
      parseServeArgs(['serve', '--project', 'p', '--create', 'Book', '--allow-writes', '--port', '0', '--token-env', 'MY_TOKEN']),
    ).toEqual({ project: 'p', create: 'Book', allowWrites: true, port: 0, tokenEnv: 'MY_TOKEN', stdio: false });
  });

  it('reads --stdio with no port and no token', () => {
    expect(parseServeArgs(['serve', '--project', 'p', '--stdio'])).toMatchObject({ stdio: true });
  });

  it('answers help when asked, or when no command is given', () => {
    expect(parseServeArgs([])).toBe('help');
    expect(parseServeArgs(['--help'])).toBe('help');
    expect(parseServeArgs(['serve', '-h'])).toBe('help');
  });

  it.each([
    ['no project', ['serve']],
    ['an empty project', ['serve', '--project', '  ']],
    ['a port that is not a number', ['serve', '--project', 'p', '--port', 'abc']],
    ['a port past the range', ['serve', '--project', 'p', '--port', '70000']],
    ['a token variable that is not a name', ['serve', '--project', 'p', '--token-env', '1BAD NAME']],
    ['stdio with a port', ['serve', '--project', 'p', '--stdio', '--port', '9000']],
    ['stdio with a token variable', ['serve', '--project', 'p', '--stdio', '--token-env', 'X_TOKEN']],
    ['an unknown flag', ['serve', '--project', 'p', '--delete-everything']],
    ['an unknown command', ['delete', '--project', 'p']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseServeArgs(argv)).toThrow(UsageError);
  });
});

describe('runCli', () => {
  it('prints the usage and exits 0 for help', async () => {
    const { io, out } = captureIo();
    expect(await runCli(['--help'], io)).toBe(0);
    expect(out.join('')).toContain('usage: caotang-mcp serve');
  });

  it('exits 2 for a command line it cannot run, and says what to change', async () => {
    const { io, err } = captureIo();
    expect(await runCli(['serve'], io)).toBe(2);
    expect(err.join('')).toContain('--project <dir> is required');
  });

  it('exits 2 for a folder with no project and no --create, and makes nothing in it', async () => {
    const root = tempDir('cli-missing');
    try {
      const { io, err } = captureIo();
      expect(await runCli(['serve', '--project', root, '--port', '0'], io)).toBe(2);
      expect(err.join('')).toContain('no Caotang project');
      expect(existsSync(join(root, 'caotang.json'))).toBe(false);
    } finally {
      removeDir(root);
    }
  });

  it('exits 2 for a folder of documents with no caotang.json, tells the operator to open it in Caotang, and changes nothing', async () => {
    const root = tempDir('cli-orphans');
    try {
      mkdirSync(join(root, 'docs'), { recursive: true });
      const orphan = join(root, 'docs', HAND_WRITTEN_DOC_NAME);
      writeFileSync(orphan, HAND_WRITTEN_DOC);
      const { io, err } = captureIo();
      expect(await runCli(['serve', '--project', root, '--create', 'Recovered', '--port', '0'], io)).toBe(2);
      expect(err.join('')).toContain('Open this folder in Caotang');
      expect(readFileSync(orphan, 'utf8')).toBe(HAND_WRITTEN_DOC);
      expect(existsSync(join(root, 'caotang.json'))).toBe(false);
    } finally {
      removeDir(root);
    }
  });

  it('exits 3 when another writer holds the folder', async () => {
    const root = tempDir('cli-locked');
    try {
      await seedProject(root, 'Held');
      const holder = await acquireProjectLock(root);
      try {
        const { io, err } = captureIo();
        expect(await runCli(['serve', '--project', root, '--port', '0'], io)).toBe(3);
        expect(err.join('')).toContain('in use by another writer');
      } finally {
        await holder.release();
      }
    } finally {
      removeDir(root);
    }
  });

  it('starts, says where it listens and whether writes are on, prints a minted token once, and stops cleanly', async () => {
    const root = tempDir('cli-run');
    try {
      const { io, out, err } = captureIo({});
      expect(await runCli(['serve', '--project', root, '--create', 'Run Book', '--port', '0'], io)).toBe(0);
      const log = err.join('');
      expect(log).toContain('project "Run Book"');
      expect(log).toMatch(/MCP endpoint http:\/\/127\.0\.0\.1:\d+\/mcp/);
      expect(log).toContain('writes are off');
      expect(log.match(/bearer token \(shown once/g)).toHaveLength(1);
      expect(log).toContain('stopped');
      expect(out.join('')).toBe('');
      expect(existsSync(join(root, '.caotang-mcp.lock'))).toBe(false);
      expect(existsSync(join(root, 'caotang.json'))).toBe(true);
    } finally {
      removeDir(root);
    }
  });

  it('does not print an operator-supplied token, and says it was taken from the variable', async () => {
    const root = tempDir('cli-env');
    try {
      const supplied = 'operator-supplied-token-0123';
      const { io, err } = captureIo({ CAOTANG_MCP_TOKEN: supplied });
      expect(await runCli(['serve', '--project', root, '--create', 'Env', '--port', '0', '--allow-writes'], io)).toBe(0);
      const log = err.join('');
      expect(log).not.toContain(supplied);
      expect(log).toContain('bearer token taken from CAOTANG_MCP_TOKEN');
      expect(log).toContain('writes are on');
    } finally {
      removeDir(root);
    }
  });

  it.each([
    ['true', 'writes are on', 'is "true"'],
    ['false', 'writes are off', 'is "false"'],
    ['1', 'writes are off', 'is other (not "true", so it does not turn writes on)'],
    ['', 'writes are off', 'is other (not "true", so it does not turn writes on)'],
    ['${user_config.allow_writes}', 'writes are off', 'is other (not "true", so it does not turn writes on)'],
  ])('reads CAOTANG_MCP_ALLOW_WRITES=%j as %s and logs it as %s, so the MCPB bundle can set writes from its settings', async (value, expected, classified) => {
    const root = tempDir('cli-allow-env');
    try {
      const { io, err } = captureIo({ CAOTANG_MCP_ALLOW_WRITES: value, CAOTANG_MCP_TOKEN: 'env-token-for-the-allow-test-0123' });
      expect(await runCli(['serve', '--project', root, '--create', 'Env Writes', '--port', '0'], io)).toBe(0);
      const log = err.join('');
      expect(log).toContain(expected);
      expect(log).toContain(`caotang-mcp: CAOTANG_MCP_ALLOW_WRITES ${classified}`);
      if (value.includes('$')) expect(log).not.toContain(value);
    } finally {
      removeDir(root);
    }
  });

  it('logs CAOTANG_MCP_ALLOW_WRITES as unset when the variable is absent, over stdio too', async () => {
    const root = tempDir('cli-allow-unset');
    try {
      const { io, err } = captureIo({});
      expect(await runCli(['serve', '--stdio', '--project', root, '--create', 'Unset'], io)).toBe(0);
      const log = err.join('');
      expect(log).toContain('caotang-mcp: CAOTANG_MCP_ALLOW_WRITES is unset');
      expect(log).toContain('writes are off');
    } finally {
      removeDir(root);
    }
  });
});

describe('runCli on a folder whose caotang.json will not load', () => {
  it('starts without a project instead of exiting 1, says what the ladder found, the way forward and the lock, and releases the lock on stop', async () => {
    const root = await brokenFolder('cli-degraded', 'snapshot');
    try {
      const before = readFileSync(join(root, 'caotang.json'), 'utf8');
      const { io, err } = captureIo({});
      expect(await runCli(['serve', '--project', root, '--port', '0'], io)).toBe(0);
      const log = err.join('');
      expect(log).toContain('no project is open');
      expect(log).toContain('caotang.json.bak.1');
      expect(log).toContain('restart caotang-mcp with --allow-writes');
      expect(log).toContain("holds the folder's lock");
      expect(log).toMatch(/MCP endpoint http:\/\/127\.0\.0\.1:\d+\/mcp/);
      expect(log).not.toContain('could not open the project');
      expect(log).toContain('stopped');
      expect(existsSync(join(root, '.caotang-mcp.lock'))).toBe(false);
      expect(readFileSync(join(root, 'caotang.json'), 'utf8')).toBe(before);
    } finally {
      removeDir(root);
    }
  });

  it('with --allow-writes it points at project.recoverApply, and --create does not replace the manifest', async () => {
    const root = await brokenFolder('cli-degraded-writes', 'rebuild');
    try {
      const before = readFileSync(join(root, 'caotang.json'), 'utf8');
      const { io, err } = captureIo({});
      expect(await runCli(['serve', '--stdio', '--project', root, '--create', 'Not Used', '--allow-writes'], io)).toBe(0);
      const log = err.join('');
      expect(log).toContain('project.recoverApply');
      expect(log).toContain('a rebuild');
      expect(log).toContain('writes are on');
      expect(readFileSync(join(root, 'caotang.json'), 'utf8')).toBe(before);
    } finally {
      removeDir(root);
    }
  });

  it('states the honest bound for a folder with nothing to recover from, and offers no write', async () => {
    const root = await brokenFolder('cli-degraded-bare', 'bare');
    try {
      const { io, err } = captureIo({});
      expect(await runCli(['serve', '--project', root, '--allow-writes', '--port', '0'], io)).toBe(0);
      const log = err.join('');
      expect(log).toContain('Caotang could not find a readable copy of this project');
      expect(log).not.toContain('project.recoverApply');
    } finally {
      removeDir(root);
    }
  });

  it('still refuses a manifest of another app outright: exit 1, nothing offered, no lock left', async () => {
    const root = tempDir('cli-refused');
    try {
      await seedProject(root, 'Other');
      const path = join(root, 'caotang.json');
      writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, 'utf8')) as object), app: 'other' }));
      const { io, err } = captureIo({});
      expect(await runCli(['serve', '--project', root, '--port', '0'], io)).toBe(1);
      expect(err.join('')).toContain('could not open the project');
      expect(existsSync(join(root, '.caotang-mcp.lock'))).toBe(false);
    } finally {
      removeDir(root);
    }
  });
});
