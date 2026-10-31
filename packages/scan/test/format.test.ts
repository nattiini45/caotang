/**
 * The outputs. The github format is the one that can be attacked: a finding's message quotes the manuscript, and the runner reads its
 * log line by line, so no message may end its own command and start another.
 */

import { describe, expect, it } from 'vitest';

import {
  GITHUB_MESSAGE_LIMIT,
  capText,
  escapeData,
  escapeProperty,
  formatGithub,
  formatJson,
  formatMarkdown,
  formatScan,
  formatText,
  githubCommand,
  isScanFormat,
  runScan,
  type PlacedFinding,
  type ScanResult,
} from '../src/index.js';

import { NOW, seedProject } from './fixture.js';

function finding(extra: Partial<PlacedFinding> = {}): PlacedFinding {
  return { id: 'f_AAAAAAAAAA', severity: 'warning', checkId: 'timeline.overlap', message: 'Mara is in two places on day 3', file: 'docs/n_7K2QX9M4A1.md', line: 42, endLine: 43, ...extra };
}

async function baseResult(): Promise<ScanResult> {
  const { fs } = await seedProject();
  return runScan(fs, { now: NOW });
}

function withFindings(result: ScanResult, findings: readonly PlacedFinding[]): ScanResult {
  const count = (severity: PlacedFinding['severity']): number => findings.filter((candidate) => candidate.severity === severity).length;
  return { ...result, findings, counts: { error: count('error'), warning: count('warning'), info: count('info') }, notices: [], unread: [], notes: [], skipped: [], status: 'complete' };
}

/** The runner's decoding of workflow-command data, in one pass. */
function unescape(text: string): string {
  return text.replaceAll(/%(25|0D|0A|3A|2C)/g, (_all, code: string) => ({ '25': '%', '0D': '\r', '0A': '\n', '3A': ':', '2C': ',' })[code] as string);
}

/** The command line shape the runner accepts for one finding: one command, on one line, with properties that hold no `:` or `,`. */
const COMMAND_LINE = /^::(error|warning|notice) (?:file=[^,:\r\n]*,line=\d+,endLine=\d+,)?title=[^,:\r\n]*::[^\r\n]*$/;

/** A small deterministic generator, so a failure is reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PIECES = ['::error::', '::warning file=a,line=1::', '::set-output name=x::', '\n', '\r', '\r\n', '%', '%0A', '%25', ':', ',', ' ', 'a', 'Elena', '“', ' ', '\u0085', '😀', '\\', '\n::stop-commands::'];

function fuzzed(next: () => number): string {
  let out = '';
  for (let i = 0, n = 1 + Math.floor(next() * 12); i < n; i += 1) out += PIECES[Math.floor(next() * PIECES.length)];
  return out;
}

describe('the github format', () => {
  it('prints a finding as a workflow command with its file, lines and check', () => {
    expect(githubCommand(finding({ severity: 'error' }))).toBe('::error file=docs/n_7K2QX9M4A1.md,line=42,endLine=43,title=timeline.overlap::Mara is in two places on day 3');
  });

  it('prints a note as a notice, and a finding that names no file without a file', () => {
    expect(githubCommand(finding({ severity: 'info', file: undefined, line: undefined, endLine: undefined }))).toBe(
      '::notice title=timeline.overlap::Mara is in two places on day 3',
    );
  });

  it('escapes % first, then CR and LF in data', () => {
    expect(escapeData('100%\r\nsure\n')).toBe('100%25%0D%0Asure%0A');
    expect(escapeData('%0A')).toBe('%250A');
  });

  it('escapes : and , in a property as well', () => {
    expect(escapeProperty('docs/a:b,c.md')).toBe('docs/a%3Ab%2Cc.md');
    expect(escapeProperty('50%\n')).toBe('50%25%0A');
    expect(escapeData('a:b,c')).toBe('a:b,c');
    const command = githubCommand(finding({ file: 'docs/a:b,c.md', checkId: 'x:y,z' }));
    expect(command).toBe('::warning file=docs/a%3Ab%2Cc.md,line=42,endLine=43,title=x%3Ay%2Cz::Mara is in two places on day 3');
  });

  it('caps a long message, without splitting a surrogate pair', () => {
    const long = '😀'.repeat(GITHUB_MESSAGE_LIMIT + 50);
    const command = githubCommand(finding({ message: long }));
    const data = unescape(command.slice(command.indexOf('::', 2) + 2));
    expect([...data]).toHaveLength(GITHUB_MESSAGE_LIMIT);
    expect(data.endsWith('…')).toBe(true);
    expect(capText('short', 10)).toBe('short');
  });

  it('can never be made to print a second command, whatever the quote holds', () => {
    const next = random(51);
    for (let round = 0; round < 500; round += 1) {
      const hostile = [fuzzed(next), `${fuzzed(next)}::error::injected\n::error::again`, '\n::error::injected'];
      for (const text of hostile) {
        const command = githubCommand(finding({ message: text, checkId: text, file: `docs/${text}.md` }));
        expect(command).toMatch(COMMAND_LINE);
        expect(command.split(/[\r\n]/)).toHaveLength(1);
      }
    }
  });

  it('prints exactly one line per finding, and decodes back to the message', async () => {
    const next = random(7);
    const findings = Array.from({ length: 40 }, (_unused, i) => finding({ id: `f_${i}`, message: fuzzed(next) }));
    const output = formatGithub(withFindings(await baseResult(), findings));
    const lines = output.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(findings.length);
    lines.forEach((line, i) => {
      expect(line).toMatch(COMMAND_LINE);
      const message = findings[i]?.message ?? '';
      const data = unescape(line.slice(line.indexOf('::', 2) + 2));
      expect(data).toBe(capText(message, GITHUB_MESSAGE_LIMIT));
    });
  });

  it('prints nothing for a clean, complete scan', async () => {
    expect(formatGithub(withFindings(await baseResult(), []))).toBe('');
  });

  it('says a partial scan was partial, in a notice that cannot carry a second command', async () => {
    const result = { ...(await baseResult()), findings: [], notices: ['coherence.json could not be read.\n::error::gotcha'] };
    const lines = formatGithub(result).trimEnd().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line).toMatch(/^::notice title=caotang scan::/);
    expect(lines.some((line) => line.includes('partial scan'))).toBe(true);
    expect(lines.some((line) => line.includes('coherence.json could not be read.%0A::error::gotcha'))).toBe(true);
  });
});

describe('the other formats', () => {
  it('maps severity to the annotation level: error, warning, and info as notice', () => {
    expect(githubCommand(finding({ severity: 'error' })).startsWith('::error ')).toBe(true);
    expect(githubCommand(finding({ severity: 'warning' })).startsWith('::warning ')).toBe(true);
    expect(githubCommand(finding({ severity: 'info' })).startsWith('::notice ')).toBe(true);
  });

  it('prints text as one line per finding with its file and line, then the counts', async () => {
    const result = withFindings(await baseResult(), [finding({ message: 'two\nlines' })]);
    const lines = formatText(result).trimEnd().split('\n');
    expect(lines[0]).toBe('docs/n_7K2QX9M4A1.md:42: warning timeline.overlap two lines');
    expect(lines[1]).toMatch(/^1 open finding \(0 errors, 1 warning, 0 notes\) in \d+ documents?\.$/);
  });

  it('prints the exporter’s Markdown report unchanged', async () => {
    const result = await baseResult();
    expect(formatMarkdown(result)).toBe(formatScan(result, 'markdown'));
    expect(formatMarkdown(result)).toContain('# Coherence report: The Lighthouse Keeper');
    expect(formatMarkdown(result)).toContain('1 open finding');
  });

  it('prints JSON that parses and carries the exit code, the counts and the placed findings', async () => {
    const result = await baseResult();
    const parsed = JSON.parse(formatJson(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ formatVersion: 1, project: 'The Lighthouse Keeper', status: 'partial', exitCode: 7, written: false, counts: { error: 1, warning: 0, info: 0 } });
    expect(parsed.findings).toEqual(result.findings);
  });

  it('knows its four formats', () => {
    expect(['text', 'markdown', 'json', 'github'].every(isScanFormat)).toBe(true);
    expect(isScanFormat('sarif')).toBe(false);
  });
});
