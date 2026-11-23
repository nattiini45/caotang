/**
 * **Import plain text…**, **Import RTF…**, **Import RTFD…** and **Import captions…** (import-preview.md §2, issues #283, #274 and #287):
 * a manuscript file opens in the shared import preview, split into chapters and scenes by the splitter (import-core.md), and nothing is
 * written until the writer chooses Import there; the import is one undo step (`binder.importTree`). Captions become one AV script
 * episode instead of chapters (import-captions.md §5).
 *
 * The readers, the splitter and the preview's sources load when a file is chosen (text-source.ts, rtf-source.ts, captions-source.ts), so
 * the first load carries only these buttons and their file inputs. The file is read in the browser and goes nowhere.
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
  const captionsFile = useRef<HTMLInputElement>(null);
  const htmlFile = useRef<HTMLInputElement>(null);
  const epubFile = useRef<HTMLInputElement>(null);
  const ao3File = useRef<HTMLInputElement>(null);
  const kankaFile = useRef<HTMLInputElement>(null);
  const docxFile = useRef<HTMLInputElement>(null);
  const odtFile = useRef<HTMLInputElement>(null);
  const csvFile = useRef<HTMLInputElement>(null);

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

  const openCaptions = async (file: File): Promise<void> => {
    try {
      const { captionsPreviewSource, captionsSizeRefusal } = await import('../import-preview/captions-source.js');
      const refusal = captionsSizeRefusal(file.name, file.size);
      if (refusal !== undefined) {
        report({ text: refusal, tone: 'error' });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const opened = captionsPreviewSource(file.name, bytes);
      if (!opened.ok) {
        report({ text: opened.message, tone: 'error' });
        return;
      }
      openImportPreview({ source: opened.source });
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

  const openHtml = async (file: File): Promise<void> => {
    try {
      const { htmlPreviewSource, htmlZipPreviewSource, htmlSizeRefusal } = await import('../import-preview/html-source.js');
      const zip = /\.zip$/i.test(file.name);
      // The size is checked before the file is loaded into memory, as the plain-text and RTF actions do: a 4 GB pick must be
      // refused with a sentence, not crash the tab on its way to the reader's own cap.
      const { MAX_TEXT_BYTES } = await import('@caotang/import-read/text');
      const { ARCHIVE_LIMITS } = await import('@caotang/import-read/zip');
      const refusal = htmlSizeRefusal(file.name, file.size, zip ? ARCHIVE_LIMITS.maxArchiveBytes : MAX_TEXT_BYTES);
      if (refusal !== undefined) {
        report({ text: refusal, tone: 'error' });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const source = zip ? htmlZipPreviewSource(file.name, bytes) : htmlPreviewSource(file.name, bytes);
      openImportPreview({ source });
    } catch (failure) {
      failed(file, failure);
    }
  };

  const openEpub = async (file: File): Promise<void> => {
    try {
      const { epubPreviewSource, epubSizeRefusal } = await import('../import-preview/epub-source.js');
      const { ARCHIVE_LIMITS } = await import('@caotang/import-read/zip');
      const refusal = epubSizeRefusal(file.name, file.size, ARCHIVE_LIMITS.maxArchiveBytes);
      if (refusal !== undefined) {
        report({ text: refusal, tone: 'error' });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      openImportPreview({ source: epubPreviewSource(file.name, bytes) });
    } catch (failure) {
      failed(file, failure);
    }
  };

  const openAo3 = async (file: File): Promise<void> => {
    try {
      const { ao3PreviewSource } = await import('../import-preview/ao3-source.js');
      const bytes = new Uint8Array(await file.arrayBuffer());
      openImportPreview({ source: ao3PreviewSource(file.name, bytes) });
    } catch (failure) {
      failed(file, failure);
    }
  };

  const openKanka = async (file: File): Promise<void> => {
    try {
      const { kankaPreviewSource } = await import('../import-preview/kanka-source.js');
      const bytes = new Uint8Array(await file.arrayBuffer());
      openImportPreview({ source: kankaPreviewSource(file.name, bytes) });
    } catch (failure) {
      failed(file, failure);
    }
  };

  const openDocx = async (file: File): Promise<void> => {
    try {
      const { docxPreviewSource } = await import('../import-preview/docx-source.js');
      const bytes = new Uint8Array(await file.arrayBuffer());
      openImportPreview({ source: docxPreviewSource(file.name, bytes) });
    } catch (failure) {
      failed(file, failure);
    }
  };

  const openOdt = async (file: File): Promise<void> => {
    try {
      const { odtPreviewSource } = await import('../import-preview/odt-source.js');
      const bytes = new Uint8Array(await file.arrayBuffer());
      openImportPreview({ source: odtPreviewSource(file.name, bytes) });
    } catch (failure) {
      failed(file, failure);
    }
  };

  const openCsv = async (file: File): Promise<void> => {
    try {
      const { csvPreviewSource } = await import('../import-preview/csv-source.js');
      const bytes = new Uint8Array(await file.arrayBuffer());
      openImportPreview({ source: csvPreviewSource(file.name, bytes) });
    } catch (failure) {
      failed(file, failure);
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
      <button type="button" className="button is-quiet" onClick={() => captionsFile.current?.click()}>
        <Trans>Import captions…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => htmlFile.current?.click()}>
        <Trans>Import HTML…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => epubFile.current?.click()}>
        <Trans>Import EPUB…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => ao3File.current?.click()}>
        <Trans>Import AO3…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => docxFile.current?.click()}>
        <Trans>Import Word…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => odtFile.current?.click()}>
        <Trans>Import OpenDocument…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => csvFile.current?.click()}>
        <Trans>Import spreadsheet…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => kankaFile.current?.click()}>
        <Trans>Import Kanka…</Trans>
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
        ref={captionsFile}
        type="file"
        hidden
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        aria-label={t`Captions file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openCaptions(file);
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
        ref={htmlFile}
        type="file"
        hidden
        accept=".html,.htm,.xhtml,.zip"
        aria-label={t`HTML file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openHtml(file);
        }}
      />
      <input
        ref={epubFile}
        type="file"
        hidden
        accept=".epub,application/epub+zip"
        aria-label={t`EPUB file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openEpub(file);
        }}
      />
      <input
        ref={ao3File}
        type="file"
        hidden
        accept=".html,.htm,.epub"
        aria-label={t`AO3 download`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openAo3(file);
        }}
      />
      <input
        ref={kankaFile}
        type="file"
        hidden
        accept=".zip"
        aria-label={t`Kanka export`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openKanka(file);
        }}
      />
      <input
        ref={docxFile}
        type="file"
        hidden
        accept=".docx,.zip"
        aria-label={t`Word file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openDocx(file);
        }}
      />
      <input
        ref={odtFile}
        type="file"
        hidden
        accept=".odt,.fodt"
        aria-label={t`OpenDocument file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openOdt(file);
        }}
      />
      <input
        ref={csvFile}
        type="file"
        hidden
        accept=".csv,.tsv,.txt"
        aria-label={t`Spreadsheet file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void openCsv(file);
        }}
      />
    </div>
  );
}
