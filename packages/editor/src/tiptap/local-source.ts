/**
 * Whether an image source may be loaded by the editor: an app-local reference, with no
 * scheme and no network-path prefix. The browser cleans a URL before it reads it, in this
 * order: tabs and newlines are removed, C0 controls and spaces are stripped from both ends,
 * and backslashes read as slashes. The stripping used to be the JavaScript `trim`, which
 * removes neither NUL nor SOH, so a leading SOH made a remote source look local.
 * The test runs on the cleaned form, so it agrees with the browser about which references
 * leave the document.
 *
 * Everything else is a network or data reference. `https:` names a host, `//host` is the
 * same host under the page's scheme, and `data:` carries its own bytes. A manuscript that
 * could make the editor contact any of them would make opening a file contact the network,
 * which §2.1 and assumption A2 rule out for a local-first app.
 */

/**
 * Removes the C0 controls and the space from both ends of a reference, which is what the URL
 * standard does before it reads a scheme (U+0000 to U+0020). Written as a character loop rather
 * than a regular expression, because a control character in a pattern is a lint error.
 */
const stripEdges = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return text.slice(start, end);
};

export const isAppLocalSource = (src: string): boolean => {
  const cleaned = stripEdges(src.replace(/[\t\n\r]/g, '')).replace(/\\/g, '/');
  if (cleaned.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return false;
  return !cleaned.startsWith('//');
};
