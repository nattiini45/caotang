/**
 * The words the exporter writes into a document, in the project's language (i18n.md §7.1). They are content, not
 * interface: they follow `project.language`, never the interface language, and a recipe can override each one.
 * Screenplay continuation marks stay `(MORE)` and `(CONT'D)`, and the coherence report follows the interface language.
 */

export interface Boilerplate {
  /** The heading of the contents list: the DOCX field and heading, the EPUB navigation, the Markdown list. */
  readonly contents: string;
}

const ENGLISH: Boilerplate = { contents: 'Contents' };

/** By language subtag, or by subtag and script where the script changes the word (`zh-Hant`). Anything absent reads as English. */
const TABLE: Readonly<Record<string, Boilerplate>> = {
  en: ENGLISH,
  de: { contents: 'Inhalt' },
  fr: { contents: 'Table des matières' },
  es: { contents: 'Contenido' },
  it: { contents: 'Indice' },
  pt: { contents: 'Conteúdo' },
  nl: { contents: 'Inhoud' },
  sv: { contents: 'Innehåll' },
  pl: { contents: 'Spis treści' },
  cs: { contents: 'Obsah' },
  tr: { contents: 'İçindekiler' },
  ru: { contents: 'Содержание' },
  uk: { contents: 'Зміст' },
  ja: { contents: '目次' },
  ko: { contents: '목차' },
  zh: { contents: '目录' },
  'zh-hant': { contents: '目錄' },
  ar: { contents: 'المحتويات' },
  he: { contents: 'תוכן עניינים' },
  hi: { contents: 'विषय-सूची' },
};

const TRADITIONAL_REGIONS: ReadonlySet<string> = new Set(['tw', 'hk', 'mo']);

/** The table's key for a BCP 47 tag: `zh-Hant` for Traditional Chinese by script or by region, else the language subtag. */
function keyOf(tag: string): string {
  const parts = tag.trim().toLowerCase().split(/[-_]/);
  const [language = '', ...rest] = parts;
  if (language === 'zh' && (rest.includes('hant') || rest.some((part) => TRADITIONAL_REGIONS.has(part)))) return 'zh-hant';
  return language;
}

/** The boilerplate for a project language, with a recipe's own labels over it. A blank override is no override. */
export function boilerplateFor(language: string | undefined, overrides?: { readonly contents?: string }): Boilerplate {
  const base = TABLE[keyOf(language ?? 'en')] ?? ENGLISH;
  const contents = overrides?.contents?.trim() ?? '';
  return contents === '' ? base : { ...base, contents };
}
