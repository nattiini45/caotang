// @vitest-environment jsdom
/**
 * The ghost preview (§8, edit-anchors §5) as the live adapter mounts it: a second
 * read-only Tiptap editor under the focus document, with append and clear, Apply,
 * Retry and Discard, and the rule that its transactions are in neither undo lane.
 *
 * ## What is measured, and against what
 *
 * The lane rule is checked on the ghost's own transactions, not on its outcome: each
 * one that changes the ghost's document must carry `addToHistory: false`, which is
 * the meta `markLane` writes and the one that keeps a transaction out of the history
 * stack. An outcome-only check (the focus document is unchanged) would pass for a
 * ghost that wrote into the focus history and happened to leave the text alone.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAutosave } from '@caotang/store';
import type { DocumentWriter } from '@caotang/store';
import { positionsOf } from '../src/tiptap/ghost.js';
import { mountInto, focusDom, ghostDom, ghostRegion, selectDom, textNodeWith, tiptapOf } from './tiptap-harness.js';

const PLAIN = '# Title\n\nSome _emphasis_ and **strong** text.\n';

describe('append and clear (§8)', () => {
  it('append accumulates the streamed text and reveals the region; clear empties it and hides it again', async () => {
    const { host, instance } = await mountInto(PLAIN);
    expect(ghostRegion(host).hidden).toBe(true);
    instance.ghost.append('Once ');
    instance.ghost.append('upon a time.');
    expect(instance.ghost.text()).toBe('Once upon a time.');
    expect(ghostRegion(host).hidden).toBe(false);
    expect(ghostDom(host).textContent).toBe('Once upon a time.');
    instance.ghost.clear();
    expect(instance.ghost.text()).toBe('');
    expect(ghostRegion(host).hidden).toBe(true);
    expect(ghostDom(host).textContent).toBe('');
  });

  it('a newline in a streamed delta starts a paragraph, so streamed blocks read as blocks', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('One.\n\nTwo.');
    const paragraphs = Array.from(ghostDom(host).querySelectorAll('p')).map((p) => p.textContent);
    expect(paragraphs).toEqual(['One.', '', 'Two.']);
  });

  it('a delta split across appends joins back into one paragraph', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('Hel');
    instance.ghost.append('lo');
    const paragraphs = Array.from(ghostDom(host).querySelectorAll('p')).map((p) => p.textContent);
    expect(paragraphs).toEqual(['Hello']);
  });
});

describe('Apply, Retry and Discard (§8)', () => {
  it('apply hands the streamed body to onApply, and leaves the ghost in place until the caller clears it', async () => {
    const onApply = vi.fn();
    const { instance } = await mountInto(PLAIN, { ghost: { onApply } });
    instance.ghost.append('Draft.');
    instance.ghost.apply();
    expect(onApply).toHaveBeenCalledWith('Draft.');
    expect(instance.ghost.text()).toBe('Draft.');
  });

  it('apply does nothing while the ghost is empty', async () => {
    const onApply = vi.fn();
    const { instance } = await mountInto(PLAIN, { ghost: { onApply } });
    instance.ghost.apply();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('retry clears the ghost first, then calls onRetry, and leaves the document untouched', async () => {
    const seen: string[] = [];
    const { instance } = await mountInto(PLAIN, {
      ghost: { onRetry: () => seen.push(`ghost:${instance.ghost.text()}`) },
    });
    instance.ghost.append('Stale.');
    instance.ghost.retry();
    expect(seen).toEqual(['ghost:']);
    expect(instance.ghost.text()).toBe('');
    expect(instance.getContent()).toBe(PLAIN);
  });

  it('discard clears the ghost first, then calls onDiscard', async () => {
    const seen: string[] = [];
    const { instance } = await mountInto(PLAIN, {
      ghost: { onDiscard: () => seen.push(`ghost:${instance.ghost.text()}`) },
    });
    instance.ghost.append('Unwanted.');
    instance.ghost.discard();
    expect(seen).toEqual(['ghost:']);
    expect(instance.ghost.text()).toBe('');
    expect(instance.getContent()).toBe(PLAIN);
  });
});

describe('the ghost is in neither undo lane (§7, §8)', () => {
  it('every transaction that changes the ghost carries the lane meta, so none reaches a history stack', async () => {
    const { host, instance } = await mountInto(PLAIN);
    const ghostEditor = tiptapOf(ghostDom(host));
    const meta: Array<boolean | undefined> = [];
    ghostEditor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) meta.push(transaction.getMeta('addToHistory'));
    });
    instance.ghost.append('Streamed\n\nin two blocks.');
    instance.ghost.clear();
    expect(meta.length).toBeGreaterThan(0);
    expect(meta.every((value) => value === false)).toBe(true);
  });

  it('a user undo neither reverts nor touches the ghost, and the ghost adds nothing to the focus history', async () => {
    vi.useFakeTimers();
    try {
      const { host, instance } = await mountInto('Hello.\n');
      instance.revealRange({ from: 0, to: 0 });
      instance.insertAtSelection('Mine ');
      instance.ghost.append('Streamed.');
      expect(instance.undo()).toBe(true);
      expect(instance.getContent()).toBe('Hello.\n');
      expect(instance.ghost.text()).toBe('Streamed.');
      expect(ghostDom(host).textContent).toBe('Streamed.');
      // The ghost's appends are not in the focus history, so only the user's edit was there.
      expect(instance.undo()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a ghost append is not a change to the document: onChange and the autosave stay silent', async () => {
    vi.useFakeTimers();
    const write = vi.fn<DocumentWriter>(async (request) => ({ revision: request.expectedRevision + 1, changed: true }));
    const autosave = createAutosave({ projectId: 'project-1', source: 'write', write });
    try {
      const onChange = vi.fn();
      const { instance } = await mountInto(PLAIN, { revision: 3, onChange, autosave });
      instance.ghost.append('Not saved.');
      instance.ghost.clear();
      vi.advanceTimersByTime(10_000);
      expect(onChange).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(autosave.status('doc-under-test').dirty).toBe(false);
    } finally {
      autosave.dispose();
      vi.useRealTimers();
    }
  });
});

describe('the ghost shares the focus document’s schema (§8)', () => {
  it('builds the same node and mark names, in the same order, as the focus document', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('x');
    const focus = tiptapOf(focusDom(host)).schema;
    const ghost = tiptapOf(ghostDom(host)).schema;
    expect(Object.keys(ghost.nodes)).toEqual(Object.keys(focus.nodes));
    expect(Object.keys(ghost.marks)).toEqual(Object.keys(focus.marks));
  });

  it('a read-only ghost is not editable, and is labelled as a preview', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('x');
    expect(ghostDom(host).getAttribute('contenteditable')).toBe('false');
    expect(ghostDom(host).getAttribute('aria-readonly')).toBe('true');
  });

  it('selecting in the focus document does not select in the ghost', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('Streamed.');
    selectDom(host, textNodeWith(focusDom(host), 'strong'), 0, 6);
    expect(instance.getSelection()).not.toBeNull();
    expect(tiptapOf(ghostDom(host)).state.selection.empty).toBe(true);
  });
});

describe('a stream that fails (§8)', () => {
  it('an abort keeps the partial text, shows the reason, and disables Apply', async () => {
    const onApply = vi.fn();
    const { host, instance } = await mountInto(PLAIN, { ghost: { onApply } });
    instance.ghost.append('Partial ');
    instance.ghost.append('text.');
    // The control: before the failure the same streamed text is applicable.
    expect(instance.ghost.canApply()).toBe(true);
    instance.ghost.fail('the connection dropped');
    expect(instance.ghost.failure()).toBe('the connection dropped');
    expect(instance.ghost.text()).toBe('Partial text.');
    expect(ghostDom(host).textContent).toBe('Partial text.');
    expect(instance.ghost.canApply()).toBe(false);
    expect(ghostRegion(host).dataset['apply']).toBe('disabled');
    expect(ghostRegion(host).querySelector('[role="alert"]')?.textContent).toContain('the connection dropped');
    instance.ghost.apply();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('a failure before any text still shows its note, so the stopped stream is not silent', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.fail('the provider refused the request');
    expect(ghostRegion(host).hidden).toBe(false);
    expect(ghostRegion(host).querySelector('[role="alert"]')?.textContent).toContain('refused');
    expect(instance.ghost.canApply()).toBe(false);
  });

  it('appends after the failure are ignored, so nothing arrives after the abort', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('Partial.');
    instance.ghost.fail('aborted');
    instance.ghost.append(' Late delta.');
    expect(instance.ghost.text()).toBe('Partial.');
    expect(ghostDom(host).textContent).toBe('Partial.');
  });

  it('Retry and Discard stay live after a failure, and each clears the partial text and the failure', async () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    const { host, instance } = await mountInto(PLAIN, { ghost: { onRetry, onDiscard } });
    instance.ghost.append('Partial.');
    instance.ghost.fail('aborted');
    instance.ghost.retry();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(instance.ghost.text()).toBe('');
    expect(instance.ghost.failure()).toBeNull();
    expect(ghostRegion(host).hidden).toBe(true);
    // A retried stream is applicable again, so the failure did not outlive the retry.
    instance.ghost.append('Second try.');
    expect(instance.ghost.canApply()).toBe(true);
    instance.ghost.fail('aborted again');
    instance.ghost.discard();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(instance.ghost.failure()).toBeNull();
    expect(instance.getContent()).toBe(PLAIN);
  });
});

describe('teardown', () => {
  it('destroy removes the ghost with the instance, and a later append is harmless', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('x');
    instance.destroy();
    expect(host.querySelector('.caotang-editor-ghost')).toBeNull();
    expect(() => instance.ghost.append('y')).not.toThrow();
    expect(() => instance.ghost.clear()).not.toThrow();
  });
});

describe('note highlights (§8, the draft review)', () => {
  const marked = (host: HTMLElement): string[] => Array.from(ghostDom(host).querySelectorAll('.caotang-ghost-note')).map((span) => span.textContent ?? '');

  it('positionsOf maps a span of the text to the paragraphs it touches, two positions apart for each paragraph before it', () => {
    expect(positionsOf('One.\nTwo words.', { from: 0, to: 3 })).toEqual([{ from: 1, to: 4 }]);
    // "Two words." starts at text offset 5 and at position 7 (the first paragraph is 4 characters and 2 tokens, then the opening token).
    expect(positionsOf('One.\nTwo words.', { from: 9, to: 14 })).toEqual([{ from: 11, to: 16 }]);
    expect(positionsOf('One.\nTwo words.', { from: 2, to: 8 })).toEqual([
      { from: 3, to: 5 },
      { from: 7, to: 10 },
    ]);
    expect(positionsOf('One.\n\nTwo.', { from: 4, to: 6 })).toEqual([]);
  });

  it('marks the spans it is given as decorations of the ghost, and nothing else changes', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('The ferry came in.\n\nElena was not on it.');
    instance.ghost.highlight([
      { from: 4, to: 9 },
      { from: 20, to: 40 },
    ]);
    expect(marked(host)).toEqual(['ferry', 'Elena was not on it.']);
    expect(instance.ghost.text()).toBe('The ferry came in.\n\nElena was not on it.');
    expect(instance.ghost.canApply()).toBe(true);
    expect(instance.getContent()).toBe(PLAIN);
  });

  it('replaces the marks it had, ignores a range outside the text, and drops them when the text changes or the ghost clears', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('One two three.');
    instance.ghost.highlight([{ from: 0, to: 3 }]);
    instance.ghost.highlight([{ from: 4, to: 7 }, { from: 90, to: 99 }, { from: 5, to: 5 }, { from: -1, to: 2 }]);
    expect(marked(host)).toEqual(['two']);
    instance.ghost.append(' More.');
    expect(marked(host)).toEqual([]);
    instance.ghost.highlight([{ from: 0, to: 3 }]);
    instance.ghost.clear();
    expect(marked(host)).toEqual([]);
  });

  it('keeps the marks out of the focus document and out of both undo lanes', async () => {
    const { host, instance } = await mountInto(PLAIN);
    const ghostEditor = tiptapOf(ghostDom(host));
    const meta: Array<boolean | undefined> = [];
    ghostEditor.on('transaction', ({ transaction }) => meta.push(transaction.getMeta('addToHistory')));
    instance.ghost.append('One two.');
    instance.ghost.highlight([{ from: 0, to: 3 }]);
    expect(meta.every((value) => value === false)).toBe(true);
    expect(focusDom(host).querySelector('.caotang-ghost-note')).toBeNull();
  });
});
