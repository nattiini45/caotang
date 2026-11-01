/**
 * Inline pictures in the live editor: the port the app injects, the transaction that inserts them, and the controller the toolbar,
 * a drop, a paste and the slash menu share (pictures.md §2.2, §6.4).
 *
 * The editor package never reads a file system and never imports one: the app hands in a {@link PicturesPort}. `resolve` turns a
 * source written in the body (`../assets/x.png`) into a URL the page may load, or `null` when the project has no such bytes, and
 * `importFiles` stores the files the writer chose (the app runs `asset.importBatch`) and answers with the sources to write.
 */
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** A stored picture, as the body will name it. */
export interface InsertedPicture {
  /** The body source: `../assets/<file>`. */
  readonly src: string;
  /** The alt text the picture starts with. The writer edits it in the placement popover. */
  readonly alt?: string;
}

/** Where the files came from: the chooser, a drop or a paste. The app records it on the picture. */
export type PictureOrigin = 'choose' | 'drop' | 'paste';

export interface PicturesPort {
  /** The `accept` value of the file chooser. */
  readonly accept?: string;
  /**
   * A URL for the bytes a body source names, or `null` when the project holds none. It is called only for a source that is a
   * project-relative path. A remote source is never passed in, so this is the only way a picture's bytes reach the page.
   */
  resolve(src: string): Promise<string | null>;
  /** Lets go of a URL `resolve` made. */
  release?(url: string): void;
  /** Stores the files as project pictures. It resolves with what was stored, in file order, and does not throw: the app reports the files it left out. */
  importFiles(files: readonly File[], origin: PictureOrigin): Promise<readonly InsertedPicture[]>;
}

interface Range {
  readonly from: number;
  readonly to: number;
}

interface AnchorState {
  readonly next: number;
  readonly anchors: ReadonlyMap<number, Range>;
}

type AnchorMeta = { readonly add: Range & { readonly id: number } } | { readonly drop: number };

const anchorKey = new PluginKey<AnchorState>('caotangPictureAnchors');

/**
 * Places that must follow the text while a file is being stored. An import is asynchronous and the writer keeps typing, so a position
 * taken when a drop landed would point at other text when the picture arrives.
 */
const anchorPlugin = (): Plugin<AnchorState> =>
  new Plugin<AnchorState>({
    key: anchorKey,
    state: {
      init: () => ({ next: 1, anchors: new Map() }),
      apply(tr, value) {
        const meta = tr.getMeta(anchorKey) as AnchorMeta | undefined;
        if (meta === undefined && !tr.docChanged) return value;
        const dropped = meta !== undefined && 'drop' in meta ? meta.drop : null;
        const anchors = new Map<number, Range>();
        for (const [id, range] of value.anchors) {
          if (id === dropped) continue;
          const from = tr.mapping.map(range.from, 1);
          anchors.set(id, { from, to: Math.max(from, tr.mapping.map(range.to, -1)) });
        }
        if (meta !== undefined && 'add' in meta) anchors.set(meta.add.id, { from: meta.add.from, to: meta.add.to });
        return { next: meta !== undefined && 'add' in meta ? meta.add.id + 1 : value.next, anchors };
      },
    },
  });

const trackRange = (view: EditorView, from: number, to: number): number => {
  const id = anchorKey.getState(view.state)?.next ?? 1;
  view.dispatch(view.state.tr.setMeta(anchorKey, { add: { id, from, to } } satisfies AnchorMeta));
  return id;
};

const rangeOf = (state: EditorState, id: number): Range | null => anchorKey.getState(state)?.anchors.get(id) ?? null;

const dropRange = (view: EditorView, id: number): void => {
  if (view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(anchorKey, { drop: id } satisfies AnchorMeta));
};

/**
 * The transaction that puts pictures into the document, or `null` when there is nothing to put.
 *
 * A single picture goes into the paragraph at the place. Several go one to a paragraph when the place is an empty paragraph, which is
 * how a writer lays out a sequence, and otherwise inline in order. A place inside a code block has no picture in it, so the pictures
 * go in a paragraph after it. The text in `range` is removed in the same transaction, so a slash and its picture are one undo.
 */
export const insertPicturesTransaction = (state: EditorState, pictures: readonly InsertedPicture[], range?: Range): Transaction | null => {
  const imageType = state.schema.nodes['image'];
  const paragraph = state.schema.nodes['paragraph'];
  if (imageType === undefined || paragraph === undefined || pictures.length === 0) return null;
  const nodes: PmNode[] = pictures.map((picture) => imageType.create({ src: picture.src, alt: picture.alt ?? null, title: null }));
  const tr = state.tr;
  const from = range?.from ?? state.selection.from;
  const to = range?.to ?? state.selection.to;
  if (from !== to) tr.delete(from, to);
  const at = tr.mapping.map(from);
  const $at = tr.doc.resolve(at);
  let end: number;
  if ($at.parent.inlineContent && !$at.parent.type.spec.code) {
    if ($at.parent.content.size === 0 && nodes.length > 1) {
      tr.insert(at, nodes[0]!);
      const after = tr.doc.resolve(at).after();
      tr.insert(after, nodes.slice(1).map((node) => paragraph.create(null, node)));
      // Each added paragraph is its two boundaries and one picture; the caret ends after the last picture.
      end = after + (nodes.length - 1) * 3 - 1;
    } else {
      tr.insert(at, nodes);
      end = at + nodes.length;
    }
  } else {
    const where = $at.depth > 0 ? $at.after() : at;
    tr.insert(where, nodes.map((node) => paragraph.create(null, node)));
    end = where + nodes.length * 3 - 1;
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
  // The picture is its own undo step, whatever the writer typed just before it.
  return closeHistory(tr).scrollIntoView();
};

const isPictureFile = (file: File): boolean => file.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name);

const imageFilesOf = (list: FileList | null | undefined): File[] => (list === undefined || list === null ? [] : Array.from(list).filter(isPictureFile));

export interface PictureController {
  readonly port: PicturesPort;
  /** Stores the files and inserts them at the tracked place `at`, or at the selection. Resolves with how many were inserted. */
  insertFiles(view: EditorView, files: readonly File[], origin: PictureOrigin, at?: number): Promise<number>;
  /** Opens the file chooser, then stores and inserts what was chosen. Resolves with 0 when the writer cancelled. */
  choose(view: EditorView, at?: number): Promise<number>;
  /** Marks `from`..`to` as a place to insert at. Pass the id back to `insertFiles` or `choose`. */
  track(view: EditorView, from: number, to: number): number;
  /** The extension's plugin that follows tracked places, and routes a drop and a paste of picture files. */
  plugins(): Plugin[];
}

export const createPictureController = (port: PicturesPort): PictureController => {
  const insertFiles: PictureController['insertFiles'] = async (view, files, origin, at) => {
    let pictures: readonly InsertedPicture[] = [];
    try {
      pictures = await port.importFiles(files, origin);
    } finally {
      if (pictures.length === 0 && at !== undefined) dropRange(view, at);
    }
    if (view.isDestroyed || pictures.length === 0) return 0;
    const range = at === undefined ? undefined : (rangeOf(view.state, at) ?? undefined);
    const tr = insertPicturesTransaction(view.state, pictures, range);
    if (at !== undefined) dropRange(view, at);
    if (tr === null) return 0;
    view.dispatch(tr);
    return pictures.length;
  };

  const choose: PictureController['choose'] = (view, at) =>
    new Promise<number>((resolve) => {
      const doc = view.dom.ownerDocument;
      const input = doc.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.hidden = true;
      input.setAttribute('data-caotang-picture-input', '');
      if (port.accept !== undefined) input.accept = port.accept;
      let settled = false;
      const finish = (files: readonly File[]): void => {
        if (settled) return;
        settled = true;
        input.remove();
        if (files.length === 0) {
          if (at !== undefined) dropRange(view, at);
          resolve(0);
          return;
        }
        void insertFiles(view, files, 'choose', at).then(resolve, () => resolve(0));
      };
      input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
      input.addEventListener('cancel', () => finish([]));
      doc.body.append(input);
      input.click();
    });

  return {
    port,
    insertFiles,
    choose,
    track: trackRange,
    plugins: () => [
      anchorPlugin(),
      new Plugin({
        key: new PluginKey('caotangPictureFiles'),
        props: {
          handleDrop(view, event) {
            const files = imageFilesOf(event.dataTransfer?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            const dropped = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
            void insertFiles(view, files, 'drop', trackRange(view, dropped, dropped));
            return true;
          },
          handlePaste(view, event) {
            const files = imageFilesOf(event.clipboardData?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            void insertFiles(view, files, 'paste', trackRange(view, view.state.selection.from, view.state.selection.to));
            return true;
          },
        },
      }),
    ],
  };
};
