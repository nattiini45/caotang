/**
 * The tray row of a moved picture pin (timeline.md §9.1, §4.4): it names the picture and the day it moves from and to, carries the same
 * checkbox, remove and stale behaviour as every other row, and counts as "picture pin" in the apply's breakdown. The tray is read from
 * its rendered markup, with the rows the model builds and the batch the bus projects.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import type { ReadAssetLink, ReadAssetRecord } from '@caotang/pictures';
import { addDocument, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { buildTimeline, dayLens } from '@caotang/timeline';

import type { ProjectSession } from '../src/app/session.js';
import { EMPTY_PROPOSALS, buildBatch, proposePin, type ProposalSet } from '../src/app/timeline-proposals.js';
import type { TrayState } from '../src/app/timeline-tray.js';
import { TimelineTray, describeRow } from '../src/components/timeline/TimelineTray.js';
import { createTimelineLabels } from '../src/components/timeline/timeline-labels.js';
import type { Proposals } from '../src/components/timeline/use-proposals.js';
import { activateEnglish } from '../src/i18n/runtime.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const SCENE = 'n_SCENE00001';
const LINK = 'l_0000000001';

beforeEach(() => activateEnglish());

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Pins', NOW), { now: NOW });
  addDocument(state, { id: SCENE, parentId: 'manuscript', title: 'Arrival', body: 'Arrival is written here.', now: NOW });
  state.coherence = { ...emptyCoherenceFile(), sceneMeta: { [SCENE]: { dayOffset: 0, durationDays: 30 } } } as CoherenceFile;
  const record: ReadAssetRecord = { id: 'a_0000000001', file: 'a_0000000001.png', mime: 'image/png', sha256: 'c'.repeat(64), bytes: 10, caption: 'Bridge sketch', createdAt: '2026-10-01T09:00:00.000Z' };
  const link: ReadAssetLink = { id: LINK, assetId: record.id, target: { kind: 'project' }, role: 'reference', order: 10, when: { dayOffset: 12 } };
  state.manifest.assets = [record];
  state.manifest.assetLinks = [link];
  return state;
}

function render(state: ProjectState, set: ProposalSet, announce = vi.fn()): string {
  const file = { ...emptyCoherenceFile(), sceneMeta: (state.coherence?.sceneMeta ?? {}) as CoherenceFile['sceneMeta'] } as CoherenceFile;
  const model = buildTimeline(state, file, { axis: 'story' });
  const labels = createTimelineLabels(i18n);
  const ids = new Set(set.rows.map((row) => row.id));
  const built = buildBatch(state, set.rows, ids);
  const tray: TrayState = { set, ticks: new Map(), suggestions: true };
  const analysis = { built, delta: undefined };
  const proposals = { tray, all: analysis, selected: analysis, whatIfMs: undefined } as unknown as Proposals;
  const session = { state } as unknown as ProjectSession;
  return renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <TimelineTray session={session} proposals={proposals} model={model} lens={dayLens} labels={labels} language={undefined} povName={(id) => id} offscreen={0} onShowOffscreen={() => undefined} announce={announce} onApplied={() => undefined} />
    </I18nProvider>,
  );
}

describe('the tray row of a moved pin', () => {
  it('names the picture and the day it moves from and to, and says it is a picture pin', () => {
    const state = project();
    const set = proposePin(EMPTY_PROPOSALS, state, LINK, { dayOffset: 15 });
    const file = { ...emptyCoherenceFile(), sceneMeta: (state.coherence?.sceneMeta ?? {}) as CoherenceFile['sceneMeta'] } as CoherenceFile;
    const words = describeRow(set.rows[0]!, { state } as unknown as ProjectSession, buildTimeline(state, file, { axis: 'story' }), dayLens, createTimelineLabels(i18n), (id) => id);
    expect(words.text).toBe('\u2018Bridge sketch\u2019 picture pin: Day 12 \u2192 Day 15');
    const markup = render(state, set);
    expect(markup).toContain('data-kind="pin"');
    expect(markup).toContain(`data-link="${LINK}"`);
    expect(markup).toContain('Bridge sketch');
    expect(markup).toContain('Apply 1 change');
    expect(markup).toContain('1 picture pin');
  });

  it('has a checkbox, a day field and a remove button named for the change', () => {
    const state = project();
    const markup = render(state, proposePin(EMPTY_PROPOSALS, state, LINK, { dayOffset: 15 }));
    expect(markup).toMatch(/type="checkbox"[^>]*checked/u);
    expect(markup).toContain('New day for change 1');
    expect(markup).toContain('Remove change 1:');
  });

  it('shows a pin row whose pin changed since it was proposed as out of date, with Read again and no apply', () => {
    const state = project();
    const set = proposePin(EMPTY_PROPOSALS, state, LINK, { dayOffset: 15 });
    state.manifest.assetLinks = [{ ...state.manifest.assetLinks![0]!, when: { dayOffset: 14 } }];
    const markup = render(state, set);
    expect(markup).toContain('is-stale');
    expect(markup).toContain('This changed since it was proposed, so it is not applied.');
    expect(markup).toContain('Read again');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply 0 changes/u);
  });

  it('reads a clear as no day', () => {
    const state = project();
    const set = proposePin(EMPTY_PROPOSALS, state, LINK, null);
    const file = { ...emptyCoherenceFile(), sceneMeta: (state.coherence?.sceneMeta ?? {}) as CoherenceFile['sceneMeta'] } as CoherenceFile;
    const words = describeRow(set.rows[0]!, { state } as unknown as ProjectSession, buildTimeline(state, file, { axis: 'story' }), dayLens, createTimelineLabels(i18n), (id) => id);
    expect(words.text).toBe('\u2018Bridge sketch\u2019 picture pin: Day 12 \u2192 no day');
  });
});
