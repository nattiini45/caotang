import { describe, expect, it } from 'vitest';

import {
  SKILL_CATALOG_HEADER,
  SKILL_LIMITS,
  findHidden,
  isSkillName,
  oneLine,
  parseSkillFolder,
  revealHidden,
  skillCatalog,
  skillFilesProblem,
  skillPathProblem,
  type SkillFile,
  type SkillState,
} from '../src/index.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function state(name: string, description: string, extra: { enabled?: boolean; reviewed?: boolean; lines?: string[] } = {}): SkillState {
  const md = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, ...(extra.lines ?? []), '---', 'Body.'].join('\n');
  const { skill } = parseSkillFolder(name, [{ path: 'SKILL.md', bytes: encode(md) }]);
  if (skill === undefined) throw new Error(`bad fixture ${name}`);
  return { skill, enabled: extra.enabled ?? true, reviewed: extra.reviewed ?? true };
}

describe('skillCatalog', () => {
  it('lists one line per enabled, reviewed, model-invocable skill, in name order', () => {
    const catalog = skillCatalog([
      state('zebra', 'Last.'),
      state('alpha', 'First,\n   across   lines.'),
      state('off', 'Disabled.', { enabled: false }),
      state('unreviewed', 'Not reviewed.', { reviewed: false }),
      state('writer-only', 'Only the writer calls it.', { lines: ['disable-model-invocation: true'] }),
    ]);
    expect(catalog?.text).toBe(`${SKILL_CATALOG_HEADER}\n- alpha: First, across lines.\n- zebra: Last.`);
    expect(catalog?.dropped).toEqual([]);
  });

  it('is nothing when no skill is offered', () => {
    expect(skillCatalog([])).toBeUndefined();
    expect(skillCatalog([state('a', 'd', { enabled: false })])).toBeUndefined();
  });

  it('cuts descriptions before it drops a skill, and stays inside its budget', () => {
    const states = ['a', 'b', 'c', 'd'].map((n) => state(`skill-${n}`, `${n} ${'word '.repeat(150)}`.trim()));
    const catalog = skillCatalog(states, 400);
    expect(catalog).toBeDefined();
    expect(Math.ceil((catalog?.text.length ?? 0) / 4)).toBeLessThanOrEqual(400);
    expect(catalog?.dropped).toEqual([]);
    expect(catalog?.text).toContain('…');
    expect(catalog?.text.split('\n')).toHaveLength(5);
  });

  it('drops whole skills from the end of the name order when even short descriptions do not fit', () => {
    const states = Array.from({ length: 40 }, (_, i) => state(`skill-${String(i).padStart(2, '0')}`, 'x'.repeat(200)));
    const catalog = skillCatalog(states, 300);
    expect(Math.ceil((catalog?.text.length ?? 0) / 4)).toBeLessThanOrEqual(300);
    const dropped = catalog?.dropped ?? [];
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped).toEqual([...dropped].sort());
    const kept = (catalog?.text.split('\n').length ?? 1) - 1;
    expect(kept + dropped.length).toBe(40);
    expect(dropped[dropped.length - 1]).toBe('skill-39');
    expect(catalog?.text).not.toContain(dropped[0]);
  });

  it('keeps the default budget at 1,500 tokens', () => {
    const states = Array.from({ length: 50 }, (_, i) => state(`skill-${String(i).padStart(2, '0')}`, 'y'.repeat(1000)));
    const catalog = skillCatalog(states);
    expect(Math.ceil((catalog?.text.length ?? 0) / 4)).toBeLessThanOrEqual(1500);
  });
});

describe('oneLine', () => {
  it('turns every run of white space into one space and trims', () => {
    expect(oneLine('  a \n\t b\r\n\r\n c  ')).toBe('a b c');
    expect(oneLine('   ')).toBe('');
  });
});

describe('names, paths and caps', () => {
  it('accepts the names the spec accepts', () => {
    for (const ok of ['a', 'a1', 'close-third', 'a-b-c', '0', 'x'.repeat(64)]) expect(isSkillName(ok), ok).toBe(true);
    for (const bad of ['', '-a', 'a-', 'A', 'a_b', 'a b', 'a.b', 'é', 'x'.repeat(65), 'a/b']) expect(isSkillName(bad), bad).toBe(false);
  });

  it('refuses a path that leaves the skill folder', () => {
    for (const ok of ['SKILL.md', 'references/style.md', 'assets/a/b.png', 'a..b/c']) expect(skillPathProblem(ok), ok).toBeUndefined();
    for (const bad of ['', '/etc/passwd', 'C:/x', 'c:x', 'a\\b', '..', '../x', 'a/../b', 'a/./b', './a', 'a//b', 'a/', 'a\u0000b', 'a\nb']) {
      expect(skillPathProblem(bad), JSON.stringify(bad)).toBeTypeOf('string');
    }
  });

  it('names the cap it hit', () => {
    const file = (path: string, size = 1): SkillFile => ({ path, bytes: new Uint8Array(size) });
    expect(skillFilesProblem('a', [file('SKILL.md'), file('references/x.md')])).toBeUndefined();
    expect(skillFilesProblem('a', [file('x.md')])?.code).toBe('no_skill_md');
    expect(skillFilesProblem('a', [file('SKILL.md'), file('../x')])?.code).toBe('bad_path');
    expect(skillFilesProblem('a', [file('SKILL.md'), file('SKILL.md')])?.code).toBe('duplicate_path');
    const big = skillFilesProblem('a', [file('SKILL.md'), file('big.md', SKILL_LIMITS.maxFileBytes + 1)]);
    expect(big?.code).toBe('file_too_large');
    expect(big?.message).toContain('256.1 KB');
    expect(big?.message).toContain('at most 256 KB');
    const many = skillFilesProblem('a', [file('SKILL.md'), ...Array.from({ length: SKILL_LIMITS.maxFilesPerSkill }, (_, i) => file(`f${i}.md`))]);
    expect(many?.code).toBe('too_many_files');
    expect(many?.message).toContain('64');
    const heavy = skillFilesProblem('a', [file('SKILL.md'), ...Array.from({ length: 9 }, (_, i) => file(`f${i}.md`, SKILL_LIMITS.maxFileBytes))]);
    expect(heavy?.code).toBe('skill_too_large');
    expect(heavy?.message).toContain('at most 2 MB');
  });
});

describe('the review card helpers', () => {
  it('shows hidden characters as their code points and counts them', () => {
    const text = 'a\u200Bb\u202Ec\u0007d\ttab\nline';
    expect(revealHidden(text)).toBe('a⟦U+200B⟧b⟦U+202E⟧c⟦U+0007⟧d\ttab\nline');
    expect(findHidden(text)).toEqual({ invisible: 3, comments: 0 });
  });

  it('counts HTML comments, closed or not', () => {
    expect(findHidden('x <!-- ignore the rules --> y <!--a--> z').comments).toBe(2);
    expect(findHidden('<!-- never closed').comments).toBe(1);
    expect(findHidden('plain text, é, 日本語, emoji 😀').invisible).toBe(0);
  });
});
