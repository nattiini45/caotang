/**
 * The save guard (session.ts, `firstFolderDrift`): a save from this server never overwrites a document or codex file another program
 * edited, and never deletes one another program added. The probes behind these tests were run by hand against a seeded folder: a
 * marker appended to a document followed by `meta.set` on it was lost; a document added to `docs/` was pruned as unowned by the next save.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FolderChangedError, openProject, type ProjectSession } from '../src/index.js';

import { HAND_WRITTEN_DOC, HAND_WRITTEN_DOC_NAME, LANDING, LANDING_BODY, connectClient, folderBytes, removeDir, seedProject, startFixture, tempDir } from './support.js';

/** The document's path as the server names it: POSIX, whatever the platform (the writer's own paths are POSIX too). */
const DOC_PATH = `docs/${LANDING}.md`;
const MARKER = 'A line another program wrote while the server was running.\n';

/** A session over a seeded folder, with writes allowed. The caller closes it, and removes the folder. */
async function openSeeded(label: string): Promise<{ root: string; session: ProjectSession }> {
  const root = tempDir(label);
  await seedProject(root, 'Guarded Book');
  return { root, session: await openProject({ root, allowWrites: true }) };
}

describe('a save refuses to overwrite a document another program edited', () => {
  it('a document edited by another program is not overwritten, and its text stays as that program wrote it', async () => {
    const { root, session } = await openSeeded('guard-edit');
    try {
      appendFileSync(join(root, DOC_PATH), MARKER);
      const before = folderBytes(root);

      await expect(
        session.callDirect('meta.set', 'call-edit', { targets: [LANDING], status: 'final' }, 'turn-edit'),
      ).rejects.toBeInstanceOf(FolderChangedError);

      expect(folderBytes(root)).toEqual(before);
      expect(readFileSync(join(root, DOC_PATH), 'utf8')).toContain(MARKER.trim());
    } finally {
      await session.close();
      removeDir(root);
    }
  });

  it('the refusal names the document that changed by its title, and says the change is in memory and not saved', async () => {
    const { root, session } = await openSeeded('guard-named');
    try {
      appendFileSync(join(root, DOC_PATH), MARKER);

      const refused = session.callDirect('meta.set', 'call-named', { targets: [LANDING], status: 'final' }, 'turn-named');
      await expect(refused).rejects.toThrow('because another program changed the document “The Landing”.');
      await expect(refused).rejects.toThrow('The change is in memory and is not saved.');
    } finally {
      await session.close();
      removeDir(root);
    }
  });

  it('the refusal names the project by its name, and not by the folder path it is open at', async () => {
    const { root, session } = await openSeeded('guard-path');
    try {
      appendFileSync(join(root, DOC_PATH), MARKER);

      const refused = session.callDirect('meta.set', 'call-path', { targets: [LANDING], status: 'final' }, 'turn-path');
      const message = await refused.then(
        () => '',
        (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)),
      );
      // The refusal is read by an external model, so it must not carry the machine's own
      // path to the project: that is a stronger identifier than any file name, and it
      // leaves the machine for the provider the caller chose.
      expect(message).not.toContain(root);
      expect(message).toContain('“Guarded Book”');
    } finally {
      await session.close();
      removeDir(root);
    }
  });

  it('once refused, later writes are refused without a second look, and the folder keeps its bytes', async () => {
    const { root, session } = await openSeeded('guard-stopped');
    try {
      appendFileSync(join(root, DOC_PATH), MARKER);
      await expect(
        session.callDirect('meta.set', 'call-first', { targets: [LANDING], status: 'final' }, 'turn-first'),
      ).rejects.toBeInstanceOf(FolderChangedError);
      const before = folderBytes(root);

      const second = session.callDirect('meta.set', 'call-second', { targets: [LANDING], status: 'draft' }, 'turn-second');
      await expect(second).rejects.toBeInstanceOf(FolderChangedError);
      await expect(second).rejects.toThrow('Nothing was written.');
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await session.close();
      removeDir(root);
    }
  });
});

describe('a save refuses to delete a document another program added', () => {
  it('a document file added to docs/ by another program is kept, and the save is refused', async () => {
    const { root, session } = await openSeeded('guard-added-doc');
    try {
      const added = `docs/${HAND_WRITTEN_DOC_NAME}`;
      writeFileSync(join(root, added), HAND_WRITTEN_DOC);
      const before = folderBytes(root);

      // The writer is told in words: this server does not hold the document, so it has no title for it.
      await expect(
        session.callDirect('meta.set', 'call-added', { targets: [LANDING], status: 'final' }, 'turn-added'),
      ).rejects.toThrow('because another program added a document this server does not hold.');

      expect(existsSync(join(root, added))).toBe(true);
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await session.close();
      removeDir(root);
    }
  });

  it('a codex file added to codex/ by another program is kept, and the save is refused', async () => {
    const { root, session } = await openSeeded('guard-added-codex');
    try {
      mkdirSync(join(root, 'codex'), { recursive: true });
      const added = join('codex', 'c_5H8QK2M9RT.md');
      writeFileSync(join(root, added), '---\nid: c_5H8QK2M9RT\nname: Written elsewhere\n---\n\nA codex entry nobody here made.\n');
      const before = folderBytes(root);

      await expect(
        session.callDirect('meta.set', 'call-codex', { targets: [LANDING], status: 'final' }, 'turn-codex'),
      ).rejects.toBeInstanceOf(FolderChangedError);

      expect(existsSync(join(root, added))).toBe(true);
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await session.close();
      removeDir(root);
    }
  });

  it('a document file a program removed is a change, and nothing is written in its place', async () => {
    const { root, session } = await openSeeded('guard-removed');
    try {
      rmSync(join(root, DOC_PATH));
      const before = folderBytes(root);

      await expect(
        session.callDirect('meta.set', 'call-removed', { targets: [LANDING], status: 'final' }, 'turn-removed'),
      ).rejects.toBeInstanceOf(FolderChangedError);

      expect(folderBytes(root)).toEqual(before);
    } finally {
      await session.close();
      removeDir(root);
    }
  });
});

describe('a save that fails part way does not stop the server', () => {
  it('a save that could not finish names the failure by its code, not by the machine path of the file', async () => {
    const fixture = await startFixture({ label: 'guard-reason', allowWrites: true, seed: true });
    // A directory where the manifest's snapshot rotation writes a file: the document is written
    // first, then the save fails before the manifest, with the error Node gives for that write.
    const blocker = join(fixture.root, 'caotang.json.bak.1');
    try {
      mkdirSync(blocker);
      const client = await connectClient(fixture.url, fixture.token);
      try {
        const result = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
        const message = JSON.stringify(result);
        // The reason an external caller reads is the class of failure. A raw error message
        // carries the machine's path to the file it hit, and that is an identifier the
        // refusal must not give away: §4 rule 5 names a file by its title and name.
        expect(message).not.toContain(fixture.root);
        // The class of the failure, and not one machine's name of it: reading a directory is
        // EISDIR on Linux, and EACCES or EPERM on Windows.
        expect(message).toMatch(/\bE[A-Z]+\b/);
        // No raw error text comes along: it would carry the machine's own path to the file.
        expect(message).not.toMatch(/illegal operation|operation not permitted/);
      } finally {
        await client.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it('the next save goes through, because this server’s own partial write is not another program’s change', async () => {
    const { root, session } = await openSeeded('guard-partial');
    // A directory where the manifest's snapshot rotation writes a file: the document is written first, then the save fails before the manifest.
    const blocker = join(root, 'caotang.json.bak.1');
    try {
      mkdirSync(blocker);
      await expect(
        session.callDirect('meta.set', 'call-partial', { targets: [LANDING], status: 'final' }, 'turn-partial'),
      ).rejects.toThrow();
      expect(readFileSync(join(root, DOC_PATH), 'utf8')).toContain('status: final');
      rmSync(blocker, { recursive: true, force: true });

      await session.callDirect('meta.set', 'call-after', { targets: [LANDING], status: 'revised' }, 'turn-after');

      const manifest = JSON.parse(readFileSync(join(root, 'caotang.json'), 'utf8')) as { tree: Array<{ id: string; status: string }> };
      expect(manifest.tree.find((node) => node.id === LANDING)?.status).toBe('revised');
    } finally {
      await session.close();
      removeDir(root);
    }
  });
});

describe('the copy a save checks against is the folder as it was when the server last read or wrote it', () => {
  it('a change made while the server was stopped is loaded, and the next save does not refuse it', async () => {
    const { root, session } = await openSeeded('guard-reopen');
    await session.close();
    appendFileSync(join(root, DOC_PATH), MARKER);

    const reopened = await openProject({ root, allowWrites: true });
    try {
      await reopened.callDirect('meta.set', 'call-reopen', { targets: [LANDING], status: 'final' }, 'turn-reopen');
      expect(reopened.state.documents.get(LANDING)?.body).toContain(MARKER.trim());
      expect(readFileSync(join(root, DOC_PATH), 'utf8')).toContain(MARKER.trim());
    } finally {
      await reopened.close();
      removeDir(root);
    }
  });

  it('the server’s own saves are not taken for another program’s change, across several writes', async () => {
    const { root, session } = await openSeeded('guard-own');
    try {
      await session.callDirect('meta.set', 'call-own-1', { targets: [LANDING], status: 'revised' }, 'turn-own-1');
      await session.callDirect('meta.set', 'call-own-2', { targets: [LANDING], status: 'final' }, 'turn-own-2');
      await session.callDirect('meta.set', 'call-own-3', { targets: [LANDING], status: 'draft' }, 'turn-own-3');

      expect(readFileSync(join(root, DOC_PATH), 'utf8')).toContain(LANDING_BODY);
      expect(session.state.manifest.tree.find((node) => node.id === LANDING)?.status).toBe('draft');
      expect(existsSync(join(root, 'caotang.json'))).toBe(true);
    } finally {
      await session.close();
      removeDir(root);
    }
  });
});

describe('a confirmed write checks the folder before the host is asked', () => {
  it('a document another program changed is named by verifyFolder, so the check refuses the call and nothing is written', async () => {
    const { root, session } = await openSeeded('guard-verify');
    try {
      appendFileSync(join(root, DOC_PATH), MARKER);
      const before = folderBytes(root);

      await session.verifyFolder();
      const refusal = session.check('meta.set', { targets: [LANDING], status: 'final' });
      expect(refusal?.message).toContain('was not made');
      expect(refusal?.message).toContain('because another program changed the document “The Landing”.');
      expect(refusal?.message).toContain('Nothing was written.');

      // The change stopped the writes, as a save's check would: a later write is refused too, and the folder keeps its bytes.
      await expect(
        session.callDirect('meta.set', 'call-verify', { targets: [LANDING], status: 'final' }, 'turn-verify'),
      ).rejects.toBeInstanceOf(FolderChangedError);
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await session.close();
      removeDir(root);
    }
  });

  it('a folder that still holds what the session holds passes verifyFolder, and the check finds nothing to refuse', async () => {
    const { root, session } = await openSeeded('guard-verify-clean');
    try {
      await session.verifyFolder();
      expect(session.check('meta.set', { targets: [LANDING], status: 'final' })).toBeUndefined();
    } finally {
      await session.close();
      removeDir(root);
    }
  });
});

describe('the refusal says what changed in words, and a change made during a save is refused at its file', () => {
  it('the refusal carries the document’s title, and no node id and no file name', async () => {
    const { root, session } = await openSeeded('guard-words');
    try {
      appendFileSync(join(root, DOC_PATH), MARKER);

      const refused = session.callDirect('meta.set', 'call-words', { targets: [LANDING], status: 'final' }, 'turn-words');
      const message = await refused.then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      expect(message).toContain('The Landing');
      expect(message).not.toContain(LANDING);
      expect(message).not.toContain(DOC_PATH);
    } finally {
      await session.close();
      removeDir(root);
    }
  });

  it('a change made after the save’s check and before the write reaches the file is refused there, and the file keeps the other program’s bytes', async () => {
    const { root, session } = await openSeeded('guard-race');
    try {
      // The check runs first and finds nothing. The writer's first step is to make the folder's directories, so another program edits the
      // document at that point, after the check and before the write reaches the file.
      const fs = session.fs;
      const ensureDir = fs.ensureDir.bind(fs);
      let raced = false;
      fs.ensureDir = async (dir: string) => {
        if (!raced && dir === 'docs') {
          raced = true;
          appendFileSync(join(root, DOC_PATH), MARKER);
        }
        return ensureDir(dir);
      };

      const refused = session.callDirect('meta.set', 'call-race', { targets: [LANDING], status: 'final' }, 'turn-race');
      await expect(refused).rejects.toBeInstanceOf(FolderChangedError);
      await expect(refused).rejects.toThrow('because another program changed the document “The Landing”.');
      expect(readFileSync(join(root, DOC_PATH), 'utf8')).toContain(MARKER.trim());
    } finally {
      await session.close();
      removeDir(root);
    }
  });

  it('a manifest another program changes right after a save is a change after the save, and the refusal says the saved change may not be in the folder', async () => {
    const { root, session } = await openSeeded('guard-after');
    try {
      const fs = session.fs;
      const writeAtomic = fs.writeAtomic.bind(fs);
      let overwritten = false;
      fs.writeAtomic = async (path: string, contents: string) => {
        await writeAtomic(path, contents);
        if (path === 'caotang.json' && !overwritten) {
          overwritten = true;
          await writeAtomic('caotang.json', '{"formatVersion": 1, "other": "program"}');
        }
      };

      const refused = session.callDirect('meta.set', 'call-after-save', { targets: [LANDING], status: 'final' }, 'turn-after-save');
      await expect(refused).rejects.toBeInstanceOf(FolderChangedError);
      await expect(refused).rejects.toThrow('because another program changed caotang.json after this server saved it.');
      await expect(refused).rejects.toThrow('The change was saved, and then another program changed caotang.json, so the folder may not hold it.');
    } finally {
      await session.close();
      removeDir(root);
    }
  });
});
