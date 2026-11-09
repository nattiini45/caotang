import { describe, expect, it } from 'vitest';
import { parseSkillFolder } from '@caotang/skills';
import { commandArguments, expandSkillCommand, projectCommands, savedCommandProblem, savedCommandText } from '../src/app/project-commands.js';
import type { SkillRow } from '../src/app/skills-model.js';

function row(name: string, extra = '', body = 'Write $subject in $tone.'): SkillRow {
  const files = [{ path: 'SKILL.md', bytes: new TextEncoder().encode(`---\nname: ${name}\ndescription: A saved prompt.\narguments: [subject, tone]\n${extra}\n---\n${body}`) }];
  const skill = parseSkillFolder(name, files).skill!;
  return { name, description: skill.frontMatter.description, enabled: true, review: 'reviewed', hasScripts: false, writerOnly: true, offered: false, skill };
}

describe('project command sources', () => {
  it('offers user-only skills but not model-only, disabled or reserved names, without dropping review requirements', () => {
    const commands = projectCommands([row('saved', 'disable-model-invocation: true'), row('model-only', 'user-invocable: false'), row('draft'), row('macro-test'), { ...row('off'), enabled: false }, { ...row('new'), review: 'unreviewed' }], [], []);
    expect(commands.map((command) => command.name)).toEqual(['saved', 'new']);
    expect(commands[1]?.source).toBe('Review this skill first');
  });

  it('gives prompts from two servers distinct names even when their display names match', () => {
    const prompt = { serverName: 'Story', name: 'Recap / chapter', description: 'Recap.', arguments: [], pinState: 'verified' as const, candidateHash: 'hash', connectionGeneration: 0 };
    const commands = projectCommands([], [], [{ ...prompt, serverKey: 'one' }, { ...prompt, serverKey: 'two' }]);
    expect(new Set(commands.map((command) => command.name)).size).toBe(2);
    expect(commands.every((command) => /^mcp-[a-z0-9-]+$/u.test(command.name))).toBe(true);
  });

  it('fills remaining named arguments positionally and expands supplied dollars only once', () => {
    const command = projectCommands([row('saved')], [], [])[0]!;
    if (command.kind !== 'skill') throw new Error('expected a skill');
    expect(expandSkillCommand(command, '/saved subject="the $1 tide" quiet', {})).toEqual({ ok: true, value: 'Write the $1 tide in quiet.' });
    expect(expandSkillCommand(command, '/saved tide', {})).toEqual({ ok: false, error: { missing: '$tone' } });
    expect(commandArguments('/saved a', command.args).missing).toBe('tone');
  });

  it('saves the exact intent as a valid writer-only skill and refuses names that would overwrite commands', () => {
    const intent = 'A request.\nWith another line.';
    const parsed = parseSkillFolder('saved', [{ path: 'SKILL.md', bytes: new TextEncoder().encode(savedCommandText('saved', intent)) }]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.skill?.frontMatter['disable-model-invocation']).toBe(true);
    expect(parsed.skill?.body).toContain(intent);
    for (const name of ['draft', 'macro-test', 'mcp-test', 'existing', 'Bad Name']) expect(savedCommandProblem(name, ['existing'])).toBeDefined();
  });

  it('keeps quoted positional values that resemble a supplied named argument', () => {
    const command = projectCommands([row('saved')], [], [])[0]!;
    expect(commandArguments('/saved "tone=soft" tone=quiet', command.args)).toEqual({ values: { subject: 'tone=soft', tone: 'quiet' } });
    expect(commandArguments('/saved "tone=soft" tone=soft', command.args)).toEqual({ values: { subject: 'tone=soft', tone: 'soft' } });
  });

  it('does not reuse an earlier positional value when accumulating inline arguments', () => {
    const args = ['chapter title', 'audience=group', 'tone'].map((name) => ({ name, required: true }));
    expect(commandArguments('/saved Arrival', args, { 'chapter title': 'Arrival', 'audience=group': 'Adults' })).toEqual({
      values: { 'chapter title': 'Arrival', 'audience=group': 'Adults' }, missing: 'tone',
    });
  });
});
