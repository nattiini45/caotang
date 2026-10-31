/**
 * The `asset.*` gestures the picture surfaces share, each one bus dispatch. A refusal is said in the status line in the command's own
 * words; a success changes the project and says nothing, as a rename does. The views never change the registry any other way.
 */

import type { CommandError, ExecutionOutcome, Result } from '@caotang/bus';
import type { AssetTarget, RecordPatch } from '@caotang/pictures';

import type { ProjectSession } from '../app/session.js';
import { explain } from '../components/actions.js';
import type { Report } from '../components/shared.js';

import { documentLevelDone, documentLevelPlanOf, repinDone, repinPlanOf, type RepinCaret } from './lost-paragraph-model.js';

type Outcome = Result<ExecutionOutcome, CommandError>;

/** Whether the dispatch landed; a refusal is reported. */
export function landed(report: Report, outcome: Outcome): boolean {
  if (outcome.ok) return true;
  report({ text: explain(outcome.error), tone: 'error' });
  return false;
}

export function setPictureMeta(session: ProjectSession, report: Report, assetId: string, patch: RecordPatch): boolean {
  return landed(report, session.dispatch('asset.setMeta', { assetId, patch }));
}

export function setPlacementNote(session: ProjectSession, report: Report, linkId: string, note: string | null): boolean {
  return landed(report, session.dispatch('asset.setLinkMeta', { linkId, patch: { note } }));
}

/** Places a picture on a target. With `card`, the picture becomes that binder item's card picture and the earlier card a plain reference. */
export function placePicture(session: ProjectSession, report: Report, assetId: string, target: AssetTarget, card = false): boolean {
  return landed(report, session.dispatch('asset.link', { assetId, target, ...(card ? { role: 'card' as const } : {}) }));
}

export function removePlacement(session: ProjectSession, report: Report, linkId: string): boolean {
  return landed(report, session.dispatch('asset.unlink', { linkId }));
}

/** *Make document-level* is one compound command and therefore one Undo, including when an existing placement is merged. */
export function makeDocumentLevel(session: Pick<ProjectSession, 'dispatch' | 'state'>, report: Report, linkId: string, name: string): boolean {
  const plan = documentLevelPlanOf(session.state.manifest.assetLinks ?? [], linkId);
  if (plan.kind === 'refused') {
    report({ text: plan.text, tone: 'error' });
    return false;
  }
  if (!landed(report, session.dispatch('asset.makeDocumentLevel', { linkId }))) return false;
  report({ text: documentLevelDone(plan, name), tone: 'info' });
  return true;
}

/**
 * *Re-pin* on a placement that lost its paragraph (pictures.md §2.3): one `asset.repin` from the editor's selection, read when the
 * writer clicks. The command re-captures the anchor against the stored body and clears `orphaned` and `moved` itself; a refusal
 * leaves the placement exactly as it was and is said in the command's own words. One command is one undo step.
 */
export function repinPicture(
  session: Pick<ProjectSession, 'dispatch' | 'state'>,
  report: Report,
  linkId: string,
  name: string,
  caret: RepinCaret | null,
  node: { readonly id: string; readonly type: string },
): boolean {
  const plan = repinPlanOf(session.state.manifest.assetLinks ?? [], linkId, caret, node);
  if (plan.kind === 'refused') {
    report({ text: plan.text, tone: 'error' });
    return false;
  }
  if (!landed(report, session.dispatch('asset.repin', { linkId: plan.linkId, selection: { ...plan.selection } }))) return false;
  report({ text: repinDone(name), tone: 'info' });
  return true;
}

export function deletePicture(session: ProjectSession, report: Report, assetId: string): boolean {
  return landed(report, session.dispatch('asset.delete', { assetId }));
}
