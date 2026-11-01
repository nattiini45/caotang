/**
 * The controls above the timeline: axis, group-by, zoom, scope, what to show, and Timeline or Agenda. They follow the interface's
 * language and direction, not the book's ([timeline.md §3.2](docs/architecture/timeline.md)). They hold no state: the view keeps it.
 */

import { type KeyboardEvent, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import type { LaneKey, TimelineAxis, Zoom } from '@caotang/timeline';

import { zoomsOf, type ScopeOption, type TimelineOverlays, type TimelineViewState } from '../../app/timeline-model.js';
import { accessibleText } from '../../i18n/accessible-text.js';
import { formatCount } from './timeline-count.js';
import { radioStep } from '../radio-keys.js';

/* lingui-set comment="Controls of the story timeline. Interpolated values: scheduled, total are scene counts." */

const GROUPS: readonly LaneKey[] = ['none', 'pov', 'character', 'mode', 'folder', 'location', 'thread'];

function groupLabel(key: LaneKey): string {
  switch (key) {
    case 'pov':
      return t`Point of view`;
    case 'character':
      return t`Character`;
    case 'mode':
      return t`Mode or strand`;
    case 'folder':
      return t`Folder`;
    case 'location':
      return t`Location`;
    case 'thread':
      return t`Thread`;
    default:
      return t`No grouping`;
  }
}

function zoomLabel(zoom: Zoom): string {
  switch (zoom) {
    case 'day':
      return t`Day`;
    case 'week':
      return t`Week`;
    case 'month':
      return t`Month`;
    case 'fit':
      return t`Fit all`;
    case 'scene':
      return t`Scene`;
    case 'chapter':
      return t`Chapter`;
    case 'act':
      return t`Act`;
  }
}

interface Option<T extends string> {
  readonly value: T;
  readonly label: string;
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly Option<T>[];
  readonly onChange: (next: T) => void;
}): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = radioStep(options.map((option) => option.value), value, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="tl-segmented" onKeyDown={onKeyDown}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          className="tl-segmented-item"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface TimelineControlsProps {
  readonly view: TimelineViewState;
  readonly agenda: boolean;
  readonly scheduled: number;
  readonly total: number;
  readonly scopes: readonly ScopeOption[];
  readonly scope: string | null;
  readonly onAxis: (axis: TimelineAxis) => void;
  readonly onZoom: (zoom: Zoom) => void;
  readonly onGroupBy: (key: LaneKey) => void;
  readonly onScope: (scope: string | null) => void;
  readonly onCompress: (on: boolean) => void;
  readonly onOverlay: (key: keyof TimelineOverlays, on: boolean) => void;
  readonly onFollow: (on: boolean) => void;
  readonly onAgenda: (on: boolean) => void;
  readonly onSaveImage: () => void;
  /** The Calendar button: opens the dialog that names the lens and holds the project's calendar. */
  readonly onCalendar: () => void;
  /** True while a picture is being drawn, so a second press does not start a second one. */
  readonly savingImage: boolean;
}

export function TimelineControls(props: TimelineControlsProps): ReactNode {
  const { view, agenda, scopes, scope } = props;
  const scheduled = formatCount(props.scheduled);
  const total = formatCount(props.total);
  const axisOptions: readonly Option<TimelineAxis>[] = [
    { value: 'story', label: t`Story time · ${{ scheduled }} of ${{ total }} scheduled` },
    { value: 'narrative', label: t`Reading order` },
    { value: 'braid', label: t`Both` },
  ];
  const zoomOptions: readonly Option<Zoom>[] = zoomsOf(view.axis).map((zoom) => ({ value: zoom, label: zoomLabel(zoom) }));
  const checkbox = (label: string, checked: boolean, onChange: (on: boolean) => void, disabled = false): ReactNode => (
    <label className="tl-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
  return (
    <div role="toolbar" aria-label={t`Timeline controls`} className="tl-toolbar" data-testid="timeline-controls">
      <Segmented
        label={t`Timeline or Agenda`}
        value={agenda ? 'agenda' : 'timeline'}
        options={[
          { value: 'timeline', label: t`Timeline` },
          { value: 'agenda', label: t`Agenda` },
        ]}
        onChange={(next) => props.onAgenda(next === 'agenda')}
      />
      <Segmented label={t`Timeline axis`} value={view.axis} options={axisOptions} onChange={props.onAxis} />
      {agenda ? null : <Segmented label={t`Zoom`} value={view.zoom} options={zoomOptions} onChange={props.onZoom} />}
      <label className="tl-field">
        <span>{t`Group by`}</span>
        <select value={view.groupBy} onChange={(event) => props.onGroupBy(event.target.value as LaneKey)}>
          {GROUPS.map((key) => (
            <option key={key} value={key}>
              {groupLabel(key)}
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field">
        <span>{t`Scope`}</span>
        <select value={scope ?? ''} onChange={(event) => props.onScope(event.target.value === '' ? null : event.target.value)}>
          <option value="">{t`Whole manuscript`}</option>
          {scopes.map((option) => (
            <option key={option.id} value={option.id}>
              {`${'\u2003'.repeat(option.depth)}${isolate(option.title)}`}
            </option>
          ))}
        </select>
      </label>
      <details className="tl-show">
        <summary>
          <Trans>Show</Trans>
        </summary>
        <div className="tl-show-body" role="group" aria-label={accessibleText(t`What the timeline shows`)}>
          {checkbox(t`Collapse long empty stretches`, view.compressGaps, props.onCompress)}
          {checkbox(t`Order links`, view.overlays.after, (on) => props.onOverlay('after', on))}
          {checkbox(t`Thread arcs`, view.overlays.thread, (on) => props.onOverlay('thread', on))}
          {checkbox(t`Open findings`, view.overlays.findings, (on) => props.onOverlay('findings', on))}
          {checkbox(t`Character paths`, view.overlays.presence, (on) => props.onOverlay('presence', on), view.groupBy !== 'character')}
          {checkbox(t`Follow the scene open in the editor`, view.followEditor, props.onFollow)}
        </div>
      </details>
      <button type="button" className="tl-save" data-testid="timeline-calendar" onClick={props.onCalendar}>
        <Trans>Calendar</Trans>
      </button>
      <button type="button" className="tl-save" data-testid="timeline-save-image" disabled={props.savingImage} aria-busy={props.savingImage} onClick={props.onSaveImage}>
        <Trans>Save image</Trans>
      </button>
    </div>
  );
}
