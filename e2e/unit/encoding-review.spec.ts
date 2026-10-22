import { expect, test } from '@playwright/test';

import {
  MANIFEST_FILE,
  MemoryArtifactFs,
  MemoryIndexedDb,
  addDocument,
  createEmptyManifest,
  createProjectState,
  listProjectIds,
  openRuntimeStore,
  writeProject,
  writeProjectState,
  type EncodingIssue,
  type ProjectState,
  ZIP_ENGINE,
} from '../../packages/store/src/index.js';

import {
  applyEncodingDecisions,
  ASK_EXCERPT_CHARS,
  encodingAskerFor,
  encodingBackupPath,
  encodingFromReply,
} from '../../apps/desktop/src/app/encoding-review.js';
import { folderArtifactFs, type DirectoryHandleLike } from '../../apps/desktop/src/app/fs-access.js';
import {
  completeEncodingReview,
  completeRecovery,
  importBundle,
  openFolder,
  type OpenOutcome,
  type PendingEncoding,
} from '../../apps/desktop/src/app/lifecycle.js';
import { ProviderService } from '../../apps/desktop/src/app/providers.js';
import type { AppDb } from '../../apps/desktop/src/app/app-db.js';

import { filesIn, memoryFolder, textOf, type Directory } from './memory-folder.js';

/**
 * The non-UTF-8 review an open pauses on, run without a browser: a folder or bundle whose load
 * reported `encodingIssues` is handed to the writer as a `PendingEncoding`, and the answers land
 * through `completeEncodingReview` — a converted file's original bytes are kept under
 * `.caotang-backup/`, a left file is byte-identical afterwards, and the re-read then opens the
 * converted text as an ordinary document. The provider half is checked against the real
 * `ProviderService` over a scripted fetch.
 */

const NOW = new Date('2026-10-02T15:00:00.000Z');
const ENC = new TextEncoder();
const BODY = 'The ferry was late.';

// An opened session listens for the DOM's flush signals; the unit run has none, so
// `document` and `window` stand in as plain event targets for the duration of the file.
const globals = globalThis as unknown as Record<string, unknown>;
let previousGlobals: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previousGlobals = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previousGlobals === null) return;
  globals['document'] = previousGlobals.document;
  globals['window'] = previousGlobals.window;
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A Windows-1252 file: ASCII with smart quotes 0x93/0x94 and an 0xE9 `é`, none of which are UTF-8. */
const CP1252 = Uint8Array.from([
  ...ENC.encode('He said '),
  0x93, 0x48, 0x69, 0x94, // “Hi”
  ...ENC.encode(' over caf'),
  0xe9, // é
  0x0a,
]);

/** UTF-16LE with a byte-order mark. */
function utf16le(text: string): Uint8Array {
  const bytes: number[] = [0xff, 0xfe];
  for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i) & 0xff, text.charCodeAt(i) >> 8);
  return Uint8Array.from(bytes);
}

/** The file's text with {@link body} re-encoded as Windows-1252, as a letter a Windows tool saved. */
function withWindows1252Body(text: string, body = BODY): Uint8Array {
  const at = text.indexOf(body);
  if (at < 0) throw new Error('the fixture body is not in the file');
  const head = ENC.encode(text.slice(0, at));
  const tail = ENC.encode(text.slice(at + body.length));
  const bytes = Uint8Array.from([...ENC.encode('Caf'), 0xe9, ...ENC.encode(' au lait.')]);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

/**
 * The in-memory folder, with `isSameEntry` added: the open's baseline checks compare folder handles
 * the way the File System Access API does, which the bare helper does not offer. A handle compares
 * equal to another built over the same tree, as a second pick of one folder does.
 */
const folderTrees = new WeakMap<DirectoryHandleLike, Directory>();

function trackedFolder(name: string): { handle: DirectoryHandleLike; tree: Directory } {
  const { handle, tree } = memoryFolder();
  const tracked: DirectoryHandleLike = {
    ...handle,
    name,
    isSameEntry: (other: DirectoryHandleLike) => Promise.resolve(folderTrees.get(other) === tree),
  } as DirectoryHandleLike;
  folderTrees.set(tracked, tree);
  return { handle: tracked, tree };
}

/** A project state with one document, and the id of it. */
function bookState(title = 'The Lighthouse Keeper', body = BODY): { state: ProjectState; docId: string } {
  const state = createProjectState(createEmptyManifest(title, NOW), { now: NOW });
  const node = addDocument(state, { parentId: 'manuscript', title: 'The Landing', body, now: NOW });
  return { state, docId: node.id };
}

/** A project folder on a memory disk, written by the real writer. */
async function writtenFolder(
  body = BODY,
): Promise<{ root: DirectoryHandleLike; tree: Directory; state: ProjectState; docId: string }> {
  const { handle, tree } = trackedFolder('Fixture Book');
  const { state, docId } = bookState('The Lighthouse Keeper', body);
  await writeProject(folderArtifactFs(handle), state, { now: NOW });
  return { root: handle, tree, state, docId };
}

/** The bytes a folder file now holds. */
function folderBytes(tree: Directory, path: string): Uint8Array {
  const bytes = filesIn(tree).get(path);
  if (bytes === undefined) throw new Error(`no file ${path}`);
  return bytes;
}

/** Rewrites a folder file with the given raw bytes. */
async function plantBytes(root: DirectoryHandleLike, path: string, bytes: Uint8Array): Promise<void> {
  await folderArtifactFs(root).writeBytesAtomic(path, bytes);
}

/** A file's bytes inside a zip fixture. */
async function zipBytesOf(zip: Uint8Array, path: string): Promise<Uint8Array> {
  const { unzipSync } = await ZIP_ENGINE.load();
  const files = unzipSync(zip);
  const bytes = files[path];
  if (bytes === undefined) throw new Error(`no ${path} in the zip`);
  return bytes;
}

/** The pending an open pauses on, failing the test when it did not pause. */
function expectEncoding(outcome: OpenOutcome): PendingEncoding {
  expect(outcome.kind).toBe('encoding');
  if (outcome.kind !== 'encoding') throw new Error('expected an encoding pause');
  return outcome.encoding;
}

/** The backup files a folder now holds, as its paths. */
function backupsIn(tree: Directory): string[] {
  return [...filesIn(tree).keys()].filter((path) => path.startsWith('.caotang-backup/'));
}

/* ------------------------------------------------------------------ *
 * applyEncodingDecisions on its own: backup-first, decline-safe
 * ------------------------------------------------------------------ */

test.describe('applyEncodingDecisions', () => {
  test('a convert backs up the original bytes, then rewrites the file as decodable text', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, original);
    const issue: EncodingIssue = { path, kind: 'document', size: original.length, encoding: 'windows-1252' };

    const result = await applyEncodingDecisions(folderArtifactFs(root), [issue], [{ path, action: 'convert' }]);

    expect(result.failed).toEqual([]);
    expect(result.converted).toEqual([{ path, encoding: 'windows-1252' }]);
    // The backup is byte-for-byte what the file held before.
    expect(folderBytes(tree, encodingBackupPath(path))).toEqual(original);
    // And the file is UTF-8 text again, with the same words.
    expect(textOf(folderBytes(tree, path))).toContain('Café au lait.');
  });

  test('a backup that cannot be written leaves the file untouched, and no file is made', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, original);
    const issue: EncodingIssue = { path, kind: 'document', size: original.length, encoding: 'windows-1252' };
    const fs = folderArtifactFs(root);
    const refusing = {
      ...fs,
      writeBytesAtomic: (p: string, b: Uint8Array) =>
        p.startsWith(encodingBackupPath('')) ? Promise.reject(new Error('the disk is full')) : fs.writeBytesAtomic(p, b),
    };

    const result = await applyEncodingDecisions(refusing, [issue], [{ path, action: 'convert' }]);

    expect(result.converted).toEqual([]);
    expect(result.failed).toEqual([{ path, reason: 'its backup copy could not be written — the disk is full' }]);
    expect(folderBytes(tree, path)).toEqual(original);
    expect(backupsIn(tree)).toEqual([]);
  });

  test('a decode that fails under the picked encoding leaves the file untouched, and no backup is written', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, original);
    const issue: EncodingIssue = { path, kind: 'document', size: original.length, encoding: 'windows-1252' };

    const result = await applyEncodingDecisions(
      folderArtifactFs(root),
      [issue],
      [{ path, action: 'convert', encoding: 'utf-8' }],
    );

    expect(result.converted).toEqual([]);
    expect(result.failed[0]?.reason).toContain('do not decode as UTF-8');
    expect(folderBytes(tree, path)).toEqual(original);
    expect(backupsIn(tree)).toEqual([]);
  });

  test('a leave is a no-op, an unknown kind converts the same, and a stray decision is ignored', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, original);
    const odd = 'odd/scene.txt';
    await plantBytes(root, odd, CP1252);
    const issues: EncodingIssue[] = [
      { path, kind: 'document', size: original.length, encoding: 'windows-1252' },
      { path: odd, kind: 'unknown', size: CP1252.length, encoding: 'windows-1252' },
    ];

    const result = await applyEncodingDecisions(folderArtifactFs(root), issues, [
      { path, action: 'leave' },
      { path: odd, action: 'convert', encoding: 'windows-1252' },
      { path: 'docs/n_NOPE.md', action: 'convert' },
    ]);

    // The left file is byte-identical; the unknown-kind file converted with its own backup.
    expect(folderBytes(tree, path)).toEqual(original);
    expect(result.converted).toEqual([{ path: odd, encoding: 'windows-1252' }]);
    expect(folderBytes(tree, encodingBackupPath(odd))).toEqual(CP1252);
    expect(result.failed).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Folder opens
 * ------------------------------------------------------------------ */

test.describe('a folder whose files are not UTF-8 pauses the open', () => {
  test('the open reports the files and writes nothing before the writer answers', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, original);
    const store = await openRuntimeStore(new MemoryIndexedDb());

    const outcome = await openFolder(store, root);

    const pending = expectEncoding(outcome);
    expect(pending.name).toBe('Fixture Book');
    expect(pending.issues).toEqual([{ path, kind: 'document', size: original.length, encoding: 'windows-1252' }]);
    expect(pending.cancelNote).toBe('');
    // The open made no decisions: the file is untouched, and nothing was adopted.
    expect(folderBytes(tree, path)).toEqual(original);
    expect(await listProjectIds(store)).toEqual([]);
  });

  test('leaving every file opens the project with the document still held, byte-identical', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, original);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const pending = expectEncoding(await openFolder(store, root));

    const outcome = await completeEncodingReview(store, pending, [{ path, action: 'leave' }]);

    expect(outcome.kind).toBe('opened');
    if (outcome.kind !== 'opened') return;
    expect(folderBytes(tree, path)).toEqual(original);
    expect(outcome.opened.session.state.declinedDocFiles.has(`${docId}.md`)).toBe(true);
    expect(outcome.opened.session.state.documents.has(docId)).toBe(false);
    // The load's own hold notice still says what it said, and nothing claims a conversion.
    expect(outcome.opened.notices.some((line) => line.includes('converted'))).toBe(false);
    await outcome.opened.session.close();
  });

  test('a converted document opens with its text, its original bytes kept, and the notice names it', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, original);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const pending = expectEncoding(await openFolder(store, root));

    const outcome = await completeEncodingReview(store, pending, [{ path, action: 'convert' }]);

    expect(outcome.kind).toBe('opened');
    if (outcome.kind !== 'opened') return;
    // The converted file is the document's body now — the re-read imported it as plain text.
    expect(outcome.opened.session.state.documents.get(docId)?.body).toContain('Café au lait.');
    expect(outcome.opened.session.state.declinedDocFiles.size).toBe(0);
    // The backup is the folder's own file, byte-for-byte, a sibling of docs/ the format does not name.
    expect(folderBytes(tree, encodingBackupPath(path))).toEqual(original);
    // The writer hears it by title, not by path.
    expect(outcome.opened.notices.some((line) => line.includes('“The Landing”') && line.includes('converted'))).toBe(true);
    await outcome.opened.session.close();
  });

  test('a UTF-16 document converts and is read as text', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const bytes = utf16le(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, bytes);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const pending = expectEncoding(await openFolder(store, root));
    expect(pending.issues[0]?.encoding).toBe('utf-16le');

    const outcome = await completeEncodingReview(store, pending, [{ path, action: 'convert' }]);

    expect(outcome.kind).toBe('opened');
    if (outcome.kind !== 'opened') return;
    expect(outcome.opened.session.state.documents.get(docId)?.body).toBe(BODY);
    expect(folderBytes(tree, encodingBackupPath(path))).toEqual(bytes);
    await outcome.opened.session.close();
  });

  test('a codex file converts too, and its entry is read in', async () => {
    const { root, tree } = await writtenFolder();
    // A codex redundancy file the manifest does not name, saved by a Windows tool: `Elena Vossé`
    // with the é as a single Windows-1252 byte.
    const path = 'codex/c_5H8QK2M9RT.md';
    const bytes = Uint8Array.from([...ENC.encode('---\nid: c_5H8QK2M9RT\nname: Elena Voss'), 0xe9, ...ENC.encode('\n---\n')]);
    await plantBytes(root, path, bytes);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const pending = expectEncoding(await openFolder(store, root));
    expect(pending.issues).toEqual([{ path, kind: 'codex', size: bytes.length, encoding: 'windows-1252' }]);

    const outcome = await completeEncodingReview(store, pending, [{ path, action: 'convert' }]);

    expect(outcome.kind).toBe('opened');
    if (outcome.kind !== 'opened') return;
    expect(outcome.opened.session.state.manifest.codex?.map((entry) => entry.name)).toContain('Elena Vossé');
    expect(folderBytes(tree, encodingBackupPath(path))).toEqual(bytes);
    await outcome.opened.session.close();
  });

  test('a backup failure opens the project anyway, the file held, with the failure said plainly', async () => {
    const { root, tree, docId } = await writtenFolder();
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)));
    await plantBytes(root, path, original);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const pending = expectEncoding(await openFolder(store, root));
    const fs = pending.fs;
    const refusing: PendingEncoding = {
      ...pending,
      fs: {
        ...fs,
        writeBytesAtomic: (p: string, b: Uint8Array) =>
          p.startsWith(encodingBackupPath('')) ? Promise.reject(new Error('the disk is full')) : fs.writeBytesAtomic(p, b),
      },
    };

    const outcome = await completeEncodingReview(store, refusing, [{ path, action: 'convert' }]);

    expect(outcome.kind).toBe('opened');
    if (outcome.kind !== 'opened') return;
    expect(folderBytes(tree, path)).toEqual(original);
    expect(outcome.opened.session.state.declinedDocFiles.has(`${docId}.md`)).toBe(true);
    expect(outcome.opened.notices.some((line) => line.includes('could not be converted') && line.includes('backup'))).toBe(
      true,
    );
    await outcome.opened.session.close();
  });

  test('a folder this browser already keeps opens as its own once the file is converted', async () => {
    // The book's document is 'Café au lait.'; on disk the é is a Windows-1252 byte. The stored
    // copy holds the same state the conversion restores, so the open is the folder's own.
    const { root, tree, state, docId } = await writtenFolder('Café au lait.');
    const path = `docs/${docId}.md`;
    const original = withWindows1252Body(textOf(folderBytes(tree, path)), 'Café au lait.');
    await plantBytes(root, path, original);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);

    const pending = expectEncoding(await openFolder(store, root));
    const outcome = await completeEncodingReview(store, pending, [{ path, action: 'convert' }]);

    // The same book opens as the folder's own session — same id, no differs question — because the conversion is measured first.
    expect(outcome.kind).toBe('opened');
    if (outcome.kind !== 'opened') return;
    expect(outcome.opened.session.projectId).toBe(state.manifest.project.id);
    expect(outcome.opened.copiedFrom).toBeNull();
    await outcome.opened.session.close();
  });
});

/* ------------------------------------------------------------------ *
 * Bundle imports
 * ------------------------------------------------------------------ */

test.describe('a bundle import applies the answers to the unpacked copy before it is adopted', () => {
  async function bundleWithWindows1252Doc(): Promise<{ bytes: Uint8Array; path: string; docId: string }> {
    const { state, docId } = bookState();
    const fs = new MemoryArtifactFs();
    await writeProject(fs, state, { now: NOW });
    const path = `docs/${docId}.md`;
    const { zipSync } = await ZIP_ENGINE.load();
    const bytes = zipSync({
      [MANIFEST_FILE]: ENC.encode(fs.snapshot()[MANIFEST_FILE]!),
      [path]: withWindows1252Body(fs.snapshot()[path]!),
    });
    return { bytes, path, docId };
  }

  test('the import pauses, and a convert lands the document’s text in the opened copy', async () => {
    const { bytes, path, docId } = await bundleWithWindows1252Doc();
    const store = await openRuntimeStore(new MemoryIndexedDb());

    const outcome = await importBundle(store, bytes, 'Fixture.caotang');

    const pending = expectEncoding(outcome);
    expect(pending.name).toBe('Fixture.caotang');
    expect(await listProjectIds(store)).toEqual([]);

    const done = await completeEncodingReview(store, pending, [{ path, action: 'convert' }]);
    expect(done.kind).toBe('opened');
    if (done.kind !== 'opened') return;
    expect(done.opened.session.state.documents.get(docId)?.body).toContain('Café au lait.');
    // The backup landed on the unpacked copy before the adopt: the bytes the bundle carried.
    expect(await pending.fs.readBytes(encodingBackupPath(path))).toEqual(await zipBytesOf(bytes, path));
    await done.opened.session.close();
  });

  test('leaving the file opens the bundle with the document still held', async () => {
    const { bytes, docId } = await bundleWithWindows1252Doc();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const pending = expectEncoding(await importBundle(store, bytes, 'Fixture.caotang'));

    const done = await completeEncodingReview(store, pending, []);

    expect(done.kind).toBe('opened');
    if (done.kind !== 'opened') return;
    expect(done.opened.session.state.declinedDocFiles.has(`${docId}.md`)).toBe(true);
    expect(done.opened.session.state.documents.has(docId)).toBe(false);
    await done.opened.session.close();
  });
});

/* ------------------------------------------------------------------ *
 * A recovery that ends on the encoding pause
 * ------------------------------------------------------------------ */

test('an accepted recovery whose copy still holds non-UTF-8 files pauses for them, and converts before opening', async () => {
  const { root, tree, state, docId } = await writtenFolder();
  const fs = folderArtifactFs(root);
  // A second write rotates caotang.json to a good backup; the manifest itself is then torn.
  await writeProject(fs, state, { now: NOW });
  const path = `docs/${docId}.md`;
  const original = withWindows1252Body(textOf(folderBytes(tree, path)));
  await plantBytes(root, path, original);
  await fs.writeAtomic(MANIFEST_FILE, '{"formatVersion": 1, "project": ');
  const store = await openRuntimeStore(new MemoryIndexedDb());

  const outcome = await openFolder(store, root);
  expect(outcome.kind).toBe('recover');
  if (outcome.kind !== 'recover') return;

  const accepted = await completeRecovery(store, outcome.recovery);
  // The recovery write ran; the writer now answers for the file it left non-UTF-8.
  expect(accepted.kind).toBe('encoding');
  if (accepted.kind !== 'encoding') return;
  expect(accepted.encoding.cancelNote).toContain('recovery was written');
  expect(folderBytes(tree, path)).toEqual(original);

  const done = await completeEncodingReview(store, accepted.encoding, [{ path, action: 'convert' }]);
  expect(done.kind).toBe('opened');
  if (done.kind !== 'opened') return;
  expect(done.opened.session.state.documents.get(docId)?.body).toContain('Café au lait.');
  expect(folderBytes(tree, encodingBackupPath(path))).toEqual(original);
  await done.opened.session.close();
});

/* ------------------------------------------------------------------ *
 * Ask the AI
 * ------------------------------------------------------------------ */

/** The app database's contract, held in a Map (the providers.spec.ts pattern). */
function memoryDb(): AppDb & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async get<T>(key: string): Promise<T | undefined> {
      return rows.has(key) ? (structuredClone(rows.get(key)) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      rows.set(key, structuredClone(value));
    },
    async list<T>(prefix: string) {
      return [...rows.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value: structuredClone(value) as T }));
    },
    async delete(key: string): Promise<void> {
      rows.delete(key);
    },
    close(): void {},
  };
}

const ENDPOINT = 'https://127.0.0.1:5999/v1';

/** A fetch that answers the endpoint's calls and records each chat request's body for the assertions. */
function scriptedFetch(captured: { bodies: Record<string, unknown>[] }, replyText: string) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }] });
    if (method === 'POST' && url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      captured.bodies.push(body);
      if (body.stream === false) {
        return Response.json({ choices: [{ message: { role: 'assistant', content: '{"ok": true}' } }] });
      }
      const chunks = [
        { choices: [{ delta: { content: replyText }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

test('the ask is not offered when only the demo profile exists', async () => {
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch({ bodies: [] }, 'windows-1252') });

  // The background role resolves the demo profile, whose kind is mock — a mock model cannot read an encoding.
  expect(service.resolveForRole('background')?.profile.kind).toBe('mock');
  expect(encodingAskerFor(service)).toBeNull();
});

test('the ask sends a capped excerpt and the candidate names, no path, and the reply picks the encoding', async () => {
  const captured = { bodies: [] as Record<string, unknown>[] };
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch(captured, 'Big5') });
  const saved = await service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT, defaultModel: 'test-model' });
  await service.activate(saved.view.id);

  const asker = encodingAskerFor(service);
  expect(asker?.profileName).toBe('Local');
  if (asker === null) return;

  const pick = await asker.ask({
    excerpt: `x${'y'.repeat(ASK_EXCERPT_CHARS + 500)}`,
    candidates: ['windows-1252', 'iso-8859-15', 'gb18030', 'big5', 'shift_jis', 'euc-kr'],
  });

  expect(pick).toBe('big5');
  const chatBody = captured.bodies.find((body) => body.stream === true);
  expect(chatBody).toBeDefined();
  const messages = (chatBody?.messages ?? []) as { role: string; content: string }[];
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  // The excerpt is capped and the candidates are listed — and no file path is ever sent.
  expect(user).toContain('y'.repeat(100));
  expect(user.length).toBeLessThan(ASK_EXCERPT_CHARS + 400);
  expect(user).toContain('windows-1252');
  expect(user).not.toContain('docs/');
  expect(user).not.toContain('.md');
  // The request runs under the background role's own profile and model.
  expect(chatBody?.model).toBe('test-model');
});

test('the reply parser names a candidate by name or alias, case-insensitively', () => {
  const candidates = ['windows-1252', 'iso-8859-15', 'gb18030', 'big5', 'shift_jis', 'euc-kr'] as const;
  expect(encodingFromReply('windows-1252', candidates)).toBe('windows-1252');
  expect(encodingFromReply('It looks like CP1252.', candidates)).toBe('windows-1252');
  expect(encodingFromReply('This reads as Shift-JIS text.', candidates)).toBe('shift_jis');
  expect(encodingFromReply('I cannot tell.', candidates)).toBeUndefined();
  expect(encodingFromReply('utf-16le', ['utf-16le', 'big5'])).toBe('utf-16le');
});
