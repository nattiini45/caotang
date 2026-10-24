/**
 * The interface's catalogue runtime ([i18n.md §3.2–§3.3, §8.1](docs/architecture/i18n.md)).
 *
 * **English is compiled into the entry.** The `en` catalogue is a static import, and
 * {@link activateEnglish} loads and activates it before `main.tsx` renders anything, so there is no
 * flash of an id and a missing message falls back to the compiled English one.
 *
 * **Other catalogues are loaded, then activated.** {@link activateCatalogue} rejects for a tag it has
 * no catalogue for and, for a catalogue it can load, activates only after the import has resolved. L4
 * owns the picker and live switching; this module is the loader that path will call.
 *
 * **A catalogue id is not a language tag.** Lingui's pseudo modes are named `pseudo-LOCALE` and
 * `pseudo-RTL`, which are names for test catalogues, not BCP-47 tags. {@link tagForCatalogueId} maps
 * them to `en-XA` and `ar-XB`, and the loader activates a catalogue under its **tag**; nothing here
 * hands an id to `Intl`. `@caotang/i18n` takes tags only, and this boundary keeps that true.
 *
 * **Pseudo is dev/test only.** Both pseudo imports sit behind `import.meta.env.DEV`, which Vite
 * replaces with `false` in a production build, so the production graph contains neither the catalogue
 * nor its strings. The production branch refuses a pseudo tag before importing anything, even when
 * `?pseudo=1` is on the URL.
 *
 * **One witness.** L2 converts exactly one rendered string, the Home screen's Settings button
 * (`components/Home.tsx`), to prove the transform and exercise the catalogue. L6 converts the rest.
 */

import { i18n, type Messages } from '@lingui/core';

import { messages as enMessages } from './locales/en/messages.po';

/** The source locale. Always shipped; the per-message fallback (§3.3). */
export const SOURCE_LOCALE_TAG = 'en';

/** A catalogue the loader can resolve: its file/id name, the language tag it is activated under, and whether it is a test-only pseudo. */
export interface Catalogue {
  readonly id: string;
  /** A valid BCP-47 tag, and what `Intl` may receive. */
  readonly tag: string;
  readonly pseudo: boolean;
}

/** The only shipped catalogue in L2. A language joins this list when its `.po` file does (§3.3). */
const ENGLISH: Catalogue = { id: 'en', tag: 'en', pseudo: false };

/**
 * The pseudo catalogues and the valid root tags they stand for. `en-XA` is the spec's accented,
 * pseudo-Latin tag; `ar-XB` is the right-to-left one. The ids never leave this module as tags.
 */
export const PSEUDO_CATALOGUES: readonly Catalogue[] = [
  { id: 'pseudo-LOCALE', tag: 'en-XA', pseudo: true },
  { id: 'pseudo-RTL', tag: 'ar-XB', pseudo: true },
];

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

/** The catalogue for a tag, or a refusal. `dev` is injectable so a test can pin the production branch. */
export function catalogueForTag(tag: string, dev: boolean = import.meta.env.DEV): Catalogue {
  if (tag === ENGLISH.tag) return ENGLISH;
  const pseudo = PSEUDO_CATALOGUES.find((entry) => entry.tag === tag);
  if (pseudo !== undefined) {
    if (!dev) throw new PseudoCatalogueUnavailableError(tag);
    return pseudo;
  }
  throw new UnknownCatalogueError(tag);
}

/** The language tag a catalogue id stands for. Throws for an id this build does not name. */
export function tagForCatalogueId(id: string): string {
  if (id === ENGLISH.id) return ENGLISH.tag;
  const pseudo = PSEUDO_CATALOGUES.find((entry) => entry.id === id);
  if (pseudo !== undefined) return pseudo.tag;
  throw new UnknownCatalogueError(id);
}

/** The catalogue id behind a tag. Used by tests and by later tooling; activation keys on the tag. */
export function catalogueIdForTag(tag: string): string {
  if (tag === ENGLISH.tag) return ENGLISH.id;
  const pseudo = PSEUDO_CATALOGUES.find((entry) => entry.tag === tag);
  if (pseudo !== undefined) return pseudo.id;
  throw new UnknownCatalogueError(tag);
}

/**
 * The pseudo catalogue's messages, in development and tests only.
 *
 * The `import.meta.env.DEV` guard is static: Vite replaces it with `false` in the build, and the two
 * dynamic imports are then unreachable and absent from `dist/`.
 */
async function importPseudo(id: string): Promise<Messages> {
  if (import.meta.env.DEV) {
    if (id === 'pseudo-LOCALE') return (await import('./locales/pseudo-LOCALE/messages.po')).messages;
    if (id === 'pseudo-RTL') return (await import('./locales/pseudo-RTL/messages.po')).messages;
  }
  throw new PseudoCatalogueUnavailableError(id);
}

/**
 * The compiled messages for a tag. An unknown tag rejects; so does a pseudo tag in production. The
 * English catalogue is the synchronous one already in the entry.
 */
export async function loadMessages(tag: string, dev: boolean = import.meta.env.DEV): Promise<Messages> {
  const catalogue = catalogueForTag(tag, dev);
  if (catalogue.id === ENGLISH.id) return enMessages;
  return importPseudo(catalogue.id);
}

/**
 * Load a tag's catalogue, then activate it under its **tag** (§3.3: activation follows a successful
 * load). A failed load leaves the active locale untouched.
 */
export async function activateCatalogue(tag: string, dev: boolean = import.meta.env.DEV): Promise<Catalogue> {
  const catalogue = catalogueForTag(tag, dev);
  const messages = await loadMessages(catalogue.tag, dev);
  i18n.load(catalogue.tag, messages);
  i18n.activate(catalogue.tag);
  return catalogue;
}

/** Load and activate English before the first render. Called once, from the app entry. */
export function activateEnglish(): void {
  i18n.load(ENGLISH.tag, enMessages);
  i18n.activate(ENGLISH.tag);
}

/** The tag that is active now. L4 publishes this to `<html lang>`; nothing here writes to the document. */
export function activeTag(): string {
  return i18n.locale ?? SOURCE_LOCALE_TAG;
}
