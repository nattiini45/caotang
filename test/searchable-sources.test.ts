/**
 * No **guarded** source file may carry a literal control byte.
 *
 * The guard covers four roots (`packages`, `apps`, `test`, `e2e`); see
 * `GUARDED_ROOT_ARGS` below. Planting real `0x00` and `0x7F` bytes in a file
 * outside them leaves this scan returning `[]`, while `rg -n` on the same file
 * prints `binary file matches` with no line numbers and exit 0.
 *
 * ## The defect this file exists to prevent
 *
 * Once, `packages/store/src/zip.ts` line 217 sanitised a project
 * name with a control-character strip written as **literal control bytes**
 * instead of escape sequences — the three bytes in its class were `0x00`,
 * `0x1F` and `0x7F`. ripgrep classifies any file containing a `0x00` as binary
 * and prints no line output for it, so for that file:
 *
 *   - `rg -n writeSessionsFile packages/store/src/zip.ts`
 *     → `binary file matches (found "\0" byte around offset 9918)` — **no line
 *       numbers**, and **exit 0**
 *   - `rg -an` on the same file → 5 matches, with line numbers
 *
 * and a search tool renders the first form as **"No matches found"**. That is an
 * answer with the shape of a fact and none of the content. `zip.ts` owns
 * `exportProjectZip`, `importProjectZip`, `buildToc`, `bundleFilename` and
 * `isRecoverySnapshot`, so anyone searching for that code was told it was not
 * there. **`rg` exits 0
 * in both forms**, so a script keyed on exit status cannot tell them apart
 * either. Both directions were re-measured while fixing it: the repaired file
 * reports 5 line-numbered matches, and a byte-identical copy with one `0x00`
 * appended reports none and still exits 0.
 *
 * The fix is the escaped form, which is behaviour-identical and drops the
 * `eslint-disable` line that existed only to suppress `no-control-regex` on the
 * literal bytes. **The escape alone would leave the next instance free, so the
 * guard below is the other half of the fix.**
 *
 * ## What it checks, and why a byte and not a heuristic
 *
 * The cause is the byte, so the check is a byte check: every C0 control
 * character except tab, LF and CR, plus DEL (`0x7F`), is refused in every
 * non-ignored file under the four roots. The row asked for `0x00` alone; the
 * file turned out to carry `0x1F` and `0x7F` as well, which is why the class is
 * the subject — `0x1F` and `0x7F` do not trigger ripgrep's binary detection but
 * are just as unreadable in a source line, and the row's own byte scan missed
 * `0x7F` by counting only bytes below `0x20`.
 *
 * Bytes `0x80`–`0xFF` are never refused: the guard reads raw bytes, so a byte
 * above `0x7F` may be part of any multi-byte UTF-8 sequence. Flagging those
 * would make the guard wrong about every non-ASCII source file in the tree.
 *
 * ## What keeps it from being vacuous
 *
 * 1. **The predicate is asserted against an enumerated list**, not against a
 *    restatement of itself. A table written as `byte < 0x20 && …` next to the
 *    implementation it checks would still pass if the class were narrowed, so
 *    the thirty refused values are written out one by one.
 * 2. **The real scan function is run against a file that does carry control
 *    bytes, on disk.** `offendersIn` is the same function the property test
 *    below uses, given a temp directory and a planted fixture of real `0x00`,
 *    `0x1F` and `0x7F` bytes, read back from the filesystem. That proves the
 *    check fires without committing a NUL into the tree, which would have forced
 *    this guard to exempt its own fixture — and an exemption is the defect
 *    wearing a note: a guard that cannot see the one file it was told not to
 *    see is a guard with a documented blind spot.
 * 3. **The enumeration is asserted non-empty and asserted by member.** A typo in
 *    the pathspec would otherwise leave this guard green because it scanned
 *    nothing.
 *
 * ## Why not ripgrep itself
 *
 * The obvious version shells out to `rg`, and it is the wrong one: `rg` is a
 * developer's tool rather than a dependency of this repository, so the guard
 * would pass vacuously on any machine without it, and ripgrep's binary
 * heuristic is a movable target across versions. The reproduction is in this
 * header; the assertion is on the cause.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');

/**
 * The roots the guard covers, as `git ls-files` arguments.
 *
 * `packages` and `apps` rather than `packages/*\/src` and `apps/*\/src`: a
 * control byte in a `package.json` or a `tsconfig.json` hides a manifest line
 * from search exactly as well as one in a `.ts` file, and every file this
 * resolves to is text. A binary asset under these roots would be a real signal,
 * and the remedy would be a named exemption — a visible edit — not a silent
 * filter.
 *
 * `-c -o` rather than the default cached-only listing: `pnpm verify` runs
 * **before** the commit, so a tracked-only scan would miss every file the
 * current change has written but not yet staged, which is exactly when a
 * stray control byte is most likely to appear. `--exclude-standard` keeps
 * `node_modules`, `dist` and the rest of `.gitignore` out. `-z` makes git emit
 * NUL-separated, unquoted, forward-slash paths; without it the paths come back
 * newline-separated and Windows-quoted, and a split on NUL yields one entry
 * holding the whole listing — a scan that reads one enormous filename and
 * reports a single ENOENT.
 */
const GUARDED_ROOT_ARGS = [
  '-z',
  '-c',
  '-o',
  '--exclude-standard',
  '--',
  'packages',
  'apps',
  'test',
  'e2e',
];

/**
 * The refused byte values, written out rather than derived from the predicate.
 *
 * Thirty values: all of C0 (`0x00`–`0x1F`) except tab, LF and CR, plus DEL.
 */
const FORBIDDEN_BYTES: readonly number[] = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12,
  0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f,
];

/**
 * Bytes that must pass: line structure, printable ASCII, and UTF-8.
 *
 * The last group is why the guard reads raw bytes and stops at `0x7F` — every
 * non-ASCII source file in this tree lives at `0x80` and above.
 */
const PERMITTED_SAMPLES: readonly number[] = [
  0x09, 0x0a, 0x0d, 0x20, 0x41, 0x7e, 0x80, 0xc3, 0xa9, 0xff,
];

/**
 * A literal control byte in a source file: C0 except tab, LF and CR, plus DEL.
 *
 * Tab, LF and CR are line structure rather than content, and every text file has
 * them. Everything at or above `0x80` passes, because a raw byte read cannot
 * tell a UTF-8 continuation byte from anything else.
 */
function isLiteralControlByte(byte: number): boolean {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false;
  return byte < 0x20 || byte === 0x7f;
}

/** The offsets of every literal control byte in `bytes`, ascending. */
function controlByteOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (isLiteralControlByte(bytes[i] as number)) offsets.push(i);
  }
  return offsets;
}

/** Every non-ignored file under the guarded roots, as repo-relative posix paths. */
function guardedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', ...GUARDED_ROOT_ARGS], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return out.split('\0').filter((entry) => entry.length > 0);
}

/**
 * `[relative path, offsets]` for every file under `root` that carries a control
 * byte, and nothing for the ones that do not.
 *
 * Parameterised on the directory so the sensitivity test below can drive the
 * same function the property test uses, rather than a parallel copy of it that
 * proves something weaker.
 */
function offendersIn(root: string, files: readonly string[]): Array<[string, number[]]> {
  return files
    .map((rel): [string, number[]] => [rel, controlByteOffsets(readFileSync(join(root, rel)))])
    .filter((pair): pair is [string, number[]] => pair[1].length > 0);
}

/**
 * Binary files under the guarded roots, each named. A font program is binary by nature, and search tools are right to
 * call it binary: it holds no source line to find. The screenplay PDF's CJK fallback font is 16 MB, so carrying it as
 * base64 text, as Courier Prime is, would put 22 MB of text into the browser bundle. Each entry is pinned below to the
 * whole file it names, by its size and SHA-256 (as packages/screenplay/src/fonts/README.md states them), so the exemption
 * cannot quietly cover anything else: an edited, appended-to or substituted file fails, not only one with another header.
 */
const BINARY_ASSETS: Readonly<Record<string, { readonly magic: string; readonly size: number; readonly sha256: string }>> = {
  // An OpenType font with CFF outlines starts with the tag 'OTTO'.
  'packages/screenplay/src/fonts/NotoSansMonoCJKsc-Regular.otf': {
    magic: 'OTTO',
    size: 16393784,
    sha256: 'ec04cc376b34887cedbdf84074e2e226ed2761eeabdcb9173fc1dd7bfd153ef7',
  },
  // A TrueType font starts with the version 1.0 tag, 00 01 00 00. Noto Emoji is 0.9 MB.
  'packages/screenplay/src/fonts/NotoEmoji-Regular.ttf': {
    magic: '\u0000\u0001\u0000\u0000',
    size: 886628,
    sha256: 'c170291ac225588dc58595df2ad1e3a91b4fddab78f3f5fcdbe0da0feb1f14d6',
  },
};

/** The same scan over the real tree, the named binary assets left out. */
function offenders(): Array<[string, number[]]> {
  return offendersIn(
    repoRoot,
    guardedFiles().filter((rel) => BINARY_ASSETS[rel] === undefined),
  );
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'caotang-control-byte-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('no source file is invisible to search', () => {
  it('refuses exactly the thirty enumerated control bytes and nothing else', () => {
    expect(FORBIDDEN_BYTES).toHaveLength(30);
    const refused = new Set(FORBIDDEN_BYTES);
    // Every enumerated value is refused, and no other value in the byte range is.
    const misclassified: number[] = [];
    for (let byte = 0; byte <= 0xff; byte += 1) {
      if (isLiteralControlByte(byte) !== refused.has(byte)) misclassified.push(byte);
    }
    expect(misclassified).toEqual([]);
    // The permitted samples are named so a widened class fails here even if the
    // table above were edited to match it.
    for (const byte of PERMITTED_SAMPLES) {
      expect(isLiteralControlByte(byte)).toBe(false);
    }
  });

  it('the scan reports a file that does carry control bytes, so the check fires', () => {
    const dir = tempDir();
    // `const x = ` + NUL + `;` + US + ESC + DEL + LF — the three bytes the real
    // defect carried, at known offsets, written as real bytes and read back.
    writeFileSync(
      join(dir, 'fixture.ts'),
      Buffer.concat([
        Buffer.from('const x = ', 'utf8'), // 10 bytes, offsets 0..9
        Buffer.from([0x00]), // offset 10
        Buffer.from(';', 'utf8'), // offset 11
        Buffer.from([0x1f, 0x7f]), // offsets 12, 13
        Buffer.from([0x0a]), // LF, permitted
      ]),
    );
    // A sibling that differs only in having no control bytes, so the three
    // offsets above are the bytes' doing and not the reader's.
    writeFileSync(join(dir, 'clean.ts'), Buffer.from('const x = 1;\n', 'utf8'));

    expect(offendersIn(dir, ['fixture.ts', 'clean.ts'])).toEqual([['fixture.ts', [10, 12, 13]]]);
    // And the offsets are the predicate's, read from disk rather than from the
    // buffer that was written.
    expect(controlByteOffsets(readFileSync(join(dir, 'fixture.ts')))).toEqual([10, 12, 13]);
  });

  it('the guarded set is non-empty and contains the files this slice is about', () => {
    // The vacuity guard: if the pathspec ever stops matching, the property below
    // passes because it read nothing. Assert members, not just a count.
    const files = guardedFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('packages/store/src/zip.ts');
    expect(files).toContain('packages/store/test/zip.test.ts');
    expect(files).toContain('test/searchable-sources.test.ts');
    // No entry may contain a path separator other than `/`: a Windows-quoted or
    // newline-joined listing would pass a count and fail every read.
    for (const rel of files) {
      expect(rel.includes('\n')).toBe(false);
      expect(rel.includes('\\')).toBe(false);
    }
  });

  it('exempts only the named binary assets, each of which is the whole file it is named as', () => {
    const files = guardedFiles();
    const readme = readFileSync(join(repoRoot, 'packages/screenplay/src/fonts/README.md'), 'utf8');
    for (const [rel, pin] of Object.entries(BINARY_ASSETS)) {
      expect(files).toContain(rel);
      const bytes = readFileSync(join(repoRoot, rel));
      expect(bytes.subarray(0, pin.magic.length).toString('latin1'), rel).toBe(pin.magic);
      expect(bytes.length, rel).toBe(pin.size);
      expect(createHash('sha256').update(bytes).digest('hex'), rel).toBe(pin.sha256);
      // The pins are the ones the fonts' README publishes, so the two cannot drift apart.
      expect(readme, rel).toContain(`\`${pin.sha256}\``);
      expect(readme, rel).toContain(`${pin.size} bytes`);
    }
  });

  // It reads every guarded file in the repository, so it gets a budget for a full suite on a loaded machine (it timed out at the
  // 5 s default once the tree passed 250 test files).
  it('no guarded file carries a literal control byte', () => {
    expect(offenders()).toEqual([]);
  }, 30_000);

  it('the file this slice fixed is searchable again: no control byte in zip.ts', () => {
    // Named separately from the property above so a regression points at the
    // known subject rather than at whichever file happens to fail first.
    expect(controlByteOffsets(readFileSync(join(repoRoot, 'packages/store/src/zip.ts')))).toEqual([]);
  });
});
