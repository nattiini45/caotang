/**
 * The writing history (goals-progress §9.1), opened from the binder footer: today, the daily average and the daily best over
 * every project in this browser, ten bars for the last ten days (a green bar is a day that met the session target), and a CSV
 * of the recorded days. The sessions are read when the panel opens, and again whenever today's words change, so an open panel
 * does not go stale. Nothing here is stored: the sessions log is the history, and this is a read of it.
 */

import { useEffect, useState, type PointerEvent, type ReactNode } from 'react';
import { HISTORY_BAR_DAYS, historyCsv, historyReading, type HistoryReading } from '@caotang/furniture';
import { listProjectIds, readSessions, type RuntimeStore, type SessionRecord } from '@caotang/store';

import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { downloadBytes } from '../app/download.js';
import type { TargetProgress } from '../app/session-progress.js';
import { formatCount } from './shared.js';

/* lingui-set comment="Interpolated values: count, day, days, error" */

/** The tallest bar, in pixels. A bar's height is its share of the largest day shown. */
const BAR_MAX_PX = 48;

export function WritingHistory({ store, target }: { store: RuntimeStore; target: TargetProgress }): ReactNode {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState<HistoryReading | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The bar under the pointer, by its place in the ten: its sentence is shown under the chart, for a reader who can see it. */
  const [pointed, setPointed] = useState<number | null>(null);

  // Read on open, and again when today's words or the target change. Today's words are the status line's figure (the sessions that
  // ended today plus the open sitting, `target.words`), so the history's Today and bars agree with the status line.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const sessions: SessionRecord[] = [];
        for (const projectId of await listProjectIds(store)) {
          sessions.push(...(await readSessions(store, projectId)));
        }
        if (!alive) return;
        setReading(historyReading(sessions, new Date(), target.target, target.words));
        setFailure(null);
      } catch (error) {
        if (alive) {
          const reason = error instanceof Error ? error.message : String(error);
          setFailure(t`The writing history could not be read: ${{ error: reason }}`);
        }
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [open, store, target.target, target.words]);

  const bars = reading?.lastTen ?? [];
  const largest = bars.reduce((max, day) => Math.max(max, day.words), 0);
  const summaryOf = (day: (typeof bars)[number]): string => {
    const count = formatCount(day.words);
    const words = day.words;
    return day.met
      ? t`${{ day: day.day }}: ${{ count }} ${plural(words, { one: 'word', other: 'words' })}, target met`
      : t`${{ day: day.day }}: ${{ count }} ${plural(words, { one: 'word', other: 'words' })}`;
  };
  const pointedDay = pointed === null ? undefined : bars[pointed];

  /** The bar under the pointer is found by its column, so a day with no words, which has no height to point at, is read too. */
  const point = (event: PointerEvent<HTMLOListElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    if (bars.length === 0 || box.width === 0) return;
    setPointed(Math.min(bars.length - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * bars.length))));
  };

  const exportCsv = (): void => {
    if (reading === null) return;
    downloadBytes(new TextEncoder().encode(historyCsv(reading)), 'caotang-writing-history.csv', 'text/csv');
  };

  return (
    <section className="footer-section history" aria-label={t`Writing history`} data-testid="writing-history">
      <h3 className="footer-title"><Trans>History</Trans></h3>
      <button
        type="button"
        className="button is-quiet"
        aria-expanded={open}
        aria-controls="writing-history-body"
        onClick={() => setOpen((on) => !on)}
      >
        {open ? <Trans>Hide the history</Trans> : <Trans>Show the history</Trans>}
      </button>
      {open ? (
        <div id="writing-history-body" className="history-body">
          {failure !== null ? (
            <p className="form-message is-error" role="alert">
              {failure}
            </p>
          ) : null}
          {reading === null && failure === null ? <p className="field-note"><Trans>Reading the history…</Trans></p> : null}
          {reading !== null ? (
            <>
              <dl className="history-stats" data-testid="history-stats">
                <div>
                  <dt><Trans>Today</Trans></dt>
                  <dd>{t`${{ count: formatCount(reading.today) }} words`}</dd>
                </div>
                <div>
                  <dt><Trans>Daily average</Trans></dt>
                  <dd>{t`${{ count: formatCount(reading.dailyAverage) }} words`}</dd>
                </div>
                <div>
                  <dt><Trans>Daily best</Trans></dt>
                  <dd>{t`${{ count: formatCount(reading.dailyBest) }} words`}</dd>
                </div>
              </dl>
              {reading.recorded.length === 0 ? <p className="field-note"><Trans>No writing is recorded yet.</Trans></p> : null}
              <ol
                className="history-bars"
                aria-label={t`Words on each of the last ${{ days: HISTORY_BAR_DAYS }} days`}
                onPointerMove={point}
                onPointerLeave={() => setPointed(null)}
              >
                {bars.map((day) => {
                  const summary = summaryOf(day);
                  return (
                    <li
                      key={day.day}
                      className={`history-bar${day.met ? ' is-met' : ''}`}
                      data-day={day.day}
                      style={{ height: `${largest === 0 || day.words === 0 ? 0 : Math.max(2, Math.round((day.words / largest) * BAR_MAX_PX))}px` }}
                    >
                      {/* The bar is a picture; its day and count are said in words once, for a reader who cannot see it (goals-progress §9.1). */}
                      <span className="visually-hidden">{summary}</span>
                    </li>
                  );
                })}
              </ol>
              {/* The same sentence for a sighted reader, who sees only the bars' heights. It is hidden from a screen reader, which
                  already reads each bar's own text, so the day is not said twice. */}
              <p className="field-note" aria-hidden="true" data-testid="history-readout">
                {pointedDay === undefined ? <Trans>Point at a bar to read its day and words.</Trans> : summaryOf(pointedDay)}
              </p>
              <button type="button" className="button" disabled={reading.recorded.length === 0} onClick={exportCsv}>
                <Trans>Download CSV</Trans>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
