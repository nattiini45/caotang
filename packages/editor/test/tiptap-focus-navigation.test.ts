// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusDom, mountInto, textNodeWith, tiptapOf } from './tiptap-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('document-boundary navigation during initial focus (#569)', () => {
  it.each([
    { key: 'Home', initial: 'The ferry was late.'.length, target: 0 },
    { key: 'End', initial: 0, target: 'The ferry was late.'.length },
  ])('keeps Ctrl+$key after the delayed focus reconciliation', async ({ key, initial, target }) => {
    vi.useFakeTimers();
    const { host } = await mountInto('The ferry was late.\n');
    const root = focusDom(host);
    const editor = tiptapOf(root);
    editor.view.setProps({ handleScrollToSelection: () => true });
    editor.commands.setTextSelection(initial + 1);
    root.focus();
    const text = textNodeWith(root, 'The ferry was late.');
    const down = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
    root.dispatchEvent(down);
    if (!down.defaultPrevented) document.getSelection()!.collapse(text, target);
    root.dispatchEvent(new KeyboardEvent('keyup', { key, ctrlKey: true, bubbles: true }));
    vi.advanceTimersByTime(20);
    expect(document.getSelection()!.anchorOffset).toBe(target);
    expect(editor.state.selection.from).toBe(target + 1);
  });

  it('extends the existing anchor with Shift and leaves unrelated or composing keys native', async () => {
    const { host } = await mountInto('The ferry was late.\n');
    const root = focusDom(host);
    const editor = tiptapOf(root);
    editor.view.setProps({ handleScrollToSelection: () => true });
    editor.commands.setTextSelection(10);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(editor.state.selection).toMatchObject({ anchor: 10, head: 1 });
    for (const options of [{}, { ctrlKey: true, altKey: true }, { ctrlKey: true, isComposing: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'Home', ...options, bubbles: true, cancelable: true });
      root.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(editor.state.selection).toMatchObject({ anchor: 10, head: 1 });
    }
  });
});
