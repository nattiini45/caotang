/**
 * The XML reader every import shares (issue #268; research: doc-formats.md §1, scrivener.md §4.2).
 *
 * DOCX, ODT, EPUB, XLSX, Scrivener's `.scrivx`, yWriter's `.yw7`, novelWriter's `.nwx`, Scapple's `.scap` and Final Draft's `.fdx`
 * are XML. `DOMParser` is not available in a Web Worker, and the CLI and the MCP server run in Node, so a reader that should run off
 * the main thread or outside a browser needs a JS parser. This is that parser: a small, forward-only scanner that builds a tree.
 *
 * What it reads, and what it does not:
 * - **Namespaces.** `xmlns` and `xmlns:p` are scoped to the element that declares them; every element and prefixed attribute
 *   carries its namespace URI, so a reader asks for `w:p` by local name and URI and never by the prefix a file chose.
 * - **Mixed content.** Text and elements stay in document order (runs inside a paragraph), and whitespace-only text is kept,
 *   because `<w:t xml:space="preserve"> </w:t>` is a real space.
 * - **Entities.** The five predefined ones and numeric references to a character XML allows, as the FDX reader decodes them. An
 *   unknown named entity, a reference to a character XML forbids, and a bare `&` are kept as written and counted in `warnings`
 *   rather than refused, so a sloppy export still opens.
 * - **CDATA** is text (marked `cdata`). Comments and processing instructions are skipped.
 * - **DOCTYPE** is skipped, internal subset included, and its entity declarations are **never expanded**: no external fetch, and
 *   no "billion laughs". A document that used one keeps the `&name;` text and a warning.
 * - **Bytes.** A byte-order mark (UTF-8, UTF-16 LE/BE), the UTF-16 shape of `<?` without one, and the `encoding` of the XML
 *   declaration decide the decoding; invalid bytes for that encoding are an error, not U+FFFD.
 * - **Malformed input** (a tag that does not close, a closing tag that does not match, two roots, a duplicate attribute, an
 *   unquoted attribute) is an {@link XmlReadError} with a code and a line and column, returned and never thrown, so nothing
 *   reaches the UI as an exception. Caps on input size, depth and node count keep a hostile file from holding a thread.
 *
 * The scan moves forward only and never recurses, so the cost is linear in the size of the file and a deep document cannot
 * overflow the stack. There is no `eval`, `new Function` or WebAssembly anywhere in it (`test/csp-clean.test.ts` greps for them).
 */

/** The namespace the `xml` prefix is bound to in every document (Namespaces in XML 1.0 §3). */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
/** The namespace of `xmlns` declarations themselves. */
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** An attribute, with its qualified name split and its namespace resolved. Unprefixed attributes are in no namespace. */
export interface XmlAttribute {
  /** The name as written, `w:val`. */
  readonly name: string;
  readonly prefix: string | null;
  readonly local: string;
  readonly ns: string | null;
  /** The value with entities decoded and whitespace normalised as XML 1.0 §3.3.3 says for CDATA attributes. */
  readonly value: string;
}

/** An element: its name, its attributes, and its children in document order. */
export interface XmlElement {
  readonly type: 'element';
  /** The name as written, `w:p`. */
  readonly name: string;
  readonly prefix: string | null;
  readonly local: string;
  /** The namespace URI the prefix (or the default namespace) resolves to, or null. */
  readonly ns: string | null;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
}

/** A run of character data. Adjacent text and CDATA are kept as separate nodes. */
export interface XmlText {
  readonly type: 'text';
  readonly text: string;
  /** True when it came from a `<![CDATA[…]]>` section. */
  readonly cdata: boolean;
}

export type XmlNode = XmlElement | XmlText;

/** What the reader kept as written rather than refusing, with how many times it met it. */
export type XmlWarningCode = 'unknown-entity' | 'invalid-char-ref' | 'bare-ampersand' | 'doctype-ignored' | 'unbound-prefix';

export interface XmlWarning {
  readonly code: XmlWarningCode;
  /** The first occurrence, for the report: the entity's text, the prefix, or the DOCTYPE's root name. */
  readonly example: string;
  readonly count: number;
}

export interface XmlDocument {
  readonly root: XmlElement;
  /** The encoding the bytes were decoded as (`utf-8`, `utf-16le`, …), or `string` when the input was already text. */
  readonly encoding: string;
  /** The `encoding` the XML declaration named, if it named one. */
  readonly declaredEncoding: string | null;
  readonly warnings: readonly XmlWarning[];
}

export type XmlErrorCode =
  | 'too-large'
  | 'too-deep'
  | 'too-many-nodes'
  | 'unsupported-encoding'
  | 'invalid-encoding'
  | 'no-root'
  | 'unclosed-tag'
  | 'mismatched-tag'
  | 'unexpected-close'
  | 'content-after-root'
  | 'bad-name'
  | 'bad-attribute'
  | 'duplicate-attribute'
  | 'unterminated';

/** A named reason the file could not be read, with where in the text it was found (1-based; 0 when it is about the bytes). */
export class XmlReadError extends Error {
  override readonly name = 'XmlReadError';
  constructor(
    readonly code: XmlErrorCode,
    message: string,
    readonly line = 0,
    readonly column = 0,
  ) {
    super(line > 0 ? `${message} (line ${line}, column ${column})` : message);
  }
}

export type XmlReadResult = { readonly ok: true; readonly document: XmlDocument } | { readonly ok: false; readonly error: XmlReadError };

export interface XmlReadOptions {
  /** The most characters (for text) or bytes (for bytes) the reader takes. Default {@link XML_LIMITS}.maxInput. */
  readonly maxInput?: number;
  /** The deepest element nesting. Default {@link XML_LIMITS}.maxDepth. */
  readonly maxDepth?: number;
  /** The most elements and text nodes in the tree. Default {@link XML_LIMITS}.maxNodes. */
  readonly maxNodes?: number;
}

/**
 * The default caps. A Word `document.xml` for a 200,000-word novel is about 30 MB and a few hundred thousand nodes, so these
 * leave room for a long book and stop a file built to exhaust memory.
 */
export const XML_LIMITS = { maxInput: 256 * 1024 * 1024, maxDepth: 1024, maxNodes: 8_000_000 } as const;

// ---------------------------------------------------------------------------------------------------------------------------
// Bytes to text
// ---------------------------------------------------------------------------------------------------------------------------

export type XmlDecodeResult =
  | { readonly ok: true; readonly text: string; readonly encoding: string; readonly declaredEncoding: string | null }
  | { readonly ok: false; readonly error: XmlReadError };

/** The `encoding` pseudo-attribute of an XML declaration at the start of `head`, or null. */
function declaredEncodingOf(head: string): string | null {
  if (!head.startsWith('<?xml')) return null;
  const end = head.indexOf('?>');
  const decl = end === -1 ? head : head.slice(0, end);
  const match = /\sencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(decl);
  if (match === null) return null;
  return (match[1] ?? match[2] ?? '').trim() || null;
}

function decodeWith(label: string, bytes: Uint8Array): string | XmlReadError {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: true, ignoreBOM: false });
  } catch {
    return new XmlReadError('unsupported-encoding', `The file says it is in ${label}, an encoding this reader does not know`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return new XmlReadError('invalid-encoding', `The file holds bytes that are not valid ${decoder.encoding}`);
  }
}

/**
 * Decodes an XML file's bytes to text (XML 1.0 Appendix F): a byte-order mark first, then the UTF-16 shape of `<?` without one,
 * then the encoding the declaration names, then UTF-8. A UTF-16 label on a file whose bytes are ASCII-shaped is a mislabel (a
 * UTF-16 document starts with a mark), so the bytes win. Invalid bytes are an error rather than U+FFFD.
 */
export function decodeXmlBytes(bytes: Uint8Array, options: Pick<XmlReadOptions, 'maxInput'> = {}): XmlDecodeResult {
  const max = options.maxInput ?? XML_LIMITS.maxInput;
  if (bytes.length > max) return { ok: false, error: new XmlReadError('too-large', `The file is larger than ${max} bytes`) };
  const [b0, b1, b2, b3] = [bytes[0], bytes[1], bytes[2], bytes[3]];
  let detected: string | null = null;
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) detected = 'utf-8';
  else if (b0 === 0xff && b1 === 0xfe) detected = 'utf-16le';
  else if (b0 === 0xfe && b1 === 0xff) detected = 'utf-16be';
  else if (b0 === 0x3c && b1 === 0x00 && b2 === 0x3f && b3 === 0x00) detected = 'utf-16le';
  else if (b0 === 0x00 && b1 === 0x3c && b2 === 0x00 && b3 === 0x3f) detected = 'utf-16be';

  if (detected !== null) {
    const text = decodeWith(detected, bytes);
    if (text instanceof XmlReadError) return { ok: false, error: text };
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return { ok: true, text: body, encoding: detected, declaredEncoding: declaredEncodingOf(body) };
  }

  // ASCII-compatible: read the declaration's label from the first bytes, which are ASCII in every such encoding.
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 256); i += 1) head += String.fromCharCode(bytes[i] ?? 0);
  const declared = declaredEncodingOf(head);
  const label = declared === null || /^utf-?16/i.test(declared) ? 'utf-8' : declared;
  const text = decodeWith(label, bytes);
  if (text instanceof XmlReadError) return { ok: false, error: text };
  return { ok: true, text, encoding: new TextDecoder(label).encoding, declaredEncoding: declared };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------------------------------------------------------

const PREDEFINED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML 1.0 `Char`: tab, line feed, carriage return, the printable BMP without surrogates and U+FFFE/U+FFFF, and the astral planes. */
function isXmlChar(code: number): boolean {
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  if (code < 0x20) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (code === 0xfffe || code === 0xffff) return false;
  return code <= 0x10ffff;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;
}

/**
 * Whether a character may be part of a name. Generous on purpose (any non-ASCII character is allowed, as XML 1.0 fifth
 * edition nearly does); the ASCII rule is exact: letters, digits, `_ : - .`.
 */
function isNameChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x3a ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0xb7 ||
    (code >= 0xc0 && code !== 0xd7 && code !== 0xf7 && code !== 0xfeff)
  );
}

function isNameStart(code: number): boolean {
  return isNameChar(code) && !(code >= 0x30 && code <= 0x39) && code !== 0x2d && code !== 0x2e && code !== 0xb7;
}

interface MutableElement {
  type: 'element';
  name: string;
  prefix: string | null;
  local: string;
  ns: string | null;
  attributes: XmlAttribute[];
  children: XmlNode[];
}

interface RawAttribute {
  readonly name: string;
  readonly value: string;
}

/** One open element on the stack, with the namespace bindings in force inside it. */
interface Frame {
  readonly element: MutableElement;
  readonly bindings: ReadonlyMap<string, string | null>;
}

function splitName(name: string): { prefix: string | null; local: string } {
  const colon = name.indexOf(':');
  return colon <= 0 ? { prefix: null, local: name } : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

class Scanner {
  private at = 0;
  private nodes = 0;
  private readonly warnings = new Map<XmlWarningCode, { example: string; count: number }>();

  constructor(
    private readonly src: string,
    private readonly maxDepth: number,
    private readonly maxNodes: number,
  ) {}

  warn(code: XmlWarningCode, example: string): void {
    const seen = this.warnings.get(code);
    if (seen === undefined) this.warnings.set(code, { example, count: 1 });
    else seen.count += 1;
  }

  warningList(): XmlWarning[] {
    return [...this.warnings].map(([code, { example, count }]) => ({ code, example, count }));
  }

  fail(code: XmlErrorCode, message: string, at = this.at): XmlReadError {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < at && i < this.src.length; i += 1) {
      if (this.src.charCodeAt(i) === 0xa) {
        line += 1;
        lineStart = i + 1;
      }
    }
    return new XmlReadError(code, message, line, at - lineStart + 1);
  }

  /** Decodes references in `raw` (text or an attribute value). Unknown and forbidden references are kept as written. */
  decode(raw: string): string {
    if (raw.indexOf('&') === -1) return raw;
    let out = '';
    let from = 0;
    let amp = raw.indexOf('&');
    while (amp !== -1) {
      out += raw.slice(from, amp);
      const semi = raw.indexOf(';', amp + 1);
      const body = semi === -1 || semi - amp > 32 ? null : raw.slice(amp + 1, semi);
      let replaced: string | null = null;
      if (body !== null && body.length > 0) {
        if (body.charCodeAt(0) === 0x23) {
          const hex = body.charCodeAt(1) === 0x78;
          const digits = body.slice(hex ? 2 : 1);
          if (hex ? /^[0-9a-fA-F]+$/.test(digits) : /^[0-9]+$/.test(digits)) {
            const code = Number.parseInt(digits, hex ? 16 : 10);
            if (isXmlChar(code)) replaced = String.fromCodePoint(code);
            else this.warn('invalid-char-ref', `&${body};`);
          } else this.warn('bare-ampersand', `&${body};`);
        } else if (Object.hasOwn(PREDEFINED, body)) {
          replaced = PREDEFINED[body] ?? null;
        } else if (/^[^\s&<>"';]+$/.test(body)) {
          this.warn('unknown-entity', `&${body};`);
        } else this.warn('bare-ampersand', '&');
      } else this.warn('bare-ampersand', '&');
      if (replaced === null || semi === -1) {
        out += '&';
        from = amp + 1;
      } else {
        out += replaced;
        from = semi + 1;
      }
      amp = raw.indexOf('&', from);
    }
    return out + raw.slice(from);
  }

  /** XML 1.0 §2.11: every `\r\n` and lone `\r` is a line feed. */
  static lineEnds(text: string): string {
    return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
  }

  readName(): string | null {
    const start = this.at;
    if (!isNameStart(this.src.charCodeAt(start))) return null;
    let i = start + 1;
    while (i < this.src.length && isNameChar(this.src.charCodeAt(i))) i += 1;
    this.at = i;
    return this.src.slice(start, i);
  }

  skipSpace(): void {
    while (this.at < this.src.length && isSpace(this.src.charCodeAt(this.at))) this.at += 1;
  }

  /** Skips to just after `token`, or fails with `unterminated`. */
  skipPast(token: string, what: string): XmlReadError | null {
    const end = this.src.indexOf(token, this.at);
    if (end === -1) return this.fail('unterminated', `${what} is not closed`);
    this.at = end + token.length;
    return null;
  }

  /** Skips a DOCTYPE, internal subset included, without reading anything in it. */
  skipDoctype(): XmlReadError | null {
    const start = this.at;
    this.at += '<!DOCTYPE'.length;
    this.skipSpace();
    const rootName = this.readName() ?? '';
    let quote = 0;
    let inSubset = false;
    while (this.at < this.src.length) {
      const c = this.src.charCodeAt(this.at);
      this.at += 1;
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) quote = c;
      else if (c === 0x5b) inSubset = true;
      else if (c === 0x5d) inSubset = false;
      else if (c === 0x3e && !inSubset) {
        this.warn('doctype-ignored', rootName);
        return null;
      } else if (c === 0x3c && inSubset && this.src.startsWith('!--', this.at)) {
        const err = this.skipPast('-->', 'A comment');
        if (err !== null) return err;
      }
    }
    return this.fail('unterminated', 'The DOCTYPE is not closed', start);
  }

  parse(): XmlReadResult {
    const src = this.src;
    const stack: Frame[] = [];
    let root: MutableElement | null = null;
    let rootClosed = false;
    const rootBindings: ReadonlyMap<string, string | null> = new Map<string, string | null>([
      ['xml', XML_NAMESPACE],
      ['xmlns', XMLNS_NAMESPACE],
    ]);

    const addNode = (node: XmlNode): XmlReadError | null => {
      this.nodes += 1;
      if (this.nodes > this.maxNodes) return this.fail('too-many-nodes', `The file holds more than ${this.maxNodes} elements and text runs`);
      stack[stack.length - 1]?.element.children.push(node);
      return null;
    };

    while (this.at < src.length) {
      const lt = src.indexOf('<', this.at);
      const textEnd = lt === -1 ? src.length : lt;
      if (textEnd > this.at) {
        const raw = src.slice(this.at, textEnd);
        if (stack.length > 0) {
          const err = addNode({ type: 'text', text: this.decode(Scanner.lineEnds(raw)), cdata: false });
          if (err !== null) return { ok: false, error: err };
        } else if (raw.trim() !== '') {
          return { ok: false, error: this.fail(root === null ? 'no-root' : 'content-after-root', root === null ? 'There is text before the first element' : 'There is text after the last element') };
        }
      }
      if (lt === -1) break;
      this.at = lt;

      if (src.startsWith('<!--', lt)) {
        this.at = lt + 4;
        const err = this.skipPast('-->', 'A comment');
        if (err !== null) return { ok: false, error: err };
        continue;
      }
      if (src.startsWith('<?', lt)) {
        this.at = lt + 2;
        const err = this.skipPast('?>', 'A processing instruction');
        if (err !== null) return { ok: false, error: err };
        continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        if (stack.length === 0) return { ok: false, error: this.fail('content-after-root', 'A CDATA section is outside the root element') };
        const end = src.indexOf(']]>', lt + 9);
        if (end === -1) return { ok: false, error: this.fail('unterminated', 'A CDATA section is not closed') };
        const err = addNode({ type: 'text', text: Scanner.lineEnds(src.slice(lt + 9, end)), cdata: true });
        if (err !== null) return { ok: false, error: err };
        this.at = end + 3;
        continue;
      }
      if (src.startsWith('<!DOCTYPE', lt)) {
        if (root !== null) return { ok: false, error: this.fail('content-after-root', 'A DOCTYPE comes after the root element') };
        const err = this.skipDoctype();
        if (err !== null) return { ok: false, error: err };
        continue;
      }
      if (src.charCodeAt(lt + 1) === 0x2f) {
        // A closing tag.
        this.at = lt + 2;
        const name = this.readName();
        if (name === null) return { ok: false, error: this.fail('bad-name', 'A closing tag has no name') };
        this.skipSpace();
        if (src.charCodeAt(this.at) !== 0x3e) return { ok: false, error: this.fail('unterminated', `The closing tag </${name}> is not closed`) };
        this.at += 1;
        const open = stack.pop();
        if (open === undefined) {
          return { ok: false, error: this.fail(rootClosed ? 'content-after-root' : 'unexpected-close', `</${name}> closes nothing`, lt) };
        }
        if (open.element.name !== name) {
          return { ok: false, error: this.fail('mismatched-tag', `</${name}> closes <${open.element.name}>`, lt) };
        }
        if (stack.length === 0) rootClosed = true;
        continue;
      }

      // An opening tag.
      if (rootClosed) return { ok: false, error: this.fail('content-after-root', 'There is a second root element') };
      this.at = lt + 1;
      const name = this.readName();
      if (name === null) return { ok: false, error: this.fail('bad-name', 'A tag has no name, or a "<" is not escaped') };
      const raw: RawAttribute[] = [];
      let selfClosing = false;
      for (;;) {
        const before = this.at;
        this.skipSpace();
        const c = src.charCodeAt(this.at);
        if (c === 0x3e) {
          this.at += 1;
          break;
        }
        if (c === 0x2f && src.charCodeAt(this.at + 1) === 0x3e) {
          this.at += 2;
          selfClosing = true;
          break;
        }
        if (this.at >= src.length) return { ok: false, error: this.fail('unclosed-tag', `The tag <${name}> is not closed`, lt) };
        if (this.at === before) return { ok: false, error: this.fail('bad-attribute', `The tag <${name}> needs a space before an attribute`) };
        const attrName = this.readName();
        if (attrName === null) return { ok: false, error: this.fail('bad-attribute', `The tag <${name}> has a character that cannot start an attribute name`) };
        this.skipSpace();
        if (src.charCodeAt(this.at) !== 0x3d) return { ok: false, error: this.fail('bad-attribute', `The attribute ${attrName} has no value`) };
        this.at += 1;
        this.skipSpace();
        const quote = src.charCodeAt(this.at);
        if (quote !== 0x22 && quote !== 0x27) return { ok: false, error: this.fail('bad-attribute', `The value of ${attrName} is not in quotes`) };
        const end = src.indexOf(quote === 0x22 ? '"' : "'", this.at + 1);
        if (end === -1) return { ok: false, error: this.fail('unterminated', `The value of ${attrName} is not closed`) };
        const value = src.slice(this.at + 1, end);
        if (value.indexOf('<') !== -1) return { ok: false, error: this.fail('bad-attribute', `The value of ${attrName} holds a "<"`) };
        if (raw.some((a) => a.name === attrName)) return { ok: false, error: this.fail('duplicate-attribute', `The tag <${name}> has ${attrName} twice`) };
        // §3.3.3: a literal tab, line feed or carriage return in a value is a space; a reference to one stays itself.
        raw.push({ name: attrName, value: this.decode(value.replace(/\r\n|[\t\n\r]/g, ' ')) });
        this.at = end + 1;
      }

      // Namespace declarations first, then the names they bind.
      const parentBindings = stack[stack.length - 1]?.bindings ?? rootBindings;
      let bindings = parentBindings;
      for (const a of raw) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
          if (bindings === parentBindings) bindings = new Map(parentBindings);
          (bindings as Map<string, string | null>).set(a.name === 'xmlns' ? '' : a.name.slice(6), a.value === '' ? null : a.value);
        }
      }
      const resolve = (prefix: string | null, isAttribute: boolean, qname: string): string | null => {
        if (prefix === null) return isAttribute ? null : (bindings.get('') ?? null);
        if (!bindings.has(prefix)) {
          this.warn('unbound-prefix', qname);
          return null;
        }
        return bindings.get(prefix) ?? null;
      };
      const { prefix, local } = splitName(name);
      const attributes: XmlAttribute[] = raw.map((a) => {
        const parts = splitName(a.name);
        const ns = a.name === 'xmlns' ? XMLNS_NAMESPACE : resolve(parts.prefix, true, a.name);
        return { name: a.name, prefix: parts.prefix, local: parts.local, ns, value: a.value };
      });
      const element: MutableElement = { type: 'element', name, prefix, local, ns: resolve(prefix, false, name), attributes, children: [] };
      if (root === null) {
        root = element;
        this.nodes += 1;
      } else {
        const err = addNode(element);
        if (err !== null) return { ok: false, error: err };
      }
      if (selfClosing) {
        if (stack.length === 0) rootClosed = true;
      } else {
        if (stack.length + 1 > this.maxDepth) return { ok: false, error: this.fail('too-deep', `Elements are nested deeper than ${this.maxDepth}`, lt) };
        stack.push({ element, bindings });
      }
    }

    if (root === null) return { ok: false, error: this.fail('no-root', 'The file holds no element') };
    const open = stack[stack.length - 1];
    if (open !== undefined) return { ok: false, error: this.fail('unclosed-tag', `<${open.element.name}> is never closed`) };
    return { ok: true, document: { root, encoding: 'string', declaredEncoding: null, warnings: this.warningList() } };
  }
}

/**
 * Reads an XML document from text or bytes into a tree. Never throws for anything about the input: every problem comes back as
 * `{ ok: false, error }` with a named {@link XmlReadError}.
 */
export function readXml(input: string | Uint8Array, options: XmlReadOptions = {}): XmlReadResult {
  const maxInput = options.maxInput ?? XML_LIMITS.maxInput;
  let text: string;
  let encoding = 'string';
  let declaredEncoding: string | null;
  if (typeof input === 'string') {
    if (input.length > maxInput) return { ok: false, error: new XmlReadError('too-large', `The file is longer than ${maxInput} characters`) };
    text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    declaredEncoding = declaredEncodingOf(text);
  } else {
    const decoded = decodeXmlBytes(input, { maxInput });
    if (!decoded.ok) return decoded;
    ({ text, encoding, declaredEncoding } = decoded);
  }
  try {
    const result = new Scanner(text, options.maxDepth ?? XML_LIMITS.maxDepth, options.maxNodes ?? XML_LIMITS.maxNodes).parse();
    if (!result.ok) return result;
    return { ok: true, document: { ...result.document, encoding, declaredEncoding } };
  } catch (cause) {
    // Nothing above throws by design; an engine limit (an allocation failure on a huge string) still must not reach the UI.
    return { ok: false, error: new XmlReadError('too-large', `The file could not be read: ${cause instanceof Error ? cause.message : String(cause)}`) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Walking the tree
// ---------------------------------------------------------------------------------------------------------------------------

/** Whether `node` is an element named `local`, in namespace `ns` when one is given (`null` means "in no namespace"). */
export function isElement(node: XmlNode | undefined, local?: string, ns?: string | null): node is XmlElement {
  if (node === undefined || node.type !== 'element') return false;
  if (local !== undefined && node.local !== local) return false;
  return ns === undefined || node.ns === ns;
}

/** The element children of `parent`, optionally only those named `local` (in `ns`). */
export function childElements(parent: XmlElement, local?: string, ns?: string | null): XmlElement[] {
  return parent.children.filter((child): child is XmlElement => isElement(child, local, ns));
}

/** The first element child named `local` (in `ns`), or undefined. */
export function firstChild(parent: XmlElement, local: string, ns?: string | null): XmlElement | undefined {
  return parent.children.find((child): child is XmlElement => isElement(child, local, ns));
}

/**
 * Every descendant element named `local` (in `ns`), in document order. Iterative, so a deep tree does not recurse. With
 * `local` undefined it yields every descendant element.
 */
export function* descendants(parent: XmlElement, local?: string, ns?: string | null): Generator<XmlElement> {
  const stack: Array<{ el: XmlElement; i: number }> = [{ el: parent, i: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    const child = top.el.children[top.i];
    top.i += 1;
    if (child === undefined) {
      stack.pop();
      continue;
    }
    if (child.type !== 'element') continue;
    if (isElement(child, local, ns)) yield child;
    stack.push({ el: child, i: 0 });
  }
}

/**
 * An attribute's value by local name, in namespace `ns` when one is given. For an unprefixed attribute pass `null` or leave
 * `ns` out; for `w:val` pass the WordprocessingML namespace, whatever prefix the file used.
 */
export function attr(element: XmlElement, local: string, ns?: string | null): string | undefined {
  return element.attributes.find((a) => a.local === local && (ns === undefined || a.ns === ns) && a.name !== 'xmlns' && a.prefix !== 'xmlns')?.value;
}

/** The text of `element` and every descendant, concatenated in document order (`textContent`). */
export function textOf(element: XmlElement): string {
  let out = '';
  const stack: Array<{ el: XmlElement; i: number }> = [{ el: element, i: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    const child = top.el.children[top.i];
    top.i += 1;
    if (child === undefined) stack.pop();
    else if (child.type === 'text') out += child.text;
    else stack.push({ el: child, i: 0 });
  }
  return out;
}
