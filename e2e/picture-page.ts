/**
 * Page-side helpers for e2e/picture-transcoder.spec.ts. The spec imports this file into the page from the dev server, so it
 * runs in the browser, beside the app's own transcoder: it paints test pictures on a real canvas, writes EXIF orientation
 * into a JPEG, and reads pixels back from whatever the transcoder returned.
 */

export type Rgb = readonly [number, number, number];

export const RED: Rgb = [255, 0, 0];
export const GREEN: Rgb = [0, 255, 0];
export const BLUE: Rgb = [0, 0, 255];
export const YELLOW: Rgb = [255, 255, 0];
export const GRAY: Rgb = [128, 128, 128];

type Draw = (context: OffscreenCanvasRenderingContext2D) => void;

export async function paint(width: number, height: number, type: 'image/png' | 'image/jpeg', draw: Draw): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no canvas');
  draw(context);
  return new Uint8Array(await (await canvas.convertToBlob({ type, quality: 0.95 })).arrayBuffer());
}

/** `columns` x `rows` blocks of `cell` pixels: red top left, green top right, blue bottom left, yellow bottom right, grey between. */
export function paintCorners(columns: number, rows: number, cell: number, type: 'image/png' | 'image/jpeg'): Promise<Uint8Array> {
  const width = columns * cell;
  const height = rows * cell;
  return paint(width, height, type, (context) => {
    context.fillStyle = 'rgb(128,128,128)';
    context.fillRect(0, 0, width, height);
    const block = (color: Rgb, x: number, y: number): void => {
      context.fillStyle = `rgb(${color.join(',')})`;
      context.fillRect(x, y, cell, cell);
    };
    block(RED, 0, 0);
    block(GREEN, width - cell, 0);
    block(BLUE, 0, height - cell);
    block(YELLOW, width - cell, height - cell);
  });
}

/** A little-endian TIFF with one entry, Orientation, in an APP1 segment straight after SOI. */
export function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = payload.length + 2;
  const segment = Uint8Array.from([0xff, 0xe1, length >> 8, length & 255, ...payload]);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2));
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

export interface Sampled {
  readonly width: number;
  readonly height: number;
  readonly colors: readonly (readonly number[])[];
}

/** The picture's size, and the RGBA at each point, read back through the browser's own decoder. */
export async function sample(bytes: Uint8Array, points: readonly (readonly [number, number])[]): Promise<Sampled> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no canvas');
  context.drawImage(bitmap, 0, 0);
  const colors = points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
  const result = { width: bitmap.width, height: bitmap.height, colors };
  bitmap.close();
  return result;
}

export interface Caught {
  readonly name: string;
  readonly code: string | undefined;
  readonly message: string;
  readonly remedy: string | undefined;
}

/** What a refusal looks like on the other side of `page.evaluate`: its fields, not its class. */
export async function caught(run: () => Promise<unknown>): Promise<Caught | undefined> {
  try {
    await run();
  } catch (error) {
    const e = error as { name?: string; code?: string; message?: string; remedy?: string };
    return { name: e.name ?? '', code: e.code, message: e.message ?? '', remedy: e.remedy };
  }
  return undefined;
}
