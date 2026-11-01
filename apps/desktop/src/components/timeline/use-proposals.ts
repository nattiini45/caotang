/**
 * The proposals of one open project as the timeline and its Agenda use them ([timeline.md §4](docs/architecture/timeline.md)): the
 * tray's rows with what they would do, the what-if delta (debounced, after the change), and the actions that add, edit, remove and apply
 * rows. Every action reads the project through the session and changes only the in-memory tray; `apply` is the one place a row reaches
 * the bus, as one `timeline.apply`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { emptyCoherenceFile } from '@caotang/coherence';
import type { TimelineProjection } from '@caotang/bus';

import type { ProjectSession } from '../../app/session.js';
import { buildBatch, proposeMeta, proposeMove, proposePin, proposeShift, rebaseRow, removeRow, setShiftDelta, type Built, type MetaIntent, type MoveTarget, type PinWhen, type RowOrigin } from '../../app/timeline-proposals.js';
import { clearTray, inAll, isTicked, updateTray, useTray, type TrayState } from '../../app/timeline-tray.js';
import { baselineKeys, whatIf, type WhatIfDelta } from '../../app/timeline-what-if.js';
import { explain } from '../actions.js';
import { useSession } from '../shared.js';

/** The pause between the last change to the tray and the what-if run (timeline.md §4.4). */
export const WHAT_IF_DEBOUNCE_MS = 150;

export interface Analysis {
  readonly built: Built;
  readonly delta: WhatIfDelta | undefined;
}

export interface ApplyResult {
  readonly ok: boolean;
  readonly count: number;
  readonly message?: string;
}

export interface Proposals {
  readonly tray: TrayState;
  /** What the primary Apply would do: every ordinary row and the suggestions that are ticked. */
  readonly all: Analysis;
  /** What Apply selected would do: the ticked rows. */
  readonly selected: Analysis;
  /** The milliseconds the last what-if took; absent until one has run. */
  readonly whatIfMs: number | undefined;
  readonly meta: (nodeId: string, intent: MetaIntent, origin?: RowOrigin) => void;
  readonly move: (nodeId: string, to: MoveTarget, origin?: RowOrigin) => void;
  readonly shift: (delta: number, nodeIds: readonly string[], origin?: RowOrigin) => void;
  /** Moves a picture's day pin (timeline.md §9.1): one row, like every other gesture. `null` clears the pin. */
  readonly pin: (linkId: string, to: PinWhen, origin?: RowOrigin) => void;
  readonly remove: (rowId: string) => void;
  readonly rebase: (rowId: string) => void;
  readonly setDelta: (rowId: string, delta: number) => void;
  readonly tick: (rowId: string, on: boolean) => void;
  readonly tickSuggestions: (on: boolean) => void;
  readonly showSuggestions: (on: boolean) => void;
  readonly discard: () => void;
  readonly apply: (only: 'all' | 'selected') => ApplyResult;
}

export function useProposals(session: ProjectSession): Proposals {
  const version = useSession(session);
  const projectId = session.projectId;
  const tray = useTray(projectId);
  const rows = tray.set.rows;

  const allIds = useMemo(() => new Set(rows.filter((row) => inAll(tray, row)).map((row) => row.id)), [rows, tray]);
  const tickedIds = useMemo(() => new Set(rows.filter((row) => isTicked(tray, row)).map((row) => row.id)), [rows, tray]);
  const builtAll = useMemo(() => buildBatch(session.state, rows, allIds), [session, version, rows, allIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const builtSelected = useMemo(() => buildBatch(session.state, rows, tickedIds), [session, version, rows, tickedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // The suggestions follow the project as well as the rows: an edit made elsewhere changes which scenes a move would break.
  useEffect(() => {
    updateTray(projectId, session.state, (now) => now);
  }, [projectId, session, version]);

  const [deltas, setDeltas] = useState<{ readonly all: WhatIfDelta | undefined; readonly selected: WhatIfDelta | undefined; readonly ms: number | undefined }>({ all: undefined, selected: undefined, ms: undefined });
  const baseline = useRef<{ readonly version: number; readonly keys: Set<string> } | null>(null);
  const sameSelection = allIds.size === tickedIds.size && [...allIds].every((id) => tickedIds.has(id));
  useEffect(() => {
    const projections: (TimelineProjection | undefined)[] = [builtAll.projection, builtSelected.projection];
    if (projections.every((projection) => projection === undefined)) return;
    const handle = window.setTimeout(() => {
      const file = session.coherenceFile() ?? emptyCoherenceFile();
      const started = performance.now();
      if (baseline.current === null || baseline.current.version !== version) baseline.current = { version, keys: baselineKeys(session.state, file) };
      const keys = baseline.current.keys;
      const all = builtAll.projection === undefined ? undefined : whatIf(session.state, file, builtAll.projection, keys);
      const selected = sameSelection ? all : builtSelected.projection === undefined ? undefined : whatIf(session.state, file, builtSelected.projection, keys);
      setDeltas({ all, selected, ms: performance.now() - started });
    }, WHAT_IF_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [session, version, builtAll.projection, builtSelected.projection, sameSelection]);

  const meta = useCallback(
    (nodeId: string, intent: MetaIntent, origin: RowOrigin = 'gesture') =>
      updateTray(projectId, session.state, (now) => ({ ...now, set: proposeMeta(now.set, session.state, nodeId, intent, origin) })),
    [projectId, session],
  );
  const move = useCallback(
    (nodeId: string, to: MoveTarget, origin: RowOrigin = 'gesture') =>
      updateTray(projectId, session.state, (now) => ({ ...now, set: proposeMove(now.set, session.state, nodeId, to, origin) })),
    [projectId, session],
  );
  const shift = useCallback(
    (delta: number, nodeIds: readonly string[], origin: RowOrigin = 'menu') =>
      updateTray(projectId, session.state, (now) => ({ ...now, set: proposeShift(now.set, session.state, delta, nodeIds, origin) })),
    [projectId, session],
  );
  const pin = useCallback(
    (linkId: string, to: PinWhen, origin: RowOrigin = 'gesture') =>
      updateTray(projectId, session.state, (now) => ({ ...now, set: proposePin(now.set, session.state, linkId, to, origin) })),
    [projectId, session],
  );
  const remove = useCallback((rowId: string) => updateTray(projectId, session.state, (now) => ({ ...now, set: removeRow(now.set, rowId) })), [projectId, session]);
  const rebase = useCallback((rowId: string) => updateTray(projectId, session.state, (now) => ({ ...now, set: rebaseRow(now.set, session.state, rowId) })), [projectId, session]);
  const setDelta = useCallback((rowId: string, delta: number) => updateTray(projectId, session.state, (now) => ({ ...now, set: setShiftDelta(now.set, rowId, delta) })), [projectId, session]);
  const tick = useCallback(
    (rowId: string, on: boolean) => updateTray(projectId, session.state, (now) => ({ ...now, ticks: new Map(now.ticks).set(rowId, on) })),
    [projectId, session],
  );
  const tickSuggestions = useCallback(
    (on: boolean) =>
      updateTray(projectId, session.state, (now) => {
        const ticks = new Map(now.ticks);
        for (const row of now.set.rows) if (row.origin === 'suggestion') ticks.set(row.id, on);
        return { ...now, ticks };
      }),
    [projectId, session],
  );
  const showSuggestions = useCallback((on: boolean) => updateTray(projectId, session.state, (now) => ({ ...now, suggestions: on })), [projectId, session]);
  const discard = useCallback(() => clearTray(projectId), [projectId]);

  const apply = useCallback(
    (only: 'all' | 'selected'): ApplyResult => {
      const built = only === 'all' ? builtAll : builtSelected;
      if (built.ops.length === 0 || built.projection === undefined) return { ok: false, count: 0 };
      const count = built.projection.counts.total;
      const outcome = session.dispatch('timeline.apply', { ops: [...built.ops] });
      if (!outcome.ok) return { ok: false, count: 0, message: explain(outcome.error) };
      const done = new Set(built.accepted);
      updateTray(projectId, session.state, (now) => ({ ...now, set: { ...now.set, rows: now.set.rows.filter((row) => !done.has(row.id)) } }));
      return { ok: true, count };
    },
    [builtAll, builtSelected, projectId, session],
  );

  return {
    tray,
    all: { built: builtAll, delta: builtAll.projection === undefined ? undefined : deltas.all },
    selected: { built: builtSelected, delta: builtSelected.projection === undefined ? undefined : deltas.selected },
    whatIfMs: deltas.ms,
    meta,
    move,
    shift,
    pin,
    remove,
    rebase,
    setDelta,
    tick,
    tickSuggestions,
    showSuggestions,
    discard,
    apply,
  };
}