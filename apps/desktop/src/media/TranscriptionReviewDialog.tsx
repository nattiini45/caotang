/**
 * The P14 transcription review gate's dialog (pictures.md §8.4 step 3): while the broker
 * (`../app/transcription-review.ts`) holds a proposal, this shows one page at a time — the picture and its
 * transcribed text side by side, a per-page include checkbox, an editable text with the marked words in a
 * rendered ghost beside it, and Approve/Cancel. Nothing is written from here: Approve hands the selected pages
 * back to the broker, and the harness port publishes them as one `asset.transcribe`.
 *
 * A re-transcription is diffed against the page's currently approved text (searchable `expect.text`, or the
 * document section the new-document `expect.docId` and its `source` links point at), and says so plainly when
 * no earlier text is available. The second read is never merged into the editable text.
 */

import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { reviewPagesOf, type PictureTranscriptionProposal, type PictureTranscriptionReviewPage } from '@caotang/harness';
import type { ReadAssetRecord } from '@caotang/pictures';
import { getBody } from '@caotang/store';

import type { TranscriptionReviewBroker } from '../app/transcription-review.js';
import type { ProjectSession } from '../app/session.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { UserText } from '../i18n/UserText.js';
import { altOf, pictureLabelOf } from './picture-board-model.js';
import { usePictureImage } from './picture-hooks.js';
import {
  answerOf,
  approvedTextFromSource,
  diffSpansOf,
  ghostSegmentsOf,
  type GhostSegment,
  type PageEdit,
} from './transcription-review-model.js';

/* lingui-set comment="The transcription review dialog. Interpolated values: file is a stored file name; current and total are the page position; second is the second read's word." */

export interface TranscriptionReviewDialogProps {
  readonly session: ProjectSession;
  /** The transient gate the harness's `PictureTranscriptionHost.review` is wired to. */
  readonly broker: TranscriptionReviewBroker;
}

/**
 * The review gate itself: a native `<dialog>` (focus trapped, Escape cancels) that is open exactly while the
 * broker holds a proposal. Mounted by AgentPanel; renders nothing of its own when closed.
 */
/** A serial per proposal object, so each held review mounts its body fresh with the default edits. */
const serials = new WeakMap<PictureTranscriptionProposal, number>();
let nextSerial = 0;
function serialOf(proposal: PictureTranscriptionProposal): number {
  const held = serials.get(proposal);
  if (held !== undefined) return held;
  const serial = nextSerial;
  nextSerial += 1;
  serials.set(proposal, serial);
  return serial;
}

export function TranscriptionReviewDialog({ session, broker }: TranscriptionReviewDialogProps): ReactNode {
  useLingui();
  const subscribe = useCallback((onChange: () => void) => broker.subscribe(() => onChange()), [broker]);
  const getSnapshot = useCallback(() => broker.snapshot(), [broker]);
  // The third argument is the server snapshot, so a static render reads the same held proposal.
  const proposal = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (proposal !== null && !dialog.open) dialog.showModal();
    if (proposal === null && dialog.open) dialog.close();
  }, [proposal]);

  return (
    <dialog
      ref={ref}
      className="transcription-review-dialog"
      aria-labelledby={titleId}
      data-testid="transcription-review-dialog"
      onCancel={(event) => {
        event.preventDefault();
        broker.cancel();
      }}
    >
      {/* The key remounts the body per held proposal, so a queued review starts from the default edits even when
          it replaces the held one without a null in between. */}
      {proposal === null ? null : <ReviewBody key={serialOf(proposal)} session={session} broker={broker} proposal={proposal} titleId={titleId} />}
    </dialog>
  );
}

/** One held proposal's review: page navigation, per-page include and editable text, the diff, Approve/Cancel. */
function ReviewBody({
  session,
  broker,
  proposal,
  titleId,
}: {
  readonly session: ProjectSession;
  readonly broker: TranscriptionReviewBroker;
  readonly proposal: PictureTranscriptionProposal;
  readonly titleId: string;
}): ReactNode {
  useLingui();
  // Re-render on every commit while the gate is open (an edit or an undo), so the approved text the diff reads
  // is the body as it is now. The third argument is the server snapshot, so a static render reads the same version.
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
  const pages = useMemo(() => reviewPagesOf(proposal), [proposal]);
  // The parent's key remounts this body per proposal, so these start from the defaults: every page included, first-read text.
  const [edits, setEdits] = useState<ReadonlyMap<string, PageEdit>>(new Map());
  const [pageIndex, setPageIndex] = useState(0);
  const [title, setTitle] = useState('');

  const page: PictureTranscriptionReviewPage | undefined = pages[Math.min(pageIndex, pages.length - 1)];
  const record: ReadAssetRecord | undefined = useMemo(
    () => (page === undefined ? undefined : (session.state.manifest.assets ?? []).find((candidate) => candidate.id === page.assetId)),
    [page, session],
  );
  const image = usePictureImage(session, record, true, session.assetsVersion());

  const planPage = page === undefined ? undefined : proposal.plan.pages.find((candidate) => candidate.assetId === page.assetId);
  const approved =
    page === undefined || planPage === undefined
      ? null
      : approvedTextFromSource(page.assetId, planPage.expect, {
          bodyOf: (docId) => getBody(session.state, docId),
          links: session.state.manifest.assetLinks,
        });
  const diffSpans = approved === null || page === undefined ? undefined : diffSpansOf(approved, edits.get(page.assetId)?.text ?? page.text);
  const ghost = page === undefined ? [] : ghostSegmentsOf(page.text, page.disagreements);
  const diffGhost = approved === null || diffSpans === undefined ? [] : ghostSegmentsOf(approved, diffSpans);

  const answer = answerOf(proposal.plan, pages, edits, title);
  const selectedCount = proposal.plan.pages.filter((candidate) => (edits.get(candidate.assetId)?.included ?? true)).length;

  const setPageEdit = (assetId: string, patch: PageEdit): void => {
    setEdits((previous) => {
      const next = new Map(previous);
      next.set(assetId, { ...next.get(assetId), ...patch });
      return next;
    });
  };
  const approve = (): void => {
    if (answer.ok) broker.answer(answer.result);
  };
  const cancel = (): void => broker.cancel();

  const contentLang = session.state.manifest.project.language;
  const file = page?.file ?? page?.assetId ?? '';
  const label = record === undefined ? file : pictureLabelOf(record);
  const alt = (record === undefined ? '' : altOf(record)) || label;
  const edit = page === undefined ? undefined : edits.get(page.assetId);
  const included = edit?.included ?? true;
  const text = edit?.text ?? page?.text ?? '';
  const blankFile =
    answer.ok || answer.assetId === undefined ? '' : (proposal.plan.pages.find((candidate) => candidate.assetId === answer.assetId)?.file ?? answer.assetId);
  const legendId = useId();
  const textId = useId();
  const diffId = useId();

  return (
    <form method="dialog" className="export-body" data-page={page?.assetId}>
      <h2 id={titleId}>
        <Trans>Review the transcription</Trans>
      </h2>
      <div className="confirm-text">
        <p>
          <Trans>
            Each page was read from its image by the model. Check every marked word against the ink and edit the text wherever it is
            wrong: [?…?] marks an uncertain word, [illegible] a span that could not be read, and a highlighted disagreement is where
            the second read saw something else. Historical handwriting is easy to misread, so read the page itself before approving.
          </Trans>
        </p>
        <p className="muted" id={legendId}>
          {plural({ count: pages.length }, { one: '# page to review', other: '# pages to review' })}
          {'; '}
          {plural({ count: selectedCount }, { one: '# page selected', other: '# pages selected' })}
        </p>
      </div>

      <div className="pb-head-actions">
        <button type="button" className="button is-quiet" disabled={page === undefined || pageIndex <= 0} onClick={() => setPageIndex(pageIndex - 1)}>
          <Trans>Previous page</Trans>
        </button>
        <span className="muted">{t`Page ${{ current: pageIndex + 1 }} of ${{ total: pages.length }}`}</span>
        <button
          type="button"
          className="button is-quiet"
          disabled={page === undefined || pageIndex >= pages.length - 1}
          onClick={() => setPageIndex(pageIndex + 1)}
        >
          <Trans>Next page</Trans>
        </button>
        <label className="pb-check">
          <input
            type="checkbox"
            checked={included}
            onChange={(event) => {
              if (page !== undefined) setPageEdit(page.assetId, { included: event.target.checked });
            }}
          />
          <span>
            <Trans>Include this page</Trans>
          </span>
        </label>
      </div>

      <div className="picker-row">
        <figure>
          <span className="pb-thumb">
            {image.url !== null ? (
              <img src={image.url} alt={alt} />
            ) : image.state === 'missing' ? (
              <span className="pb-placeholder is-missing">
                <Trans>File missing</Trans>
              </span>
            ) : image.state === 'error' ? (
              <span className="pb-placeholder is-missing">
                <Trans>Could not be read</Trans>
              </span>
            ) : (
              <span className="pb-placeholder" aria-busy="true">
                <Trans>Loading…</Trans>
              </span>
            )}
          </span>
          <figcaption className="muted">
            <UserText value={label} lang={contentLang} />
          </figcaption>
        </figure>
        <div className="picker-row">
          <div className="muted" dir="auto" aria-hidden="true">
            <MarkedText segments={ghost} />
          </div>
          <label className="pb-filter">
            <span className="field-label">
              <Trans>Transcribed text</Trans>
            </span>
            <textarea
              id={textId}
              value={text}
              rows={10}
              dir="auto"
              lang={contentLang}
              aria-label={accessibleText(t`Transcribed text of ${{ file: isolate(file) }}`)}
              aria-describedby={approved === null ? legendId : `${legendId} ${diffId}`}
              onChange={(event) => {
                if (page !== undefined) setPageEdit(page.assetId, { text: event.target.value });
              }}
            />
          </label>
        </div>
      </div>

      {page?.disagreements !== undefined && page.disagreements.length > 0 ? (
        <p className="muted">
          {plural({ count: page.disagreements.length }, { one: 'The second read differs on # word: ', other: 'The second read differs on # words: ' })}
          {isolate(page.disagreements.map((disagreement) => (disagreement.first === '' ? disagreement.second : `${disagreement.first} → ${disagreement.second}`)).join('; '))}
        </p>
      ) : null}

      {approved === null ? (
        <p className="muted">
          <Trans>No earlier approved text is available for this page, so the new read cannot be diffed against one.</Trans>
        </p>
      ) : (
        <div>
          <p className="field-label" id={diffId}>
            {t`Diff against the approved text of ${{ file: isolate(file) }}:`}
          </p>
          <div className="muted" dir="auto" aria-hidden="true">
            <MarkedText segments={diffGhost} />
          </div>
          {diffSpans !== undefined && diffSpans.length === 0 ? (
            <p className="muted">
              <Trans>The new read matches the approved text.</Trans>
            </p>
          ) : null}
        </div>
      )}

      {proposal.plan.into === 'new-document' ? (
        <label className="pb-filter">
          <span className="field-label">
            <Trans>Title of the new document (optional)</Trans>
          </span>
          <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
          <span className="muted">
            <Trans>Leave empty to title the document from the first non-empty line of the first approved page.</Trans>
          </span>
        </label>
      ) : null}

      {!answer.ok ? (
        <p className="field-note is-complaint" role="alert">
          {answer.reason === 'no-pages-selected' ? (
            <Trans>Select at least one page before approving.</Trans>
          ) : (
            t`The text of ${{ file: isolate(blankFile) }} is blank, so it cannot be approved. Add the page’s text, or leave the page out.`
          )}
        </p>
      ) : null}

      <div className="confirm-actions">
        <button type="button" className="button" autoFocus onClick={cancel}>
          <Trans>Cancel</Trans>
        </button>
        <button type="button" className="button is-primary" data-testid="transcription-review-approve" disabled={!answer.ok} onClick={approve}>
          <Trans>Approve the selected pages</Trans>
        </button>
      </div>
    </form>
  );
}

/** The ghost's marked runs: plain spans, and `<mark>`s carrying the second read's word where one disagrees. */
function MarkedText({ segments }: { readonly segments: readonly GhostSegment[] }): ReactNode {
  useLingui();
  return (
    <>
      {segments.map((segment, index) =>
        segment.mark === null ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <mark
            key={index}
            data-mark={segment.mark}
            title={segment.second === undefined ? undefined : isolate(segment.second)}
            aria-label={
              segment.mark === 'disagree' && segment.second !== undefined
                ? accessibleText(t`The second read says ${{ second: segment.second }}`)
                : segment.mark === 'illegible'
                  ? accessibleText(t`Illegible in the image`)
                  : accessibleText(t`Uncertain word`)
            }
          >
            {segment.text}
          </mark>
        ),
      )}
    </>
  );
}
