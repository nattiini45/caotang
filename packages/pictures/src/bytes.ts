export function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (offset < 0 || offset + signature.length > bytes.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

export function u16(bytes: Uint8Array, at: number, little: boolean): number {
  const a = bytes[at] ?? 0;
  const b = bytes[at + 1] ?? 0;
  return little ? a | (b << 8) : (a << 8) | b;
}

export function u32(bytes: Uint8Array, at: number, little: boolean): number {
  const a = bytes[at] ?? 0;
  const b = bytes[at + 1] ?? 0;
  const c = bytes[at + 2] ?? 0;
  const d = bytes[at + 3] ?? 0;
  return (little ? (a | (b << 8) | (c << 16) | (d << 24)) : ((a << 24) | (b << 16) | (c << 8) | d)) >>> 0;
}

export function writeU16(bytes: Uint8Array, at: number, value: number, little: boolean): void {
  const hi = (value >>> 8) & 0xff;
  const lo = value & 0xff;
  bytes[at] = little ? lo : hi;
  bytes[at + 1] = little ? hi : lo;
}

export function writeU32(bytes: Uint8Array, at: number, value: number, little: boolean): void {
  const b = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  if (little) b.reverse();
  for (let i = 0; i < 4; i += 1) bytes[at + i] = b[i] ?? 0;
}

export function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[at + i] ?? 0);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

let crcTable: Uint32Array | undefined;

export function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = (crcTable[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
