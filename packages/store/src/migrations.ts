/**
 * Migration registry — [project-format.md §6](docs/architecture/project-format.md).
 *
 * §6 in full, because every rule below is transcribed from it rather than
 * invented: "Migrations run **load-time, in-memory first**: `v(n) → v(n+1)`
 * functions in a fixed registry, each with a unit test fixture pair. A migration
 * failure aborts the open with the project untouched."
 *
 * Four decisions are load-bearing and each is enforced structurally, not by
 * convention:
 *
 *   1. **The chain must be contiguous.** A missing `v(n) → v(n+1)` step is a hard
 *      failure naming the exact version, never a silent skip. A registry that
 *      quietly stopped at the first gap would hand the caller a manifest that
 *      claims to be current and is not — the one failure mode a migration
 *      cannot have, because §2 step 2 already refuses to guess-upgrade.
 *   2. **The runner owns the version stamp.** A migration returns *content*; the
 *      runner writes `formatVersion` from the step it is on. A migration that
 *      returns a wrong or missing version therefore cannot desync the chain.
 *   3. **The caller's object is never mutated.** The chain starts from a deep
 *      clone, which is what makes "the project untouched" true even when a
 *      migration mutates its own argument in place and a later step throws. On
 *      failure the caller holds the object it passed in, byte for byte.
 *   4. **The registry is empty, and that is correct.** v1 is the first format;
 *      v2 protects newly written codex data without transforming v1 data.
 *      The migration chain is tested against synthetic steps and fixture pairs.
 */

import { FORMAT_VERSION, type Manifest } from './manifest.js';

/** The lowest `formatVersion` that names a real Caotang format. */
export const FIRST_FORMAT_VERSION = 1;

/**
 * One `v(n) → v(n+1)` step.
 *
 * `run` takes the manifest as plain JSON data and returns the upgraded content.
 * It must not set `formatVersion` — {@link runMigrations} stamps that from `to`.
 * Throwing aborts the open; there is no partial-migration result.
 */
export interface Migration {
  /** the version this step upgrades *from* */
  readonly from: number;
  /** always `from + 1` — §6 fixes the step size at one version */
  readonly to: number;
  /** one line, for the load notice the user sees */
  readonly describe: string;
  run(input: Record<string, unknown>): Record<string, unknown>;
}

/** A fixed, ordered set of one-version steps. */
export type MigrationRegistry = readonly Migration[];

/** What a step did, for reporting. */
export interface AppliedMigration {
  readonly from: number;
  readonly to: number;
  readonly describe: string;
}

/**
 * A migration could not be run, or could not be run safely.
 *
 * Distinct from a *validation* failure on purpose: §2's three gates abort three
 * different ways, and a version-gate abort is not a field violation. Throwing
 * rather than collecting keeps the cause chain intact and guarantees no
 * half-migrated object is ever handed back to a caller.
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    readonly from: number,
    readonly to: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * The production registry.
 *
 * Empty on purpose — see the module note, point 4. The first real entry arrives
 * with format v2, and must arrive with a fixture pair in
 * `test/migrations.test.ts` or that suite fails.
 */
export const MIGRATIONS: MigrationRegistry = Object.freeze([]);

/**
 * The two facts a load or a write needs about the format: which steps this build
 * knows, and which version it is at.
 *
 * Bundled as one value because §2 step 2 and §6's writer clause both need *both*
 * halves and a half-known build is the failure this whole module refuses to
 * produce — a writer that stamps v2 with no `v1 → v2` step cannot undo the lie,
 * and a validator that migrates to v2 with no step to run aborts every open.
 */
export interface FormatContext {
  readonly registry: MigrationRegistry;
  /** the highest supported version */
  readonly current: number;
}

/**
 * The production context: the shipped registry at the shipped version.
 *
 * **Every default in the package resolves to this object, and it is a frozen
 * singleton rather than a fresh literal** so that "a caller passed the
 * production context" and "a caller passed nothing" are the same value at
 * runtime. A test may substitute a synthetic registry to reach the load path
 * §6 describes; what it may not do is make production do so, and the one thing
 * that could let it — seeding a fake step into {@link MIGRATIONS} to make a test
 * pass — is asserted against in `test/migration-path.test.ts`.
 */
export const PRODUCTION_FORMAT: FormatContext = Object.freeze({
  registry: MIGRATIONS,
  current: FORMAT_VERSION,
});

/** v1 and v2 coexist in production; a substituted context still requires its migration chain. */
export function migrationTarget(format: FormatContext): number {
  return format === PRODUCTION_FORMAT ? FIRST_FORMAT_VERSION : format.current;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The manifest is JSON by definition — it came from `JSON.parse` — so a JSON
 * round-trip is a faithful deep clone. The one thing it does not carry is an
 * explicit `undefined` property, which cannot occur in parsed JSON.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The registry's structural invariant, checked on every run rather than trusted. */
function assertRegistry(registry: MigrationRegistry): void {
  const seen = new Set<number>();
  for (const m of registry) {
    if (m.to !== m.from + 1) {
      throw new MigrationError(
        `migration from v${m.from} declares v${m.to}; §6 fixes every step at v(n) → v(n+1)`,
        m.from,
        m.to,
      );
    }
    if (seen.has(m.from)) {
      throw new MigrationError(
        `two migrations registered from v${m.from}; a version has exactly one step`,
        m.from,
        m.to,
      );
    }
    seen.add(m.from);
  }
}

/** The manifest's own version, or a typed failure explaining why there isn't one. */
export function readFormatVersion(input: unknown): number {
  if (!isRecord(input)) {
    throw new MigrationError(
      'not a Caotang project: manifest is not an object',
      Number.NaN,
      Number.NaN,
    );
  }
  const version = input.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < FIRST_FORMAT_VERSION) {
    throw new MigrationError(
      `expected formatVersion integer ≥ ${FIRST_FORMAT_VERSION}, got ${JSON.stringify(version)}`,
      Number.NaN,
      Number.NaN,
    );
  }
  return version;
}

export interface MigrationResult {
  /** The upgraded manifest. A fresh object — never the caller's input. */
  readonly manifest: Record<string, unknown>;
  /** In the order they ran; empty when the input was already current or newer. */
  readonly applied: readonly AppliedMigration[];
}

/**
 * Run `input` up to `target`, one registered step at a time.
 *
 * Pure: the input is not mutated, and on any failure nothing is returned at all.
 * An input already at or beyond `target` is returned as-is with no steps run —
 * refusing a *newer* manifest is the version gate's job in `validate.ts`, not
 * this function's, so that the two decisions stay in one place.
 */
export function runMigrations(
  registry: MigrationRegistry,
  input: unknown,
  target: number = FORMAT_VERSION,
): MigrationResult {
  const version = readFormatVersion(input);
  if (version >= target) {
    return { manifest: input as Record<string, unknown>, applied: [] };
  }
  assertRegistry(registry);

  let work = clone(input as Record<string, unknown>);
  const applied: AppliedMigration[] = [];

  for (let step = version; step < target; step++) {
    const migration = registry.find((m) => m.from === step);
    if (!migration) {
      throw new MigrationError(
        `no migration registered from v${step} to v${step + 1}; refusing to open a project ` +
          `this build cannot upgrade to v${target}`,
        step,
        step + 1,
      );
    }

    let next: unknown;
    try {
      next = migration.run(work);
    } catch (cause) {
      throw new MigrationError(
        `migration v${migration.from} → v${migration.to} (${migration.describe}) failed: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
        migration.from,
        migration.to,
        { cause },
      );
    }

    if (!isRecord(next)) {
      throw new MigrationError(
        `migration v${migration.from} → v${migration.to} (${migration.describe}) returned ` +
          `${next === null ? 'null' : typeof next}, expected a manifest object`,
        migration.from,
        migration.to,
      );
    }

    // The runner owns the stamp — see the module note, point 2.
    work = { ...next, formatVersion: migration.to };
    applied.push({ from: migration.from, to: migration.to, describe: migration.describe });
  }

  return { manifest: work, applied };
}

/** {@link runMigrations} against the production {@link MIGRATIONS} registry. */
export function migrateToCurrent(input: unknown, target: number = migrationTarget(PRODUCTION_FORMAT)): MigrationResult {
  return runMigrations(MIGRATIONS, input, target);
}

/** Narrowing helper for the one place that needs the typed shape. */
export function asManifest(value: Record<string, unknown>): Manifest {
  return value as unknown as Manifest;
}
