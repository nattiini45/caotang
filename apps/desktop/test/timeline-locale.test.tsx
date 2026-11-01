/**
 * The counts the timeline writes as digits (the shelf's "Showing N of M", the scene counts of the axis switch) are formatted for the
 * interface language, not printed raw (i18n.md §4.1).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyCoherenceFile } from '@caotang/coherence';
import { addDocument, createEmptyManifest, createProjectState } from '@caotang/store';
import { buildTimeline } from '@caotang/timeline';

import { initialViewState } from '../src/app/timeline-model.js';
import { TimelineControls } from '../src/components/timeline/TimelineControls.js';
import { TimelineShelf } from '../src/components/timeline/TimelineShelf.js';
import { createTimelineLabels } from '../src/components/timeline/timeline-labels.js';
import { setUiLocaleTag } from '../src/i18n/format-locale.js';
import { activateEnglish } from '../src/i18n/runtime.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const SCENES = 1234;

beforeEach(() => activateEnglish());
afterEach(() => setUiLocaleTag('en'));

function shelfMarkup(): string {
  const state = createProjectState(createEmptyManifest('Many', NOW), { now: NOW });
  for (let at = 0; at < SCENES; at += 1) addDocument(state, { parentId: 'manuscript', title: `Scene ${at}`, body: 'x', now: NOW });
  const model = buildTimeline(state, emptyCoherenceFile(), { axis: 'story' });
  return renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <TimelineShelf
        model={model}
        labels={createTimelineLabels(i18n)}
        language={undefined}
        selected={new Set()}
        activeDocId={null}
        focusKey={undefined}
        onFocusKey={() => undefined}
        onToggle={() => undefined}
        onOpen={() => undefined}
        onOpenAgenda={() => undefined}
      />
    </I18nProvider>,
  );
}

function controlsMarkup(): string {
  const noop = (): void => undefined;
  return renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <TimelineControls
        view={initialViewState(1)}
        agenda={false}
        scheduled={SCENES}
        total={SCENES * 2}
        scopes={[]}
        scope={null}
        onAxis={noop}
        onZoom={noop}
        onGroupBy={noop}
        onScope={noop}
        onCompress={noop}
        onOverlay={noop}
        onFollow={noop}
        onAgenda={noop}
        onSaveImage={noop}
        onCalendar={noop}
        savingImage={false}
      />
    </I18nProvider>,
  );
}

describe('the timeline counts follow the interface language', () => {
  it('groups the shelf counts with the English separator', () => {
    const markup = shelfMarkup();
    expect(markup).toContain('Showing 60 of 1,234 scenes.');
    expect(markup).toContain('<span class="tl-count">1,234</span>');
  });

  it('groups them with the German separator under a German interface', () => {
    setUiLocaleTag('de');
    const markup = shelfMarkup();
    // The total's own `#` belongs to the catalogue's plural, which this English catalogue still groups with a comma.
    expect(markup).toContain('Showing 60 of');
    expect(markup).toContain('<span class="tl-count">1.234</span>');
  });

  it('formats the scheduled share in the axis switch', () => {
    expect(controlsMarkup()).toContain('Story time · 1,234 of 2,468 scheduled');
    setUiLocaleTag('de');
    expect(controlsMarkup()).toContain('Story time · 1.234 of 2.468 scheduled');
  });
});
