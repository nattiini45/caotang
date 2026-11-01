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

  return (
    <div className="script-import" role="group" aria-label={t`Import a manuscript`}>
      <button type="button" className="button is-quiet" onClick={() => textFile.current?.click()}>
        <Trans>Import plain text…</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => rtfFile.current?.click()}>
        <Trans>Import RTF…</Trans>
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
    </div>
  );
}
