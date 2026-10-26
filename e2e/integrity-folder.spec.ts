/**
 * A project folder across the ways a writer opens and saves it (project-format §4, lifecycle `openFolder`, `saveFolder`): what an open says
 * about the file it read, a save into a folder whose `caotang.json` another program removed, and the writing history a
 * folder holds coming back when the project is opened from the folder after it was removed from this browser.
 *
 * The folder is a directory in the page's own storage, handed out by a stand-in for the folder picker (as media-storyboard-folder.spec.ts
 * does), so the tests change the folder's files through the same file API the app writes with.
 */

import { chromium, expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, FOLDER_ACCESS_ONLY, waitForSaved, writerText } from './support.js';

test.skip(({ browserName }) => browserName !== 'chromium', FOLDER_ACCESS_ONLY);

/** The folder the stand-in picker hands out in a test: a directory in the page's own storage, named for the test. */
async function standInFolderPicker(page: Page, folder: string): Promise<void> {
  await page.addInitScript((name: string) => {
    const host = globalThis as unknown as { showDirectoryPicker: () => Promise<unknown> };
    host.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  }, folder);
}

/** A file at the top of the folder, read back through the file API, or `null` when the folder does not hold it. */
async function readFolderFile(page: Page, folder: string, name: string): Promise<string | null> {
  return page.evaluate(
    async ([dir, file]: readonly [string, string]) => {
      try {
        const handle = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(dir)).getFileHandle(file);
        return await (await handle.getFile()).text();
      } catch {
        return null;
      }
    },
    [folder, name] as const,
  );
}

/** Writes a file at the top of the folder through the file API, or removes it when `text` is `null`: what another program would do. */
async function writeFolderFile(page: Page, folder: string, name: string, text: string | null): Promise<void> {
  await page.evaluate(
    async ([dir, file, body]: readonly [string, string, string | null]) => {
      type Dir = {
        getFileHandle(child: string, options?: { create: boolean }): Promise<{ createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> }>;
        removeEntry(child: string): Promise<void>;
      };
      // A folder no test has made yet is made, as another program would make it.
      const folderHandle = (await (await navigator.storage.getDirectory()).getDirectoryHandle(dir, { create: true })) as unknown as Dir;
      if (body === null) {
        await folderHandle.removeEntry(file);
        return;
      }
      const writable = await (await folderHandle.getFileHandle(file, { create: true })).createWritable();
      await writable.write(body);
      await writable.close();
    },
    [folder, name, text] as const,
  );
}

/** The folder's `caotang.json` as an object, with `change` applied and written back: a folder an older build wrote, for instance. */
async function editFolderManifest(page: Page, folder: string, change: (project: Record<string, unknown>, manifest: Record<string, unknown>) => void): Promise<void> {
  const text = await readFolderFile(page, folder, 'caotang.json');
  if (text === null) throw new Error('the folder holds no caotang.json to edit');
  const manifest = JSON.parse(text) as Record<string, unknown>;
  change(manifest.project as Record<string, unknown>, manifest);
  await writeFolderFile(page, folder, 'caotang.json', JSON.stringify(manifest, null, 2));
}

/** A project with one chapter and one scene carrying `text`, in a new project of the given name. */
async function projectWithWords(page: Page, name: string, text: string): Promise<void> {
  await createProject(page, name);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill(text);
  await waitForSaved(page);
}

/**
 * A status line's whole text, exactly: the line is matched from its start to its end, and only the status's own Dismiss button may follow
 * it. A notice joined without its capital or full stop, or one more notice than the test names, does not match.
 */
function wholeLine(text: string, writer?: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A writer value in the sentence may carry the FSI/PDI pair (i18n.md §5.3); allow it where named.
  const body = writer === undefined ? escaped : escaped.replace(writer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), writerText(writer));
  return new RegExp(`^${body}(Dismiss)?$`);
}

/**
 * Saves the open project to the folder, and waits for the save to say so. The workspace shows one status line, and a save before this one
 * left "Saved the project to the folder “…”" in it, so a test that saves into a second folder names that folder: the wait then holds
 * until this save has finished, rather than passing on the line the earlier save left.
 */
async function saveToFolder(page: Page, folder?: string): Promise<void> {
  await page.getByRole('button', { name: 'Save to folder' }).click();
  // The folder name is writer text and is isolated, so the named form is a matcher rather than a string.
  const saved =
    folder === undefined ? 'Saved the project to the folder' : new RegExp(`Saved the project to the folder “${writerText(folder)}`);
  await expect(page.getByRole('status').filter({ hasText: saved })).toBeVisible();
}

/** Removes the project from this browser, from the projects list. */
async function removeFromBrowser(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await page.getByRole('button', { name: `Remove ${name} from this browser` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
}

test('a folder made before the identifier and the language existed says what the open made, and counts no field', async ({ page }) => {
  await standInFolderPicker(page, 'pre-identity-folder');
  await page.goto('/');
  await projectWithWords(page, 'Pre Identity', 'Words in the folder.');
  await saveToFolder(page);
  await removeFromBrowser(page, 'Pre Identity');

  // The folder as an older Caotang wrote it: the project has no language and no identifier.
  await editFolderManifest(page, 'pre-identity-folder', (project) => {
    delete project.language;
    delete project.identifier;
  });
  await page.getByRole('button', { name: 'Open a folder…' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();

  // Each thing the open made is said in its own sentence, and nothing is counted as dropped on a save: no field is dropped.
  // The whole line is asserted, so a notice joined without its capital and full stop, or one in the file's own terms, fails here.
  const made = page.getByRole('status').filter({ hasText: 'had no language' });
  await expect(made).toBeVisible();
  await expect(made).toHaveText(
    wholeLine(
      'The project had no book identifier for EPUB, so Caotang made one, and the project keeps it from now on. ' +
      'The project had no language, so it is set from the app’s language. You can change it in the project panel.',
    ),
  );
  await expect(page.getByText(/Caotang keeps but does not use/)).toHaveCount(0);
});

test('a field a save drops is named, and the identity made at open is said beside it, even with the MCP lock file present', async ({ page }) => {
  await standInFolderPicker(page, 'dropped-field-folder');
  await page.goto('/');
  await projectWithWords(page, 'Dropped Field', 'Words kept.');
  await saveToFolder(page);
  await removeFromBrowser(page, 'Dropped Field');

  // An unknown field, which the next save drops, and no identifier, which the open makes. The lock file says another program may be
  // using the folder, so the identity made at open is not written back, and the writer is told the next open may make another.
  await editFolderManifest(page, 'dropped-field-folder', (_project, manifest) => {
    delete (manifest.project as Record<string, unknown>).identifier;
    manifest.colour = 'teal';
  });
  await writeFolderFile(page, 'dropped-field-folder', '.caotang-mcp.lock', '');
  await page.getByRole('button', { name: 'Open a folder…' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();

  const status = page.getByRole('status').filter({ hasText: 'The file has a field Caotang keeps but does not use' });
  await expect(status).toBeVisible();
  await expect(status).toHaveText(
    wholeLine(
      'The project had no book identifier for EPUB, so Caotang made one, and the project keeps it from now on. ' +
      'The details Caotang made for this project as it opened were not saved to the folder, because another program, such as the Caotang MCP server, may be using it. The next open may make another set. ' +
      'The file has a field Caotang keeps but does not use: “colour”. It is dropped on the next save.',
      'colour',
    ),
  );
});

test('a folder whose caotang.json another program removed is asked about before a save writes it back', async ({ page }) => {
  await standInFolderPicker(page, 'removed-manifest-folder');
  await page.goto('/');
  await projectWithWords(page, 'Removed Manifest', 'First words.');
  await saveToFolder(page);

  // Another program removes the folder's caotang.json after Caotang saved it; the tab then makes an edit and saves to the folder again.
  await writeFolderFile(page, 'removed-manifest-folder', 'caotang.json', null);
  await page.getByRole('textbox', { name: 'Document text' }).fill('Second words.');
  await waitForSaved(page);
  await page.getByRole('button', { name: 'Save to folder' }).click();

  // The question says the file was removed, and does not send the writer to a newer copy that does not exist.
  const question = page.getByRole('dialog').filter({ hasText: 'caotang.json was removed' });
  await expect(question).toBeVisible();
  await expect(question).toContainText('Another program removed caotang.json from this folder');
  await expect(question).toContainText('Saving here writes caotang.json back into the folder from this tab');
  await expect(question).not.toContainText('open the folder again');
  // The save asked, and wrote nothing: the folder still holds no caotang.json.
  expect(await readFolderFile(page, 'removed-manifest-folder', 'caotang.json')).toBeNull();

  // The writer's yes writes it back, with this tab's project.
  await question.getByRole('button', { name: 'Write it back' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the project to the folder' })).toBeVisible();
  await expect.poll(() => readFolderFile(page, 'removed-manifest-folder', 'caotang.json')).toContain('Removed Manifest');
});

/**
 * A stand-in picker that hands out the folder a test names at the moment it is asked (`pickFolder`), so a test can offer one folder and
 * then another, as a writer choosing again would.
 */
async function switchableFolderPicker(page: Page, first: string): Promise<void> {
  await page.addInitScript((name: string) => {
    const host = globalThis as unknown as { showDirectoryPicker: () => Promise<unknown>; caotangPickFolder?: string };
    host.caotangPickFolder ??= name;
    host.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle(host.caotangPickFolder ?? name, { create: true });
  }, first);
}

/** The folder the switchable picker hands out next. */
async function pickFolder(page: Page, name: string): Promise<void> {
  await page.evaluate((next: string) => {
    (globalThis as unknown as { caotangPickFolder?: string }).caotangPickFolder = next;
  }, name);
}

/** Rewrites the document file in the folder's `docs/` whose text holds `holding`, replacing that text with `text`: another program's edit. */
async function editFolderDocument(page: Page, folder: string, holding: string, text: string): Promise<void> {
  await page.evaluate(
    async ([dir, find, replace]: readonly [string, string, string]) => {
      type Writable = { write(data: string): Promise<void>; close(): Promise<void> };
      type FileHandle = { kind: 'file'; getFile(): Promise<{ text(): Promise<string> }>; createWritable(): Promise<Writable> };
      type Dir = { getDirectoryHandle(child: string): Promise<Dir>; entries(): AsyncIterable<[string, FileHandle | { kind: 'directory' }]> };
      const docs = await ((await (await navigator.storage.getDirectory()).getDirectoryHandle(dir)) as unknown as Dir).getDirectoryHandle('docs');
      for await (const [, handle] of docs.entries()) {
        if (handle.kind !== 'file') continue;
        const body = await (await handle.getFile()).text();
        if (!body.includes(find)) continue;
        const writable = await handle.createWritable();
        await writable.write(body.replace(find, replace));
        await writable.close();
        return;
      }
      throw new Error(`no document in ${dir} holds "${find}"`);
    },
    [folder, holding, text] as const,
  );
}

/** The document text the folder's `docs/` holds, joined: what the folder's version of the book says. */
async function folderDocuments(page: Page, folder: string): Promise<string> {
  return page.evaluate(async (dir: string) => {
    type FileHandle = { kind: 'file'; getFile(): Promise<{ text(): Promise<string> }> };
    type Dir = { getDirectoryHandle(child: string): Promise<Dir>; entries(): AsyncIterable<[string, FileHandle | { kind: 'directory' }]> };
    try {
      const docs = await ((await (await navigator.storage.getDirectory()).getDirectoryHandle(dir)) as unknown as Dir).getDirectoryHandle('docs');
      const texts: string[] = [];
      for await (const [, handle] of docs.entries()) if (handle.kind === 'file') texts.push(await (await handle.getFile()).text());
      return texts.join('\n');
    } catch {
      return '';
    }
  }, folder);
}

/** The text of every file under the folder's `.caotang-backup`, joined, at any depth: what the saves kept of the folder's own version. */
async function backupText(page: Page, folder: string): Promise<string> {
  return page.evaluate(async (dir: string) => {
    type FileHandle = { kind: 'file'; getFile(): Promise<{ text(): Promise<string> }> };
    type Dir = { kind: 'directory'; getDirectoryHandle(child: string): Promise<Dir>; entries(): AsyncIterable<[string, FileHandle | Dir]> };
    const walk = async (directory: Dir): Promise<string[]> => {
      const texts: string[] = [];
      for await (const [, handle] of directory.entries()) {
        texts.push(...(handle.kind === 'file' ? [await (await handle.getFile()).text()] : await walk(handle)));
      }
      return texts;
    };
    try {
      const root = (await (await navigator.storage.getDirectory()).getDirectoryHandle(dir)) as unknown as Dir;
      return (await walk(await root.getDirectoryHandle('.caotang-backup'))).join('\n');
    } catch {
      return '';
    }
  }, folder);
}

/** The labels of a dialog's buttons, in the order the dialog shows them. */
async function buttonLabels(dialog: ReturnType<Page['getByRole']>): Promise<string[]> {
  return (await dialog.getByRole('button').allTextContents()).map((label) => label.trim());
}

// The folder question, and a folder holding another project.
test('documents another program changed are asked about with Save as a new folder…, which takes only an empty folder', async ({ page }) => {
  await switchableFolderPicker(page, 'changed-docs-folder');
  await page.goto('/');
  await projectWithWords(page, 'Changed Docs', 'Words from this tab.');
  await saveToFolder(page);

  // Another program changes the scene in the folder; the tab then saves to the folder again.
  await editFolderDocument(page, 'changed-docs-folder', 'Words from this tab.', 'Words from another program.');
  await page.getByRole('button', { name: 'Save to folder' }).click();
  const question = page.getByRole('dialog').filter({ hasText: 'Some documents in this folder changed since Caotang last saved them' });
  await expect(question).toBeVisible();
  await expect(question.getByRole('listitem')).toContainText(['The Landing']);
  await expect(question).toContainText(
    'Saving writes this tab’s version over them. The folder’s version is kept first, in .caotang-backup in the folder, so if you need anything from it, copy it from there.',
  );
  expect(await buttonLabels(question)).toEqual(['Save as a new folder…', 'Save over them', 'Cancel']);

  // A folder that holds anything is refused with a sentence, and the writer can choose again.
  await writeFolderFile(page, 'not-empty-folder', 'notes.txt', 'Someone else’s notes.');
  await pickFolder(page, 'not-empty-folder');
  await question.getByRole('button', { name: 'Save as a new folder…' }).click();
  const notEmpty = page.getByRole('dialog').filter({ hasText: 'That folder is not empty' });
  await expect(notEmpty).toBeVisible();
  await expect(notEmpty).toContainText(new RegExp(`The folder “${writerText('not-empty-folder')}” already has files in it, so nothing was saved there\\.`));
  expect(await readFolderFile(page, 'not-empty-folder', 'caotang.json')).toBeNull();

  // An empty folder takes the project, through the folder save, and becomes the project's folder.
  await pickFolder(page, 'new-empty-folder');
  await notEmpty.getByRole('button', { name: 'Choose another folder…' }).click();
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`Saved the project to the folder “${writerText('new-empty-folder')}`) })).toBeVisible();
  await expect.poll(() => readFolderFile(page, 'new-empty-folder', 'caotang.json')).toContain('Changed Docs');
  expect(await folderDocuments(page, 'new-empty-folder')).toContain('Words from this tab.');
  // The first folder keeps the other program's text: nothing was written over it.
  expect(await folderDocuments(page, 'changed-docs-folder')).toContain('Words from another program.');
  // The next save goes to the new folder, with no question.
  await page.getByRole('textbox', { name: 'Document text' }).fill('Words saved again.');
  await waitForSaved(page);
  await pickFolder(page, 'new-empty-folder');
  await saveToFolder(page);
  await expect.poll(() => folderDocuments(page, 'new-empty-folder')).toContain('Words saved again.');
});

test('“Save over them” keeps the folder’s version in .caotang-backup, and the status line says where', async ({ page }) => {
  await switchableFolderPicker(page, 'kept-docs-folder');
  await page.goto('/');
  await projectWithWords(page, 'Kept Docs', 'Words from this tab.');
  await saveToFolder(page);
  // A save that asks nothing keeps nothing.
  expect(await backupText(page, 'kept-docs-folder')).toBe('');

  await editFolderDocument(page, 'kept-docs-folder', 'Words from this tab.', 'Words from another program.');
  await page.getByRole('textbox', { name: 'Document text' }).fill('Words from this tab, edited.');
  await waitForSaved(page);
  await page.getByRole('button', { name: 'Save to folder' }).click();
  const question = page.getByRole('dialog').filter({ hasText: 'Some documents in this folder changed since Caotang last saved them' });
  await question.getByRole('button', { name: 'Save over them' }).click();
  const saved = page.getByRole('status').filter({ hasText: new RegExp(`Saved the project to the folder “${writerText('kept-docs-folder')}`) });
  await expect(saved).toContainText(/What it replaced is kept in \.caotang-backup\/\d{4}-\d{2}-\d{2}T[\d-]+Z\./);
  await expect.poll(() => folderDocuments(page, 'kept-docs-folder')).toContain('Words from this tab, edited.');
  expect(await backupText(page, 'kept-docs-folder')).toContain('Words from another program.');
});

test('a document another program changes while the save writes is named after the save, in words that say the save was written', async ({ page }) => {
  await switchableFolderPicker(page, 'raced-docs-folder');
  await page.goto('/');
  await projectWithWords(page, 'Raced Docs', 'Words from this tab.');
  await saveToFolder(page);
  await page.getByRole('textbox', { name: 'Document text' }).fill('Words from this tab, edited.');
  await waitForSaved(page);

  // The other program writes the scene as the save writes caotang.json, which is after the scene was written: the folder ends up holding its version.
  await page.evaluate(async (dir: string) => {
    type Writable = { close(): Promise<void> };
    type FileHandle = { name: string; getFile(): Promise<{ text(): Promise<string> }>; createWritable(): Promise<Writable & { write(data: string): Promise<void> }> };
    type Dir = { getDirectoryHandle(child: string): Promise<Dir>; entries(): AsyncIterable<[string, FileHandle & { kind: string }]> };
    const proto = (globalThis as unknown as { FileSystemFileHandle: { prototype: FileHandle } }).FileSystemFileHandle.prototype;
    const create = proto.createWritable;
    proto.createWritable = async function (this: FileHandle) {
      const writable = await create.call(this);
      if (this.name !== 'caotang.json') return writable;
      const close = writable.close.bind(writable);
      writable.close = async () => {
        await close();
        const docs = await ((await (await navigator.storage.getDirectory()).getDirectoryHandle(dir)) as unknown as Dir).getDirectoryHandle('docs');
        for await (const [, entry] of docs.entries()) {
          if (entry.kind !== 'file') continue;
          const text = await (await entry.getFile()).text();
          const out = await create.call(entry);
          await out.write(text.replace('Words from this tab, edited.', 'Words from another program.'));
          await out.close();
        }
      };
      return writable;
    };
  }, 'raced-docs-folder');
  await page.getByRole('button', { name: 'Save to folder' }).click();
  const question = page.getByRole('dialog').filter({ hasText: 'Some documents in this folder changed since Caotang last saved them' });
  await expect(question).toContainText('Another program changed these files in the folder while Caotang was saving. The save was written, and the folder now holds that program’s version of them:');
  await expect(question.getByRole('listitem')).toContainText(['The Landing']);
  expect(await folderDocuments(page, 'raced-docs-folder')).toContain('Words from another program.');
});

test('a folder holding another project asks with the owner’s words and three choices, and “Save over it” writes this one there', async ({ page }) => {
  await switchableFolderPicker(page, 'shared-folder');
  await page.goto('/');
  await projectWithWords(page, 'First Book', 'Words of the first book.');
  await saveToFolder(page);
  // A second, separate project is saved to the folder the first one is in.
  await projectWithWords(page, 'Second Book', 'Words of the second book.');
  await page.getByRole('button', { name: 'Save to folder' }).click();
  const question = page.getByRole('dialog').filter({ hasText: 'This folder already holds another project' });
  await expect(question).toBeVisible();
  await expect(question).toContainText(
    'Saving here replaces that project’s caotang.json and any of its documents that share an id with this one. Caotang keeps a backup of that caotang.json, and copies each document it replaces to .caotang-backup in the folder.',
  );
  expect(await buttonLabels(question)).toEqual(['Save as a new folder…', 'Save over it', 'Cancel']);
  expect(await readFolderFile(page, 'shared-folder', 'caotang.json')).toContain('First Book');

  // "Save over it" goes through the folder save: the folder holds the second project, and the first one's caotang.json is the backup.
  await question.getByRole('button', { name: 'Save over it' }).click();
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`Saved the project to the folder “${writerText('shared-folder')}`) })).toBeVisible();
  expect(await readFolderFile(page, 'shared-folder', 'caotang.json')).toContain('Second Book');
  expect(await readFolderFile(page, 'shared-folder', 'caotang.json.bak.1')).toContain('First Book');
  expect(await folderDocuments(page, 'shared-folder')).toContain('Words of the second book.');
});

test('this project’s own folder after a reload is not another project: the save goes straight in', async ({ page }) => {
  await switchableFolderPicker(page, 'own-folder');
  await page.goto('/');
  await projectWithWords(page, 'Own Folder', 'Words before the reload.');
  await saveToFolder(page);
  // After a reload this tab holds no copy of the folder, but the folder is as Caotang last left it, so nothing needs asking.
  await page.reload();
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('treeitem', { name: /The Landing/ }).getByText('The Landing').click();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Words after the reload.');
  await waitForSaved(page);
  await saveToFolder(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => folderDocuments(page, 'own-folder')).toContain('Words after the reload.');
});

test('this project’s earlier save in a folder Caotang has no record of asks in words that name this project', async ({ page }) => {
  await switchableFolderPicker(page, 'older-folder');
  await page.goto('/');
  await projectWithWords(page, 'Earlier Save', 'Words in the older folder.');
  await saveToFolder(page, 'older-folder');
  // The project is then saved to a new, empty folder, which is the one Caotang keeps a record of. The reload waits for that save to say
  // it finished: a reload part way through it leaves the record naming the older folder, and the save below then goes straight in.
  await pickFolder(page, 'newer-folder');
  await saveToFolder(page, 'newer-folder');
  await page.reload();
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await pickFolder(page, 'older-folder');
  await page.getByRole('button', { name: 'Save to folder' }).click();
  const question = page.getByRole('dialog').filter({ hasText: 'This folder holds an earlier save of this project' });
  await expect(question).toBeVisible();
  await expect(question).not.toContainText('another project');
  await expect(question).toContainText(
    'Caotang has no record of what this folder held when this project was last saved there, so it can’t tell which documents changed since. Saving writes this tab’s version over the folder’s documents. The folder’s version of each one it replaces is kept in .caotang-backup in the folder, and an older caotang.json is kept as a backup of its own, so if you need anything from it, copy it from there.',
  );
  expect(await buttonLabels(question)).toEqual(['Save as a new folder…', 'Save over it', 'Cancel']);
  await question.getByRole('button', { name: 'Save over it' }).click();
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`Saved the project to the folder “${writerText('older-folder')}`) })).toBeVisible();
});

/**
 * A page in an ordinary (not private) browser profile, where a folder handle read back from IndexedDB works: the default test context is
 * private, and Chromium closes the page when it reads a handle there (folder-memory.ts `inPrivateFileSystem`). The page tells the app to
 * remember the stand-in picker's folders, which live in the page's own storage.
 */
const ordinaryProfile = test.extend<{ page: Page }>({
  page: async ({ baseURL }, provide, testInfo) => {
    // A browser of its own starts and stops for each of these tests, which a loaded full run makes slow: the stop is given time too.
    testInfo.setTimeout(testInfo.timeout + 60_000);
    const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
      baseURL,
      viewport: { width: 1280, height: 720 },
    });
    await context.addInitScript(() => {
      (globalThis as unknown as { caotangRememberPrivateFolders: boolean }).caotangRememberPrivateFolders = true;
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await provide(page);
    await context.close();
  },
});

// Linking a copy to its folder.
ordinaryProfile('a project remembers its folder: Reopen folder opens it in one click, and a folder that differs asks which version to keep', async ({ page }) => {
  await standInFolderPicker(page, 'remembered-folder');
  await page.goto('/');
  await projectWithWords(page, 'Remembered', 'Words in both places.');
  await saveToFolder(page);

  // The same book in the folder and in this browser: one click opens it as the folder's own project, with no copy made.
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen folder of Remembered' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.getByText('separate copy')).toHaveCount(0);

  // Another program changes the folder. Reopening asks, and nothing opens or changes until the writer answers.
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await editFolderDocument(page, 'remembered-folder', 'Words in both places.', 'Words the folder holds.');
  await page.getByRole('button', { name: 'Reopen folder of Remembered' }).click();
  const question = page.getByRole('dialog').filter({ hasText: new RegExp(`The folder holds a different version of “${writerText('Remembered')}”`) });
  await expect(question).toBeVisible();
  expect(await buttonLabels(question)).toEqual([
    'Use the folder’s version',
    'Keep this browser’s version and save it to the folder',
    'Open as a separate copy',
    'Cancel',
  ]);

  // Keeping this browser's version opens it and saves it to the folder, through the changed-documents question.
  await question.getByRole('button', { name: 'Keep this browser’s version and save it to the folder' }).click();
  const changed = page.getByRole('dialog').filter({ hasText: 'Some documents in this folder changed since Caotang last saved them' });
  await expect(changed).toBeVisible();
  await expect(changed.getByRole('listitem')).toContainText(['The Landing']);
  expect(await folderDocuments(page, 'remembered-folder')).toContain('Words the folder holds.');
  await changed.getByRole('button', { name: 'Save over them' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the project to the folder' })).toBeVisible();
  await expect.poll(() => folderDocuments(page, 'remembered-folder')).toContain('Words in both places.');
});

ordinaryProfile('a folder that differs can be taken as it is, or opened as a separate copy with the copy notice', async ({ page }) => {
  await standInFolderPicker(page, 'differs-folder');
  await page.goto('/');
  await projectWithWords(page, 'Differs', 'Words this browser holds.');
  await saveToFolder(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await editFolderDocument(page, 'differs-folder', 'Words this browser holds.', 'Words the folder has now.');

  // "Open as a separate copy" is the open as it was before the question: a copy with its own id, and the notice that says so.
  await page.getByRole('button', { name: 'Reopen folder of Differs' }).click();
  const question = page.getByRole('dialog').filter({ hasText: new RegExp(`The folder holds a different version of “${writerText('Differs')}”`) });
  await question.getByRole('button', { name: 'Open as a separate copy' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'the folder opened as a separate copy' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Differs' })).toHaveCount(2);

  // "Use the folder's version" puts the folder's text in this browser's project, under its own name, and opens it.
  await page.getByRole('button', { name: 'Reopen folder of Differs' }).first().click();
  await page
    .getByRole('dialog')
    .filter({ hasText: new RegExp(`The folder holds a different version of “${writerText('Differs')}”`) })
    .getByRole('button', { name: 'Use the folder’s version' })
    .click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await binderTitle(page, 'The Landing').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('Words the folder has now.');
});

test('the writing history a folder holds comes back when the project is opened from it after it was removed from this browser', async ({ page }) => {
  await standInFolderPicker(page, 'history-folder');
  await page.goto('/');
  // A daily target, so the words of a sitting are counted on the session line the workspace shows.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Writing' }).click();
  await settings.getByLabel('Daily target, in words (0 for none)').fill('300');
  await settings.getByRole('button', { name: 'Save writing settings' }).click();
  await expect(settings.getByText(/Saved\. The save delay/)).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();

  await projectWithWords(page, 'History Folder', 'one two three four five six seven');
  await expect(page.getByTestId('session-target')).toContainText('7 / 300 words today');

  // Leaving the project ends the sitting, and its line goes into the store's log. Opened again, it is saved to the folder with that line.
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await saveToFolder(page);
  await expect.poll(() => readFolderFile(page, 'history-folder', 'sessions.jsonl')).toContain('"wordsWritten":7');

  // The project leaves this browser, with its log. Opening the folder brings the folder's history back into the browser's copy.
  await removeFromBrowser(page, 'History Folder');
  await page.getByRole('button', { name: 'Open a folder…' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await binderTitle(page, 'The Landing').click();
  await expect(page.getByTestId('session-target')).toContainText('7 / 300 words today');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('one two three four five six seven');
});
