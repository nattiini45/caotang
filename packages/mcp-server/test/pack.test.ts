/**
 * The MCPB bundle. The manifest rules are the ones an install would fail on, so they are checked here before the CLI sees
 * the file; the pack itself runs through the CLI this package pins, and the result is read back through that CLI too.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUNDLE_CJK_FONT, BUNDLE_EMOJI_FONT, BUNDLE_ENTRY, manifestProblems, mcpbCliPath, packBundle, runMcpb, stageBundle } from '../scripts/pack-mcpb.mjs';
import { removeDir, tempDir } from './support.js';

const PACKAGE_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const MANIFEST_PATH = join(PACKAGE_DIR, 'manifest.json');
const BUNDLE = { version: '0.1.0', files: [BUNDLE_ENTRY, 'manifest.json'] };

type Json = Record<string, unknown>;

function realManifest(): Json {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Json;
}

/** The manifest with one edit applied to a fresh copy, so no test changes another's input. */
function edited(change: (manifest: Json) => void): Json {
  const copy = realManifest();
  change(copy);
  return copy;
}

function serverOf(manifest: Json): Json {
  return manifest['server'] as Json;
}

function configOf(manifest: Json): Json {
  return serverOf(manifest)['mcp_config'] as Json;
}

function settingsOf(manifest: Json): Json {
  return manifest['user_config'] as Json;
}

describe('the bundle manifest', () => {
  it('is valid for the bundle it packs: stdio, the project folder, and writes off by default', () => {
    expect(manifestProblems(realManifest(), BUNDLE)).toEqual([]);
  });

  it('declares the package version, as the server advertises it', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string };
    expect(realManifest()['version']).toBe(pkg.version);
  });

  it('turns writes on from the user’s setting, never on the command line', () => {
    const config = configOf(realManifest());
    expect(config['args']).not.toContain('--allow-writes');
    expect(config['env']).toEqual({ CAOTANG_MCP_ALLOW_WRITES: '${user_config.allow_writes}' });
    expect(settingsOf(realManifest())['allow_writes']).toMatchObject({ type: 'boolean', default: false, required: false });
  });

  it.each<[string, (manifest: Json) => void, string]>([
    [
      'writes on by default',
      (m) => {
        (settingsOf(m)['allow_writes'] as Json)['default'] = true;
      },
      'default must be false',
    ],
    [
      'writes fixed on the command line',
      (m) => {
        (configOf(m)['args'] as string[]).push('--allow-writes');
      },
      '--allow-writes must not be fixed',
    ],
    [
      'no environment switch for writes',
      (m) => {
        delete configOf(m)['env'];
      },
      'CAOTANG_MCP_ALLOW_WRITES',
    ],
    [
      'no author',
      (m) => {
        delete m['author'];
      },
      'author.name is required',
    ],
    [
      'a version the package does not have',
      (m) => {
        m['version'] = '9.9.9';
      },
      'version is',
    ],
    [
      'an entry point the bundle does not have',
      (m) => {
        serverOf(m)['entry_point'] = 'server/other.mjs';
      },
      'server.entry_point must be',
    ],
    [
      'no stdio transport',
      (m) => {
        (configOf(m)['args'] as string[]).splice(2, 1);
      },
      'must run "serve --stdio"',
    ],
    [
      'a write setting the user must set',
      (m) => {
        (settingsOf(m)['allow_writes'] as Json)['required'] = true;
      },
      'must not be required',
    ],
  ])('refuses a manifest with %s', (_label, change, message) => {
    const problems = manifestProblems(edited(change), BUNDLE);
    expect(problems.join('\n')).toContain(message);
  });

  it('is refused as a whole when it is not an object', () => {
    expect(manifestProblems('not a manifest', BUNDLE)).toEqual(['the manifest is not a JSON object']);
  });
});

describe('the MCPB CLI this package pins', () => {
  it('is installed at the exact version declared in package.json, with no range', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    const declared = pkg.devDependencies['@anthropic-ai/mcpb'];
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    const installed = JSON.parse(readFileSync(join(PACKAGE_DIR, 'node_modules', '@anthropic-ai', 'mcpb', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(installed.version).toBe(declared);
    expect(existsSync(mcpbCliPath(PACKAGE_DIR))).toBe(true);
  });
});

describe('staging and packing', () => {
  it('stages nothing for a manifest that is not valid for the bundle', () => {
    const outDir = tempDir('pack-refused');
    try {
      const badManifest = join(outDir, 'manifest.json');
      writeFileSync(badManifest, JSON.stringify(edited((m) => void delete m['author'])));
      expect(() =>
        stageBundle({
          outDir,
          serverBundle: MANIFEST_PATH,
          manifestPath: badManifest,
          version: '0.1.0',
          notices: '# notices\n',
          license: join(REPO_ROOT, 'LICENSE'),
        }),
      ).toThrow('author.name is required');
      expect(existsSync(join(outDir, 'mcpb'))).toBe(false);
    } finally {
      removeDir(outDir);
    }
  });

  it('stages the CJK fallback font in server/fonts/, where the bundle reads it from', () => {
    const outDir = tempDir('pack-font');
    try {
      const font = join(outDir, 'NotoSansMonoCJKsc-Regular.otf');
      writeFileSync(font, 'OTTO fixture font');
      const { staging, files } = stageBundle({
        outDir,
        serverBundle: MANIFEST_PATH,
        manifestPath: MANIFEST_PATH,
        version: '0.1.0',
        notices: '# notices\n',
        license: join(REPO_ROOT, 'LICENSE'),
        cjkFont: font,
      });
      expect(BUNDLE_CJK_FONT).toBe('server/fonts/NotoSansMonoCJKsc-Regular.otf');
      expect(files).toContain(BUNDLE_CJK_FONT);
      expect(readFileSync(join(staging, BUNDLE_CJK_FONT), 'utf8')).toBe('OTTO fixture font');
      // The screenplay package resolves the font as ./fonts/ beside the running module, which is server/caotang-mcp.mjs.
      expect(BUNDLE_CJK_FONT.replace(/[^/]+$/, '')).toBe(BUNDLE_ENTRY.replace(/[^/]+$/, 'fonts/'));
    } finally {
      removeDir(outDir);
    }
  });

  it('stages the emoji fallback font in server/fonts/, beside the CJK one', () => {
    const outDir = tempDir('pack-emoji');
    try {
      const cjk = join(outDir, 'NotoSansMonoCJKsc-Regular.otf');
      const emoji = join(outDir, 'NotoEmoji-Regular.ttf');
      writeFileSync(cjk, 'OTTO fixture font');
      writeFileSync(emoji, 'TrueType fixture font');
      const { staging, files } = stageBundle({
        outDir,
        serverBundle: MANIFEST_PATH,
        manifestPath: MANIFEST_PATH,
        version: '0.1.0',
        notices: '# notices\n',
        license: join(REPO_ROOT, 'LICENSE'),
        cjkFont: cjk,
        emojiFont: emoji,
      });
      expect(BUNDLE_EMOJI_FONT).toBe('server/fonts/NotoEmoji-Regular.ttf');
      expect(files).toEqual(expect.arrayContaining([BUNDLE_CJK_FONT, BUNDLE_EMOJI_FONT]));
      expect(readFileSync(join(staging, BUNDLE_EMOJI_FONT), 'utf8')).toBe('TrueType fixture font');
      // The screenplay package resolves the font as ./fonts/ beside the running module, which is server/caotang-mcp.mjs.
      expect(BUNDLE_EMOJI_FONT.replace(/[^/]+$/, '')).toBe(BUNDLE_ENTRY.replace(/[^/]+$/, 'fonts/'));
    } finally {
      removeDir(outDir);
    }
  });

  it('packs a bundle through the pinned CLI, and the archive unpacks to the same four files with the same notices', () => {
    const outDir = tempDir('pack-run');
    const unpacked = tempDir('pack-unpacked');
    try {
      const serverBundle = join(outDir, 'caotang-mcp.mjs');
      writeFileSync(serverBundle, '#!/usr/bin/env node\nconsole.log("caotang-mcp fixture");\n');
      const notices = '# Third-party notices\n\nFixture notices for the pack test.\n';
      const { bundle, info } = packBundle({
        outDir,
        serverBundle,
        manifestPath: MANIFEST_PATH,
        version: '0.1.0',
        notices,
        license: join(REPO_ROOT, 'LICENSE'),
      });
      expect(bundle).toBe(join(outDir, 'caotang-mcp-0.1.0.mcpb'));
      expect(existsSync(bundle)).toBe(true);
      expect(info).toContain('caotang-mcp');

      runMcpb(['unpack', bundle, unpacked]);
      for (const file of [BUNDLE_ENTRY, 'manifest.json', 'THIRD-PARTY-NOTICES.md', 'LICENSE']) {
        expect(existsSync(join(unpacked, file)), `${file} is in the bundle`).toBe(true);
      }
      expect(readFileSync(join(unpacked, 'THIRD-PARTY-NOTICES.md'), 'utf8')).toBe(notices);
      expect(readFileSync(join(unpacked, 'manifest.json'), 'utf8')).toBe(readFileSync(MANIFEST_PATH, 'utf8'));
    } finally {
      removeDir(outDir);
      removeDir(unpacked);
    }
    // Four CLI processes (validate, pack, info, unpack): each is about a second on Windows, and more under a full parallel run.
  }, 60_000);
});
