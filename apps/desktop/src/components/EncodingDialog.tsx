/**
 * The non-UTF-8 review an open pauses on (`PendingEncoding`): one card per file the load held,
 * with a preview of how its bytes read under each candidate encoding, an optional "Ask the AI"
 * (offered only when the background role resolves a real profile), and the writer's choice per
 * file — leave it byte-for-byte, or convert it to text Caotang can read.
 *
 * Nothing is written from inside the dialog: the choices are handed back as `EncodingDecision`s,
 * and `completeEncodingReview` applies them — a convert always writes the original bytes to
 * `.caotang-backup/` first. Cancel leaves the whole open untouched (an accepted recovery's write
 * is the one exception, and `cancelNote` then says so).
 */

import { isolate, numberFormat } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  decodeAs,
  detectEncoding,
  encodingName,
  type DecodableEncoding,
  type EncodingDetection,
  type EncodingIssue,
} from '@caotang/store';

import { ASK_EXCERPT_CHARS, encodingBackupPath, type EncodingAsker, type EncodingDecision } from '../app/encoding-review.js';
import { encodingPanelMachine, type EncodingPanelEvent, type EncodingPanelState } from '../app/encoding-dialog-model.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { formatterLocale } from '../i18n/format-locale.js';
import { UserText } from '../i18n/UserText.js';
import type { PendingEncoding } from '../app/lifecycle.js';
import { Modal, useModalDialog } from './modal.js';
import './encoding-dialog.css';


/* lingui-set comment="The encoding dialog. Interpolated values: path, name and profile are the writer's own file or provider names; encoding names a text encoding; size and count are numbers; reason is a failure message." */
export interface EncodingDialogProps {
  readonly pending: PendingEncoding;
  /** The background-role ask, or `null` when no real profile resolves — no "Ask the AI" is offered then. */
  readonly asker: EncodingAsker | null;
  /** The open's continuation is running; every control waits for it. */
  readonly busy: boolean;
  readonly onDone: (decisions: readonly EncodingDecision[]) => void;
  readonly onCancel: () => void;
}

/** How much of a decoded preview is shown: enough to judge the reading, not the whole file. */
const PREVIEW_CHARS = 3000;

/**
 * Whether the top two candidates are close enough to say the detection is not sure: their scores are
 * within this margin and both read as credible text. A certain answer (a BOM) never says it.
 */
function isUncertain(detection: EncodingDetection): boolean {
  if (detection.certain) return false;
  const [first, second] = detection.candidates;
  if (first === undefined || second === undefined) return false;
  return second.score >= first.score - 0.25;
}

/** A file's bytes as readable size text, for the line under its name. */
function sizeText(size: number): string {
  if (size < 1024) return plural(size, { one: '# byte', other: '# bytes' });
  const kilobytes = numberFormat(formatterLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(size / 1024);
  return t`${kilobytes} KB`;
}

/** The picker's label for an encoding — `encodingName` covers every candidate; UTF-8 is the odd defensive case. */
function encodingLabel(encoding: DecodableEncoding): string {
  return encoding === 'utf-8' ? 'UTF-8' : encodingName(encoding);
}

/** One file's card: name, guess, the encoding picker and preview, the AI button, and the leave/convert choice. */
function IssueCard({
  issue,
  panel,
  asker,
  busy,
  onAsk,
  onChoose,
  onAction,
}: {
  readonly issue: EncodingIssue;
  readonly panel: EncodingPanelState;
  readonly asker: EncodingAsker | null;
  readonly busy: boolean;
  readonly onAsk: () => void;
  readonly onChoose: (encoding: DecodableEncoding) => void;
  readonly onAction: (action: 'leave' | 'convert') => void;
}): ReactNode {
  useLingui();
  const titleId = useId();
  const selectId = useId();
  const backupPath = encodingBackupPath(issue.path);
  const group = useId();
  const ready = panel.kind === 'ready' || panel.kind === 'asking' ? panel : undefined;
  const asking = panel.kind === 'asking';
  const preview = useMemo(() => {
    if (ready?.chosen === undefined) return null;
    const { text } = decodeAs(ready.bytes, ready.chosen);
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  }, [ready]);

  const detection = ready?.detection;
  // The picker's entries: the scored candidates, plus the chosen encoding when it is not among them.
  const options: readonly DecodableEncoding[] = useMemo(() => {
    const listed = (detection?.candidates ?? []).map((candidate) => candidate.encoding);
    return ready?.chosen !== undefined && !listed.includes(ready.chosen) ? [ready.chosen, ...listed] : listed;
  }, [detection, ready]);

  const guessLine =
    issue.encoding === 'unknown'
      ? t`Caotang cannot tell what encoding it is.`
      : t`Its bytes look like ${{ encoding: encodingName(issue.encoding) }}.`;

  return (
    <section className="encoding-file" aria-labelledby={titleId} data-state={panel.kind}>
      <h3 id={titleId}>{issue.path}</h3>
      <p className="encoding-hint">
        {detection !== undefined && isUncertain(detection)
          ? t`${{ size: sizeText(issue.size) }} — ${{ guess: guessLine }} Caotang is not sure which of these it is — compare the previews.`
          : t`${{ size: sizeText(issue.size) }} — ${{ guess: guessLine }}`}
      </p>
      {panel.kind === 'unreadable' ? (
        <p className="encoding-hint" role="alert">
          {t`The file could not be read for a preview: ${{ reason: panel.error }}`}
        </p>
      ) : null}
      {ready !== undefined && options.length > 0 ? (
        <>
          <div className="encoding-fields">
            <label htmlFor={selectId}><Trans>Read it as</Trans></label>
            <select
              id={selectId}
              value={ready.chosen ?? ''}
              disabled={busy}
              onChange={(event) => onChoose(event.target.value as DecodableEncoding)}
            >
              {options.map((encoding) => (
                <option key={encoding} value={encoding}>
                  {detection !== undefined && encoding === detection.best
                    ? t`${{ encoding: encodingLabel(encoding) }} — the best reading`
                    : encodingLabel(encoding)}
                </option>
              ))}
            </select>
            {asker !== null ? (
              <button type="button" className="button is-quiet" disabled={busy || asking} onClick={onAsk}>
                {asking ? t`Asking…` : t`Ask the AI`}
              </button>
            ) : null}
          </div>
          {panel.kind === 'ready' && panel.aiNote !== undefined ? (
            <p className="encoding-hint" role="status">
              {panel.aiNote}
            </p>
          ) : null}
          {preview !== null ? (
            <pre className="encoding-preview" aria-label={accessibleText(t`Preview of ${{ path: isolate(issue.path) }} read as ${{ encoding: encodingLabel(ready.chosen ?? 'windows-1252') }}`)}>
              {preview === '' ? t`The file is empty.` : preview}
            </pre>
          ) : null}
        </>
      ) : null}
      <fieldset className="encoding-choice">
        <legend><Trans>What should Caotang do with it?</Trans></legend>
        <label>
          <input
            type="radio"
            name={group}
            checked={ready?.action !== 'convert'}
            disabled={busy}
            onChange={() => onAction('leave')}
          />
          <Trans>Leave it as it is — the file is not changed.</Trans>
        </label>
        <label>
          <input
            type="radio"
            name={group}
            checked={ready?.action === 'convert'}
            disabled={busy || ready === undefined}
            onChange={() => onAction('convert')}
          />
          <Trans>Convert it — the file is rewritten as text Caotang can read, and its original bytes are kept at <UserText value={backupPath} />.</Trans>
        </label>
      </fieldset>
    </section>
  );
}

export function EncodingDialog({ pending, asker, busy, onDone, onCancel }: EncodingDialogProps): ReactNode {
  useLingui();
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  // One pending per mount — answering unmounts the dialog before the open continues — so the
  // panels start as placeholders and the effect below fills each with its file's bytes.
  const [panels, setPanels] = useState<readonly EncodingPanelState[]>(() =>
    pending.issues.map(() => ({ kind: 'loading' })),
  );
  const panelsRef = useRef(panels);
  const request = useRef(0);
  const live = useRef(true);
  const movePanel = (index: number, event: EncodingPanelEvent): void => {
    if (!live.current) return;
    const current = panelsRef.current[index];
    if (current === undefined) return;
    const next = encodingPanelMachine.step(current, event);
    if (next === current) return;
    panelsRef.current = panelsRef.current.map((panel, i) => i === index ? next : panel);
    setPanels(panelsRef.current);
  };
  const closePanels = (): void => {
    panelsRef.current = panelsRef.current.map((panel) => encodingPanelMachine.step(panel, { type: 'close' }));
  };

  useModalDialog(ref, true, 'dialog', cancel);

  // Read each file's bytes once, on mount: the previews are pure decodes of them, so the file is
  // never asked for again while the dialog is open.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    panelsRef.current = pending.issues.map(() => ({ kind: 'loading' }));
    setPanels(panelsRef.current);
    pending.issues.forEach((issue, index) => {
      void pending.fs
        .readBytes(issue.path)
        .then((bytes) => {
          if (!alive) return;
          const detection = detectEncoding(bytes);
          movePanel(index, { type: 'loaded', bytes, detection, issue });
        })
        .catch((error: unknown) => {
          if (!alive) return;
          const message = error instanceof Error ? error.message : String(error);
          movePanel(index, { type: 'unreadable', error: message });
        });
    });
    return () => {
      alive = false;
    };
  }, [pending]);

  /** Asks the AI which encoding fits this file's previewed excerpt; its answer picks the preview, never writes. */
  const askFor = (index: number): void => {
    if (asker === null || busy || !live.current) return;
    const panel = panelsRef.current[index];
    const issue = pending.issues[index];
    if (panel === undefined || issue === undefined || panel.kind !== 'ready' || panel.chosen === undefined) {
      return;
    }
    const excerpt = decodeAs(panel.bytes, panel.chosen).text.slice(0, ASK_EXCERPT_CHARS);
    const candidates = (panel.detection?.candidates ?? []).map((candidate) => candidate.encoding);
    if (candidates.length === 0) return;
    const serial = ++request.current;
    movePanel(index, { type: 'ask', request: serial });
    void Promise.resolve().then(() => asker.ask({ excerpt, candidates }))
      .then((pick) => {
        if (pick === undefined) {
          movePanel(index, { type: 'answered', request: serial, note: t`The AI’s answer did not name one of the encodings.` });
        } else {
          movePanel(index, { type: 'answered', request: serial, encoding: pick, note: t`The AI suggests ${{ encoding: encodingLabel(pick) }}.` });
        }
      })
      .catch((error: unknown) => {
        movePanel(index, {
          type: 'answered', request: serial,
          note: t`The AI could not be asked: ${{ reason: error instanceof Error ? error.message : String(error) }}`,
        });
      });
  };

  const finish = (): void => {
    if (busy) return;
    const decisions: EncodingDecision[] = pending.issues.map((issue, index) => {
      const panel = panelsRef.current[index];
      if ((panel?.kind === 'ready' || panel?.kind === 'asking') && panel.action === 'convert') {
        return { path: issue.path, action: 'convert', ...(panel.chosen === undefined ? {} : { encoding: panel.chosen }) };
      }
      return { path: issue.path, action: 'leave' };
    });
    closePanels();
    onDone(decisions);
  };
  const cancelReview = (): void => {
    if (busy) return;
    closePanels();
    onCancel();
  };

  const count = pending.issues.length;
  const name = isolate(pending.name);
  return (
    <Modal
      ref={ref}
      className="confirm encoding-dialog"
      aria-labelledby={titleId}
      data-testid="encoding-dialog"
      onCancel={(event) => {
        event.preventDefault();
        cancelReview();
      }}
    >
      <form method="dialog" className="confirm-body">
        <h2 id={titleId}>{plural(count, { one: 'One file is not UTF-8 text', other: '# files are not UTF-8 text' })}</h2>
        <div className="confirm-text">
          <p>
            {plural(count, {
              one: `“${name}” holds a file Caotang cannot read as it is. Preview how its bytes read, then choose: convert it to text Caotang can read — the original bytes are kept in the project’s .caotang-backup folder — or leave it exactly as it is.`,
              other: `“${name}” holds # files Caotang cannot read as they are. For each one, preview how its bytes read, then choose: convert it to text Caotang can read — the original bytes are kept in the project’s .caotang-backup folder — or leave it exactly as it is.`,
            })}
          </p>
          {asker !== null ? (
            <p>
              {t`“Ask the AI” sends the previewed excerpt of that one file to ${{ profile: isolate(asker.profileName) }}. Nothing else is sent, and nothing is written unless you choose Convert.`}
            </p>
          ) : null}
        </div>
        <div className="encoding-list">
          {pending.issues.map((issue, index) => (
            <IssueCard
              key={issue.path}
              issue={issue}
              panel={panels[index] ?? { kind: 'loading' }}
              asker={asker}
              busy={busy}
              onAsk={() => askFor(index)}
              onChoose={(encoding) => movePanel(index, { type: 'choose', encoding })}
              onAction={(action) => movePanel(index, { type: 'action', action })}
            />
          ))}
        </div>
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="button" autoFocus disabled={busy} onClick={cancelReview}>
            <Trans>Cancel</Trans>
          </button>
          <button type="button" className="button is-primary" disabled={busy} onClick={finish}>
            <Trans>Open the project</Trans>
          </button>
        </div>
      </form>
    </Modal>
  );
}
