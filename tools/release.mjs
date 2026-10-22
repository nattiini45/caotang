#!/usr/bin/env node
/**
 * What .github/workflows/release.yml asks of the repository when a `v*` tag is pushed.
 *
 *   node tools/release.mjs check <tag>      fails unless the tag names the version in packages/mcp-server/package.json,
 *                                           packages/mcp-server/manifest.json and server.json
 *   node tools/release.mjs notes <version>  prints the CHANGELOG.md section of that version, for the release notes
 *
 * The release asset is built from the tagged source, so a tag that disagrees with those three files would publish a bundle
 * whose name, manifest and registry entry say different things.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const TAG = /^v\d+\.\d+\.\d+$/;

/** The ways a tag disagrees with the versions the release would ship; empty when it is fit to release. */
export function tagProblems(tag, versions) {
  if (!TAG.test(tag)) return [`the tag "${tag}" must look like v1.2.3`];
  const version = tag.slice(1);
  const files = [
    ['packages/mcp-server/package.json', versions.packageVersion],
    ['packages/mcp-server/manifest.json', versions.manifestVersion],
    ['server.json', versions.serverVersion],
  ];
  return files.filter(([, have]) => have !== version).map(([file, have]) => `${file} is at ${JSON.stringify(have)}, but the tag is ${tag}`);
}

/** The body of the `## <version>` section of a changelog, or undefined when it has none. */
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n').map((line) => line.trimEnd());
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let at = start + 1; at < lines.length; at += 1) {
    if (lines[at].startsWith('## ')) {
      end = at;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
}

function main(argv) {
  const [command, value] = argv;
  if (command === 'check' && value !== undefined) {
    const problems = tagProblems(value, {
      packageVersion: readJson('packages/mcp-server/package.json').version,
      manifestVersion: readJson('packages/mcp-server/manifest.json').version,
      serverVersion: readJson('server.json').version,
    });
    for (const problem of problems) console.error(problem);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === 'notes' && value !== undefined) {
    const section = changelogSection(readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8'), value);
    if (section === undefined || section === '') {
      console.error(`CHANGELOG.md has no section "## ${value}" with text in it`);
      return 1;
    }
    console.log(section);
    return 0;
  }
  console.error('usage: node tools/release.mjs check <tag> | notes <version>');
  return 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
