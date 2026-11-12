/**
 * Highland 2 / Pro's native `.highland` file is a zip of a customised TextBundle (issue #284). This reader unzips it through
 * the shared archive reader (its size, entry, ratio and path caps), routes the script to the Fountain importer, reads the
 * title from `info.json`, collects the `assets/` pictures and lists what it cannot bring in. Nothing is dropped silently:
 * the bin, the revisions and the planning metadata are named in `losses`. DOM-free, so it runs on the main thread, in the
 * import Worker and in Node; the preview source and command wire it to the dialog later.
 */

import { openZip } from '@caotang/import-read/zip';
import { importFountainScript, type ImportedScript } from '@caotang/screenplay';

/** One picture from the package's `assets/` folder, with its path inside the archive. */
export interface HighlandAsset {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** A `.highland` package read: the Fountain import, its title, its pictures, and what was left behind. */
export interface HighlandImport {
  readonly script: ImportedScript;
  /** The degraded Fountain text, as `screenplay.import` takes it: the preview shows the script, the commit writes this. */
  readonly fountainText: string;
  readonly title: string;
  readonly assets: readonly HighlandAsset[];
  /** The parts not imported, each named for the losses report. */
  readonly losses: readonly string[];
  readonly notices: readonly string[];
}

/** A read, or a refusal flattened to a code and a message so it survives a Worker clone. */
export type HighlandResult =
  | { readonly ok: true; readonly value: HighlandImport }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** The script file a TextBundle carries, in the order Highland writes them. */
const SCRIPT_PATHS = ['text.fountain', 'text.markdown', 'text.txt'] as const;

const decoder = new TextDecoder();

/** Highland's `+highlight+` and `~~strike~~` have no Fountain equivalent: the words stay, the markers go (issue #284). */
function degradeMarkup(text: string): { readonly text: string; readonly changed: boolean } {
  let changed = false;
  const out = text
    .replace(/\+([^+\n]+)\+/g, (_match, words: string) => {
      changed = true;
      return words;
    })
    .replace(/~~([^~\n]+)~~/g, (_match, words: string) => {
      changed = true;
      return words;
    });
  return { text: out, changed };
}

const refusal = (error: { readonly code: string; readonly message: string }): HighlandResult => ({ ok: false, error });

/** Reads a `.highland` package. Never throws for anything about the input: a refusal is `{ ok: false, error }`. */
export async function readHighland(bytes: Uint8Array, fileName = ''): Promise<HighlandResult> {
  const opened = await openZip(bytes);
  if (!opened.ok) return refusal(opened.error);
  const archive = opened.value;

  const scriptPath = SCRIPT_PATHS.find((path) => archive.entry(path) !== undefined);
  if (scriptPath === undefined) {
    return refusal({ code: 'no-script', message: 'a Highland file carries text.fountain, text.markdown or text.txt; this one has none of them' });
  }
  const read = await archive.read(scriptPath);
  if (!read.ok) return refusal(read.error);

  const degraded = degradeMarkup(decoder.decode(read.value));
  const script = importFountainScript(degraded.text);
  const notices: string[] = [...script.notices];
  if (scriptPath !== 'text.fountain') notices.push(`${scriptPath} was read as Fountain; a Markdown reader is not built yet`);
  if (degraded.changed) notices.push('Highland highlight and strikethrough markers were kept as plain text');

  // The title comes from info.json when it has one, else the Fountain title page, else the file name.
  let title = script.titlePage?.Title ?? script.titlePage?.title ?? '';
  let metadata: Record<string, unknown> = {};
  const info = await archive.read('info.json');
  if (info.ok) {
    try {
      const parsed: unknown = JSON.parse(decoder.decode(info.value));
      if (parsed !== null && typeof parsed === 'object') metadata = parsed as Record<string, unknown>;
    } catch {
      notices.push('info.json could not be read; the title falls back to the script');
    }
  }
  if (typeof metadata.title === 'string' && metadata.title !== '') title = metadata.title;
  if (title === '') title = fileName.replace(/\.highland$/i, '') || 'Untitled';

  // The pictures ride along as bytes; the caller stores them through the picture pipeline.
  const assetEntries = archive.entries.filter((entry) => entry.path.startsWith('assets/') && entry.size > 0);
  const assets: HighlandAsset[] = [];
  if (assetEntries.length > 0) {
    const got = await archive.readMany(assetEntries.map((entry) => entry.path));
    if (!got.ok) return refusal(got.error);
    for (const entry of assetEntries) {
      const data = got.value.get(entry.path);
      if (data !== undefined) assets.push({ path: entry.path, bytes: data });
    }
  }

  // What Highland keeps that Caotang does not import is named, never dropped silently.
  const losses: string[] = [];
  const bin = archive.entries.filter((entry) => entry.path.startsWith('bin/') && entry.size > 0);
  if (bin.length > 0) losses.push(`bin/ (${bin.length} file${bin.length === 1 ? '' : 's'}) not imported`);
  const revisions = archive.entries.filter((entry) => entry.path.startsWith('revisions/') && entry.size > 0);
  if (revisions.length > 0) losses.push(`revisions/ (${revisions.length} file${revisions.length === 1 ? '' : 's'}) not imported`);
  const planning = ['sprints', 'milestones'].filter((key) => metadata[key] !== undefined);
  if (planning.length > 0) losses.push(`${planning.join(' and ')} not imported`);

  return { ok: true, value: { script, fountainText: degraded.text, title, assets, losses, notices } };
}
