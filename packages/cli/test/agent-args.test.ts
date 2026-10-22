/** The agent flags: every one, the rules between them, and the refusal of a key on the command line. */

import { describe, expect, it } from 'vitest';

import { DEFAULT_KEY_ENV, DEFAULT_MAX_MODEL_CALLS, parseAgentArgs, UsageError, type AgentOptions } from '../src/agent-args.js';

const parse = (...argv: string[]): AgentOptions => {
  const parsed = parseAgentArgs(argv);
  if (parsed === 'help') throw new Error('help');
  return parsed;
};

function thrownBy(argv: string[]): Error | undefined {
  try {
    parseAgentArgs(argv);
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

describe('parseAgentArgs', () => {
  it('reads the shortest command with its defaults: read-only, text, nothing written, eight model calls, the key from CAOTANG_API_KEY', () => {
    expect(parse('-p', 'Check the manuscript.', '--mock')).toEqual({
      prompt: 'Check the manuscript.',
      project: undefined,
      planFile: undefined,
      provider: { kind: 'mock' },
      keyEnv: DEFAULT_KEY_ENV,
      permission: 'read-only',
      approveTools: undefined,
      write: false,
      outputFormat: 'text',
      maxModelCalls: DEFAULT_MAX_MODEL_CALLS,
    });
    expect(DEFAULT_KEY_ENV).toBe('CAOTANG_API_KEY');
    expect(DEFAULT_MAX_MODEL_CALLS).toBe(8);
  });

  it('reads every flag it names', () => {
    expect(
      parse(
        '--prompt', 'Fill the synopses.', '--project', './novel', '--plan-file', 'plan.json',
        '--provider', 'openrouter', '--base-url', 'https://example.test/v1', '--model', 'a/b', '--thinking', 'high',
        '--key-env', 'MY_KEY', '--permission', 'approve-all', '--approve-tools', 'synopsis.fill, scene.draft', '--write',
        '--output-format', 'stream-json', '--max-model-calls', '12',
      ),
    ).toEqual({
      prompt: 'Fill the synopses.',
      project: './novel',
      planFile: 'plan.json',
      provider: { kind: 'preset', preset: 'openrouter', baseUrl: 'https://example.test/v1', model: 'a/b', thinking: 'high' },
      keyEnv: 'MY_KEY',
      permission: 'approve-all',
      approveTools: ['synopsis.fill', 'scene.draft'],
      write: true,
      outputFormat: 'stream-json',
      maxModelCalls: 12,
    });
  });

  it('reads -p - as the intent on stdin, leaving the prompt for the caller to fill', () => {
    expect(parse('-p', '-', '--mock').prompt).toBeUndefined();
  });

  it('reads --help and -h as help', () => {
    expect(parseAgentArgs(['--help'])).toBe('help');
    expect(parseAgentArgs(['-h'])).toBe('help');
  });

  it('accepts auto with --write, and each output format', () => {
    expect(parse('-p', 'x', '--mock', '--permission', 'auto', '--write')).toMatchObject({ permission: 'auto', write: true });
    for (const format of ['text', 'json', 'stream-json']) expect(parse('-p', 'x', '--mock', '--output-format', format).outputFormat).toBe(format);
  });
});

describe('the key is never a flag value', () => {
  it.each(['--key', '--api-key', '--apikey', '--api_key', '--secret', '--token', '--password', '--API-KEY'])('refuses %s, with a space or an equals sign', (flag) => {
    for (const argv of [['-p', 'x', '--provider', 'openai', flag, 'sk-live-0123456789'], ['-p', 'x', '--provider', 'openai', `${flag}=sk-live-0123456789`]]) {
      const error = thrownBy(argv);
      expect(error).toBeInstanceOf(UsageError);
      expect(error?.message).toContain('--key-env');
      expect(error?.message).not.toContain('sk-live');
    }
  });

  it('names the variable with --key-env, which must be a variable name', () => {
    expect(parse('-p', 'x', '--provider', 'openai', '--key-env', 'OPENAI_API_KEY').keyEnv).toBe('OPENAI_API_KEY');
    expect(thrownBy(['-p', 'x', '--provider', 'openai', '--key-env', 'sk-live-0123456789'])?.message).toMatch(/--key-env must name an environment variable/);
    expect(thrownBy(['-p', 'x', '--provider', 'openai', '--key-env', 'a b'])).toBeInstanceOf(UsageError);
  });
});

describe('usage errors', () => {
  const refused: [string, string[], RegExp][] = [
    ['no intent', ['--mock'], /-p <intent> is required/],
    ['an empty intent', ['-p', '  ', '--mock'], /intent after -p is empty/],
    ['no provider', ['-p', 'x'], /choose a provider/],
    ['--mock with --provider', ['-p', 'x', '--mock', '--provider', 'openai'], /exclusive/],
    ['--model with --mock', ['-p', 'x', '--mock', '--model', 'm'], /does not apply to --mock/],
    ['--key-env with --mock', ['-p', 'x', '--mock', '--key-env', 'K'], /does not apply to --mock/],
    ['an unknown flag', ['-p', 'x', '--mock', '--frobnicate'], /Unknown option/],
    ['a stray word', ['-p', 'x', '--mock', 'extra'], /unexpected argument "extra"/],
    ['an unknown permission', ['-p', 'x', '--mock', '--permission', 'yolo'], /--permission must be one of read-only, auto, approve-all/],
    ['an unknown thinking level', ['-p', 'x', '--provider', 'openai', '--thinking', 'deep'], /--thinking must be one of/],
    ['an unknown output format', ['-p', 'x', '--mock', '--output-format', 'xml'], /--output-format must be one of/],
    ['--write on read-only', ['-p', 'x', '--mock', '--write'], /--write needs --permission auto or approve-all/],
    ['--approve-tools without approve-all', ['-p', 'x', '--mock', '--approve-tools', 'synopsis.fill'], /needs --permission approve-all/],
    ['--approve-tools with auto', ['-p', 'x', '--mock', '--permission', 'auto', '--approve-tools', 'synopsis.fill'], /needs --permission approve-all/],
    ['an empty tool in --approve-tools', ['-p', 'x', '--mock', '--permission', 'approve-all', '--approve-tools', 'a,,b'], /list of tool names/],
    ['--max-model-calls of 0', ['-p', 'x', '--mock', '--max-model-calls', '0'], /from 1 to 1000/],
    ['--max-model-calls that is not a number', ['-p', 'x', '--mock', '--max-model-calls', '3x'], /whole number/],
    ['an empty --project', ['-p', 'x', '--mock', '--project', ' '], /--project needs a path/],
  ];
  it.each(refused)('refuses %s', (_name, argv, message) => {
    const error = thrownBy(argv);
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.message).toMatch(message);
  });
});
