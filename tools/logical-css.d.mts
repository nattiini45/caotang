/** Types for tools/logical-css.mjs, so the repository tests can import it. */

export const APP_ROOT: string;
export const ALLOWLIST_FILE: string;

export interface Occurrence {
  readonly file: string;
  readonly context: string;
  readonly property: string;
  readonly line: number;
}

export interface AllowlistEntry {
  readonly file: string;
  readonly context: string;
  readonly property: string;
  readonly count: number;
}

export interface Allowlist {
  readonly version: 1;
  readonly entries: readonly AllowlistEntry[];
}

export interface CssScan {
  readonly occurrences: readonly Occurrence[];
  readonly files: readonly string[];
}

export function scanCss(source: string, file?: string): readonly Occurrence[];
export function scanInlineStyles(path: string, source: string, file?: string): readonly Occurrence[];
export function scanTree(root: string): CssScan;
export function makeAllowlist(occurrences: readonly Occurrence[]): Allowlist;
export function readAllowlist(path: string): Allowlist;
export function renderAllowlist(allowlist: Allowlist): string;
export function compareToAllowlist(occurrences: readonly Occurrence[], allowlist: Allowlist): readonly string[];
export function lowerAllowlist(
  occurrences: readonly Occurrence[],
  allowlist: Allowlist,
): { readonly allowlist: Allowlist; readonly problems: readonly string[] };
