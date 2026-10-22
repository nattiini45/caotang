/**
 * The pure parts of the real-key round (e2e/provider-smoke.spec.ts), kept out of the spec so vitest can check them
 * (test/provider-smoke.test.ts): the preset filter, the CI-safe failure text and the job-summary table.
 *
 * Nothing here sees a key. Failure text and the summary carry the preset id, the stage name and a pass or fail with an HTTP
 * status, never a response body, model text or credential: a provider's error body can echo part of a key that GitHub's
 * secret masking does not recognise.
 */

/** The filter variable. It must not start with `CAOTANG_SMOKE_`, or the spec would read it as a preset named "only". */
export const ONLY_PRESETS_VAR = 'CAOTANG_ONLY_PRESETS';

/** The stages the spec runs, in order. The summary lists only these. */
export const SMOKE_STAGES = ['model list', 'streamed completion', 'native tools', 'thinking', 'key redaction'] as const;
export type SmokeStage = (typeof SMOKE_STAGES)[number];

/**
 * The preset ids a `CAOTANG_ONLY_PRESETS` value names, or undefined when it names none (unset, empty or only separators), which
 * means no filter. Ids are separated by spaces or commas and hold lowercase letters, digits and hyphens only; anything else
 * throws, so a mistyped dispatch input fails loudly instead of running nothing. The message does not repeat the value.
 */
export function parsePresetFilter(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw === undefined) return undefined;
  for (const ch of raw) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === ' ' || ch === ',';
    if (!ok) throw new Error(`${ONLY_PRESETS_VAR} may hold only lowercase letters, digits, hyphens, spaces and commas.`);
  }
  const ids = raw.split(',').join(' ').split(' ').filter((id) => id !== '');
  return ids.length === 0 ? undefined : new Set(ids);
}

/** The configured presets the filter keeps; all of them when there is no filter. */
export function applyPresetFilter<T>(configured: ReadonlyMap<string, T>, only: ReadonlySet<string> | undefined): Map<string, T> {
  return new Map([...configured].filter(([id]) => only === undefined || only.has(id)));
}

/** The ids the filter names that have no key, in the filter's order, so the summary can say why a requested preset did not run. */
export function filteredWithoutKey(configured: ReadonlyMap<string, unknown>, only: ReadonlySet<string> | undefined): string[] {
  return only === undefined ? [] : [...only].filter((id) => !configured.has(id));
}

/** The HTTP status an error carries, when it is a number in the HTTP range. A `ProviderError` has one for a failed response. */
export function httpStatus(error: unknown): number | undefined {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** What a CI log may say about a failed stage: the preset, the stage and the HTTP status. Never the error's own text. */
export function failureText(preset: string, stage: SmokeStage, error: unknown): string {
  const status = httpStatus(error);
  return `${preset}: ${stage} failed${status === undefined ? '' : ` (HTTP ${status})`}`;
}

type StageState = { readonly result: 'pass' } | { readonly result: 'fail'; readonly status?: number } | { readonly result: 'not claimed' } | { readonly result: 'running' };

/** One preset's progress through the stages, and the Markdown it leaves in the job summary. */
export class SmokeReport {
  private readonly states = new Map<SmokeStage, StageState>();

  constructor(readonly preset: string) {}

  begin(stage: SmokeStage): void {
    this.states.set(stage, { result: 'running' });
  }

  pass(stage: SmokeStage): void {
    this.states.set(stage, { result: 'pass' });
  }

  fail(stage: SmokeStage, error: unknown): void {
    const status = httpStatus(error);
    this.states.set(stage, status === undefined ? { result: 'fail' } : { result: 'fail', status });
  }

  /** The preset's capability row does not claim the stage's feature, so it does not run. */
  notClaimed(stage: SmokeStage): void {
    this.states.set(stage, { result: 'not claimed' });
  }

  /** A table of every stage. A stage still running when the test ended (a timeout) counts as failed; one never started is "not reached". */
  markdown(): string {
    const rows = SMOKE_STAGES.map((stage) => {
      const state = this.states.get(stage);
      let cell = 'not reached';
      if (state?.result === 'pass') cell = 'pass';
      else if (state?.result === 'fail') cell = state.status === undefined ? 'fail' : `fail (HTTP ${state.status})`;
      else if (state?.result === 'running') cell = 'fail';
      else if (state?.result === 'not claimed') cell = 'not claimed';
      return `| ${this.preset} | ${stage} | ${cell} |`;
    });
    return ['| Preset | Stage | Result |', '| --- | --- | --- |', ...rows, ''].join('\n');
  }
}

/** The line the summary carries when no preset ran, so a green dispatch with no secrets reads as a skip and not as a pass. */
export function nothingRanText(unkeyed: readonly string[]): string {
  const base = 'No preset ran: no `CAOTANG_SMOKE_<PRESET>` secret is set';
  return unkeyed.length === 0 ? `${base}.\n` : `${base} for the presets asked for: ${unkeyed.join(', ')}.\n`;
}
