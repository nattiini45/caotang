/**
 * The picture registry's data model — pictures.md §2.1. Types only, plus the closed lists the readers and
 * validators check against. Nothing here imports the store, the editor or a codec; the store depends on
 * this package, never the other way round.
 */

export type PictureMime = 'image/png' | 'image/jpeg' | 'image/webp';

export const PICTURE_MIMES: readonly PictureMime[] = ['image/png', 'image/jpeg', 'image/webp'];

/** The stored extension of each mime type; JPEG is `jpg`, as the storyboard's image store has always written it. */
export type PictureExtension = 'png' | 'jpg' | 'webp';

/** Bytes plus what a profile needs to know about them (the P1 host contract). */
export interface PictureBytes {
  bytes: Uint8Array;
  mime: PictureMime;
  width: number;
  height: number;
}

export interface PictureProfile {
  /** Longest edge in pixels; a picture already within it is never upscaled. */
  maxEdge: number;
  output: 'jpeg' | 'png' | 'preserve';
  jpegQuality: number;
  flattenAlpha: boolean;
  stripMetadata: boolean;
}

/** One implementation per host (browser canvas, Node codec); a profile a host cannot run is refused, never approximated. */
export type ProcessPicture = (input: PictureBytes, profile: PictureProfile) => Promise<PictureBytes>;

/** The editor's `TextAnchor`, restated structurally so this package imports no editor or storyboard code. */
export interface TextAnchor {
  from: number;
  to: number;
  exact: string;
  prefix: string;
  suffix: string;
  capturedRevision: number;
}

/** A paragraph anchor is a text anchor plus two tie-breakers (§2.3), not a second mechanism. */
export interface ParagraphAnchor extends TextAnchor {
  /** FNV-1a (64-bit, hex) of the whole normalised paragraph, not of the short quote. */
  blockHash: string;
  /** Zero-based index among the body's non-blank blocks. */
  ordinal: number;
}

export type AssetSourceKind = 'import' | 'paste' | 'mcp' | 'scan' | 'agent';

export const ASSET_SOURCE_KINDS: readonly AssetSourceKind[] = ['import', 'paste', 'mcp', 'scan', 'agent'];

export interface AssetSource {
  kind: AssetSourceKind;
  label?: string;
  server?: string;
  tool?: string;
  url?: string;
}

export interface AssetTranscription {
  docId?: string;
  anchor?: TextAnchor;
  text?: string;
  model?: string;
  at: string;
}

export interface AssetWorkingCopy {
  fromBytes: number;
  fromWidth: number;
  fromHeight: number;
}

export interface AssetRecord {
  /** `a_XXXXXXXXXX`: the existing asset-id space and the file's stem. */
  id: string;
  /** `a_….png` under `assets/`; the extension comes from the sniff, never from the name the writer gave. */
  file: string;
  mime: PictureMime;
  /** Lower-case hex SHA-256 of the bytes as stored; the dedup key. */
  sha256: string;
  bytes: number;
  /** Display size: what the writer sees once EXIF orientation is applied. */
  width?: number;
  height?: number;
  caption?: string;
  alt?: string;
  decorative?: true;
  tags?: string[];
  source?: AssetSource;
  transcription?: AssetTranscription;
  workingCopy?: AssetWorkingCopy;
  createdAt: string;
  updatedAt?: string;
}

export type AssetTarget =
  | { kind: 'project' }
  | { kind: 'node'; nodeId: string }
  | { kind: 'paragraph'; nodeId: string; anchor: ParagraphAnchor; orphaned?: true; moved?: true };

export type AssetLinkRole = 'reference' | 'card' | 'source';

export const ASSET_LINK_ROLES: readonly AssetLinkRole[] = ['reference', 'card', 'source'];

export interface AssetWhen {
  dayOffset?: number;
  label?: string;
}

export interface AssetLink {
  /** `l_XXXXXXXXXX`. */
  id: string;
  assetId: string;
  target: AssetTarget;
  role: AssetLinkRole;
  /** Gap-encoded among the links of one target, in multiples of 10, like `tree[].order`. */
  order: number;
  /** Placement text about this link, at most 2000 characters; it is not record metadata. */
  note?: string;
  /**
   * A picture that marks a moment (timeline.md §9.1). Only `timeline.apply`'s `picture-when` op writes it: the pin is
   * timeline state, so it moves through the same one-approval batch as a scene's day and never as a picture edit.
   */
  when?: AssetWhen;
}

/** A target kind this build does not know, kept as written (§2.1 load rules). */
export interface UnknownTarget {
  kind: string;
  readonly [field: string]: unknown;
}

/** What a tolerant read returns for a link: roles and target kinds from a newer build survive as strings. */
export interface ReadAssetLink extends Omit<AssetLink, 'role' | 'target'> {
  role: AssetLinkRole | (string & {});
  target: AssetTarget | UnknownTarget;
  readonly [field: string]: unknown;
}

export type ReadAssetRecord = AssetRecord & { readonly [field: string]: unknown };

export const PICTURE_LIMITS = {
  caption: 2000,
  alt: 500,
  note: 2000,
  tags: 32,
  tagLength: 64,
  label: 200,
} as const;
