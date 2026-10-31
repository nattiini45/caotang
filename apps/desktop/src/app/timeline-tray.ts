/**
 * The proposed-changes tray's state ([timeline.md §4.4](docs/architecture/timeline.md)): in memory, per open project, shared by the
 * timeline, the Agenda and the workspace's leave guard. Nothing here is persisted and nothing here writes to the project.
 *
 * It lives outside React so the workspace can ask whether a change of centre would lose rows without the timeline being mounted to
 * answer, and so a switch between the timeline and its Agenda keeps the rows.
 */

import { useSyncExternalStore } from 'react';

import type { ProjectState } from '@caotang/store';

import { EMPTY_PROPOSALS, syncSuggestions, type ProposalSet, type Row } from './timeline-proposals.js';

export interface TrayState {
  readonly set: ProposalSet;
  /** A row's tick, where the writer has changed it. A row with none is ticked unless it is a suggestion. */
  readonly ticks: ReadonlyMap<string, boolean>;
  /** Suggested rows are derived and shown (timeline.md §4.5). */
  readonly suggestions: boolean;
}

const EMPTY: TrayState = { set: EMPTY_PROPOSALS, ticks: new Map(), suggestions: true };

const trays = new Map<string, TrayState>();
const listeners = new Set<() => void>();

export function trayOf(projectId: string): TrayState {
  return trays.get(projectId) ?? EMPTY;
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeTray(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTray(projectId: string): TrayState {
  return useSyncExternalStore(subscribeTray, () => trayOf(projectId), () => EMPTY);
}

/** The rows the writer would lose by leaving: every row the primary Apply would take. */
export function pendingRows(projectId: string): number {
  const tray = trayOf(projectId);
  return tray.set.rows.filter((row) => inAll(tray, row)).length;
}

export function isTicked(tray: Pick<TrayState, 'ticks'>, row: Row): boolean {
  return tray.ticks.get(row.id) ?? row.origin !== 'suggestion';
}

/**
 * Whether the primary Apply takes the row: every ordinary row whether ticked or not, and a suggested row only when it is ticked. The
 * tick otherwise says which rows "Apply selected" takes.
 */
export function inAll(tray: Pick<TrayState, 'ticks'>, row: Row): boolean {
  return row.origin !== 'suggestion' || tray.ticks.get(row.id) === true;
}

/** Applies a change to the tray, brings the suggestions in line with the rows, and forgets ticks of rows that are gone. */
export function updateTray(projectId: string, state: ProjectState, change: (tray: TrayState) => TrayState): void {
  const before = trayOf(projectId);
  let next = change(before);
  const set = syncSuggestions(next.set, state, next.suggestions);
  if (set !== next.set) next = { ...next, set };
  if (next.ticks.size > 0) {
    const live = new Set(next.set.rows.map((row) => row.id));
    if ([...next.ticks.keys()].some((id) => !live.has(id))) next = { ...next, ticks: new Map([...next.ticks].filter(([id]) => live.has(id))) };
  }
  if (next === before) return;
  if (next.set.rows.length === 0 && next.ticks.size === 0 && next.suggestions) trays.delete(projectId);
  else trays.set(projectId, next);
  emit();
}

export function clearTray(projectId: string): void {
  const had = trays.has(projectId);
  const keep = trayOf(projectId).suggestions;
  trays.delete(projectId);
  if (!keep) trays.set(projectId, { ...EMPTY, suggestions: false });
  if (had) emit();
}
