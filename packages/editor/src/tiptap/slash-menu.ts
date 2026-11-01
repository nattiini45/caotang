/**
 * The slash menu: typing `/` at the start of a line, or after a space, offers to insert a picture.
 *
 * It opens only from text the writer typed, and never while an input method is composing: a composition's text is not final until it
 * ends, and a `/` typed for another script must not open a menu over it. It is re-read when the composition ends. The menu is a
 * listbox the keyboard drives (Arrow keys, Enter or Tab to choose, Escape to dismiss) and the pointer can too.
 *
 * Choosing a picture opens the file chooser; the slash and the text typed after it are replaced by the picture in the same
 * transaction, so one undo removes the picture and leaves what the writer typed. A cancelled chooser changes nothing.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { EditorLabels } from './labels.js';
import type { PictureController } from './pictures.js';

/** What a typed query is matched against. The menu has one item today; the shape is a list so a second item needs no new keys. */
interface SlashItem {
  readonly id: string;
  readonly keywords: readonly string[];
  readonly title: (labels: EditorLabels) => string;
  readonly hint: (labels: EditorLabels) => string;
}

const ITEMS: readonly SlashItem[] = [
  { id: 'picture', keywords: ['picture', 'image', 'photo'], title: (labels) => labels.insertPicture, hint: (labels) => labels.slashPictureHint },
];

interface Open {
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

/** The slash and query before the caret, or `null`. */
const slashBefore = (state: EditorState): Open | null => {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code === true) return null;
  const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '\ufffc');
  const match = /(^|\s)\/([^\s/]{0,24})$/.exec(before);
  if (match === null) return null;
  const query = match[2] ?? '';
  return { from: $pos.pos - query.length - 1, to: $pos.pos, query };
};

const matching = (query: string): SlashItem[] => {
  const needle = query.toLowerCase();
  return ITEMS.filter((item) => needle === '' || item.keywords.some((word) => word.startsWith(needle)));
};

const isInputMethodKey = (event: KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;

export const slashMenu = (controller: PictureController, labels: EditorLabels): Plugin => {
  let menu: HTMLElement | null = null;
  let current: Open | null = null;
  let active = 0;
  /** A slash the writer dismissed stays dismissed until it is a different slash. */
  let dismissedAt: number | null = null;
  let counter = 0;

  const close = (view: EditorView): void => {
    menu?.remove();
    menu = null;
    current = null;
    view.dom.removeAttribute('aria-activedescendant');
    view.dom.removeAttribute('aria-controls');
  };

  const choose = (view: EditorView, item: SlashItem): void => {
    const open = current;
    close(view);
    if (open === null || item.id !== 'picture') return;
    dismissedAt = open.from;
    // The place is tracked: the text after the slash can change while the chooser is open and the files are stored.
    void controller.choose(view, controller.track(view, open.from, open.to));
  };

  const render = (view: EditorView, open: Open, items: readonly SlashItem[]): void => {
    const doc = view.dom.ownerDocument;
    if (menu === null) {
      menu = doc.createElement('div');
      menu.className = 'caotang-slash-menu';
      menu.setAttribute('role', 'listbox');
      menu.id = `caotang-slash-${(counter += 1)}`;
      // The menu is not a place the caret goes, so a press on it must not take focus from the document.
      menu.addEventListener('mousedown', (event) => event.preventDefault());
      doc.body.append(menu);
    }
    menu.setAttribute('aria-label', labels.slashMenu);
    active = Math.min(active, items.length - 1);
    menu.replaceChildren(
      ...items.map((item, index) => {
        const row = doc.createElement('div');
        row.className = 'caotang-slash-item';
        row.id = `${menu!.id}-${item.id}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', index === active ? 'true' : 'false');
        const title = doc.createElement('span');
        title.className = 'caotang-slash-title';
        title.textContent = item.title(labels);
        const hint = doc.createElement('span');
        hint.className = 'caotang-slash-hint';
        hint.textContent = item.hint(labels);
        row.append(title, hint);
        row.addEventListener('click', () => choose(view, item));
        return row;
      }),
    );
    view.dom.setAttribute('aria-controls', menu.id);
    view.dom.setAttribute('aria-activedescendant', `${menu.id}-${items[active]!.id}`);
    const caret = view.coordsAtPos(open.from);
    menu.style.position = 'fixed';
    menu.style.left = `${caret.left}px`;
    menu.style.top = `${caret.bottom + 4}px`;
    current = open;
  };

  const refresh = (view: EditorView, typed: boolean): void => {
    if (view.composing || view.isDestroyed) return;
    const found = slashBefore(view.state);
    const items = found === null ? [] : matching(found.query);
    if (found === null || items.length === 0) {
      dismissedAt = null;
      if (current !== null) close(view);
      return;
    }
    if (dismissedAt === found.from) return;
    // A menu that is not open opens from typing, not from the caret arriving beside a slash that was already there.
    if (current === null && !typed) return;
    if (current !== null && current.query !== found.query) active = 0;
    render(view, found, items);
  };

  return new Plugin({
    key: new PluginKey('caotangSlashMenu'),
    view: () => ({
      update(view, previous) {
        refresh(view, !previous.doc.eq(view.state.doc));
      },
      destroy() {
        menu?.remove();
        menu = null;
      },
    }),
    props: {
      handleKeyDown(view, event) {
        if (current === null || isInputMethodKey(event)) return false;
        const items = matching(current.query);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          active = (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
          render(view, current, items);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items[active];
          if (item === undefined) return false;
          choose(view, item);
          return true;
        }
        if (event.key === 'Escape') {
          dismissedAt = current.from;
          close(view);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        // The composition's text is final now; the menu was held back while it ran.
        compositionend(view) {
          view.dom.ownerDocument.defaultView?.setTimeout(() => refresh(view, true), 0);
          return false;
        },
        blur(view) {
          if (current !== null) close(view);
          return false;
        },
      },
    },
  });
};
