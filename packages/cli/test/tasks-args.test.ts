import { describe, expect, it } from 'vitest';

import { UsageError } from '../src/agent-args.js';
import { parseTasksArgs } from '../src/tasks-args.js';

const args = (argv: readonly string[]) => {
  const parsed = parseTasksArgs(argv);
  if (parsed === 'help') throw new Error('expected args');
  return parsed;
};
const refuses = (argv: readonly string[], message: string) => {
  expect(() => parseTasksArgs(argv)).toThrow(UsageError);
  expect(() => parseTasksArgs(argv)).toThrow(message);
};

describe('caotang tasks flags', () => {
  it('list and due read; run is the only subcommand that takes a provider, a permission or a write', () => {
    expect(args(['list']).kind).toBe('list');
    expect(args(['due', '--time-zone', 'Europe/Berlin']).timeZone).toBe('Europe/Berlin');
    refuses(['list', '--write'], 'belongs to run');
    refuses(['due', '--permission', 'auto'], 'belongs to run');
    refuses(['list', '--state', 'x.json'], 'belongs to due and run');
    refuses(['due', '--mock'], 'belongs to run');
    refuses(['list', 't_5H8QK2M9RT'], 'takes no task name');
  });

  it('run takes one id or name, or --due, not both and not neither', () => {
    expect(args(['run', 't_5H8QK2M9RT']).target).toBe('t_5H8QK2M9RT');
    expect(args(['run', '--due']).due).toBe(true);
    refuses(['run'], 'needs a task id or name');
    refuses(['run', '--due', 't_5H8QK2M9RT'], 'not both');
    refuses(['run', 'a', 'b'], 'one task id or name');
    refuses(['wat'], 'unknown subcommand');
    refuses([], 'choose a subcommand');
  });

  it('--include-offered belongs to run --due and needs an explicit --permission', () => {
    refuses(['run', 't_5H8QK2M9RT', '--include-offered'], 'belongs to run --due');
    refuses(['run', '--due', '--include-offered'], 'needs an explicit --permission');
    const parsed = args(['run', '--due', '--include-offered', '--permission', 'read-only']);
    expect(parsed.includeOffered).toBe(true);
    expect(parsed.permissionExplicit).toBe(true);
    expect(args(['run', '--due']).permissionExplicit).toBe(false);
  });

  it('the permission, format, zone, cap and provider flags are checked', () => {
    refuses(['run', '--due', '--permission', 'wat'], '--permission must be one of');
    refuses(['list', '--format', 'yaml'], '--format must be one of');
    refuses(['due', '--time-zone', 'Mars/Olympus'], '--time-zone must name a time zone');
    refuses(['run', '--due', '--max-model-calls', '0'], '--max-model-calls must be');
    refuses(['run', '--due', '--approve-tools', 'doc.write'], 'needs --permission approve-all');
    refuses(['run', '--due', '--mock', '--provider', 'openai'], 'choose one provider');
    refuses(['run', '--due', '--provider', 'openai', '--key-env', 'bad name'], '--key-env must name');
    refuses(['run', '--due', '--provider', 'openai', '--thinking', 'none'], '--thinking must be one of');
    const parsed = args(['run', '--due', '--provider', 'openai', '--model', 'gpt', '--thinking', 'high', '--max-model-calls', '3', '--permission', 'approve-all', '--approve-tools', 'doc.write,coherence.scan']);
    expect(parsed.providerFlags?.provider).toMatchObject({ kind: 'preset', preset: 'openai', model: 'gpt', thinking: 'high' });
    expect(parsed.maxModelCalls).toBe(3);
    expect(parsed.approveTools).toEqual(['doc.write', 'coherence.scan']);
    expect(args(['run', '--due', '--mock']).providerFlags?.provider).toEqual({ kind: 'mock' });
  });

  it('help is help, at either position', () => {
    expect(parseTasksArgs(['--help'])).toBe('help');
    expect(parseTasksArgs(['run', '-h'])).toBe('help');
  });
});
