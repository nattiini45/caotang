/**
 * **Import plain text…** and **Import RTF…** (import-preview.md §2, issues #283 and #274): a manuscript file opens in the shared
 * import preview, split into chapters and scenes by the splitter (import-core.md), and nothing is written until the writer chooses
 * Import there; the import is one undo step (`binder.importTree`).
 *
 * The readers, the splitter and the preview's sources load when a file is chosen (text-source.ts, rtf-source.ts), so the first load
 * carries only these two buttons and their file inputs. The file is read in the browser and goes nowhere.
 */
/* lingui-set comment="The binder's manuscript import buttons. Interpolated values: file (the file's name), problem (why it could not be read)" */

import { useRef, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';

import { openImportPreview } from '../import-preview/requests.js';
import { useReport } from './shared.js';

export function ManuscriptImportActions(): ReactNode {
  const report = useReport();
  const textFile = useRef<HTMLInputElement>(null);
  const rtfFile = useRef<HTMLInputElement>(null);
  const rtfdFolder = useRef<HTMLInputElement>(null);
  const mdFile = useRef<HTMLInputElement>(null);
  const mdFolder = useRef<HTMLInputElement>(null);
  const obsidianFolder = useRef<HTMLInputElement>(null);
  const obsidianZip = useRef<HTMLInputElement>(null);

  const failed = (file: File, failure: unknown): void => {
    const problem = failure instanceof Error ? failure.message : String(failure);
    report({ text: t`${{ file: isolate(file.name) }} could not be read: ${{ problem }}`, tone: 'error' });
  };

  const openText = async (file: File): Promise<void> => {
    try {
      const { plainTextPreviewSource, plainTextSizeRefusal } = await import('../import-preview/text-source.js');
      // The size is checked before the file is read, so a file past the reader's cap never reaches memory.
      const refusal = plainTextSizeRefusal(file.name, file.size);
      if (refusal !== undefined) {
        report({ text: refusal, tone: 'error' });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const opened = plainTextPreviewSource(file.name, bytes);
      if (!opened.ok) {
        report({ text: opened.message, tone: 'error' });
        return;
      }
      openImportPreview({ source: opened.source });
    } catch (failure) {
      failed(file, failure);
    }
  };

  const openRtf = async (file: File): Promise<void> => {
    try {
      const { rtfPreviewSource, rtfSizeRefusal } = await import('../import-preview/rtf-source.js');
      const refusal = rtfSizeRefusal(file.name, file.size);
      if (refusal !== undefined) {
        report({ text: refusal, tone: 'error' });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      openImportPreview({ source: rtfPreviewSource(file.name, bytes) });
    } catch (failure) {
      failed(file, failure);
    }
  };

  // An `.rtfd` is a package folder (TXT.rtf plus the pictures it names), so it is picked whole; the browser lists its files with
  // their paths. The bytes are read here (I/O), and the package is unpacked and parsed in the preview's Worker (import-rtf.md §4).
  const openRtfd = async (files: readonly File[]): Promise<void> => {
    const list = [...files];
    if (list.length === 0) return;
    try {
      const { rtfdPreviewSource } = await import('../import-preview/rtf-source.js');
      const { ARCHIVE_LIMITS } = await import('@caotang/import-read/zip');
      const total = list.reduce((sum, file) => sum + file.size, 0);
      if (list.length > ARCHIVE_LIMITS.maxEntries || total > ARCHIVE_LIMITS.maxTotalBytes) {
        report({ text: t`The RTFD package is too large to import.`, tone: 'error' });
        return;
      }
      const top = (list[0]?.webkitRelativePath ?? '').split('/')[0] || t`RTFD package`;
      const read = await Promise.all(
        list.map(async (file) => ({
          path: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
          size: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      openImportPreview({ source: rtfdPreviewSource(top, read) });
    } catch (failure) {
      report({ text: t`The RTFD package could not be read: ${{ problem: failure instanceof Error ? failure.message : String(failure) }}`, tone: 'error' });
    }
  };

  const openMarkdown = async (file: File): Promise<void> => {
    try {
      const { markdownPreviewSource, markdownZipPreviewSource } = await import('../import-preview/markdown-source.js');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const source = /\.zip$/i.test(file.name) ? markdownZipPreviewSource(file.name, bytes) : markdownPreviewSource(file.name, bytes);
      openImportPreview({ source });
    } catch (failure) {
      failed(file, failure);
    }
  };

  // A folder of Markdown files: each file a scene, each subfolder a chapter. The bytes are read here (I/O); the parsing runs in the
  // preview's Worker (import-markdown.md §4).
  const openMarkdownFolder = async (files: readonly File[]): Promise<void> => {
    const list = [...files];
    if (list.length === 0) return;
    try {
      const { markdownFolderPreviewSource } = await import('../import-preview/markdown-source.js');
      const { ARCHIVE_LIMITS } = await import('@caotang/import-read/zip');
      const total = list.reduce((sum, file) => sum + file.size, 0);
      if (list.length > ARCHIVE_LIMITS.maxEntries || total > ARCHIVE_LIMITS.maxTotalBytes) {
        report({ text: t`The Markdown folder is too large to import.`, tone: 'error' });
        return;
      }
      const top = (list[0]?.webkitRelativePath ?? '').split('/')[0] || t`Markdown folder`;
      const read = await Promise.all(
        list.map(async (file) => ({
          path: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
          size: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      openImportPreview({ source: markdownFolderPreviewSource(top, read) });
    } catch (failure) {
      report({ text: t`The Markdown folder could not be read: ${{ problem: failure instanceof Error ? failure.message : String(failure) }}`, tone: 'error' });
    }
  };

  const openObsidianZip = async (file: File): Promise<void> => {
    try {
      const { obsidianZipPreviewSource } = await import('../import-preview/obsidian-source.js');
      const bytes = new Uint8Array(await file.arrayBuffer());
      openImportPreview({ source: obsidianZipPreviewSource(file.name, bytes) });
    } catch (failure) {
      failed(file, failure);
    }
  };

  // An Obsidian vault is a folder of notes (plus .obsidian/ config); it is picked whole, the bytes read here (I/O) and the vault
  // parsed in the preview's Worker (import-obsidian.md).
  const openObsidianFolder = async (files: readonly File[]): Promise<void> => {
    const list = [...files];
    if (list.length === 0) return;
    try {
      const { obsidianPreviewSource } = await import('../import-preview/obsidian-source.js');
      const { ARCHIVE_LIMITS } = await import('@caotang/import-read/zip');
      const total = list.reduce((sum, file) => sum + file.size, 0);
      if (list.length > ARCHIVE_LIMITS.maxEntries || total > ARCHIVE_LIMITS.maxTotalBytes) {
        report({ text: t`The Obsidian vault is too large to import.`, tone: 'error' });
        return;
      }
      const top = (list[0]?.webkitRelativePath ?? '').split('/')[0] || t`Obsidian vault`;
      const read = await Promise.all(
        list.map(async (file) => ({
          path: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
          size: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      openImportPreview({ source: obsidianPreviewSource(top, read) });
    } catch (failure) {
      report({ text: t`The Obsidian vault could not be read: ${{ problem: failure instanceof Error ? failure.message : String(failure) }}`, tone: 'error' });
    }
  };

  return (
    <div className="script-import" role="group" aria-label={t`Import a manuscript`}>
      <button type="button" className="button is-quiet" onClick={() => textFile.current?.click()}>
        <Trans>Import plain text…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => rtfFile.current?.click()}>
        <Trans>Import RTF…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => rtfdFolder.current?.click()}>
        <Trans>Import RTFD…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => mdFile.current?.click()}>
        <Trans>Import Markdown…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => mdFolder.current?.click()}>
        <Trans>Import Markdown folder…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => obsidianZip.current?.click()}>
        <Trans>Import Obsidian zip…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => obsidianFolder.current?.click()}>
        <Trans>Import Obsidian vault…</Trans>
      </button>
      <input
        ref={textFile}
        type="file"
        hidden
        accept=".txt,.text,text/plain"
        aria-label={t`Plain text file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openText(file);
        }}
      />
      <input
        ref={rtfFile}
        type="file"
        hidden
        accept=".rtf,application/rtf,text/rtf"
        aria-label={t`RTF file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openRtf(file);
        }}
      />
      <input
        ref={rtfdFolder}
        type="file"
        multiple
        hidden
        aria-label={t`RTFD package folder`}
        // A package folder is picked whole; the browser lists its files with their paths (webkitRelativePath).
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          // Snapshot the files before clearing the input: a FileList is live, so resetting value empties it.
          const files = event.currentTarget.files;
          const list = files === null ? [] : [...files];
          event.currentTarget.value = '';
          if (list.length > 0) void openRtfd(list);
        }}
      />
      <input
        ref={mdFile}
        type="file"
        hidden
        accept=".md,.markdown,.mdown,.mkd,.zip"
        aria-label={t`Markdown file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openMarkdown(file);
        }}
      />
      <input
        ref={mdFolder}
        type="file"
        multiple
        hidden
        aria-label={t`Markdown folder`}
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          const files = event.currentTarget.files;
          const list = files === null ? [] : [...files];
          event.currentTarget.value = '';
          if (list.length > 0) void openMarkdownFolder(list);
        }}
      />
      <input
        ref={obsidianZip}
        type="file"
        hidden
        accept=".zip"
        aria-label={t`Obsidian vault zip`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openObsidianZip(file);
        }}
      />
      <input
        ref={obsidianFolder}
        type="file"
        multiple
        hidden
        aria-label={t`Obsidian vault folder`}
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          const files = event.currentTarget.files;
          const list = files === null ? [] : [...files];
          event.currentTarget.value = '';
          if (list.length > 0) void openObsidianFolder(list);
        }}
      />
    </div>
  );
}
