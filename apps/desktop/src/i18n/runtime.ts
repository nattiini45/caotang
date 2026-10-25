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
 * no catalogue for and, for a catalogue it can load, activates only after the import has resolved.
 * The live switcher (`language.ts`) uses the same order.
 *
 * **The table lives in `catalogues.ts`.** That module is pure data, so settings and the picker can
 * read the tags without importing Lingui; this module adds the one loader per row. A catalogue id is
 * not a language tag: Lingui's pseudo modes are named `pseudo-LOCALE` and `pseudo-RTL`, and
 * {@link tagForCatalogueId} maps them to `en-XA` and `ar-XB`. Nothing here hands an id to `Intl`.
 *
 * **Pseudo is dev/test only.** Both pseudo imports sit behind `import.meta.env.DEV`, which Vite
 * replaces with `false` in a production build, so the production graph contains neither the catalogue
 * nor its strings. The production branch refuses a pseudo tag before importing anything.
 *
 * **One witness.** I3 converts exactly one rendered string, the Home screen's Settings button
 * (`components/Home.tsx`), to prove the transform and exercise the catalogue. I5 converts the rest.
 */

import { i18n, type Messages } from '@lingui/core';

import {
  interfaceCatalogueForId,
  interfaceCatalogueForTag,
  pseudoCatalogues,
  type InterfaceCatalogue,
} from './catalogues.js';
import { messages as enMessages } from './locales/en/messages.po';

/** The source locale. Always shipped; the per-message fallback (§3.3). */
export const SOURCE_LOCALE_TAG = 'en';

/** A catalogue the loader can resolve: its file/id name and the language tag it is activated under. */
export type Catalogue = InterfaceCatalogue;

/** A catalogue plus the loader that reaches it. */
interface CatalogueEntry extends Catalogue {
  /** Loads the compiled messages. English resolves from the entry immediately. */
  readonly load: () => Promise<Messages>;
}

/** The pseudo catalogues and the valid root tags they stand for, for tests and the dev picker. */
export const PSEUDO_CATALOGUES: readonly Catalogue[] = pseudoCatalogues();

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
  const identity = interfaceCatalogueForTag(tag);
  if (identity === undefined) throw new UnknownCatalogueError(tag);
  if (identity.pseudo && !dev) throw new PseudoCatalogueUnavailableError(tag);
  return { ...identity, load: () => loadCatalogue(identity.id) };
}

/** The catalogue for a tag, or a refusal. `dev` is injectable so a test can pin the production branch. */
export function catalogueForTag(tag: string, dev: boolean = import.meta.env.DEV): Catalogue {
  return entryForTag(tag, dev);
}

/** The language tag a catalogue id stands for. Throws for an id this build does not name. */
export function tagForCatalogueId(id: string): string {
  const entry = interfaceCatalogueForId(id);
  if (entry === undefined) throw new UnknownCatalogueError(id);
  return entry.tag;
}

/**
 * A catalogue's compiled messages, in development and tests only for the pseudo rows.
 *
 * The `import.meta.env.DEV` guard is static: Vite replaces it with `false` in the build, and the two
 * dynamic imports are then unreachable and absent from `dist/`.
 */
async function loadCatalogue(id: string): Promise<Messages> {
  if (id === 'en') return enMessages;
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
  i18n.load(SOURCE_LOCALE_TAG, enMessages);
  i18n.activate(SOURCE_LOCALE_TAG);
}

/** The tag that is active now. The switcher publishes this to `<html lang>`; nothing here writes to the document. */
export function activeTag(): string {
  return i18n.locale ?? SOURCE_LOCALE_TAG;
}
