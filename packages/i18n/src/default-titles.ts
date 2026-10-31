/**
 * The titles Caotang writes into a project when the writer has not named something (i18n.md §7.1). They are content: they
 * follow `project.language`, never the interface language, and a title already stored is never rewritten. This is the one
 * vocabulary the store, the exporter and the app share, so the store never imports the exporter.
 */

export type DefaultTitleKind = 'document' | 'entry' | 'scene' | 'section' | 'shot' | 'dialogue' | 'storyboard' | 'comic' | 'comicPage';

type Titles = Readonly<Record<DefaultTitleKind, string>>;

const ENGLISH: Titles = {
  document: 'Untitled',
  entry: 'Untitled entry',
  scene: 'Untitled scene',
  section: 'Untitled section',
  shot: 'New shot',
  dialogue: 'Untitled dialogue',
  storyboard: 'Storyboard',
  comic: 'Untitled comic',
  comicPage: 'New page',
};

/** By language subtag. A language not listed reads as English. */
const TABLE: Readonly<Record<string, Titles>> = {
  en: ENGLISH,
  de: { document: 'Ohne Titel', entry: 'Eintrag ohne Titel', scene: 'Szene ohne Titel', section: 'Abschnitt ohne Titel', shot: 'Neue Einstellung', dialogue: 'Dialog ohne Titel', storyboard: 'Storyboard', comic: 'Comic ohne Titel', comicPage: 'Neue Seite' },
  fr: { document: 'Sans titre', entry: 'Entrée sans titre', scene: 'Scène sans titre', section: 'Section sans titre', shot: 'Nouveau plan', dialogue: 'Dialogue sans titre', storyboard: 'Storyboard', comic: 'Bande dessinée sans titre', comicPage: 'Nouvelle page' },
  es: { document: 'Sin título', entry: 'Entrada sin título', scene: 'Escena sin título', section: 'Sección sin título', shot: 'Plano nuevo', dialogue: 'Diálogo sin título', storyboard: 'Guion gráfico', comic: 'Cómic sin título', comicPage: 'Página nueva' },
  ja: { document: '無題', entry: '無題の項目', scene: '無題のシーン', section: '無題のセクション', shot: '新しいショット', dialogue: '無題の会話', storyboard: 'ストーリーボード', comic: '無題のコミック', comicPage: '新しいページ' },
};

const ALL: readonly Titles[] = Object.values(TABLE);

/** The default title for something the writer created without naming it, in the project's language. */
export function defaultTitleOf(kind: DefaultTitleKind, language?: string): string {
  const subtag = (language ?? 'en').trim().toLowerCase().split(/[-_]/)[0] ?? 'en';
  return (TABLE[subtag] ?? ENGLISH)[kind];
}

/** Whether a title is the default one of any language, so a rename prompt is offered for it whatever the project language was. */
export function isDefaultTitle(title: string, kind: DefaultTitleKind = 'document'): boolean {
  return ALL.some((titles) => titles[kind] === title);
}
