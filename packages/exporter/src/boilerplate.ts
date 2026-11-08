/**
 * The words the exporter writes into a document, in the project's language (i18n.md §7.1). They are content, not
 * interface: they follow `project.language`, never the interface language, and a recipe can override the contents heading.
 * Screenplay continuation marks stay `(MORE)` and `(CONT'D)`, and the coherence report follows the interface language.
 *
 * A word here is written only where the writer wrote none: the heading of a folder the writer left untitled, the title of an
 * empty scene, the file name of a book with no title. A title the writer typed is never replaced.
 */

export interface Boilerplate {
  /** The heading of the contents list: the DOCX field and heading, the EPUB navigation, the Markdown list, and the `toc` landmark. */
  readonly contents: string;
  /** A chapter heading for a folder the writer left untitled, with `{number}` where the language puts it: "Chapter 1", "1章". */
  readonly chapter: string;
  /** A title the writer left empty: a scene's, or the project's in a file name ("Untitled", "Ohne Titel", "無題"). */
  readonly untitled: string;
  /** The hidden landmarks navigation's heading. */
  readonly landmarks: string;
  /** The `bodymatter` landmark's label: where the text begins. */
  readonly beginReading: string;
  /** The `cover` landmark's label. */
  readonly cover: string;
}

const ENGLISH: Boilerplate = {
  contents: 'Contents',
  chapter: 'Chapter {number}',
  untitled: 'Untitled',
  landmarks: 'Landmarks',
  beginReading: 'Begin Reading',
  cover: 'Cover',
};

/**
 * By language subtag, or by subtag and script where the script changes the word (`zh-Hant`). Anything absent reads as English.
 * `untitled` repeats the word `default-title.ts` writes into a new document; `boilerplate.test.ts` holds the two together.
 */
const TABLE: Readonly<Record<string, Boilerplate>> = {
  en: ENGLISH,
  de: {
    contents: 'Inhalt',
    chapter: 'Kapitel {number}',
    untitled: 'Ohne Titel',
    landmarks: 'Orientierungspunkte',
    beginReading: 'Textbeginn',
    cover: 'Umschlag',
  },
  fr: {
    contents: 'Table des matières',
    chapter: 'Chapitre {number}',
    untitled: 'Sans titre',
    landmarks: 'Repères',
    beginReading: 'Commencer la lecture',
    cover: 'Couverture',
  },
  es: {
    contents: 'Contenido',
    chapter: 'Capítulo {number}',
    untitled: 'Sin título',
    landmarks: 'Puntos de referencia',
    beginReading: 'Empezar a leer',
    cover: 'Portada',
  },
  it: {
    contents: 'Indice',
    chapter: 'Capitolo {number}',
    untitled: 'Senza titolo',
    landmarks: 'Punti di riferimento',
    beginReading: 'Inizia a leggere',
    cover: 'Copertina',
  },
  pt: {
    contents: 'Conteúdo',
    chapter: 'Capítulo {number}',
    untitled: 'Sem título',
    landmarks: 'Pontos de referência',
    beginReading: 'Começar a ler',
    cover: 'Capa',
  },
  nl: {
    contents: 'Inhoud',
    chapter: 'Hoofdstuk {number}',
    untitled: 'Zonder titel',
    landmarks: 'Oriëntatiepunten',
    beginReading: 'Begin met lezen',
    cover: 'Omslag',
  },
  sv: {
    contents: 'Innehåll',
    chapter: 'Kapitel {number}',
    untitled: 'Utan titel',
    landmarks: 'Hållpunkter',
    beginReading: 'Börja läsa',
    cover: 'Omslag',
  },
  pl: {
    contents: 'Spis treści',
    chapter: 'Rozdział {number}',
    untitled: 'Bez tytułu',
    landmarks: 'Punkty orientacyjne',
    beginReading: 'Zacznij czytać',
    cover: 'Okładka',
  },
  cs: {
    contents: 'Obsah',
    chapter: 'Kapitola {number}',
    untitled: 'Bez názvu',
    landmarks: 'Orientační body',
    beginReading: 'Začít číst',
    cover: 'Obálka',
  },
  tr: {
    contents: 'İçindekiler',
    chapter: 'Bölüm {number}',
    untitled: 'Başlıksız',
    landmarks: 'Yer imleri',
    beginReading: 'Okumaya başla',
    cover: 'Kapak',
  },
  ru: {
    contents: 'Содержание',
    chapter: 'Глава {number}',
    untitled: 'Без названия',
    landmarks: 'Ориентиры',
    beginReading: 'Начать чтение',
    cover: 'Обложка',
  },
  uk: {
    contents: 'Зміст',
    chapter: 'Розділ {number}',
    untitled: 'Без назви',
    landmarks: 'Орієнтири',
    beginReading: 'Почати читання',
    cover: 'Обкладинка',
  },
  ja: {
    contents: '目次',
    chapter: '{number}章',
    untitled: '無題',
    landmarks: 'ランドマーク',
    beginReading: '本文へ',
    cover: '表紙',
  },
  ko: {
    contents: '목차',
    chapter: '{number}장',
    untitled: '제목 없음',
    landmarks: '랜드마크',
    beginReading: '본문으로',
    cover: '표지',
  },
  zh: {
    contents: '目录',
    chapter: '第{number}章',
    untitled: '无题',
    landmarks: '地标',
    beginReading: '开始阅读',
    cover: '封面',
  },
  'zh-hant': {
    contents: '目錄',
    chapter: '第{number}章',
    untitled: '無題',
    landmarks: '地標',
    beginReading: '開始閱讀',
    cover: '封面',
  },
  ar: {
    contents: 'المحتويات',
    chapter: 'الفصل {number}',
    untitled: 'بلا عنوان',
    landmarks: 'معالم',
    beginReading: 'ابدأ القراءة',
    cover: 'الغلاف',
  },
  he: {
    contents: 'תוכן עניינים',
    chapter: 'פרק {number}',
    untitled: 'ללא כותרת',
    landmarks: 'ציוני דרך',
    beginReading: 'התחל לקרוא',
    cover: 'כריכה',
  },
  hi: {
    contents: 'विषय-सूची',
    chapter: 'अध्याय {number}',
    untitled: 'बिना शीर्षक',
    landmarks: 'लैंडमार्क',
    beginReading: 'पढ़ना शुरू करें',
    cover: 'आवरण',
  },
};

const TRADITIONAL_REGIONS: ReadonlySet<string> = new Set(['tw', 'hk', 'mo']);

/** The table's key for a BCP 47 tag: `zh-Hant` for Traditional Chinese by script or by region, else the language subtag. */
function keyOf(tag: string): string {
  const parts = tag.trim().toLowerCase().split(/[-_]/);
  const [language = '', ...rest] = parts;
  if (language === 'zh' && (rest.includes('hant') || rest.some((part) => TRADITIONAL_REGIONS.has(part)))) return 'zh-hant';
  return language;
}

/** The boilerplate for a project language, with a recipe's own contents heading over it. A blank override is no override. */
export function boilerplateFor(language: string | undefined, overrides?: { readonly contents?: string }): Boilerplate {
  const base = TABLE[keyOf(language ?? 'en')] ?? ENGLISH;
  const contents = overrides?.contents?.trim() ?? '';
  return contents === '' ? base : { ...base, contents };
}

/** A chapter heading for a folder with no title, from the language's pattern: "Kapitel 3", "第3章". */
export function generatedChapterHeading(boilerplate: Boilerplate, number: number): string {
  return boilerplate.chapter.replace('{number}', String(number));
}
