/**
 * The interface catalogues this build can activate ([i18n.md §3.1, §3.3](docs/architecture/i18n.md)).
 *
 * **This module is pure data.** Settings validation, the Appearance picker and the formatter-locale
 * decision all need the catalogue tags, and none of them may import Lingui or the compiled catalogue:
 * a Node test that reads the settings must not pull in a `.po` module. The runtime (`runtime.ts`)
 * adds each entry's loader; this table is the one place an id and its language tag are written down.
 *
 * **A catalogue id is not a language tag.** Lingui's pseudo modes are named `pseudo-LOCALE` and
 * `pseudo-RTL`; the tags `en-XA` and `ar-XB` are what `Intl` receives. Only the runtime maps one to
 * the other.
 *
 * **Pseudo is dev/test only.** {@link catalogueTags} leaves the pseudo entries out when `dev` is
 * false. A production build still carries the table (its entries are small), but it refuses a pseudo
 * tag and never imports the catalogue.
 */

/** One catalogue: its file/id name and the root language tag it is activated under. */
export interface InterfaceCatalogue {
  readonly id: string;
  /** A valid BCP-47 tag, and what `Intl` may receive. */
  readonly tag: string;
  /** True for a dev/test pseudo catalogue, which a production build must refuse. */
  readonly pseudo: boolean;
}

/**
 * Every catalogue this build can activate, in picker order. A real language joins when its `.po` file
 * does (§3.3): add its id, tag and `pseudo: false` here and a loader in the runtime.
 */
export const INTERFACE_CATALOGUES: readonly InterfaceCatalogue[] = [
  { id: 'en', tag: 'en', pseudo: false },
  { id: 'pseudo-LOCALE', tag: 'en-XA', pseudo: true },
  { id: 'pseudo-RTL', tag: 'ar-XB', pseudo: true },
];

/** The catalogues this build can activate, English first; pseudo entries only when `dev` is true. */
export function catalogueTags(dev: boolean): readonly string[] {
  return INTERFACE_CATALOGUES.filter((entry) => dev || !entry.pseudo).map((entry) => entry.tag);
}

/**
 * True when two catalogue settings name the same tag. A stored setting is canonicalised by
 * `normalizeInterfaceLanguage`, and `'system'` is compared by the switcher itself, so this only
 * absorbs a mixed-case caller or a hand-edited record; the comparison is case-insensitive so a tag's
 * case can never decide whether the picker shows a row as selected.
 */
export function sameTag(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The pseudo catalogues, for tests and the developer-exposed picker. */
export function pseudoCatalogues(): readonly InterfaceCatalogue[] {
  return INTERFACE_CATALOGUES.filter((entry) => entry.pseudo);
}

/** The catalogue with this tag, when this build names it. */
export function interfaceCatalogueForTag(tag: string): InterfaceCatalogue | undefined {
  return INTERFACE_CATALOGUES.find((entry) => entry.tag === tag);
}

/** The catalogue with this id, when this build names it. */
export function interfaceCatalogueForId(id: string): InterfaceCatalogue | undefined {
  return INTERFACE_CATALOGUES.find((entry) => entry.id === id);
}
