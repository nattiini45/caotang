/** Types for tools/pdf-validate/check.mjs, so the repository tests can import it. */

/** A font the corpus's expected.json names, or one a file has. */
export interface FontFact {
  /** For an expected font, a substring of the BaseFont; for a font found, the BaseFont without its subset tag. */
  readonly name: string;
  readonly embedded: boolean;
  readonly toUnicode: boolean;
}

/** One file's entry in expected.json. */
export interface ExpectedFile {
  readonly file: string;
  readonly format: 'pdf' | 'contact-sheet-pdf';
  /** Per page, the strings it must give back as text. */
  readonly pages: readonly (readonly string[])[];
  /** Per page, text only a tool that reads /ActualText gives back (pdf.js does not). */
  readonly actualText?: readonly (readonly string[])[];
  readonly size: readonly [number, number];
  readonly fonts: readonly FontFact[];
}

export interface Row {
  readonly file: string;
  readonly problems: readonly string[];
}

export const EXTERNAL_TOOLS: readonly string[];

/** The text with every whitespace character removed. */
export function squash(text: string): string;

/** A font's name without the six capitals and `+` a subset carries. */
export function unsubset(name: string): string;

/** The classic xref table against the bytes. */
export function checkStructure(bytes: Uint8Array): string[];

/** The fonts a file names. */
export function fontsOf(bytes: Uint8Array): Promise<FontFact[]>;

/** The problems between the fonts a file has and the ones expected. */
export function compareFonts(expected: readonly FontFact[], actual: readonly FontFact[]): string[];

/** The file through pdf.js. */
export function checkWithPdfjs(bytes: Uint8Array, expected: ExpectedFile): Promise<string[]>;

/** Poppler's pdffonts table as fonts. */
export function parsePdffonts(output: string): FontFact[];

/** Checks every file expected.json lists in `dir`. */
export function checkCorpus(dir: string, options?: { readonly tools?: readonly string[]; readonly logDir?: string }): Promise<Row[]>;
