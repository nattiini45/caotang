/**
 * Writer text for an accessible name or a tooltip (i18n.md §5.3; the I5 decision, inherited by I6).
 *
 * Visible text is isolated exactly once with FSI…PDI. An `aria-label` or `title` is spoken or matched
 * as text, not laid out, and those controls break role-name and exact-text matching; it carries the
 * same writer text with the isolation marks removed. One treatment for every converted surface.
 */
const BIDI_ISOLATION = /[\u2066-\u2069]/g;

export function accessibleText(value: string): string {
  return value.replace(BIDI_ISOLATION, '');
}
