/**
 * An XML file's text, decoded the way XML says (issue #268): a byte-order mark first (UTF-8, UTF-16 LE or BE), then the UTF-16
 * shape of `<?` without one, then the `encoding` the XML declaration names, then UTF-8. `File.text()` reads every file as UTF-8,
 * so a Final Draft file saved as UTF-16 came in as noise; this reads it as its author wrote it.
 *
 * The decoder is the shared import reader's (`@caotang/import-read/xml`), loaded on first use: it is its own chunk, so the first
 * download does not carry it. Bytes that are not valid in their encoding are refused with the reason, rather than read with
 * U+FFFD in their place.
 */

/** The text, or the reason in words the file could not be read. */
export type XmlFileText = { readonly text: string } | { readonly problem: string };

export async function readXmlFileText(bytes: Uint8Array): Promise<XmlFileText> {
  const { decodeXmlBytes } = await import('@caotang/import-read/xml');
  const decoded = decodeXmlBytes(bytes);
  return decoded.ok ? { text: decoded.text } : { problem: decoded.error.message };
}
