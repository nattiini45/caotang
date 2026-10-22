import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as bare from 'fflate';
import * as browser from 'fflate/browser';
import { unzipSync } from 'fflate/browser';

import {
  BUNDLE_EXTENSION,
  MissingManifestError,
  NestedManifestError,
  SESSIONS_FILE,
  SessionsShrinkError,
  UnsafeZipEntryError,
  ZIP_ENGINE,
  addDocument,
  addFolder,
  buildToc,
  bundleFilename,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
  getBody,
  importProjectZip,
  MemoryArtifactFs,
  isRecoverySnapshot,
  moveNode,
  nodeById,
  readProject,
  removeNode,
  writeProject,
  writeSessionsFile,
  type ProjectState,
  type SessionRecord,
} from '../src/index.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');

/**
 * An archive built the way a test needs one: with the module's own ZIP engine, loaded the way the
 * module loads it. The engine is loaded lazily now, so building one is an `await`.
 */
async function zipOf(files: Record<string, Uint8Array>, options: { mtime: Date }): Promise<Uint8Array> {
  const { zipSync } = await ZIP_ENGINE.load();
  return zipSync(files, options);
}

/** A small project: a root folder, a nested folder, and two documents. */
function sample(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
  const folder = addFolder(state, { parentId: 'manuscript', title: 'Part One', now: NOW });
  addDocument(state, { parentId: 'manuscript', title: 'Overture', body: 'Cold open.', now: NOW });
  addDocument(state, { parentId: folder.id, title: 'Arrival', body: 'It was a dark and stormy night.', now: NOW });
  return state;
}

/** The A5 record shape: `{startedAt, endedAt, wordsWritten, docIds[]}` — no project id. */
function session(index: number): SessionRecord {
  const at = new Date(NOW.getTime() + index * 1000).toISOString();
  return { startedAt: at, endedAt: at, wordsWritten: index * 10, docIds: [] };
}

describe('§7 zip bundle', () => {
  it('exports a bundle whose filename is <name>.caotang', async () => {
    const result = await exportProjectZip(sample(), { now: NOW });
    expect(result.filename).toBe(`The Lighthouse Keeper${BUNDLE_EXTENSION}`);
    expect(BUNDLE_EXTENSION).toBe('.caotang');
    // The whole point of .caotang: it must NOT end in .zip, or the OS launches it.
    expect(result.filename.endsWith('.zip')).toBe(false);
  });

  it('sanitizes a project name that is not a legal filename', async () => {
    const state = createProjectState(createEmptyManifest('a/b:c*d?', NOW));
    const result = await exportProjectZip(state, { now: NOW });
    expect(result.filename).toBe(`a-b-c-d-${BUNDLE_EXTENSION}`);
  });

  it('falls back to the project id when the name sanitizes to nothing', () => {
    // `'///'` sanitizes to `'---'`, which IS a legal name — the fallback is for
    // a name with nothing filename-safe left, e.g. control characters or spaces.
    expect(bundleFilename('///', 'n_abc12345')).toBe(`---${BUNDLE_EXTENSION}`);
    expect(bundleFilename(' ', 'n_abc12345')).toBe(`n_abc12345${BUNDLE_EXTENSION}`);
    expect(bundleFilename('   ', 'n_abc12345')).toBe(`n_abc12345${BUNDLE_EXTENSION}`);
  });

  it('trims leading and trailing dots and whitespace from a project name, and only there', () => {
    const f = (n: string): string => bundleFilename(n, 'n_abc12345');
    expect(f('  ..The Lighthouse.. ')).toBe(`The Lighthouse${BUNDLE_EXTENSION}`);
    expect(f('. . .')).toBe(`n_abc12345${BUNDLE_EXTENSION}`);
    expect(f('...')).toBe(`n_abc12345${BUNDLE_EXTENSION}`);
    expect(f('')).toBe(`n_abc12345${BUNDLE_EXTENSION}`);
    expect(f('\t\r\n')).toBe(`n_abc12345${BUNDLE_EXTENSION}`);
    expect(f('.\r\n.a.b.\r\n.')).toBe(`a.b${BUNDLE_EXTENSION}`);
    expect(f('\u00a0\u2003.Café Ünï.\ufeff')).toBe(`Café Ünï${BUNDLE_EXTENSION}`);
    // The 80-character cap re-trims whitespace (not dots), as before.
    expect(f(`${'a'.repeat(79)} b`)).toBe(`${'a'.repeat(79)}${BUNDLE_EXTENSION}`);
  });

  it('sanitizes a long run of dots and spaces in linear time', () => {
    // `/^[.\s]+|[.\s]+$/g` took seconds on this input at 30k.
    const hostile = `a${'. '.repeat(50_000)}b`;
    const start = performance.now();
    const out = bundleFilename(hostile, 'n_abc12345');
    expect(performance.now() - start).toBeLessThan(500);
    expect(out.endsWith(BUNDLE_EXTENSION)).toBe(true);
    const edge = bundleFilename(`${'. '.repeat(50_000)}x${'. '.repeat(50_000)}`, 'n_abc12345');
    expect(edge).toBe(`x${BUNDLE_EXTENSION}`);
  });

  it('strips every control character from a project name, the class the searchable-sources guard refuses', () => {
    // §7 puts `<project-name>` in a filename, so the strip has to cover the
    // whole C0 range and DEL. The class is written as escapes because the
    // literal-byte form made `zip.ts` unsearchable, and a rewrite of a
    // character class with no assertion on it is a change nobody can tell from
    // no change — so the assertion is over **the whole class**, written out.
    //
    // Pinning only a few characters is not enough: narrowing the source class to
    // `[\u0000-\u0001\u001f\u007f]` — 4 of its 33 members — would leave a
    // spot-check green. Written out, that same narrowing drops 29 members and
    // this test fails, which is the whole point of writing it out.
    //
    // Escapes, not literal bytes — writing the bytes here would reproduce in a
    // test file the defect this slice fixed in a source file.
    const control =
      '\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f' +
      '\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f\u007f';
    expect(bundleFilename(`The${control}Lighthouse`, 'n_abc12345')).toBe(
      `TheLighthouse${BUNDLE_EXTENSION}`,
    );
    // A name that is *only* control characters has nothing legal left, which is
    // the case the fallback above names in its own comment.
    expect(bundleFilename(control, 'n_abc12345')).toBe(`n_abc12345${BUNDLE_EXTENSION}`);
  });

  it('puts caotang.json at the zip root, never under a directory', async () => {
    const result = await exportProjectZip(sample(), { now: NOW });
    expect(result.entries).toContain('caotang.json');
    expect(result.entries.filter((e) => e.endsWith('/caotang.json'))).toEqual([]);
  });

  it('carries docs, codex and the gitignore the write path produced', async () => {
    const result = await exportProjectZip(sample(), { now: NOW });
    expect(result.entries).toContain('.gitignore');
    expect(result.entries.filter((e) => e.startsWith('docs/') && e.endsWith('.md')).length).toBe(2);
  });

  it('generates §7 ToC.md into exports/, not the tree', async () => {
    const state = sample();
    const result = await exportProjectZip(state, { now: NOW });
    expect(result.entries).toContain('exports/ToC.md');
    expect(result.entries.filter((e) => e.startsWith('docs/ToC.md'))).toEqual([]);

    const toc = buildToc(state, 'The Lighthouse Keeper');
    expect(toc).toContain('# The Lighthouse Keeper');
    // order — title — status — filename
    expect(toc).toMatch(/^\s*\d+ — Overture — \S+ — docs\/n_[A-Z0-9]+\.md$/m);
    // a folder line ends in the em-dash, not a filename
    expect(toc).toMatch(/^\s*\d+ — Part One — \S+ — —$/m);
    // depth indentation, so the shape is legible without Caotang:
    // root > manuscript > Part One > Arrival, so Arrival is one level deeper
    // than Part One, and both are deeper than the Overture beside Part One.
    const arrival = toc.split('\n').find((l) => l.includes('Arrival'))!;
    const partOne = toc.split('\n').find((l) => l.includes('Part One'))!;
    const overture = toc.split('\n').find((l) => l.includes('Overture'))!;
    const indent = (line: string) => line.length - line.trimStart().length;
    expect(indent(arrival)).toBe(indent(partOne) + 2);
    expect(indent(overture)).toBe(indent(partOne));
  });

  it('is byte-stable for an unchanged project', async () => {
    const state = sample();
    const a = await exportProjectZip(state, { now: NOW });
    const b = await exportProjectZip(state, { now: NOW });
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
  });

  it('never ships §5 recovery snapshots in a bundle', async () => {
    const result = await exportProjectZip(sample(), { now: NOW, snapshotCount: 2 });
    // The assembled folder is fresh, so writeProject had no previous manifest
    // to rotate — the filter is what guarantees this, not the absence.
    expect(result.entries.filter((e) => e.startsWith('caotang.json.bak'))).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.entries).toContain('caotang.json');

    // and the filter itself is the guarantee, proven against a real snapshot
    expect(isRecoverySnapshot('caotang.json.bak.1')).toBe(true);
    expect(isRecoverySnapshot('caotang.json.bak.4')).toBe(true);
    expect(isRecoverySnapshot('caotang.json')).toBe(false);
    expect(isRecoverySnapshot('docs/caotang.json.bak.1')).toBe(false);

    // a folder that DOES have snapshots drops them: simulate by re-running the
    // export over a resumed write, which is the shape the filter defends.
    const resumed = await exportProjectZip(sample(), { now: NOW });
    expect(resumed.entries.some(isRecoverySnapshot)).toBe(false);
  });
});

describe('§7 round-trip (export is lossless both ways)', () => {
  it('reloads an exported bundle to an equal project', async () => {
    const state = sample();
    const zip = await exportProjectZip(state, { now: NOW });
    const imported = await importProjectZip(zip.bytes);

    const loaded = await readProject(imported.fs, { now: NOW });
    expect(loaded.state.manifest).toEqual(state.manifest);
    const docId = state.manifest.tree.find((n) => n.type === 'document')!.id;
    expect(getBody(loaded.state, docId)).toBe(getBody(state, docId));
  });

  // The loader declines a codex or document file it cannot import and keeps it
  // on disk, but the export is built from state, and the text of a declined file was
  // not in state: the bundle silently lost it. A declined file's text now travels with
  // the state, and the export carries it.
  it('keeps a codex file the loader declined, so the export is lossless', async () => {
    const source = new MemoryArtifactFs();
    await writeProject(source, sample(), { now: NOW });
    source.putFile('codex/c_5H8QK2M9RT.md', 'not a codex file at all\n');
    const loaded = await readProject(source, { now: NOW });
    expect([...loaded.state.declinedCodexFiles]).toEqual(['c_5H8QK2M9RT.md']);

    const zip = await exportProjectZip(loaded.state, { now: NOW });
    const imported = await importProjectZip(zip.bytes);

    expect(await imported.fs.read('codex/c_5H8QK2M9RT.md')).toBe('not a codex file at all\n');
  });

  it('keeps a document file the loader declined, so the export is lossless', async () => {
    const state = sample();
    const folder = state.manifest.tree.find((n) => n.type === 'folder' && n.id.startsWith('n_'))!;
    const source = new MemoryArtifactFs();
    await writeProject(source, state, { now: NOW });
    source.putFile(`docs/${folder.id}.md`, 'a file named for a folder\n');
    const loaded = await readProject(source, { now: NOW });

    const zip = await exportProjectZip(loaded.state, { now: NOW });
    const imported = await importProjectZip(zip.bytes);

    expect(await imported.fs.read(`docs/${folder.id}.md`)).toBe('a file named for a folder\n');
  });

  // The mirror of the document refusal, and the hole it leaves: a file whose bytes
  // are not UTF-8 has no text to carry, so the bundle would simply not carry it —
  // silently, with no error, and no trace of it in the bundle.
  it('refuses an export of a codex file that is not UTF-8 text, rather than leaving it out of the bundle', async () => {
    const source = new MemoryArtifactFs();
    await writeProject(source, sample(), { now: NOW });
    // An orphan codex file whose bytes are not UTF-8: the loader declines it, and
    // there is no text to travel with the state.
    await source.writeBytesAtomic('codex/c_VANSHED002.md', new Uint8Array([0xff, 0xfe, 0x41, 0x00]));
    const loaded = await readProject(source, { now: NOW });
    expect([...loaded.state.declinedCodexFiles]).toEqual(['c_VANSHED002.md']);

    await expect(exportProjectZip(loaded.state, { now: NOW })).rejects.toThrow(/not UTF-8/);
  });

  it('leaves that same file alone when the save is in place — only the copy that would lose it refuses', async () => {
    const source = new MemoryArtifactFs();
    await writeProject(source, sample(), { now: NOW });
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
    await source.writeBytesAtomic('codex/c_VANSHED002.md', bytes);
    const loaded = await readProject(source, { now: NOW });

    const report = await writeProject(source, loaded.state, { now: NOW });

    expect(report.pruned).toEqual([]);
    expect(await source.readBytes('codex/c_VANSHED002.md')).toEqual(bytes);
  });

  it('carries no file for a document the project deleted', async () => {
    // The mirror of the `docs/` prune, and the one that is **inert** rather than
    // load-bearing: the bundle is assembled into a fresh `MemoryArtifactFs`, so a
    // deleted document's file is absent because it was never written. Asserted
    // because the lesson is that a guarantee held in one path reads as a
    // guarantee, and here the two paths get there for opposite reasons.
    const state = sample();
    const arrival = state.manifest.tree.find((n) => n.title === 'Arrival')!;
    removeNode(state, arrival.id);

    const result = await exportProjectZip(state, { now: NOW });

    expect(result.entries.filter((e) => e.startsWith('docs/') && e.endsWith('.md'))).toHaveLength(1);
    expect(result.entries).not.toContain(`docs/${arrival.id}.md`);
    // And the bundle reloads to a project without it, rather than one that adopts
    // the missing file as Recovered.
    const loaded = await readProject((await importProjectZip(result.bytes)).fs, { now: NOW });
    expect(loaded.orphans).toEqual([]);
    expect(loaded.state.manifest.tree.some((n) => n.id === arrival.id)).toBe(false);
  });

  it('survives a reorg in between (§8: round-trip twice with a reorg = identical docs)', async () => {
    const original = sample();
    const first = await exportProjectZip(original, { now: NOW });
    const back = await readProject((await importProjectZip(first.bytes)).fs, { now: NOW });

    // reorganize: move the nested document up out of "Part One"
    const arrival = back.state.manifest.tree.find((n) => n.title === 'Arrival')!;
    moveNode(back.state, arrival.id, { parentId: 'manuscript' });

    const second = await exportProjectZip(back.state, { now: NOW });
    const reloaded = await readProject((await importProjectZip(second.bytes)).fs, { now: NOW });

    // the move survived the second round-trip
    expect(nodeById(reloaded.state, arrival.id)!.parentId).toBe('manuscript');
    // and the doc CONTENT is identical, which is what §8 asks for
    expect(getBody(reloaded.state, arrival.id)).toBe(getBody(back.state, arrival.id));
    expect(getBody(reloaded.state, arrival.id)).toBe('It was a dark and stormy night.');
  });

  it('imports into a fresh working copy (§8) without sharing the exporter fs', async () => {
    const zip = await exportProjectZip(sample(), { now: NOW });
    const a = await importProjectZip(zip.bytes);
    const b = await importProjectZip(zip.bytes);
    await a.fs.writeAtomic('docs/extra.md', 'only in a');
    // each import is its own working copy, and neither is the exporter's folder
    expect(await b.fs.exists('docs/extra.md')).toBe(false);
    expect(await zip.fs.exists('docs/extra.md')).toBe(false);
    expect(await a.fs.exists('docs/extra.md')).toBe(true);
  });
});

describe('§7 import guardrails', () => {
  it('refuses an unsafe entry name (zip slip) rather than sanitising it', async () => {
    for (const entry of [
      '../evil.md',
      'docs/../../evil.md',
      '/etc/passwd',
      'C:/Windows/system.ini',
    ]) {
      const evil: Record<string, Uint8Array> = {
        'caotang.json': new TextEncoder().encode('{"formatVersion":1}'),
        [entry]: new TextEncoder().encode('x'),
      };
      const bytes = await zipOf(evil, { mtime: NOW });
      await expect(importProjectZip(bytes)).rejects.toThrow(UnsafeZipEntryError);
    }
  });

  it('refuses a nested manifest with the fix in the message', async () => {
    const bytes = await zipOf(
      {
        'MyProject/caotang.json': new TextEncoder().encode('{"formatVersion":1}'),
        'MyProject/docs/n_abc.md': new TextEncoder().encode('x'),
      },
      { mtime: NOW },
    );
    await expect(importProjectZip(bytes)).rejects.toThrow(NestedManifestError);
    await expect(importProjectZip(bytes)).rejects.toThrow(/zip its contents, not the folder itself/);
  });

  it('rejects an archive that is not a Caotang bundle at all', async () => {
    const bytes = await zipOf({ 'readme.txt': new TextEncoder().encode('hi') }, { mtime: NOW });
    await expect(importProjectZip(bytes)).rejects.toThrow(MissingManifestError);
  });

  it('rejects bytes that are not a zip, in the writer’s words, with the engine’s reason kept on the cause', async () => {
    const refusal = await importProjectZip(new Uint8Array([1, 2, 3, 4])).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe('This file is not a Caotang bundle.');
    expect((refusal as Error).cause).toBeDefined();
  });

  it('ignores unknown files, and carries a forward-compatible one', async () => {
    const state = sample();
    const zip = await exportProjectZip(state, { now: NOW });
    const entries = unzipSync(zip.bytes);
    entries['some/future/file.md'] = new TextEncoder().encode('from a newer Caotang');
    const merged = await zipOf(entries, { mtime: NOW });

    const imported = await importProjectZip(merged);
    // §1: loaders ignore unknown files, never error
    const loaded = await readProject(imported.fs, { now: NOW });
    expect(loaded.state.manifest).toEqual(state.manifest);
    // and the bytes are still there — ignored by the loader, not discarded
    expect(await imported.fs.read('some/future/file.md')).toBe('from a newer Caotang');
  });

  /**
   * The boundary of that forward compatibility, measured rather than assumed.
   *
   * **The bundle is a text bundle.** `importProjectZip` decodes every entry with a
   * non-fatal UTF-8 decoder and `ArtifactFs` stores strings, so an entry that is
   * not valid UTF-8 does not survive the trip: invalid bytes become U+FFFD and the
   * file silently changes. This test pins that as a *measured* fact with the
   * honest reason attached, because the alternative — leaving the previous
   * `.bin`-named test in place — is a guard whose name claims binary support while
   * its payload is ASCII, which is the exact species of claim this repo's reviews
   * keep finding: the assertion cannot fail for the reason its name states.
   *
   * **It is a documented limitation, not a defect against v0.1.** Nothing in the
   * project format writes binary (§1–§9 are JSON, Markdown and `.jsonl`), so no
   * bundle Caotang produces today contains a byte this would damage. It becomes a
   * defect the moment a binary file is admitted to the tree — the media track's
   * `assets/` store is the first candidate, and it is post-v0.1. The fix when that
   * happens is to carry bytes end to end (`Uint8Array` in `ArtifactFs`), not to
   * make this decoder fatal, because a fatal decode would *refuse* a bundle rather
   * than carry it.
   */
  it('carries text entries and binary entries byte-exactly', async () => {
    const state = sample();
    const zip = await exportProjectZip(state, { now: NOW });
    const entries = unzipSync(zip.bytes);

    const enc = new TextEncoder();
    // Valid UTF-8 — the shape every file in the format actually has, including
    // multi-byte and astral characters, which is where a naive byte-per-char
    // implementation would break first.
    const text: Record<string, Uint8Array> = {
      'future/ascii.md': enc.encode('plain ascii'),
      'future/multibyte.md': enc.encode('café — 你好 — 🎭'),
    };
    // Not valid UTF-8: a PNG header plus a latin-1 'café' and a NUL/0xFF pair.
    const binary: Record<string, Uint8Array> = {
      'future/image.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x80]),
    };
    Object.assign(entries, text, binary);

    const imported = await importProjectZip(await zipOf(entries, { mtime: NOW }));
    // Both views together: the text contract reads strings, the binary one reads bytes.
    const snap: Record<string, string | Uint8Array> = { ...imported.fs.snapshot(), ...imported.fs.snapshotBytes() };

    // The text contract, which is the one §7 states and the one v0.1 depends on.
    for (const [path, bytes] of Object.entries(text)) {
      const got = snap[path]!;
      expect(Buffer.compare(Buffer.from(typeof got === 'string' ? enc.encode(got) : got), Buffer.from(bytes)), path).toBe(0);
    }

    // The binary limit, inverted. This test used to assert that a non-UTF-8 entry
    // came back damaged, and said that when it stopped being damaged the test should
    // be inverted. `ArtifactFs` now carries bytes, so the entry is
    // kept as it was written, and the boundary it used to record is gone.
    const gotBinary = snap['future/image.png']!;
    expect(gotBinary).toBeInstanceOf(Uint8Array);
    expect(
      Buffer.compare(Buffer.from(gotBinary as Uint8Array), Buffer.from(binary['future/image.png']!)),
      'a non-UTF-8 entry must come back byte-for-byte now that ArtifactFs carries bytes',
    ).toBe(0);
  });
});

describe('§4 the session log rides in the bundle', () => {
  it('carries the full log and hands it back for seeding', async () => {
    const records = [session(1), session(2), session(3)];
    const zip = await exportProjectZip(sample(), { now: NOW, sessions: records });
    expect(zip.entries).toContain(SESSIONS_FILE);

    const imported = await importProjectZip(zip.bytes);
    expect(imported.sessions).toHaveLength(3);
    expect(imported.sessionsSkipped).toBe(0);
  });

  it('refuses to shrink a log rather than truncating it', async () => {
    const three = [session(1), session(2), session(3)];
    const zip = await exportProjectZip(sample(), { now: NOW, sessions: three });

    // the imported folder's log holds 3 lines; writing 1 over it must refuse
    const imported = await importProjectZip(zip.bytes);
    await expect(writeSessionsFile(imported.fs, [session(1)], {})).rejects.toThrow(SessionsShrinkError);

    // and the file is untouched — a refused write is not a partial write
    expect((await imported.fs.read(SESSIONS_FILE))!.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('carries a damaged line and a hand-written key order through an import byte-for-byte', async () => {
    // An import is a copy. The log used to come in by parsing it and projecting the
    // lines it could read into an empty folder, so a damaged line was dropped on the
    // way in — counted as skipped, and gone from the artifact — and a hand-written
    // key order was normalised. The bytes are now kept, and the projection finds
    // them already holding these records and appends nothing.
    const handWritten = `{"wordsWritten":7,"startedAt":"${session(2).startedAt}","endedAt":"${session(2).endedAt}","docIds":[]}`;
    const original = `${JSON.stringify(session(1))}\nnot json\n${handWritten}\n`;
    const zip = await exportProjectZip(sample(), { now: NOW });
    const entries = unzipSync(zip.bytes);
    entries[SESSIONS_FILE] = new TextEncoder().encode(original);
    const imported = await importProjectZip(await zipOf(entries, { mtime: NOW }));

    expect(await imported.fs.read(SESSIONS_FILE)).toBe(original);
    expect(imported.sessions).toHaveLength(2);
    expect(imported.sessionsSkipped).toBe(1);
  });

  it('counts a malformed log line instead of dropping it silently', async () => {
    const good = `${JSON.stringify(session(1))}\nnot json\n${JSON.stringify(session(2))}\n`;
    const zip = await exportProjectZip(sample(), { now: NOW });
    const entries = unzipSync(zip.bytes);
    entries[SESSIONS_FILE] = new TextEncoder().encode(good);
    const imported = await importProjectZip(await zipOf(entries, { mtime: NOW }));
    expect(imported.sessions).toHaveLength(2);
    expect(imported.sessionsSkipped).toBe(1);
  });
});

describe('the fflate resolution hazard (§3a)', () => {
  it('binds the browser build, not the Node build', async () => {
    expect(ZIP_ENGINE.subpath).toBe('fflate/browser');
    const engine = await ZIP_ENGINE.load();
    // If the import ever drifts back to bare `fflate`, these four fail — the
    // module vitest loads (Node build) stops being the module the app bundles.
    expect(engine.zipSync).toBe(browser.zipSync);
    expect(engine.zipSync).not.toBe(bare.zipSync);
    expect(engine.unzipSync).toBe(browser.unzipSync);
    expect(engine.unzipSync).not.toBe(bare.unzipSync);
  });

  it('loads fflate lazily: the module has no static import of it, so the main bundle does not carry it', () => {
    // The import is the thing being guarded, so the test reads the source. A type-only
    // import is erased and does not count; a value import of fflate at the top of the
    // file is the regression, and this fails on it. The dynamic import is the proof the
    // loader is still there to split into its own chunk.
    const source = readFileSync(fileURLToPath(new URL('../src/zip.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^import\s+(?!type\s)[^;]*\bfrom\s+['"]fflate/m);
    expect(source).toMatch(/await import\('fflate\/browser'\)/);
  });

  it('proves the two builds are genuinely different objects, so the assertion above can fail', () => {
    // A guard against a vacuous test: if these were ever the same function,
    // `toBe`/`not.toBe` above would be meaningless.
    expect(bare.zipSync).not.toBe(browser.zipSync);
    expect(bare.unzipSync).not.toBe(browser.unzipSync);
  });
});
