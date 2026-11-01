/**
 * **Import plain text…** through the shared preview (import-core.md §7.1, issue #283): the plain-text reader
 * (`@caotang/import-read/text`) decodes the file and builds its blocks, and the splitter source shows them. The encoding (when it
 * is a guess) and the paragraph mode are the reader's chips: a change decodes or re-reads the text, and a rule chip re-runs only the
 * splitter. Nothing is written until Import, which commits one `binder.importTree`.
 *
 * Loaded on first use by the Import plain text action (ManuscriptImport.tsx), with the reader and the splitter, so the first load
 * carries neither.
 */
/* lingui-set comment="The plain-text import. Interpolated values: file (the file's name), size and limit (megabytes or lines), encoding (an encoding's name, such as Windows-1252)" */

import { t } from '@lingui/core/macro';
import { MAX_TEXT_BYTES, MAX_TEXT_LINES, decodePlainText, plainTextBlocks, type ParagraphMode } from '@caotang/import-read/text';
import { encodingName, type DecodableEncoding } from '@caotang/store/encoding';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewChip, PreviewReportList, PreviewSettings } from './model.js';
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

/**
 * Opens a plain-text file for the preview, or says why it cannot: larger than the reader takes, more lines than it splits, or in no
 * encoding it can name. An encoding it guessed is a chip the writer can change, preselected with the guess.
 */
export function plainTextPreviewSource(fileName: string, bytes: Uint8Array): TextImportOpening {
  const first = decodePlainText(bytes);
  if (first.status === 'too-large') return { ok: false, message: plainTextSizeRefusal(fileName, first.bytes) ?? '' };
  if (first.status === 'too-many-lines') {
    return { ok: false, message: t`${{ file: fileName }} has more lines than a plain-text import splits: at most ${{ limit: formatCount(MAX_TEXT_LINES) }}.` };
  }
  const suggested = first.status === 'decoded' ? first.encoding : first.suggested;
  if (suggested === undefined) return { ok: false, message: t`Caotang cannot tell which encoding ${{ file: fileName }} is in, so it cannot import it.` };
  const guessed = first.status === 'ask' || first.guessed;
  const candidates = (first.status === 'decoded' ? first.candidates : first.detection.candidates).map((candidate) => candidate.encoding);
  const choices = guessed ? [...new Set([suggested, ...candidates])] : [];

  const decoded = new Map<DecodableEncoding, string | null>();
  if (first.status === 'decoded') decoded.set(first.encoding, first.text);
  const textIn = (encoding: DecodableEncoding): string | null => {
    const held = decoded.get(encoding);
    if (held !== undefined) return held;
    const read = decodePlainText(bytes, { encoding });
    const text = read.status === 'decoded' ? read.text : null;
    decoded.set(encoding, text);
    return text;
  };
  const encodingOf = (settings: PreviewSettings): DecodableEncoding => {
    const chosen = settings.chips[TEXT_CHIPS.encoding];
    return isEncoding(chosen) ? chosen : suggested;
  };
  const firstText = textIn(suggested);
  const detected: ParagraphMode = firstText === null ? 'blank' : plainTextBlocks(firstText, { fileName }).detectedParagraphs;
  const paragraphsOf = (settings: PreviewSettings): ParagraphMode => (settings.chips[TEXT_CHIPS.paragraphs] === 'line' ? 'line' : settings.chips[TEXT_CHIPS.paragraphs] === 'blank' ? 'blank' : detected);

  const readerChips = (): PreviewChip[] => [
    ...(choices.length === 0
      ? []
      : [{ id: TEXT_CHIPS.encoding, label: t`Encoding`, value: suggested, options: choices.map((encoding) => ({ value: encoding, label: encodingLabel(encoding) })) }]),
    {
      id: TEXT_CHIPS.paragraphs,
      label: t`Paragraphs`,
      value: detected,
      options: [
        { value: 'blank', label: t`Separated by blank lines` },
        { value: 'line', label: t`One line each` },
      ],
    },
  ];

  const read = (settings: PreviewSettings): ReaderDocument => {
    const encoding = encodingOf(settings);
    const text = textIn(encoding);
    if (text === null) {
      return { doc: { blocks: [] }, losses: [{ message: t`The file cannot be read as ${{ encoding: encodingLabel(encoding) }}. Choose another encoding.` }] };
    }
    return { doc: plainTextBlocks(text, { fileName, paragraphs: paragraphsOf(settings) }).doc };
  };

  let shownEncoding: DecodableEncoding = suggested;
  const report = (): PreviewReportList[] => {
    if (!guessed) return [];
    const label = t`Encoding`;
    return [{ heading: label, label, lines: [t`The file is read as ${{ encoding: encodingLabel(shownEncoding) }}, a guess. If letters look wrong in the text, choose another encoding.`] }];
  };

  return {
    ok: true,
    source: splitterPreviewSource({
      fileName,
      readerChips,
      read: (settings) => {
        shownEncoding = encodingOf(settings);
        return read(settings);
      },
      readKey: (settings) => `${encodingOf(settings)}|${paragraphsOf(settings)}`,
      report,
    }),
  };
}
