/**
 * Live interface-language switching ([i18n.md §3.1, §3.3, §8.3](docs/architecture/i18n.md), I4).
 *
 * **Load, activate, publish.** A switch resolves the stored setting (`'system'` or a catalogue tag) to
 * a tag, loads that catalogue, and only then calls `i18n.activate`, records the tag for the formatter
 * decision, sets `<html lang dir>`, and finally publishes the preference to the settings store. A
 * catalogue that fails to load therefore leaves the active catalogue, the root attributes and the
 * stored preference exactly as they were; the picker shows the notice and nothing else changes.
 *
 * **Latest request wins.** Every switch takes a serial. A load that resolves after a newer switch has
 * started is discarded without activating; the newer request owns the screen and the stored value.
 *
 * **A persistence failure does not roll the screen back.** The activation already happened, so the
 * writer keeps the language they chose; the notice says the choice will not survive a reload. The
 * settings store applies a patch and announces it before it writes, and IndexedDB commits writes in
 * creation order, so the last switch's value is the one stored when switches overlap.
 *
 * **Nothing here writes to a project.** The preference is an app setting, beside the other settings in
 * `app-db`; the project bundle never carries it.
 *
 * The controller is injectable so a unit test can hold a load open and prove the ordering, the
 * rejection and the race without a browser.
 */
import { i18n, type Messages } from '@lingui/core';
import { t } from '@lingui/core/macro';
import { directionOf, resolveUiLocale } from '@caotang/i18n';

import { catalogueTags, sameTag } from './catalogues.js';
import { setUiLocaleTag, systemLanguages } from './format-locale.js';
import { loadMessages, UnknownCatalogueError } from './runtime.js';

/** What a switch did, or why it did nothing. */
export type SwitchResult =
  /** The catalogue loaded and is active; the preference was saved (or there was nothing to save). */
  | { readonly status: 'switched' }
  /**
   * The catalogue is active and {@link LanguageController.setting} is the choice; only the write
   * failed. The message is shown as-is.
   */
  | { readonly status: 'kept'; readonly message: string }
  /** Nothing changed: the candidate catalogue could not be resolved or loaded. */
  | { readonly status: 'failed'; readonly message: string }
  /** A newer switch superseded this one; it must not touch the screen or the status line. */
  | { readonly status: 'superseded' };

/** The sentences a failed switch shows. Injected so a unit test does not need a UI language. */
export interface LanguageMessages {
  /** A catalogue could not be resolved or downloaded; the active language is unchanged. */
  readonly loadFailed: () => string;
  /** The catalogue is active, but the choice could not be stored; a reload returns to the saved one. */
  readonly persistFailed: () => string;
}

export interface LanguageControllerOptions {
  /** The tag a stored setting names. May throw when this build has no such catalogue. */
  readonly resolve: (setting: string) => string;
  readonly load: (tag: string) => Promise<Messages>;
  readonly activate: (tag: string, messages: Messages) => void;
  /** Publishes the tag where the page and the formatter decision can see it. */
  readonly publish: (tag: string) => void;
  readonly messages: LanguageMessages;
}

export interface LanguageController {
  /** Switch to a setting, optionally persisting it once activation has succeeded. */
  switchTo(setting: string, persist?: (setting: string) => Promise<string | null>): Promise<SwitchResult>;
  subscribe(listener: () => void): () => void;
  /** Increases only when a catalogue was activated, so React can re-render without remounting. */
  revision(): number;
  /**
   * The **effective** setting behind the active catalogue: what the screen and the formatter are
   * using. It changes when a catalogue activates, before persistence. A failed write leaves this
   * value and the screen in place (the settings store's in-memory record holds it too); a reload may
   * then return to the last value that reached `app-db`. It is not a report of what was persisted.
   */
  setting(): string;
}

/** A test-injectable controller. The app uses the singleton at the bottom of this module. */
export function createLanguageController(options: LanguageControllerOptions): LanguageController {
  const listeners = new Set<() => void>();
  let serial = 0;
  let revision = 0;
  // The effective setting, not the persisted one: see `LanguageController.setting`.
  let setting = 'system';

  const switchTo = async (
    next: string,
    persist?: (setting: string) => Promise<string | null>,
  ): Promise<SwitchResult> => {
    const request = ++serial;

    let tag: string;
    try {
      tag = options.resolve(next);
    } catch {
      if (request !== serial) return { status: 'superseded' };
      return { status: 'failed', message: options.messages.loadFailed() };
    }

    let messages: Messages;
    try {
      messages = await options.load(tag);
    } catch {
      if (request !== serial) return { status: 'superseded' };
      return { status: 'failed', message: options.messages.loadFailed() };
    }

    // A newer switch started while this catalogue downloaded: discard this result, activate nothing.
    if (request !== serial) return { status: 'superseded' };

    options.activate(tag, messages);
    options.publish(tag);
    setting = next;
    revision += 1;
    for (const listener of listeners) listener();

    if (persist !== undefined) {
      let failure: string | null;
      try {
        failure = await persist(next);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      // A later switch owns the status line now; this one must not overwrite its message.
      if (request !== serial) return { status: 'superseded' };
      if (failure !== null) return { status: 'kept', message: options.messages.persistFailed() };
    }
    return { status: 'switched' };
  };

  return {
    switchTo,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revision: () => revision,
    setting: () => setting,
  };
}

/** The tag a stored setting names in this build. An explicit tag this build does not ship is refused. */
function resolveSetting(setting: string): string {
  const dev = import.meta.env.DEV;
  if (setting === 'system') return resolveUiLocale('system', systemLanguages(), catalogueTags(dev));
  const match = catalogueTags(dev).find((tag) => sameTag(tag, setting));
  if (match === undefined) throw new UnknownCatalogueError(setting);
  return match;
}

/** Sets `<html lang>` and `<html dir>` to the activated catalogue. A Node test has no document. */
export function publishDocumentLanguage(tag: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = tag;
  document.documentElement.dir = directionOf(tag);
}

/**
 * Whether the picker may show dev/test pseudo catalogues and languages below the D5 gate.
 *
 * Only a development/test build answers yes, and only with `?pseudo=1` or the `caotang.pseudo` local
 * flag. A production build ignores both: the runtime refuses a pseudo tag and `dist/` holds no pseudo
 * catalogue, which `e2e/prod-smoke.spec.ts` still proves.
 */
export function developerLanguageExposure(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('pseudo') === '1') return true;
  } catch {
    // A malformed address is not an exposure switch.
  }
  try {
    return window.localStorage.getItem('caotang.pseudo') === '1';
  } catch {
    return false;
  }
}

const controller = createLanguageController({
  resolve: resolveSetting,
  load: (tag) => loadMessages(tag),
  activate: (tag, messages) => {
    i18n.load(tag, messages);
    i18n.activate(tag);
    // Only now does the formatter decision see the new language (§4.1).
    setUiLocaleTag(tag);
  },
  publish: publishDocumentLanguage,
  messages: {
    loadFailed: () =>
      t`The interface language could not be loaded, so nothing changed. Check your connection and choose the language again.`,
    persistFailed: () =>
      t`The interface language changed, but the choice could not be saved in this browser. It will go back to the saved language when you reload.`,
  },
});

/**
 * Loads and activates the stored preference at start-up, without writing it back. A failed catalogue
 * falls back to English and returns the notice; the stored value is left alone, so a build that ships
 * the catalogue later can use it.
 */
export async function initializeInterfaceLanguage(setting: string): Promise<string | null> {
  const result = await controller.switchTo(setting);
  if (result.status !== 'failed') return null;
  // English is synchronous and always present. Publishing it keeps the formatter and `<html lang>`
  // agreeing with the screen the writer is actually reading.
  await controller.switchTo('en');
  return result.message;
}

/** The picker's switch: activation first, then the app setting. */
export function switchInterfaceLanguage(
  setting: string,
  settings: { update(patch: { readonly interfaceLanguage: string }): Promise<string | null> },
): Promise<SwitchResult> {
  return controller.switchTo(setting, (next) => settings.update({ interfaceLanguage: next }));
}

/** The live subscription App reads to re-render the whole tree without remounting it. */
export const subscribeLanguage = controller.subscribe;

/** The revision App passes to `useSyncExternalStore`. */
export const languageRevision = controller.revision;
