/**
 * The continuity-scan workflow template a writer copies into their project repository (docs/ci/continuity-scan.yml), and the step in
 * Caotang's own ci.yml that scans a fixture with the built command. actionlint is not run here; these are the rules the template
 * has to keep, read off its text: least privilege, no secret, no floating command, and a command that is checked before it runs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('\r\n').join('\n');

const template = read('docs/ci/continuity-scan.yml');
/** The template without its comment lines, so a rule is checked against what runs and not against the prose about it. */
const code = template
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');
const ci = read('.github/workflows/ci.yml');

const actionsOf = (text: string): string[] => [...text.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] ?? '');

describe('docs/ci/continuity-scan.yml', () => {
  it('asks for contents: read and nothing else, and keeps no token in the checked-out folder', () => {
    const block = code.slice(code.indexOf('permissions:'), code.indexOf('concurrency:'));
    expect(block.split('\n').filter((line) => line.startsWith('  '))).toEqual(['  contents: read']);
    expect(code).toContain('persist-credentials: false');
  });

  it('runs on a schedule, by hand and on pull requests, and never on pull_request_target', () => {
    expect(code).toMatch(/^on:\n {2}schedule:\n/m);
    expect(code).toContain('workflow_dispatch:');
    expect(code).toMatch(/^ {2}pull_request:\n {4}paths:/m);
    expect(code).not.toContain('pull_request_target');
    expect(template).toContain('never `pull_request_target`');
  });

  it('holds no secret, no key and no token in the job', () => {
    expect(code).not.toMatch(/secrets\./i);
    expect(code).not.toMatch(/GITHUB_TOKEN|github\.token|API_KEY|CAOTANG_API/i);
  });

  it('uses the actions at the majors ci.yml uses, and no third-party action', () => {
    const used = actionsOf(code);
    expect(used.length).toBeGreaterThan(0);
    const inCi = new Set(actionsOf(ci));
    for (const action of used) {
      expect(action.startsWith('actions/')).toBe(true);
      expect(inCi.has(action), `${action} is not at the version ci.yml uses`).toBe(true);
    }
  });

  it('downloads one pinned release file and checks its SHA-256 before running it, with no npx line', () => {
    expect(code).not.toMatch(/\bnpx\b|npm (install|exec)|pnpm dlx/);
    expect(code).toContain('https://github.com/nattiini45/caotang/releases/download/${CAOTANG_VERSION}/caotang.mjs');
    const fetched = code.indexOf('curl ');
    const checked = code.indexOf('sha256sum --check --strict');
    const ran = code.indexOf('node "$RUNNER_TEMP/caotang.mjs" scan');
    expect(fetched).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(fetched);
    expect(ran).toBeGreaterThan(checked);
  });

  it('stops while the version and the hash are still placeholders, and once set accepts only a tag and a 64-digit hash', () => {
    const version = /CAOTANG_VERSION: '([^']*)'/.exec(code)?.[1] ?? '';
    const hash = /CAOTANG_SHA256: '([^']*)'/.exec(code)?.[1] ?? '';
    expect(version).not.toBe('');
    expect(hash).not.toBe('');
    // The template guards both values with the patterns below; a placeholder fails them.
    expect(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version) || version.startsWith('REPLACE-')).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(hash) || hash.startsWith('REPLACE-')).toBe(true);
    expect(code).toContain('=~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(code).toContain('=~ ^[0-9a-f]{64}$');
    expect(template).toContain('PLACEHOLDERS');
  });

  it('scans the whole project and reads the folder: full scope, GitHub annotations, the step summary, no --write', () => {
    const scan = code.split('\n').find((line) => line.includes('caotang.mjs" scan')) ?? '';
    expect(scan).toContain('--scope full');
    expect(scan).toContain('--format github');
    expect(scan).toContain('--summary "$GITHUB_STEP_SUMMARY"');
    expect(scan).not.toContain('--write');
    expect(code).not.toMatch(/\bagent\b/);
  });

  it('says that annotations carry quotes from the manuscript', () => {
    expect(template).toContain('short quotes from your manuscript');
  });
});

describe('ci.yml scans the fixture project', () => {
  it('runs the built command on the committed fixture after building it, and asserts the exit code, one annotation and no change', () => {
    const build = ci.indexOf('pnpm --filter @caotang/cli run build');
    const step = ci.indexOf('caotang.mjs scan --project packages/cli/test/fixtures/continuity-project --format github');
    expect(build).toBeGreaterThan(0);
    expect(step).toBeGreaterThan(build);
    const block = ci.slice(step, ci.indexOf('\n  verify:', step));
    expect(block).toContain('test "$code" = 7');
    expect(block).toContain("grep -c '^::error '");
    expect(block).toContain('line=10,endLine=11,title=presence');
    expect(block).toContain('git status --porcelain -- packages/cli/test/fixtures/continuity-project');
  });
});
