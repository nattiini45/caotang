/**
 * Where a compiled file goes (desktop.md §Native save). The exporter makes the bytes and the name; the shell shows the operating
 * system's own Save dialog and writes once; the browser keeps its download. The page decides nothing about the place, and nothing
 * is written when the writer cancels.
 *
 * The bytes are the exporter's own, exactly as the download path takes them: `ProjectSession.readExport` reads each artifact the
 * way `ExportStore` holds it, and that store's `isBinaryPath` list decides text from bytes — a Markdown export is text encoded as
 * UTF-8, and a DOCX, EPUB, XLSX or PDF is the bytes as made.
 */

import { downloadBytes } from './download.js';
import { osBridge } from './native-os.js';

/** What became of the file: written where the writer chose, cancelled at the dialog, or not written for a reason. */
export type SaveOutcome = 'saved' | 'cancelled' | 'unavailable';

export async function saveExportFile(bytes: Uint8Array, name: string, mime: string): Promise<SaveOutcome> {
  const bridge = osBridge();
  if (bridge === undefined) {
    downloadBytes(bytes, name, mime);
    return 'saved';
  }
  const reply = await bridge.saveFile({ name, bytes }).catch(() => null);
  if (reply === null) return 'unavailable';
  if (!reply.ok) return 'unavailable';
  return reply.value.saved ? 'saved' : 'cancelled';
}
