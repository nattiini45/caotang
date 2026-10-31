/**
 * The timeline's *Save image* (timeline.md §8): a browser-only PNG of the timeline, not a compile format.
 *
 * The drawing is `renderTimelineSvg`, the same one `timeline-svg` compiles, rather than the view's own `<svg>`. The view's SVG is
 * windowed to what is on screen, carries its colours in stylesheet classes and leaves the chips to HTML cells, so serializing it
 * would save a clipped, unstyled picture. The exporter's drawing is the whole selection, self-contained, and follows the project
 * language's direction, which is the geometry the view and the SVG share. `rasterizeSvgToPng` bounds the raster.
 */
/* lingui-set comment="The timeline's Save image." */

import { t } from '@lingui/core/macro';
import type { rasterizeSvgToPng, renderTimelineSvg } from '@caotang/exporter';
import type { ProjectState } from '@caotang/store';

import { downloadBytes } from './download.js';

/** The seams the action touches, so a test drives it without a canvas or a download. */
export interface TimelineImageDeps {
  readonly exporter: () => Promise<{ readonly renderTimelineSvg: typeof renderTimelineSvg; readonly rasterizeSvgToPng: typeof rasterizeSvgToPng }>;
  readonly download: (bytes: Uint8Array, filename: string, mime: string) => void;
}

const DEFAULTS: TimelineImageDeps = {
  // Through the exporter's lazy module, not the package: a dynamic import of the whole package keeps every renderer in the chunk the page loads.
  exporter: () => import('./lazy-exporter.js'),
  download: downloadBytes,
};

export interface TimelineImageRequest {
  readonly state: ProjectState;
  /** The folder the view is narrowed to, or null for the whole manuscript. */
  readonly scopeId: string | null;
}

export type TimelineImageOutcome =
  | { readonly ok: true; readonly filename: string }
  | { readonly ok: false; readonly message: string };

/** A file name stem the platforms accept: the characters a file name cannot carry are replaced. */
function stemOf(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '-').trim();
  return cleaned === '' ? 'timeline' : cleaned;
}

/** The PNG's file name, beside the `(timeline).svg` and `(timeline).pdf` the compile writes. */
export function timelineImageName(state: ProjectState): string {
  return `${stemOf(state.manifest.project.name)} (timeline).png`;
}

/** Draws the timeline, rasterizes it and hands the PNG to the browser's download. Never throws: a failure is a whole sentence. */
export async function saveTimelineImage(request: TimelineImageRequest, deps: TimelineImageDeps = DEFAULTS): Promise<TimelineImageOutcome> {
  const { state, scopeId } = request;
  const language = state.manifest.project.language;
  try {
    const exporter = await deps.exporter();
    const drawing = exporter.renderTimelineSvg({
      state,
      includeRootIds: scopeId === null ? ['manuscript'] : [scopeId],
      ...(language === undefined || language === '' ? {} : { language }),
    });
    if (drawing.chips === 0) {
      return { ok: false, message: t`There is no scene in this part of the timeline, so there is no image to save. Choose a different scope and try again.` };
    }
    const png = await exporter.rasterizeSvgToPng(drawing.svg);
    const bytes = new Uint8Array(await png.arrayBuffer());
    if (bytes.byteLength === 0) {
      return { ok: false, message: t`The browser drew an empty image, so nothing was saved. Try again, or compile the timeline as SVG from the export dialog.` };
    }
    const filename = timelineImageName(state);
    deps.download(bytes, filename, png.type === '' ? 'image/png' : png.type);
    return { ok: true, filename };
  } catch {
    return {
      ok: false,
      message: t`The browser could not draw the timeline as an image, so nothing was saved. Try again, or compile the timeline as SVG from the export dialog.`,
    };
  }
}
