/** Types for tools/check-bundle-size.mjs, so the repository tests can import it. */

/** The limits, all in bytes (1 kB = 1000 bytes, as Vite counts). */
export interface Budget {
  /** A JS chunk over this must be on the allow-list. */
  readonly chunkLimit: number;
  /** Chunks allowed over `chunkLimit`, by chunk name (the file name without its hash), each with its own cap. */
  readonly allow: Readonly<Record<string, number>>;
  /** The gzip size of the first load: the entry chunk and the chunks index.html loads with it. */
  readonly initialGzip: number;
  /** All JS together. */
  readonly totalJs: number;
}

export const BUDGET: Budget;

/** One built JS file. */
export interface Chunk {
  readonly file: string;
  readonly bytes: number;
  readonly gzip: number;
}

export interface Report {
  readonly rows: readonly { readonly chunk: Chunk; readonly name: string; readonly initial: boolean; readonly cap: number | undefined }[];
  readonly initialGzip: number;
  readonly totalJs: number;
  readonly problems: readonly string[];
}

/** A chunk's name: its file name without the extension and the 8-character hash Vite appends. */
export function chunkName(file: string): string;

/** The JS files index.html loads at start: the module script and the modulepreload links, by file name. */
export function initialFilesOf(html: string): string[];

/** Measures the chunks against the budget. `initial` are the file names the first load fetches. */
export function analyse(chunks: readonly Chunk[], initial: readonly string[], budget?: Budget): Report;

/** The report as a table, then the problems, if any. */
export function renderReport(report: Report): string;

/** Reads `<dist>/index.html` and `<dist>/assets/*.js`. */
export function readBuild(dist: string): { readonly chunks: Chunk[]; readonly initial: string[] };
