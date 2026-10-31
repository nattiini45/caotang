/**
 * Source provenance: the Markdown syntax the editor's schema cannot hold, kept so a save writes it back.
 *
 * The schema has no node for a link definition and no way to say that an image or a link came from a reference (`![alt][logo]`,
 * `[text][ref]`, `[docs]`). Expanding them on load and writing direct links on save changed every such body the writer touched, and
 * dropped a definition nothing referenced. So the load keeps, from the same mdast parse, the raw spelling of each reference and each
 * definition, and a save emits them again while they are still what the document says.
 *
 * ## Where it lives
 *
 * - The map is one JSON value on the document node (`doc.attrs.provenance`), editor and history state only: it is not syntax, not a
 *   sidecar, and not part of any visible text or offset. JSON, history and journal round trips carry it because they carry node attrs.
 * - A reference is tied to its place by an id in `image.attrs.prov` or in the `link` mark's `prov`. The ids are assigned in document
 *   order by the parse, so a re-parse of the same body gives the same ids.
 * - A definition has no node. Its position is a ProseMirror boundary between two top-level blocks, which the transaction mapping moves
 *   with the text around it (`mapProvenance`); a save snaps it to a block boundary.
 *
 * ## When raw text is reused
 *
 * Only when the node still says what the parse captured: an image's `src`, `alt` and `title`; a link run's text, `href` and `title`;
 * and the definition the reference names still exists with the same target. Anything else is dirty, and a dirty span is written as an
 * ordinary direct image or link, so a stale spelling is never written over an edit. A placement edit therefore converts only that
 * placement. Its definition stays, and so do the other references that share it.
 *
 * ## What is not kept
 *
 * A reference whose text carries marks or an image (`[*a* b][x]`), a reference that spans lines, and a definition nested in a quote
 * or a list keep the earlier behaviour: the reference expands and the load says so. A nested definition is kept, and a save writes it
 * at the top level.
 */
import { Fragment, Mark } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Definition, Nodes, Root } from 'mdast';

export const PROVENANCE_VERSION = 1;

export type ReferenceForm = 'full' | 'collapsed' | 'shortcut';

/** One reference as the body spelled it, with the values it resolved to. */
export interface ReferenceSource {
  readonly kind: 'image' | 'link';
  readonly form: ReferenceForm;
  readonly raw: string;
  readonly identifier: string;
  /** An image's alt text, or a link's text. */
  readonly text: string;
  readonly url: string;
  readonly title: string | null;
}

/** One definition as the body spelled it. */
export interface DefinitionSource {
  readonly identifier: string;
  readonly raw: string;
  readonly url: string;
  readonly title: string | null;
  /** The ProseMirror boundary between top-level blocks the definition stands at. */
  readonly pos: number;
  /** Written on the line directly after the definition before it. */
  readonly tight: boolean;
}

export interface SourceProvenance {
  readonly v: typeof PROVENANCE_VERSION;
  readonly refs: Readonly<Record<string, ReferenceSource>>;
  readonly defs: readonly DefinitionSource[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The map a document carries, or `null` for none or for one of a version this build does not read. */
export const readProvenance = (value: unknown): SourceProvenance | null => {
  if (!isRecord(value) || value['v'] !== PROVENANCE_VERSION || !isRecord(value['refs']) || !Array.isArray(value['defs'])) return null;
  return value as unknown as SourceProvenance;
};

/** The same document with its map replaced; `null` removes it. */
export const withProvenance = (doc: PmNode, provenance: SourceProvenance | null): PmNode =>
  doc.type.create({ ...doc.attrs, provenance: provenance ?? undefined }, doc.content, doc.marks);

/** Whether a map holds anything a save would write. */
const isEmpty = (provenance: SourceProvenance): boolean => provenance.defs.length === 0 && Object.keys(provenance.refs).length === 0;

const normalize = (identifier: string): string => identifier.toUpperCase();

const sameTitle = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? null) === (b ?? null);

/** The first definition with this identifier, which is the one a reference resolves against. */
export const definitionFor = (provenance: SourceProvenance, identifier: string): DefinitionSource | undefined =>
  provenance.defs.find((definition) => normalize(definition.identifier) === normalize(identifier));

/** The definition a reference names still holds the target the reference was captured with. */
const targetHolds = (provenance: SourceProvenance, entry: ReferenceSource): boolean => {
  const definition = definitionFor(provenance, entry.identifier);
  return definition !== undefined && definition.url === entry.url && sameTitle(definition.title, entry.title);
};

/** The raw spelling of an image placement, or `null` when the placement has been edited since the parse. */
export const cleanImageRaw = (provenance: SourceProvenance, id: unknown, attrs: Readonly<Record<string, unknown>>): string | null => {
  if (typeof id !== 'string') return null;
  const entry = provenance.refs[id];
  if (entry === undefined || entry.kind !== 'image') return null;
  if (attrs['src'] !== entry.url || ((attrs['alt'] as string | null | undefined) ?? '') !== entry.text) return null;
  if (!sameTitle(attrs['title'] as string | null | undefined, entry.title)) return null;
  return targetHolds(provenance, entry) ? entry.raw : null;
};

const normalizeNewlines = (text: string): string => text.replaceAll('\r\n', '\n');

/**
 * Collects the provenance while one body is parsed. The handlers call `rawOf` and `add` as they meet references; `finish` walks the
 * mdast for definitions once the document exists, because a definition's position is a position in that document.
 */
export class ProvenanceCapture {
  private readonly refs: Record<string, ReferenceSource> = {};
  private count = 0;

  constructor(private readonly body: string) {}

  /** The source text of a node, or `null` when the node carries no offsets. */
  rawOf(node: { position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined }): string | null {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined ? null : normalizeNewlines(this.body.slice(start, end));
  }

  add(entry: ReferenceSource): string {
    this.count += 1;
    const id = `r${this.count}`;
    this.refs[id] = entry;
    return id;
  }

  /**
   * The map for the finished document, or `null` when there is nothing to keep. `spanOf` is how many top-level blocks an mdast block
   * compiled into, which is the handler table's own fact (`compiledBlockSpan`).
   */
  finish(tree: Root, doc: PmNode, spanOf: (node: Nodes) => number): SourceProvenance | null {
    const defs: DefinitionSource[] = [];
    let index = 0;
    let previous: { node: Nodes; line: number | undefined } | null = null;
    for (const child of tree.children) {
      const found = definitionsIn(child);
      for (const definition of found) {
        const direct = definition === child;
        const raw = direct ? this.rawOf(definition) : null;
        const line = definition.position?.start.line;
        defs.push({
          identifier: definition.identifier,
          raw: raw ?? canonicalDefinition(definition),
          url: definition.url,
          title: definition.title ?? null,
          pos: boundaryPos(doc, direct ? index : index + spanOf(child)),
          tight:
            direct &&
            previous !== null &&
            previous.node.type === 'definition' &&
            previous.line !== undefined &&
            line !== undefined &&
            line === previous.line + 1,
        });
      }
      previous = { node: child, line: child.position?.end.line };
      index += spanOf(child);
    }
    const provenance: SourceProvenance = { v: PROVENANCE_VERSION, refs: this.refs, defs };
    return isEmpty(provenance) ? null : provenance;
  }
}

/** Every definition inside `node`, in document order, including `node` itself. */
const definitionsIn = (node: Nodes): Definition[] => {
  if (node.type === 'definition') return [node];
  const children = 'children' in node ? (node.children as Nodes[]) : [];
  return children.flatMap(definitionsIn);
};

/** A definition written from its parts, for one that cannot be sliced out of the body (nested in a container, or on several lines). */
const canonicalDefinition = (node: Definition): string => {
  const label = node.label ?? node.identifier;
  const title = node.title === null || node.title === undefined ? '' : ` "${node.title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return `[${label}]: <${node.url.replaceAll('<', '%3C').replaceAll('>', '%3E')}>${title}`;
};

/** The ProseMirror position of the boundary before top-level block `index`. */
const boundaryPos = (doc: PmNode, index: number): number => {
  let pos = 0;
  for (let i = 0; i < index && i < doc.childCount; i += 1) pos += doc.child(i).nodeSize;
  return pos;
};

/** The top-level block boundary a position stands at: inside a block it is the boundary after that block. */
const boundaryIndex = (doc: PmNode, pos: number): number => {
  let at = 0;
  for (let i = 0; i < doc.childCount; i += 1) {
    if (pos <= at) return i;
    at += doc.child(i).nodeSize;
  }
  return doc.childCount;
};

/** Definition text to write at one block boundary. Definitions written on adjacent lines stay one chunk. */
export interface DefinitionChunk {
  /** The chunk is written before this top-level block; `childCount` means after the last. */
  readonly index: number;
  readonly text: string;
}

export const definitionChunks = (doc: PmNode, provenance: SourceProvenance): DefinitionChunk[] => {
  const placed = provenance.defs
    .map((definition, order) => ({ definition, order, index: boundaryIndex(doc, definition.pos) }))
    .sort((a, b) => a.index - b.index || a.order - b.order);
  const chunks: { index: number; text: string }[] = [];
  for (const { definition, index } of placed) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.index === index && definition.tight) last.text += `\n${definition.raw}`;
    else chunks.push({ index, text: definition.raw });
  }
  return chunks;
};

/**
 * Moves the definitions through a transaction's mapping. A definition at the end of the document stays at the end when text is
 * added there; every other one stays after the block before it. The same value comes back when nothing moved, so a caller can
 * tell by identity.
 */
export const mapProvenance = (
  provenance: SourceProvenance,
  mapping: { map(pos: number, assoc?: number): number },
  oldSize: number,
): SourceProvenance => {
  let moved = false;
  const defs = provenance.defs.map((definition) => {
    const pos = mapping.map(definition.pos, definition.pos >= oldSize ? 1 : -1);
    if (pos === definition.pos) return definition;
    moved = true;
    return { ...definition, pos };
  });
  return moved ? { ...provenance, defs } : provenance;
};

const linkProvOf = (marks: readonly Mark[]): { mark: Mark; id: string } | null => {
  for (const mark of marks) {
    const id: unknown = mark.type.name === 'link' ? mark.attrs['prov'] : undefined;
    if (typeof id === 'string') return { mark, id };
  }
  return null;
};

const withoutProv = (marks: readonly Mark[]): Mark[] =>
  marks.map((mark) => (mark.type.name === 'link' && mark.attrs['prov'] !== undefined ? mark.type.create({ ...mark.attrs, prov: undefined }) : mark));

/**
 * The document ready to save: every reference link run that is still what the parse captured becomes one text node holding its raw
 * spelling (still under its link mark, which the save handler turns into verbatim text), and every other run loses its provenance
 * id so it saves as a direct link.
 */
export const resolveReferenceRuns = (doc: PmNode, provenance: SourceProvenance): PmNode => {
  if (Object.values(provenance.refs).every((entry) => entry.kind !== 'link')) return doc;
  const schema = doc.type.schema;

  const resolveInline = (content: Fragment): Fragment => {
    const nodes: PmNode[] = [];
    content.forEach((child) => nodes.push(child));
    const out: PmNode[] = [];
    for (let i = 0; i < nodes.length; ) {
      const head = linkProvOf(nodes[i]!.marks);
      if (head === null) {
        out.push(nodes[i]!);
        i += 1;
        continue;
      }
      let end = i + 1;
      while (end < nodes.length && linkProvOf(nodes[end]!.marks)?.id === head.id) end += 1;
      const group = nodes.slice(i, end);
      const entry = provenance.refs[head.id];
      const first = group[0]!;
      const attrs = head.mark.attrs;
      const clean =
        entry !== undefined &&
        entry.kind === 'link' &&
        group.every((node) => node.isText && Mark.sameSet(node.marks, first.marks)) &&
        group.map((node) => node.text).join('') === entry.text &&
        attrs['href'] === entry.url &&
        sameTitle(attrs['title'] as string | null | undefined, entry.title) &&
        targetHolds(provenance, entry);
      if (clean) out.push(schema.text(entry.raw, first.marks));
      else for (const node of group) out.push(node.mark(withoutProv(node.marks)));
      i = end;
    }
    return Fragment.fromArray(out);
  };

  const resolve = (node: PmNode): PmNode => {
    if (node.isLeaf) return node;
    if (node.inlineContent) return node.copy(resolveInline(node.content));
    const children: PmNode[] = [];
    let changed = false;
    node.forEach((child) => {
      const next = resolve(child);
      if (next !== child) changed = true;
      children.push(next);
    });
    return changed ? node.copy(Fragment.fromArray(children)) : node;
  };
  return resolve(doc);
};
