import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseSkillFolder, skillIssueText, skillPin, type SkillFile } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string): SkillFile => ({ path, bytes: encode(text) });
const skillMd = (...lines: string[]): SkillFile => file('SKILL.md', ['---', ...lines, '---', '', '# Body', '', 'Write in close third person.', ''].join('\n'));

describe('the public skills', () => {
  const fixtures = readdirSync(join(here, 'fixtures')).filter((name) => name.endsWith('.SKILL.md'));

  it('has fixtures to read', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const fixture of fixtures) {
    it(`reads ${fixture} and gives back its bytes exactly`, () => {
      const source = readFileSync(join(here, 'fixtures', fixture), 'utf8');
      const name = /^name: ?"?([a-z0-9-]+)"?$/mu.exec(source)?.[1] ?? '';
      const { skill, issues } = parseSkillFolder(name, [file('SKILL.md', source)]);
      expect(issues).toEqual([]);
      expect(skill?.frontMatter.name).toBe(name);
      expect(skill?.frontMatter.description.length).toBeGreaterThan(20);
      expect((skill?.frontMatterText ?? '') + (skill?.body ?? '')).toBe(source);
    });
  }

  it('reads the metadata map of a skill that has one', () => {
    const source = readFileSync(join(here, 'fixtures', 'openai-linear.SKILL.md'), 'utf8');
    const { skill } = parseSkillFolder('linear', [file('SKILL.md', source)]);
    expect(skill?.frontMatter.metadata).toEqual({ 'short-description': 'Manage Linear issues in Codex' });
  });
});

describe('parseSkillFolder', () => {
  it('reads every key a skill may carry, and keeps the others', () => {
    const { skill, issues } = parseSkillFolder('close-third', [
      skillMd(
        'name: close-third',
        'description: >-',
        '  Draft in close third person,',
        '  past tense.',
        'license: MIT',
        'compatibility: Any model',
        'metadata:',
        '  author: me',
        'allowed-tools: Read Grep',
        'disable-model-invocation: true',
        'user-invocable: false',
        'argument-hint: "[scene]"',
        'x-vendor: kept',
        'x-list: [1, 2]',
      ),
    ]);
    expect(issues).toEqual([]);
    expect(skill?.frontMatter).toEqual({
      name: 'close-third',
      description: 'Draft in close third person, past tense.',
      license: 'MIT',
      compatibility: 'Any model',
      metadata: { author: 'me' },
      'allowed-tools': 'Read Grep',
      'disable-model-invocation': true,
      'user-invocable': false,
      'argument-hint': '[scene]',
    });
    expect(skill?.unknownFrontMatter).toEqual({ 'x-vendor': 'kept', 'x-list': ['1', '2'] });
    expect(skill?.hasScripts).toBe(false);
  });

  it('reads allowed-tools written as a list', () => {
    const { skill } = parseSkillFolder('a', [skillMd('name: a', 'description: d', 'allowed-tools:', '  - Read', '  - Grep')]);
    expect(skill?.frontMatter['allowed-tools']).toBe('Read Grep');
  });

  it('notes scripts and sorts the files', () => {
    const { skill } = parseSkillFolder('a', [file('scripts/run.sh', 'echo'), file('references/b.md', 'b'), skillMd('name: a', 'description: d'), file('references/a.md', 'a')]);
    expect(skill?.hasScripts).toBe(true);
    expect(skill?.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/a.md', 'references/b.md', 'scripts/run.sh']);
  });

  it('does not offer a skill whose name is not its folder, and says so', () => {
    const { skill, issues } = parseSkillFolder('folder', [skillMd('name: other', 'description: d')]);
    expect(skill).toBeUndefined();
    expect(issues).toEqual([{ code: 'name_mismatch', folder: 'folder', name: 'other' }]);
    expect(skillIssueText(issues[0]!)).toMatch(/“folder”.*“other”/u);
  });

  it('refuses what the spec refuses', () => {
    const bad = (lines: string[], folder = 'a'): string => {
      const { skill, issues } = parseSkillFolder(folder, [skillMd(...lines)]);
      expect(skill).toBeUndefined();
      return JSON.stringify(issues);
    };
    expect(bad(['description: d'])).toMatch(/no “name”/u);
    expect(bad(['name: a'])).toMatch(/no “description”/u);
    expect(bad(['name: A', 'description: d'], 'A')).toMatch(/lower-case/u);
    expect(bad(['name: -a', 'description: d'], '-a')).toMatch(/lower-case/u);
    expect(bad(['name: a--b-', 'description: d'], 'a--b-')).toMatch(/lower-case/u);
    expect(bad(['name: a', 'description: d', 'disable-model-invocation: maybe'])).toMatch(/true or false/u);
    expect(bad(['name: a', 'description: d', 'disable-model-invocation: "true"'])).toMatch(/true or false/u);
    expect(bad(['name: a', 'description: d', 'metadata:', '  deep:', '    x: 1'])).toMatch(/metadata/u);
    expect(bad(['name: a', 'description: [x]'])).toMatch(/should be text/u);
    expect(bad(['name: a', 'description: &x d'])).toMatch(/anchor/u);
  });

  it('refuses a description over 1024 characters and a compatibility over 500', () => {
    const long = parseSkillFolder('a', [skillMd('name: a', `description: ${'x'.repeat(1025)}`)]);
    expect(long.issues).toEqual([{ code: 'too_long', folder: 'a', field: 'description', limit: 1024 }]);
    const edge = parseSkillFolder('a', [skillMd('name: a', `description: ${'x'.repeat(1024)}`)]);
    expect(edge.skill).toBeDefined();
    const compat = parseSkillFolder('a', [skillMd('name: a', 'description: d', `compatibility: ${'y'.repeat(501)}`)]);
    expect(compat.issues).toEqual([{ code: 'too_long', folder: 'a', field: 'compatibility', limit: 500 }]);
  });

  it('says when there is no SKILL.md or it is not text', () => {
    expect(parseSkillFolder('a', [file('notes.md', 'x')]).issues).toEqual([{ code: 'missing_skill_md', folder: 'a' }]);
    const binary = parseSkillFolder('a', [{ path: 'SKILL.md', bytes: Uint8Array.of(0xff, 0xfe, 0x00) }]);
    expect(JSON.stringify(binary.issues)).toMatch(/not UTF-8/u);
  });
});

describe('skillPin', () => {
  const base = [skillMd('name: a', 'description: d'), file('references/r.md', 'one'), file('scripts/s.sh', 'echo')];
  const pinOf = (files: SkillFile[]): string => parseSkillFolder('a', files).skill?.pin ?? '';

  it('is the same for the same skill whatever the order its files come in', () => {
    expect(pinOf(base)).toMatch(/^[0-9a-f]{64}$/u);
    expect(pinOf([...base].reverse())).toBe(pinOf(base));
  });

  it('changes when any byte of any file changes, scripts and references included', () => {
    const pin = pinOf(base);
    expect(pinOf([base[0]!, file('references/r.md', 'one!'), base[2]!])).not.toBe(pin);
    expect(pinOf([base[0]!, base[1]!, file('scripts/s.sh', 'echo hi')])).not.toBe(pin);
    expect(pinOf([base[0]!, base[1]!])).not.toBe(pin);
    expect(pinOf([...base, file('assets/x.bin', '')])).not.toBe(pin);
    expect(pinOf([skillMd('name: a', 'description: d', 'x-new: 1'), base[1]!, base[2]!])).not.toBe(pin);
  });

  it('is the hash of the parts it names', () => {
    const one = skillPin({ name: 'a', frontMatterText: 'f', body: 'b', files: [file('SKILL.md', 'fb')] });
    expect(skillPin({ name: 'a', frontMatterText: 'f', body: 'b', files: [file('SKILL.md', 'fb')] })).toBe(one);
    expect(skillPin({ name: 'a', frontMatterText: 'f', body: 'b2', files: [file('SKILL.md', 'fb')] })).not.toBe(one);
    expect(skillPin({ name: 'b', frontMatterText: 'f', body: 'b', files: [file('SKILL.md', 'fb')] })).not.toBe(one);
  });
});
