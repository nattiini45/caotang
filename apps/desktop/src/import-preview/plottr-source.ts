/**
 * The Plottr `.pltr` source for the shared import preview (#290). The worker reads the JSON once; this source turns cards into an
 * empty-prose timeline, plotlines into thread declarations, people and places into codex rows, and notes into research pages.
 */

import { t } from '@lingui/core/macro';

import type { PlottrCard, PlottrRead } from '@caotang/import-plottr';

/* lingui-set comment="Plottr import strings. file and fileName are file names; value names a plotline or field; count and counts are item counts." */

import { ReaderHost } from './reader-host.js';
import type { ImportPreviewSource, PreviewBlock, PreviewLoss, PreviewNode, PreviewOption, PreviewPlan, PreviewSettings } from './model.js';

const BOOK = 'plottr-book';
const PICTURES = 'pictures';

type MutablePreviewNode = {
  -readonly [K in keyof PreviewNode]: PreviewNode[K];
} & { children?: MutablePreviewNode[] };

export interface PlottrImportOpening {
  readonly ok: true;
  readonly source: ImportPreviewSource;
}

const failure = (fileName: string, kind: string): Error => {
  if (kind === 'too-large') return new Error(t`${{ file: fileName }} is larger than one Plottr import reads: at most 25 MB.`);
  if (kind === 'not-json') return new Error(t`${{ file: fileName }} is not readable JSON.`);
  return new Error(t`${{ file: fileName }} is not a Plottr file Caotang can read.`);
};

const imageRef = (id: string): string => `import:plottr-image-${id.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;

function compareCards(a: PlottrCard, b: PlottrCard): number {
  return (a.positionWithinLine - b.positionWithinLine) || (a.positionInChapter - b.positionInChapter) || (a.position - b.position) || (Number(a.id) || 0) - (Number(b.id) || 0);
}

/** Open a `.pltr` file for the shared preview. */
export function plottrPreviewSource(fileName: string, bytes: Uint8Array): PlottrImportOpening {
  const host = new ReaderHost();
  let read: PlottrRead | null = null;
  let currentSettings: PreviewSettings | null = null;

  const selectedBook = (settings: PreviewSettings): string => settings.chips[BOOK] ?? read?.books[0]?.id ?? '1';
  const tagNames = (ids: readonly string[]): string[] => ids.map((id) => read?.tags.get(id)).filter((name): name is string => name !== undefined);
  const charactersById = () => new Map((read?.characters ?? []).map((entity) => [entity.id, entity.name]));
  const placesById = () => new Map((read?.places ?? []).map((entity) => [entity.id, entity.name]));
  const image = (id: string | undefined) => read?.images.find((item) => item.id === id);
  const supported = (item: { mime: string }): boolean => item.mime === 'image/png' || item.mime === 'image/jpeg' || item.mime === 'image/webp';
  const picturesOn = () => currentSettings?.options[PICTURES] !== false;
  const imageMarkdown = (id: string | undefined, alt: string): string => {
    const item = image(id);
    return item === undefined || id === undefined || !supported(item) || !picturesOn() ? '' : `![${alt}](${imageRef(id)})`;
  };

  const build = (settings: PreviewSettings): { tree: PreviewNode[]; blocks: PreviewPlan['blocks']; losses: PreviewPlan['losses']; scenes: number; words: number } => {
    if (read === null) return { tree: [], blocks: [], losses: [], scenes: 0, words: 0 };
    const data: PlottrRead = read;
    const bookId = selectedBook(settings);
    const beats = read.beats.filter((beat) => beat.bookId === bookId).sort((a, b) => a.position - b.position);
    const beatIds = new Set(beats.map((beat) => beat.id));
    const beatBooks = new Map(read.beats.map((beat) => [beat.id, beat.bookId]));
    const lineBooks = new Map(read.lines.map((line) => [line.id, line.series ? undefined : line.bookId]));
    const cardBook = (card: PlottrCard): string | undefined => card.bookId ?? (card.beatId === undefined ? undefined : beatBooks.get(card.beatId)) ?? (card.lineId === undefined ? undefined : lineBooks.get(card.lineId));
    const cards = read.cards.filter((card) => cardBook(card) === undefined || cardBook(card) === bookId);
    const losses: PreviewLoss[] = [];
    const blocks: PreviewBlock[] = [];
    const scenes: MutablePreviewNode[] = [];
    let words = 0;
    const includePictures = settings.options[PICTURES] !== false;
    const people = charactersById();
    const places = placesById();

    const nodes = new Map<string, MutablePreviewNode>();
    const roots: MutablePreviewNode[] = [];
    for (const beat of beats) {
      nodes.set(beat.id, { id: `beat-${beat.id}`, role: 'chapter', title: beat.title, startBlock: 0, endBlock: -1, words: 0, children: [] });
    }
    for (const beat of beats) {
      const node = nodes.get(beat.id);
      if (node === undefined) continue;
      const parent = beat.parentId === undefined ? undefined : nodes.get(beat.parentId);
      if (parent === undefined) roots.push(node);
      else (parent.children as MutablePreviewNode[]).push(node);
    }

    const lines = new Map(data.lines.filter((line) => line.bookId === bookId || (line.bookId === 'series' && data.books.length === 1)).map((line) => [line.id, line.title]));
    const orphan: MutablePreviewNode = { id: 'unsorted', role: 'chapter', title: t`Unsorted cards`, startBlock: 0, endBlock: -1, words: 0, children: [] };
    let block = 0;
    for (const card of cards.sort(compareCards)) {
      const parent = card.beatId !== undefined && beatIds.has(card.beatId) ? nodes.get(card.beatId) : orphan;
      if (parent === undefined) continue;
      const description = card.description.trim();
      const overflow = description.length > 2000 ? description.slice(2000).trim() : '';
      const synopsis = description.slice(0, 2000).trim();
      const picture = includePictures ? imageMarkdown(card.imageId, card.title) : '';
      const body = [picture, overflow].filter((part) => part !== '').join('\n\n');
      const threadNames = [...new Set([card.lineId, card.seriesLineId].map((id) => id === undefined ? undefined : lines.get(id)).filter((name): name is string => name !== undefined))];
      const sceneMeta: NonNullable<PreviewNode['sceneMeta']> = {
        ...(card.pov === undefined ? {} : { pov: card.pov }),
        ...(card.characters.length === 0 ? {} : { expectedPresent: card.characters.map((id) => people.get(id)).filter((name): name is string => name !== undefined) }),
        ...(card.places.length === 0 ? {} : { locations: card.places.map((id) => places.get(id)).filter((name): name is string => name !== undefined) }),
      };
      const scene: MutablePreviewNode = {
        id: `card-${card.id}`,
        role: 'scene',
        title: card.title,
        startBlock: block,
        endBlock: block,
        words: description.split(/\s+/).filter(Boolean).length,
        body,
        ...(synopsis === '' ? {} : { synopsis }),
        keywords: tagNames(card.tags),
        ...(Object.keys(sceneMeta).length === 0 ? {} : { sceneMeta }),
      };
      (scene as { plottrThreads?: string[] }).plottrThreads = threadNames;
      scenes.push(scene);
      words += scene.words;
      blocks.push({ kind: 'heading', text: card.title });
      (parent.children as MutablePreviewNode[]).push(scene);
      parent.endBlock = block;
      block += 1;
    }
    if ((orphan.children?.length ?? 0) > 0) roots.push(orphan);

    // Plottr notes are research, not manuscript scenes. They stay visible in the preview tree and commit to Research.
    for (const note of data.notes) {
      const picture = includePictures ? imageMarkdown(note.imageId, note.title) : '';
      roots.push({
        id: `note-${note.id}`,
        role: 'front',
        title: note.title,
        startBlock: block,
        endBlock: block,
        words: note.content.split(/\s+/).filter(Boolean).length,
        body: [picture, note.content].filter((part) => part !== '').join('\n\n'),
        keywords: tagNames(note.tags),
        place: 'research',
      });
      blocks.push({ kind: 'other', text: note.title });
      block += 1;
    }

    const span = (node: MutablePreviewNode): void => {
      const children = node.children ?? [];
      if (children.length === 0) return;
      for (const child of children) span(child as MutablePreviewNode);
      node.startBlock = Math.min(...children.map((child) => child.startBlock));
      node.endBlock = Math.max(...children.map((child) => child.endBlock));
    };
    for (const root of roots) span(root);

    // A Plottr line is a Caotang thread. The format stores no payoff scene, so the last scene in reading order is the fallback.
    const fallback = scenes[scenes.length - 1];
    const dropped = new Set<string>();
    for (const scene of scenes) {
      const names = (scene as { plottrThreads?: string[] }).plottrThreads ?? [];
      if (names.length === 0) continue;
      const payoff = fallback === scene ? scenes[0] : fallback;
      if (payoff === undefined || payoff === scene) {
        for (const name of names) dropped.add(name);
        continue;
      }
      scene.sceneMeta = { ...(scene.sceneMeta ?? {}), threads: names.map((name) => ({ id: name, payoff: `pending-node:${payoff.id}`, note: t`Imported Plottr plotline` })) };
    }
    for (const name of dropped) losses.push({ message: t`The plotline ${{ value: name }} had no other scene to use as its payoff.` });
    if (data.lines.some((line) => line.series && data.books.length > 1)) losses.push({ message: t`Series-level plotlines outside the chosen book were not imported.` });
    if (data.unknownKeys.length > 0) losses.push({ message: t`Unknown Plottr fields were left out: ${{ value: data.unknownKeys.join(', ') }}` });
    if (data.images.some((item) => !supported(item))) losses.push({ message: t`Unsupported embedded images were left out because Caotang picture imports keep PNG, JPEG and WebP.` });
    if (data.imageBytesDropped > 0) losses.push({ message: t`Some embedded Plottr images were left out because they exceed the image limits.` });
    return { tree: roots, blocks, losses, scenes: scenes.length, words };
  };

  const plan = (settings: PreviewSettings): PreviewPlan => {
    currentSettings = settings;
    const shaped = build(settings);
    return { blocks: shaped.blocks, markers: [], tree: shaped.tree, counts: { words: shaped.words, parts: 0, chapters: shaped.tree.filter((node) => node.role === 'chapter').length, scenes: shaped.scenes, images: read?.images.length ?? 0, comments: 0, footnotes: 0 }, losses: shaped.losses, flags: [] };
  };

  const entityBody = (entity: PlottrRead['characters'][number]): string => {
    const picture = imageMarkdown(entity.imageId, entity.name);
    const attributes = entity.attributes.map((attribute) => `## ${attribute.key}\n\n${attribute.value}`).join('\n\n');
    return [`# ${entity.name}`, picture, entity.description, entity.notes, attributes].filter((part) => part !== '').join('\n\n');
  };

  const source: ImportPreviewSource = {
    fileName,
    title: t`Import “${fileName}”`,
    intro: t`Plottr outlines contain scene cards, not prose. Scenes import empty except for overflow text and pictures; card descriptions become synopses.`,
    readOnly: true,
    picturesOption: PICTURES,
    async load(progress, signal) {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open({ kind: 'open', reader: 'plottr', bytes }, signal);
      const reply = await host.read({ kind: 'read', reader: 'plottr' }, signal);
      if (reply.kind !== 'plottr') throw failure(fileName, 'not-plottr');
      if (!reply.result.ok) throw failure(fileName, reply.result.error.kind);
      read = reply.result.value;
    },
    dispose: () => host.dispose(),
    chips: () => (read !== null && read.books.length > 1 ? [{ id: BOOK, label: t`Book`, value: read.books[0]?.id ?? '', options: read.books.map((book) => ({ value: book.id, label: book.title })) }] : []),
    options: (): readonly PreviewOption[] => [{ id: PICTURES, label: t`Import embedded images`, checked: true }],
    prepared: () => read !== null,
    plan,
    codexRows: () => {
      if (read === null) return [];
      const data: PlottrRead = read;
      const rowOf = (entity: PlottrRead['characters'][number], type: 'character' | 'location', linked: 'characters' | 'places') => {
        const category = entity.categoryId === undefined ? undefined : data.categories.get(entity.categoryId);
        const keywords = [...new Set([...tagNames(entity.tags), ...(category === undefined ? [] : [category])])];
        const attachmentNodes = data.notes.filter((note) => note[linked].includes(entity.id)).map((note) => `note-${note.id}`);
        const description = [entity.description, entity.notes].filter((part) => part !== '').join('\n\n').slice(0, 2000);
        return { id: `${type}-${entity.id}`, name: entity.name, type, description, keywords, ...(attachmentNodes.length === 0 ? {} : { attachmentNodes }), ...(entity.imageId === undefined || image(entity.imageId) === undefined || !picturesOn() ? {} : { visualRefs: [imageRef(entity.imageId)] }), page: { title: entity.name, body: entityBody(entity) }, preferPage: true as const };
      };
      return [
        ...read.characters.map((entity) => rowOf(entity, 'character', 'characters')),
        ...read.places.map((entity) => rowOf(entity, 'location', 'places')),
      ];
    },
    pictures: () => (read?.images ?? []).filter(supported).map((item) => ({ ref: imageRef(item.id), name: item.name, bytes: item.bytes.length, alt: item.name, data: () => item.bytes })),
    metadata: () => ({ ...(read?.title === undefined ? {} : { title: read.title }) }),
    report: (plan) => [{ heading: t`What the import does`, label: t`Import shape`, lines: [t`${{ count: plan.counts.scenes }} scene cards become scenes with synopses and empty prose.`, t`Characters: ${{ characters: read?.characters.length ?? 0 }}; places: ${{ places: read?.places.length ?? 0 }}.`, t`Plottr notes: ${{ count: read?.notes.length ?? 0 }}.`] }],
    importLabel: (plan) => t`Import ${{ count: plan.counts.scenes }} scenes`,
  };
  return { ok: true, source };
}
