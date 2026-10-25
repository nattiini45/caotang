/**
 * The Findings rail tab (coherence.md §8): a quick scan with the scope and checks the writer chose, a model review that runs only
 * after its plan is approved, the findings grouped by fact with the passages each one quotes, the run history with its discard,
 * and the actions on a card. Dismissal opens the picker of §6.3, which is the writer's judgment and never the agent's. Every
 * status change and every discard is a bus command, so it is logged, undoable and refused the same way for everyone.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SCAN_DOC_GUARD, checkCrossLinkFor, validateDismissal, type CoherenceFile, type DeterministicCheckId, type ReviewPlan, type ScopeSpec } from '@caotang/coherence';
import { agentFor } from '../app/agent.js';
import type { ProviderService } from '../app/providers.js';

import {
  FILTER_LABELS,
  NOTE_LIMIT,
  SCOPE_CHOICES,
  dismissalLabelOf,
  dismissalReasons,
  nextOpenFindingId,
  openFindingCount,
  quoteIsCurrent,
  runViewsOf,
  scanCoverageLine,
  scopeFor,
  severitySections,
  type FindingFilter,
  type FindingGroupView,
  type FindingView,
  type QuoteView,
  type ReasonView,
} from '../app/findings-model.js';
import { DEFAULT_COHERENCE_SETTINGS, type CoherenceSettings, type ReviewScope } from '../app/settings.js';
import { gatewayCoherenceModel, planCoherenceReview, reviewCostDetailFor, runCoherenceReview } from '../app/coherence-review.js';
import { formatUsd } from '../app/plan-preview.js';
import { renderRef, titleValues } from '../i18n/render-ref.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { KnowledgeList } from './KnowledgeList.js';
import { EmptyState, formatCount, useReport, useSession } from './shared.js';

export interface FindingsPanelProps {
  readonly session: ProjectSession;
  /** Opens the document a quoted passage is in and shows the passage (the editor reveals the body-projection range). */
  readonly onReveal: (docId: string, from: number, to: number) => void;
  /** The Coherence settings (ui-modules §5.2): the checks a scan runs, the scope the tab starts with, and the cap on a review. */
  readonly settings?: CoherenceSettings;
  /** The providers, for the model review. Absent where no provider can be asked. */
  readonly providers?: ProviderService;
  /** Opens the agent drawer when "Fix with agent" starts, so the fix's card or its refusal is on screen (coherence.md §6.3). */
  readonly onOpenAgent?: () => void;
  /** Opens a document in the editor: the scenes of the Knowledge list's ledger are buttons that do. */
  readonly onOpenDocument?: (docId: string) => void;
}

/** The question a large scope asks before it runs (coherence.md §6.2). "Scan it anyway" is the control that answers it. */
const APPROVAL_SENTENCE = `This scope covers more than ${SCAN_DOC_GUARD} documents. Split it, or press “Scan it anyway” to scan all of it.`;

/** The focus target after a dismissal when no open card remains: the Findings heading. */
const FOCUS_HEADING = 'heading';

/** A quoted passage's key in its card: its document and its offsets, which is what the reveal is asked for. */
function quoteKey(quote: QuoteView): string {
  return `${quote.docId}:${quote.from}:${quote.to}`;
}

/** The review in progress, or the plan waiting for approval. Nothing is sent to a model before the plan is approved. */
interface ReviewState {
  readonly plan: ReviewPlan;
  readonly controller: AbortController | null;
}

export function FindingsPanel({ session, onReveal, settings = DEFAULT_COHERENCE_SETTINGS, providers, onOpenAgent, onOpenDocument }: FindingsPanelProps): ReactNode {
  useSession(session);
  const report = useReport();
  const [filter, setFilter] = useState<FindingFilter>('open');
  const [scopeChoice, setScopeChoice] = useState<ReviewScope>(settings.defaultReviewScope);
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [dismissing, setDismissing] = useState<FindingView | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  // The quoted passage, in one card, that a writer asked to open after its text changed: that card says why it did not open.
  const [stale, setStale] = useState<string | null>(null);
  // A large scope waiting for the writer's approval, and the scope it names: "Scan it anyway" runs that one, not the choice on screen.
  const [pendingScope, setPendingScope] = useState<ScopeSpec | null>(null);
  // The control that opened the dismissal picker takes focus back when the picker is cancelled.
  const openerRef = useRef<HTMLElement | null>(null);
  // Where focus goes after a dismissal: the next open card's Dismiss control, or the heading when no open card remains.
  const focusAfterRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const target = focusAfterRef.current;
    if (target === null) return;
    focusAfterRef.current = null;
    const element =
      target === FOCUS_HEADING ? headingRef.current : document.querySelector<HTMLElement>(`[data-finding="${target}"] [data-dismiss]`);
    element?.focus();
  });
  const file: CoherenceFile | undefined = session.coherenceFile();
  const status = session.coherenceStatus();
  const sections = severitySections(session.state, file, filter);
  const open = openFindingCount(file);
  const currentDocId = session.view.activeDocId ?? undefined;
  const runs = runViewsOf(file, (docId) => session.state.manifest.tree.find((node) => node.id === docId)?.title ?? docId);
  const activeProfile = providers?.active();
  // The model review is a 'chat'-role call (provider-gateway §6): it runs on the profile the role resolves to —
  // the active one unless the writer pinned chat to another — with the role's model and thinking defaults.
  const chatResolution = providers?.resolveForRole?.('chat');
  const chatProfile = chatResolution?.profile ?? activeProfile;
  const mockOnly = chatProfile === undefined || chatProfile.kind === 'mock';

  /** A large scope asks first. The panel says so in its own words, and the control that answers it is shown beside the scan. */
  const askForApproval = (scope: ScopeSpec): void => {
    setApprovalNeeded(true);
    setPendingScope(scope);
    report({ text: APPROVAL_SENTENCE, tone: 'info' });
  };

  const scan = (approved: boolean): void => {
    setStale(null);
    const scope = approved && pendingScope !== null ? pendingScope : scopeFor(scopeChoice, currentDocId);
    if (scope === undefined) {
      report({ text: 'Open the document to scan it alone, or choose another scope.', tone: 'info' });
      return;
    }
    const checks: readonly DeterministicCheckId[] = settings.enabledChecks;
    if (checks.length === 0) {
      report({ text: 'Every quick check is off in Settings, so this tab’s scan runs nothing. Turn checks on in Settings › Coherence.', tone: 'info' });
      return;
    }
    const result = session.scanCoherence({ approvedLargeScope: approved, scope, checks });
    if (!result.ok) {
      if (result.code === 'confirmation-required') {
        askForApproval(scope);
        return;
      }
      report({ text: result.message, tone: 'error' });
      return;
    }
    setApprovalNeeded(false);
    setPendingScope(null);
    report({ text: result.summary, tone: 'info' });
  };

  /** "Run again" on a run of the history: the same scope, with the checks the Settings turn on now (coherence.md §8). */
  const rerun = (scope: ScopeSpec): void => {
    setStale(null);
    const checks: readonly DeterministicCheckId[] = settings.enabledChecks;
    if (checks.length === 0) {
      report({ text: 'Every quick check is off in Settings, so this run would check nothing. Turn checks on in Settings › Coherence.', tone: 'info' });
      return;
    }
    const result = session.scanCoherence({ approvedLargeScope: false, scope, checks });
    if (!result.ok) {
      if (result.code === 'confirmation-required') {
        askForApproval(scope);
        return;
      }
      report({ text: result.message, tone: 'error' });
      return;
    }
    setApprovalNeeded(false);
    setPendingScope(null);
    report({ text: result.summary, tone: 'info' });
  };

  const planReviewNow = (): void => {
    const scope = scopeFor(scopeChoice, currentDocId);
    if (scope === undefined) {
      report({ text: 'Open the document to review it alone, or choose another scope.', tone: 'info' });
      return;
    }
    const current = session.coherenceFile();
    if (current === undefined) {
      report({ text: 'No findings file is open for this project, so there is nothing to review into.', tone: 'error' });
      return;
    }
    const plan = planCoherenceReview(session.state, current, { scope, maxFindings: settings.maxFindings });
    if (plan.scopeDocIds.length === 0) {
      report({ text: 'There is no document in this scope to read. Write something, or choose another scope.', tone: 'info' });
      return;
    }
    setReview({ plan, controller: null });
  };

  const startReview = async (plan: ReviewPlan): Promise<void> => {
    const current = session.coherenceFile();
    const resolved = providers?.resolveForRole?.('chat');
    const profile = resolved?.profile ?? activeProfile;
    if (current === undefined || providers === undefined || profile === undefined) {
      report({ text: 'Connect a provider in Settings to review the story with a model.', tone: 'error' });
      return;
    }
    const controller = new AbortController();
    setReview({ plan, controller });
    try {
      const model = gatewayCoherenceModel(providers.gateway, profile, resolved);
      const result = await runCoherenceReview({
        state: session.state,
        file: current,
        plan,
        model,
        maxFindings: settings.maxFindings,
        signal: controller.signal,
        // A scan or an agent review that finishes while this one waits replaces the held file; the run is written into the held one.
        currentFile: () => session.coherenceFile() ?? current,
      });
      session.applyCoherenceFile(result.file);
      const added = result.run.findingsUpserted.length;
      const summary =
        result.status === 'complete'
          ? `The model review is complete: ${added === 1 ? '1 finding' : `${added} findings`} added or updated.`
          : `The model review stopped early, so it is partial: ${added === 1 ? '1 finding' : `${added} findings`} kept. ${result.notes[0] ?? ''}`.trim();
      report({ text: summary, tone: result.status === 'complete' ? 'info' : 'error' });
    } catch (error) {
      report({ text: `The model review did not run: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' });
    } finally {
      setReview(null);
    }
  };

  const setStatus = (findingId: string, next: 'open' | 'fixed'): void => {
    const outcome = session.dispatch('coherence.setFindingStatus', { findingId, status: next });
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };

  /** Opens the picker for a card. The card's Dismiss control is the opener, and it takes focus back if the picker is cancelled. */
  const openDismiss = (finding: FindingView): void => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDismissing(finding);
  };

  const cancelDismiss = (): void => {
    const opener = openerRef.current;
    setDismissing(null);
    if (opener !== null && opener.isConnected) opener.focus();
  };

  const dismiss = (findingId: string, reason: string, note: string): void => {
    const outcome = session.dispatch('coherence.setFindingStatus', {
      findingId,
      status: 'dismissed',
      reason,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    // The dismissed card leaves the open list, so its control is gone: focus moves to the next open card, or to the heading.
    focusAfterRef.current = nextOpenFindingId(sections, findingId) ?? FOCUS_HEADING;
    setDismissing(null);
  };

  const discardRun = (runId: string, at: string): void => {
    const outcome = session.dispatch('coherence.discardRun', { runId });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    report({ text: `The run of ${at} is discarded. Undo puts it back.`, tone: 'info' });
  };

  // A review is either waiting for its plan's approval (no controller yet) or running (it has one). A running review holds the scan.
  const running = review !== null && review.controller !== null;
  const plan = review !== null && !running ? review.plan : null;
  // The same figure the agent's plan card shows for this review: one function, reading the gateway's limits for the profile as the agent's loop does (coherence-review.ts).
  const costDetail =
    plan === null || providers === undefined || chatProfile === undefined
      ? undefined
      : reviewCostDetailFor(plan, providers.gateway, chatProfile.id, chatResolution?.model, chatResolution?.thinking);
  const cost = costDetail?.totalUsd;

  return (
    <div className="findings" data-testid="findings-panel">
      <header className="findings-head" ref={headingRef} tabIndex={-1}>
        <p className="eyebrow">Findings</p>
        <span className="findings-count" data-testid="findings-open">
          {open === 1 ? '1 open' : `${open} open`}
        </span>
      </header>

      <div className="findings-actions">
        <label className="findings-filter">
          <span>Scope</span>
          <select
            value={scopeChoice}
            onChange={(event) => setScopeChoice(event.target.value as ReviewScope)}
            aria-label="Scope of the scan and the review"
          >
            {SCOPE_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button is-primary" onClick={() => scan(false)} disabled={running}>
          Scan the manuscript
        </button>
        {approvalNeeded ? (
          <button type="button" className="button" onClick={() => scan(true)}>
            Scan it anyway
          </button>
        ) : null}
        <button type="button" className="button" onClick={planReviewNow} disabled={mockOnly || review !== null}>
          Review with agent
        </button>
        <label className="findings-filter">
          <span>Show</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as FindingFilter)} aria-label="Show findings with status">
            {(Object.keys(FILTER_LABELS) as FindingFilter[]).map((key) => (
              <option key={key} value={key}>
                {FILTER_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="field-note findings-coverage" data-testid="findings-coverage">
        {scanCoverageLine(settings.enabledChecks)}
      </p>
      {mockOnly ? (
        <p className="field-note" role="status">
          The model review needs a provider. Connect one in Settings to read the story for plot and character problems.
        </p>
      ) : null}

      {plan !== null ? (
        <section className="findings-plan" aria-label="The model review plan" data-testid="review-plan">
          <h3 className="findings-section-title">Model review plan</h3>
          <p className="finding-message">
            Reads {plan.scopeDocIds.length === 1 ? '1 document' : `${plan.scopeDocIds.length} documents`}:{' '}
            {plan.documents.map((doc) => doc.title).join(', ')}.
          </p>
          <p className="field-note">
            About {plan.estimate.extractCalls} model {plan.estimate.extractCalls === 1 ? 'call' : 'calls'} to read them, then up to{' '}
            {plan.estimate.verifyCallsAtMost} to check the pairs they raise; about {formatCount(plan.estimate.totalTokensAtMost)} tokens
            at most (an estimate).
            {cost === undefined ? '' : ` About ${formatUsd(cost)} for the whole plan${costDetail?.includesThinking === true ? ', including thinking' : ''}, at this profile’s prices.`}
          </p>
          {plan.documents.some((doc) => doc.truncated || doc.codexDropped.length > 0 || doc.storyDropped.length > 0) ? (
            <p className="field-note">
              Some text did not fit the budget and is left out of the prompt: the longest passages are cut, and the least important
              codex entries and earlier scenes are dropped first.
            </p>
          ) : null}
          {plan.overGuard ? (
            <p className="form-message is-error" role="alert">
              This scope is over the 20-document guard. Approving the plan approves reading all of it.
            </p>
          ) : null}
          <details className="findings-prompt">
            <summary>The first prompt the model reads</summary>
            <pre>{plan.promptPreview}</pre>
          </details>
          <div className="finding-actions">
            <button type="button" className="button is-quiet" onClick={() => setReview(null)}>
              Cancel
            </button>
            <button type="button" className="button is-primary" onClick={() => void startReview(plan)}>
              Start the review
            </button>
          </div>
        </section>
      ) : null}
      {running && review !== null ? (
        <section className="findings-plan" aria-label="The model review in progress" data-testid="review-running">
          <p className="finding-message" role="status">
            Reviewing with the model. This can take a while, and the findings appear here when it is done.
          </p>
          <div className="finding-actions">
            <button type="button" className="button" onClick={() => review.controller?.abort()}>
              Stop the review
            </button>
          </div>
        </section>
      ) : null}

      {status.notices.map((notice) => (
        <p key={notice} className="field-note" role="status">
          {notice}
        </p>
      ))}
      {status.saveFailure !== null ? (
        <p className="form-message is-error" role="alert">
          {status.saveFailure}
        </p>
      ) : null}

      {sections.length === 0 ? (
        <EmptyState title={file === undefined || file.findings.length === 0 ? 'No findings yet' : `No ${FILTER_LABELS[filter].toLowerCase()} findings`}>
          {file === undefined || file.findings.length === 0
            ? 'Run a scan to check the manuscript against the codex, the scene declarations and the screenplay and storyboard. Nothing changes in the text.'
            : 'Choose another status to see the findings in it.'}
        </EmptyState>
      ) : (
        sections.map((section) => (
          <section key={section.severity} className={`findings-section is-${section.severity}`} aria-label={section.label}>
            <h3 className="findings-section-title">
              {section.label} <span className="findings-section-count">{section.findings.length}</span>
            </h3>
            {section.groups.map((group) => (
              <FindingGroupCard
                key={`${group.severity}:${group.factGroup}`}
                group={group}
                stale={stale}
                setStale={setStale}
                session={session}
                onReveal={onReveal}
                onDismiss={openDismiss}
                onStatus={setStatus}
                onOpenAgent={onOpenAgent}
              />
            ))}
          </section>
        ))
      )}

      <KnowledgeList session={session} onOpenDocument={onOpenDocument} />

      <section className="findings-runs" aria-label="Run history" data-testid="run-history">
        <h3 className="findings-section-title">
          Run history <span className="findings-section-count">{runs.length}</span>
        </h3>
        {runs.length === 0 ? (
          <p className="field-note">No check has run on this project yet.</p>
        ) : (
          <ol className="findings-run-list">
            {runs.slice(0, 20).map((run) => (
              <li key={run.id} className="findings-run" data-run={run.id}>
                <p className="finding-message">
                  {run.kind} · {run.scopeLabel} · {run.at} · {run.findingCount === 1 ? '1 finding' : `${run.findingCount} findings`} · {run.status}
                </p>
                {run.tokenLine !== undefined ? <p className="field-note">{run.tokenLine}</p> : null}
                {run.notes.map((note) => (
                  <p key={note} className="field-note">
                    {note}
                  </p>
                ))}
                <footer className="finding-actions">
                  {run.rerunScope !== undefined ? (
                    <button type="button" className="button is-quiet" aria-label={`Run again the scan of ${run.at}`} onClick={() => run.rerunScope !== undefined && rerun(run.rerunScope)}>
                      Run again
                    </button>
                  ) : null}
                  <button type="button" className="button is-quiet" aria-label={`Discard run from ${run.at}`} onClick={() => discardRun(run.id, run.at)}>
                    Discard run
                  </button>
                </footer>
              </li>
            ))}
          </ol>
        )}
      </section>

      {dismissing !== null ? (
        <DismissPicker finding={dismissing} onCancel={cancelDismiss} onDismiss={(reason, note) => dismiss(dismissing.id, reason, note)} />
      ) : null}
    </div>
  );
}

/**
 * One fact's card (coherence.md §4.2, §8): the findings that share it, with a citation for each. The heading is the first
 * finding's message, so the writer reads one problem and sees how many places show it.
 */
function FindingGroupCard({
  group,
  stale,
  setStale,
  session,
  onReveal,
  onDismiss,
  onStatus,
  onOpenAgent,
}: {
  group: FindingGroupView;
  stale: string | null;
  setStale: (key: string | null) => void;
  session: ProjectSession;
  onReveal: (docId: string, from: number, to: number) => void;
  onDismiss: (finding: FindingView) => void;
  onStatus: (findingId: string, next: 'open' | 'fixed') => void;
  onOpenAgent?: () => void;
}): ReactNode {
  const heading =
    group.headingRef === undefined
      ? group.heading
      : renderRef(group.headingRef, { userValues: titleValues(group.headingRef) });
  return (
    <div className="finding-group" role="group" aria-label={heading} data-group={group.factGroup}>
      <header className="finding-group-head">
        <span className="finding-group-heading">{heading}</span>
        {group.findings.length > 1 ? <span className="finding-group-count">{group.findings.length} citations</span> : null}
      </header>
      {group.findings.map((finding) => (
        <FindingCard
          key={finding.id}
          finding={finding}
          stale={stale}
          setStale={setStale}
          session={session}
          onReveal={onReveal}
          onDismiss={onDismiss}
          onStatus={onStatus}
          onOpenAgent={onOpenAgent}
        />
      ))}
    </div>
  );
}

/**
 * Starts "Fix with agent" for a finding and says what happened in words (coherence.md §6.3). The fix is a turn in the agent, which runs
 * on past this answer: whether it makes a card, or the provider refuses, shows in the agent panel, and this note cannot wait for that.
 * So the note promises no card. A refusal the controller can name at once (no passage, a dialogue) is returned as it is. The drawer
 * opens first, whatever the answer, so the card or the refusal is where the writer looks.
 */
function startFixWithAgent(session: ProjectSession, findingId: string, onOpenAgent: (() => void) | undefined): string {
  onOpenAgent?.();
  const agent = agentFor(session);
  if (agent === undefined) return 'The agent is not ready for this project yet. Open the agent panel, then try again.';
  if (agent.snapshot().busy) return 'The agent is busy with another turn. Let it finish, then fix the finding.';
  void agent.fixFinding(findingId);
  return agent.snapshot().message ?? 'The fix has started in the agent panel. Its outcome shows there.';
}

/** One finding's card: its message, expected line, quotes, verdict and actions. */
function FindingCard({
  finding,
  stale,
  setStale,
  session,
  onReveal,
  onDismiss,
  onStatus,
  onOpenAgent,
}: {
  finding: FindingView;
  stale: string | null;
  setStale: (key: string | null) => void;
  session: ProjectSession;
  onReveal: (docId: string, from: number, to: number) => void;
  onDismiss: (finding: FindingView) => void;
  onStatus: (findingId: string, next: 'open' | 'fixed') => void;
  onOpenAgent?: () => void;
}): ReactNode {
  // What "Fix with agent" said when it was pressed: where the fix is, or why it could not start.
  const [fixNote, setFixNote] = useState<string | null>(null);
  // A deterministic finding renders its ref in the active UI language, with each title isolated once.
  const message =
    finding.messageRef === undefined
      ? finding.message
      : renderRef(finding.messageRef, { userValues: titleValues(finding.messageRef) });
  // Each quoted passage's document title is its button's description, so the button's name is the passage itself.
  const baseId = useId();
  return (
    <article className="finding" data-finding={finding.id} data-status={finding.status}>
      <header className="finding-head">
        <span className="finding-type">{finding.typeLabel}</span>
        <span className={`status-chip is-${finding.status}`}>{finding.status === 'open' ? 'Open' : finding.status === 'fixed' ? 'Marked fixed' : 'Dismissed'}</span>
      </header>
      <p className="finding-message">{message}</p>
      {finding.expected !== undefined ? <p className="finding-expected">Expected: {finding.expected}</p> : null}
      {finding.quotes.length > 0 ? (
        <ul className="finding-quotes" aria-label="Quoted passages">
          {finding.quotes.map((quote, index) => {
            // The card's own key: the same passage quoted by two findings is each card's to report.
            const key = `${finding.id}/${quoteKey(quote)}`;
            const sourceId = `${baseId}-source-${index}`;
            return (
              <li key={key}>
                <button
                  type="button"
                  className="finding-quote"
                  aria-describedby={sourceId}
                  onClick={() => {
                    // The offsets are checked against the body before the editor is asked to select them.
                    if (!quoteIsCurrent(session.state, quote)) {
                      setStale(key);
                      return;
                    }
                    setStale(null);
                    onReveal(quote.docId, quote.from, quote.to);
                  }}
                >
                  “{quote.quote}”
                </button>
                <span className="finding-source" id={sourceId}>
                  {quote.docTitle}
                </span>
                {stale === key ? (
                  <p className="field-note" role="status">
                    This passage has changed since the scan. Scan again to find it.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {finding.dismissedReason !== undefined ? <p className="field-note">Dismissed as: {dismissalLabelOf(finding.dismissedReason)}</p> : null}
      {finding.note !== undefined ? <p className="field-note">Note: {finding.note}</p> : null}
      {finding.redetected > 0 ? (
        <p className="field-note">Found again in {finding.redetected} later {finding.redetected === 1 ? 'run' : 'runs'}.</p>
      ) : null}
      {fixNote !== null ? (
        <p className="field-note" role="status">
          {fixNote}
        </p>
      ) : null}
      <footer className="finding-actions">
        {finding.status === 'open' ? (
          <>
            <button type="button" className="button" data-dismiss onClick={() => onDismiss(finding)}>
              Dismiss…
            </button>
            {finding.fixable ? (
              <button type="button" className="button" onClick={() => setFixNote(startFixWithAgent(session, finding.id, onOpenAgent))}>
                Fix with agent
              </button>
            ) : null}
            <button type="button" className="button is-quiet" onClick={() => onStatus(finding.id, 'fixed')}>
              Mark fixed
            </button>
          </>
        ) : (
          <button type="button" className="button is-quiet" onClick={() => onStatus(finding.id, 'open')}>
            Re-open
          </button>
        )}
      </footer>
    </article>
  );
}

/**
 * The dismissal picker (coherence.md §6.3): one of five reasons, with the one-line tooltip the spec gives two of them, the
 * cross-link line for the technique reasons, a line for the check that has its own mode (`timeline.gap`), and an optional note. The reason is required; a dismissal is never anonymous.
 */
export function DismissPicker({
  finding,
  onCancel,
  onDismiss,
}: {
  finding: FindingView;
  onCancel: () => void;
  onDismiss: (reason: string, note: string) => void;
}): ReactNode {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const message =
    finding.messageRef === undefined
      ? finding.message
      : renderRef(finding.messageRef, { userValues: titleValues(finding.messageRef) });
  const [complaint, setComplaint] = useState<string | null>(null);
  const reasons: ReasonView[] = dismissalReasons();
  const chosen = reasons.find((candidate) => candidate.id === reason);
  const checkLine = checkCrossLinkFor(finding.checkId);
  // The picker opens at a distance from its card, so the keyboard is moved into it: the first reason takes focus when it opens.
  const firstReason = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstReason.current?.focus();
  }, []);

  return (
    <section
      className="finding-dismiss"
      role="dialog"
      aria-label={`Dismiss the finding: ${message}`}
      data-testid="dismiss-picker"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onCancel();
      }}
    >
      <fieldset className="dismiss-reasons">
        <legend>Why is this not a problem?</legend>
        {reasons.map((candidate, index) => (
          <label key={candidate.id} className="dismiss-reason">
            <input
              ref={index === 0 ? firstReason : undefined}
              type="radio"
              name="dismiss-reason"
              value={candidate.id}
              checked={reason === candidate.id}
              onChange={() => {
                setReason(candidate.id);
                setComplaint(null);
              }}
            />
            <span>{candidate.label}</span>
            {candidate.tooltip !== undefined ? <span className="field-note dismiss-tooltip">{candidate.tooltip}</span> : null}
          </label>
        ))}
      </fieldset>
      {chosen?.crossLink !== undefined ? <p className="field-note">{chosen.crossLink}</p> : null}
      {checkLine !== undefined ? (
        <p className="field-note" data-testid="dismiss-check-cross-link">
          {checkLine}
        </p>
      ) : null}
      <label className="dismiss-note">
        <span>Note (optional)</span>
        <textarea
          rows={2}
          maxLength={NOTE_LIMIT}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-label="Dismissal note"
        />
      </label>
      {complaint !== null ? (
        <p className="form-message is-error" role="alert">
          {complaint}
        </p>
      ) : null}
      <div className="finding-actions">
        <button type="button" className="button is-quiet" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button is-primary"
          disabled={reason === null}
          onClick={() => {
            const check = validateDismissal(reason, note);
            if (!check.ok) {
              setComplaint(check.error);
              return;
            }
            if (reason !== null) onDismiss(reason, note);
          }}
        >
          Dismiss finding
        </button>
      </div>
    </section>
  );
}
