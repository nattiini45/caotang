/**
 * Import of a whole-script Fountain file — [screenplay.md §2.2](../../../docs/architecture/screenplay.md).
 * The file maps to the binder once: sections become folders, each scene heading starts a
 * screenplay document, the `=` line becomes the node's synopsis, and the title page is
 * returned for the caller to map onto template variables. No monolithic script is stored.
 *
 * A scene's body is its own source text, verbatim, with its synopsis line removed. That is
 * what lets Fountain export reproduce the imported file byte for byte (screenplay.md §5.1).
 */

import { sceneNumberOf, stripSceneNumber } from './classify.js';
import { normaliseSource, parseFountain } from './parse.js';
import type { LocatedElement } from './types.js';

export interface ImportedSection {
  readonly kind: 'section';
  readonly depth: 1 | 2 | 3;
  readonly title: string;
  /** The `=` line directly under the section, when there is one. */
  readonly synopsis: string;
}

export interface ImportedScene {
  readonly kind: 'scene';
  /** The node title: the heading without its scene number, or `Untitled` for text before the first heading. */
  readonly title: string;
  /** The heading as written, or null for text before the first heading. */
  readonly heading: string | null;
  readonly sceneNumber: string | null;
  /** The scene's first `=` line. The manifest synopsis is the single truth (screenplay.md §2.2). */
  readonly synopsis: string;
  /** The scene's Fountain text: heading first, `=` lines removed, no surrounding blank lines. */
  readonly body: string;
  /** Further `=` lines in the scene. They are dropped on import, with a notice. */
  readonly droppedSynopses: number;
  /** Length in eighths of a page, when the source carried one (FDX SceneProperties). */
  readonly lengthEighths: number | null;
  /** The binder title the source gave the scene (FDX `SceneProperties Title`), used over `title`. Absent when it gave none. */
  readonly nodeTitle?: string;
  /** The scene's colour as `#rrggbb` (FDX `SceneProperties Color`), which the import maps to a binder label. Absent when none. */
  readonly colour?: string;
}

export type ImportedNode = ImportedSection | ImportedScene;

export interface ImportedScript {
  readonly titlePage: Readonly<Record<string, string>> | null;
  /** Sections and scenes in document order. */
  readonly nodes: readonly ImportedNode[];
  readonly notices: readonly string[];
}

/** A scene still being read: its span runs from `from` to `to`, and `=` lines inside it are excised. */
interface Draft {
  readonly from: number;
  readonly heading: string | null;
  to: number;
  readonly synopses: LocatedElement[];
}

function afterLineBreak(source: string, at: number): number {
  if (source.startsWith('\r\n', at)) return at + 2;
  if (source.startsWith('\n', at)) return at + 1;
  return at;
}

function sceneText(source: string, d: Draft): string {
  let text = '';
  let cursor = d.from;
  for (const s of d.synopses) {
    // A synopsis after the last body element is outside the body and stays out of it.
    if (s.range.from >= d.to) continue;
    text += source.slice(cursor, s.range.from);
    cursor = afterLineBreak(source, s.range.to);
    // A synopsis that sat between two blank lines takes one of them with it, so no double gap is left.
    const past = afterLineBreak(source, cursor);
    if (text.endsWith('\n\n') && past !== cursor) cursor = past;
  }
  text += source.slice(cursor, d.to);
  return text.replace(/\s+$/, '');
}

function finishScene(source: string, d: Draft, notices: string[]): ImportedScene {
  const body = sceneText(source, d);
  const title = d.heading === null ? 'Untitled' : stripSceneNumber(d.heading);
  const first = d.synopses[0];
  const synopsis = first !== undefined && first.type === 'synopsis' ? first.text : '';
  const dropped = Math.max(0, d.synopses.length - 1);
  if (dropped > 0) {
    notices.push(`"${title}": ${dropped} extra synopsis line${dropped === 1 ? '' : 's'} dropped; the first is kept.`);
  }
  if (d.heading === null && body !== '') {
    notices.push('Text before the first scene heading became an untitled scene.');
  }
  return {
    kind: 'scene',
    title,
    heading: d.heading,
    sceneNumber: d.heading === null ? null : sceneNumberOf(d.heading),
    synopsis,
    body,
    droppedSynopses: dropped,
    lengthEighths: null,
  };
}

/** Maps a whole Fountain script onto sections and scenes (screenplay.md §2.2). Never throws. */
export function importFountainScript(input: string): ImportedScript {
  const source = normaliseSource(input);
  const parsed = parseFountain(source);
  const notices: string[] = [...parsed.notices];
  const nodes: ImportedNode[] = [];
  let open: Draft | null = null;
  // The index of the section the reader is directly under, while no scene has opened since.
  let sectionAt: number | null = null;

  for (const el of parsed.elements) {
    if (el.type === 'title_page') continue;

    if (el.type === 'section') {
      if (open !== null) nodes.push(finishScene(source, open, notices));
      open = null;
      nodes.push({ kind: 'section', depth: el.depth, title: el.text, synopsis: '' });
      sectionAt = nodes.length - 1;
      continue;
    }

    if (el.type === 'scene_heading') {
      if (open !== null) nodes.push(finishScene(source, open, notices));
      open = { from: el.range.from, heading: el.text, to: el.range.to, synopses: [] };
      sectionAt = null;
      continue;
    }

    if (el.type === 'synopsis' && open === null && sectionAt !== null) {
      const section = nodes[sectionAt];
      if (section !== undefined && section.kind === 'section') {
        if (section.synopsis === '') {
          nodes[sectionAt] = { ...section, synopsis: el.text };
        } else {
          // A section keeps one synopsis. A second line under it is residue (screenplay.md A5): it is dropped, and it opens no scene.
          notices.push(`"${section.title}": extra synopsis line dropped; the first is kept.`);
        }
        continue;
      }
    }

    if (open === null) open = { from: el.range.from, heading: null, to: el.range.to, synopses: [] };
    sectionAt = null;
    if (el.type === 'synopsis') {
      open.synopses.push(el);
      continue;
    }
    open.to = Math.max(open.to, el.range.to);
  }
  if (open !== null) nodes.push(finishScene(source, open, notices));

  return { titlePage: parsed.titlePage, nodes, notices };
}
