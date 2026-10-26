import { describe, expect, it } from 'vitest';

import { UsageError } from '../src/agent-args.js';
import { SCAN_USAGE, parseScanArgs } from '../src/scan-args.js';

describe('parseScanArgs', () => {
  it('has defaults that read the folder and fail on an error', () => {
    expect(parseScanArgs([])).toEqual({ project: undefined, scope: 'full', checks: undefined, format: 'text', failOn: 'error', write: false, summary: undefined });
  });

  it('takes every flag', () => {
    expect(
      parseScanArgs(['--project', 'novel', '--scope', 'changed', '--checks', 'codex.never-mentioned, pov.coverage', '--format', 'github', '--fail-on', 'never', '--write', '--summary', 'out.md']),
    ).toEqual({
      project: 'novel',
      scope: 'changed',
      checks: ['codex.never-mentioned', 'pov.coverage'],
      format: 'github',
      failOn: 'never',
      write: true,
      summary: 'out.md',
    });
  });

  it('answers --help', () => {
    expect(parseScanArgs(['--help'])).toBe('help');
    expect(SCAN_USAGE).toContain('--fail-on');
    expect(SCAN_USAGE).toContain('--help');
  });

  it.each([
    [['--scope', 'doc'], '--scope must be full or changed'],
    [['--scope', ''], '--scope must be full or changed'],
    [['--format', 'sarif'], '--format must be one of text, markdown, json, github'],
    [['--fail-on', 'fatal'], '--fail-on must be one of error, warning, info, never'],
    [['--checks', 'codex.never-mentioned,nope'], '"nope", which is not a check'],
    [['--checks', ''], '"", which is not a check'],
    [['--project', ' '], '--project needs a path'],
    [['--summary', ''], '--summary needs a path'],
    [['novel'], 'unexpected argument "novel"'],
    [['--provider', 'openai'], 'Unknown option'],
    [['--mock'], 'Unknown option'],
    [['--key-env', 'X'], 'Unknown option'],
    [['--project'], 'argument missing'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseScanArgs(argv)).toThrow(UsageError);
    expect(() => parseScanArgs(argv)).toThrow(message);
  });
});
