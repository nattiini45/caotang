/**
 * **Replay…** (agent-harness §8.1): a recorded turn, or one of its model calls, run against another model on a copy of the project, so
 * a writer can answer "would a cheaper model have done this as well?" without restoring their work or paying blind.
 *
 * The dialog is the engine's front door and nothing more: it offers the modes the recording can actually support, says why it cannot
 * offer the others, shows the estimate before anything is sent, and runs only after the writer presses the button. A replay never
 * changes the project — the copy is a state nobody else holds — so there is no Apply here: adopting a result is a later, ordinary turn
 * of its own.
 *
 * UI SDK supplies the dialog and the select (focus, Escape, outside presses, keyboard); the comparison is text, and a diff is underlined
 * or struck as well as coloured, so it reads without colour.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@ui-sdk/react/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui-sdk/react/select';

import type { ReplayMode } from '@caotang/harness';
import type { ProfileView } from '@caotang/gateway';

import { wordDiff } from '../app/plan-preview.js';
import {
  defaultMode,
  destinationsOf,
  modeOffers,
  refusalText,
  type ReplayDestination,
  type ReplayOutcome,
} from '../app/replay-model.js';
import './replay-dialog.css';

/* lingui-set comment="The Replay dialog. Interpolated values: count, tokens and words are numbers; model and name are the writer's own provider names; text is a refusal or a step description." */

/** The label and the one line under it, per mode. `t` at the definition, so the catalogue has both before a paint. */
const modeLabel = (mode: ReplayMode): string =>
  mode === 'call' ? t`One model call` : mode === 'turn' ? t`The whole turn` : t`From the recording, free`;

const modeHint = (mode: ReplayMode): string =>
  mode === 'call'
    ? t`Sends the one recorded request again, word for word. No tool runs, so nothing can change.`
    : mode === 'turn'
      ? t`Runs the turn again from its instruction on a copy of the project, with the same approvals.`
      : t`Answers from the recording itself, with no key and no cost, so a bug report reproduces here.`;

function StepRow({ text }: { text: string }): ReactNode {
  return <li className="replay-step">{text}</li>;
}

/** One document's text as each side left it, the change marked word by word. */
function DraftRow({ row }: { row: ReplayOutcome['drafts'][number] }): ReactNode {
  const segments = useMemo(() => wordDiff(row.original, row.replay), [row.original, row.replay]);
  return (
    <div className="replay-draft" data-testid="replay-draft">
      <h4>
        {row.title} <span className="replay-faint">{row.field} · {row.words}</span>
      </h4>
      <p className="notes-diff replay-draft-text">
        {segments.map((segment, index) =>
          segment.kind === 'added' ? <ins key={index}>{segment.text}</ins> : segment.kind === 'removed' ? <del key={index}>{segment.text}</del> : <span key={index}>{segment.text}</span>,
        )}
      </p>
    </div>
  );
}

function Comparison({ outcome }: { outcome: ReplayOutcome }): ReactNode {
  return (
    <div className="replay-result" data-testid="replay-result">
      <p className="replay-headline">{outcome.headline}</p>
      {outcome.steps.length === 0 ? null : (
        <>
          <h4>
            <Trans>Steps that differ</Trans>
          </h4>
          <ol className="replay-steps">
            {outcome.steps.map((step) => (
              <StepRow key={step} text={step} />
            ))}
          </ol>
        </>
      )}
      {outcome.drafts.length === 0 ? (
        <p className="replay-faint">
          <Trans>The replay changed no text, so there is nothing to read side by side.</Trans>
        </p>
      ) : (
        <>
          <h4>
            <Trans>What the replay would change</Trans>
          </h4>
          {outcome.drafts.map((row) => (
            <DraftRow key={`${row.title}-${row.field}`} row={row} />
          ))}
        </>
      )}
      {outcome.stopped === undefined ? null : (
        <p className="replay-stopped" role="alert">
          {outcome.stopped}
        </p>
      )}
      <p className="replay-faint">{outcome.tokens}</p>
      <p className="replay-faint">
        <Trans>The project was not changed. Nothing is applied from a replay.</Trans>
      </p>
    </div>
  );
}

export interface ReplayDialogProps {
  /** The turn being replayed, or `null` when the dialog is closed. */
  readonly turn: { readonly turnId: string; readonly intent: string } | null;
  /** The saved profiles a replay may be sent to. */
  readonly profiles: readonly ProfileView[];
  /** Whether this tab kept the project as the turn found it. */
  readonly hasSnapshot: boolean;
  /** Whether the recording holds a request kept whole, which a call replay sends. */
  readonly hasCall: boolean;
  /** What a replay would cost, before it runs. Throws a refusal when the mode cannot run. */
  readonly onEstimate: (mode: ReplayMode, destination: ReplayDestination | undefined) => string;
  /** Runs the replay. */
  readonly onRun: (mode: ReplayMode, destination: ReplayDestination | undefined) => Promise<ReplayOutcome>;
  readonly onClose: () => void;
  /** Where focus goes when the dialog closes: the Replay… button that opened it, as every dialog in the app returns it. */
  readonly finalFocus?: () => HTMLElement | null;
}

export function ReplayDialog({ turn, profiles, hasSnapshot, hasCall, onEstimate, onRun, onClose, finalFocus }: ReplayDialogProps): ReactNode {
  useLingui();
  const cancel = useRef<HTMLButtonElement>(null);
  const destinations = useMemo(() => destinationsOf(profiles), [profiles]);
  const offers = useMemo(() => modeOffers({ hasCall, hasSnapshot, hasDestination: destinations.length > 0 }), [hasCall, hasSnapshot, destinations.length]);
  // What the writer picked, remembered with the turn it was picked for: a mode chosen on one turn is not this turn's, and the dialog
  // opens on the first mode this recording can actually run (#819).
  const [picked, setPicked] = useState<{ readonly turnId: string | null; readonly mode?: ReplayMode; readonly profileId?: string | null }>({ turnId: null });
  const mode = picked.turnId === (turn?.turnId ?? null) && picked.mode !== undefined ? picked.mode : defaultMode(offers);
  const profileId = picked.turnId === (turn?.turnId ?? null) && picked.profileId !== undefined ? picked.profileId : destinations[0]?.profileId ?? null;
  const setMode = (next: ReplayMode): void => setPicked({ turnId: turn?.turnId ?? null, mode: next, ...(profileId === null ? {} : { profileId }) });
  const setProfileId = (next: string | null): void => setPicked({ turnId: turn?.turnId ?? null, mode, profileId: next });
  const [estimate, setEstimate] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<ReplayOutcome | null>(null);

  const destination = destinations.find((entry) => entry.profileId === profileId) ?? destinations[0];
  const offered = offers.find((offer) => offer.mode === mode);
  // Nothing this turn can be replayed in: say so once, plainly, instead of opening on a mode that is checked and disabled.
  const runnable = offers.filter((offer) => offer.refused === undefined);

  const reset = (): void => {
    setEstimate(null);
    setProblem(null);
    setOutcome(null);
  };

  const estimator = (nextMode: ReplayMode, nextDestination: ReplayDestination | undefined): void => {
    reset();
    try {
      setEstimate(onEstimate(nextMode, nextDestination));
    } catch (error) {
      setProblem(refusalText(error) ?? (error instanceof Error ? error.message : String(error)));
    }
  };

  const run = async (): Promise<void> => {
    if (mode !== 'cassette' && destination === undefined) return;
    setRunning(true);
    setProblem(null);
    try {
      setOutcome(await onRun(mode, mode === 'cassette' ? undefined : destination));
    } catch (error) {
      setProblem(refusalText(error) ?? (error instanceof Error ? error.message : String(error)));
    } finally {
      setRunning(false);
    }
  };

  const close = (): void => {
    reset();
    onClose();
  };

  return (
    <Dialog open={turn !== null} onOpenChange={(open) => { if (!open && !running) close(); }}>
      <DialogContent
        container={typeof document === 'undefined' ? undefined : document.body}
        className="confirm replay-dialog"
        initialFocus={() => cancel.current}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        <div className="confirm-body" aria-busy={running}>
          <DialogTitle>
            <Trans>Replay this turn</Trans>
          </DialogTitle>
          <DialogDescription>
            {turn === null ? '' : turn.intent}
          </DialogDescription>
          <p className="replay-faint">
            <Trans>
              A replay answers “would another model have done this as well?”. It runs on a copy of the project, so nothing here changes your manuscript, and it reaches only a provider you have already set up.
            </Trans>
          </p>

          {runnable.length === 0 ? (
            <p className="form-message" role="status" data-testid="replay-unavailable">
              <Trans>This turn cannot be replayed yet. Its recorded start is kept only while traces are on, and the turn and recorded-answer modes also need one. Turn traces on, run a turn, then open it here.</Trans>
            </p>
          ) : null}
          <fieldset className="replay-modes">
            <legend>
              <Trans>What to replay</Trans>
            </legend>
            {offers.map((offer) => (
              <label key={offer.mode} className="check replay-mode">
                <input
                  type="radio"
                  name="replay-mode"
                  checked={mode === offer.mode}
                  disabled={offer.refused !== undefined || running}
                  onChange={() => {
                    setMode(offer.mode);
                    estimator(offer.mode, offer.mode === 'cassette' ? undefined : destination);
                  }}
                />
                <span>
                  {modeLabel(offer.mode)}
                  <span className="replay-faint"> — {modeHint(offer.mode)}</span>
                </span>
                {offer.refused === undefined ? null : <span className="replay-refused">{offer.refused}</span>}
              </label>
            ))}
          </fieldset>

          {mode === 'cassette' ? null : destinations.length === 0 ? (
            <p className="replay-faint">
              <Trans>No provider is saved yet, so there is nowhere to send a replay. Add one in Settings, then open this dialog again.</Trans>
            </p>
          ) : (
            <div className="replay-target">
              <label htmlFor="replay-profile">
                <Trans>Send it to</Trans>
              </label>
              <Select value={profileId ?? ''} onValueChange={(value) => {
                setProfileId(value);
                estimator(mode, destinations.find((entry) => entry.profileId === value));
              }}>
                <SelectTrigger id="replay-profile" className="replay-select" disabled={running}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((entry) => (
                    <SelectItem key={entry.profileId} value={entry.profileId}>
                      {entry.label} · {entry.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="replay-estimate">
            <button ref={cancel} type="button" className="button" disabled={running} onClick={close}>
              <Trans>Cancel</Trans>
            </button>
            <button
              type="button"
              className="button is-quiet"
              disabled={running || runnable.length === 0 || offered?.refused !== undefined}
              onClick={() => estimator(mode, mode === 'cassette' ? undefined : destination)}
            >
              <Trans>What it would cost</Trans>
            </button>
            <button
              type="button"
              className="button is-primary"
              disabled={running || estimate === null || problem !== null || runnable.length === 0 || (mode !== 'cassette' && destination === undefined)}
              onClick={() => void run()}
            >
              {running ? t`Replaying…` : t`Replay`}
            </button>
          </div>

          {estimate === null ? null : (
            <p className="replay-cost" data-testid="replay-cost">
              {estimate}
            </p>
          )}
          {problem === null ? null : (
            <p className="form-message is-error" role="alert" data-testid="replay-problem">
              {problem}
            </p>
          )}
          {outcome === null ? null : <Comparison outcome={outcome} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
