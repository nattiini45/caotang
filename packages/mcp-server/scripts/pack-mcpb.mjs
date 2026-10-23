#!/usr/bin/env node
/* global process */
// The root lint config gives Node globals to tools/ and to TypeScript only. This script runs under Node and reads `process`,
// so it names that global here rather than widening the config for one file.
/**
 * Packs the MCP server as an MCPB bundle, `dist/caotang-mcp-<version>.mcpb` (extensibility.md §9: the `.mcpb` bundle is the
 * one-click install for a host that reads the format, and it runs the server over stdio, so the host's own process boundary
 * stands in for the bearer token).
 *
 * Run it as `pnpm --filter @caotang/mcp-server run pack`, which builds `dist/caotang-mcp.mjs` first. The bare `pack` is pnpm's own
 * tarball command, and it would never reach this script.
 *
 * The steps, each of which stops the pack when it fails:
 *  1. Stage `dist/mcpb/`: `server/caotang-mcp.mjs` (the built bundle), `server/fonts/` (the CJK, emoji, Arabic, Hebrew and Devanagari fonts
 *     both PDFs set text in: `@caotang/font-noto-cjk`, `@caotang/font-noto-emoji`, `@caotang/font-noto-arabic`,
 *     `@caotang/font-noto-hebrew` and `@caotang/font-noto-devanagari`, staged as `NotoSansMonoCJKsc-Regular.woff`,
 *     `NotoEmoji-Regular.woff`, `NotoSansArabic-Regular.ttf`, `NotoSansHebrew-Regular.ttf` and `NotoSansDevanagari-Regular.ttf`, where the Node loaders look first, packages/pdf-fonts/src/node-loader.ts),
 *     `server/webp_dec.wasm` (the WebP decoder of `@jsquash/webp`, beside the bundle, where the contact sheet's transcoder looks first,
 *     packages/exporter/src/picture-transcoder-node.ts), `manifest.json`,
 *     `THIRD-PARTY-NOTICES.md` for this bundle's production dependencies (tools/third-party-notices.mjs), and the repository's
 *     LICENSE.
 *  2. Check the manifest against what the bundle is: the version, the entry point, the settings the arguments read, and the
 *     write switch. Writes are not put on the command line, because a bundle cannot pass a flag conditionally; the manifest
 *     sets `CAOTANG_MCP_ALLOW_WRITES` from the user's "Allow changes" setting instead.
 *  3. Validate the manifest with the MCPB CLI this package pins (`@anthropic-ai/mcpb`).
 *  4. Pack the staged folder with that CLI, and read the result back with its `info` command.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');

/** The bundle's file names inside the archive. The manifest's entry point must be one of them. */
export const BUNDLE_ENTRY = 'server/caotang-mcp.mjs';
export const BUNDLE_MANIFEST = 'manifest.json';
export const BUNDLE_NOTICES = 'THIRD-PARTY-NOTICES.md';
export const BUNDLE_LICENSE = 'LICENSE';
/** The folder of the PDF fallback fonts, beside the server bundle. */
export const BUNDLE_FONTS = 'server/fonts';
/** The folder of the files the server reads beside its bundle: the WebP decoder. */
export const BUNDLE_SERVER = 'server';

/** The one switch a manifest must carry for writes: the setting it reads, and the variable it sets from it. */
export const WRITE_SETTING = 'allow_writes';
export const WRITE_VARIABLE = 'CAOTANG_MCP_ALLOW_WRITES';

/**
 * Every problem with a manifest for this bundle. An empty list means the manifest is one the bundle can run from. The
 * checks are the ones a wrong manifest would fail at install time, so they run here before the CLI sees the file.
 *
 * @param {unknown} manifest the parsed manifest.json
 * @param {{ version: string; files: readonly string[] }} bundle the version the package declares, and the files staged
 * @returns {string[]}
 */
export function manifestProblems(manifest, bundle) {
  const problems = [];
  if (!isRecord(manifest)) return ['the manifest is not a JSON object'];
  if (manifest['manifest_version'] !== '0.3') problems.push('manifest_version must be "0.3"');
  if (manifest['name'] !== 'caotang-mcp') problems.push('name must be "caotang-mcp"');
  if (manifest['version'] !== bundle.version) {
    problems.push(`version is ${JSON.stringify(manifest['version'])}, but the package is ${bundle.version}`);
  }
  if (!isRecord(manifest['author']) || typeof manifest['author']['name'] !== 'string') problems.push('author.name is required');

  const server = isRecord(manifest['server']) ? manifest['server'] : undefined;
  if (server === undefined) return [...problems, 'server is required'];
  if (server['type'] !== 'node') problems.push('server.type must be "node"');
  if (server['entry_point'] !== BUNDLE_ENTRY) problems.push(`server.entry_point must be "${BUNDLE_ENTRY}"`);
  if (typeof server['entry_point'] === 'string' && !bundle.files.includes(server['entry_point'])) {
    problems.push(`the bundle does not contain ${server['entry_point']}`);
  }

  const config = isRecord(server['mcp_config']) ? server['mcp_config'] : undefined;
  if (config === undefined || typeof config['command'] !== 'string') return [...problems, 'server.mcp_config.command is required'];
  const args = Array.isArray(config['args']) ? config['args'].filter((arg) => typeof arg === 'string') : [];
  if (!args.includes('serve') || !args.includes('--stdio')) problems.push('server.mcp_config.args must run "serve --stdio"');
  if (!args.includes('--project') || !args.includes('${user_config.project_folder}')) {
    problems.push('server.mcp_config.args must pass --project ${user_config.project_folder}');
  }
  if (args.includes('--allow-writes')) {
    problems.push('--allow-writes must not be fixed in args: writes are set by the user, through the environment variable');
  }
  const env = isRecord(config['env']) ? config['env'] : {};
  if (env[WRITE_VARIABLE] !== `\${user_config.${WRITE_SETTING}}`) {
    problems.push(`server.mcp_config.env.${WRITE_VARIABLE} must be "\${user_config.${WRITE_SETTING}}"`);
  }

  const settings = isRecord(manifest['user_config']) ? manifest['user_config'] : {};
  const writes = isRecord(settings[WRITE_SETTING]) ? settings[WRITE_SETTING] : undefined;
  if (writes === undefined) {
    problems.push(`user_config.${WRITE_SETTING} is required, so that writes are a setting the user chooses`);
  } else {
    if (writes['type'] !== 'boolean') problems.push(`user_config.${WRITE_SETTING}.type must be "boolean"`);
    if (writes['default'] !== false) problems.push(`user_config.${WRITE_SETTING}.default must be false: read-only until the user turns writes on`);
    if (writes['required'] === true) problems.push(`user_config.${WRITE_SETTING} must not be required`);
  }
  if (!isRecord(settings['project_folder']) || settings['project_folder']['type'] !== 'directory') {
    problems.push('user_config.project_folder must be a directory setting');
  }
  return problems;
}

/**
 * Writes the staged bundle folder. The bundle and the notices are copied in; the manifest is checked before it is copied,
 * so a wrong manifest never reaches the staging folder.
 *
 * @param {{ outDir: string; serverBundle: string; manifestPath: string; version: string; notices: string; license: string; fonts?: readonly string[]; serverFiles?: readonly string[] }} input
 * @returns {{ staging: string; files: string[] }}
 */
export function stageBundle(input) {
  const manifest = JSON.parse(readFileSync(input.manifestPath, 'utf8'));
  const problems = manifestProblems(manifest, { version: input.version, files: [BUNDLE_ENTRY, BUNDLE_MANIFEST] });
  if (problems.length > 0) throw new Error(`the manifest is not valid for this bundle:\n  - ${problems.join('\n  - ')}`);

  const staging = join(input.outDir, 'mcpb');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'server'), { recursive: true });
  copyFileSync(input.serverBundle, join(staging, BUNDLE_ENTRY));
  copyFileSync(input.manifestPath, join(staging, BUNDLE_MANIFEST));
  writeFileSync(join(staging, BUNDLE_NOTICES), input.notices);
  copyFileSync(input.license, join(staging, BUNDLE_LICENSE));
  const files = [BUNDLE_ENTRY, BUNDLE_MANIFEST, BUNDLE_NOTICES, BUNDLE_LICENSE];
  // The PDFs' fallback fonts, each under its own name.
  for (const font of input.fonts ?? []) {
    const staged = `${BUNDLE_FONTS}/${basename(font)}`;
    mkdirSync(join(staging, BUNDLE_FONTS), { recursive: true });
    copyFileSync(font, join(staging, staged));
    files.push(staged);
  }
  // The files the server reads beside its bundle, each under its own name.
  for (const file of input.serverFiles ?? []) {
    const staged = `${BUNDLE_SERVER}/${basename(file)}`;
    copyFileSync(file, join(staging, staged));
    files.push(staged);
  }
  return { staging, files };
}

/**
 * Where the pinned MCPB CLI's entry point is, in this package's own dependencies. The package does not export its
 * `package.json`, so the path is the one its `bin` entry names, and a missing install is reported as such.
 */
export function mcpbCliPath(packageDir = PACKAGE_DIR) {
  const cli = join(packageDir, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
  if (!existsSync(cli)) throw new Error(`the MCPB CLI is not installed at ${cli}: run pnpm install`);
  return cli;
}

/** Runs the MCPB CLI with the given arguments. A non-zero exit throws with what the CLI printed. */
export function runMcpb(args, options = {}) {
  const cli = options.cli ?? mcpbCliPath();
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: options.cwd ?? PACKAGE_DIR });
  if (result.status !== 0) {
    throw new Error(`mcpb ${args.join(' ')} exited ${result.status}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * The whole pack: stage, validate and pack. Returns the path of the bundle and what `mcpb info` reported. `notices` is the
 * text of THIRD-PARTY-NOTICES.md for this bundle; the CLI passes the generated one.
 */
export function packBundle(input) {
  const { staging } = stageBundle(input);
  runMcpb(['validate', join(staging, BUNDLE_MANIFEST)], input.mcpb === undefined ? {} : { cli: input.mcpb });
  const output = join(input.outDir, `caotang-mcp-${input.version}.mcpb`);
  rmSync(output, { force: true });
  runMcpb(['pack', staging, output], input.mcpb === undefined ? {} : { cli: input.mcpb });
  if (!existsSync(output) || statSync(output).size === 0) throw new Error(`the pack did not write ${output}`);
  const info = runMcpb(['info', output], input.mcpb === undefined ? {} : { cli: input.mcpb });
  return { bundle: output, info };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main() {
  const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  const outDir = join(PACKAGE_DIR, 'dist');
  const serverBundle = join(outDir, 'caotang-mcp.mjs');
  if (!existsSync(serverBundle)) {
    throw new Error(`${serverBundle} is missing: run the bundle build first (pnpm --filter @caotang/mcp-server build)`);
  }
  const { generateNotices } = await import('../../../tools/third-party-notices.mjs');
  const notices = generateNotices({ root: REPO_ROOT, filters: ['./packages/mcp-server'] });
  const result = packBundle({
    outDir,
    serverBundle,
    manifestPath: join(PACKAGE_DIR, BUNDLE_MANIFEST),
    version,
    notices,
    license: join(REPO_ROOT, 'LICENSE'),
    serverFiles: [createRequire(import.meta.url).resolve('@jsquash/webp/codec/dec/webp_dec.wasm')],
    fonts: [
      createRequire(import.meta.url).resolve('@caotang/font-noto-cjk/NotoSansMonoCJKsc-Regular.woff'),
      createRequire(import.meta.url).resolve('@caotang/font-noto-emoji/NotoEmoji-Regular.woff'),
      createRequire(import.meta.url).resolve('@caotang/font-noto-arabic/NotoSansArabic-Regular.ttf'),
      createRequire(import.meta.url).resolve('@caotang/font-noto-hebrew/NotoSansHebrew-Regular.ttf'),
      createRequire(import.meta.url).resolve('@caotang/font-noto-devanagari/NotoSansDevanagari-Regular.ttf'),
    ],
  });
  process.stdout.write(`packed ${result.bundle}\n${result.info}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`pack-mcpb: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
