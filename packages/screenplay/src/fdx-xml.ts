/**
 * A small XML reader for Final Draft files: one forward pass that builds an element tree with a stack, so a nested
 * element is read as a child of its parent, never paired with the next closing tag of the same name.
 *
 * Final Draft nests `<Paragraph>` elements (a scene's summary, an inline script note, a dual-dialogue pair inside a
 * wrapper paragraph). A reader that pairs each opening tag with the next closing tag cuts or replaces text in all
 * three. This one keeps a stack of the open elements and a count of each open name, so:
 *
 * - every character of the file is looked at a bounded number of times: the scan moves forward only, and a closing
 *   tag pops only elements that were pushed once, so the cost is linear in the size of the file however deep the
 *   nesting or however many closing tags are missing;
 * - a closing tag whose name is not open is ignored, and one that closes an outer element closes the inner ones too;
 * - at the end of the text, a `<Paragraph>` still open (a truncated download, a save that ran out of room) is dropped
 *   with what it holds, as the reader always has; any other element still open keeps its complete children.
 *
 * No DTD, no external entities, no namespaces: FDX uses the five predefined entities and numeric references only.
 * Character data is kept only inside `<Text>`, the one element whose characters are script text, so the tree stays
 * small. It never calls `DOMParser`, `eval` or anything else a Worker or Node lacks.
 */

/** An element of the tree. Its children are elements and, inside `<Text>`, decoded character data. */
export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  /** Written as `<name …/>`. */
  readonly selfClosing: boolean;
}

export type XmlNode = XmlElement | string;

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Whether a code point may name a character in an XML document (XML 1.0's `Char` production): tab, line feed and
 * carriage return, the printable range, and the astral planes. A surrogate, a control character and U+FFFE and U+FFFF
 * may not, so a reference to one of them names no character the file could hold.
 */
function isXmlChar(code: number): boolean {
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  if (code < 0x20) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (code === 0xfffe || code === 0xffff) return false;
  return code <= 0x10ffff;
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // A reference that names no character XML allows stays as it was written, as an unknown entity does.
      return isXmlChar(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * XML folds a line end to a line feed (XML 1.0 §2.11), and a byte order mark is not content. A file Final Draft or
 * a Windows editor saved can carry either, so the reader sees the folded text.
 */
export function normaliseXml(xml: string): string {
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** A character that may start an element name. */
const NAME_START = /[A-Za-z_:\u00C0-\uFFFF]/;

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
}

/** Reads `name="value"` and `name='value'` pairs from the inside of a start tag. */
function attributesOf(source: string, from: number, to: number): Record<string, string> {
  const out: Record<string, string> = {};
  let at = from;
  while (at < to) {
    while (at < to && (isSpace(source[at]) || source[at] === '/')) at += 1;
    const nameStart = at;
    while (at < to && source[at] !== '=' && !isSpace(source[at]) && source[at] !== '/') at += 1;
    const name = source.slice(nameStart, at);
    while (at < to && isSpace(source[at])) at += 1;
    if (source[at] !== '=') {
      if (at === nameStart) at += 1;
      continue;
    }
    at += 1;
    while (at < to && isSpace(source[at])) at += 1;
    const quote = source[at];
    if (quote !== '"' && quote !== "'") continue;
    const close = source.indexOf(quote, at + 1);
    const end = close < 0 || close > to ? to : close;
    if (name !== '') out[name] = decodeEntities(source.slice(at + 1, end));
    at = end + 1;
  }
  return out;
}

/** The index of the `>` that ends the start tag opened at `from`, skipping quoted values, or -1 when there is none. */
function startTagEnd(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    const ch = source[at];
    if (ch === '>') return at;
    if (ch === '"' || ch === "'") {
      const close = source.indexOf(ch, at + 1);
      if (close < 0) return -1;
      at = close + 1;
      continue;
    }
    at += 1;
  }
  return -1;
}

/**
 * Reads `xml` into a tree. The returned root is a nameless element whose children are the top-level elements, so a
 * fragment with several top-level elements (or none) reads the same as a whole document.
 */
export function readXml(xml: string): XmlElement {
  const source = normaliseXml(xml);
  const root: XmlElement = { name: '', attrs: {}, children: [], selfClosing: false };
  const stack: XmlElement[] = [root];
  const openCount = new Map<string, number>();
  const pop = (): void => {
    const el = stack.pop();
    if (el !== undefined) openCount.set(el.name, (openCount.get(el.name) ?? 1) - 1);
  };
  let at = 0;
  while (at < source.length) {
    const lt = source.indexOf('<', at);
    const textEnd = lt < 0 ? source.length : lt;
    const top = stack[stack.length - 1] as XmlElement;
    if (textEnd > at && top.name === 'Text') top.children.push(decodeEntities(source.slice(at, textEnd)));
    if (lt < 0) break;
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end < 0) break;
      if (top.name === 'Text') top.children.push(source.slice(lt + 9, end));
      at = end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      if (end < 0) break;
      at = end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2);
      if (end < 0) break;
      at = end + 1;
      continue;
    }
    if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt + 2);
      if (end < 0) break;
      const name = source.slice(lt + 2, end).trim();
      // A closing tag closes the nearest open element of its name and every element opened inside it. One whose name
      // is not open closes nothing; the count makes that a constant-time check.
      if ((openCount.get(name) ?? 0) > 0) {
        while (stack.length > 1) {
          const closing = (stack[stack.length - 1] as XmlElement).name;
          pop();
          if (closing === name) break;
        }
      }
      at = end + 1;
      continue;
    }
    if (!NAME_START.test(source[lt + 1] ?? '')) {
      // A `<` that opens no name is not markup: a file written by hand can hold one. It stays text.
      if (top.name === 'Text') top.children.push('<');
      at = lt + 1;
      continue;
    }
    const end = startTagEnd(source, lt + 1);
    if (end < 0) break;
    let nameEnd = lt + 1;
    while (nameEnd < end && !isSpace(source[nameEnd]) && source[nameEnd] !== '/') nameEnd += 1;
    const name = source.slice(lt + 1, nameEnd);
    let last = end - 1;
    while (last > nameEnd && isSpace(source[last])) last -= 1;
    const selfClosing = source[last] === '/';
    if (name === '') {
      at = end + 1;
      continue;
    }
    const element: XmlElement = { name, attrs: attributesOf(source, nameEnd, selfClosing ? last : end), children: [], selfClosing };
    top.children.push(element);
    if (!selfClosing) {
      stack.push(element);
      openCount.set(name, (openCount.get(name) ?? 0) + 1);
    }
    at = end + 1;
  }
  // A paragraph whose closing tag never came is dropped with everything inside it. The outermost one is enough: the
  // rest are inside it. Other open elements keep the children they completed.
  for (let i = 1; i < stack.length; i += 1) {
    const el = stack[i] as XmlElement;
    if (el.name !== 'Paragraph') continue;
    const parent = stack[i - 1] as XmlElement;
    const index = parent.children.lastIndexOf(el);
    if (index >= 0) parent.children.splice(index, 1);
    break;
  }
  return root;
}

/** The element children of `el` named `name`, in order. */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of el.children) {
    if (typeof child !== 'string' && (name === undefined || child.name === name)) out.push(child);
  }
  return out;
}

/** The character data directly inside `el`, joined. */
export function ownText(el: XmlElement): string {
  let out = '';
  for (const child of el.children) if (typeof child === 'string') out += child;
  return out;
}
