/**
 * The Appearance picker's model ([i18n.md §3.1, §9.2](docs/architecture/i18n.md), decision D5).
 *
 * The model is pure: it takes the committed `locales/stats.json`, the browser's languages and the
 * developer-exposure flag, and returns the choices in order. It reads the catalogue table, never the
 * runtime, so `e2e/unit` can import it without a compiled `.po`.
 *
 * **The gates (D5).** A language at 95 % or more is listed plainly. One at 60–94 % is listed with a
 * "Preview, partly English" label, so a dip does not hide a usable language. Below 60 % it is hidden
 * unless the developer exposure is on. A language that is currently selected is always listed, even
 * below the gate: the writer must be able to switch away from what they chose. Hysteresis for a
 * language that was already listed is I11 and is deliberately not built here.
 *
 * **Pseudo entries are dev/test only.** They are complete by construction (they cover every message),
 * so they carry no percentage; they appear only when the developer exposure is on, or when one is the
 * current setting.
 *
 * **Native names.** Each entry is named by `Intl.DisplayNames` in its own language, so a German writer
 * reads "Deutsch" and an Arabic reader reads "العربية", whatever language the interface is in.
 */
import { displayNames, resolveUiLocale } from '@caotang/i18n';

import { INTERFACE_CATALOGUES, type InterfaceCatalogue } from './catalogues.js';

/** The shape of `apps/desktop/src/i18n/locales/stats.json` (check-translations.mjs owns it). */
export interface InterfaceLanguageStats {
  readonly sourceLocale: string;
  readonly locales: Readonly<Record<string, { readonly completion: number }>>;
}

/** One row of the picker. */
export interface LanguageChoice {
  /** The value stored in the app settings: `'system'` or a catalogue tag. */
  readonly setting: string;
  /** The catalogue tag the choice activates today. */
  readonly tag: string;
  /** The language's name in its own language. */
  readonly nativeName: string;
  /** The committed completion, or `null` for System and the source language (no percentage to show). */
  readonly completion: number | null;
  /** True when the row carries the "Preview, partly English" label. */
  readonly preview: boolean;
  /** True for a dev/test pseudo catalogue. */
  readonly pseudo: boolean;
}

export interface LanguageChoiceOptions {
  /** The stored preference, so a below-gate or unexposed selection stays visible. */
  readonly setting: string;
  readonly navigatorLanguages: readonly string[];
  readonly stats: InterfaceLanguageStats;
  /** `?pseudo=1` or the developer flag, in a development build only. */
  readonly exposeDeveloperLanguages: boolean;
  /** The table to model; the app uses the shipped one. A test can pass a synthetic future table (I14). */
  readonly catalogues?: readonly InterfaceCatalogue[];
}

/** A language's name in its own language, or the tag when `Intl` has no name for it. */
function nativeNameOf(tag: string): string {
  try {
    return displayNames(tag, 'language').of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** D5: listed plainly at ≥95 %, listed as Preview at 60–94 %, hidden below 60 % unless exposed. */
function gateFor(completion: number, exposed: boolean): { readonly listed: boolean; readonly preview: boolean } {
  if (completion >= 95) return { listed: true, preview: false };
  if (completion >= 60) return { listed: true, preview: true };
  return { listed: exposed, preview: true };
}

/** The rows the Appearance picker shows, System first. */
export function languageChoices(options: LanguageChoiceOptions): readonly LanguageChoice[] {
  const catalogues = options.catalogues ?? INTERFACE_CATALOGUES;
  const shipped = catalogues.filter((entry) => !entry.pseudo).map((entry) => entry.tag);
  const systemTag = resolveUiLocale('system', options.navigatorLanguages, shipped);
  const choices: LanguageChoice[] = [
    {
      setting: 'system',
      tag: systemTag,
      nativeName: nativeNameOf(systemTag),
      completion: null,
      preview: false,
      pseudo: false,
    },
  ];

  for (const entry of catalogues) {
    if (entry.pseudo) {
      if (!options.exposeDeveloperLanguages && options.setting !== entry.tag) continue;
      choices.push({
        setting: entry.tag,
        tag: entry.tag,
        nativeName: nativeNameOf(entry.tag),
        completion: null,
        preview: false,
        pseudo: true,
      });
      continue;
    }

    // English is the source locale: it has no completion row because it is complete by definition.
    const source = entry.tag === options.stats.sourceLocale;
    const completion = source ? 100 : (options.stats.locales[entry.tag]?.completion ?? 0);
    const gate = gateFor(completion, options.exposeDeveloperLanguages);
    if (!gate.listed && options.setting !== entry.tag) continue;
    choices.push({
      setting: entry.tag,
      tag: entry.tag,
      nativeName: nativeNameOf(entry.tag),
      completion: source ? null : completion,
      preview: gate.preview,
      pseudo: false,
    });
  }
  return choices;
}
