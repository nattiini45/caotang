/**
 * The interface's catalogue runtime ([i18n.md §3.2–§3.3, §8.1](docs/architecture/i18n.md)).
 *
 * **English is compiled into the entry and is the per-message fallback.** The `en` catalogue is a
 * static import, and {@link activateEnglish} loads and activates it before `main.tsx` renders
 * anything. Every other catalogue is laid over it by {@link withEnglishFallback} before activation, so
 * an id with no translation renders its English sentence; Lingui's `_` reads only the active locale,
 * so the merge is what makes that true.
 *
 * **Other catalogues are loaded, then activated.** {@link activateCatalogue} rejects for a tag it has
 * no catalogue for and, for a catalogue it can load, activates only after the import has resolved. I4
 * owns the picker and live switching; this module is the loader that path will call.
 *
 * **A catalogue id is not a language tag.** Lingui's pseudo modes are named `pseudo-LOCALE` and
 * `pseudo-RTL`, which are names for test catalogues, not BCP-47 tags. The single
 * {@link CATALOGUES} table records each catalogue's id, its root tag and how to load it;
 * {@link tagForCatalogueId} maps the ids to `en-XA` and `ar-XB`, and the loader activates a
 * catalogue under its **tag**. Nothing here hands an id to `Intl`. `@caotang/i18n` takes tags only,
 * and this boundary keeps that true.
 *
 * **Pseudo is dev/test only.** Both pseudo imports sit behind `import.meta.env.DEV`, which Vite
 * replaces with `false` in a production build, so the production graph contains neither the catalogue
 * nor its strings. The production branch refuses a pseudo tag before importing anything. There is no
 * URL switch in this build; the picker's dev/test exposure arrives with I4.
 *
 * **One witness.** I3 converts exactly one rendered string, the Home screen's Settings button
 * (`components/Home.tsx`), to prove the transform and exercise the catalogue. I5 converts the rest.
 */

import { i18n, type Messages } from '@lingui/core';

import { messages as enMessages } from './locales/en/messages.po';

/** The source locale. Always shipped; the per-message fallback (§3.3). */
export const SOURCE_LOCALE_TAG = 'en';

/** A catalogue the loader can resolve: its file/id name and the language tag it is activated under. */
export interface Catalogue {
  readonly id: string;
  /** A valid BCP-47 tag, and what `Intl` may receive. */
  readonly tag: string;
}

/** A catalogue plus what the loader needs to reach it. */
interface CatalogueEntry extends Catalogue {
  /** True for a dev/test pseudo catalogue, which a production build must refuse. */
  readonly pseudo: boolean;
  /** Loads the compiled messages. English resolves from the entry immediately. */
  readonly load: () => Promise<Messages>;
}

/** The only shipped catalogue in I3. A language joins this table when its `.po` file does (§3.3). */
const ENGLISH: CatalogueEntry = { id: 'en', tag: 'en', pseudo: false, load: async () => enMessages };

/**
 * Every catalogue this build can activate, in picker order. One table serves the tag lookup, the id
 * lookup and the loader, so a language arrives by adding a row here rather than by editing three
 * near-identical lists. `en-XA` is the spec's accented, pseudo-Latin tag; `ar-XB` is the
 * right-to-left one. The ids never leave this module as tags.
 */
const CATALOGUES: readonly CatalogueEntry[] = [
  ENGLISH,
  { id: 'pseudo-LOCALE', tag: 'en-XA', pseudo: true, load: () => loadPseudo('pseudo-LOCALE') },
  { id: 'pseudo-RTL', tag: 'ar-XB', pseudo: true, load: () => loadPseudo('pseudo-RTL') },
];

/** The pseudo catalogues and the valid root tags they stand for, for tests and the dev picker. */
export const PSEUDO_CATALOGUES: readonly Catalogue[] = CATALOGUES.filter((entry) => entry.pseudo).map(({ id, tag }) => ({
  id,
  tag,
}));

/** A tag with no catalogue in this build. */
export class UnknownCatalogueError extends Error {
  constructor(tag: string) {
    super(`No interface catalogue is shipped for "${tag}".`);
    this.name = 'UnknownCatalogueError';
  }
}

/** A pseudo catalogue asked for by a production build, where it does not exist and must not. */
export class PseudoCatalogueUnavailableError extends Error {
  constructor(tag: string) {
    super(`The pseudo catalogue "${tag}" is available only in development and tests.`);
    this.name = 'PseudoCatalogueUnavailableError';
  }
}

/** The table row for a tag, or a refusal. `dev` is injectable so a test can pin the production branch. */
function entryForTag(tag: string, dev: boolean): CatalogueEntry {
  const entry = CATALOGUES.find((candidate) => candidate.tag === tag);
  if (entry === undefined) throw new UnknownCatalogueError(tag);
  if (entry.pseudo && !dev) throw new PseudoCatalogueUnavailableError(tag);
  return entry;
}

/** The catalogue for a tag, or a refusal. `dev` is injectable so a test can pin the production branch. */
export function catalogueForTag(tag: string, dev: boolean = import.meta.env.DEV): Catalogue {
  return entryForTag(tag, dev);
}

/** The language tag a catalogue id stands for. Throws for an id this build does not name. */
export function tagForCatalogueId(id: string): string {
  const entry = CATALOGUES.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new UnknownCatalogueError(id);
  return entry.tag;
}

/**
 * A pseudo catalogue's messages, in development and tests only.
 *
 * The `import.meta.env.DEV` guard is static: Vite replaces it with `false` in the build, and the two
 * dynamic imports are then unreachable and absent from `dist/`.
 */
async function loadPseudo(id: string): Promise<Messages> {
  if (import.meta.env.DEV) {
    if (id === 'pseudo-LOCALE') return (await import('./locales/pseudo-LOCALE/messages.po')).messages;
    if (id === 'pseudo-RTL') return (await import('./locales/pseudo-RTL/messages.po')).messages;
  }
  throw new PseudoCatalogueUnavailableError(id);
}

/**
 * A locale's compiled catalogue laid over the compiled English source.
 *
 * Lingui 6.10.1's `i18n._` reads only the active locale: `activate(locale, locales)` does not make it
 * fall back, and an id absent from the active catalogue renders the raw id (which is a generated hash,
 * not a sentence). Spreading English first makes every untranslated id render its English message,
 * while a translation still wins because it is spread last.
 */
export function withEnglishFallback(messages: Messages): Messages {
  return { ...enMessages, ...messages };
}

/**
 * The messages a tag renders with. An unknown tag rejects; so does a pseudo tag in production. Every
 * catalogue is merged over the compiled English one, so a missing message is an English sentence rather
 * than a raw id. The English catalogue itself resolves from its table row already in the entry.
 */
export async function loadMessages(tag: string, dev: boolean = import.meta.env.DEV): Promise<Messages> {
  const entry = entryForTag(tag, dev);
  return withEnglishFallback(await entry.load());
}

/**
 * Load a tag's catalogue, then activate it under its **tag** (§3.3: activation follows a successful
 * load). A failed load leaves the active locale untouched.
 */
export async function activateCatalogue(tag: string, dev: boolean = import.meta.env.DEV): Promise<Catalogue> {
  const entry = entryForTag(tag, dev);
  const messages = await loadMessages(entry.tag, dev);
  i18n.load(entry.tag, messages);
  i18n.activate(entry.tag);
  return entry;
}

/** Load and activate English before the first render. Called once, from the app entry. */
export function activateEnglish(): void {
  i18n.load(ENGLISH.tag, enMessages);
  i18n.activate(ENGLISH.tag);
}

/** The tag that is active now. I4 publishes this to `<html lang>`; nothing here writes to the document. */
export function activeTag(): string {
  return i18n.locale ?? SOURCE_LOCALE_TAG;
}
