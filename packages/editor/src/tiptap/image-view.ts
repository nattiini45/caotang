/**
 * The image node's view: the picture the port resolves, a placeholder when it cannot be shown, and the placement popover.
 *
 * - A source that is a project path is shown through the port's `resolve`. Bytes the project does not hold show a placeholder that
 *   names the file, so a body that outlives its asset still reads.
 * - A source that is not a project path (a scheme, a network path) is never loaded. The view shows its alt text as before, whatever
 *   the port could do.
 * - An image that is alone in its paragraph is a `figure` with its caption; one inside a sentence is an inline `span`. The editor
 *   decorates the first kind (`aloneImages`), and a change of kind makes the view build a new element.
 * - The popover edits alt text, caption, decorative and size. Applying writes the title through the placement codec and clears the
 *   node's source provenance, so that placement saves as a direct image and nothing else in the body moves.
 */
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { NodeView } from '@tiptap/pm/view';
import { PLACEMENT_SIZES, decodePlacementTitle, encodePlacementTitle, placementCaptionOf } from '@caotang/pictures';
import type { PlacementSize } from '@caotang/pictures';
import { isAppLocalSource } from './local-source.js';
import type { EditorLabels } from './labels.js';
import type { PicturesPort } from './pictures.js';

/** The event the keyboard sends a picture's view to open its popover. */
export const EDIT_PICTURE_EVENT = 'caotang:edit-picture';

const ALONE = 'data-alone';

/** Marks every image that is the whole content of its paragraph. Only block structure is walked, never the text. */
export const aloneImages = (): Plugin =>
  new Plugin({
    key: new PluginKey('caotangAloneImages'),
    state: {
      init: (_config, state) => build(state.doc),
      apply: (tr, value) => (tr.docChanged ? build(tr.doc) : value),
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });

const build = (doc: PmNode): DecorationSet => {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') {
      if (node.childCount === 1 && node.child(0).type.name === 'image') decorations.push(Decoration.node(pos + 1, pos + 2, { [ALONE]: 'true' }, { alone: true }));
      return false;
    }
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, decorations);
};

const isAlone = (decorations: readonly Decoration[]): boolean =>
  decorations.some((decoration) => (decoration.spec as { alone?: boolean } | undefined)?.alone === true);

/** The file name a project path ends in, for the placeholder. */
const fileNameOf = (src: string): string => {
  const last = src.split(/[\\/]/).pop() ?? src;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

const SIZE_LABEL: Readonly<Record<PlacementSize, keyof EditorLabels>> = { full: 'sizeFull', half: 'sizeHalf', inline: 'sizeInline' };

export interface ImageViewOptions {
  readonly port: PicturesPort | null;
  readonly labels: EditorLabels;
}

export const createImageView =
  (options: ImageViewOptions) =>
  ({ node: initial, view, getPos, decorations }: NodeViewRendererProps): NodeView => {
    const { port, labels } = options;
    const doc = view.dom.ownerDocument;
    let node = initial;
    const alone = isAlone(decorations);

    const dom = doc.createElement(alone ? 'figure' : 'span');
    dom.className = 'caotang-picture';
    dom.contentEditable = 'false';
    const media = doc.createElement('span');
    media.className = 'caotang-picture-media';
    const edit = doc.createElement('button');
    edit.type = 'button';
    edit.className = 'caotang-picture-edit';
    edit.setAttribute('aria-label', labels.pictureSettings);
    edit.title = labels.pictureSettings;
    edit.textContent = '\u270E';
    const caption = alone ? doc.createElement('figcaption') : null;
    dom.append(media, edit);
    if (caption !== null) dom.append(caption);

    let shown: { readonly src: string; url: string | null } | null = null;
    let requested = '';
    let popover: (() => void) | null = null;

    const placeholder = (state: 'loading' | 'missing' | 'remote', text: string): void => {
      const holder = doc.createElement('span');
      holder.className = 'caotang-image-placeholder';
      holder.setAttribute('data-state', state);
      holder.textContent = text;
      if (state === 'remote') holder.title = labels.imageRemote;
      media.replaceChildren(holder);
    };

    const release = (): void => {
      if (shown !== null && shown.url !== null) port?.release?.(shown.url);
      shown = null;
    };

    const picture = (url: string): void => {
      const img = doc.createElement('img');
      img.src = url;
      img.draggable = false;
      media.replaceChildren(img);
      syncText();
    };

    /** The attributes that do not need the bytes: alt text, caption, size and decoration. */
    const syncText = (): void => {
      const src = String(node.attrs['src'] ?? '');
      const alt = typeof node.attrs['alt'] === 'string' ? node.attrs['alt'] : '';
      const title = typeof node.attrs['title'] === 'string' ? node.attrs['title'] : '';
      const decoded = decodePlacementTitle(title);
      const decorative = decoded.kind === 'placement' && decoded.decorative;
      dom.setAttribute('data-size', decoded.kind === 'placement' ? decoded.size : 'full');
      if (decorative) dom.setAttribute('data-decorative', 'true');
      else dom.removeAttribute('data-decorative');
      const img = media.querySelector('img');
      if (img !== null) {
        img.alt = decorative ? '' : alt;
        if (decorative) img.setAttribute('role', 'presentation');
        else img.removeAttribute('role');
      }
      const words = placementCaptionOf(title);
      if (caption !== null) {
        caption.textContent = words;
        caption.hidden = words === '';
      }
      if (words === '') dom.removeAttribute('title');
      else dom.title = words;
      if (img === null && !isAppLocalSource(src)) placeholder('remote', alt.length > 0 ? alt : labels.image);
    };

    const paint = (): void => {
      const src = String(node.attrs['src'] ?? '');
      if (!isAppLocalSource(src)) {
        release();
        requested = '';
        syncText();
        return;
      }
      if (port === null) {
        const img = doc.createElement('img');
        img.src = src;
        img.draggable = false;
        media.replaceChildren(img);
        syncText();
        return;
      }
      if (requested === src) {
        syncText();
        return;
      }
      requested = src;
      release();
      placeholder('loading', labels.imageLoading);
      syncText();
      port.resolve(src).then(
        (url) => {
          if (requested !== src) {
            if (url !== null) port.release?.(url);
            return;
          }
          if (url === null) {
            placeholder('missing', labels.imageMissing(fileNameOf(src)));
            syncText();
            return;
          }
          shown = { src, url };
          picture(url);
        },
        () => {
          if (requested === src) {
            placeholder('missing', labels.imageMissing(fileNameOf(src)));
            syncText();
          }
        },
      );
    };

    const closePopover = (): void => {
      popover?.();
      popover = null;
    };

    const openPopover = (): void => {
      closePopover();
      const at = getPos();
      if (at === undefined) return;
      const attrs = node.attrs;
      const title = typeof attrs['title'] === 'string' ? attrs['title'] : '';
      const decoded = decodePlacementTitle(title);
      const opaque = decoded.kind === 'opaque-version';
      const startCaption = decoded.kind === 'placement' ? decoded.caption : decoded.raw;
      const startSize: PlacementSize = decoded.kind === 'placement' ? decoded.size : 'full';
      const startDecorative = decoded.kind === 'placement' && decoded.decorative;

      const box = doc.createElement('form');
      box.className = 'caotang-picture-popover';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', labels.pictureSettings);
      const field = (label: string, control: HTMLElement): void => {
        const row = doc.createElement('label');
        row.className = 'caotang-picture-field';
        const name = doc.createElement('span');
        name.textContent = label;
        row.append(name, control);
        box.append(row);
      };
      const altInput = doc.createElement('input');
      altInput.type = 'text';
      altInput.value = typeof attrs['alt'] === 'string' ? attrs['alt'] : '';
      altInput.setAttribute('data-field', 'alt');
      const captionInput = doc.createElement('input');
      captionInput.type = 'text';
      captionInput.value = startCaption;
      captionInput.disabled = opaque;
      captionInput.setAttribute('data-field', 'caption');
      const decorativeInput = doc.createElement('input');
      decorativeInput.type = 'checkbox';
      decorativeInput.checked = startDecorative;
      decorativeInput.disabled = opaque;
      decorativeInput.setAttribute('data-field', 'decorative');
      const sizeInput = doc.createElement('select');
      sizeInput.disabled = opaque;
      sizeInput.setAttribute('data-field', 'size');
      for (const size of PLACEMENT_SIZES) {
        const option = doc.createElement('option');
        option.value = size;
        option.textContent = String(labels[SIZE_LABEL[size]]);
        option.selected = size === startSize;
        sizeInput.append(option);
      }
      field(labels.pictureAlt, altInput);
      field(labels.pictureCaption, captionInput);
      field(labels.pictureDecorative, decorativeInput);
      field(labels.pictureSize, sizeInput);

      const actions = doc.createElement('div');
      actions.className = 'caotang-picture-actions';
      const apply = doc.createElement('button');
      apply.type = 'submit';
      apply.textContent = labels.pictureApply;
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.textContent = labels.pictureCancel;
      actions.append(apply, cancel);
      box.append(actions);

      const rect = dom.getBoundingClientRect();
      box.style.position = 'fixed';
      box.style.left = `${Math.max(8, rect.left)}px`;
      box.style.top = `${rect.bottom + 6}px`;

      const onPointerDown = (event: Event): void => {
        const target = event.target as Node | null;
        if (target !== null && !box.contains(target) && !dom.contains(target)) close();
      };
      const close = (): void => {
        doc.removeEventListener('pointerdown', onPointerDown, true);
        box.remove();
        popover = null;
      };
      const finish = (): void => {
        close();
        if (!view.isDestroyed) view.focus();
      };

      box.addEventListener('submit', (event) => {
        event.preventDefault();
        const pos = getPos();
        if (pos === undefined || view.isDestroyed) return finish();
        const caption = captionInput.value;
        const size = sizeInput.value as PlacementSize;
        const decorative = decorativeInput.checked;
        let nextTitle: string | null = title === '' ? null : title;
        if (decoded.kind === 'placement' && (caption !== startCaption || size !== startSize || decorative !== startDecorative)) {
          nextTitle = encodePlacementTitle({ caption, size, decorative, extras: decoded.extras });
        }
        const alt = altInput.value;
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...attrs, alt: alt === '' ? null : alt, title: nextTitle, prov: undefined }));
        finish();
      });
      cancel.addEventListener('click', finish);
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          finish();
        }
      });
      doc.body.append(box);
      doc.addEventListener('pointerdown', onPointerDown, true);
      popover = close;
      altInput.focus();
    };

    edit.addEventListener('click', openPopover);
    dom.addEventListener('dblclick', openPopover);
    dom.addEventListener(EDIT_PICTURE_EVENT, openPopover);
    paint();

    return {
      dom,
      update(next: PmNode, nextDecorations: readonly Decoration[]): boolean {
        if (next.type !== node.type) return false;
        if (isAlone(nextDecorations) !== alone) return false;
        node = next;
        paint();
        return true;
      },
      stopEvent: (event: Event): boolean => event.target === edit || edit.contains(event.target as Node),
      destroy(): void {
        closePopover();
        release();
        requested = '';
      },
    };
  };
