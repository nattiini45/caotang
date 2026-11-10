import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { detectEncoding, type EncodingIssue } from '@caotang/store';
import { encodingPanelMachine, type EncodingPanelEvent, type EncodingPanelState } from '../src/app/encoding-dialog-model.js';

const bytes = Uint8Array.from([72, 105, 32, 0x93, 0xe9, 0x94]);
const detection = detectEncoding(bytes);
const issue: EncodingIssue = { path: 'docs/old.md', kind: 'document', encoding: 'windows-1252', size: bytes.length };
const loaded: EncodingPanelEvent = { type: 'loaded', bytes, detection, issue };
const ready = encodingPanelMachine.step({ kind: 'loading' }, loaded);
const ask = (state: EncodingPanelState, request = 1): EncodingPanelState => encodingPanelMachine.step(state, { type: 'ask', request });
const answer = (request = 1): EncodingPanelEvent => ({ type: 'answered', request, encoding: 'utf-16le', note: 'Suggestion' });

describe('encoding review panels', () => {
  it('exhaustively checks every state and event, including stale replies and the closed final state', () => {
    expect(checkMachine(encodingPanelMachine, {
      states: [{ kind: 'loading' }, { kind: 'unreadable', error: 'Read failed' }, ready, ask(ready), ask(ready, 2), { kind: 'closed' }],
      events: [loaded, { type: 'unreadable', error: 'Read failed' }, { type: 'choose', encoding: 'windows-1252' },
        { type: 'action', action: 'convert' }, { type: 'action', action: 'leave' }, { type: 'ask', request: 1 },
        answer(), answer(2), { type: 'answered', request: 1, note: 'No answer' }, { type: 'close' }],
    })).toEqual([]);
  });

  it('accepts current advice, keeps the action and clears advice after a manual encoding change', () => {
    const converting = encodingPanelMachine.step(ready, { type: 'action', action: 'convert' });
    const advised = encodingPanelMachine.step(ask(converting), answer());
    expect(advised).toMatchObject({ kind: 'ready', chosen: 'utf-16le', action: 'convert', aiNote: 'Suggestion' });
    const chosen = encodingPanelMachine.step(advised, { type: 'choose', encoding: 'windows-1252' });
    expect(chosen).toMatchObject({ kind: 'ready', chosen: 'windows-1252', action: 'convert' });
    expect(chosen).not.toHaveProperty('aiNote');
  });

  it.each<EncodingPanelEvent>([{ type: 'choose', encoding: 'windows-1252' }, { type: 'action', action: 'convert' }, { type: 'action', action: 'leave' }])(
    'ignores an earlier answer after a manual $type choice', (event) => {
      const chosen = encodingPanelMachine.step(ask(ready), event);
      expect(chosen.kind).toBe('ready');
      expect(encodingPanelMachine.step(chosen, answer())).toBe(chosen);
      expect(encodingPanelMachine.step(ask(chosen, 2), answer())).toEqual(ask(chosen, 2));
    },
  );

  it('records failures or invalid answers without changing the chosen encoding', () => {
    expect(encodingPanelMachine.step(ask(ready), { type: 'answered', request: 1, note: 'Could not ask' }))
      .toMatchObject({ kind: 'ready', chosen: 'windows-1252', action: 'leave', aiNote: 'Could not ask' });
  });

  it('ignores every event after the review is closed', () => {
    const closed = encodingPanelMachine.step(ask(ready), { type: 'close' });
    for (const event of [loaded, answer(), { type: 'unreadable', error: 'Late error' }, { type: 'ask', request: 2 }] as const) {
      expect(encodingPanelMachine.step(closed, event)).toBe(closed);
    }
  });

  it('keeps unknown detections safe when no encoding candidate exists', () => {
    expect(encodingPanelMachine.step({ kind: 'loading' }, { ...loaded, issue: { ...issue, encoding: 'unknown' }, detection: { ...detection, best: 'unknown', candidates: [] } }))
      .toMatchObject({ kind: 'ready', chosen: undefined, action: 'leave' });
  });
});
