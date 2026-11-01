/**
 * The old/new body-write boundary — [pictures.md §2.3](docs/architecture/pictures.md)'s "one body-write
 * boundary, not the current `captureBody`".
 *
 * `captureBody` in `commands.ts` is a snapshot sink: it sees the old body and its revision, and the new
 * body is not available there. This module is the boundary every body mutation and recovery goes
 * through: it carries `{docId, oldBody, newBody, revision, priorLinks}`, maps the document's paragraph
 * links across the write through the injected `AnchorPort`, and captures the prior links independently
 * of the snapshot sink so one undo restores body and links together.
 *
 * The store cannot import `@caotang/editor`, so the resolver is a port (`ProjectCommandOptions.anchors`,
 * the `ShotCommandPort` pattern): one operation taking the document id, the old body, the new body, the
 * revision and **that document's** links, returning the mapped links plus explicit `orphaned` and
 * `moved` outcomes — never a silently dropped link. The port never mutates state; the default is the
 * pure `@caotang/pictures` implementation, and the desktop and Node composition roots inject it
 * explicitly.
 */

import { paragraphAnchorPort, type AnchorPort, type AnchorResult, type ParagraphAnchor, type ParagraphLinkRef } from '@caotang/pictures';
import type { AssetLink, ReadAssetLink } from '@caotang/pictures';

import { linksOf, replaceList, type ListUndo } from './picture-registry.js';
import { getRevision, type ProjectState } from './state.js';

type AnyLink = AssetLink | ReadAssetLink;

/** Re-exported so the store's options and callers name one type. */
export type { AnchorPort } from '@caotang/pictures';

/** The port a registry uses when the host injected none: the pure pictures implementation. */
export function anchorPortOf(options: { readonly anchors?: AnchorPort }): AnchorPort {
  return options.anchors ?? paragraphAnchorPort();
}

/** The paragraph links of one document, as the boundary captures them (the list is replaced, never edited in place, so a reference is exact). */
export function paragraphLinksOfDoc(state: ProjectState, docId: string): readonly AnyLink[] {
  return linksOf(state).filter((link) => {
    const target = link.target as { kind: unknown; nodeId?: unknown };
    return target.kind === 'paragraph' && target.nodeId === docId;
  });
}

function anchorOf(link: AnyLink): ParagraphAnchor | undefined {
  const anchor = (link.target as { anchor?: unknown }).anchor;
  return anchor !== undefined && typeof anchor === 'object' && typeof (anchor as { from?: unknown }).from === 'number' ? (anchor as ParagraphAnchor) : undefined;
}

/** Applies one mapping outcome to a link: the anchor is rewritten, and `orphaned`/`moved` are set or cleared. */
function linkWithOutcome(link: AnyLink, outcome: AnchorResult['outcome']): AnyLink {
  const target = link.target as { kind: string; nodeId?: string; anchor?: ParagraphAnchor; orphaned?: true; moved?: true } & Record<string, unknown>;
  const nextTarget: Record<string, unknown> = { ...target, anchor: outcome.anchor };
  if (outcome.status === 'orphaned') {
    nextTarget['orphaned'] = true;
    delete nextTarget['moved'];
  } else if (outcome.status === 'moved') {
    nextTarget['moved'] = true;
    delete nextTarget['orphaned'];
  } else {
    delete nextTarget['orphaned'];
    delete nextTarget['moved'];
  }
  return { ...link, target: nextTarget as AnyLink['target'] };
}

export interface MappedLinks {
  /** The whole `assetLinks` list with this document's paragraph links mapped. */
  readonly next: AnyLink[];
  /** The ids whose link actually changed (an unchanged outcome writes nothing). */
  readonly changed: string[];
}

/**
 * Maps one document's paragraph links across one body write, through the port. Returns the next list
 * and the changed ids; the caller turns that into the undo capture with `replaceList`.
 */
export function mapLinksThroughWrite(
  state: ProjectState,
  port: AnchorPort,
  docId: string,
  oldBody: string,
  newBody: string,
  revision: number,
): MappedLinks {
  const links = linksOf(state);
  const refs: ParagraphLinkRef[] = [];
  for (const link of links) {
    const target = link.target as { kind: unknown; nodeId?: unknown };
    if (target.kind !== 'paragraph' || target.nodeId !== docId) continue;
    const anchor = anchorOf(link);
    if (anchor === undefined) continue;
    refs.push({ linkId: link.id, anchor });
  }
  if (refs.length === 0) return { next: [...links], changed: [] };
  const mapping = port.op({ docId, oldBody, newBody, revision, links: refs });
  const outcomes = new Map(mapping.results.map((result) => [result.linkId, result.outcome]));
  const next: AnyLink[] = [];
  const changed: string[] = [];
  for (const link of links) {
    const outcome = outcomes.get(link.id);
    if (outcome === undefined) {
      next.push(link);
      continue;
    }
    const mapped = linkWithOutcome(link, outcome);
    next.push(mapped);
    if (JSON.stringify(mapped.target) !== JSON.stringify(link.target)) changed.push(link.id);
  }
  return { next, changed };
}

/**
 * The recovery half of the boundary: a caller that replaces a body **outside** a command (a
 * pending-journal put-back, an encoding conversion, a snapshot restore, an external-write adoption)
 * passes the same old/new pair here and the links are reconciled the same way — no undo capture, no
 * revision bump, because the caller owns the write. `oldBody` is `''` when there is no old body to
 * diff (a reload), which routes every link to the guarded resolver.
 *
 * **In this build the recovery paths adopt a whole state**, so a document's body and its links come
 * from one save and there is nothing to reconcile; every in-command write (including the comic
 * script derivation and the working-copy batch) goes through `mapLinksThroughWrite`. This is the API
 * a caller that replaces one body needs, and `test/body-write.test.ts` is its contract: mapping, the
 * no-old-body resolver, and the no-links/no-change cases.
 */
export function reconcileAdoptedBody(
  state: ProjectState,
  port: AnchorPort,
  docId: string,
  oldBody: string,
  newBody: string,
): void {
  const prior = paragraphLinksOfDoc(state, docId);
  if (prior.length === 0 || oldBody === newBody) return;
  const mapped = mapLinksThroughWrite(state, port, docId, oldBody, newBody, getRevision(state, docId));
  if (mapped.changed.length > 0) replaceList(state, 'assetLinks', mapped.next, mapped.changed);
}

/** What a body write captured for undo: the body capture plus the link undo, restored together. */
export interface BodyWriteUndo {
  readonly linkUndo: ListUndo | undefined;
}
