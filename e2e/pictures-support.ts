/**
 * Helpers the picture specs share: real PNGs of one colour, a large photograph drawn in the page, the registry as the hook reports it,
 * the synthetic drop and paste, and the Undo of the latest activity row. Not a spec file: it is imported, never run.
 */

import { deflateSync } from 'node:zlib';

import { type Locator, type Page } from '@playwright/test';

export interface PictureRegistry {
  readonly records: readonly { id: string; file: string; bytes: number; width: number | null; height: number | null; caption: string | null; tags: readonly string[]; workingCopy: boolean }[];
  readonly links: readonly { id: string; assetId: string; role: string; kind: string; nodeId: string | null; note: string | null }[];
}

export async function registry(page: Page): Promise<PictureRegistry> {
  return page.evaluate(() => {
    const hook = (globalThis as unknown as { __caotang?: { pictures(): unknown } }).__caotang;
    return hook?.pictures() as PictureRegistry;
  });
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** A solid-colour PNG, so two colours are two different pictures and the same colour is the same one. */
export function solidPng([red, green, blue]: readonly [number, number, number], width = 8, height = 6): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [red, green, blue]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const RED = { name: 'red.png', mimeType: 'image/png', buffer: solidPng([200, 30, 30]) };
export const BLUE = { name: 'blue.png', mimeType: 'image/png', buffer: solidPng([30, 30, 200]) };
export const GREEN = { name: 'green.png', mimeType: 'image/png', buffer: solidPng([30, 200, 30]) };

/** A flat-colour JPEG of more than 24 megapixels, drawn on a canvas: small on disk, large for the decision. */
export async function bigPhoto(page: Page, name: string, color: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const base64 = await page.evaluate(async (fill) => {
    const canvas = document.createElement('canvas');
    canvas.width = 6000;
    canvas.height = 4200;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d canvas');
    context.fillStyle = fill;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.4));
    if (blob === null) throw new Error('the canvas gave no picture');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(text);
  }, color);
  return { name, mimeType: 'image/jpeg', buffer: Buffer.from(base64, 'base64') };
}

export async function undoLatest(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByRole('list', { name: 'Activity' }).getByRole('listitem').first().getByRole('button', { name: 'Undo' }).click();
}

export interface Sent {
  readonly name: string;
  readonly type: string;
  readonly bytes: Buffer;
}

export async function send(target: Locator, gesture: 'drop' | 'paste', files: readonly Sent[]): Promise<{ cancelled: boolean }> {
  return target.evaluate(
    (element, input) => {
      const data = new DataTransfer();
      for (const file of input.files) data.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: file.type }));
      if (data.files.length !== input.files.length) throw new Error('the DataTransfer lost a file');
      if (input.gesture === 'paste') {
        return { cancelled: !element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })) };
      }
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      return { cancelled: !element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })) };
    },
    { gesture, files: files.map((file) => ({ name: file.name, type: file.type, bytes: [...file.bytes] })) },
  );
}

export const asSent = (file: { name: string; mimeType: string; buffer: Buffer }): Sent => ({ name: file.name, type: file.mimeType, bytes: file.buffer });
