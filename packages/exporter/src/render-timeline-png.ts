/**
 * The timeline's *Save image* (PNG) — timeline.md §8: a browser-only action on the view, not a compile format. The
 * view serializes its own SVG (the same geometry as `timeline-svg`) and hands it here; this file rasterizes it on an
 * offscreen canvas and returns the PNG blob for the download.
 *
 * The raster is bounded: the SVG's own size is scaled down to a maximum side, so a 2,000-scene timeline cannot ask
 * for a 100,000-pixel canvas. Before drawing, the document's fonts are awaited (`document.fonts.ready`) and every
 * image the SVG references is resolved through `resolveImage` and inlined as a data URL, so the raster does not
 * depend on the SVG's URL staying alive or on a network fetch. A host without a canvas — Node, the CLI, the MCP
 * server — gets a clear refusal, never a half-drawn file: PNG export is the app's, and the compile formats
 * (`timeline-svg`, `timeline-pdf`) are the headless path.
 */

/** The longest side the raster is allowed, in pixels. */
export const PNG_MAX_SIDE = 4096;

/** The PNG's MIME type. */
export const PNG_MIME = 'image/png';

export interface RasterizeSvgOptions {
  /** The longest side of the output, in pixels. Absent is {@link PNG_MAX_SIDE}. */
  readonly maxSide?: number;
  /** The background the canvas is filled with before the SVG is drawn. Absent is white. */
  readonly background?: string;
  /**
   * Resolves one image the SVG references (an `href` or `xlink:href`) to the bytes to inline, or `null` to leave the
   * reference as it is. The view passes a resolver over the project's stored pictures; without one, an SVG that
   * references external images rasterizes with those images missing.
   */
  readonly resolveImage?: (href: string) => Promise<Blob | null>;
}

/** Reads the `width`/`height` (or `viewBox`) of an SVG document's root, as the raster's intrinsic size. */
export function svgIntrinsicSize(svg: string): { readonly width: number; readonly height: number } {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const attr = (name: string): string | undefined => new RegExp(`${name}="([^"]+)"`, 'i').exec(root)?.[1];
  const px = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const viewBox = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(attr('viewBox') ?? '');
  const width = px(attr('width')) ?? px(viewBox?.[3]);
  const height = px(attr('height')) ?? px(viewBox?.[4]);
  if (width === undefined || height === undefined) {
    throw new Error('the SVG has no readable width and height, so its size cannot be bounded');
  }
  return { width, height };
}

/** Inlines every external image reference as a data URL, through the resolver, so the raster needs no network. */
async function inlineImages(svg: string, resolveImage: (href: string) => Promise<Blob | null>): Promise<string> {
  const hrefs = [...new Set([...svg.matchAll(/(?:xlink:)?href="([^"]+)"/g)].map((match) => match[1] ?? '').filter((href) => !href.startsWith('data:')))];
  let out = svg;
  for (const href of hrefs) {
    const blob = await resolveImage(href).catch(() => null);
    if (blob === null) continue;
    const dataUrl = `data:${blob.type || 'application/octet-stream'};base64,${await blobToBase64(blob)}`;
    out = out.split(`href="${href}"`).join(`href="${dataUrl}"`);
  }
  return out;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  return btoa(binary);
}

/**
 * Rasterizes an SVG string to a PNG blob, in the browser only. Throws a plain error with the reason when the host
 * has no canvas or the SVG cannot be drawn — a *Save image* that cannot be made says so, and writes nothing.
 */
export async function rasterizeSvgToPng(svg: string, options: RasterizeSvgOptions = {}): Promise<Blob> {
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined') {
    throw new Error('PNG export draws on a browser canvas, and this host has none: use the timeline-svg or timeline-pdf compile format instead');
  }
  const maxSide = options.maxSide ?? PNG_MAX_SIDE;
  const { width, height } = svgIntrinsicSize(svg);
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const source = options.resolveImage === undefined ? svg : await inlineImages(svg, options.resolveImage);
  // The document's fonts are awaited so a webfont the SVG names is in the raster, not a fallback.
  await document.fonts?.ready?.catch(() => undefined);

  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('the timeline SVG could not be decoded for the image export'));
      element.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('this browser gave no 2D canvas context, so the image export cannot be drawn');
    ctx.fillStyle = options.background ?? '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(image, 0, 0, outW, outH);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, PNG_MIME));
    if (blob === null) throw new Error('the canvas produced no PNG bytes, so the image export cannot be saved');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
