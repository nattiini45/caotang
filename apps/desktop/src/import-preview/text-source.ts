/**
 * **Import plain text…** through the shared preview (import-core.md §7.1, issue #283): the plain-text reader
 * (`@caotang/import-read/text`) decodes the file and builds its blocks, and the splitter source shows them. The encoding (when it
 * is a guess) and the paragraph mode are the reader's chips: a change decodes or re-reads the text, and a rule chip re-runs only the
 * splitter. Nothing is written until Import, which commits one `binder.importTree`.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts, #390), so a large file never blocks the main thread. The
 * bytes are handed to the Worker once; an encoding or paragraph change re-reads the Worker's cached copy. The splitter stays on the
 * main thread, where it re-runs on every rule chip.
 *
 * Loaded on first use by the Import plain text action (ManuscriptImport.tsx), with the reader host and the splitter, so the first
 * load carries neither.
 */
/* lingui-set comment="The plain-text import. Interpolated values: file (the file's name), size and limit (megabytes or lines), encoding (an encoding's name, such as Windows-1252)" */

import { t } from '@lingui/core/macro';
import { MAX_TEXT_BYTES, MAX_TEXT_LINES, type ParagraphMode } from '@caotang/import-read/text';
import { encodingName, type DecodableEncoding } from '@caotang/store/encoding';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewChip, PreviewReportList, PreviewSettings } from './model.js';
import { ReaderHost } from './reader-host.js';
import { splitterPreviewSource, type ReaderDocument } from './splitter-source.js';

export const TEXT_CHIPS = { encoding: 'encoding', paragraphs: 'paragraphs' } as const;

export type TextImportOpening = { readonly ok: true; readonly source: ImportPreviewSource } | { readonly ok: false; readonly message: string };

/** An encoding's name as the chip shows it. */
export function encodingLabel(encoding: DecodableEncoding): string {
  return encoding === 'utf-8' ? 'UTF-8' : encodingName(encoding);
}

const ENCODINGS: readonly DecodableEncoding[] = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'iso-8859-15', 'gb18030', 'big5', 'shift_jis', 'euc-kr'];

function isEncoding(value: string | undefined): value is DecodableEncoding {
  return value !== undefined && (ENCODINGS as readonly string[]).includes(value);
}

/** Why a file of this size is not read at all, before its bytes are loaded; undefined when the reader takes it. */
export function plainTextSizeRefusal(fileName: string, size: number): string | undefined {
  if (size <= MAX_TEXT_BYTES) return undefined;
  return t`${{ file: fileName }} is too large to import as plain text: the import reads files up to ${{ limit: formatCount(MAX_TEXT_BYTES / (1024 * 1024)) }} MB.`;
}

/** What the first read found: the encoding to preselect, whether it is a guess, the picker's choices and the detected paragraph mode. */
interface FirstDecode {
  readonly suggested: DecodableEncoding;
  readonly guessed: boolean;
  readonly choices: readonly DecodableEncoding[];
  readonly detected: ParagraphMode;
}

/**
 * Opens a plain-text file for the preview. The first read happens in the Worker when the dialog loads; a file past the reader's caps,
 * or in no encoding it can name, fails the load with a message. An encoding it guessed is a chip the writer can change.
 */
export function plainTextPreviewSource(fileName: string, bytes: Uint8Array): TextImportOpening {
  if (bytes.length > MAX_TEXT_BYTES) return { ok: false, message: plainTextSizeRefusal(fileName, bytes.length) ?? '' };

  const host = new ReaderHost();
  const cache = new Map<string, ReaderDocument>();
  let first: FirstDecode | null = null;
  let shownEncoding: DecodableEncoding = 'utf-8';

  const encodingOf = (settings: PreviewSettings): DecodableEncoding => {
    const chosen = settings.chips[TEXT_CHIPS.encoding];
    return isEncoding(chosen) ? chosen : (first?.suggested ?? 'utf-8');
  };
  const paragraphsOf = (settings: PreviewSettings): ParagraphMode => {
    const chosen = settings.chips[TEXT_CHIPS.paragraphs];
    return chosen === 'line' ? 'line' : chosen === 'blank' ? 'blank' : (first?.detected ?? 'blank');
  };
  const keyOf = (settings: PreviewSettings): string => `${encodingOf(settings)}|${paragraphsOf(settings)}`;

  const load = async (progress: (text: string) => void, signal: AbortSignal): Promise<void> => {
    progress(t`Reading ${{ file: fileName }}…`);
    await host.open({ kind: 'open', reader: 'text', bytes }, signal);
    const reply = await host.read({ kind: 'read', reader: 'text', fileName }, signal);
    if (reply.kind !== 'text') throw new Error(t`The file could not be read as plain text.`);
    const result = reply.result;
    if (result.status === 'too-large') throw new Error(plainTextSizeRefusal(fileName, result.bytes) ?? '');
    if (result.status === 'too-many-lines') {
      throw new Error(t`${{ file: fileName }} has more lines than a plain-text import splits: at most ${{ limit: formatCount(MAX_TEXT_LINES) }}.`);
    }

    let suggested: DecodableEncoding;
    let guessed: boolean;
    let choices: readonly DecodableEncoding[];
    let detected: ParagraphMode;
    let doc: ReaderDocument;
    if (result.status === 'ask') {
      suggested = result.suggested ?? 'utf-8';
      if (result.suggested === undefined) {
        throw new Error(t`Caotang cannot tell which encoding ${{ file: fileName }} is in, so it cannot import it.`);
      }
      guessed = true;
      choices = [...new Set([suggested, ...result.detection.candidates.map((candidate) => candidate.encoding)])];
      const second = await host.read({ kind: 'read', reader: 'text', encoding: suggested, fileName }, signal);
      if (second.kind !== 'text' || second.result.status !== 'read') {
        throw new Error(t`The file cannot be read as ${{ encoding: encodingLabel(suggested) }}. Choose another encoding.`);
      }
      detected = second.result.detectedParagraphs;
      doc = { doc: second.result.doc };
    } else {
      suggested = result.encoding;
      guessed = result.guessed;
      choices = guessed ? [...new Set([suggested, ...result.candidates.map((candidate) => candidate.encoding)])] : [];
      detected = result.detectedParagraphs;
      doc = { doc: result.doc };
    }
    first = { suggested, guessed, choices, detected };
    shownEncoding = suggested;
    cache.set(`${suggested}|${detected}`, doc);
  };

  const readerChips = (): PreviewChip[] => {
    if (first === null) return [];
    return [
      ...(first.choices.length === 0
        ? []
        : [{ id: TEXT_CHIPS.encoding, label: t`Encoding`, value: first.suggested, options: first.choices.map((encoding) => ({ value: encoding, label: encodingLabel(encoding) })) }]),
      {
        id: TEXT_CHIPS.paragraphs,
        label: t`Paragraphs`,
        value: first.detected,
        options: [
          { value: 'blank', label: t`Separated by blank lines` },
          { value: 'line', label: t`One line each` },
        ],
      },
    ];
  };

  const prepare = async (settings: PreviewSettings, signal: AbortSignal): Promise<void> => {
    const key = keyOf(settings);
    if (cache.has(key)) return;
    const encoding = encodingOf(settings);
    const reply = await host.read({ kind: 'read', reader: 'text', encoding, paragraphs: paragraphsOf(settings), fileName }, signal);
    if (reply.kind === 'text' && reply.result.status === 'read') cache.set(key, { doc: reply.result.doc });
    else cache.set(key, { doc: { blocks: [] }, losses: [{ message: t`The file cannot be read as ${{ encoding: encodingLabel(encoding) }}. Choose another encoding.` }] });
  };

  const report = (): PreviewReportList[] => {
    if (first === null || !first.guessed) return [];
    const label = t`Encoding`;
    return [{ heading: label, label, lines: [t`The file is read as ${{ encoding: encodingLabel(shownEncoding) }}, a guess. If letters look wrong in the text, choose another encoding.`] }];
  };

  return {
    ok: true,
    source: splitterPreviewSource({
      fileName,
      readerChips,
      load,
      prepare,
      prepared: (settings) => cache.has(keyOf(settings)),
      dispose: () => host.dispose(),
      read: (settings) => {
        shownEncoding = encodingOf(settings);
        return cache.get(keyOf(settings)) ?? { doc: { blocks: [] } };
      },
      readKey: keyOf,
      report,
    }),
  };
}
