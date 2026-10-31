import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { plural, select, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { SCAN_DOC_GUARD, validateDismissal, type CoherenceFile, type DeterministicCheckId, type ReviewPlan, type ScopeSpec } from '@caotang/coherence';
import { isolate } from '@caotang/i18n';
import { agentFor } from '../app/agent-registry.js';
import type { ProviderService } from '../app/providers.js';
import {
  FILTER_LABELS,
  NOTE_LIMIT,
  SCOPE_CHOICES,
  dismissalLabelOf,
  dismissalReasons,
  findingMessageText,
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
import { accessibleText } from '../i18n/accessible-text.js';
import { renderRef, titleValues } from '../i18n/render-ref.js';
import { UserText } from '../i18n/UserText.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { KnowledgeList } from './KnowledgeList.js';
import { EmptyState, formatCount, useReport, useSession } from './shared.js';
import { uiLocale } from '../i18n/format-locale.js';

/* lingui-set comment="Counts describe findings, citations, documents or model calls. Dates are formatted timestamps. Titles, evidence, errors and model notes are supplied values, not translated prose." */

export interface FindingsPanelProps {
  readonly session: ProjectSession;
  readonly onReveal: (docId: string, from: number, to: number) => void;
  readonly settings?: CoherenceSettings;
  readonly providers?: ProviderService;
  readonly onOpenAgent?: () => void;
  readonly onOpenDocument?: (docId: string) => void;
  /** A fact group the timeline asked to see: the panel shows open findings, scrolls to the group and focuses it. `serial` makes a repeat a new request. */
  readonly focusGroup?: { readonly factGroup: string; readonly serial: number } | null;
  /** Called once the panel has acted on `focusGroup`, so the shell can drop the request. */
  readonly onGroupFocused?: () => void;
  /** "Show on timeline": the scenes a finding cites and its id. Without it the group cards offer no such button. */
  readonly onShowOnTimeline?: (docIds: readonly string[], findingId: string) => void;
}

const FOCUS_HEADING = 'heading';

function quoteKey(quote: QuoteView): string {
  return `${quote.docId}:${quote.from}:${quote.to}`;
}

interface ReviewState {
  readonly plan: ReviewPlan;
  readonly controller: AbortController | null;
}

export function FindingsPanel({ session, onReveal, settings = DEFAULT_COHERENCE_SETTINGS, providers, onOpenAgent, onOpenDocument, focusGroup = null, onGroupFocused, onShowOnTimeline }: FindingsPanelProps): ReactNode {
  useSession(session);
  useLingui();
  const report = useReport();
  const [filter, setFilter] = useState<FindingFilter>('open');
  const [scopeChoice, setScopeChoice] = useState<ReviewScope>(settings.defaultReviewScope);
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [dismissing, setDismissing] = useState<FindingView | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [pendingScope, setPendingScope] = useState<ScopeSpec | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const focusAfterRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const target = focusAfterRef.current;
    if (target === null) return;
    focusAfterRef.current = null;
    const element = target === FOCUS_HEADING ? headingRef.current : document.querySelector<HTMLElement>(`[data-finding="${target}"] [data-dismiss]`);
    element?.focus();
  });
  // The timeline names a group by its fact. Only open findings sit on the timeline, so the filter goes back to them first, and the
  // group is found after that render has put its card in the page.
  // The timeline names a group by its fact. Only open findings sit on the timeline, so the filter goes back to them in the render
  // that sees the request, and the group is found once that render has put its card in the page.
  const [seenFocus, setSeenFocus] = useState(0);
  if (focusGroup !== null && focusGroup.serial !== seenFocus) {
    setSeenFocus(focusGroup.serial);
    if (filter !== 'open') setFilter('open');
  }
  useEffect(() => {
    if (focusGroup === null) return;
    const card = [...document.querySelectorAll<HTMLElement>('.finding-group[data-group]')].find((element) => element.dataset.group === focusGroup.factGroup);
    if (card !== undefined) {
      card.scrollIntoView({ block: 'center' });
      card.focus();
    }
    onGroupFocused?.();
  }, [seenFocus]); // eslint-disable-line react-hooks/exhaustive-deps
  const file: CoherenceFile | undefined = session.coherenceFile();
  const status = session.coherenceStatus();
  const sections = severitySections(session.state, file, filter);
  const open = openFindingCount(file);
  const currentDocId = session.view.activeDocId ?? undefined;
  const runs = runViewsOf(file, (docId) => session.state.manifest.tree.find((node) => node.id === docId)?.title ?? docId);
  const activeProfile = providers?.active();
  const chatResolution = providers?.resolveForRole?.('chat');
  const chatProfile = chatResolution?.profile ?? activeProfile;
  const mockOnly = chatProfile === undefined || chatProfile.kind === 'mock';

  const askForApproval = (scope: ScopeSpec): void => {
    setApprovalNeeded(true);
    setPendingScope(scope);
    report({ text: t`This scope covers more than ${{ limit: SCAN_DOC_GUARD }} documents. Split it, or press “Scan it anyway” to scan all of it.`, tone: 'info' });
  };

  const scan = (approved: boolean): void => {
    setStale(null);
    const scope = approved && pendingScope !== null ? pendingScope : scopeFor(scopeChoice, currentDocId);
    if (scope === undefined) {
      report({ text: t`Open the document to scan it alone, or choose another scope.`, tone: 'info' });
      return;
    }
    const checks: readonly DeterministicCheckId[] = settings.enabledChecks;
    if (checks.length === 0) {
      report({ text: t`Every quick check is off in Settings, so this tab’s scan runs nothing. Turn checks on in Settings › Coherence.`, tone: 'info' });
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

  const rerun = (scope: ScopeSpec): void => {
    setStale(null);
    const checks: readonly DeterministicCheckId[] = settings.enabledChecks;
    if (checks.length === 0) {
      report({ text: t`Every quick check is off in Settings, so this run would check nothing. Turn checks on in Settings › Coherence.`, tone: 'info' });
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
      report({ text: t`Open the document to review it alone, or choose another scope.`, tone: 'info' });
      return;
    }
    const current = session.coherenceFile();
    if (current === undefined) {
      report({ text: t`No findings file is open for this project, so there is nothing to review into.`, tone: 'error' });
      return;
    }
    const plan = planCoherenceReview(session.state, current, { scope, maxFindings: settings.maxFindings });
    if (plan.scopeDocIds.length === 0) {
      report({ text: t`There is no document in this scope to read. Write something, or choose another scope.`, tone: 'info' });
      return;
    }
    setReview({ plan, controller: null });
  };

  const startReview = async (plan: ReviewPlan): Promise<void> => {
    const current = session.coherenceFile();
    const resolved = providers?.resolveForRole?.('chat');
    const profile = resolved?.profile ?? activeProfile;
    if (current === undefined || providers === undefined || profile === undefined) {
      report({ text: t`Connect a provider in Settings to review the story with a model.`, tone: 'error' });
      return;
    }
    const controller = new AbortController();
    setReview({ plan, controller });
    try {
      const model = gatewayCoherenceModel(providers.gateway, profile, { ...resolved, languages: { ui: uiLocale(), project: session.state.manifest.project.language ?? 'en' } });
      const result = await runCoherenceReview({
        state: session.state,
        file: current,
        plan,
        model,
        maxFindings: settings.maxFindings,
        signal: controller.signal,
        currentFile: () => session.coherenceFile() ?? current,
      });
      session.applyCoherenceFile(result.file);
      const added = result.run.findingsUpserted.length;
      const summary = result.status === 'complete'
        ? t`The model review is complete: ${plural(added, { one: '# finding', other: '# findings' })} added or updated.`
        : t`The model review stopped early, so it is partial: ${plural(added, { one: '# finding', other: '# findings' })} kept. ${{ note: result.notes[0] ?? '' }}`.trim();
      report({ text: summary, tone: result.status === 'complete' ? 'info' : 'error' });
    } catch (error) {
      report({ text: t`The model review did not run: ${{ error: error instanceof Error ? error.message : String(error) }}`, tone: 'error' });
    } finally {
      setReview(null);
    }
  };

  const setStatus = (findingId: string, next: 'open' | 'fixed'): void => {
    const outcome = session.dispatch('coherence.setFindingStatus', { findingId, status: next });
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };
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
    const outcome = session.dispatch('coherence.setFindingStatus', { findingId, status: 'dismissed', reason, ...(note.trim() === '' ? {} : { note: note.trim() }) });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    focusAfterRef.current = nextOpenFindingId(sections, findingId) ?? FOCUS_HEADING;
    setDismissing(null);
  };
  const discardRun = (runId: string, at: string): void => {
    const outcome = session.dispatch('coherence.discardRun', { runId });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    report({ text: t`The run of ${{ at }} is discarded. Undo puts it back.`, tone: 'info' });
  };

  const running = review !== null && review.controller !== null;
  const plan = review !== null && !running ? review.plan : null;
  const costDetail = plan === null || providers === undefined || chatProfile === undefined
    ? undefined
    : reviewCostDetailFor(plan, providers.gateway, chatProfile.id, chatResolution?.model, chatResolution?.thinking);
  const cost = costDetail?.totalUsd;
  const documentCount = plan?.scopeDocIds.length ?? 0;
  const extractCalls = plan?.estimate.extractCalls ?? 0;

  return (
    <div className="findings" data-testid="findings-panel">
      <header className="findings-head" ref={headingRef} tabIndex={-1}>
        <p className="eyebrow"><Trans>Findings</Trans></p>
        <span className="findings-count" data-testid="findings-open">{plural(open, { one: '# open', other: '# open' })}</span>
      </header>
      <div className="findings-actions">
        <label className="findings-filter">
          <span><Trans>Scope</Trans></span>
          <select value={scopeChoice} onChange={(event) => setScopeChoice(event.target.value as ReviewScope)} aria-label={t`Scope of the scan and the review`}>
            {SCOPE_CHOICES.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select>
        </label>
        <button type="button" className="button is-primary" onClick={() => scan(false)} disabled={running}><Trans>Scan the manuscript</Trans></button>
        {approvalNeeded ? <button type="button" className="button" onClick={() => scan(true)}><Trans>Scan it anyway</Trans></button> : null}
        <button type="button" className="button" onClick={planReviewNow} disabled={mockOnly || review !== null}><Trans>Review with agent</Trans></button>
        <label className="findings-filter">
          <span><Trans>Show</Trans></span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as FindingFilter)} aria-label={t`Show findings with status`}>
            {(Object.keys(FILTER_LABELS) as FindingFilter[]).map((key) => <option key={key} value={key}>{FILTER_LABELS[key]}</option>)}
          </select>
        </label>
      </div>
      <p className="field-note findings-coverage" data-testid="findings-coverage">{scanCoverageLine(settings.enabledChecks)}</p>
      {mockOnly ? <p className="field-note" role="status"><Trans>The model review needs a provider. Connect one in Settings to read the story for plot and character problems.</Trans></p> : null}
      {plan !== null ? (
        <section className="findings-plan" aria-label={t`The model review plan`} data-testid="review-plan">
          <h3 className="findings-section-title"><Trans>Model review plan</Trans></h3>
          <p className="finding-message">{t`Reads ${plural(documentCount, { one: '# document', other: '# documents' })}: ${{ titles: plan.documents.map((doc) => isolate(doc.title)).join(', ') }}.`}</p>
          <p className="field-note">
            {t`About ${plural(extractCalls, { one: '# model call', other: '# model calls' })} to read them, then up to ${{ verifyCalls: plan.estimate.verifyCallsAtMost }} to check the pairs they raise; about ${{ tokens: formatCount(plan.estimate.totalTokensAtMost) }} tokens at most (an estimate).`}
            {cost === undefined ? null : <> {costDetail?.includesThinking === true
              ? t`About ${{ cost: formatUsd(cost) }} for the whole plan, including thinking, at this profile’s prices.`
              : t`About ${{ cost: formatUsd(cost) }} for the whole plan, at this profile’s prices.`}</>}
          </p>
          {plan.documents.some((doc) => doc.truncated || doc.codexDropped.length > 0 || doc.storyDropped.length > 0) ? <p className="field-note"><Trans>Some text did not fit the budget and is left out of the prompt: the longest passages are cut, and the least important codex entries and earlier scenes are dropped first.</Trans></p> : null}
          {plan.overGuard ? <p className="form-message is-error" role="alert"><Trans>This scope is over the 20-document guard. Approving the plan approves reading all of it.</Trans></p> : null}
          <details className="findings-prompt"><summary><Trans>The first prompt the model reads</Trans></summary><pre>{plan.promptPreview}</pre></details>
          <div className="finding-actions">
            <button type="button" className="button is-quiet" onClick={() => setReview(null)}><Trans>Cancel</Trans></button>
            <button type="button" className="button is-primary" onClick={() => void startReview(plan)}><Trans>Start the review</Trans></button>
          </div>
        </section>
      ) : null}
      {running && review !== null ? (
        <section className="findings-plan" aria-label={t`The model review in progress`} data-testid="review-running">
          <p className="finding-message" role="status"><Trans>Reviewing with the model. This can take a while, and the findings appear here when it is done.</Trans></p>
          <div className="finding-actions"><button type="button" className="button" onClick={() => review.controller?.abort()}><Trans>Stop the review</Trans></button></div>
        </section>
      ) : null}
      {status.notices.map((notice) => <p key={notice} className="field-note" role="status">{notice}</p>)}
      {status.saveFailure !== null ? <p className="form-message is-error" role="alert">{status.saveFailure}</p> : null}
      {sections.length === 0 ? (
        <EmptyState title={file === undefined || file.findings.length === 0 ? t`No findings yet` : select(filter, { open: 'No open findings', dismissed: 'No dismissed findings', fixed: 'No marked fixed findings', all: 'No all findings', other: 'No findings' })}>
          {file === undefined || file.findings.length === 0
            ? t`Run a scan to check the manuscript against the codex, the scene declarations and the screenplay and storyboard. Nothing changes in the text.`
            : t`Choose another status to see the findings in it.`}
        </EmptyState>
      ) : sections.map((section) => (
        <section key={section.severity} className={`findings-section is-${section.severity}`} aria-label={accessibleText(section.label)}>
          <h3 className="findings-section-title">{section.label} <span className="findings-section-count">{section.findings.length}</span></h3>
          {section.groups.map((group) => <FindingGroupCard key={`${group.severity}:${group.factGroup}`} group={group} stale={stale} setStale={setStale} session={session} onReveal={onReveal} onDismiss={openDismiss} onStatus={setStatus} onOpenAgent={onOpenAgent} onShowOnTimeline={onShowOnTimeline} />)}
        </section>
      ))}
      <KnowledgeList session={session} onOpenDocument={onOpenDocument} />
      <section className="findings-runs" aria-label={t`Run history`} data-testid="run-history">
        <h3 className="findings-section-title"><Trans>Run history</Trans> <span className="findings-section-count">{runs.length}</span></h3>
        {runs.length === 0 ? <p className="field-note"><Trans>No check has run on this project yet.</Trans></p> : (
          <ol className="findings-run-list">
            {runs.slice(0, 20).map((run) => {
              const count = run.findingCount;
              return (
                <li key={run.id} className="findings-run" data-run={run.id}>
                  <p className="finding-message">{run.kind} · {run.scopeLabel} · {run.at} · {plural(count, { one: '# finding', other: '# findings' })} · {run.status}</p>
                  {run.tokenLine !== undefined ? <p className="field-note">{run.tokenLine}</p> : null}
                  {run.notes.map((note) => <p key={note} className="field-note">{note}</p>)}
                  <footer className="finding-actions">
                    {run.rerunScope !== undefined ? <button type="button" className="button is-quiet" aria-label={t`Run again the scan of ${{ at: run.at }}`} onClick={() => run.rerunScope !== undefined && rerun(run.rerunScope)}><Trans>Run again</Trans></button> : null}
                    <button type="button" className="button is-quiet" aria-label={t`Discard run from ${{ at: run.at }}`} onClick={() => discardRun(run.id, run.at)}><Trans>Discard run</Trans></button>
                  </footer>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {dismissing !== null ? <DismissPicker finding={dismissing} onCancel={cancelDismiss} onDismiss={(reason, note) => dismiss(dismissing.id, reason, note)} /> : null}
    </div>
  );
}

function FindingGroupCard({ group, stale, setStale, session, onReveal, onDismiss, onStatus, onOpenAgent, onShowOnTimeline }: {
  group: FindingGroupView;
  stale: string | null;
  setStale: (key: string | null) => void;
  session: ProjectSession;
  onReveal: (docId: string, from: number, to: number) => void;
  onDismiss: (finding: FindingView) => void;
  onStatus: (findingId: string, next: 'open' | 'fixed') => void;
  onOpenAgent?: () => void;
  onShowOnTimeline?: (docIds: readonly string[], findingId: string) => void;
}): ReactNode {
  useLingui();
  const heading = group.headingRef === undefined ? group.heading : renderRef(group.headingRef, { userValues: titleValues(group.headingRef) });
  const citations = group.findings.length;
  const docIds = [...new Set(group.findings.flatMap((finding) => finding.quotes.map((quote) => quote.docId)))];
  const firstId = group.findings[0]?.id;
  return (
    <div className="finding-group" role="group" aria-label={accessibleText(heading)} data-group={group.factGroup} tabIndex={-1}>
      <header className="finding-group-head">
        <span className="finding-group-heading">{heading}</span>
        {citations > 1 ? <span className="finding-group-count">{plural(citations, { one: '# citation', other: '# citations' })}</span> : null}
        {onShowOnTimeline !== undefined && firstId !== undefined && docIds.length > 0 ? (
          <button type="button" className="button is-quiet" data-show-on-timeline onClick={() => onShowOnTimeline(docIds, firstId)}>
            <Trans>Show on timeline</Trans>
          </button>
        ) : null}
      </header>
      {group.findings.map((finding) => <FindingCard key={finding.id} finding={finding} stale={stale} setStale={setStale} session={session} onReveal={onReveal} onDismiss={onDismiss} onStatus={onStatus} onOpenAgent={onOpenAgent} />)}
    </div>
  );
}

function startFixWithAgent(session: ProjectSession, findingId: string, onOpenAgent: (() => void) | undefined): string {
  onOpenAgent?.();
  const agent = agentFor(session);
  if (agent === undefined) return t`The agent is not ready for this project yet. Open the agent panel, then try again.`;
  if (agent.snapshot().busy) return t`The agent is busy with another turn. Let it finish, then fix the finding.`;
  void agent.fixFinding(findingId);
  return agent.snapshot().message ?? t`The fix has started in the agent panel. Its outcome shows there.`;
}

function FindingCard({ finding, stale, setStale, session, onReveal, onDismiss, onStatus, onOpenAgent }: {
  finding: FindingView;
  stale: string | null;
  setStale: (key: string | null) => void;
  session: ProjectSession;
  onReveal: (docId: string, from: number, to: number) => void;
  onDismiss: (finding: FindingView) => void;
  onStatus: (findingId: string, next: 'open' | 'fixed') => void;
  onOpenAgent?: () => void;
}): ReactNode {
  useLingui();
  const [fixNote, setFixNote] = useState<string | null>(null);
  const message = findingMessageText(finding);
  const baseId = useId();
  const lang = session.state.manifest.project.language;
  const redetected = finding.redetected;
  return (
    <article className="finding" data-finding={finding.id} data-status={finding.status}>
      <header className="finding-head">
        <span className="finding-type">{finding.typeLabel}</span>
        <span className={`status-chip is-${finding.status}`}>{FILTER_LABELS[finding.status]}</span>
      </header>
      <p className="finding-message">{message}</p>
      {finding.expected !== undefined ? <p className="finding-expected"><Trans>Expected: <UserText value={finding.expected} lang={lang} /></Trans></p> : null}
      {finding.quotes.length > 0 ? (
        <ul className="finding-quotes" aria-label={t`Quoted passages`}>
          {finding.quotes.map((quote, index) => {
            const key = `${finding.id}/${quoteKey(quote)}`;
            const sourceId = `${baseId}-source-${index}`;
            return (
              <li key={key}>
                <button type="button" className="finding-quote" aria-describedby={sourceId} onClick={() => {
                  if (!quoteIsCurrent(session.state, quote)) {
                    setStale(key);
                    return;
                  }
                  setStale(null);
                  onReveal(quote.docId, quote.from, quote.to);
                }}>“<UserText value={quote.quote} lang={lang} />”</button>
                <span className="finding-source" id={sourceId}><UserText value={quote.docTitle} lang={lang} /></span>
                {stale === key ? <p className="field-note" role="status"><Trans>This passage has changed since the scan. Scan again to find it.</Trans></p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {finding.dismissedReason !== undefined ? <p className="field-note"><Trans>Dismissed as:</Trans> {dismissalLabelOf(finding.dismissedReason)}</p> : null}
      {finding.note !== undefined ? <p className="field-note"><Trans>Note: <UserText value={finding.note} lang={lang} /></Trans></p> : null}
      {redetected > 0 ? <p className="field-note">{t`Found again in ${plural(redetected, { one: '# later run', other: '# later runs' })}.`}</p> : null}
      {fixNote !== null ? <p className="field-note" role="status">{fixNote}</p> : null}
      <footer className="finding-actions">
        {finding.status === 'open' ? <>
          <button type="button" className="button" data-dismiss onClick={() => onDismiss(finding)}><Trans>Dismiss…</Trans></button>
          {finding.fixable ? <button type="button" className="button" onClick={() => setFixNote(startFixWithAgent(session, finding.id, onOpenAgent))}><Trans>Fix with agent</Trans></button> : null}
          <button type="button" className="button is-quiet" onClick={() => onStatus(finding.id, 'fixed')}><Trans>Mark fixed</Trans></button>
        </> : <button type="button" className="button is-quiet" onClick={() => onStatus(finding.id, 'open')}><Trans>Re-open</Trans></button>}
      </footer>
    </article>
  );
}

export function DismissPicker({ finding, onCancel, onDismiss }: {
  finding: FindingView;
  onCancel: () => void;
  onDismiss: (reason: string, note: string) => void;
}): ReactNode {
  useLingui();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const message = findingMessageText(finding);
  const [complaint, setComplaint] = useState<'reason' | 'note' | null>(null);
  const reasons: ReasonView[] = dismissalReasons();
  const chosen = reasons.find((candidate) => candidate.id === reason);
  const firstReason = useRef<HTMLInputElement>(null);
  useEffect(() => { firstReason.current?.focus(); }, []);
  return (
    <section className="finding-dismiss" role="dialog" aria-label={t`Dismiss the finding: ${{ message: accessibleText(message) }}`} data-testid="dismiss-picker" onKeyDown={(event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    }}>
      <fieldset className="dismiss-reasons">
        <legend><Trans>Why is this not a problem?</Trans></legend>
        {reasons.map((candidate, index) => (
          <label key={candidate.id} className="dismiss-reason">
            <input ref={index === 0 ? firstReason : undefined} type="radio" name="dismiss-reason" value={candidate.id} checked={reason === candidate.id} onChange={() => { setReason(candidate.id); setComplaint(null); }} />
            <span>{candidate.label}</span>
            {candidate.tooltip !== undefined ? <span className="field-note dismiss-tooltip">{candidate.tooltip}</span> : null}
          </label>
        ))}
      </fieldset>
      {chosen?.crossLink !== undefined ? <p className="field-note">{chosen.crossLink}</p> : null}
      {finding.checkId === 'timeline.gap' ? <p className="field-note" data-testid="dismiss-check-cross-link"><Trans>Declare a time skip on one of these scenes instead.</Trans></p> : null}
      <label className="dismiss-note">
        <span><Trans>Note (optional)</Trans></span>
        <textarea rows={2} maxLength={NOTE_LIMIT} value={note} onChange={(event) => setNote(event.target.value)} aria-label={t`Dismissal note`} />
      </label>
      {complaint !== null ? <p className="form-message is-error" role="alert">{complaint === 'reason' ? t`Choose a reason from the picker.` : t`Keep the dismissal note to ${{ limit: NOTE_LIMIT }} characters or fewer.`}</p> : null}
      <div className="finding-actions">
        <button type="button" className="button is-quiet" onClick={onCancel}><Trans>Cancel</Trans></button>
        <button type="button" className="button is-primary" disabled={reason === null} onClick={() => {
          const check = validateDismissal(reason, note);
          if (!check.ok) {
            setComplaint(reason === null || !reasons.some((candidate) => candidate.id === reason) ? 'reason' : 'note');
            return;
          }
          if (reason !== null) onDismiss(reason, note);
        }}><Trans>Dismiss finding</Trans></button>
      </div>
    </section>
  );
}
