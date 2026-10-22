/** Types for scripts/pack-mcpb.mjs, so the server's tests can import the pack steps. */

export const BUNDLE_ENTRY: string;
export const BUNDLE_MANIFEST: string;
export const BUNDLE_NOTICES: string;
export const BUNDLE_LICENSE: string;
/** The folder of the PDF fallback fonts in the bundle, beside the server entry point. */
export const BUNDLE_FONTS: string;
/** The folder of the files the server reads beside its bundle (the WebP decoder), which is the folder of the entry point. */
export const BUNDLE_SERVER: string;
export const BUNDLE_CJK_FONT: string;
export const BUNDLE_EMOJI_FONT: string;
export const WRITE_SETTING: string;
export const WRITE_VARIABLE: string;

/** Every problem with a manifest for the bundle; an empty list means it is valid. */
export function manifestProblems(manifest: unknown, bundle: { readonly version: string; readonly files: readonly string[] }): string[];

export interface StageInput {
  readonly outDir: string;
  readonly serverBundle: string;
  readonly manifestPath: string;
  readonly version: string;
  readonly notices: string;
  readonly license: string;
  /** Font files to stage in BUNDLE_FONTS, each under its own name: the PDF fallback fonts. */
  readonly fonts?: readonly string[];
  /** Files to stage in BUNDLE_SERVER, each under its own name: `webp_dec.wasm`, the contact sheet's WebP decoder. */
  readonly serverFiles?: readonly string[];
  /** The CJK fallback font the build put beside the bundle, staged as `server/fonts/`. Absent: the bundle has no font. */
  readonly cjkFont?: string;
  /** The emoji fallback font the build put beside the bundle, staged as `server/fonts/`. Absent: the bundle has no emoji font. */
  readonly emojiFont?: string;
}

/** Writes the staged bundle folder after checking the manifest. Throws, and writes nothing, for an invalid manifest. */
export function stageBundle(input: StageInput): { readonly staging: string; readonly files: readonly string[] };

/** The pinned MCPB CLI's entry point in this package's dependencies. */
export function mcpbCliPath(packageDir?: string): string;

/** Runs the MCPB CLI; a non-zero exit throws with its output. Returns the output. */
export function runMcpb(args: readonly string[], options?: { readonly cli?: string; readonly cwd?: string }): string;

export interface PackInput extends StageInput {
  /** The CLI to run, for a test that supplies another. Defaults to the pinned one. */
  readonly mcpb?: string;
}

/** Stages, validates and packs the bundle; returns its path and what the CLI's `info` reported. */
export function packBundle(input: PackInput): { readonly bundle: string; readonly info: string };
