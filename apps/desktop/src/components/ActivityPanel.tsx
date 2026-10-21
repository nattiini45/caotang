/**
 * The activity panel — command-bus.md §8 and §5, in the left rail's Activity tab. One row per executed command,
 * newest first: a title for the command, the digest the apply wrote, who issued it and where it came from. An
 * undo group carries one Undo, on its newest row, while the group can still be undone.
 *
 * Only the newest group can be undone. An older group's Undo is shown disabled, with the reason as its title,
 * until the changes after it are taken back: undoing it first would also take back their text (session.ts).
 *
 * Nothing here dispatches a command except Undo, and Undo is the bus's own: `undoGroup` (session.ts) runs the
 * group's compensations in reverse, and the undo is logged like any other command.
 *
 * The panel shows a window of the log's rows, not the whole log: the log holds every command of the sitting
 * (command-bus §8), and the older rows are one window at a time, on the button that names how many are left
 * (activity-window.ts). The export carries the whole log, rows and all.
 */

import { useState, type ReactNode } from 'react';

import type { ProjectSession } from '../app/session.js';
import { issuerLabel, sourceBadge, timeLabel } from '../app/activity-model.js';
import { activityWindow, ACTIVITY_PANEL_WINDOW, showOlderWindow } from './activity-window.js';
import { EmptyState, useReport, useSession } from './shared.js';

/** The title of an Undo that waits for the changes made after its group. */
const LATER_CHANGES_FIRST = 'Undo the later changes first';

export function ActivityPanel({ session, onExport }: { session: ProjectSession; onExport: () => void }): ReactNode {
  useSession(session);
  const report = useReport();
  const [showViews, setShowViews] = useState(false);
  // The panel shows a window of the log's rows, and the older ones one window at a time
  // (activity-window.ts): the log keeps every row, and the panel renders none of the ones behind
  // its window.
  const [limit, setLimit] = useState(ACTIVITY_PANEL_WINDOW);
  const panel = activityWindow(session.log.entries(), {
    showViews,
    groupOf: (id) => session.undo.group(id),
    newestUndoGroupId: session.newestUndoGroupId(),
    limit,
  });
  const rows = panel.rows;
  const newest = session.newestUndoGroupId();

  const undoGroup = (id: string, summary: string): void => {
    void session.undoGroup(id).then((done) => {
      if (done) return;
      const detail = session.undoErrorMessage();
      report(
        detail !== null
          ? { text: detail, tone: 'error' }
          : { text: `“${summary}” could not be undone in full. The rest of its group is kept for another try.`, tone: 'error' },
      );
    });
  };

  return (
    <div className="activity">
      <div className="activity-toolbar">
        <label className="check">
          <input type="checkbox" checked={showViews} onChange={(event) => setShowViews(event.target.checked)} />
          Show view changes
        </label>
        <button type="button" className="button is-quiet" onClick={onExport}>
          Export as Markdown
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nothing has changed yet">
          Each change you make appears here, with the command it ran. Undo takes back one change, or one group of them.
          Next step: type a sentence in the editor, or make a folder in the binder, and its row appears here.
        </EmptyState>
      ) : (
        <ol className="activity-list" aria-label="Activity">
          {rows.map(({ index, entry, title, undo }) => (
            <li key={index} className={`activity-row is-${entry.issuedBy}`} data-command={entry.command}>
              <div className="activity-head">
                <span className="activity-title">{title}</span>
                <span className={`badge is-source-${entry.source}`} title={`Source: ${sourceBadge(entry.source)}`}>
                  {sourceBadge(entry.source)}
                </span>
              </div>
              <p className="activity-summary">{entry.summary}</p>
              <p className="activity-meta">
                <time dateTime={new Date(entry.at).toISOString()}>{timeLabel(entry.at)}</time>
                <span> · {issuerLabel(entry.issuedBy)}</span>
              </p>
              {undo !== null ? (
                <button
                  type="button"
                  className="button is-quiet activity-undo"
                  disabled={undo.id !== newest}
                  title={undo.id === newest ? undo.label : LATER_CHANGES_FIRST}
                  aria-label={`Undo: ${entry.summary}`}
                  onClick={() => undoGroup(undo.id, entry.summary)}
                >
                  Undo
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {panel.showOlder !== null ? (
        <button
          type="button"
          className="button is-quiet activity-older"
          onClick={() => setLimit((current) => showOlderWindow(current))}
        >
          {panel.showOlder}
        </button>
      ) : null}
    </div>
  );
}
