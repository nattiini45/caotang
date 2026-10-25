/** Types for tools/check-translations.mjs, so the repository tests can import it. */

export const LOCALES_ROOT: string;
export const STATS_FILE: string;
export const SOURCE_LOCALE: string;
export const PSEUDO_LOCALES: ReadonlySet<string>;
export const MODEL_FACING_MARKER: string;
export const STATS_FIELDS: readonly string[];

export interface PoItem {
  readonly msgid: string;
  readonly msgid_plural?: string | null;
  readonly msgctxt?: string | null;
  readonly msgstr: readonly string[];
  readonly extractedComments: readonly string[];
  readonly comments: readonly string[];
  readonly flags: Readonly<Record<string, boolean | string>>;
  readonly obsolete?: boolean;
}

export interface PoCatalog {
  readonly items: readonly PoItem[];
}

export interface Catalogue {
  readonly path: string;
  readonly catalog: PoCatalog;
}

export interface LocaleStats {
  readonly total: number;
  readonly translated: number;
  readonly untranslated: number;
  readonly missing: number;
  readonly fuzzy: number;
  readonly sameAsEnglish: number;
  readonly completion: number;
}

export interface Stats {
  readonly sourceLocale: string;
  readonly locales: Readonly<Record<string, LocaleStats>>;
}

export function normalisePo(content: string): string;
export function compareCatalogues(committed: string, generated: string): readonly string[];
export function readCatalogues(cataloguesRoot: string): Readonly<Record<string, Catalogue>>;
export function activeItems(catalog: PoCatalog): readonly PoItem[];
export function icuArguments(message: string): readonly string[];
export function positionalPlaceholders(message: string): readonly string[];
export function checkCompile(catalogues: Readonly<Record<string, Catalogue>>): readonly string[];
export function checkPlaceholderParity(catalogues: Readonly<Record<string, Catalogue>>): readonly string[];
export function checkTranslatorHygiene(catalogues: Readonly<Record<string, Catalogue>>): readonly string[];
export function findConcatenations(roots: readonly string[]): readonly string[];
export function findModelFacingImports(roots: readonly string[]): readonly string[];
export function repositorySourceRoots(repoRoot: string): readonly string[];
export function localeStats(catalog: PoCatalog): LocaleStats;
export function computeStats(catalogues: Readonly<Record<string, Catalogue>>): Stats;
export function renderStats(stats: Stats): string;
export function readStats(path: string): Stats | undefined;
export function extractToTemp(repoRoot: string): Readonly<Record<string, string>>;
export function checkDrift(repoRoot: string, generated?: Readonly<Record<string, string>>): readonly string[];
