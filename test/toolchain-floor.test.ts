/**
 * The toolchain floor, and the two facts `pnpm audit` cannot see.
 *
 * ## Why this file exists
 *
 * The root manifest pins a toolchain floor — `vitest`, `vite`, and `engines.node`
 * set to vitest's own floor — that keeps a vulnerable subtree out of the install.
 * That absence should be *proved rather than asserted*, and a lockfile read plus
 * `pnpm audit` is not a proof that keeps running:
 *
 * 1. **A guard belongs in the root suite.** `vitest.config.ts` collects the root
 *    `test` suite alongside the package tests, because *"a guard that verify never
 *    collects is a guard that is green because it never ran."* So this check needs
 *    no workspace package of its own.
 *
 * 2. **`pnpm audit` is blind to the trap.** `@vitejs/plugin-react` 6.1.1 peers
 *    `vite ^8.0.0`, so adopting it forces a Vite-major migration.
 *    **That is a peer-range fact, and no advisory database will ever carry it.**
 *    Measured in a clean-room `%TEMP%` project, not argued: `pnpm add -D
 *    @vitejs/plugin-react@6.1.1` followed by `pnpm audit` reports
 *    **`No known vulnerabilities found`**. A clean `pnpm audit` therefore proves
 *    nothing about that constraint, which makes the peer assertions below the part
 *    of this file that is not a duplicate of `pnpm audit`.
 *
 * ## The technique
 *
 * **Read the fact out of the lockfile; never transcribe it.** The peer ranges and
 * engine floors this file checks are all recorded in `pnpm-lock.yaml` — `vitest@5.0.3`
 * carries `engines: {node: …}` and a `vite` peer range, and so does
 * `@vitejs/plugin-react@4.7.0`. So a floor that moves is *checked against the new
 * fact* rather than against a copy of the old one, and the legitimate future
 * migration this repo has already scoped (Vite 8, or plugin-react 5.x/6.x) makes
 * these assertions pass on its merits instead of needing an exemption.
 *
 * That is also why no version is written as a literal here. docs/decisions.md
 * states the plugin-react constraint as its reason, not as *"stays on 4.x"* —
 * **the reason is durable and the version is not** — and a guard built on the
 * version would freeze the over-broad form that entry rejects.
 *
 * Every absence assertion in this file passes vacuously against an empty parse, so
 * the parse is asserted first, in its own test, exactly as the queue guard does.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectLockfile } from './lockfile';

const repoRoot = resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  engines: { node: string };
  devDependencies: Record<string, string>;
};

/**
 * The build allowlist, read from **pnpm-workspace.yaml**.
 *
 * Not from a `pnpm` block in package.json: reading it from there would be a
 * silent wrong answer rather than an error, because pnpm 12 does not read that
 * key at all, so a manifest carrying it would satisfy such a helper while pnpm
 * ignored the entry entirely — and, as measured,
 * failed the install with ERR_PNPM_IGNORED_BUILDS.
 *
 * Parsed by hand because the repo reads its own lockfile by hand for the same
 * reason, and because a YAML parser for one optional list is a dependency this
 * guard does not justify. Absent means "no allowlist", which is a legitimate
 * state, not a parse failure.
 */
function buildAllowlist(): string[] {
  const yaml = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const block = /^onlyBuiltDependencies:\s*$/m.exec(yaml);
  if (!block) return [];
  return yaml
    .slice(block.index + block[0].length)
    .split(/\r?\n/)
    .map((line) => /^\s+-\s+(\S+)\s*$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}
const lockfile = projectLockfile(readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8'));

/**
 * The lockfile's `packages:` block — the **resolutions**, which is what actually
 * installs. `importers:` records declared specs and `snapshots:` records peer-
 * suffixed duplicates of the same resolutions, so neither is the complete set
 *. Reading only one of the three audits a subset.
 *
 * Scoped names are single-quoted in the lockfile, and the quotes are stripped here
 * because an unstripped quote makes `@scope/pkg` fail every filter and report as
 * **absent** — the useful direction to fail in, and the one this file's own first
 * test exists to catch.
 */
interface PackageEntry {
  name: string;
  version: string;
  /** Raw block text, for the `engines` and `peerDependencies` a floor is read from. */
  block: string;
}

function parseResolutions(): PackageEntry[] {
  const lines = lockfile.split(/\r?\n/);
  const entries: PackageEntry[] = [];
  let inPackages = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    // Any other top-level key ends the block; `snapshots:` is one of them.
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;

    const header = /^ {2}(\S.*?):\s*$/.exec(line);
    if (!header) continue;
    const key = header[1]!.replace(/^'(.*)'$/, '$1');
    const body = key.startsWith('@') ? key.slice(1) : key;
    const at = body.lastIndexOf('@');
    if (at <= 0) continue;
    entries.push({
      name: key.startsWith('@') ? `@${body.slice(0, at)}` : body.slice(0, at),
      version: body.slice(at + 1),
      block: lines.slice(i + 1, i + 60).join('\n'),
    });
  }
  return entries;
}

const resolutions = parseResolutions();

/** Every resolved version of `name`, sorted. */
function resolvedVersions(name: string): string[] {
  return [...new Set(resolutions.filter((r) => r.name === name).map((r) => r.version))].sort();
}

/** The lockfile block for the single resolved `name@version`. */
function entryFor(name: string, version: string): string {
  const hit = resolutions.find((r) => r.name === name && r.version === version);
  if (!hit) throw new Error(`no lockfile entry for ${name}@${version}`);
  return hit.block;
}

const majorOf = (version: string): number => Number(version.split('.')[0]);

/**
 * The majors a `^`-rooted peer range admits, read out of the package's own
 * declared `peerDependencies` line.
 *
 * Deliberately narrow: `vite: ^6.4.0 || ^7.0.0 || ^8.0.0` yields `{6,7,8}`. A
 * range it cannot read yields an **empty set and a thrown error**, never a
 * permissive one — the shape this repo has now found three times, where a parse
 * that silently matches nothing is indistinguishable from a guard that silently
 * checks nothing.
 */
function peerMajors(name: string, version: string, peer: string): Set<number> {
  const block = entryFor(name, version);
  const section = /peerDependencies:\n((?: {4,}\S.*\n?)+)/.exec(block);
  if (!section) throw new Error(`${name}@${version} declares no peerDependencies to read`);
  const line = new RegExp(`^\\s+'?${peer}'?:\\s*(.+)$`, 'm').exec(section[1]!);
  if (!line) throw new Error(`${name}@${version} declares no '${peer}' peer`);
  const majors = [...line[1]!.matchAll(/\^\s*(\d+)/g)].map((m) => Number(m[1]));
  if (majors.length === 0) {
    throw new Error(`${name}@${version} '${peer}' peer is not caret-rooted: ${line[1]}`);
  }
  return new Set(majors);
}

/** The `node` floor a package declares, read out of its lockfile entry. */
function declaredEngines(name: string, version: string): string {
  const block = entryFor(name, version);
  const engines = /engines:\s*\{node:\s*([^}]+)\}/.exec(block);
  if (!engines) throw new Error(`${name}@${version} declares no engines in the lockfile`);
  return engines[1]!.trim();
}

describe("the toolchain floor, read out of the lockfile", () => {
  it('parses the resolutions -- a parse that matches nothing fails, not passes', () => {
    // The control assertion, and it is load-bearing rather than decorative: every
    // `absent` claim below is satisfied by an empty map, so without this a broken
    // parser would report a clean tree for the wrong reason.
    //
    // pnpm 12 writes the lockfile as TWO documents (see test/lockfile.ts); a
    // reader of the first alone sees about 15 resolutions, and this control
    // fails with `expected 15 to be greater than or equal to 300`. The
    // guard below the control could not notice that on its own — every
    // assertion it makes is an `absent` claim, and an empty map satisfies all
    // of them.
    expect(resolutions.length).toBeGreaterThanOrEqual(300);
    for (const name of ['vitest', 'vite', '@vitejs/plugin-react', 'typescript']) {
      expect(resolvedVersions(name), `${name} must resolve somewhere in the tree`).not.toEqual([]);
    }
    // Spot-check the exact vitest resolution the floor pins.
    expect(resolvedVersions('vitest')).toEqual(['5.0.3']);
  });

  it('carries no resolution of vite below major 6 -- the vulnerable subtree stays absent', () => {
    // `vite@5.4.21` and `esbuild@0.21.5` are absent because *the edge that nested
    // them is gone*, not because anything was upgraded past them. The durable
    // form of that claim is a floor, not two versions: a later toolchain change
    // may move either one upward, and must not move either one downward without
    // deciding to.
    const vite = resolvedVersions('vite');
    expect(vite.filter((v) => majorOf(v) < 6), `vite below 6 resolved: ${vite.join(', ')}`).toEqual([]);

    // The esbuild half is now stronger than a version floor: since Vite 8,
    // **esbuild is not in the tree at all** (it bundled with esbuild; Vite 8
    // bundles with rolldown/oxc). There are 0 resolutions in the lockfile, and
    // `pnpm install` completes with no build allowlist, which is why
    // pnpm-workspace.yaml does not name it. Asserted as an absence rather than
    // left to the floor above, because "esbuild is gone entirely" is the fact a
    // future change would otherwise have to re-derive.
    expect(resolvedVersions('esbuild'), 'esbuild no longer resolves: Vite 8 bundles with rolldown/oxc').toEqual(
      [],
    );
  });

  it('resolves one vite major, because a second one is a nested vulnerable edge again', () => {
    // The subject is **one** major, not a particular one. A literal such as `[6]`
    // would fail the next Vite-major move for being a fossil: the rule is
    // "no second, nested vite edge", so the number to
    // compare against is the major the root manifest *declares*, which moves
    // only when someone decides to move it.
    const declared = majorOf(manifest.devDependencies.vite.replace(/^\D*/, ''));
    const majors = [...new Set(resolvedVersions('vite').map(majorOf))].sort();
    expect(majors, `vite majors in the tree: ${majors.join(', ')}`).toEqual([declared]);
  });

  it("has vitest's resolved vite inside vitest's own declared peer range", () => {
    const version = resolvedVersions('vitest')[0]!;
    const viteMajor = majorOf(resolvedVersions('vite')[0]!);
    const admitted = peerMajors('vitest', version, 'vite');
    expect(
      admitted.has(viteMajor),
      `vitest@${version} admits vite majors {${[...admitted].sort().join(',')}}, ` +
        `but the tree resolves vite ${viteMajor}. The structural claim is that vitest 5 takes vite as a peer ` +
        `(^6.4.0 || ^7 || ^8) rather than a dependency, so the resolution must satisfy the peer.`,
    ).toBe(true);
  });

  it('has plugin-react inside its own declared vite peer range -- the trap pnpm audit cannot see', () => {
    // The constraint, stated as its reason. `@vitejs/plugin-react` 4.7.0 admits
    // vite majors {4,5,6,7}; 6.1.1 admits only {8} and would force the root Vite
    // major with it. Asserting "stays on 4.x" would freeze the version the
    // decisions entry rejects; asserting the peer range keeps the real rule and lets the
    // Vite-8 migration pass on its merits.
    const viteMajor = majorOf(resolvedVersions('vite')[0]!);
    const version = resolvedVersions('@vitejs/plugin-react')[0]!;
    const admitted = peerMajors('@vitejs/plugin-react', version, 'vite');
    expect(
      admitted.has(viteMajor),
      `@vitejs/plugin-react@${version} admits vite majors {${[...admitted].sort().join(',')}}, but the tree ` +
        `resolves vite ${viteMajor}. Moving plugin-react to 6.x is only safe alongside a Vite-major migration, ` +
        `and "pnpm audit" will not report it: 6.1.1 audits clean on its own.`,
    ).toBe(true);
  });

  it('declares engines.node as vitest does, with the 22 line at the highest 22 floor the tree declares', () => {
    // The third declaration was vitest 5's own `engines`, copied verbatim. If
    // vitest moves, the user-facing support claim has to move with it — and this
    // is the assertion that says so, in the failure direction the repo wants:
    // loud, on the day the floor moves.
    //
    // The install is engine-strict, so a package that needs a later Node 22 than
    // vitest does raises the 22 line for everyone: Lingui 6 (the interface
    // catalogues, #322) declares `>=22.19.0`, and Node 22.12 refuses to install it.
    // The floor is read from every lockfile entry, never transcribed.
    const vitest = declaredEngines('vitest', resolvedVersions('vitest')[0]!);
    const floors = resolutions
      .map((r) => /engines:\s*\{node:\s*([^}]+)\}/.exec(r.block.split(/\n(?= {2}\S)/)[0]!)?.[1] ?? '')
      .flatMap((range) => [...range.matchAll(/(?:\^|>=)\s*22\.(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const));
    expect(floors.length).toBeGreaterThan(0);
    const [minor, patch] = floors.reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? b : a));
    expect(vitest).toMatch(/\^22\.\d+\.\d+/);
    expect(manifest.engines.node).toBe(vitest.replace(/\^22\.\d+\.\d+/, `^22.${minor}.${patch}`));
  });

  it('installs nothing whose engines exclude the Node 22 line unless a patch says why', () => {
    // CI's 22 leg runs an engine-strict install, so one package that asks for Node 24 alone fails it, and a peer or engines
    // fact like this is invisible to `pnpm audit`. pseudolocale 3 (under @lingui/cli) declares `>=24.0.0` for a few
    // string functions; patches/pseudolocale@3.1.0.patch sets it to the 22 floor, as the pdfjs-dist patch does.
    const workspace = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    const patched = new Set([...workspace.matchAll(/^\s+'?([^\s:']+)'?:\s*patches\//gm)].map((m) => m[1]!));
    expect(patched.size).toBeGreaterThan(0);
    const excluding = resolutions
      .filter((r) => {
        // The entry's own lines only: `block` runs on into the entries after it.
        const own = r.block.split(/\n(?= {2}\S)/)[0]!;
        const range = /engines:\s*\{node:\s*([^}]+)\}/.exec(own)?.[1];
        if (range === undefined) return false;
        const lows = range.split('||').map((part) => Number(/(\d+)/.exec(part)?.[1] ?? '0'));
        return lows.every((major) => major > 22);
      })
      .map((r) => `${r.name}@${r.version}`)
      .filter((key) => !patched.has(key));
    expect(excluding, `packages whose engines leave out Node 22: ${excluding.join(', ')}`).toEqual([]);
  });

  it('names no build-allowlist entry that is not installed', () => {
    // A build-allowlist entry is argued from the *package*, not from a version:
    // dropping an entry the install still needs would suppress its build step.
    // This states the conditional itself, so a later toolchain change that
    // removes a package is told to remove the entry too.
    //
    // **The allowlist lives in pnpm-workspace.yaml**, not package.json — pnpm 12
    // reads it from there, and an entry left in package.json makes pnpm treat the
    // install script as an *ignored* build (ERR_PNPM_IGNORED_BUILDS). And
    // **esbuild is not installed at all**, since Vite 8 bundles with
    // rolldown/oxc — so this asserts the rule against a list that may be empty.
    const allowlist = buildAllowlist();
    const orphan = allowlist.filter((name) => resolvedVersions(name).length === 0);
    expect(orphan, 'the build allowlist names packages that are not resolved').toEqual([]);
  });
});
