import { checkMachine } from '@caotang/machine/testing';
import { describe, expect, it } from 'vitest';

import { ModalStack, modalMachine, type ModalEvent, type ModalState } from '../src/components/modal-stack.js';

describe('the modal stack', () => {
  it('agrees with its exhaustive transition table', () => {
    const states: ModalState[] = [{ kind: 'empty', entries: [] }, { kind: 'open', entries: [{ id: 1, priority: 'dialog' }] }];
    const events: ModalEvent[] = [
      { type: 'open', entry: { id: 2, priority: 'notice' } },
      { type: 'open', entry: { id: 1, priority: 'dialog' } },
      { type: 'close', id: 1 }, { type: 'close', id: 2 },
    ];
    expect(checkMachine(modalMachine, { states, events })).toEqual([]);
  });

  it('keeps equal-priority dialogs in arrival order below a confirmation and the stopped-tab notice', () => {
    const stack = new ModalStack();
    for (const entry of [
      { id: 1, priority: 'dialog' }, { id: 2, priority: 'confirm' },
      { id: 3, priority: 'notice' }, { id: 4, priority: 'dialog' },
      { id: 5, priority: 'confirm' },
    ] as const) stack.send({ type: 'open', entry });
    expect(stack.getSnapshot().entries.map(({ id }) => id)).toEqual([1, 4, 2, 5, 3]);
    stack.send({ type: 'close', id: 3 });
    expect(stack.getSnapshot().entries.at(-1)?.id).toBe(5);
    stack.send({ type: 'close', id: 2 });
    expect(stack.getSnapshot().entries.map(({ id }) => id)).toEqual([1, 4, 5]);
    for (const id of [5, 4, 1]) stack.send({ type: 'close', id });
    expect(stack.getSnapshot()).toEqual({ kind: 'empty', entries: [] });
  });

  it('holds request payloads by identity without replacing other dialog families', () => {
    const stack = new ModalStack();
    const draft = { text: 'Keep this draft' };
    let changes = 0;
    const off = stack.subscribe(() => { changes++; });
    stack.write('settings', draft);
    stack.write('feature', { kind: 'skills' });
    stack.write('settings', draft);
    stack.send({ type: 'close', id: 99 });
    expect(changes).toBe(2);
    expect(stack.read('settings')).toBe(draft);
    stack.write('feature', null);
    expect(stack.read('settings')).toBe(draft);
    expect(stack.read('feature')).toBeNull();
    off();
    stack.write('settings', null);
    expect(changes).toBe(3);
  });
});
