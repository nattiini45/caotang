/**
 * The built binary, run as a process: `dist/caotang-mcp.mjs` is built here with the
 * package's own Vite config, started with `node`, and driven by the SDK's client over
 * Streamable HTTP and over stdio. This is the artifact a host runs, so it is what the
 * suite must prove works.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptConfirm,
  type Answer,
  connectClient,
  declineConfirm,
  HAND_WRITTEN_DOC,
  HAND_WRITTEN_DOC_NAME,
  removeDir,
  resultJson,
  seedProject,
  SHOTS_FOLDER,
  tempDir,
  TAVERN,
  testToken,
} from './support.js';
import { LOCK_FILE } from '../src/index.js';
import { webpFixture } from '../../exporter/test/webp-fixtures.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(PACKAGE, 'dist', 'caotang-mcp.mjs');

/** Resolves once `pattern` appears in what the child wrote to stderr, or rejects after `ms`. */
function waitForStderr(child: ChildProcess, pattern: RegExp, ms = 20_000): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`no ${pattern} on stderr within ${ms} ms; saw: ${seen}`)), ms);
    child.stderr?.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8');
      const match = seen.match(pattern);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the process exited (${code}) before ${pattern}; saw: ${seen}`));
    });
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/** The exit code, or a rejection when the process has not exited within `ms`. */
function exitedWithin(child: ChildProcess, ms: number): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the process did not exit within ${ms} ms`)), ms);
  });
  return Promise.race([exited(child), late]).finally(() => clearTimeout(timer));
}

/** How many tree nodes carry this title in the folder's manifest, read from disk. */
function nodesTitled(folder: string, title: string): number {
  const manifest = JSON.parse(readFileSync(join(folder, 'caotang.json'), 'utf8')) as { tree: { title: string }[] };
  return manifest.tree.filter((node) => node.title === title).length;
}

/**
 * A host over stdio: the bundle is its child process, with writes on, and the SDK's client speaks
 * to it on the 2026-07-28 revision, or on the 2025-era handshake with `legacy`. With `answer` the
 * host declares elicitation and answers it.
 */
async function stdioHost(folder: string, answer?: Answer, legacy = false): Promise<Client> {
  const client = new Client(
    { name: 'caotang-stdio-host', version: '0.0.0' },
    {
      capabilities: answer === undefined ? {} : { elicitation: {} },
      versionNegotiation: legacy ? { mode: 'legacy' } : { mode: { pin: '2026-07-28' } },
    },
  );
  if (answer !== undefined) client.setRequestHandler('elicitation/create', (request) => answer(request.params));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE, 'serve', '--project', folder, '--create', 'Stdio Book', '--allow-writes', '--stdio'],
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
      stderr: 'pipe',
    }),
  );
  return client;
}

describe('the built caotang-mcp binary', () => {
  let root: string;

  beforeAll(async () => {
    await build({ root: PACKAGE, configFile: join(PACKAGE, 'vite.config.ts'), logLevel: 'silent' });
    root = tempDir('binary');
  }, 240_000);

  afterAll(() => {
    removeDir(root);
  });

  it('is a single file, and it runs: --help prints the usage on stdout and exits 0', async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    expect(statSync(BUNDLE).size).toBeGreaterThan(100_000);
    const child = spawn(process.execPath, [BUNDLE, '--help']);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    expect(await exited(child)).toBe(0);
    expect(stdout).toContain('usage: caotang-mcp serve');
  }, 60_000);

  it('reads the PDFs’ fallback fonts from fonts/ beside the bundle, which the pack stages, and builds none of its own', () => {
    const bundle = readFileSync(BUNDLE, 'utf8');
    // The Node loader's first candidate is fonts/<file> beside the running module (packages/pdf-fonts/src/node-loader.ts);
    // the pack script copies the one CJK and the one emoji file there. The build itself emits no font.
    expect(bundle).toMatch(/["']fonts["'], file/);
    expect(bundle).not.toMatch(/new URL\((["'])\.\/fonts\//);
    expect(existsSync(join(PACKAGE, 'dist', 'fonts'))).toBe(false);
  });

  it('reads the WebP decoder from beside the bundle, which the pack stages, and emits none of its own', () => {
    const bundle = readFileSync(BUNDLE, 'utf8');
    // The transcoder's first candidate is webp_dec.wasm beside the running module (packages/exporter/src/picture-transcoder-node.ts).
    expect(bundle).toMatch(/WEBP_DECODER_FILE = ["']webp_dec\.wasm["']/);
    expect(readdirSync(join(PACKAGE, 'dist')).filter((name) => name.endsWith('.wasm'))).toEqual([]);
  });

  it('serves a project over Streamable HTTP with the token from the environment, and answers with real data', async () => {
    const token = testToken();
    const child = spawn(
      process.execPath,
      [BUNDLE, 'serve', '--project', join(root, 'http'), '--create', 'Spawned Book', '--port', '0'],
      { env: { ...process.env, CAOTANG_MCP_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    try {
      const [, url] = await waitForStderr(child, /MCP endpoint (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
      expect(url).toBeDefined();
      const client = await connectClient(url ?? '', token);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toContain('project.overview');
        expect(tools.map((tool) => tool.name)).not.toContain('doc.import');
        const overview = await client.callTool({ name: 'project.overview', arguments: {} });
        expect(resultJson(overview)['summary']).toBe('"Spawned Book": 0 documents, 0 words');
      } finally {
        await client.close();
      }
      expect(stdout).toBe('');
    } finally {
      child.kill();
      await exited(child);
    }
  }, 120_000);

  it('answers a wrong token with 401 on the built binary too', async () => {
    const token = testToken();
    const child = spawn(
      process.execPath,
      [BUNDLE, 'serve', '--project', join(root, 'auth'), '--create', 'Guarded', '--port', '0'],
      { env: { ...process.env, CAOTANG_MCP_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const [, url] = await waitForStderr(child, /MCP endpoint (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
      const response = await fetch(url ?? '', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${testToken()}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(401);
    } finally {
      child.kill();
      await exited(child);
    }
  }, 120_000);

  it('serves over stdio when --stdio is given: a host lists the tools and reads the tree', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE, 'serve', '--project', join(root, 'stdio'), '--create', 'Piped Book', '--stdio'],
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'caotang-stdio-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('binder.read_tree');
      const tree = await client.callTool({ name: 'binder.read_tree', arguments: { root: 'manuscript', depth: 1 } });
      expect(JSON.stringify(resultJson(tree))).toContain('manuscript');
    } finally {
      await client.close();
    }
  }, 120_000);

  it('compiles Ink in the single file: the Ink compiler is loaded before the project opens, so dialogue.table and the branch checks answer', async () => {
    const folder = join(root, 'stdio-dialogue');
    await seedProject(folder, 'Dialogue Book', { dialogue: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE, 'serve', '--project', folder, '--stdio'],
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'caotang-stdio-dialogue', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const table = await client.callTool({ name: 'dialogue.table', arguments: { doc: TAVERN } });
      expect(table.isError).toBeFalsy();
      expect(JSON.stringify(resultJson(table))).toContain('Ah, a traveller.');
      const scan = await client.callTool({ name: 'coherence.scan', arguments: {} });
      expect(scan.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  }, 120_000);

  it('serves the resources and prompts from the bundle too: the context assembly is in the single file', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE, 'serve', '--project', join(root, 'stdio-resources'), '--create', 'Resource Book', '--stdio'],
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'caotang-stdio-resources', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toEqual(['caotang://project', 'caotang://binder', 'caotang://codex']);
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toContain('continuity-check');
      expect(client.getServerCapabilities()?.resources?.subscribe).toBeFalsy();
    } finally {
      await client.close();
    }
  }, 120_000);

  it('ends with exit 0 when the host closes stdin, and writes nothing to stdout', async () => {
    const child = spawn(process.execPath, [BUNDLE, 'serve', '--project', join(root, 'stdio-eof'), '--create', 'Eof Book', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    try {
      // The stop listener is attached before the last start line is written, so the line is the signal that stdin is watched.
      await waitForStderr(child, /caotang-mcp: writes are (on|off)/);
      child.stdin?.end();
      expect(await exitedWithin(child, 20_000)).toBe(0);
      expect(stdout).toBe('');
    } finally {
      child.kill();
      await exited(child);
    }
  }, 120_000);

  it('over stdio, a 2026-pinned host that accepts a write-confirm gets exactly one document', async () => {
    const folder = join(root, 'stdio-accept');
    const host = await stdioHost(folder, acceptConfirm);
    try {
      const result = await host.callTool({
        name: 'doc.import',
        arguments: { parent: 'research', title: 'Over Stdio', body: 'Written through the host.' },
      });
      expect(result.isError).not.toBe(true);
      expect(nodesTitled(folder, 'Over Stdio')).toBe(1);
    } finally {
      await host.close();
    }
  }, 120_000);

  it('compiles a contact sheet with a WebP picture in the single file, the decoder read from @jsquash/webp', async () => {
    const folder = join(root, 'stdio-webp');
    await seedProject(folder, 'Stdio Book', { shot: true, shotImage: 'a_7WEBP4K2QX' });
    mkdirSync(join(folder, 'assets'), { recursive: true });
    writeFileSync(join(folder, 'assets', 'a_7WEBP4K2QX.webp'), webpFixture('lossless'));
    const host = await stdioHost(folder, acceptConfirm);
    try {
      const result = await host.callTool({
        name: 'export.compile',
        arguments: { selection: { root: SHOTS_FOLDER, includeSubtrees: true }, format: 'contact-sheet-pdf' },
      });
      expect(result.isError).not.toBe(true);
      const pdf = readdirSync(join(folder, 'exports')).filter((name) => name.endsWith('.pdf'));
      expect(pdf).toHaveLength(1);
      const bytes = readFileSync(join(folder, 'exports', pdf[0] ?? '')).toString('latin1');
      expect(bytes.match(/\/Subtype \/Image/g)).toHaveLength(1);
      expect(bytes).toMatch(/\/Width 80\b/);
    } finally {
      await host.close();
    }
  }, 120_000);

  it('over stdio, a 2025-era host that declares elicitation and accepts a write-confirm gets exactly one document', async () => {
    const folder = join(root, 'stdio-legacy-accept');
    const host = await stdioHost(folder, acceptConfirm, true);
    try {
      const result = await host.callTool({
        name: 'doc.import',
        arguments: { parent: 'research', title: 'Legacy Stdio', body: 'Written by a 2025-era host.' },
      });
      expect(result.isError).not.toBe(true);
      expect(nodesTitled(folder, 'Legacy Stdio')).toBe(1);
    } finally {
      await host.close();
    }
  }, 120_000);

  it('over stdio, a 2026-pinned host that declines a write-confirm gets none, and is told nothing was written', async () => {
    const folder = join(root, 'stdio-decline');
    const host = await stdioHost(folder, declineConfirm);
    try {
      const result = await host.callTool({
        name: 'doc.import',
        arguments: { parent: 'research', title: 'Declined', body: 'Never written.' },
      });
      expect(JSON.stringify(result.structuredContent)).toContain('"written":false');
      expect(nodesTitled(folder, 'Declined')).toBe(0);
    } finally {
      await host.close();
    }
  }, 120_000);

  it('over stdio, a host that did not declare elicitation is refused a write-confirm, and nothing is written', async () => {
    const folder = join(root, 'stdio-no-elicit');
    const host = await stdioHost(folder);
    try {
      const result = await host.callTool({
        name: 'doc.import',
        arguments: { parent: 'research', title: 'Refused', body: 'Never written.' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('did not declare elicitation support');
      expect(nodesTitled(folder, 'Refused')).toBe(0);
    } finally {
      await host.close();
    }
  }, 120_000);

  it('refuses --create over a folder of documents with no caotang.json: exit 2, and the documents are untouched', async () => {
    const folder = join(root, 'orphans');
    mkdirSync(join(folder, 'docs'), { recursive: true });
    const orphan = join(folder, 'docs', HAND_WRITTEN_DOC_NAME);
    writeFileSync(orphan, HAND_WRITTEN_DOC);
    const child = spawn(process.execPath, [BUNDLE, 'serve', '--project', folder, '--create', 'Recovered', '--port', '0'], {
      env: { ...process.env, CAOTANG_MCP_TOKEN: testToken() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    expect(await exitedWithin(child, 60_000)).toBe(2);
    expect(stderr).toContain('Open this folder in Caotang');
    expect(readFileSync(orphan, 'utf8')).toBe(HAND_WRITTEN_DOC);
    expect(existsSync(join(folder, 'caotang.json'))).toBe(false);
  }, 120_000);

  it('gives a stale lock to exactly one of the servers that start on the folder at once', async () => {
    const folder = join(root, 'contended');
    await seedProject(folder, 'Contended');
    // A lock whose holder has exited: the case every writer is entitled to take over.
    const gone = spawn(process.execPath, ['-e', '']);
    const pid = gone.pid;
    if (pid === undefined) throw new Error('could not start a child process');
    await new Promise<void>((done) => gone.once('exit', () => done()));
    writeFileSync(join(folder, LOCK_FILE), JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));

    const running = Array.from({ length: 8 }, () =>
      spawn(process.execPath, [BUNDLE, 'serve', '--project', folder, '--port', '0'], {
        env: { ...process.env, CAOTANG_MCP_TOKEN: testToken() },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    // The line a server writes once it holds the folder and has its endpoint. A server
    // the lock refuses says so and exits 3, and never writes one.
    const outcomes = await Promise.all(
      running.map(async (child) => {
        try {
          await waitForStderr(child, /MCP endpoint http:\/\/127\.0\.0\.1:\d+/, 60_000);
          return { held: true, reason: 'it took the folder' };
        } catch (error) {
          return { held: false, reason: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    for (const child of running) {
      child.kill();
      await exited(child);
    }
    // The count is what this test is about. The reasons say which of the eight servers took the
    // folder and which refused it, and why, when the count is not one.
    expect(
      outcomes.filter((outcome) => outcome.held).length,
      `every server that took the folder is a writer of it: ${outcomes.map((outcome) => outcome.reason).join('; ')}`,
    ).toBe(1);
  }, 180_000);
});
