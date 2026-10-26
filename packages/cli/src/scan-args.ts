/**
 * `caotang scan [flags]`: the flags, checked. A pure function like `parseAgentArgs`, so every rule is tested without a process.
 * The scan has no provider flags: it never calls a model.
 */

import { parseArgs } from 'node:util';

import { DETERMINISTIC_CHECK_IDS, type DeterministicCheckId } from '@caotang/coherence';
import { DEFAULT_FAIL_ON, FAIL_ON_VALUES, SCAN_FORMATS, isFailOn, isScanFormat, type FailOn, type ScanFormat } from '@caotang/scan';

import { UsageError } from './agent-args.js';

export interface ScanArgs {
  /** The project folder, as typed. `undefined`: the working directory. */
  readonly project: string | undefined;
  readonly scope: 'full' | 'changed';
  /** `undefined`: every check. */
  readonly checks: readonly DeterministicCheckId[] | undefined;
  readonly format: ScanFormat;
  readonly failOn: FailOn;
  readonly write: boolean;
  /** Where the Markdown report is also written, as typed. */
  readonly summary: string | undefined;
}

export const SCAN_USAGE = `usage: caotang scan [--project <dir>] [flags]

  --project <dir>       the project folder (default: the working directory)
  --scope <scope>       full (default) reads every document; changed only those edited since the last saved run
  --checks <id,id,...>  run only these checks (default: all of them)
  --format <format>     ${SCAN_FORMATS.join(', ')} (default text); github prints one workflow command per finding
  --fail-on <level>     ${FAIL_ON_VALUES.join(', ')} (default ${DEFAULT_FAIL_ON}): exit 7 when an open finding is at or above it
  --write               save coherence.json with this run in it (default: the folder is only read)
  --summary <file>      also write the Markdown report here (the file named by $GITHUB_STEP_SUMMARY is appended to)

The scan calls no model and reads no key. A finding dismissed or marked fixed in coherence.json neither prints nor fails the run.
Exit codes: 0 clean (or --fail-on never); 1 internal error; 2 usage error or no project; 3 the folder is held by another writer
(--write only); 7 an open finding at or above --fail-on; 8 no such finding, but a document was not UTF-8 text and went unchecked.
`;

/** The scan flags, checked. `argv` is what follows `scan`. */
export function parseScanArgs(argv: readonly string[]): ScanArgs | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: 'string' },
        scope: { type: 'string' },
        checks: { type: 'string' },
        format: { type: 'string' },
        'fail-on': { type: 'string' },
        write: { type: 'boolean', default: false },
        summary: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) return 'help';
  if (positionals.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(positionals[0])}; the folder goes after --project`);
  for (const flag of ['project', 'summary'] as const) {
    if (values[flag] !== undefined && values[flag].trim() === '') throw new UsageError(`--${flag} needs a path`);
  }

  const scope = values.scope ?? 'full';
  if (scope !== 'full' && scope !== 'changed') throw new UsageError(`--scope must be full or changed, got ${JSON.stringify(scope)}`);

  let checks: DeterministicCheckId[] | undefined;
  if (values.checks !== undefined) {
    const known: readonly string[] = DETERMINISTIC_CHECK_IDS;
    checks = [];
    for (const id of values.checks.split(',').map((item) => item.trim())) {
      if (!known.includes(id)) throw new UsageError(`--checks names ${JSON.stringify(id)}, which is not a check; the checks are ${DETERMINISTIC_CHECK_IDS.join(', ')}`);
      checks.push(id as DeterministicCheckId);
    }
  }

  const format = values.format ?? 'text';
  if (!isScanFormat(format)) throw new UsageError(`--format must be one of ${SCAN_FORMATS.join(', ')}, got ${JSON.stringify(format)}`);
  const failOn = values['fail-on'] ?? DEFAULT_FAIL_ON;
  if (!isFailOn(failOn)) throw new UsageError(`--fail-on must be one of ${FAIL_ON_VALUES.join(', ')}, got ${JSON.stringify(failOn)}`);

  return { project: values.project, scope, checks, format, failOn, write: values.write === true, summary: values.summary };
}
