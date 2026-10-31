/**
 * The Proposed changes tray ([timeline.md §4.4, §4.5](docs/architecture/timeline.md)): one row for each change a gesture, an Agenda cell
 * or a finding's quick action proposed, the what-if delta they would have, and the buttons that apply them as one batch.
 *
 * Nothing here writes to the project except the Apply buttons, and they dispatch one `timeline.apply`. A row keeps the value it read, so
 * a change made elsewhere since shows as out of date, and the row is not applied until it is read again or removed.
 */

import { useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { CalendarLens, StoryPart, TimelineLabels, TimelineModel } from '@caotang/timeline';

import { pictureNameOf } from '../../app/timeline-pictures.js';
import { SUGGESTIONS_VISIBLE, batchWords, datedInsideMain, pinWithDay, type MetaRow, type MoveRow, type Row, type ShiftRow } from '../../app/timeline-proposals.js';
import { isTicked } from '../../app/timeline-tray.js';
import type { WhatIfFinding } from '../../app/timeline-what-if.js';
import { accessibleText } from '../../i18n/accessible-text.js';
import { formatCount } from './timeline-count.js';
import { UserText } from '../../i18n/UserText.js';
import type { ProjectSession } from '../../app/session.js';
import type { Proposals } from './use-proposals.js';
import { ValueField } from './ValueField.js';

/* lingui-set comment="The timeline's Proposed changes tray. Interpolated values: title, name, other, parent, from, to, part, day, days, count, total, shown, hidden, delta are scene titles, part words, day labels or counts." */

export interface TimelineTrayProps {
  readonly session: ProjectSession;
  readonly proposals: Proposals;
  readonly model: TimelineModel;
  readonly lens: CalendarLens;
  readonly labels: TimelineLabels;
  readonly language: string | undefined;
  readonly povName: (id: string) => string;
  /** Rows whose scene is not on screen. */
  readonly offscreen: number;
  readonly onShowOffscreen: () => void;
  readonly announce: (text: string) => void;
  readonly onApplied: () => void;
}

type ModeKey = Parameters<TimelineLabels['modeName']>[0];

interface Words {
  readonly text: string;
  readonly part: StoryPart;
  readonly notable: boolean;
  readonly inside: boolean;
}

function quoted(title: string): string {
  return `\u2018${title}\u2019`;
}

export function describeRow(row: Row, session: ProjectSession, model: TimelineModel, lens: CalendarLens, labels: TimelineLabels, povName: (id: string) => string): Words {
  const titleOf = (id: string): string => session.state.manifest.tree.find((node) => node.id === id)?.title || id;
  const item = (id: string) => model.items.find((candidate) => candidate.nodeId === id);
  const dayText = (day: number | null): string => (day === null ? t`no day` : lens.label(day, 'long'));
  if (row.kind === 'shift') return describeShift(row, labels, lens);
  if (row.kind === 'pin') {
    const name = quoted(pictureNameOf(session.state, row.assetId));
    const from = dayText(row.base?.dayOffset ?? null);
    const to = dayText(row.to?.dayOffset ?? null);
    return { text: t`${{ name }} picture pin: ${{ from }} \u2192 ${{ to }}`, part: 'main', notable: false, inside: false };
  }
  const title = quoted(titleOf(row.nodeId));
  const here = item(row.nodeId);
  const partNow: StoryPart = here?.part ?? 'main';
  if (row.kind === 'move') return describeMove(row, title, partNow, titleOf);
  const bits: string[] = [];
  const partAfter: StoryPart = row.part === undefined || row.part.to === null ? partNow : row.part.to;
  if (row.part !== undefined) {
    const from = labels.partName(row.part.base ?? partNow);
    const to = row.part.to === null ? t`inherited from its folder` : labels.partName(row.part.to);
    bits.push(t`${{ from }} \u2192 ${{ to }}`);
  }
  if (row.day !== undefined) bits.push(`${dayText(row.day.base)} \u2192 ${dayText(row.day.to)}`);
  if (row.duration !== undefined) {
    const from = row.duration.base ?? 0;
    const to = row.duration.to ?? 0;
    bits.push(t`length ${plural(from, { one: '# day', other: '# days' })} \u2192 ${plural(to, { one: '# day', other: '# days' })}`);
  }
  if (row.mode !== undefined) bits.push(t`mode ${{ from: labels.modeName((row.mode.base ?? 'linear') as ModeKey) }} \u2192 ${{ to: labels.modeName((row.mode.to ?? 'linear') as ModeKey) }}`);
  if (row.pov !== undefined) {
    const from = row.pov.base === null ? t`nobody` : povName(row.pov.base);
    const to = row.pov.to === null ? t`nobody` : povName(row.pov.to);
    bits.push(t`point of view ${{ from }} \u2192 ${{ to }}`);
  }
  if (row.after !== undefined) {
    for (const id of row.after.add) {
      const name = quoted(titleOf(id));
      bits.push(t`must follow ${{ name }}`);
    }
    for (const id of row.after.remove) {
      const name = quoted(titleOf(id));
      bits.push(t`no longer has to follow ${{ name }}`);
    }
  }
  const main = model.zones.find((zone) => zone.part === 'main');
  const dayAfter = row.day === undefined ? (here?.dayOffset ?? null) : row.day.to;
  const inside = (row.day !== undefined || row.part !== undefined) && datedInsideMain(partAfter, dayAfter, main === undefined ? undefined : { ...(main.startDay !== undefined ? { start: main.startDay } : {}), ...(main.endDay !== undefined ? { end: main.endDay } : {}) });
  const notable = partNow !== 'main' || row.part !== undefined;
  const name = labels.partName(partAfter).toLowerCase();
  const head = notable ? t`${{ title }} (${{ name }})` : title;
  return { text: `${head}: ${bits.join(', ')}`, part: partAfter, notable, inside };
}

function describeMove(row: MoveRow, title: string, part: StoryPart, titleOf: (id: string) => string): Words {
  const parent = quoted(titleOf(row.to.parentId));
  const text =
    row.to.anchorId === null
      ? t`${{ title }} moved to the start of ${{ parent }}`
      : (() => {
          const other = quoted(titleOf(row.to.anchorId));
          return t`${{ title }} moved after ${{ other }} in ${{ parent }}`;
        })();
  return { text, part, notable: false, inside: false };
}

function describeShift(row: ShiftRow, labels: TimelineLabels, lens: CalendarLens): Words {
  void labels;
  void lens;
  const count = row.nodeIds.length;
  const delta = row.delta > 0 ? `+${row.delta}` : `\u2212${Math.abs(row.delta)}`;
  return { text: t`Shift ${plural(count, { one: '# scene', other: '# scenes' })} by ${{ delta }} days`, part: 'main', notable: false, inside: false };
}

export function TimelineTray(props: TimelineTrayProps): ReactNode {
  const { session, proposals, model, lens, labels, language, povName } = props;
  const rows = proposals.tray.set.rows;
  const [moreOpen, setMoreOpen] = useState(false);
  if (rows.length === 0) return null;

  const status = (row: Row) => {
    const mine = proposals.all.built.status.get(row.id);
    const other = proposals.selected.built.status.get(row.id);
    return mine !== undefined && mine.state !== 'skipped' ? mine : (other ?? mine);
  };
  const number = new Map(rows.map((row, at) => [row.id, at + 1]));
  const ordinary = rows.filter((row) => row.origin !== 'suggestion');
  const suggested = rows.filter((row) => row.origin === 'suggestion');
  const offscreen = props.offscreen;
  const visibleSuggested = moreOpen ? suggested : suggested.slice(0, SUGGESTIONS_VISIBLE);
  const hiddenSuggested = suggested.length - visibleSuggested.length;
  const suggestionsOn = proposals.tray.suggestions;

  const totalAll = proposals.all.built.projection?.counts.total ?? 0;
  const tickedCount = rows.filter((row) => isTicked(proposals.tray, row) && (proposals.selected.built.status.get(row.id)?.state ?? 'skipped') === 'ok').length;
  const words = batchWords(proposals.all.built.projection);
  const breakdown = words.parts.map((part) => kindWords(part.kind, part.count)).join(', ');

  const run = (only: 'all' | 'selected'): void => {
    const result = proposals.apply(only);
    if (result.ok) {
      const count = result.count;
      props.announce(plural(count, { one: '# change applied. Undo restores it.', other: '# changes applied. Undo restores them.' }));
      props.onApplied();
    } else if (result.message !== undefined) props.announce(result.message);
    else props.announce(t`There is nothing to apply: every change is out of date or left unchecked.`);
  };

  const rowView = (row: Row): ReactNode => {
    const info = describeRow(row, session, model, lens, labels, povName);
    const state = status(row);
    const stale = state?.state === 'stale';
    const invalid = state?.state === 'invalid';
    const n = number.get(row.id) as number;
    const ticked = isTicked(proposals.tray, row);
    const plain = accessibleText(info.text);
    return (
      <li key={row.id} className={`tl-row-proposal${stale ? ' is-stale' : ''}${invalid ? ' is-invalid' : ''}${row.origin === 'suggestion' ? ' is-suggestion' : ''}`} data-row={row.id} data-kind={row.kind} data-node={row.kind === 'shift' || row.kind === 'pin' ? undefined : row.nodeId} data-link={row.kind === 'pin' ? row.linkId : undefined}>
        <label className="tl-check">
          <input type="checkbox" checked={ticked} onChange={(event) => proposals.tick(row.id, event.target.checked)} aria-label={t`Include change ${{ n }}: ${{ plain }}`} />
          <span className="tl-number" aria-hidden="true">
            {n}
          </span>
        </label>
        <div className="tl-row-body">
          <p className="tl-row-text">
            <UserText value={info.text} lang={language} />
          </p>
          {row.kind === 'meta' && row.because !== undefined ? <SuggestionWhy row={row} session={session} /> : null}
          {info.inside ? (
            <p className="tl-row-note" role="note">
              <Trans>This dates the scene inside the main story, which a prologue or an epilogue does not sit in.</Trans>
            </p>
          ) : null}
          {stale ? (
            <p className="tl-row-note is-warning" role="note">
              <Trans>This changed since it was proposed, so it is not applied. Read it again, or remove it.</Trans>
            </p>
          ) : null}
          {invalid ? (
            <p className="tl-row-note is-error" role="note">
              {state?.message ?? ''}
            </p>
          ) : null}
        </div>
        {row.kind === 'meta' && row.day !== undefined && row.day.to !== null ? (
          <ValueField label={t`New day for change ${{ n }}`} value={row.day.to} onCommit={(day) => day !== null && proposals.meta((row as MetaRow).nodeId, { day }, row.origin)} />
        ) : null}
        {row.kind === 'pin' && row.to?.dayOffset !== undefined ? (
          <ValueField label={t`New day for change ${{ n }}`} value={row.to.dayOffset} onCommit={(day) => day !== null && proposals.pin(row.linkId, pinWithDay(row.to, day), row.origin)} />
        ) : null}
        {row.kind === 'shift' ? <ValueField label={t`Days to shift for change ${{ n }}`} value={row.delta} onCommit={(delta) => delta !== null && proposals.setDelta(row.id, delta)} /> : null}
        <div className="tl-row-actions">
          {stale ? (
            <button type="button" className="button is-quiet" onClick={() => proposals.rebase(row.id)}>
              <Trans>Read again</Trans>
            </button>
          ) : null}
          <button type="button" className="button is-quiet" aria-label={t`Remove change ${{ n }}: ${{ plain }}`} onClick={() => proposals.remove(row.id)}>
            <Trans>Remove</Trans>
          </button>
        </div>
      </li>
    );
  };

  const delta = proposals.all.delta;
  const selectedDelta = proposals.selected.delta;
  const same = proposals.selected.delta === proposals.all.delta;

  return (
    <section className="tl-tray" id="tl-tray" tabIndex={-1} aria-label={t`Proposed changes`} data-testid="timeline-tray" data-whatif-ms={proposals.whatIfMs === undefined ? undefined : Math.round(proposals.whatIfMs)}>
      <h3 className="tl-tray-title">
        <Trans>Proposed changes</Trans> <span className="tl-count">{formatCount(ordinary.length)}</span>
      </h3>
      <p className="field-note">
        <Trans>Nothing is written to the project until you apply. Applying is one step, and Undo takes it back.</Trans>
      </p>
      {props.offscreen > 0 ? (
        <button type="button" className="button is-quiet tl-offscreen" onClick={props.onShowOffscreen}>
          {plural(offscreen, { one: '# change is off-screen', other: '# changes are off-screen' })}
        </button>
      ) : null}
      <ol className="tl-rows" aria-label={t`Changes`}>
        {ordinary.map(rowView)}
      </ol>
      {suggestionsOn && suggested.length > 0 ? (
        <div className="tl-suggestions" role="group" aria-label={t`Suggested follow-ups`}>
          <h4>
            <Trans>Suggested follow-ups</Trans>
          </h4>
          <p className="field-note">
            <Trans>These scenes must follow a scene you moved. They stay unchecked until you check them.</Trans>
          </p>
          <ol className="tl-rows">{visibleSuggested.map(rowView)}</ol>
          {hiddenSuggested > 0 ? (
            <button type="button" className="button is-quiet" onClick={() => setMoreOpen(true)}>
              {t`Show ${{ hidden: formatCount(hiddenSuggested) }} more suggestions`}
            </button>
          ) : null}
          <button type="button" className="button is-quiet" onClick={() => proposals.tickSuggestions(true)}>
            <Trans>Check all suggestions</Trans>
          </button>
        </div>
      ) : null}
      <div className="tl-whatif" role="status" aria-live="polite" data-testid="timeline-whatif">
        {delta === undefined ? null : <WhatIf label={t`If you apply everything`} delta={delta} />}
        {!same && selectedDelta !== undefined ? <WhatIf label={t`If you apply only the checked changes`} delta={selectedDelta} /> : null}
      </div>
      <div className="tl-tray-buttons">
        <button type="button" className="button is-primary" disabled={proposals.all.built.ops.length === 0} onClick={() => run('all')}>
          {plural(totalAll, { one: 'Apply # change', other: 'Apply # changes' })}
        </button>
        <button type="button" className="button" disabled={proposals.selected.built.ops.length === 0} onClick={() => run('selected')}>
          {t`Apply selected (${{ count: formatCount(tickedCount) }})`}
        </button>
        <button type="button" className="button is-quiet" onClick={() => proposals.discard()}>
          <Trans>Discard all</Trans>
        </button>
        <label className="tl-toggle">
          <input type="checkbox" checked={suggestionsOn} onChange={(event) => proposals.showSuggestions(event.target.checked)} />
          <Trans>Suggest follow-ups</Trans>
        </label>
      </div>
      {breakdown === '' ? null : <p className="field-note tl-breakdown">{breakdown}</p>}
    </section>
  );
}

function kindWords(kind: 'days' | 'durations' | 'modes' | 'povs' | 'parts' | 'orderings' | 'moves' | 'shifts' | 'pins', count: number): string {
  switch (kind) {
    case 'pins':
      return plural(count, { one: '# picture pin', other: '# picture pins' });
    case 'days':
      return plural(count, { one: '# day', other: '# days' });
    case 'durations':
      return plural(count, { one: '# length', other: '# lengths' });
    case 'modes':
      return plural(count, { one: '# mode', other: '# modes' });
    case 'povs':
      return plural(count, { one: '# point of view', other: '# points of view' });
    case 'parts':
      return plural(count, { one: '# part', other: '# parts' });
    case 'orderings':
      return plural(count, { one: '# ordering', other: '# orderings' });
    case 'moves':
      return plural(count, { one: '# move', other: '# moves' });
    case 'shifts':
      return plural(count, { one: '# shift', other: '# shifts' });
  }
}

function SuggestionWhy({ row, session }: { row: MetaRow; session: ProjectSession }): ReactNode {
  const names = (row.because ?? []).map((id) => quoted(session.state.manifest.tree.find((node) => node.id === id)?.title || id)).join(', ');
  return (
    <p className="field-note">
      <UserText value={t`It must follow ${names}, which moved.`} />
    </p>
  );
}

function WhatIf({ label, delta }: { label: string; delta: { readonly resolved: readonly WhatIfFinding[]; readonly added: readonly WhatIfFinding[] } }): ReactNode {
  const resolved = delta.resolved.length;
  const added = delta.added.length;
  return (
    <div className="tl-whatif-set">
      <p className="tl-whatif-line">
        <strong>{label}:</strong> {plural(resolved, { one: 'Resolves # finding', other: 'Resolves # findings' })} {'\u00b7'} {plural(added, { one: 'New: # finding', other: 'New: # findings' })}
      </p>
      {added === 0 && resolved === 0 ? null : (
        <ul className="tl-whatif-list">
          {delta.resolved.slice(0, 5).map((finding) => (
            <li key={`r:${finding.key}`}>
              <span aria-hidden="true">{'\u2713'} </span>
              <Trans>Resolves:</Trans> <UserText value={finding.message} />
            </li>
          ))}
          {delta.added.slice(0, 5).map((finding) => (
            <li key={`a:${finding.key}`}>
              <span aria-hidden="true">{'\u25b2'} </span>
              <Trans>New:</Trans> <UserText value={finding.message} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
