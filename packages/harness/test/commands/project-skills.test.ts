import { describe, expect, it } from 'vitest';
import { parseSkillFolder } from '@caotang/skills';
import { FRIEND, makeHarness, makeState } from '../fixtures.js';
import { expandTemplate, parseSlash } from '../../src/commands/slash.js';

const files = (extra = '', body = 'Write about $subject.') => [{ path: 'SKILL.md', bytes: new TextEncoder().encode(`---\nname: saved\ndescription: A saved request.\ndisable-model-invocation: true\n${extra}\n---\n${body}`) }];

describe('writer-selected skills', () => {
  it('loads a reviewed user-only skill for this turn, never offers it to the model, and forgets it at turn end', () => {
    const state = makeState();
    const source = files();
    state.skills.set('saved', source);
    const pin = parseSkillFolder('saved', source).skill!.pin;
    const harness = makeHarness({ skills: { reviewedPin: () => pin } }, state);
    expect(harness.skillCatalog()).toBeUndefined();
    expect(harness.call({ name: 'skill.load', params: { name: 'saved' }, callId: 'model' }, { turnId: 'one' }).ok).toBe(false);
    expect(harness.loadWriterSkill({ name: 'saved', pin, body: 'Write about tides.' }, { turnId: 'one' }).ok).toBe(true);
    expect(harness.loadedSkills('one')[0]).toMatchObject({ name: 'saved', body: 'Write about tides.' });
    harness.endTurn('one');
    expect(harness.loadedSkills('one')).toEqual([]);
  });

  it('refuses changed, off, unreviewed and non-user-invocable skills, and an expanded body over the cap', () => {
    for (const problem of ['changed', 'off', 'unreviewed', 'non-user', 'over-cap']) {
      const state = makeState();
      const source = files(problem === 'non-user' ? 'user-invocable: false' : '');
      state.skills.set('saved', source);
      const pin = parseSkillFolder('saved', source).skill!.pin;
      if (problem === 'off') state.manifest.disabledSkills = ['saved'];
      const harness = makeHarness({ skills: { reviewedPin: () => problem === 'unreviewed' ? undefined : pin } }, state);
      const result = harness.loadWriterSkill({ name: 'saved', pin: problem === 'changed' ? 'old' : pin, body: problem === 'over-cap' ? 'x'.repeat(30_000) : 'Expanded.' }, { turnId: 'one' });
      expect(result.ok, problem).toBe(false);
      expect(harness.loadedSkills('one')).toEqual([]);
    }
  });

  it('does not bypass a skill.load deny or ask rule', () => {
    for (const effect of ['deny', 'ask'] as const) {
      const state = makeState();
      const source = files();
      state.skills.set('saved', source);
      const pin = parseSkillFolder('saved', source).skill!.pin;
      const harness = makeHarness({ skills: { reviewedPin: () => pin }, rules: () => ({ rules: [{ source: 'app', tool: 'skill.load', effect }] }) }, state);
      expect(harness.loadWriterSkill({ name: 'saved', pin, body: 'Expanded.' }, { turnId: 'one' }).ok).toBe(false);
    }
  });

  it('reads a writer-only skill’s reviewed references after an expanded load and restoration', () => {
    const state = makeState();
    const source = [...files('allowed-tools: skill.read meta.set'), { path: 'references/voice.md', bytes: new TextEncoder().encode('Keep the salt air.') }];
    state.skills.set('saved', source);
    const pin = parseSkillFolder('saved', source).skill!.pin;
    const harness = makeHarness({ skills: { reviewedPin: () => pin } }, state);
    expect(harness.loadWriterSkill({ name: 'saved', pin, body: 'Write about tides.' }, { turnId: 'one' }).ok).toBe(true);
    expect(harness.call({ name: 'skill.read', params: { name: 'saved', path: 'references/voice.md' }, callId: 'read' }, { turnId: 'one' }).ok).toBe(true);
    const snapshots = harness.loadedSkills('one');
    expect(snapshots[0]).toMatchObject({ origin: 'writer', body: 'Write about tides.', allowedTools: ['skill.read', 'meta.set'] });
    harness.endTurn('one');
    expect(harness.restoreSkills('two', snapshots).ok).toBe(true);
    expect(harness.call({ name: 'skill.read', params: { name: 'saved', path: 'references/voice.md' }, callId: 'read-again' }, { turnId: 'two' }).ok).toBe(true);
    expect(harness.call({ name: 'notes.append', params: { doc: FRIEND, text: 'Outside the skill list.' }, callId: 'denied' }, { turnId: 'two' }).ok).toBe(false);
  });

  it('restores expanded writer provenance atomically without admitting model loads, widened lists or stale reviews', () => {
    const state = makeState();
    const source = files('allowed-tools: meta.set');
    state.skills.set('saved', source);
    const pin = parseSkillFolder('saved', source).skill!.pin;
    let reviewed: string | undefined = pin;
    const harness = makeHarness({ skills: { reviewedPin: () => reviewed } }, state);
    const snapshot = { name: 'saved', pin, body: 'Write about tides.', allowedTools: ['meta.set'], origin: 'writer' as const };
    expect(harness.restoreSkills('valid', [snapshot]).ok).toBe(true);
    for (const bad of [{ ...snapshot, origin: undefined }, { ...snapshot, origin: 'model' }, { ...snapshot, pin: '0'.repeat(64) }, { ...snapshot, body: 'x'.repeat(30_000) }, { ...snapshot, allowedTools: ['notes.append'] }, { ...snapshot, allowedTools: undefined }]) {
      expect(harness.restoreSkills('atomic', [snapshot, { ...bad, name: 'missing' } as typeof snapshot]).ok).toBe(false);
      expect(harness.loadedSkills('atomic')).toEqual([]);
      expect(harness.restoreSkills('bad', [bad as typeof snapshot]).ok).toBe(false);
      expect(harness.loadedSkills('bad')).toEqual([]);
    }
    reviewed = undefined;
    expect(harness.restoreSkills('unreviewed', [snapshot]).ok).toBe(false);
    expect(harness.call({ name: 'skill.load', params: { name: 'saved' }, callId: 'model' }, { turnId: 'model' }).ok).toBe(false);
  });

  it('keeps a model-visible command’s selected expansion when the model loads it again in the same turn', () => {
    const state = makeState();
    const source = [{ path: 'SKILL.md', bytes: new TextEncoder().encode('---\nname: saved\ndescription: A saved request.\nallowed-tools: skill.load meta.set\n---\nWrite about $subject.') }];
    state.skills.set('saved', source);
    const pin = parseSkillFolder('saved', source).skill!.pin;
    const harness = makeHarness({ skills: { reviewedPin: () => pin } }, state);
    expect(harness.loadWriterSkill({ name: 'saved', pin, body: 'Write about tides.' }, { turnId: 'one' }).ok).toBe(true);
    const reloaded = harness.call({ name: 'skill.load', params: { name: 'saved' }, callId: 'model' }, { turnId: 'one' });
    expect(reloaded).toMatchObject({ ok: true, value: { data: { instructions: 'Write about tides.' } } });
    expect(harness.loadedSkills('one')[0]).toMatchObject({ body: 'Write about tides.', origin: 'writer', allowedTools: ['skill.load', 'meta.set'] });
    harness.endTurn('one');
    expect(harness.call({ name: 'skill.load', params: { name: 'saved' }, callId: 'fresh' }, { turnId: 'two' })).toMatchObject({ ok: true, value: { data: { instructions: 'Write about $subject.' } } });
    expect(harness.loadedSkills('two')[0]?.origin).toBeUndefined();
  });
});

describe('template arguments', () => {
  it('reads quoted named values, expands once, and asks for empty required values', () => {
    const parsed = parseSlash('/saved subject="the $1 tides"')!;
    expect(parsed.named).toEqual({ subject: 'the $1 tides' });
    expect(expandTemplate('Write $subject. $$ $DOC', parsed, { DOC: 'Landing' }, ['subject'])).toEqual({ ok: true, value: 'Write the $1 tides. $ Landing' });
    expect(expandTemplate('$subject', parseSlash('/saved subject=""')!, {}, ['subject'])).toEqual({ ok: false, error: { missing: '$subject' } });
    expect(expandTemplate('$1', parseSlash('/saved ""')!)).toEqual({ ok: false, error: { missing: '$1' } });
    expect(parseSlash('/prompt chapter-id="The Landing"')?.named).toEqual({ 'chapter-id': 'The Landing' });
    expect(expandTemplate('$toString', parseSlash('/saved')!)).toEqual({ ok: true, value: '$toString' });
    expect(expandTemplate('$constructor', parseSlash('/saved')!, {}, ['constructor'])).toEqual({ ok: false, error: { missing: '$constructor' } });
  });

  it('reads argument declarations from the standard skill file and rejects ambiguous declarations', () => {
    expect(parseSkillFolder('saved', files('arguments: [subject, tone]')).skill?.frontMatter.arguments).toEqual(['subject', 'tone']);
    for (const declaration of ['arguments: [subject, subject]', 'arguments: [DOC]', 'arguments: [not-valid]', 'arguments: subject']) {
      expect(parseSkillFolder('saved', files(declaration)).issues[0]?.code).toBe('bad_front_matter');
    }
  });
});
