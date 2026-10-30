/**
 * The real-key round in CI (issue 15, decisions.md "Real-key smoke tests"): the preset filter, the CI-safe failure text and
 * summary, and the shape of .github/workflows/provider-smoke.yml.
 *
 * The workflow cannot run here, so these tests hold what keeps a key out of reach: no trigger but a manual dispatch, no step
 * that uploads a file, and the secrets on the one step that runs the spec and nowhere else.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../packages/gateway/src/index.js';
import {
  SMOKE_STAGES,
  SmokeReport,
  applyPresetFilter,
  failureText,
  filteredWithoutKey,
  httpStatus,
  nothingRanText,
  parsePresetFilter,
} from '../e2e/provider-smoke-lib.js';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('\r\n').join('\n');

describe('parsePresetFilter', () => {
  it('means no filter when unset, empty or only separators', () => {
    expect(parsePresetFilter(undefined)).toBeUndefined();
    expect(parsePresetFilter('')).toBeUndefined();
    expect(parsePresetFilter(' , ,  ')).toBeUndefined();
  });

  it('reads ids separated by spaces, commas or both', () => {
    expect(parsePresetFilter('anthropic deepseek')).toEqual(new Set(['anthropic', 'deepseek']));
    expect(parsePresetFilter('anthropic,deepseek')).toEqual(new Set(['anthropic', 'deepseek']));
    expect(parsePresetFilter(' zhipu-zai ,  tencent-hunyuan ')).toEqual(new Set(['zhipu-zai', 'tencent-hunyuan']));
  });

  it('refuses anything outside lowercase letters, digits, hyphens, spaces and commas', () => {
    for (const bad of ['Anthropic', 'a_b', 'a;b', 'a\nb', 'a\tb', '$(x)', 'a=b', '../x']) {
      expect(() => parsePresetFilter(bad), bad).toThrow(/may hold only/);
    }
  });

  it('does not repeat a refused value', () => {
    expect(() => parsePresetFilter('sk-SECRET')).toThrow(/^(?!.*SECRET)/);
  });
});

describe('applyPresetFilter', () => {
  const configured = new Map([
    ['anthropic', 'k1'],
    ['deepseek', 'k2'],
    ['openai', 'k3'],
  ]);

  it('keeps everything without a filter', () => {
    expect([...applyPresetFilter(configured, undefined).keys()]).toEqual(['anthropic', 'deepseek', 'openai']);
  });

  it('keeps only the listed presets, and drops a listed id that has no key', () => {
    expect([...applyPresetFilter(configured, new Set(['deepseek', 'groq'])).keys()]).toEqual(['deepseek']);
  });

  it('can end up empty', () => {
    expect(applyPresetFilter(configured, new Set(['groq'])).size).toBe(0);
  });

  it('names the listed ids that have no key', () => {
    expect(filteredWithoutKey(configured, new Set(['deepseek', 'groq']))).toEqual(['groq']);
    expect(filteredWithoutKey(configured, undefined)).toEqual([]);
  });
});

describe('failure text', () => {
  it('names the preset, the stage and the HTTP status, and nothing from the error', () => {
    const error = Object.assign(new Error('401 {"error":"invalid key sk-ant-abcdef"}'), { status: 401 });
    const text = failureText('anthropic', 'model list', error);
    expect(text).toBe('anthropic: model list failed (HTTP 401)');
    expect(text).not.toContain('abcdef');
  });

  it('has no status for an error without one', () => {
    expect(failureText('openai', 'thinking', new TypeError('fetch failed: host.example'))).toBe('openai: thinking failed');
  });

  it('reads a status only when it is an HTTP status', () => {
    expect(httpStatus({ status: 429 })).toBe(429);
    expect(httpStatus({ status: 'sk-key' })).toBeUndefined();
    expect(httpStatus({ status: 0 })).toBeUndefined();
    expect(httpStatus({ status: 1000 })).toBeUndefined();
    expect(httpStatus(null)).toBeUndefined();
    expect(httpStatus('401')).toBeUndefined();
  });
});

describe('SmokeReport', () => {
  it('lists every stage the spec runs, and only those', () => {
    expect(SMOKE_STAGES).toEqual(['model list', 'streamed completion', 'native tools', 'thinking', 'prompt cache', 'key redaction']);
    const rows = new SmokeReport('groq').markdown().split('\n').filter((line) => line.startsWith('| groq'));
    expect(rows).toHaveLength(SMOKE_STAGES.length);
  });

  it('shows pass, fail with a status, not claimed, and not reached', () => {
    const report = new SmokeReport('deepseek');
    report.begin('model list');
    report.pass('model list');
    report.begin('streamed completion');
    report.pass('streamed completion');
    report.notClaimed('native tools');
    report.begin('thinking');
    report.fail('thinking', Object.assign(new Error('body text'), { status: 400 }));
    expect(report.markdown().split('\n')).toEqual([
      '| Preset | Stage | Result |',
      '| --- | --- | --- |',
      '| deepseek | model list | pass |',
      '| deepseek | streamed completion | pass |',
      '| deepseek | native tools | not claimed |',
      '| deepseek | thinking | fail (HTTP 400) |',
      '| deepseek | key redaction | not reached |',
      '',
    ]);
  });

  it('counts a stage still running at the end (a timeout) as failed', () => {
    const report = new SmokeReport('xai');
    report.begin('model list');
    expect(report.markdown()).toContain('| xai | model list | fail |');
  });

  it('says why nothing ran', () => {
    expect(nothingRanText([])).toContain('No preset ran');
    expect(nothingRanText(['groq', 'xai'])).toContain('for the presets asked for: groq, xai.');
  });
});

describe('provider-smoke.yml', () => {
  const workflow = read('.github/workflows/provider-smoke.yml');
  const code = workflow.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  const text = code.join('\n');

  /** The two-space-indented keys of the top-level `on:` block. */
  function triggers(): string[] {
    const start = code.findIndex((line) => line === 'on:');
    expect(start, 'the workflow has an on: block').toBeGreaterThanOrEqual(0);
    const keys: string[] = [];
    for (const line of code.slice(start + 1)) {
      if (line !== '' && !line.startsWith(' ')) break;
      if (line.startsWith('  ') && !line.startsWith('   ')) keys.push(line.trim().split(':')[0]!);
    }
    return keys;
  }

  it('runs on a manual dispatch only: no pull request, push, schedule or workflow_run', () => {
    expect(triggers()).toEqual(['workflow_dispatch']);
    for (const word of ['pull_request', 'pull_request_target', 'push:', 'schedule', 'workflow_run', 'workflow_call']) {
      expect(text, word).not.toContain(word);
    }
  });

  it('reads the repository and nothing else, in the provider-smoke environment, on main', () => {
    expect(text).toContain('permissions:\n  contents: read\n');
    expect(text).toContain('environment: provider-smoke');
    expect(text).toContain("if: github.ref == 'refs/heads/main'");
    expect(text).toContain('timeout-minutes: 20');
    expect(text).toContain('group: provider-smoke');
  });

  it('uploads nothing and writes no trace or report', () => {
    expect(text).not.toContain('upload-artifact');
    expect(text).not.toContain('actions/cache');
    expect(text).toContain('--retries=0');
    expect(text).toContain('--trace off');
  });

  it('pins the first-party actions the way ci.yml does', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const action of ['actions/checkout', 'actions/setup-node']) {
      const pin = new RegExp(`${action}@(v\\d+)`).exec(ci)?.[1];
      expect(pin, action).toBeDefined();
      expect(text).toContain(`${action}@${pin}`);
    }
    for (const line of code.filter((l) => l.includes('uses:'))) expect(line).toMatch(/uses: actions\/(checkout|setup-node)@v\d+$/);
  });

  it('passes the presets input through the environment, never into a command', () => {
    expect(text).toContain('CAOTANG_ONLY_PRESETS: ${{ inputs.presets }}');
    for (const line of code.filter((l) => l.includes('${{'))) {
      if (line.includes('inputs.')) expect(line).toMatch(/^\s+CAOTANG_ONLY_PRESETS: \$\{\{ inputs\.presets \}\}$/);
    }
  });

  it('gives the secrets to the one step that runs the spec', () => {
    const lines = code;
    const secretLines = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.includes('secrets.'));
    expect(secretLines.length).toBeGreaterThan(0);
    const step = lines.findIndex((line) => line.includes('e2e/provider-smoke.spec.ts'));
    expect(step).toBeGreaterThan(0);
    // The step's `env:` follows its `run:`; the next step (or the end) bounds it.
    const next = lines.findIndex((line, i) => i > step && line.startsWith('      - '));
    const end = next === -1 ? lines.length : next;
    for (const { line, i } of secretLines) {
      expect(i, line).toBeGreaterThan(step);
      expect(i, line).toBeLessThan(end);
    }
    expect(text).toContain("CAOTANG_E2E_NO_SERVER: '1'");
  });

  it('has a secret line for every real preset, named for its id', () => {
    // A server on this computer has no account to put a secret on, so the real-key round is for the hosted providers.
    const real = PRESETS.filter((preset) => preset.local === undefined).map((preset) => preset.id).filter((id) => id !== 'generic' && id !== 'mock');
    expect(real.length).toBeGreaterThan(20);
    for (const id of real) {
      const name = `CAOTANG_SMOKE_${id.toUpperCase().split('-').join('_')}`;
      expect(text, id).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    const named = code.filter((line) => line.includes('secrets.')).length;
    expect(named).toBe(real.length);
  });
});

describe('where the round is described', () => {
  it('no longer says it never runs in CI', () => {
    for (const path of ['docs/decisions.md', 'CHANGELOG.md', 'docs/architecture/providers-browser-cors.md', 'e2e/provider-smoke.spec.ts']) {
      const lines = read(path).toLowerCase().split('\n').filter((line) => line.includes('smoke'));
      expect(lines.length, path).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, path).not.toMatch(/never (run )?in ci|nothing here runs in ci/);
      }
    }
  });
});
