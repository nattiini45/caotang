/**
 * A plan card (agent-harness §2): the steps a turn asks to run, editable before the user approves them. Each change the user
 * makes is one `edit` decision, which the loop applies, checks and shows again, so the card on the screen is always the card
 * the loop holds. The loop shows the card again after every decision, and each showing is read afresh, so a value the loop
 * refused comes back as the card holds it. The one-step confirm card is the same card with one step.
 *
 * A step that has run is shown as done and cannot be changed (agent-harness §7). A step that has not run can have its expectation
 * and params edited, and the loop's preflight checks each edit again before the card is shown (agent-harness §2). A drafted step
 * is drafted again after an edit (agent-harness §8). A card whose preflight refused a step can be edited or cancelled, but not
 * approved. A drafted scene is approved only once its
 * draft has been on screen in its scene (agent-harness §8); a draft that is not on screen now is written out in its step. The
 * prompt behind each step is one click away (context-assembly §5).
 */

import { useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import {
  MODEL_BACKED_TOOLS,
  RESOLVE_BADGE,
  refusalSentence,
  type PromptPreview as ContextPreview,
  type ComicPreview,
  type Decision,
  type TimelineCard,
  type PlanCardView,
  type PlanEdit,
  type PlanStepView,
} from '@caotang/harness';
import type { ProjectState } from '@caotang/store';

import type { ProjectSession } from '../app/session.js';
import { usePictureThumb } from '../media/picture-hooks.js';
import { proposedByWords, type DraftCheck, type DraftedStep } from '../app/agent-model.js';
import { isImeEnter } from '../app/keymap.js';
import {
  costLineOf,
  formatUsd,
  NEW_ENTRY_FROM,
  planCostOf,
  refusalReasonOf,
  stepPreviewOf,
  type ReviewPreviewView,
  type StepPreviewView,
  type TranscriptionPreviewView,
} from '../app/plan-preview.js';
import { formatCount } from './shared.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { UserText } from '../i18n/UserText.js';

/* lingui-set comment="Plan preview and approval. Step numbers are one-based. Counts and costs are formatted values. Names, titles, tool parameter keys, code and draft text are supplied content, not translated." */

/** A step's estimated cost, as the card's step view carries it: the prompt's, or a staged review's (coherence.md §5.3). */
type PlanStepCost = NonNullable<PlanStepView['cost']>;

export interface TranscriptionRouteChoice {
  readonly profileId: string;
  readonly model?: string;
  readonly label: string;
  readonly vision: boolean;
}

export interface PlanCardProps {
  readonly card: PlanCardView;
  /** The loop is waiting for this card's decision. Only then are the controls live. */
  readonly live: boolean;
  /** The drafted scenes of the card and what they need before approval, while the loop waits for the decision; `null` otherwise. */
  readonly drafts: DraftCheck | null;
  /** The project the card acts on, which names what a step's preview refers to (a codex attachment, a restructure's place). */
  readonly project: ProjectState;
  /** Supplies real thumbnails to a transcription preview; headless card tests may omit it and show page names. */
  readonly session?: ProjectSession;
  /** The configured choices for an explicitly selected second transcription route. */
  readonly transcriptionRoutes?: readonly TranscriptionRouteChoice[];
  /** The project's pictures by asset id, as their file names: a codex step's visual references are named by these (video-prompt-pack §3). */
  readonly pictureNames: ReadonlyMap<string, string>;
  readonly onDecide: (decision: Decision) => void;
  /** The mode's policy approved this card, so the writer was not asked (agent-harness §4). */
  readonly auto?: boolean;
}

/** A card's heading: the one-step card, or the plan with the steps still to run. */
export function planHeading(card: PlanCardView): string {
  const count = card.steps.filter((step) => step.status !== 'done').length;
  return card.kind === 'confirm' ? t`One step to confirm` : plural(count, { one: 'Plan, # step', other: 'Plan, # steps' });
}

export function PlanCard({ card, live, drafts, project, session, transcriptionRoutes = [], pictureNames, onDecide, auto = false }: PlanCardProps): ReactNode {
  useLingui();
  const pending = card.steps.filter((step) => step.status !== 'done');
  // A retry drafts again the steps the loop drafts (agent-harness §8); a step with no draft is not one of them.
  const retryable = pending.some((step) => MODEL_BACKED_TOOLS.has(step.tool));
  const heading = planHeading(card);
  const edit = (edits: PlanEdit[]): void => onDecide({ action: 'edit', edits });
  const held = live ? (drafts?.blocked ?? null) : null;
  const approvable = live && card.approvable && held === null;
  // A refused step is why Approve is off, and its reason is the preflight's own words (plan-preview.ts `refusalReasonOf`).
  const refused = refusalReasonOf(card.steps);
  // The window check and the estimate are the prompt's own (context-assembly §5, §7), read from each step's preview.
  const windowWarnings = card.steps.flatMap((step) => {
    const warning = step.context?.window?.warning;
    return warning === undefined ? [] : [warning];
  });
  // A step's cost is its prompt's, or a coherence review's own estimate (coherence.md §5.3) when the step stages a review.
  const planCost = planCostOf(card.steps.map((step) => step.context?.cost?.totalUsd ?? step.cost?.totalUsd));

  return (
    <section className={`plan-card is-${card.kind}${live ? ' is-live' : ''}`} aria-label={accessibleText(heading)} data-testid="plan-card">
      <header className="plan-head">
        <h3>{heading}</h3>
        {live ? <span className="plan-state"><Trans>Waiting for you</Trans></span> : <span className="plan-state">{auto ? t`Approved as shown` : card.approvable ? t`Ready` : t`Not ready`}</span>}
      </header>

      <ol className="plan-steps" aria-label={t`Steps`}>
        {card.steps.map((step) => (
          <StepRow
            key={step.origin}
            step={step}
            live={live && step.status !== 'done'}
            draft={drafts?.steps.find((entry) => entry.index === step.index)}
            project={project}
            session={session}
            transcriptionRoutes={transcriptionRoutes}
            pictureNames={pictureNames}
            onEdit={edit}
            last={card.steps.length - 1}
          />
        ))}
      </ol>

      {card.notice !== undefined ? (
        <p className="plan-notice" role="status">
          {card.notice}
        </p>
      ) : null}
      {held !== null ? (
        <p className="plan-notice" role="status">
          {held}
        </p>
      ) : null}
      {windowWarnings.map((warning, index) => (
        <p key={`${index}:${warning}`} className="plan-notice is-warn" role="status">
          {warning}
        </p>
      ))}
      {planCost !== undefined ? <p className="plan-cost">{t`About ${{ cost: formatUsd(planCost) }} for the whole plan, at this profile’s prices.`}</p> : null}

      {/* A card the mode approved has nothing left to decide. */}
      <div className="plan-actions" hidden={auto}>
        <button type="button" className="button is-primary" disabled={!approvable} onClick={() => onDecide({ action: 'approve' })}>
          {card.kind === 'confirm' ? t`Approve` : t`Approve plan`}
        </button>
        {!approvable && refused !== undefined ? (
          <p className="plan-notice is-warn plan-approve-reason" role="status">
            {refused}
          </p>
        ) : null}
        {card.canAcceptCut ? (
          <button
            type="button"
            className="button"
            disabled={!live || held !== null}
            onClick={() => onDecide({ action: 'approve', acceptTruncated: true })}
          >
            <Trans>Approve and keep the cut text</Trans>
          </button>
        ) : null}
        {retryable ? (
          <button type="button" className="button" disabled={!live} onClick={() => onDecide({ action: 'retry' })}>
            {pending.every((step) => step.tool === 'timeline.edit' || !MODEL_BACKED_TOOLS.has(step.tool)) ? <Trans>Read the timeline again</Trans> : <Trans>Retry draft</Trans>}
          </button>
        ) : null}
        <button type="button" className="button is-quiet" disabled={!live} onClick={() => onDecide({ action: 'cancel' })}>
          <Trans>Cancel</Trans>
        </button>
      </div>
    </section>
  );
}

function StepRow({
  step,
  live,
  draft,
  project,
  session,
  transcriptionRoutes,
  pictureNames,
  onEdit,
  last,
}: {
  step: PlanStepView;
  live: boolean;
  draft: DraftedStep | undefined;
  project: ProjectState;
  session: ProjectSession | undefined;
  transcriptionRoutes: readonly TranscriptionRouteChoice[];
  pictureNames: ReadonlyMap<string, string>;
  onEdit: (edits: PlanEdit[]) => void;
  last: number;
}): ReactNode {
  const number = step.index + 1;
  const done = step.status === 'done';
  const shownHere = draft?.draft ?? null;
  const draftWords = shownHere?.words ?? 0;
  const preview = stepPreviewOf(step.tool, step.preview, project, pictureNames);
  return (
    <li className={`plan-step is-${step.status}`} data-tool={step.tool} data-step={number}>
      <div className="plan-step-head">
        <span className="plan-step-number">{number}</span>
        <code className="plan-step-tool">{step.tool}</code>
        <span className={`badge is-risk-${step.risk.replace(/[^a-z]+/g, '-')}`} title={t`Risk`}>
          {step.risk}
        </span>
        <span className={`plan-step-status is-${step.status}`}>{statusWord(step)}</span>
        {step.badges.includes(RESOLVE_BADGE) ? (
          <span className="badge is-warn" title={t`A step this one reads was changed; it is looked up again when this step runs`}>
            {t`will re-resolve at execution`}
          </span>
        ) : null}
        {step.stale ? (
          <span className="badge is-warn" title={t`The card cannot be approved until this step is checked again`}>
            {step.tool === 'timeline.edit' ? t`Proposed against earlier days or parts` : MODEL_BACKED_TOOLS.has(step.tool) ? t`Drafted against an earlier text` : t`Changed since it was checked`}
          </span>
        ) : null}
        {step.cut ? <span className="badge is-warn"><Trans>Cut at the output limit</Trans></span> : null}
        {proposedByWords(step) === undefined ? null : (
          <span className="badge" title={t`A delegated agent proposed this step as it stands. It is in your plan, and it only runs if you approve the plan.`}>
            {proposedByWords(step)}
          </span>
        )}
        {!done ? (
          <span className="plan-step-controls">
            <button
              type="button"
              className="button is-quiet"
              disabled={!live || step.index === 0}
              aria-label={t`Move step ${number} up`}
              onClick={() => onEdit([{ op: 'reorder', from: step.index, to: step.index - 1 }])}
            >
              ↑
            </button>
            <button
              type="button"
              className="button is-quiet"
              disabled={!live || step.index === last}
              aria-label={t`Move step ${number} down`}
              onClick={() => onEdit([{ op: 'reorder', from: step.index, to: step.index + 1 }])}
            >
              ↓
            </button>
            <button
              type="button"
              className="button is-quiet is-danger"
              disabled={!live}
              aria-label={t`Drop step ${number}`}
              onClick={() => onEdit([{ op: 'drop', index: step.index }])}
            >
              <Trans>Drop</Trans>
            </button>
          </span>
        ) : null}
      </div>

      <ExpectField step={step} live={live} onEdit={onEdit} />

      {step.error !== undefined ? <p className="plan-step-error">{refusalSentence(step.error.message, step.error.correctiveHint)}</p> : null}

      {!done ? <ParamFields step={step} live={live} onEdit={onEdit} /> : null}

      {preview !== undefined ? (
        <StepPreviewBlock
          view={preview}
          cost={step.cost}
          step={step}
          live={live}
          session={session}
          transcriptionRoutes={transcriptionRoutes}
          onEdit={onEdit}
        />
      ) : null}

      {shownHere !== null && draft !== undefined && !draft.onScreen ? (
        <figure className="plan-draft" aria-label={t`Draft for step ${number}`}>
          <figcaption>
            {shownHere.cut
              ? <Trans>Draft for “<UserText value={draft.title} />”, {draftWords} words, cut off at the output limit. It is not on screen in its scene now, so it is shown here.</Trans>
              : <Trans>Draft for “<UserText value={draft.title} />”, {draftWords} words. It is not on screen in its scene now, so it is shown here.</Trans>}
          </figcaption>
          <p>{shownHere.text}</p>
        </figure>
      ) : null}

      {step.context !== undefined ? <PromptPreview context={step.context} /> : null}
    </li>
  );
}

/**
 * What a coherence review reads and what it may cost, before the writer approves it (coherence.md §5.3, §7 tool 16): the
 * documents with their token estimates, the calls each stage makes at most, the cap on findings, and the first prompt. The
 * review changes no text, so the card says only what it will read.
 */
function ReviewPreviewBlock({ view, cost }: { view: ReviewPreviewView; cost?: PlanStepCost }): ReactNode {
  useLingui();
  const documents = view.documents.length;
  const extractCalls = view.extractCalls;
  const verifyCalls = view.verifyCallsAtMost;
  const tokens = formatCount(view.totalTokensAtMost);
  const findings = formatCount(view.maxFindings);
  // Shown only when the profile has a price (coherence.md §5.3): the same line a prompt's cost gets, with the bound the plan states.
  const line = costLineOf(cost);
  return (
    <figure className="plan-draft" aria-label={t`What this review reads`}>
      <figcaption><Trans>What this review reads, shown before approval</Trans></figcaption>
      <p>
        {t({
          message: `${plural(documents, { one: '# document', other: '# documents' })}: ${plural(extractCalls, { one: '# extraction call', other: '# extraction calls' })}, and at most ${plural(verifyCalls, { one: '# verification call', other: '# verification calls' })}, about ${tokens} tokens at most. Up to ${findings} findings are recorded in the inbox.`,
          comment: 'A coherence review plan summary. tokens and findings are formatted counts; each count is pluralised.',
        })}
      </p>
      {line !== undefined ? <p className="context-cost">{line}</p> : null}
      {view.overGuard ? (
        <p className="status-line is-error" role="status">
          <Trans>This scope is over the document guard, so approve it only if you mean the whole of it.</Trans>
        </p>
      ) : null}
      <ul>
        {view.documents.map((doc, index) => (
          <li key={`${doc.title}:${index}`}>
            <strong><UserText value={doc.title} /></strong>{' '}
            {doc.truncated
              ? t({ message: `(about ${{ tokens: formatCount(doc.tokens) }} tokens, cut to fit the budget)`, comment: 'A document the review reads; the value is a formatted token count.' })
              : t({ message: `(about ${{ tokens: formatCount(doc.tokens) }} tokens)`, comment: 'A document the review reads; the value is a formatted token count.' })}
            {doc.left.length > 0 ? ` ${t({ message: `Left out of its prompt: ${{ names: isolate(doc.left.join(', ')) }}`, comment: 'Names of codex entries or blocks the prompt budget left out; the value is writer content.' })}` : ''}
          </li>
        ))}
      </ul>
      <details>
        <summary><Trans>The first prompt the review sends</Trans></summary>
        <pre className="plan-prompt">{view.prompt}</pre>
      </details>
    </figure>
  );
}

function TranscriptionThumbnail({ session, assetId, title }: { session: ProjectSession | undefined; assetId: string; title: string }): ReactNode {
  if (session === undefined) return <span className="transcription-thumb-name"><UserText value={title} /></span>;
  return <TranscriptionThumbnailImage session={session} assetId={assetId} title={title} />;
}

function TranscriptionThumbnailImage({ session, assetId, title }: { session: ProjectSession; assetId: string; title: string }): ReactNode {
  const record = (session.state.manifest.assets ?? []).find((candidate) => candidate.id === assetId);
  const image = usePictureThumb(session, record, record !== undefined, session.assetsVersion());
  return (
    <figure className="transcription-thumb">
      {image.url === null ? <span className="transcription-thumb-placeholder" aria-hidden="true" /> : <img src={image.url} alt={accessibleText(title)} />}
      <figcaption><UserText value={title} lang={session.state.manifest.project.language} /></figcaption>
    </figure>
  );
}

/** The transcription schedule and both provider routes, shown before any image is sent (pictures.md §8.4). */
function TranscriptionPreviewBlock({
  view,
  step,
  live,
  session,
  transcriptionRoutes,
  onEdit,
}: {
  view: TranscriptionPreviewView;
  step: PlanStepView;
  live: boolean;
  session: ProjectSession | undefined;
  transcriptionRoutes: readonly TranscriptionRouteChoice[];
  onEdit: (edits: PlanEdit[]) => void;
}): ReactNode {
  useLingui();
  const selectedRoute = transcriptionRoutes.findIndex(
    (choice) => choice.profileId === view.secondRead?.profileId && (choice.model ?? '') === (view.secondRead.model ?? ''),
  );
  const primaryCost = costLineOf(view.routeCosts.primary);
  const secondCost = costLineOf(view.routeCosts.second);
  const batches = view.batchSizes.join(' + ');
  return (
    <figure className="plan-draft transcription-plan" aria-label={t`Transcription plan`}>
      <figcaption><Trans>Pages and model routes, shown before anything is sent</Trans></figcaption>
      <div className="transcription-thumbs">
        {view.pages.map((page) => <TranscriptionThumbnail key={page.assetId} session={session} assetId={page.assetId} title={page.title} />)}
      </div>
      <p>
        {t({
          message: `${plural({ pageCount: view.pages.length }, { one: '# page', other: '# pages' })} in ${plural({ requestCount: view.batchSizes.length }, { one: '# request', other: '# requests' })} per read (${batches}). Up to ${plural({ maxRequestCount: view.maxRequests }, { one: '# request', other: '# requests' })} if every batch needs single-page retries.`,
          comment: 'A transcription request schedule. batchSizes is a list such as 6 + 1; maxRequests includes second reads and fallback.',
        })}
      </p>
      <p>
        {view.into === 'new-document' ? <Trans>Approved pages become one Research document with source links.</Trans> : <Trans>Approved pages become searchable text on the picture records, with no new document.</Trans>}
        {' '}{t`Language hint: ${{ language: view.language }}.`}
      </p>
      <p><Trans>First read:</Trans> <UserText value={view.routes.primary.label} />{' '}{primaryCost ?? t`No price is listed for this route.`}</p>
      {view.routes.second !== undefined ? <p><Trans>Second read:</Trans> <UserText value={view.routes.second.label} />{' '}{secondCost ?? t`No price is listed for this route.`}</p> : null}
      {live && transcriptionRoutes.length > 0 ? (
        <label className="transcription-second-route">
          <span><Trans>Second read on another vision route</Trans></span>
          <select
            value={selectedRoute < 0 ? (view.secondRead === undefined ? '' : 'missing') : String(selectedRoute)}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === 'missing') return;
              const index = raw === '' ? -1 : Number(raw);
              const choice = index < 0 ? undefined : transcriptionRoutes[index];
              onEdit([{
                op: 'set',
                index: step.index,
                path: ['params', 'secondRead'],
                value: choice === undefined ? undefined : { profileId: choice.profileId, ...(choice.model === undefined ? {} : { model: choice.model }) },
              }]);
            }}
          >
            {view.secondRead !== undefined && selectedRoute < 0 ? <option value="missing" disabled><Trans>The selected route is no longer configured</Trans></option> : null}
            <option value=""><Trans>No second read</Trans></option>
            {transcriptionRoutes.map((choice, index) => (
              <option key={`${choice.profileId}:${choice.model ?? ''}`} value={String(index)} disabled={!choice.vision}>
                {choice.label}{choice.vision ? '' : ` (${t`no vision`})`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {view.warnings.includes('large-batch') ? <p className="status-line is-warn" role="status"><Trans>More than 20 pages are selected. Review them in smaller batches if the request budget is tight.</Trans></p> : null}
      {view.warnings.includes('non-english') ? <p className="status-line is-warn" role="status"><Trans>The language hint is not English. Check names and uncertain words carefully; the hint is not a claim about the handwriting.</Trans></p> : null}
      {view.warnings.includes('new-document') ? <p className="status-line is-warn" role="status"><Trans>Some pages already point to an approved transcription document. This run is a new ghost and will not rewrite that document.</Trans></p> : null}
      {view.warnings.includes('searchable') ? <p className="status-line is-warn" role="status"><Trans>Some pages already have searchable transcription text. The previous value is guarded until you approve this review.</Trans></p> : null}
      <p className="context-cost">
        {t`Estimated input ${{ input: formatCount(view.promptTokens) }} tokens and output ${{ output: formatCount(view.outputTokens) }} tokens across the planned reads. Actual provider use may differ.`}
      </p>
    </figure>
  );
}

/** The complete before/after value a comic tool staged, available before approval without a raw-params detour. */
function ComicValueChange({ before, after }: { readonly before: unknown; readonly after: unknown }): ReactNode {
  return (
    <details>
      <summary><Trans>Complete before and after values</Trans></summary>
      <div className="comic-preview-values">
        <pre className="plan-prompt" dir="auto" aria-label={t`Before this step`}>{JSON.stringify(before, null, 2)}</pre>
        <pre className="plan-prompt" dir="auto" aria-label={t`After this step`}>{JSON.stringify(after, null, 2)}</pre>
      </div>
    </details>
  );
}

/** C6's comic cards: every derived page, one lettered page, or the whole pages-to-script change. */
function ComicPreviewBlock({ view }: { readonly view: ComicPreview }): ReactNode {
  useLingui();
  if (view.kind === 'comic-derive') {
    return (
      <figure className="plan-draft comic-plan" aria-label={t`Comic page derivation`}>
        <figcaption><Trans>Pages derived from “<UserText value={view.script.title} />” for “<UserText value={view.book.title} />”, shown before approval</Trans></figcaption>
        {view.link.before === null ? <p><Trans>This derivation links the script to the book.</Trans></p> : null}
        <ol>
          {view.pages.map((page) => (
            <li key={`${page.pageId ?? 'new'}:${page.number}`} value={page.number}>
              <strong><UserText value={page.title} /></strong>{' '}
              {page.created ? <Trans>(new page)</Trans> : page.changed ? <Trans>(changed)</Trans> : <Trans>(unchanged)</Trans>}
              <p className="muted">
                {t`Panels: ${{ panels: page.panels }}; script lines: ${{ lines: page.lines }}; balloons placed: ${{ placed: page.placed }}; updated: ${{ updated: page.updated }}; removed: ${{ removed: page.removed }}.`}
              </p>
              <ComicValueChange before={page.before} after={page.after} />
            </li>
          ))}
        </ol>
      </figure>
    );
  }
  if (view.kind === 'comic-letter') {
    return (
      <figure className="plan-draft comic-plan" aria-label={t`Comic lettering change`}>
        <figcaption><Trans>Balloons lettered on “<UserText value={view.page.title} />” from “<UserText value={view.script.title} />”, shown before approval</Trans></figcaption>
        <p>
          {t`Script lines: ${{ lines: view.lines }}; balloons placed: ${{ placed: view.placed }}; updated: ${{ updated: view.updated }}.`}
          {view.panel === undefined ? null : <> {t`Panel ${{ panel: view.panel }}.`}</>}
          {view.line === undefined ? null : <> {t`Line ${{ line: view.line }}.`}</>}
        </p>
        <ComicValueChange before={view.before} after={view.after} />
      </figure>
    );
  }
  return (
    <figure className="plan-draft comic-plan" aria-label={t`Comic script change`}>
      <figcaption><Trans>The complete script written from “<UserText value={view.book.title} />”, shown before approval</Trans></figcaption>
      {view.link.created ? <p><Trans>This step creates the script document and links it to the book.</Trans></p> : null}
      <p>{t`Script lines: ${{ lines: view.lines }}; covered lines before: ${{ before: view.coverage.before }}; after: ${{ after: view.coverage.after }}.`}</p>
      <details>
        <summary><Trans>Script before this step</Trans></summary>
        <pre className="plan-prompt" dir="auto">{view.body.before ?? t`No script is linked yet.`}</pre>
      </details>
      <details>
        <summary><Trans>Script after this step</Trans></summary>
        <pre className="plan-prompt" dir="auto">{view.body.after}</pre>
      </details>
      <ul>
        {view.coverage.pages.map((page) => (
          <li key={page.pageId}>{t`Page ${{ number: page.number }}: covered lines ${{ before: page.before }} → ${{ after: page.after }}`}</li>
        ))}
      </ul>
    </figure>
  );
}

/** The writer's word for a field a timeline row changes. The harness names them in a closed set; one it does not know is shown as it came. */
function timelineFieldWords(field: string): string {
  switch (field) {
    case 'day':
      return t`Day`;
    case 'duration':
      return t`Duration`;
    case 'mode':
      return t`Mode`;
    case 'POV':
      return t`Point of view`;
    case 'story part':
      return t`Story part`;
    case 'after':
      return t`Must follow`;
    case 'position':
      return t`Place in the binder`;
    default:
      return field;
  }
}

function timelinePartWords(part: string): string {
  if (part === 'prologue') return t`Prologue`;
  if (part === 'epilogue') return t`Epilogue`;
  return t`Main story`;
}

function severityWords(severity: string): string {
  if (severity === 'error') return t`Error`;
  if (severity === 'warning') return t`Warning`;
  return t`Note`;
}

/** The findings a timeline batch would resolve or raise, as a heading, the listed ones and the count of those not listed. */
function TimelineFindings({ heading, empty, list, total }: { heading: string; empty: string; list: TimelineCard['findingsDelta']['added']; total: number }): ReactNode {
  const unlisted = total - list.length;
  return (
    <section aria-label={heading}>
      <h4 className="timeline-plan-heading">{heading}</h4>
      {total === 0 ? (
        <p>{empty}</p>
      ) : (
        <ul>
          {list.map((finding, index) => (
            <li key={`${finding.checkId}:${index}`}>
              <span className="badge is-warn">{severityWords(finding.severity)}</span> <UserText value={finding.message} />
            </li>
          ))}
        </ul>
      )}
      {unlisted > 0 ? <p className="field-note">{plural(unlisted, { one: '# more finding is not listed here.', other: '# more findings are not listed here.' })}</p> : null}
    </section>
  );
}

/** The timeline edit a step proposes: every field it changes with its value before and after, and the findings it would resolve and raise. */
function TimelinePreviewBlock({ view }: { readonly view: TimelineCard }): ReactNode {
  useLingui();
  const omitted = view.omittedRows ?? 0;
  const total = view.rows.length + omitted;
  return (
    <figure className="plan-draft timeline-plan" aria-label={t`Timeline changes this step makes`}>
      <figcaption>{plural(total, { one: '# timeline change, shown before approval', other: '# timeline changes, shown before approval' })}</figcaption>
      {view.rows.length === 0 ? (
        <p><Trans>This step changes no scene’s day, duration, part or place.</Trans></p>
      ) : (
        <table className="timeline-plan-rows">
          <caption className="visually-hidden"><Trans>Each change, from its value now to its value after this step</Trans></caption>
          <thead>
            <tr>
              <th scope="col"><Trans>Scene or folder</Trans></th>
              <th scope="col"><Trans>Part</Trans></th>
              <th scope="col"><Trans>Field</Trans></th>
              <th scope="col"><Trans>Before</Trans></th>
              <th scope="col"><Trans>After</Trans></th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, index) => (
              <tr key={`${row.node}:${row.field}:${index}`} data-field={row.field}>
                <th scope="row"><UserText value={row.node} /></th>
                <td>{timelinePartWords(row.part)}</td>
                <td>{timelineFieldWords(row.field)}</td>
                <td><UserText value={row.before} /></td>
                <td><UserText value={row.after} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {omitted > 0 ? <p className="field-note">{plural(omitted, { one: '# more change is not listed here. It is applied with the rest.', other: '# more changes are not listed here. They are applied with the rest.' })}</p> : null}
      <TimelineFindings heading={t`Findings this would resolve`} empty={t`It would resolve no open finding.`} list={view.findingsDelta.resolved} total={view.findingsDelta.resolvedCount} />
      <TimelineFindings heading={t`Findings this would raise`} empty={t`It would raise no new finding.`} list={view.findingsDelta.added} total={view.findingsDelta.addedCount} />
    </figure>
  );
}
/**
 * What a step will write, as its preview states it before approval (agent-harness §3, rows 7, 9 and 13): the synopses a batch
 * writes, a codex write's entry changes with their flags, or a restructure's tree from where each item sits to where it lands.
 */
function StepPreviewBlock({
  view,
  cost,
  step,
  live,
  session,
  transcriptionRoutes,
  onEdit,
}: {
  view: StepPreviewView;
  cost?: PlanStepCost;
  step: PlanStepView;
  live: boolean;
  session: ProjectSession | undefined;
  transcriptionRoutes: readonly TranscriptionRouteChoice[];
  onEdit: (edits: PlanEdit[]) => void;
}): ReactNode {
  useLingui();
  if (view.kind === 'review') return <ReviewPreviewBlock view={view} cost={cost} />;
  if (view.kind === 'transcription') {
    return <TranscriptionPreviewBlock view={view} step={step} live={live} session={session} transcriptionRoutes={transcriptionRoutes} onEdit={onEdit} />;
  }
  if (view.kind === 'comic-derive' || view.kind === 'comic-letter' || view.kind === 'comic-script-from-pages') {
    return <ComicPreviewBlock view={view} />;
  }
  if (view.kind === 'timeline-edit') return <TimelinePreviewBlock view={view} />;
  if (view.kind === 'notes') {
    const wordsBefore = view.wordsBefore;
    const wordsAfter = view.wordsAfter;
    return (
      <figure className="plan-draft" aria-label={t`Notes this step writes`}>
        <figcaption>
          <Trans>The notes of “<UserText value={view.doc} />”, word by word from the old to the new ({wordsBefore} words to {wordsAfter}), shown before approval</Trans>
        </figcaption>
        <p className="notes-diff">
          {view.segments.map((segment, index) =>
            segment.kind === 'added' ? (
              <ins key={index}>{segment.text}</ins>
            ) : segment.kind === 'removed' ? (
              <del key={index}>{segment.text}</del>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </p>
      </figure>
    );
  }
  if (view.kind === 'shots') {
    const shotCount = view.shots.length;
    const folder = isolate(view.folder);
    return (
      <figure className="plan-draft" aria-label={t`Shots this step creates`}>
        <figcaption>
          {t({
            message: plural(shotCount, {
              one: `# shot, in a new folder “${folder}”, shown before approval`,
              other: `# shots, in a new folder “${folder}”, shown before approval`,
            }),
            comment: 'folder is the isolated name of the storyboard folder the derive creates.',
          })}
        </figcaption>
        <ol>
          {/* Each shot is numbered as the derive numbers it, not by its place in the list, so the card and the folder agree. */}
          {view.shots.map((shot) => (
            <li key={`${shot.number}:${shot.title}`} value={shot.number}>
              <strong>{shot.title}</strong>
              {shot.spec === '' ? '' : ` (${shot.spec})`}
            </li>
          ))}
        </ol>
        {view.lines.length > 0 ? (
          <pre className="plan-prompt" aria-label={t`Target tree`}>
            {view.lines.join('\n')}
          </pre>
        ) : null}
        {view.notes.map((note) => (
          <p key={note} className="field-note">
            {note}
          </p>
        ))}
      </figure>
    );
  }
  if (view.kind === 'ink') {
    return (
      <figure className="plan-draft" aria-label={t`Dialogue this step writes`}>
        <figcaption><Trans>Dialogue this step writes to “<UserText value={view.container} />”, shown before approval</Trans></figcaption>
        <pre className="plan-prompt">{view.ink}</pre>
        {view.warnings.map((warning) => (
          <p key={warning} className="field-note">
            {warning}
          </p>
        ))}
      </figure>
    );
  }
  if (view.kind === 'synopses') {
    const synopsisCount = view.rows.length;
    return (
      <figure className="plan-draft" aria-label={t`Synopses this step writes`}>
        <figcaption>{plural(synopsisCount, { one: '# synopsis, shown before approval', other: '# synopses, shown before approval' })}</figcaption>
        <ul>
          {view.rows.map((row, index) => (
            <li key={`${row.doc}:${index}`}>
              <strong><UserText value={row.doc} /></strong>{' '}
              {row.action === 'create'
                ? <Trans>(new, {{ words: row.words }} words): <UserText value={row.synopsis} /></Trans>
                : <Trans>(replaces the current one, {{ words: row.words }} words): <UserText value={row.synopsis} /></Trans>}
            </li>
          ))}
        </ul>
      </figure>
    );
  }
  if (view.kind === 'codex') {
    return (
      <figure className="plan-draft" aria-label={t`Codex entries this step writes`}>
        <figcaption><Trans>What this step writes to the codex</Trans></figcaption>
        <ul>
          {view.entries.map((entry, index) => (
            <li key={`${entry.name}:${index}`}>
              <strong>
                {entry.action === 'create'
                  ? <Trans>New entry: <UserText value={entry.name} /></Trans>
                  : <Trans>Changes to <UserText value={entry.name} /></Trans>}
              </strong>
              {entry.changes.length > 0 ? (
                <ul>
                  {entry.changes.map((change) => (
                    <li key={change.field}>
                      {/* A new entry has no earlier value, so its fields read as "label: value" rather than "(new entry) → value". */}
                      {change.from === NEW_ENTRY_FROM
                        ? t({ message: `${{ field: change.field }}: ${{ to: isolate(change.to) }}`, comment: 'A codex field of a new entry: the field label, then its proposed value (writer content).' })
                        : t({ message: `${{ field: change.field }}: ${{ from: isolate(change.from) }} → ${{ to: isolate(change.to) }}`, comment: 'A codex field change: the field label, the old value, then the new value (writer content).' })}
                    </li>
                  ))}
                </ul>
              ) : null}
              {entry.attached.length > 0 ? <p><Trans>Attached to <UserText value={entry.attached.join(', ')} /></Trans></p> : null}
              {entry.detached.length > 0 ? <p><Trans>Taken off <UserText value={entry.detached.join(', ')} /></Trans></p> : null}
              {entry.flags.map((flag) => (
                <span key={flag} className="badge is-warn">
                  {flag}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </figure>
    );
  }
  return (
    <figure className="plan-draft" aria-label={t`Tree this step changes`}>
      <figcaption><Trans>Where each item sits now, and where this step puts it</Trans></figcaption>
      <ul>
        {view.rows.map((row, index) => (
          <li key={`${row.title}:${index}`}>
            <strong><UserText value={row.title} /></strong>
            {' — '}
            {t({ message: `${{ change: row.change }}: from ${{ from: row.from }} to ${{ to: row.to }}`, comment: 'A restructure row after the item title. change is a translated word such as Moved; from and to are places that already name their isolated titles.' })}
          </li>
        ))}
      </ul>
      {view.lines.length > 0 ? (
        <ul>
          {view.lines.map((line, index) => (
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}

function statusWord(step: PlanStepView): string {
  if (step.status === 'done') return t`Done`;
  if (step.status === 'refused') return t`Refused`;
  if (step.status === 'deferred') return t`Waits for an earlier step`;
  return t`Ready`;
}

/**
 * The expectation of a step. An empty edit is not sent, and the field goes back to the card's own text, as a refused edit does.
 */
function ExpectField({ step, live, onEdit }: { step: PlanStepView; live: boolean; onEdit: (edits: PlanEdit[]) => void }): ReactNode {
  const [value, setValue] = useFollowed(step.expect);
  const label = t`Expected effect of step ${{ number: step.index + 1 }}`;
  return (
    <label className="plan-expect">
      <span className="visually-hidden">{label}</span>
      <input
        type="text"
        aria-label={accessibleText(label)}
        value={value}
        disabled={!live}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          const next = value.trim();
          if (next === '') {
            setValue(step.expect);
            return;
          }
          if (next !== step.expect) onEdit([{ op: 'set', index: step.index, path: ['expect'], value: next }]);
        }}
        onKeyDown={(event) => {
          // The Enter that commits an IME candidate must not leave the field and send a half-composed expectation.
          if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) event.currentTarget.blur();
        }}
      />
    </label>
  );
}

/**
 * The step's params, one field each. Text and numbers are edited in place; a list or an object is edited as JSON, and a
 * value that does not parse is kept on the field and not sent.
 */
function ParamFields({ step, live, onEdit }: { step: PlanStepView; live: boolean; onEdit: (edits: PlanEdit[]) => void }): ReactNode {
  const entries = Object.entries(step.params);
  if (entries.length === 0) return null;
  return (
    <div className="plan-params">
      {entries.map(([key, value]) => (
        <ParamField key={key} step={step} name={key} value={value} live={live} onEdit={onEdit} />
      ))}
    </div>
  );
}

function ParamField({
  step,
  name,
  value,
  live,
  onEdit,
}: {
  step: PlanStepView;
  name: string;
  value: unknown;
  live: boolean;
  onEdit: (edits: PlanEdit[]) => void;
}): ReactNode {
  const label = accessibleText(t`${{ name: isolate(name) }} of step ${{ number: step.index + 1 }}`);
  const send = (next: unknown): void => onEdit([{ op: 'set', index: step.index, path: ['params', name], value: next }]);
  if (typeof value === 'boolean') {
    return (
      <label className="check plan-param">
        <input type="checkbox" aria-label={accessibleText(label)} checked={value} disabled={!live} onChange={(event) => send(event.target.checked)} />
        {name}
      </label>
    );
  }
  if (typeof value === 'number') {
    return <NumberParam label={label} name={name} value={value} live={live} onSend={send} />;
  }
  if (typeof value === 'string') {
    return <TextParam label={label} name={name} value={value} live={live} onSend={send} />;
  }
  return <JsonParam label={label} name={name} value={value} live={live} onSend={send} />;
}

function TextParam({ label, name, value, live, onSend }: { label: string; name: string; value: string; live: boolean; onSend: (v: unknown) => void }): ReactNode {
  const [draft, setDraft] = useFollowed(value);
  const long = value.length > 60 || value.includes('\n');
  const commit = (): void => {
    if (draft !== value) onSend(draft);
  };
  return (
    <label className="plan-param">
      <span className="plan-param-name">{name}</span>
      {long ? (
        <textarea aria-label={accessibleText(label)} value={draft} rows={3} disabled={!live} onChange={(event) => setDraft(event.target.value)} onBlur={commit} />
      ) : (
        <input
          type="text"
          aria-label={accessibleText(label)}
          value={draft}
          disabled={!live}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // The Enter that commits an IME candidate must not leave the field and send a half-composed value.
            if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) event.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}

/**
 * A number field, controlled by the card's value: a number the card does not take (empty, or not a number) is not sent, and the
 * field goes back to the value the card holds.
 */
function NumberParam({ label, name, value, live, onSend }: { label: string; name: string; value: number; live: boolean; onSend: (v: unknown) => void }): ReactNode {
  const [draft, setDraft] = useFollowed(String(value));
  return (
    <label className="plan-param">
      <span className="plan-param-name">{name}</span>
      <input
        type="number"
        aria-label={accessibleText(label)}
        value={draft}
        disabled={!live}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (draft.trim() !== '' && Number.isFinite(next) && next !== value) onSend(next);
          else setDraft(String(value));
        }}
      />
    </label>
  );
}

function JsonParam({ label, name, value, live, onSend }: { label: string; name: string; value: unknown; live: boolean; onSend: (v: unknown) => void }): ReactNode {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const [draft, setDraft] = useFollowed(text);
  const [error, setError] = useState(false);
  // A new value from the store replaces the draft; the error belonged to the draft it followed, so it goes too.
  const [seen, setSeen] = useState(text);
  if (seen !== text) {
    setSeen(text);
    setError(false);
  }
  return (
    <label className="plan-param">
      <span className="plan-param-name">{name}</span>
      <textarea
        aria-label={accessibleText(label)}
        value={draft}
        rows={Math.min(8, draft.split('\n').length + 1)}
        disabled={!live}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(draft);
            setError(false);
            if (JSON.stringify(parsed) !== JSON.stringify(value)) onSend(parsed);
          } catch {
            setError(true);
          }
        }}
      />
      {error ? <span className="plan-param-error" role="alert"><Trans><UserText value={name} /> is not valid JSON, so the change was not sent.</Trans></span> : null}
    </label>
  );
}

/**
 * A field's draft, which follows the value it was given: when the value changes (the store moved, or the loop shows the card
 * again), the draft takes the new value. Done during render, as React's own guidance has it, so no effect has to set state.
 */
function useFollowed(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  return [draft, setDraft];
}

/** The prompt behind a step (context-assembly §5): each layer against its budget, the codex entries and why, the focus excerpt. */
export function PromptPreview({ context }: { context: ContextPreview }): ReactNode {
  useLingui();
  const promptTokens = context.promptTokens;
  const completionTokens = context.completionTokens;
  const focusSummary = context.focus?.summary ?? '';
  // Shown only when the profile has a price (provider-gateway §6); an unpriced profile shows the tokens and nothing else.
  const cost = costLineOf(context.cost);
  return (
    <details className="context-preview">
      <summary>
        <Trans>Prompt for this step: about {promptTokens} tokens in, {completionTokens} out</Trans>
      </summary>
      {cost !== undefined ? <p className="context-cost">{cost}</p> : null}
      <ul className="context-layers" aria-label={t`Layers`}>
        {context.layers.map((layer, index) => {
          const budget = layer.budget ?? 0;
          const share = budget > 0 ? Math.min(100, Math.round((layer.tokens / budget) * 100)) : 0;
          // A synopsis batch carries one focus layer per document, so the id alone is not unique.
          return (
            <li key={`${layer.id}:${index}`}>
              <span className="context-layer-name">
                {layer.id} {layer.name}
              </span>
              <span className="context-bar" aria-hidden="true">
                <span style={{ width: `${share}%` }} />
              </span>
              <span className="context-layer-count">
                {budget > 0
                  ? t({ message: `${{ tokens: layer.tokens }} of ${{ budget }} tokens`, comment: 'A prompt layer: its tokens against its budget.' })
                  : t({ message: `${{ tokens: layer.tokens }} tokens`, comment: 'A prompt layer with no budget: its token count.' })}
              </span>
            </li>
          );
        })}
      </ul>
      {context.codex.included.length > 0 ? (
        <ul className="context-reasons" aria-label={t`Codex included`}>
          {context.codex.included.map((entry, index) => (
            <li key={`${entry.name}:${index}`}>
              <strong>{entry.name}</strong>: {entry.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {leftOut(context).length > 0 ? (
        <ul className="context-dropped" aria-label={t`Left out`}>
          {leftOut(context).map((reason, index) => (
            <li key={`${index}:${reason}`}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {context.focus !== undefined ? (
        <p className="context-focus">
          <Trans><strong>Focus</strong>: {focusSummary}</Trans>
        </p>
      ) : null}
    </details>
  );
}

/** What the assembly left out, in words: codex entries with their reason, then each layer's own cut notes. */
function leftOut(context: ContextPreview): string[] {
  return [
    ...context.codex.dropped.map((entry) => `${entry.name}: ${entry.reason}`),
    ...context.layers.flatMap((layer) => layer.notes.map((note) => `${layer.name}: ${note}`)),
  ];
}
