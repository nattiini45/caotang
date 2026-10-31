/**
 * The Agenda ([timeline.md §6](docs/architecture/timeline.md)): the timeline's items as a table, grouped under Prologue, Main story
 * and Epilogue in logical order whichever way the book is read. A row opens its scene, and a finding opens in the Findings tab.
 * The day, length, part, mode and point of view are cells a writer edits: an edit adds a row to the same tray the timeline's
 * gestures use, and writes nothing. The end day, the reading index and the findings are read-only. It is what a writer gets first
 * under forced colours or reduced motion, and from the skip link.
 */

import { useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { STORY_PARTS, TIMELINE_MODES, type DeclaredStoryPart } from '@caotang/bus';
import type { CalendarLens, TimelineLabels, TimelineModel } from '@caotang/timeline';

import { modeLabel, storyPartLabel } from '../../app/findings-model.js';
import { SEVERITY_GLYPH, agendaOf, badgeOf, type AgendaColumn, type AgendaSort } from '../../app/timeline-model.js';
import type { Declared, MetaIntent, MetaRow } from '../../app/timeline-proposals.js';
import { accessibleText } from '../../i18n/accessible-text.js';
import { UserText } from '../../i18n/UserText.js';
import { ValueField } from './ValueField.js';

/* lingui-set comment="Columns and cells of the timeline's Agenda table. Interpolated values: count is a number of scenes or findings; title, name and part are writer or part words." */

const PAGE = 150;

export interface AgendaProps {
  readonly model: TimelineModel;
  readonly lens: CalendarLens;
  readonly labels: TimelineLabels;
  readonly language: string | undefined;
  readonly povName: (id: string) => string;
  readonly activeDocId: string | null;
  readonly onOpen: (nodeId: string) => void;
  readonly onOpenFindings: (factGroup: string) => void;
  /** What turns a cell into a proposal. Without it the table is read-only. */
  readonly edit?: AgendaEdit;
}

export interface AgendaEdit {
  /** The tray's row for a scene, with its number in the tray. */
  readonly rowOf: (nodeId: string) => { readonly row: MetaRow; readonly number: number } | undefined;
  readonly declared: (nodeId: string) => Declared;
  readonly povChoices: readonly { readonly id: string; readonly name: string }[];
  readonly onMeta: (nodeId: string, intent: MetaIntent) => void;
}

const COLUMNS: readonly AgendaColumn[] = ['title', 'day', 'end', 'duration', 'reading', 'mode', 'pov', 'findings'];

function columnLabel(column: AgendaColumn): string {
  switch (column) {
    case 'title':
      return t`Scene`;
    case 'day':
      return t`Day`;
    case 'end':
      return t`Ends`;
    case 'duration':
      return t`Days long`;
    case 'reading':
      return t`Reading order`;
    case 'mode':
      return t`Mode`;
    case 'pov':
      return t`Point of view`;
    case 'findings':
      return t`Findings`;
  }
}

export function Agenda({ model, lens, labels, language, povName, activeDocId, onOpen, onOpenFindings, edit }: AgendaProps): ReactNode {
  const [sort, setSort] = useState<AgendaSort | undefined>(undefined);
  const [shown, setShown] = useState<Readonly<Record<string, number>>>({});
  const groups = agendaOf(model, sort, povName);
  const chooseSort = (column: AgendaColumn): void =>
    setSort((current) => (current?.column === column ? (current.direction === 'ascending' ? { column, direction: 'descending' } : undefined) : { column, direction: 'ascending' }));
  const dayText = (day: number | undefined): string => (day === undefined ? '\u2014' : lens.label(day, 'long'));
  if (groups.length === 0) {
    return (
      <p className="tl-empty" id="tl-agenda" tabIndex={-1} data-testid="timeline-agenda">
        <Trans>There are no scenes in the manuscript yet. Write a scene, and it appears here.</Trans>
      </p>
    );
  }
  return (
    <div className="tl-agenda-wrap" id="tl-agenda" tabIndex={-1} data-testid="timeline-agenda">
      <table className="tl-agenda">
        <caption>
          <Trans>Agenda: every scene, grouped by part, with its day, length and open findings.</Trans>
        </caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column} scope="col" aria-sort={sort?.column === column ? sort.direction : 'none'}>
                <button type="button" className="tl-sort" onClick={() => chooseSort(column)}>
                  {columnLabel(column)}
                  <span aria-hidden="true">{sort?.column === column ? (sort.direction === 'ascending' ? ' \u25b2' : ' \u25bc') : ''}</span>
                </button>
              </th>
            ))}
            <th scope="col">
              <Trans>Part</Trans>
            </th>
            {edit === undefined ? null : (
              <th scope="col">
                <Trans>Proposed change</Trans>
              </th>
            )}
          </tr>
        </thead>
        {groups.map((group) => {
          const limit = shown[group.part] ?? PAGE;
          const rows = group.rows.slice(0, limit);
          const name = labels.partName(group.part);
          const count = group.rows.length;
          return (
            <tbody key={group.part} data-part={group.part}>
              <tr>
                <th scope="rowgroup" colSpan={COLUMNS.length + (edit === undefined ? 1 : 2)} className="tl-agenda-group">
                  {t`${{ name }} (${plural(count, { one: '# scene', other: '# scenes' })})`}
                </th>
              </tr>
              {rows.map(({ item, day, end }) => {
                const badge = badgeOf(item.findings);
                const openCount = badge?.count ?? 0;
                const proposed = edit?.rowOf(item.nodeId);
                const declared = edit?.declared(item.nodeId);
                return (
                  <tr key={item.nodeId} data-node={item.nodeId} aria-current={item.nodeId === activeDocId ? 'true' : undefined}>
                    <th scope="row">
                      <button type="button" className="tl-link" aria-label={accessibleText(item.a11yLabel)} onClick={() => onOpen(item.nodeId)}>
                        <UserText value={item.label} lang={language} />
                      </button>
                    </th>
                    <td>
                      {edit === undefined ? (
                        dayText(day)
                      ) : (
                        <>
                          <ValueField
                            label={accessibleText(t`Day for ${{ title: item.title }}`)}
                            value={proposed?.row.day !== undefined ? proposed.row.day.to : (declared?.day ?? null)}
                            clearable
                            onCommit={(value) => edit.onMeta(item.nodeId, { day: value })}
                          />
                          {(proposed?.row.day !== undefined ? proposed.row.day.to : day) === null || (proposed?.row.day === undefined && day === undefined) ? null : (
                            <span className="tl-hint"> {dayText(proposed?.row.day !== undefined ? (proposed.row.day.to ?? undefined) : day)}</span>
                          )}
                        </>
                      )}
                    </td>
                    <td>{end !== undefined && end !== day ? dayText(end) : '\u2014'}</td>
                    <td>
                      {edit === undefined ? (
                        item.durationDays !== undefined && item.durationDays > 0 ? item.durationDays : '\u2014'
                      ) : (
                        <ValueField
                          label={accessibleText(t`Days long for ${{ title: item.title }}`)}
                          value={proposed?.row.duration !== undefined ? proposed.row.duration.to : (declared?.duration ?? null)}
                          clearable
                          min={0}
                          onCommit={(value) => edit.onMeta(item.nodeId, { duration: value })}
                        />
                      )}
                    </td>
                    <td>{item.readingIndex + 1}</td>
                    <td>
                      {edit === undefined ? (
                        labels.modeName(item.mode)
                      ) : (
                        <select
                          aria-label={accessibleText(t`Mode for ${{ title: item.title }}`)}
                          value={proposed?.row.mode !== undefined ? (proposed.row.mode.to ?? 'linear') : (declared?.mode ?? 'linear')}
                          onChange={(event) => edit.onMeta(item.nodeId, { mode: event.target.value })}
                        >
                          {TIMELINE_MODES.map((mode) => (
                            <option key={mode} value={mode}>
                              {modeLabel(mode)}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {edit === undefined ? (
                        item.pov === undefined ? '\u2014' : <UserText value={povName(item.pov)} lang={language} />
                      ) : (
                        <select
                          aria-label={accessibleText(t`Point of view for ${{ title: item.title }}`)}
                          value={proposed?.row.pov !== undefined ? (proposed.row.pov.to ?? '') : (declared?.pov ?? '')}
                          onChange={(event) => edit.onMeta(item.nodeId, { pov: event.target.value === '' ? null : event.target.value })}
                        >
                          <option value="">{t`No point of view declared`}</option>
                          {edit.povChoices.map((choice) => (
                            <option key={choice.id} value={choice.id}>
                              {choice.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {badge === undefined ? (
                        '\u2014'
                      ) : (
                        <button
                          type="button"
                          className="tl-link"
                          aria-label={t`Open in Findings: ${plural(openCount, { one: '# open finding', other: '# open findings' })} on this scene`}
                          onClick={() => onOpenFindings(badge.groups[0] as string)}
                        >
                          <span aria-hidden="true">{SEVERITY_GLYPH[badge.severity]} </span>
                          {badge.count}
                        </button>
                      )}
                    </td>
                    <td>
                      {edit === undefined ? (
                        labels.partName(item.part)
                      ) : (
                        <select
                          aria-label={accessibleText(t`Story part for ${{ title: item.title }}`)}
                          value={proposed?.row.part !== undefined ? (proposed.row.part.to ?? '') : (declared?.part ?? '')}
                          onChange={(event) => edit.onMeta(item.nodeId, { part: event.target.value === '' ? null : (event.target.value as DeclaredStoryPart) })}
                        >
                          <option value="">{t`Inherit the folder’s part (${{ part: labels.partName(item.part) }})`}</option>
                          {STORY_PARTS.map((part) => (
                            <option key={part} value={part}>
                              {storyPartLabel(part)}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    {edit === undefined ? null : (
                      <td data-testid="agenda-proposed">
                        {proposed === undefined ? (
                          '\u2014'
                        ) : (
                          <span>
                            {t`Change ${{ number: proposed.number }}`}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {count > limit ? (
                <tr>
                  <td colSpan={COLUMNS.length + (edit === undefined ? 1 : 2)}>
                    <button type="button" className="button is-quiet" onClick={() => setShown((now) => ({ ...now, [group.part]: limit + PAGE }))}>
                      {t`Show ${{ more: Math.min(PAGE, count - limit) }} more scenes of ${{ name }}`}
                    </button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
