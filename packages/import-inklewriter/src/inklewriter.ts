/**
 * The Inklewriter JSON reader (issue #286). Inklewriter stories export as JSON; inkle's MIT converter (vendored as
 * inklewriter-convert.ts) turns one into Ink, and the shared whole-story planner (`planInkImport`, `@caotang/dialogue`)
 * turns that Ink into containers. This wrapper is the typed, checked surface over the vendored converter: it parses the
 * JSON, refuses anything that is not a story, never lets the converter's throws escape, lists the stitch images by URL
 * (the import never fetches them; downloading is opt-in, Decision 10) and names the editor data it cannot bring in.
 * DOM-free, no eval and no network, so it runs on the main thread, in the import Worker and in Node; the preview source
 * and command wire it to the dialog later.
 */

import { planInkImport, type InkImportPlan } from '@caotang/dialogue';
import { convert } from './inklewriter-convert.js';

/** The converter's own JSON shape, taken from its signature so the vendored file stays the single source of it. */
type InklewriterJSON = Parameters<typeof convert>[0];

/** One stitch image, listed by its URL; the import never fetches it (Decision 10). */
export interface InklewriterImage {
  readonly url: string;
  readonly stitch: string;
}

/** An Inklewriter story read: the Ink import plan, the Ink text, its title, its images, and what was left behind. */
export interface InklewriterImport {
  readonly plan: InkImportPlan;
  readonly ink: string;
  readonly title: string;
  readonly images: readonly InklewriterImage[];
  /** The parts not imported, each named for the losses report. */
  readonly losses: readonly string[];
  readonly notices: readonly string[];
}

/** A read, or a refusal flattened to a code and a message so it survives a Worker clone. */
export type InklewriterResult =
  | { readonly ok: true; readonly value: InklewriterImport }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const decoder = new TextDecoder();

const refusal = (error: { readonly code: string; readonly message: string }): InklewriterResult => ({ ok: false, error });

/** The fields the converter reads before it can do anything; a JSON missing them is not an Inklewriter story. */
function isInklewriter(value: unknown): value is InklewriterJSON {
  if (value === null || typeof value !== 'object') return false;
  const data = (value as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return false;
  const stitches = (data as { stitches?: unknown }).stitches;
  return (
    typeof (value as { title?: unknown }).title === 'string' &&
    typeof (data as { initial?: unknown }).initial === 'string' &&
    stitches !== null &&
    typeof stitches === 'object'
  );
}

/** The images each stitch carries, in story order, by URL. */
function collectImages(json: InklewriterJSON): InklewriterImage[] {
  const images: InklewriterImage[] = [];
  for (const name of Object.keys(json.data.stitches)) {
    const stitch = json.data.stitches[name];
    if (stitch === undefined || !Array.isArray(stitch.content)) continue;
    for (const item of stitch.content) {
      if (item !== null && typeof item === 'object' && typeof (item as { image?: unknown }).image === 'string') {
        images.push({ url: (item as { image: string }).image, stitch: name });
      }
    }
  }
  return images;
}

/** Reads an Inklewriter JSON export. Never throws for anything about the input: a refusal is `{ ok: false, error }`. */
export function readInklewriter(bytes: Uint8Array, fileName = ''): InklewriterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return refusal({ code: 'not-json', message: 'the file is not JSON; an Inklewriter export is a .json story' });
  }
  if (!isInklewriter(parsed)) {
    return refusal({ code: 'not-inklewriter', message: 'the JSON is not an Inklewriter story: it has no title, data.initial and stitches' });
  }

  let ink: string;
  try {
    // terminateAllLooseEnds: a stitch that leads nowhere ends the story rather than falling off it.
    ink = convert(parsed, true);
  } catch (error) {
    return refusal({ code: 'convert-failed', message: error instanceof Error ? error.message : String(error) });
  }

  const plan = planInkImport(ink);
  const images = collectImages(parsed);
  const title = parsed.title !== '' ? parsed.title : fileName.replace(/\.json$/i, '') || 'Untitled';

  // Inklewriter keeps the editor's layout (where each stitch sat on the page); Caotang has no place for it.
  const losses = ['Inklewriter editor data (stitch positions) not imported'];
  const notices: string[] = [];
  if (images.length > 0) {
    notices.push(`${images.length} image${images.length === 1 ? '' : 's'} listed by URL; downloading is opt-in`);
  }

  return { ok: true, value: { plan, ink, title, images, losses, notices } };
}
