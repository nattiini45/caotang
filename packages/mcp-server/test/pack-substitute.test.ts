/**
 * What a host does with the `.mcpb` manifest: substitute `${__dirname}` and the `${user_config.*}`
 * values, then run the server's own command line over stdio. The paths are the ones hosts fail on,
 * a folder with a space and Chinese characters in it, so the substitution is proven with weird
 * paths and not only with a tidy temporary one.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packBundle, runMcpb } from '../scripts/pack-mcpb.mjs';
import { removeDir, resultJson, seedProject, tempDir } from './support.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const MANIFEST_PATH = join(PACKAGE_DIR, 'manifest.json');
const ROOT_NODE_RANGE = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node;

type Json = Record<string, unknown>;

interface HostConfig {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/** Fills every `${name}` a host would fill, and fails on one it would not (a manifest cannot rely on the shell). */
function substitute(value: string, variables: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    const filled = variables[name];
    if (filled === undefined) throw new Error(`the manifest names ${match}, which this host does not fill`);
    return filled;
  });
}

/**
 * Starts the unpacked bundle the way a host does: the manifest's command, each argument as its own
 * argv entry (no shell), and its environment. `allowWrites` is the user's "Allow changes" setting.
 */
async function hostFromBundle(unpacked: string, project: string, allowWrites: boolean): Promise<Client> {
  const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8')) as Json;
  const server = manifest['server'] as Json;
  const config = server['mcp_config'] as HostConfig;
  expect(config.command).toBe('node');
  const variables = {
    __dirname: unpacked,
    'user_config.project_folder': project,
    'user_config.allow_writes': String(allowWrites),
  };
  const args = config.args.map((arg) => substitute(arg, variables));
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' };
  for (const [key, value] of Object.entries(config.env ?? {})) env[key] = substitute(String(value), variables);
  const client = new Client({ name: 'caotang-bundle-host', version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, env, stderr: 'pipe' }));
  return client;
}

describe('the .mcpb manifest, as a host runs it', () => {
  let root = '';
  let unpacked = '';
  let project = '';

  beforeAll(async () => {
    root = tempDir('pack substitution');
    // Both paths carry the two things a host has historically mangled: a space, and Chinese characters.
    unpacked = join(root, 'caotang mcpb 测试');
    project = join(root, '我的 小说 Project');
    await seedProject(project, 'Subject Book');
    // Built into this test's own folder, so it cannot race the binary suite's build of `dist/`.
    const buildDir = join(root, 'build');
    await build({
      root: PACKAGE_DIR,
      configFile: join(PACKAGE_DIR, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir: buildDir, emptyOutDir: true },
    });
    const packed = packBundle({
      outDir: join(root, 'out'),
      serverBundle: join(buildDir, 'caotang-mcp.mjs'),
      manifestPath: MANIFEST_PATH,
      version: '0.1.0',
      nodeRange: ROOT_NODE_RANGE,
      notices: '# Third-party notices\n',
      license: join(REPO_ROOT, 'LICENSE'),
    });
    expect(statSync(packed.bundle).size).toBeGreaterThan(0);
    runMcpb(['unpack', packed.bundle, unpacked]);
  }, 300_000);

  afterAll(() => {
    if (root !== '') removeDir(root);
  });

  it('opens a project at a path with a space and CJK characters, read-only, and lists 13 tools', async () => {
    const client = await hostFromBundle(unpacked, project, false);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(13);
      const tree = resultJson(await client.callTool({ name: 'binder.read_tree', arguments: { root: 'root', depth: 3, include: 'counts' } }));
      expect(JSON.stringify(tree)).toContain('The Landing');
      expect(JSON.stringify(tree)).toContain('Subject Book');
    } finally {
      await client.close();
    }
  });

  it('turns writes on from the manifest setting, and lists 36 tools', async () => {
    const client = await hostFromBundle(unpacked, project, true);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(36);
      expect(tools.map((tool) => tool.name)).toContain('notes.append');
    } finally {
      await client.close();
    }
  });
});
