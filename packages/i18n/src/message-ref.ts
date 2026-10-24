/**
 * The text a package hands to a UI — [i18n.md §3.2](docs/architecture/i18n.md), decision D7.
 *
 * A package below the app keeps returning the English `string` it returns today (the CLI, the MCP
 * server and the SDK render that), and adds a `MessageRef` beside it where the app shows the text. The
 * app renders the active catalogue's entry for `id` when it has one, and otherwise compiles `message`
 * as ICU with `values` — so a missing translation is a formatted English sentence, never a raw
 * `{title}` placeholder.
 *
 * `id` is opaque: it is not a locale, never reaches `Intl`, and is stable across edits to the English.
 */
export interface MessageRef {
  /** A stable, opaque catalogue id, e.g. `coherence.timeline.orderDrift`. */
  id: string;
  /** The named ICU values the message interpolates; named, never positional (i18n §8.2). */
  values?: Record<string, string | number>;
  /** The English sentence as it renders today, written as an ICU template. */
  message: string;
}
