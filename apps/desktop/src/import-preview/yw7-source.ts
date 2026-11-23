/**
 * The yWriter import on the shared preview (#291, epic #263). A `.yw7` project is one XML file (UTF-8 or UTF-16):
 * parts from section-start chapters, chapters and scenes with the scene's text, synopsis, tags and notes. The
 * declared cast, point of view, day offsets and durations ride the scene declarations to the timeline when the
 * project holds a coherence file; clock times, calendar dates and sub-day lengths stay in the notes. Characters,
 * places and items become codex rows. Nothing is written until Import, which commits one `binder.importTree`.
 */

/* lingui-set comment="The yWriter import. Interpolated values: file (the file's name), count (scenes, chapters, codex entries)" */

import { plural, t } from '@lingui/core/macro';
import type { Yw7Error, Yw7Import, Yw7Scene } from '@caotang/import-yw7';

import type { ImportPreviewSource, PreviewBlock, PreviewCodexRow, PreviewNode, PreviewPlan, ScanExtra } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';

/** The reader's refusal, in the writer's words. */
export function yw7ErrorText(error: Yw7Error): string {
  switch (error.kind) {
    case 'not-yw7':
      return t`This is not a yWriter project. In yWriter, keep the project as a .yw7 file.`;
    case 'too-large':
      return t`This yWriter file is too large to import.`;
    case 'bad-xml': {
      const message = error.message;
      return t`This yWriter file could not be read: ${message}`;
    }
    case 'empty':
      return t`This yWriter file carries no chapters, scenes or entries.`;
  }
}

const wordsIn = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length;

/** A `.yw7` project in the preview, read in the Worker. */
export function yw7PreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  const openReq: ReaderOpen = { kind: 'open', reader: 'yw7', bytes };
  let current: Yw7Import | null = null;
  let loaded = false;

  const sceneNode = (scene: Yw7Scene, index: number, blocks: PreviewBlock[]): PreviewNode => {
    const start = blocks.length;
    for (const line of scene.body.split('\n')) {
      if (line.trim() === '') continue;
      if (line.startsWith('#')) blocks.push({ kind: 'heading', text: line.replace(/^#+\s*/, '') });
      else blocks.push({ kind: 'para', text: line });
    }
    const notes = [...scene.notes];
    if (scene.pov !== undefined) notes.unshift(`POV: ${scene.pov}`);
    if (scene.dayOffset !== undefined) notes.push(`Day: ${scene.dayOffset}`);
    if (scene.durationDays !== undefined) notes.push(`Duration: ${scene.durationDays} day${scene.durationDays === 1 ? '' : 's'}`);
    if (scene.expectedPresent.length > 0) notes.push(`Present: ${scene.expectedPresent.join(', ')}`);
    return {
      id: `yw7-scene-${scene.id}-${index}`,
      role: 'scene',
      title: scene.title,
      startBlock: start,
      endBlock: Math.max(start, blocks.length - 1),
      words: wordsIn(`${scene.synopsis} ${scene.body}`),
      ...(scene.synopsis === '' ? {} : { synopsis: scene.synopsis }),
      ...(scene.body === '' ? {} : { body: scene.body }),
      ...(scene.keywords.length === 0 ? {} : { keywords: scene.keywords }),
      ...(notes.length === 0 ? {} : { notes: notes.join('\n') }),
      ...(scene.status === undefined ? {} : { fields: { Status: scene.status } }),
      ...(scene.pov === undefined ? {} : { pov: scene.pov }),
      ...(scene.dayOffset === undefined ? {} : { dayOffset: scene.dayOffset }),
      ...(scene.durationDays === undefined ? {} : { durationDays: scene.durationDays }),
      ...(scene.expectedPresent.length === 0 ? {} : { expectedPresent: scene.expectedPresent }),
    };
  };

  const plan = (): PreviewPlan => {
    const blocks: PreviewBlock[] = [];
    const tree: PreviewNode[] = [];
    const read = current;
    let scenes = 0;
    let chapters = 0;
    if (read !== null) {
      for (const part of read.parts) {
        const children = part.chapters.map((chapter) => {
          chapters += 1;
          const chapterChildren = chapter.scenes.map((scene, index) => {
            scenes += 1;
            return sceneNode(scene, index, blocks);
          });
          const start = blocks.length;
          if (chapter.synopsis !== '') blocks.push({ kind: 'para', text: chapter.synopsis });
          const node: PreviewNode = {
            id: `yw7-chapter-${chapter.id}`,
            role: 'chapter',
            title: chapter.title,
            startBlock: start,
            endBlock: Math.max(start, blocks.length - 1),
            words: wordsIn(chapter.synopsis),
            ...(chapter.synopsis === '' ? {} : { synopsis: chapter.synopsis }),
            children: chapterChildren,
          };
          return node;
        });
        tree.push({ id: `yw7-part-${part.title}`, role: 'part', title: part.title, startBlock: 0, endBlock: 0, words: 0, children });
      }
      for (const [index, doc] of read.research.entries()) {
        const start = blocks.length;
        for (const line of doc.body.split('\n')) {
          if (line.trim() === '') continue;
          if (line.startsWith('#')) blocks.push({ kind: 'heading', text: line.replace(/^#+\s*/, '') });
          else blocks.push({ kind: 'para', text: line });
        }
        tree.push({ id: `yw7-note-${index}`, role: 'back', title: doc.title, startBlock: start, endBlock: Math.max(start, blocks.length - 1), words: wordsIn(doc.body), body: doc.body, place: 'research' });
      }
    }
    return {
      blocks,
      markers: [],
      tree,
      counts: {
        words: blocks.reduce((sum, block) => sum + wordsIn(block.text), 0),
        parts: read?.parts.length ?? 0,
        chapters,
        scenes,
        images: 0,
        comments: 0,
        footnotes: 0,
      },
      losses: (read?.losses ?? []).map((loss) => ({ message: loss.message ?? loss.code, ...(loss.count === undefined ? {} : { count: loss.count }) })),
      flags: [],
    };
  };

  return {
    fileName,
    title: t`Import “${{ file: fileName }}”`,
    readOnly: true,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open(openReq, signal);
      const reply = await host.read({ kind: 'read', reader: 'yw7' }, signal);
      if (reply.kind !== 'yw7') throw new Error(t`It is not a yWriter import.`);
      if (!reply.result.ok) throw new Error(yw7ErrorText(reply.result.error));
      current = reply.result.value;
      loaded = true;
    },
    prepared: () => loaded,
    dispose: () => host.dispose(),
    chips: () => [],
    options: () => [],
    plan,
    fields: () => {
      const statuses = (current?.parts ?? []).flatMap((part) => part.chapters.flatMap((chapter) => chapter.scenes.flatMap((scene) => (scene.status === undefined ? [] : [scene.status]))));
      if (statuses.length === 0) return [];
      return [{ key: 'Status', count: statuses.length, samples: [...new Set(statuses)], suggested: 'status' as const }];
    },
    codexRows: (): PreviewCodexRow[] => {
      const read = current;
      if (read === null) return [];
      return read.codex.map((row) => ({
        id: `yw7-${row.kind}-${row.id}`,
        name: row.name,
        type: row.kind,
        ...(row.aliases.length === 0 ? {} : { aliases: row.aliases }),
        page: row.page,
        preferPage: true,
      }));
    },
    // The codex pages and research bodies are not all tree text, so the scan reads them here too.
    scanExtra: (): ScanExtra[] => {
      const read = current;
      if (read === null) return [];
      return [
        ...read.codex.map((row) => ({ label: t`Entry`, text: `${row.name}\n${row.page.body}` })),
        ...read.research.map((doc) => ({ label: t`Notes`, text: `${doc.title}\n${doc.body}` })),
      ];
    },
    report: () => {
      const read = current;
      if (read === null) return [];
      const lists = [];
      const carried: string[] = [];
      const sceneCount = read.parts.reduce((sum, part) => sum + part.chapters.reduce((inner, chapter) => inner + chapter.scenes.length, 0), 0);
      const chapterCount = read.parts.reduce((sum, part) => sum + part.chapters.length, 0);
      if (sceneCount > 0) carried.push(plural(sceneCount, { one: '# scene', other: '# scenes' }));
      if (chapterCount > 0) carried.push(plural(chapterCount, { one: '# chapter', other: '# chapters' }));
      const codexCount = read.codex.length;
      if (codexCount > 0) carried.push(plural(codexCount, { one: '# character, place or item is offered as a codex entry with its own page', other: '# characters, places and items are offered as codex entries with their own pages' }));
      if (read.research.length > 0) {
        const notes = read.research.length;
        carried.push(plural(notes, { one: '# note or non-manuscript chapter became a Research document', other: '# notes and non-manuscript chapters became Research documents' }));
      }
      lists.push({ heading: t`yWriter`, label: t`What the project carried`, lines: carried });
      const approximated: string[] = [];
      const clocks = read.losses.filter((loss) => loss.code === 'clock-time' || loss.code === 'calendar-date' || loss.code === 'sub-day-duration').length;
      if (clocks > 0) approximated.push(plural(clocks, { one: 'One clock time, date or sub-day length sits in the scene’s notes: the timeline counts whole days only', other: '# clock times, dates or sub-day lengths sit in the scenes’ notes: the timeline counts whole days only' }));
      if (approximated.length > 0) lists.push({ heading: t`yWriter`, label: t`What was approximated`, lines: approximated });
      return lists;
    },
    importLabel: () => {
      const read = current;
      const scenes = read === null ? 0 : read.parts.reduce((sum, part) => sum + part.chapters.reduce((inner, chapter) => inner + chapter.scenes.length, 0), 0) + read.research.length;
      return scenes === 0 ? t`Import` : plural(scenes, { one: 'Import # document', other: 'Import # documents' });
    },
  };
}
