/**
 * The changes a focused scene can be given without a pointer ([timeline.md §4.2, §5.3](docs/architecture/timeline.md)): the part, a day
 * typed in, a scene it must follow, a day counted from another scene, the quick actions of its findings, and a shift of many days at once.
 * Every button adds a row to the tray; none writes to the project.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { TIMELINE_SHIFT_NODES_MAX } from '@caotang/bus';
import type { CalendarLens, TimelineItem, TimelineLabels, TimelineModel } from '@caotang/timeline';

import { isImeEnter } from '../../app/keymap.js';
import { parseDayText } from '../../app/timeline-edit-model.js';
import { quickActions, type QuickAction } from '../../app/timeline-quick-actions.js';
import { SHIFT_ABOVE, datedAmong, declaredOf, isProposableDay } from '../../app/timeline-proposals.js';
import { accessibleText } from '../../i18n/accessible-text.js';
import { UserText } from '../../i18n/UserText.js';
import type { ProjectSession } from '../../app/session.js';
import type { Proposals } from './use-proposals.js';

/* lingui-set comment="Changes a timeline scene can be given from the keyboard. Interpolated values: title, name, count, delta, other, part, day are scene titles, part words or numbers." */

export interface SceneChangesProps {
  readonly session: ProjectSession;
  readonly proposals: Proposals;
  readonly model: TimelineModel;
  readonly lens: CalendarLens;
  readonly labels: TimelineLabels;
  readonly language: string | undefined;
  readonly item: TimelineItem | undefined;
  /** The scenes marked with Space; shifted together when any are. */
  readonly marked: ReadonlySet<string>;
  readonly announce: (text: string) => void;
  /** Alt+R: a new serial opens the form that places the scene some days after another. */
  readonly request?: { readonly serial: number } | null;
}

type Form = 'day' | 'follow' | 'place' | 'shift' | null;

const PICK_LIMIT = 8;

function ScenePicker({ items, exclude, language, onPick, label }: { items: readonly TimelineItem[]; exclude: string; language: string | undefined; onPick: (item: TimelineItem) => void; label: string }): ReactNode {
  const [filter, setFilter] = useState('');
  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const seen = new Set<string>();
    const out: TimelineItem[] = [];
    for (const item of items) {
      if (item.nodeId === exclude || seen.has(item.nodeId)) continue;
      if (needle !== '' && !item.title.toLowerCase().includes(needle)) continue;
      seen.add(item.nodeId);
      out.push(item);
      if (out.length >= PICK_LIMIT) break;
    }
    return out;
  }, [items, exclude, filter]);
  return (
    <div className="tl-picker">
      <input type="search" className="tl-value is-wide" aria-label={label} value={filter} onChange={(event) => setFilter(event.target.value)} />
      <ul className="tl-picker-list" aria-label={t`Scenes that match`}>
        {matches.map((item) => (
          <li key={item.nodeId}>
            <button type="button" className="button is-quiet" aria-label={accessibleText(item.title)} onClick={() => onPick(item)}>
              <UserText value={item.title} lang={language} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SceneChanges({ session, proposals, model, lens, language, item, marked, announce, request = null }: SceneChangesProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(null);
  const [seen, setSeen] = useState(0);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const [gap, setGap] = useState('0');
  const [follow, setFollow] = useState(true);
  if (request !== null && request.serial !== seen) {
    setSeen(request.serial);
    setOpen(true);
    setForm('place');
  }
  const actions = useMemo(() => (item === undefined ? [] : quickActions(session.state, model, item)), [session, model, item]);
  const close = (): void => {
    setOpen(false);
    setForm(null);
    setText('');
    setBad(false);
  };
  const proposed = (): void => {
    announce(t`Added to the proposed changes. Nothing is written until you apply.`);
    close();
  };
  const parseDay = (value: string): number | null => {
    const parsed = lens.parse?.(value) ?? parseDayText(value);
    return parsed !== null && isProposableDay(parsed) ? parsed : null;
  };

  const declared = item === undefined ? undefined : declaredOf(session.state, item.nodeId);
  const scenes = model.items;

  const labelOf = (action: QuickAction): string => {
    const other = session.state.manifest.tree.find((node) => node.id === action.otherId)?.title ?? '';
    const title = session.state.manifest.tree.find((node) => node.id === action.nodeId)?.title ?? '';
    const day = action.intent?.day;
    switch (action.kind) {
      case 'time-skip':
        return t`Declare a time skip before \u2018${{ title }}\u2019`;
      case 'epilogue':
        return t`Make \u2018${{ title }}\u2019 the epilogue`;
      case 'prologue':
        return t`Make \u2018${{ title }}\u2019 the prologue`;
      case 'simultaneous':
        return t`Declare \u2018${{ title }}\u2019 simultaneous with \u2018${{ other }}\u2019`;
      case 'flashback':
        return t`Mark \u2018${{ title }}\u2019 as a flashback`;
      case 'match-days':
        return t`Put \u2018${{ title }}\u2019 before \u2018${{ other }}\u2019 in the binder to match the days`;
      case 'relation-day':
        return t`Set \u2018${{ title }}\u2019 to ${{ day: day === undefined || day === null ? '' : lens.label(day, 'long') }} or later`;
    }
  };
  const quick = (action: QuickAction): void => {
    if (action.move !== undefined) proposals.move(action.nodeId, action.move, 'finding');
    else if (action.intent !== undefined) proposals.meta(action.nodeId, action.intent, 'finding');
    proposed();
  };

  const shiftTargets = (): string[] => {
    const ids = marked.size > 0 ? [...marked] : [...new Set(model.items.map((candidate) => candidate.nodeId))];
    return datedAmong(session.state, ids).dated;
  };

  const submitDay = (): void => {
    if (item === undefined) return;
    const day = parseDay(text);
    if (day === null) {
      setBad(true);
      return;
    }
    proposals.meta(item.nodeId, { day }, 'menu');
    proposed();
  };
  const submitShift = (): void => {
    const delta = parseDayText(text);
    const targets = shiftTargets();
    if (delta === null || delta === 0 || targets.length === 0 || targets.length > TIMELINE_SHIFT_NODES_MAX) {
      setBad(true);
      return;
    }
    if (targets.length > SHIFT_ABOVE || marked.size === 0) proposals.shift(delta, targets, 'menu');
    else for (const id of targets) proposals.meta(id, { day: (declaredOf(session.state, id).day as number) + delta }, 'menu');
    proposed();
  };
  const pick = (other: TimelineItem): void => {
    if (item === undefined) return;
    if (form === 'follow') {
      proposals.meta(item.nodeId, { afterAdd: [other.nodeId] }, 'menu');
      proposed();
      return;
    }
    const n = parseDayText(gap);
    if (n === null || other.dayOffset === undefined) {
      setBad(true);
      return;
    }
    const day = other.dayOffset + (other.durationDays ?? 0) + n;
    if (!isProposableDay(day)) {
      setBad(true);
      return;
    }
    proposals.meta(item.nodeId, { day, ...(follow ? { afterAdd: [other.nodeId] } : {}) }, 'menu');
    proposed();
  };

  const field = (label: string, onSubmit: () => void, placeholder?: string): ReactNode => (
    <div className="tl-form">
      <input
        type="text"
        className="tl-value is-wide"
        aria-label={label}
        aria-invalid={bad ? true : undefined}
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          setBad(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <button type="button" className="button" onClick={onSubmit}>
        <Trans>Propose</Trans>
      </button>
      {bad ? (
        <span role="alert" className="field-note is-error">
          <Trans>That is not a whole number of days the timeline can hold.</Trans>
        </span>
      ) : null}
    </div>
  );

  const title = item?.title ?? '';
  return (
    <div className="tl-changes" role="group" aria-label={t`Propose changes`}>
      <button type="button" className="button" aria-expanded={open} aria-controls="tl-changes-panel" onClick={() => (open ? close() : setOpen(true))}>
        <Trans>Change a scene&hellip;</Trans>
      </button>
      {open ? (
        <div id="tl-changes-panel" className="tl-changes-panel" onKeyDown={(event) => event.key === 'Escape' && (event.stopPropagation(), close())}>
          {item === undefined || declared === undefined ? (
            <p className="field-note">
              <Trans>Focus a scene on the timeline to change it.</Trans>
            </p>
          ) : (
            <>
              <p className="tl-detail-text">
                <Trans>
                  Change <UserText value={title} lang={language} />
                </Trans>
              </p>
              <div className="tl-form-buttons">
                {item.part !== 'prologue' ? (
                  <button type="button" className="button" onClick={() => (proposals.meta(item.nodeId, { part: 'prologue' }, 'menu'), proposed())}>
                    <Trans>Make prologue</Trans>
                  </button>
                ) : null}
                {item.part !== 'epilogue' ? (
                  <button type="button" className="button" onClick={() => (proposals.meta(item.nodeId, { part: 'epilogue' }, 'menu'), proposed())}>
                    <Trans>Make epilogue</Trans>
                  </button>
                ) : null}
                {item.part !== 'main' || declared.part !== 'main' ? (
                  <button type="button" className="button" onClick={() => (proposals.meta(item.nodeId, { part: 'main' }, 'menu'), proposed())}>
                    <Trans>Move to main story</Trans>
                  </button>
                ) : null}
                {declared.part !== null ? (
                  <button type="button" className="button" onClick={() => (proposals.meta(item.nodeId, { part: null }, 'menu'), proposed())}>
                    <Trans>Inherit the part from its folder</Trans>
                  </button>
                ) : null}
                <button type="button" className="button" aria-pressed={form === 'day'} onClick={() => (setForm('day'), setText(''), setBad(false))}>
                  <Trans>Set day&hellip;</Trans>
                </button>
                <button type="button" className="button" aria-pressed={form === 'follow'} onClick={() => (setForm('follow'), setBad(false))}>
                  <Trans>Must follow&hellip;</Trans>
                </button>
                <button type="button" className="button" aria-pressed={form === 'place'} onClick={() => (setForm('place'), setBad(false))}>
                  <Trans>Place days after&hellip;</Trans>
                </button>
              </div>
              {form === 'day' ? field(t`Day for this scene`, submitDay) : null}
              {form === 'follow' ? <ScenePicker items={scenes} exclude={item.nodeId} language={language} onPick={pick} label={t`Find the scene it must follow`} /> : null}
              {form === 'place' ? (
                <div>
                  <label className="tl-form">
                    <span>
                      <Trans>Days after the other scene ends</Trans>
                    </span>
                    <input type="text" className="tl-value" inputMode="numeric" value={gap} onChange={(event) => setGap(event.target.value)} />
                  </label>
                  <label className="tl-toggle">
                    <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
                    <Trans>Also make it follow that scene</Trans>
                  </label>
                  <ScenePicker items={scenes.filter((candidate) => candidate.dayOffset !== undefined)} exclude={item.nodeId} language={language} onPick={pick} label={t`Find the scene to place it after`} />
                </div>
              ) : null}
              {actions.length > 0 ? (
                <div className="tl-quick" role="group" aria-label={t`Quick actions for its findings`}>
                  {actions.map((action) => (
                    <button key={action.key} type="button" className="button" onClick={() => quick(action)}>
                      <UserText value={labelOf(action)} lang={language} />
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
          <div className="tl-form-buttons">
            <button type="button" className="button" aria-pressed={form === 'shift'} onClick={() => (setForm('shift'), setText(''), setBad(false))}>
              <Trans>Shift all days&hellip;</Trans>
            </button>
          </div>
          {form === 'shift' ? (
            <>
              <p className="field-note">
                {(() => {
                  const targetCount = shiftTargets().length;
                  return marked.size > 0
                    ? t`Shifts the ${plural(targetCount, { one: '# marked scene with a day', other: '# marked scenes with a day' })} by the days you type.`
                    : t`Shifts the ${plural(targetCount, { one: '# scene with a day', other: '# scenes with a day' })} in view by the days you type.`;
                })()}
              </p>
              {field(t`Days to shift by, for example 14 or -3`, submitShift)}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
