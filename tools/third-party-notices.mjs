#!/usr/bin/env node
/**
 * THIRD-PARTY-NOTICES.md, generated from the production dependency tree of what Caotang ships.
 *
 * Run: `node tools/third-party-notices.mjs --write` (writes ./THIRD-PARTY-NOTICES.md). The file is not edited by hand: the test in
 * packages/mcp-server/test/third-party-notices.test.ts regenerates it and fails when the committed copy has drifted from the lockfile.
 *
 * What it covers. The shipped artefacts are the desktop build (apps/desktop, Vite into dist/) and the MCP server bundle
 * (packages/mcp-server, one file, with its dependencies inlined). Their production dependencies are read from
 * `pnpm list --prod`, which walks the same lockfile the build uses, so the list cannot name a package the build does not
 * contain. Development tools are not shipped, so they are not listed. Caotang's own packages are MIT, under LICENSE, and
 * are not repeated here.
 *
 * Why each license text is kept. MIT and Apache-2.0 both require the copyright notice and the license to travel with
 * copies of the software, and Apache-2.0 also requires a NOTICE file to be carried when the package has one. So each
 * package's own license file is reproduced. A package with no license file whose README carries the license gets that
 * section verbatim (README_LICENSE_OVERRIDES); any other package with no license file says so and names its declared license.
 *
 * Windows. pnpm's `.cmd` shim cannot be spawned directly from node on Windows, so the call goes through `cmd /c`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The workspace packages whose production closure ships. Paths are relative to the repository root. */
export const SHIPPED_FILTERS = ['./apps/desktop', './packages/mcp-server'];

/** The file name the notices take, in the repository and beside every build that ships them. */
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.md';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i;

/**
 * Third-party files that ship inside a Caotang package rather than as a dependency, so the lockfile does not list them. Each
 * names the file it ships as, its license, its source, and the license text kept beside it in the repository (a path from the
 * repository root), which is reproduced in full. The screenplay PDF embeds Courier Prime, a subset of Noto Sans Mono CJK SC
 * for the characters Courier Prime cannot print, and a subset of Noto Emoji for emoji (docs/architecture/screenplay.md §5.3).
 */
export const BUNDLED_ASSETS = Object.freeze([
  Object.freeze({
    name: 'Courier Prime Regular (font)',
    version: '3.018',
    license: 'OFL-1.1',
    repository: 'https://github.com/quoteunquoteapps/CourierPrime',
    shippedAs: 'packages/screenplay/src/fonts/courier-prime-regular.ts',
    licenseFile: 'packages/screenplay/src/fonts/OFL.txt',
  }),
  Object.freeze({
    name: 'Noto Sans Mono CJK SC Regular (font)',
    version: '2.004',
    license: 'OFL-1.1',
    repository: 'https://github.com/notofonts/noto-cjk',
    shippedAs: 'packages/screenplay/src/fonts/NotoSansMonoCJKsc-Regular.otf',
    licenseFile: 'packages/screenplay/src/fonts/OFL-NotoSansMonoCJK.txt',
  }),
  Object.freeze({
    name: 'Noto Emoji Regular (font)',
    version: '3.002',
    license: 'OFL-1.1',
    repository: 'https://github.com/google/fonts',
    shippedAs: 'packages/screenplay/src/fonts/NotoEmoji-Regular.ttf',
    licenseFile: 'packages/screenplay/src/fonts/OFL-NotoEmoji.txt',
  }),
]);

/**
 * Dual-licensed packages Caotang uses under the permissive side. The notice names the license it is used under, so a
 * reader does not take the GPL side of the declared expression to be an obligation. Each entry is a decision, and it is
 * reviewed when the package changes. `jszip` (MIT OR GPL-3.0-or-later) is used under MIT, through `docx`.
 */
export const ELECTED_LICENSES = Object.freeze({
  jszip: 'MIT',
});

/** The label a notice taken from a README carries in place of a license file name. */
export const README_NOTICE_NAME = 'README (licence section)';

/**
 * Packages whose tarball ships no license file but whose README carries the license, keyed `name@version`. The text is the
 * README's license section copied verbatim (HTML entities included, as the README spells them), so the copyright line
 * travels with the copy as MIT requires. It is used only when the package ships no license file, and an entry is checked
 * again whenever the version changes: a new version gets no override until someone reads its README.
 */
export const README_LICENSE_OVERRIDES = Object.freeze({
  'hash.js@1.1.7': [
    'This software is licensed under the MIT License.',
    '',
    'Copyright Fedor Indutny, 2014.',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a',
    'copy of this software and associated documentation files (the',
    '"Software"), to deal in the Software without restriction, including',
    'without limitation the rights to use, copy, modify, merge, publish,',
    'distribute, sublicense, and/or sell copies of the Software, and to permit',
    'persons to whom the Software is furnished to do so, subject to the',
    'following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included',
    'in all copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS',
    'OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF',
    'MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN',
    'NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,',
    'DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR',
    'OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE',
    'USE OR OTHER DEALINGS IN THE SOFTWARE.',
  ].join('\n'),
  'isarray@1.0.0': [
    '(MIT)',
    '',
    'Copyright (c) 2013 Julian Gruber &lt;julian@juliangruber.com&gt;',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of',
    'this software and associated documentation files (the "Software"), to deal in',
    'the Software without restriction, including without limitation the rights to',
    'use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies',
    'of the Software, and to permit persons to whom the Software is furnished to do',
    'so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
  ].join('\n'),
});

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The production tree of the given workspace packages, as `pnpm list --json` prints it. `root` is the repository root,
 * where pnpm must run so that `--filter` resolves.
 */
export function listProductionTree(root, filters = SHIPPED_FILTERS) {
  const args = ['list', '--prod', '--depth', 'Infinity', '--json'];
  for (const filter of filters) args.push('--filter', filter);
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const output =
    process.platform === 'win32'
      ? execFileSync('cmd', ['/c', 'pnpm', ...args], options)
      : execFileSync('pnpm', args, options);
  return JSON.parse(output);
}

/**
 * Every external package in the tree, once per name and version, sorted by name then version. Workspace links (`link:`)
 * are Caotang's own packages and are skipped. The `path` of each is the package's directory, where its license file lives.
 */
export function externalPackages(tree) {
  const found = new Map();
  const visit = (dependencies) => {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      const version = dependency.version;
      if (typeof version === 'string' && !version.startsWith('link:') && typeof dependency.path === 'string') {
        const key = `${name}@${version}`;
        if (!found.has(key)) found.set(key, { name, version, path: dependency.path });
      }
      visit(dependency.dependencies);
      visit(dependency.optionalDependencies);
    }
  };
  for (const project of tree) {
    visit(project.dependencies);
    visit(project.optionalDependencies);
  }
  return [...found.values()].sort((a, b) => compareText(a.name, b.name) || compareText(a.version, b.version));
}

/** Reads one package's declared license, repository and its license and notice files. */
export function describePackage(record) {
  const manifest = JSON.parse(readFileSync(join(record.path, 'package.json'), 'utf8'));
  const license = licenseOf(manifest);
  const repository = repositoryOf(manifest);
  const files = readdirSync(record.path)
    .filter((entry) => LICENSE_FILE.test(entry) && statSync(join(record.path, entry)).isFile())
    .sort(compareText)
    .map((entry) => ({ name: entry, text: normalizeText(readFileSync(join(record.path, entry), 'utf8')) }));
  const override = README_LICENSE_OVERRIDES[`${record.name}@${record.version}`];
  if (files.length === 0 && override !== undefined) files.push({ name: README_NOTICE_NAME, text: override });
  const elected = ELECTED_LICENSES[record.name];
  const used = elected !== undefined && license.includes(' OR ') ? `${elected} (elected from ${license})` : license;
  return { name: record.name, version: record.version, license: used, repository, files };
}

/** The SPDX-style license a package declares, or `UNKNOWN` when it declares none. */
function licenseOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (isRecord(manifest.license) && typeof manifest.license.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map((item) => (isRecord(item) ? item.type : undefined)).filter((type) => typeof type === 'string');
    if (types.length > 0) return types.join(' OR ');
  }
  return 'UNKNOWN';
}

function repositoryOf(manifest) {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : isRecord(manifest.repository) ? manifest.repository.url : undefined;
  const url = typeof repository === 'string' && repository !== '' ? repository : typeof manifest.homepage === 'string' ? manifest.homepage : '';
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
}

/**
 * The notices document for the given packages. It is deterministic: the same packages and the same license files give the
 * same bytes, on any machine, so a committed copy can be compared with a fresh one.
 */
export function renderNotices(packages, { filters = SHIPPED_FILTERS, assets = [] } = {}) {
  const lines = [];
  lines.push('# Third-party notices');
  lines.push('');
  lines.push(
    'Caotang is MIT-licensed (see LICENSE). The software listed here is third-party code that ships inside the Caotang builds named ' +
      'below. Each entry keeps its own license. Where a package ships a license or notice file, its text is reproduced below in full.',
  );
  lines.push('');
  lines.push(`Generated by \`node tools/third-party-notices.mjs --write\` from the lockfile, for the production dependencies of ${filters.map((filter) => `\`${filter.replace(/^\.\//, '')}\``).join(' and ')}. Do not edit by hand.`);
  lines.push('');
  lines.push(`## Packages (${packages.length})`);
  lines.push('');
  lines.push('| Package | Version | License |');
  lines.push('| --- | --- | --- |');
  for (const pkg of packages) lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license} |`);
  lines.push('');
  lines.push('## License texts');
  for (const pkg of packages) {
    lines.push('');
    lines.push(`### ${pkg.name}@${pkg.version}`);
    lines.push('');
    lines.push(`License: ${pkg.license}${pkg.repository === '' ? '' : `. Source: ${pkg.repository}`}`);
    if (pkg.files.length === 0) {
      lines.push('');
      lines.push('This package ships no license file. Its package.json declares the license above.');
      continue;
    }
    for (const file of pkg.files) {
      lines.push('');
      lines.push(`${file.name}:`);
      lines.push('');
      const fence = fenceFor(file.text);
      lines.push(`${fence}text`);
      lines.push(file.text.replace(/\n+$/, ''));
      lines.push(fence);
    }
  }
  if (assets.length > 0) {
    lines.push('');
    lines.push(`## Bundled files (${assets.length})`);
    lines.push('');
    lines.push('These ship inside Caotang\'s own packages, not as dependencies, so the lockfile does not list them.');
    for (const asset of assets) {
      lines.push('');
      lines.push(`### ${asset.name} ${asset.version}`);
      lines.push('');
      lines.push(`License: ${asset.license}. Source: ${asset.repository}. Shipped as \`${asset.shippedAs}\`.`);
      lines.push('');
      const fence = fenceFor(asset.text);
      lines.push(`${fence}text`);
      lines.push(asset.text.replace(/\n+$/, ''));
      lines.push(fence);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The bundled assets with their license texts, read from `root`. Each asset's `shippedAs` file must exist, as its license
 * file must, so the notices never name a file that is not in the repository: a renamed or moved asset fails here.
 */
export function bundledAssetNotices(root = REPO_ROOT, assets = BUNDLED_ASSETS) {
  return assets.map((asset) => {
    if (!existsSync(join(root, asset.shippedAs))) {
      throw new Error(`third-party notices: ${asset.name} is shipped as ${asset.shippedAs}, which does not exist`);
    }
    return { ...asset, text: normalizeText(readFileSync(join(root, asset.licenseFile), 'utf8')) };
  });
}

/** Generates the document for the shipped packages in `root`. */
export function generateNotices({ root = REPO_ROOT, filters = SHIPPED_FILTERS } = {}) {
  const packages = externalPackages(listProductionTree(root, filters)).map(describePackage);
  return renderNotices(packages, { filters, assets: bundledAssetNotices(root) });
}

function fenceFor(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(longest + 1);
}

function normalizeText(text) {
  // A leading byte-order mark is not part of the license text. The code point is spelt in ASCII, so the source holds no invisible character.
  const bom = String.fromCharCode(0xfeff);
  return (text.startsWith(bom) ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Code-unit order, so the sort does not depend on the locale. */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Run directly: `node tools/third-party-notices.mjs [--write]`. With --write the repository copy is replaced; without it the
// document is printed, so a reviewer can diff it.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const text = generateNotices();
  if (process.argv.includes('--write')) {
    writeFileSync(join(REPO_ROOT, NOTICES_FILE), text);
    process.stdout.write(`wrote ${NOTICES_FILE} (${text.length} characters)\n`);
  } else {
    process.stdout.write(text);
  }
}
