import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { expect, it } from 'vitest';
import { REQUEST_PIN_REASON } from '@caotang/harness';
import { assemble, buildPreview, toChatMessages } from '../../../packages/context/src/index.js';
import { droppedContextPins } from '../src/app/context-choices.js';
import { sampleProjectState } from '../src/app/demo-sample.js';
import { PromptPreview } from '../src/components/PlanCard.js';
import { activateEnglish } from '../src/i18n/runtime.js';

it('shows a kept pinned excerpt without an unsent warning when L3 and L4 have zero budget', () => {
  activateEnglish();
  const state = sampleProjectState();
  const prior = state.manifest.tree.find((node) => node.title === 'The Landing')!;
  const focus = state.manifest.tree.find((node) => node.title === 'The Friend')!;
  const ref = { kind: 'doc' as const, id: prior.id };
  const prompt = assemble({ tool: 'scene.draft', instruction: 'Continue.', focus: focus.id, mode: 'continue', overrides: { include: [ref] } },
    { state }, { layerBudgets: { L3: 0, L4: 0, L5: 2_000 } });
  const preview = buildPreview(prompt);
  expect(preview.layers.find((layer) => layer.id === 'L4')?.drops).toContainEqual(expect.objectContaining({ ref, reason: expect.objectContaining({ kind: 'budget', budget: 0 }) }));
  expect(preview.layers.find((layer) => layer.id === 'L5')?.kept).toContainEqual(expect.objectContaining({ ref, reason: REQUEST_PIN_REASON }));
  expect(droppedContextPins(preview.layers, [ref])).toEqual([]);
  const payload = JSON.stringify(toChatMessages(prompt));
  expect(payload).toContain('The Landing (pinned excerpt)');
  expect(payload).toContain('The ferry was late, as always.');
  const html = renderToStaticMarkup(createElement(I18nProvider, { i18n, children: createElement(PromptPreview, { context: preview, pinned: [ref] }) }));
  expect(html).toContain('Pinned for this request');
  expect(html).not.toContain('Pinned context not sent');
  expect(html).toContain('The L4 budget of 0 tokens is full');
});
