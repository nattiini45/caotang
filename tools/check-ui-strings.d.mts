/** Types for tools/check-ui-strings.mjs, so the repository tests can import it. */

/** The site kinds, in report order. */
export const KINDS: readonly ('jsxText' | 'attribute' | 'literal' | 'template')[];
export const UI_ROOT: string;
export const BASELINE_FILE: string;
export const MODEL_FACING_MARKER: string;
export const USER_FACING_ATTRIBUTES: ReadonlySet<string>;

export type SiteKind = (typeof KINDS)[number];

export interface Site {
  readonly kind: SiteKind;
  readonly line: number;
  readonly text: string;
  readonly file?: string;
}

export type FileCounts = Record<SiteKind, number>;

export interface ScannedFile {
  readonly file: string;
  readonly modelFacing: boolean;
  readonly counts: FileCounts;
}

export interface ScanTree {
  readonly root: string;
  readonly files: readonly ScannedFile[];
  readonly sites: readonly Site[];
}

export interface Baseline {
  readonly version: 1;
  readonly root: string;
  readonly files: Readonly<Record<string, FileCounts>>;
}

export function isModelFacing(source: string): boolean;
export function isProse(value: string, kind?: SiteKind): boolean;
export function scanSource(filePath: string, source: string): { readonly file: string; readonly modelFacing: boolean; readonly sites: readonly Site[] };
export function scanTree(root: string): ScanTree;
export function summarise(tree: ScanTree): { readonly sites: number; readonly files: number; readonly totals: FileCounts };
export function makeBaseline(tree: ScanTree): Baseline;
export function readBaseline(path: string): Baseline;
export function renderBaseline(baseline: Baseline): string;
export function seedBaseline(
  path: string,
  tree: ScanTree,
  options?: { readonly fileExists?: (path: string) => boolean },
): { readonly ok: true; readonly baseline: Baseline } | { readonly ok: false; readonly message: string };
export function compareToBaseline(tree: ScanTree, baseline: Baseline): readonly string[];
export function lowerBaseline(tree: ScanTree, baseline: Baseline): { readonly baseline: Baseline; readonly problems: readonly string[] };
