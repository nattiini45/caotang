/**
 * The Plottr import on the shared preview (#290, epic #263). A `.pltr` outline has no prose: the beat tree becomes
 * folders, its cards scenes whose text is the synopsis, the plotlines and tags keywords, characters and places codex
 * rows with a Details page, and the notes Research documents. A series file offers the book picker as a chip.
 * Nothing is written until Import, which commits one `binder.importTree`.
 */

/* lingui-set comment="The Plottr import. Interpolated values: file (the file's name), book (a book's title), count (scenes, characters, places, pictures), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { PlottrError, PlottrFolder, PlottrImport } from '@caotang/import-plottr';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewBlock, PreviewCodexRow, PreviewNode, PreviewOption, PreviewPicture, PreviewPlan, ScanExtra } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';

const PLOTTR_CHIPS = { book: 'plottr-book' } as const;
const PLOTTR_OPTIONS = { pictures: 'pictures' } as const;

/** The reader's refusal, in the writer's words. */
export function plottrErrorText(error: PlottrError): string {
  switch (error.kind) {
    case 'not-plottr':
      return t`This is not a Plottr outline. In Plottr, open your project and keep it as a .pltr file.`;
    case 'too-large':
      return t`This Plottr file is too large to import.`;
    case 'bad-json':
      return error.message;
    case 'empty':
      return t`This Plottr file carries no book.`;
  }
}

const wordsIn = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length;

/** A Plottr outline file in the preview, read in the Worker. */
export function plottrPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  const openReq: ReaderOpen = { kind: 'open', reader: 'plottr', bytes };
  let current: PlottrImport | null = null;
  let currentBook: string | undefined;
  let loaded = false;
  let picturesOn = true;

  const readAs = async (bookId: string | undefined, signal: AbortSignal): Promise<PlottrImport> => {
    if (current !== null && currentBook === bookId) return current;
    const labels = { details: t`Details`, attributes: t`Attributes` };
    const reply = await host.read({ kind: 'read', reader: 'plottr', ...(bookId === undefined ? {} : { bookId }), labels }, signal);
    if (reply.kind !== 'plottr') throw new Error(t`It is not a Plottr import.`);
    if (!reply.result.ok) throw new Error(plottrErrorText(reply.result.error));
    current = reply.result.value;
    currentBook = bookId;
    return reply.result.value;
  };

  const pictures = (): PreviewPicture[] => {
    const read = current;
    if (read === null) return [];
    return read.assets.flatMap((asset) => {
      const data = read.assetData.get(asset.ref);
      if (data === undefined) return [];
      return [{ ref: asset.ref, name: asset.name ?? asset.ref, bytes: data.length, data: () => data }];
    });
  };

  const options = (): PreviewOption[] => {
    const shown = pictures();
    if (shown.length === 0) return [];
    const megabytes = shown.reduce((sum, picture) => sum + picture.bytes, 0) / 1_000_000;
    const size = formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10));
    const count = shown.length;
    return [{ id: PLOTTR_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: picturesOn, detail: t`About ${size} MB.` }];
  };

  const sceneNode = (scene: PlottrImport['folders'][number]['scenes'][number], index: number, blocks: PreviewBlock[]): PreviewNode => {
    const start = blocks.length;
    if (scene.synopsis !== '') blocks.push({ kind: 'para', text: scene.synopsis });
    if (scene.body !== '') blocks.push({ kind: 'para', text: scene.body });
    const notes: string[] = [];
    if (scene.characters.length > 0) notes.push(`Characters: ${scene.characters.join(', ')}`);
    if (scene.places.length > 0) notes.push(`Places: ${scene.places.join(', ')}`);
    return {
      id: `plottr-card-${scene.id}-${index}`,
      role: 'scene',
      title: scene.title,
      startBlock: start,
      endBlock: Math.max(start, blocks.length - 1),
      words: wordsIn(`${scene.synopsis} ${scene.body}`),
      ...(scene.synopsis === '' ? {} : { synopsis: scene.synopsis }),
      ...(scene.body === '' ? {} : { body: scene.body }),
      ...(scene.keywords.length === 0 ? {} : { keywords: scene.keywords }),
      ...(notes.length === 0 ? {} : { notes: notes.join('\n') }),
    };
  };

  const countScenes = (folders: PlottrFolder[]): number =>
    folders.reduce((sum, folder) => sum + folder.scenes.length + countScenes(folder.children), 0);

  const folderNode = (folder: PlottrFolder, blocks: PreviewBlock[]): PreviewNode => {
    const children: PreviewNode[] = [
      ...folder.children.map((child) => folderNode(child, blocks)),
      ...folder.scenes.map((scene, index) => sceneNode(scene, index, blocks)),
    ];
    return { id: `plottr-beat-${folder.id}`, role: 'container', title: folder.title, startBlock: 0, endBlock: 0, words: 0, children };
  };

  const plan = (): PreviewPlan => {
    const blocks: PreviewBlock[] = [];
    const tree: PreviewNode[] = [];
    const read = current;
    if (read !== null) {
      for (const folder of read.folders) tree.push(folderNode(folder, blocks));
      if (read.orphans.length > 0) {
        const title = t`Unsorted`;
        tree.push({
          id: 'plottr-unsorted',
          role: 'container',
          title,
          startBlock: 0,
          endBlock: 0,
          words: 0,
          children: read.orphans.map((scene, index) => {
            const start = blocks.length;
            if (scene.synopsis !== '') blocks.push({ kind: 'para', text: scene.synopsis });
            return {
              id: `plottr-orphan-${scene.id}-${index}`,
              role: 'scene',
              title: scene.title,
              startBlock: start,
              endBlock: Math.max(start, blocks.length - 1),
              words: wordsIn(scene.synopsis),
              ...(scene.synopsis === '' ? {} : { synopsis: scene.synopsis }),
              ...(scene.keywords.length === 0 ? {} : { keywords: scene.keywords }),
            };
          }),
        });
      }
      for (const [index, note] of read.research.entries()) {
        const start = blocks.length;
        const body = `# ${note.title}\n\n${note.body}`;
        for (const line of note.body.split('\n')) {
          if (line.trim() === '') continue;
          if (line.startsWith('#')) blocks.push({ kind: 'heading', text: line.replace(/^#+\s*/, '') });
          else if (line.startsWith('![')) blocks.push({ kind: 'image', text: line });
          else blocks.push({ kind: 'para', text: line });
        }
        tree.push({ id: `plottr-note-${index}`, role: 'back', title: note.title, startBlock: start, endBlock: Math.max(start, blocks.length - 1), words: wordsIn(note.body), body, place: 'research', ...(note.keywords.length === 0 ? {} : { keywords: note.keywords }) });
      }
    }
    const scenes = countScenes(read?.folders ?? []) + (read?.orphans.length ?? 0) + (read?.research.length ?? 0);
    return {
      blocks,
      markers: [],
      tree,
      counts: {
        words: blocks.reduce((sum, block) => sum + wordsIn(block.text), 0),
        parts: 0,
        chapters: 0,
        scenes,
        images: picturesOn ? (read?.assets.length ?? 0) : 0,
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
    picturesOption: PLOTTR_OPTIONS.pictures,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open(openReq, signal);
      await readAs(undefined, signal);
      loaded = true;
    },
    prepare: async (settings, signal) => {
      picturesOn = settings.options[PLOTTR_OPTIONS.pictures] ?? true;
      const chosen = settings.chips[PLOTTR_CHIPS.book];
      await readAs(chosen === '' || chosen === undefined ? undefined : chosen, signal);
      loaded = true;
    },
    prepared: () => loaded,
    dispose: () => host.dispose(),
    chips: () => {
      const read = current;
      if (read === null || read.books.length < 2) return [];
      return [{ id: PLOTTR_CHIPS.book, label: t`Book`, value: read.book.id, options: read.books.map((book) => ({ value: book.id, label: book.title })) }];
    },
    options,
    plan,
    pictures,
    metadata: () => {
      const read = current;
      if (read === null) return {};
      return read.seriesName === '' ? {} : { title: read.seriesName };
    },
    codexRows: (): PreviewCodexRow[] => {
      const read = current;
      if (read === null) return [];
      return read.codex.map((row) => ({
        id: `plottr-${row.kind}-${row.id}`,
        name: row.name,
        type: row.kind === 'character' ? 'character' : 'location',
        ...(row.description === '' ? {} : { description: row.description }),
        ...(row.keywords.length === 0 ? {} : { keywords: row.keywords }),
        page: row.page,
        preferPage: true,
      }));
    },
    // The codex pages and research bodies are not all tree text, so the scan reads them here with the names and keywords.
    scanExtra: (): ScanExtra[] => {
      const read = current;
      if (read === null) return [];
      return [
        ...read.codex.map((row) => ({ label: row.kind === 'character' ? t`Character` : t`Place`, text: `${row.name}\n${row.page.body}` })),
        ...read.research.map((note) => ({ label: t`Notes`, text: `${note.title}\n${note.body}` })),
        ...read.codex.map((row) => ({ label: t`Keywords`, text: row.keywords.join(', ') })),
      ];
    },
    report: () => {
      const read = current;
      if (read === null) return [];
      const lists = [];
      const folders = read.folders.length;
      const scenes = countScenes(read.folders) + read.orphans.length;
      const carried = [plural(scenes, { one: '# card became a scene under its beat folder', other: '# cards became scenes under their beat folders' })];
      if (folders > 0) carried.push(plural(folders, { one: '# beat became a folder', other: '# beats became folders' }));
      if (read.orphans.length > 0) {
        const orphans = read.orphans.length;
        carried.push(plural(orphans, { one: '# card sat on no beat and lands in “Unsorted”', other: '# cards sat on no beat and land in “Unsorted”' }));
      }
      const codexCount = read.codex.length;
      if (codexCount > 0) carried.push(plural(codexCount, { one: '# character or place is offered as a codex entry with its own Details page', other: '# characters and places are offered as codex entries with their own Details pages' }));
      if (read.research.length > 0) {
        const notes = read.research.length;
        carried.push(plural(notes, { one: '# note became a Research document', other: '# notes became Research documents' }));
      }
      lists.push({ heading: t`Plottr`, label: t`What the outline carried`, lines: carried });

      const approximated: string[] = [];
      const threadCount = read.threads.length;
      if (threadCount > 0) approximated.push(plural(threadCount, { one: 'The plotline is a keyword on each of its scenes, not a typed thread', other: 'The # plotlines are keywords on their scenes, not typed threads' }));
      const attrsNote = t`Every custom attribute is written as text on the codex page, not as a field`;
      if (read.codex.length > 0) approximated.push(attrsNote);
      if (approximated.length > 0) lists.push({ heading: t`Plottr`, label: t`What was approximated`, lines: approximated });
      return lists;
    },
    importLabel: () => {
      const read = current;
      const scenes = read === null ? 0 : countScenes(read.folders) + read.orphans.length + read.research.length;
      return scenes === 0 ? t`Import` : plural(scenes, { one: 'Import # document', other: 'Import # documents' });
    },
  };
}
