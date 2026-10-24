/**
 * Bidi isolation for writer content interpolated into a UI string — [i18n.md §5.3](docs/architecture/i18n.md).
 *
 * JSX interpolations go through `<UserText>` (a `<bdi>`); attributes and plain strings — `aria-label`,
 * `title`, notices, `document.title`, toasts — go through this: FSI (U+2068) before the text and PDI
 * (U+2069) after it, the W3C's inline-bidi form, so an opposite-direction title cannot reorder the
 * sentence around it.
 */
export function isolate(text: string): string {
  return text === '' ? '' : `\u2068${text}\u2069`;
}
