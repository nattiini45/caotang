import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@caotang/gateway';

import { fitToWindow } from '../../src/index.js';

describe('planner messages fit the known model window', () => {
  it('clears an older result without changing its native call pair or the newest result', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Follow the writer’s instructions.' },
      { role: 'user', content: 'Read both chapters.' },
      { role: 'assistant', content: '', toolCalls: [
        { id: 'first', name: 'doc.read', argumentsJson: '{"doc":"Chapter 1"}' },
        { id: 'second', name: 'doc.read', argumentsJson: '{"doc":"Chapter 2"}' },
      ], reasoning: [{ text: 'Read the earlier chapter first.', raw: { signed: 'opaque' } }] },
      { role: 'tool', toolCallId: 'first', content: 'x'.repeat(4_000) },
      { role: 'tool', toolCallId: 'second', content: 'The latest chapter ends at the river.' },
    ];

    const fitted = fitToWindow(messages, { windowTokens: 200, reserveTokens: 40, keepToolResults: 1 });

    expect(fitted.fits).toBe(true);
    expect(fitted.cleared).toEqual([{ tool: 'doc.read', toolCallId: 'first', tokens: 1_000 }]);
    expect(fitted.messages).toHaveLength(5);
    expect(fitted.messages.slice(0, 3)).toEqual(messages.slice(0, 3));
    expect(fitted.messages[3]).toEqual({
      role: 'tool', toolCallId: 'first',
      content: '[doc.read result cleared to save room; call it again if you need it]',
    });
    expect(fitted.messages[4]).toEqual(messages[4]);
    expect(messages[3]?.content).toHaveLength(4_000);
  });

  it('does not enlarge a small result when the protected tail still exceeds the window', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [
        { id: 'first', name: 'doc.read', argumentsJson: '{"doc":"Chapter 1"}' },
        { id: 'second', name: 'doc.read', argumentsJson: '{"doc":"Chapter 2"}' },
      ] },
      { role: 'tool', toolCallId: 'first', content: 'ok' },
      { role: 'tool', toolCallId: 'second', content: 'x'.repeat(4_000) },
    ];

    const fitted = fitToWindow(messages, { windowTokens: 200, reserveTokens: 40, keepToolResults: 1 });

    expect(fitted.fits).toBe(false);
    expect(fitted.cleared).toEqual([]);
    expect(fitted.messages).toEqual(messages);
  });

  it('clears oldest first and stops as soon as the remaining messages fit', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: ['first', 'second', 'third', 'last'].map((id) => ({
        id, name: 'doc.read', argumentsJson: JSON.stringify({ doc: id }),
      })) },
      ...['first', 'second'].map((toolCallId): ChatMessage => ({ role: 'tool', toolCallId, content: 'x'.repeat(4_000) })),
      { role: 'tool', toolCallId: 'third', content: 'y'.repeat(2_000) },
      { role: 'tool', toolCallId: 'last', content: 'The latest result.' },
    ];

    const fitted = fitToWindow(messages, { windowTokens: 600, reserveTokens: 40, keepToolResults: 1 });

    expect(fitted.fits).toBe(true);
    expect(fitted.cleared.map((entry) => entry.toolCallId)).toEqual(['first', 'second']);
    expect(fitted.messages.slice(-2)).toEqual(messages.slice(-2));
    expect(fitToWindow(messages, { windowTokens: 600, reserveTokens: 40, keepToolResults: 1 })).toEqual(fitted);
    expect(fitToWindow(fitted.messages, { windowTokens: 600, reserveTokens: 40, keepToolResults: 1 }).cleared).toEqual([]);
  });

  it('leaves every result intact when the model window is unknown', () => {
    const messages: ChatMessage[] = [{ role: 'tool', toolCallId: 'first', content: 'x'.repeat(4_000) }];

    expect(fitToWindow(messages, { reserveTokens: 40, keepToolResults: 0 })).toEqual({
      messages, cleared: [], fits: true,
    });
  });

  it('preserves oversized writer instructions and says that clearing cannot make them fit', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Follow the writer’s instructions.' },
      { role: 'user', content: 'x'.repeat(4_000) },
      { role: 'assistant', content: 'The writer’s request is still needed.', reasoning: [{ text: 'Keep it intact.' }] },
    ];

    expect(fitToWindow(messages, { windowTokens: 200, reserveTokens: 40, keepToolResults: 0 })).toEqual({
      messages, cleared: [], fits: false,
    });
  });

  it('removes a cleared result’s cached parts so an adapter cannot resend its original body', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'first', name: 'doc.read', argumentsJson: '{"doc":"Chapter 1"}' }] },
      { role: 'tool', toolCallId: 'first', content: 'x'.repeat(4_000), parts: [{ text: 'x'.repeat(4_000), cacheBoundary: true }], isError: true },
    ];

    const fitted = fitToWindow(messages, { windowTokens: 200, reserveTokens: 40, keepToolResults: 0 });

    expect(fitted.fits).toBe(true);
    expect(fitted.messages[1]).not.toHaveProperty('parts');
    expect(fitted.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'first', isError: true });
    expect(messages[1]?.parts?.[0]?.text).toHaveLength(4_000);
  });

  it('keeps a request that exactly leaves its reserved output room', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(40) }];

    expect(fitToWindow(messages, { windowTokens: 100, reserveTokens: 90, keepToolResults: 3 })).toEqual({
      messages, cleared: [], fits: true,
    });
  });
});
