/**
 * THIRD-PARTY-NOTICES.md is generated from the lockfile (tools/third-party-notices.mjs), and the MCP bundle ships a copy of
 * it. A committed copy that no longer matches the production tree names the wrong packages, so this guard regenerates the
 * document and compares. When it fails, run `node tools/third-party-notices.mjs --write` and commit the result.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUNDLED_ASSETS,
  bundledAssetNotices,
  describePackage,
  ELECTED_LICENSES,
  generateNotices,
  NOTICES_FILE,
  renderNotices,
} from '../../../tools/third-party-notices.mjs';

const repoRoot = resolve(__dirname, '../../..');

describe('THIRD-PARTY-NOTICES.md', () => {
  it('is the document the generator writes from the lockfile, so it cannot drift from what ships', () => {
    const committed = readFileSync(resolve(repoRoot, NOTICES_FILE), 'utf8').replace(/\r\n/g, '\n');
    const generated = generateNotices({ root: repoRoot });
    // Control: the generator found packages. An empty tree would make both sides agree on nothing.
    const count = Number(/^## Packages \((\d+)\)$/m.exec(generated)?.[1]);
    expect(count).toBeGreaterThan(100);
    expect(committed, 'run `node tools/third-party-notices.mjs --write` and commit the result').toBe(generated);
  }, 120_000);

  // hash.js 1.1.7 and isarray 1.0.0 ship no license file; their READMEs carry the license, and its copyright line must
  // travel with the copy.
  it.each([
    ['hash.js', '1.1.7', 'Copyright Fedor Indutny, 2014.'],
    ['isarray', '1.0.0', 'Copyright (c) 2013 Julian Gruber'],
  ])('carries the README license section of %s@%s with its copyright line', (name, version, copyright) => {
    const path = resolve(repoRoot, 'node_modules/.pnpm', `${name}@${version}`, 'node_modules', name);
    const described = describePackage({ name, version, path });
    expect(described.files).toHaveLength(1);
    expect(described.files[0]?.name).toBe('README (licence section)');
    expect(described.files[0]?.text).toContain(copyright);
    expect(described.files[0]?.text).toContain('Permission is hereby granted, free of charge');
    // The rendered document carries it under the package's own heading.
    const rendered = renderNotices([described]);
    expect(rendered).toContain(`### ${name}@${version}`);
    expect(rendered).toContain(copyright);
    expect(rendered).not.toContain('This package ships no license file.');
  });

  it('names only bundled files that exist, each where the notices say it ships', () => {
    expect(BUNDLED_ASSETS.length).toBeGreaterThan(0);
    for (const asset of BUNDLED_ASSETS) expect(existsSync(resolve(repoRoot, asset.shippedAs)), asset.shippedAs).toBe(true);
    const [first] = BUNDLED_ASSETS;
    if (first === undefined) throw new Error('no bundled asset');
    // A moved or renamed file stops the generator, as a missing license file does, rather than leaving a stale line.
    const moved = { ...first, shippedAs: first.shippedAs.replace(/[^/]+$/, 'renamed-font.otf') };
    expect(() => bundledAssetNotices(repoRoot, [moved])).toThrow(`is shipped as ${moved.shippedAs}, which does not exist`);
  });

  it('leaves jszip elected under MIT', () => {
    expect(ELECTED_LICENSES.jszip).toBe('MIT');
  });
});
