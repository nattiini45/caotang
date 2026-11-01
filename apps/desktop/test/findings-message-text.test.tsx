/**
 * A stored model-authored finding keeps its English across a locale switch (i18n.md §3.4; I7).
 * The codec never gives an `llm:` finding a reference; this test drives the card's own text helper,
 * so the panel path is covered directly rather than only through the codec and the render fallback.
 */
import { i18n } from '@lingui/core';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import { parseCoherenceFile } from '@caotang/coherence';
import { afterEach, describe, expect, it } from 'vitest';

import { findingMessageText } from '../src/app/findings-model.js';

const ENGLISH = 'Elena is thirty-four here, but forty in the codex.';

function storedLlmFinding(): string {
  return JSON.stringify({
    formatVersion: 1,
    findings: [
      {
        id: 'f_5H8QK2M9RT',
        runId: 'r_3W8RN2TQ6C',
        class: 'llm',
        checkId: 'llm:characterization',
        type: 'characterization',
        severity: 'warning',
        status: 'open',
        factGroup: 'c_5h8qk2m9rt|age',
        message: ENGLISH,
        evidence: [
          { docId: 'sA', quote: 'Elena is thirty-four.', from: 0, to: 20 },
          { docId: 'sB', quote: 'Elena is forty.', from: 3, to: 17 },
        ],
        createdAt: '2026-10-24T10:00:00.000Z',
        updatedAt: '2026-10-24T10:00:00.000Z',
        // An older or hand-edited file might carry one; the codec strips it for a model-authored finding.
        messageRef: { id: 'coherence.timeline.orderDrift', message: 'stale model prose', values: {} },
      },
    ],
    runs: [],
    sceneMeta: {},
    worldRules: [],
    reviewState: {},
  });
}

describe('a stored model-authored finding after a locale switch', () => {
  afterEach(() => {
    i18n.load('en-test-clean', {});
    i18n.activate('en-test-clean');
  });

  it('keeps its English as written, while a deterministic finding with the same id translates', () => {
    i18n.load('probe-llm', {
      'coherence.timeline.orderDrift': compileMessage('⟦{lateTitle} kommt vor {earlyTitle}⟧'),
    });
    i18n.activate('probe-llm');

    const outcome = parseCoherenceFile(storedLlmFinding());
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const finding = outcome.file.findings[0];
    expect(finding?.messageRef).toBeUndefined();
    expect(finding === undefined ? '' : findingMessageText(finding)).toBe(ENGLISH);

    // The probe catalogue is active: the same id on a deterministic finding renders the translation.
    const translated = findingMessageText({
      message: 'English as stored',
      messageRef: {
        id: 'coherence.timeline.orderDrift',
        message: '"{lateTitle}" comes before "{earlyTitle}"',
        values: { lateTitle: 'B', earlyTitle: 'A' },
      },
    });
    expect(translated).toContain('⟦');
    expect(translated).toContain('kommt vor');
    expect(translated).not.toContain('English as stored');
  });
});
