/**
 * The four skill descriptors (extensibility.md §10): what each accepts and refuses, with the caps named. All four are `never` for an
 * agent; that is held against the gate in permission.test.ts and, through the store's registry, in the store's commands-skills test.
 */

import { describe, expect, it } from 'vitest';

import { SKILL_LIMITS } from '@caotang/skills';

import { COMMAND_REGISTRY } from '../src/index.js';
import { makeSnapshot } from './fixtures.js';

const validate = (name: 'skill.import' | 'skill.write' | 'skill.delete' | 'skill.setEnabled', params: unknown, snapshot = makeSnapshot()) =>
  COMMAND_REGISTRY[name].descriptor.validate(params, snapshot);

const held = makeSnapshot({ skills: { 'close-third': [{ path: 'SKILL.md', length: 100 }, { path: 'references/a.md', length: 50 }] }, disabledSkills: ['off'] });

describe('every skill command is user-only', () => {
  it('is agentRisk never, with the undo the spec says', () => {
    for (const [name, undo] of [['skill.import', 'compensable'], ['skill.write', 'compensable'], ['skill.delete', 'compensable'], ['skill.setEnabled', 'inverse']] as const) {
      expect(COMMAND_REGISTRY[name].descriptor.agentRisk, name).toBe('never');
      expect(COMMAND_REGISTRY[name].descriptor.undo, name).toBe(undo);
      expect(COMMAND_REGISTRY[name].descriptor.mutates, name).toBe('project');
    }
  });
});

describe('skill.write', () => {
  it('accepts a file of a new skill only when it is SKILL.md', () => {
    expect(validate('skill.write', { name: 'new-skill', path: 'SKILL.md', text: 'x' }).ok).toBe(true);
    expect(validate('skill.write', { name: 'new-skill', path: 'references/a.md', text: 'x' })).toMatchObject({ ok: false, error: { target: 'path' } });
  });

  it('accepts a new file or a replacement in a skill the project has', () => {
    expect(validate('skill.write', { name: 'close-third', path: 'references/b.md', text: 'x' }, held).ok).toBe(true);
    expect(validate('skill.write', { name: 'close-third', path: 'SKILL.md', text: '' }, held).ok).toBe(true);
  });

  it('refuses a name that is not a skill name, and says what one is', () => {
    for (const bad of ['', 'Close', 'a b', '-a', 'a-', 'a/b', '..', 'x'.repeat(65), 5, null]) {
      const result = validate('skill.write', { name: bad, path: 'SKILL.md', text: 'x' });
      expect(result, String(bad)).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'name' } });
    }
    expect(validate('skill.write', { name: 'Close', path: 'SKILL.md', text: 'x' })).toMatchObject({ error: { correctiveHint: expect.stringMatching(/lower-case/u) } });
  });

  it('refuses a path that leaves the skill folder', () => {
    for (const bad of ['', '/a', '../a', 'a/../../b', 'a\\b', 'C:/x', 'a//b', './a', 7]) {
      expect(validate('skill.write', { name: 'close-third', path: bad, text: 'x' }, held), String(bad)).toMatchObject({ ok: false, error: { target: 'path' } });
    }
  });

  it('refuses a text that is not a string, and a file over 256 KB, naming the cap', () => {
    expect(validate('skill.write', { name: 'close-third', path: 'a.md', text: 5 }, held)).toMatchObject({ ok: false, error: { target: 'text' } });
    const big = validate('skill.write', { name: 'close-third', path: 'a.md', text: 'é'.repeat(SKILL_LIMITS.maxFileBytes / 2 + 1) }, held);
    expect(big).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    expect(big.ok ? '' : big.error.message).toMatch(/at most 256 KB/u);
    expect(validate('skill.write', { name: 'close-third', path: 'a.md', text: 'é'.repeat(SKILL_LIMITS.maxFileBytes / 2) }, held).ok).toBe(true);
  });

  it('counts a replaced file once against the 2 MB cap, and a new one in full', () => {
    const near = makeSnapshot({
      skills: { big: [{ path: 'SKILL.md', length: 1000 }, ...Array.from({ length: 7 }, (_, i) => ({ path: `b${i}`, length: SKILL_LIMITS.maxFileBytes }))] },
    });
    expect(validate('skill.write', { name: 'big', path: 'b0', text: 'x'.repeat(SKILL_LIMITS.maxFileBytes) }, near).ok).toBe(true);
    const over = validate('skill.write', { name: 'big', path: 'new', text: 'x'.repeat(SKILL_LIMITS.maxFileBytes) }, near);
    expect(over).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
  });
});

describe('skill.import', () => {
  it('takes a staging id and nothing else', () => {
    expect(validate('skill.import', { stagingId: 'stg_1' })).toEqual({ ok: true, value: { stagingId: 'stg_1' } });
    expect(validate('skill.import', { stagingId: '' }).ok).toBe(false);
    expect(validate('skill.import', { stagingId: 'stg_1', name: 'x' })).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
  });
});

describe('skill.delete and skill.setEnabled', () => {
  it('refuse a skill the project does not hold', () => {
    expect(validate('skill.delete', { name: 'ghost' }, held)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(validate('skill.setEnabled', { name: 'ghost', enabled: true }, held)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(validate('skill.delete', { name: 'close-third' }, held).ok).toBe(true);
  });

  it('refuses setting what is already set, as a change of nothing', () => {
    expect(validate('skill.setEnabled', { name: 'close-third', enabled: true }, held)).toMatchObject({ ok: false, error: { details: { changesNothing: true } } });
    expect(validate('skill.setEnabled', { name: 'close-third', enabled: false }, held).ok).toBe(true);
    const offHeld = makeSnapshot({ skills: { off: [{ path: 'SKILL.md', length: 1 }] }, disabledSkills: ['off'] });
    expect(validate('skill.setEnabled', { name: 'off', enabled: false }, offHeld)).toMatchObject({ ok: false });
    expect(validate('skill.setEnabled', { name: 'off', enabled: true }, offHeld).ok).toBe(true);
  });

  it('wants a true or false', () => {
    expect(validate('skill.setEnabled', { name: 'close-third', enabled: 'yes' }, held)).toMatchObject({ ok: false, error: { target: 'enabled' } });
  });
});
