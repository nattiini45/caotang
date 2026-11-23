/**
 * An independent Argon2id reference (RFC 9106), for test vectors only — never shipped, never imported by src.
 * It shares no code with hash-wasm: Blake2b, the variable-length hash H', the compression function G and the
 * Argon2id indexing are written out from the RFC with 64-bit BigInt arithmetic. It is slow, so the suite runs
 * it only at small memory costs; the production parameters are checked against hash-wasm offline.
 *
 * It is pinned two ways: it reproduces the RFC 9106 §5.3 Argon2id vector (both the 64-byte pre-hash H_0 and the
 * 32-byte tag), and hash-wasm agrees with it in the no-secret, no-associated-data mode the adapter uses.
 * hash-wasm exposes no associated-data input, so the RFC vector itself runs through this reference, not the WASM.
 */
const M64 = (1n << 64n) - 1n;
const M32 = (1n << 32n) - 1n;
const IV: bigint[] = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];
const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & M64;

function bG(v: bigint[], a: number, b: number, c: number, d: number, x: bigint, y: bigint): void {
  v[a] = (v[a]! + v[b]! + x) & M64;
  v[d] = rotr(v[d]! ^ v[a]!, 32n);
  v[c] = (v[c]! + v[d]!) & M64;
  v[b] = rotr(v[b]! ^ v[c]!, 24n);
  v[a] = (v[a]! + v[b]! + y) & M64;
  v[d] = rotr(v[d]! ^ v[a]!, 16n);
  v[c] = (v[c]! + v[d]!) & M64;
  v[b] = rotr(v[b]! ^ v[c]!, 63n);
}

function compress(h: bigint[], w: bigint[], t: bigint, last: boolean): void {
  const v = [...h, ...IV];
  v[12] = v[12]! ^ (t & M64);
  v[13] = v[13]! ^ ((t >> 64n) & M64);
  if (last) v[14] = v[14]! ^ M64;
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r]!;
    bG(v, 0, 4, 8, 12, w[s[0]!]!, w[s[1]!]!);
    bG(v, 1, 5, 9, 13, w[s[2]!]!, w[s[3]!]!);
    bG(v, 2, 6, 10, 14, w[s[4]!]!, w[s[5]!]!);
    bG(v, 3, 7, 11, 15, w[s[6]!]!, w[s[7]!]!);
    bG(v, 0, 5, 10, 15, w[s[8]!]!, w[s[9]!]!);
    bG(v, 1, 6, 11, 12, w[s[10]!]!, w[s[11]!]!);
    bG(v, 2, 7, 8, 13, w[s[12]!]!, w[s[13]!]!);
    bG(v, 3, 4, 9, 14, w[s[14]!]!, w[s[15]!]!);
  }
  for (let i = 0; i < 8; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 8]!;
}

function wordsLE(bytes: Uint8Array): bigint[] {
  const w: bigint[] = new Array(16).fill(0n);
  for (let i = 0; i < 16; i++) {
    let x = 0n;
    for (let j = 7; j >= 0; j--) x = (x << 8n) | BigInt(bytes[i * 8 + j] ?? 0);
    w[i] = x;
  }
  return w;
}

function bytesLE(words: bigint[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Number((words[i >> 3]! >> BigInt((i & 7) * 8)) & 0xffn);
  return out;
}

/** Unkeyed BLAKE2b with a digest length of 1..64 bytes (RFC 7693). */
export function blake2b(data: Uint8Array, outLen: number): Uint8Array {
  const h = IV.slice();
  h[0] = h[0]! ^ 0x01010000n ^ BigInt(outLen);
  const len = data.length;
  let t = 0n;
  if (len === 0) {
    compress(h, new Array(16).fill(0n), 0n, true);
  } else {
    for (let pos = 0; pos < len; pos += 128) {
      const chunk = data.subarray(pos, Math.min(pos + 128, len));
      const padded = new Uint8Array(128);
      padded.set(chunk);
      t += BigInt(chunk.length);
      compress(h, wordsLE(padded), t, len - pos <= 128);
    }
  }
  return bytesLE(h, outLen);
}

const le32 = (n: number): Uint8Array => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const cat = (...arrs: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
};

/** The variable-length hash H' (RFC 9106 §3.3). */
export function Hprime(input: Uint8Array, outLen: number): Uint8Array {
  const A = cat(le32(outLen), input);
  if (outLen <= 64) return blake2b(A, outLen);
  const r = Math.ceil(outLen / 32) - 2;
  const out = new Uint8Array(outLen);
  let V = blake2b(A, 64);
  out.set(V.subarray(0, 32), 0);
  for (let i = 2; i <= r; i++) {
    V = blake2b(V, 64);
    out.set(V.subarray(0, 32), (i - 1) * 32);
  }
  out.set(blake2b(V, outLen - 32 * r), r * 32);
  return out;
}

function GB(v: bigint[], a: number, b: number, c: number, d: number): void {
  v[a] = (v[a]! + v[b]! + 2n * (v[a]! & M32) * (v[b]! & M32)) & M64;
  v[d] = rotr(v[d]! ^ v[a]!, 32n);
  v[c] = (v[c]! + v[d]! + 2n * (v[c]! & M32) * (v[d]! & M32)) & M64;
  v[b] = rotr(v[b]! ^ v[c]!, 24n);
  v[a] = (v[a]! + v[b]! + 2n * (v[a]! & M32) * (v[b]! & M32)) & M64;
  v[d] = rotr(v[d]! ^ v[a]!, 16n);
  v[c] = (v[c]! + v[d]! + 2n * (v[c]! & M32) * (v[d]! & M32)) & M64;
  v[b] = rotr(v[b]! ^ v[c]!, 63n);
}

function P(v: bigint[]): void {
  GB(v, 0, 4, 8, 12); GB(v, 1, 5, 9, 13); GB(v, 2, 6, 10, 14); GB(v, 3, 7, 11, 15);
  GB(v, 0, 5, 10, 15); GB(v, 1, 6, 11, 12); GB(v, 2, 7, 8, 13); GB(v, 3, 4, 9, 14);
}

/** The compression function G (RFC 9106 §3.5): two 1024-byte blocks in, one out. */
function G(X: bigint[], Y: bigint[]): bigint[] {
  const R = X.map((x, i) => x ^ Y[i]!);
  const s = R.slice();
  for (let i = 0; i < 8; i++) {
    const row = s.slice(i * 16, i * 16 + 16);
    P(row);
    for (let j = 0; j < 16; j++) s[i * 16 + j] = row[j]!;
  }
  for (let i = 0; i < 8; i++) {
    const idx = [2 * i, 2 * i + 1, 2 * i + 16, 2 * i + 17, 2 * i + 32, 2 * i + 33, 2 * i + 48, 2 * i + 49, 2 * i + 64, 2 * i + 65, 2 * i + 80, 2 * i + 81, 2 * i + 96, 2 * i + 97, 2 * i + 112, 2 * i + 113];
    const col = idx.map((k) => s[k]!);
    P(col);
    for (let j = 0; j < 16; j++) s[idx[j]!] = col[j]!;
  }
  return s.map((x, i) => x ^ R[i]!);
}

const blockFromBytes = (b: Uint8Array): bigint[] => {
  const w: bigint[] = new Array(128);
  for (let i = 0; i < 128; i++) {
    let x = 0n;
    for (let j = 7; j >= 0; j--) x = (x << 8n) | BigInt(b[i * 8 + j]!);
    w[i] = x;
  }
  return w;
};
const blockToBytes = (w: bigint[]): Uint8Array => {
  const o = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) o[i] = Number((w[i >> 3]! >> BigInt((i & 7) * 8)) & 0xffn);
  return o;
};

function indexAlpha(pass: number, slice: number, i: number, q: number, segLen: number, sameLane: boolean, J1: number): number {
  let area: number;
  if (pass === 0) {
    if (slice === 0) area = i - 1;
    else area = sameLane ? slice * segLen + i - 1 : slice * segLen + (i === 0 ? -1 : 0);
  } else {
    area = sameLane ? q - segLen + i - 1 : q - segLen + (i === 0 ? -1 : 0);
  }
  let rel = BigInt(J1 >>> 0);
  rel = (rel * rel) >> 32n;
  rel = BigInt(area) - 1n - ((BigInt(area) * rel) >> 32n);
  const start = pass === 0 ? 0 : slice === 3 ? 0 : (slice + 1) * segLen;
  return (start + Number(rel)) % q;
}

export interface Argon2Options {
  password: Uint8Array;
  salt: Uint8Array;
  secret?: Uint8Array;
  ad?: Uint8Array;
  p: number;
  t: number;
  m: number;
  tagLength: number;
  /** 0 = Argon2d, 1 = Argon2i, 2 = Argon2id (default). */
  type?: number;
}

/** Argon2 (RFC 9106) returning the pre-hash H_0 and the tag, so a vector can pin either. */
export function argon2Reference(options: Argon2Options): { H0: Uint8Array; tag: Uint8Array } {
  const { password, salt, p, t, m, tagLength } = options;
  const secret = options.secret ?? new Uint8Array(0);
  const ad = options.ad ?? new Uint8Array(0);
  const type = options.type ?? 2;
  const H0 = blake2b(
    cat(
      le32(p), le32(tagLength), le32(m), le32(t), le32(0x13), le32(type),
      le32(password.length), password, le32(salt.length), salt,
      le32(secret.length), secret, le32(ad.length), ad,
    ),
    64,
  );
  const mp = 4 * p * Math.floor(m / (4 * p));
  const q = mp / p;
  const segLen = q / 4;
  const B: bigint[][][] = [];
  for (let lane = 0; lane < p; lane++) {
    B[lane] = [];
    B[lane]![0] = blockFromBytes(Hprime(cat(H0, le32(0), le32(lane)), 1024));
    B[lane]![1] = blockFromBytes(Hprime(cat(H0, le32(1), le32(lane)), 1024));
  }
  const zero: bigint[] = new Array(128).fill(0n);
  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      for (let lane = 0; lane < p; lane++) {
        const dataIndep = type === 1 || (type === 2 && pass === 0 && slice < 2);
        let addressBlock: bigint[] | null = null;
        const inputBlock: bigint[] = new Array(128).fill(0n);
        if (dataIndep) {
          inputBlock[0] = BigInt(pass); inputBlock[1] = BigInt(lane); inputBlock[2] = BigInt(slice);
          inputBlock[3] = BigInt(mp); inputBlock[4] = BigInt(t); inputBlock[5] = BigInt(type);
        }
        const startI = pass === 0 && slice === 0 ? 2 : 0;
        const nextAddresses = (): void => {
          inputBlock[6] = inputBlock[6]! + 1n;
          addressBlock = G(zero, G(zero, inputBlock));
        };
        if (dataIndep && startI === 2) nextAddresses();
        for (let i = startI; i < segLen; i++) {
          const j = slice * segLen + i;
          const prev = B[lane]![(j - 1 + q) % q]!;
          let pseudo: bigint;
          if (dataIndep) {
            if (i % 128 === 0) nextAddresses();
            pseudo = addressBlock![i % 128]!;
          } else {
            pseudo = prev[0]!;
          }
          let refLane = Number((pseudo >> 32n) % BigInt(p));
          if (pass === 0 && slice === 0) refLane = lane;
          const sameLane = refLane === lane;
          const refIndex = indexAlpha(pass, slice, i, q, segLen, sameLane, Number(pseudo & M32));
          const computed = G(prev, B[refLane]![refIndex]!);
          if (pass === 0) B[lane]![j] = computed;
          else B[lane]![j] = computed.map((x, k) => x ^ B[lane]![j]![k]!);
        }
      }
    }
  }
  const C = B[0]![q - 1]!.slice();
  for (let lane = 1; lane < p; lane++) for (let k = 0; k < 128; k++) C[k] = C[k]! ^ B[lane]![q - 1]![k]!;
  return { H0, tag: Hprime(blockToBytes(C), tagLength) };
}