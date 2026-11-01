/**
 * The three demo intents the first-run card and the empty states offer (context-assembly §6). The sample manuscript they run on
 * is `demo-sample.ts`; it is project content and is not translated.
 */

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { DEMO_INTENTS } from '@caotang/gateway/mock';

export { LANDING_BODY, SAMPLE_TITLE, STORM_BODY, sampleProjectState } from './demo-sample.js';

/** The words each demo button shows. They are descriptors, resolved when a button is drawn, so no `t` runs at import. */
const DEMO_LABELS: Readonly<Record<'draftScene' | 'fillSynopses' | 'continuity', MessageDescriptor>> = {
  draftScene: msg`Draft the opening scene`,
  fillSynopses: msg`Fill in the synopses`,
  continuity: msg`Check for continuity problems`,
};

interface DemoChoice {
  readonly intent: string;
  /** The button's words, in the active locale, read when the button is drawn. */
  readonly label: string;
}

/** The three zero-key demo intents, with the labels the card shows for them. */
export const DEMO_CHOICES: readonly DemoChoice[] = [
  { intent: DEMO_INTENTS.draftScene, get label() { return i18n._(DEMO_LABELS.draftScene); } },
  { intent: DEMO_INTENTS.fillSynopses, get label() { return i18n._(DEMO_LABELS.fillSynopses); } },
  { intent: DEMO_INTENTS.continuity, get label() { return i18n._(DEMO_LABELS.continuity); } },
];
