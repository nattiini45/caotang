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
import {
  MODEL_BACKED_TOOLS,
  RESOLVE_BADGE,
  refusalSentence,
  type PromptPreview as ContextPreview,
  type Decision,
  type PlanCardView,
  type PlanEdit,
  type PlanStepView,
} from '@caotang/harness';
import type { ProjectState } from '@caotang/store';

import { proposedByWords, type DraftCheck, type DraftedStep } from '../app/agent-model.js';
import {
  costLineOf,
  formatUsd,
  NEW_ENTRY_FROM,
  planCostOf,
  refusalReasonOf,
  stepPreviewOf,
  type ReviewPreviewView,
  type StepPreviewView,
} from '../app/plan-preview.js';

/** A step's estimated cost, as the card's step view carries it: the prompt's, or a staged review's (coherence.md §5.3). */
type PlanStepCost = NonNullable<PlanStepView['cost']>;

export interface PlanCardProps {
  readonly card: PlanCardView;
  /** The loop is waiting for this card's decision. Only then are the controls live. */
  readonly live: boolean;
  /** The drafted scenes of the card and what they need before approval, while the loop waits for the decision; `null` otherwise. */
  readonly drafts: DraftCheck | null;
  /** The project the card acts on, which names what a step's preview refers to (a codex attachment, a restructure's place). */
  readonly project: ProjectState;
  /** The project's pictures by asset id, as their file names: a codex step's visual references are named by these (video-prompt-pack §3). */
  readonly pictureNames: ReadonlyMap<string, string>;
  readonly onDecide: (decision: Decision) => void;
  /** The mode's policy approved this card, so the writer was not asked (agent-harness §4). */
  readonly auto?: boolean;
}

/** A card's heading: the one-step card, or the plan with the steps still to run. */
export function planHeading(card: PlanCardView): string {
  const pending = card.steps.filter((step) => step.status !== 'done');
  return card.kind === 'confirm' ? 'One step to confirm' : `Plan, ${pending.length} ${pending.length === 1 ? 'step' : 'steps'}`;
}

export function PlanCard({ card, live, drafts, project, pictureNames, onDecide, auto = false }: PlanCardProps): ReactNode {
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
    <section className={`plan-card is-${card.kind}${live ? ' is-live' : ''}`} aria-label={heading} data-testid="plan-card">
      <header className="plan-head">
        <h3>{heading}</h3>
        {live ? <span className="plan-state">Waiting for you</span> : <span className="plan-state">{auto ? 'Approved as shown' : card.approvable ? 'Ready' : 'Not ready'}</span>}
      </header>

      <ol className="plan-steps" aria-label="Steps">
        {card.steps.map((step) => (
          <StepRow
            key={step.origin}
            step={step}
            live={live && step.status !== 'done'}
            draft={drafts?.steps.find((entry) => entry.index === step.index)}
            project={project}
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
      {planCost !== undefined ? <p className="plan-cost">About {formatUsd(planCost)} for the whole plan, at this profile’s prices.</p> : null}

      {/* A card the mode approved has nothing left to decide. */}
      <div className="plan-actions" hidden={auto}>
        <button type="button" className="button is-primary" disabled={!approvable} onClick={() => onDecide({ action: 'approve' })}>
          {card.kind === 'confirm' ? 'Approve' : 'Approve plan'}
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
            Approve and keep the cut text
          </button>
        ) : null}
        {retryable ? (
          <button type="button" className="button" disabled={!live} onClick={() => onDecide({ action: 'retry' })}>
            Retry draft
          </button>
        ) : null}
        <button type="button" className="button is-quiet" disabled={!live} onClick={() => onDecide({ action: 'cancel' })}>
          Cancel
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
  pictureNames,
  onEdit,
  last,
}: {
  step: PlanStepView;
  live: boolean;
  draft: DraftedStep | undefined;
  project: ProjectState;
  pictureNames: ReadonlyMap<string, string>;
  onEdit: (edits: PlanEdit[]) => void;
  last: number;
}): ReactNode {
  const number = step.index + 1;
  const done = step.status === 'done';
  const shownHere = draft?.draft ?? null;
  const preview = stepPreviewOf(step.tool, step.preview, project, pictureNames);
  return (
    <li className={`plan-step is-${step.status}`} data-tool={step.tool} data-step={number}>
      <div className="plan-step-head">
        <span className="plan-step-number">{number}</span>
        <code className="plan-step-tool">{step.tool}</code>
        <span className={`badge is-risk-${step.risk.replace(/[^a-z]+/g, '-')}`} title="Risk">
          {step.risk}
        </span>
        <span className={`plan-step-status is-${step.status}`}>{statusWord(step)}</span>
        {step.badges.includes(RESOLVE_BADGE) ? (
          <span className="badge is-warn" title="A step this one reads was changed; it is looked up again when this step runs">
            {RESOLVE_BADGE}
          </span>
        ) : null}
        {step.stale ? (
          <span className="badge is-warn" title="The card cannot be approved until this step is checked again">
            {MODEL_BACKED_TOOLS.has(step.tool) ? 'Drafted against an earlier text' : 'Changed since it was checked'}
          </span>
        ) : null}
        {step.cut ? <span className="badge is-warn">Cut at the output limit</span> : null}
        {proposedByWords(step) === undefined ? null : (
          <span className="badge" title="A delegated agent proposed this step as it stands. It is in your plan, and it only runs if you approve the plan.">
            {proposedByWords(step)}
          </span>
        )}
        {!done ? (
          <span className="plan-step-controls">
            <button
              type="button"
              className="button is-quiet"
              disabled={!live || step.index === 0}
              aria-label={`Move step ${number} up`}
              onClick={() => onEdit([{ op: 'reorder', from: step.index, to: step.index - 1 }])}
            >
              ↑
            </button>
            <button
              type="button"
              className="button is-quiet"
              disabled={!live || step.index === last}
              aria-label={`Move step ${number} down`}
              onClick={() => onEdit([{ op: 'reorder', from: step.index, to: step.index + 1 }])}
            >
              ↓
            </button>
            <button
              type="button"
              className="button is-quiet is-danger"
              disabled={!live}
              aria-label={`Drop step ${number}`}
              onClick={() => onEdit([{ op: 'drop', index: step.index }])}
            >
              Drop
            </button>
          </span>
        ) : null}
      </div>

      <ExpectField step={step} live={live} onEdit={onEdit} />

      {step.error !== undefined ? <p className="plan-step-error">{refusalSentence(step.error.message, step.error.correctiveHint)}</p> : null}

      {!done ? <ParamFields step={step} live={live} onEdit={onEdit} /> : null}

      {preview !== undefined ? <StepPreviewBlock view={preview} cost={step.cost} /> : null}

      {shownHere !== null && draft !== undefined && !draft.onScreen ? (
        <figure className="plan-draft" aria-label={`Draft for step ${number}`}>
          <figcaption>
            Draft for “{draft.title}”, {shownHere.words} words
            {shownHere.cut ? ', cut off at the output limit' : ''}. It is not on screen in its scene now, so it is shown here.
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
  const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  // Shown only when the profile has a price (coherence.md §5.3): the same line a prompt's cost gets, with the bound the plan states.
  const line = costLineOf(cost);
  return (
    <figure className="plan-draft" aria-label="What this review reads">
      <figcaption>What this review reads, shown before approval</figcaption>
      <p>
        {count(view.documents.length, 'document', 'documents')}: {count(view.extractCalls, 'extraction call', 'extraction calls')}, and at most{' '}
        {count(view.verifyCallsAtMost, 'verification call', 'verification calls')}, about {view.totalTokensAtMost.toLocaleString('en-US')} tokens
        at most. Up to {view.maxFindings.toLocaleString('en-US')} findings are recorded in the inbox.
      </p>
      {line !== undefined ? <p className="context-cost">{line}</p> : null}
      {view.overGuard ? (
        <p className="status-line is-error" role="status">
          This scope is over the document guard, so approve it only if you mean the whole of it.
        </p>
      ) : null}
      <ul>
        {view.documents.map((doc, index) => (
          <li key={`${doc.title}:${index}`}>
            <strong>{doc.title}</strong> (about {doc.tokens.toLocaleString('en-US')} tokens
            {doc.truncated ? ', cut to fit the budget' : ''})
            {doc.left.length > 0 ? `. Left out of its prompt: ${doc.left.join(', ')}` : ''}
          </li>
        ))}
      </ul>
      <details>
        <summary>The first prompt the review sends</summary>
        <pre className="plan-prompt">{view.prompt}</pre>
      </details>
    </figure>
  );
}

/**
 * What a step will write, as its preview states it before approval (agent-harness §3, rows 7, 9 and 13): the synopses a batch
 * writes, a codex write's entry changes with their flags, or a restructure's tree from where each item sits to where it lands.
 */
function StepPreviewBlock({ view, cost }: { view: StepPreviewView; cost?: PlanStepCost }): ReactNode {
  if (view.kind === 'review') return <ReviewPreviewBlock view={view} cost={cost} />;
  if (view.kind === 'notes') {
    return (
      <figure className="plan-draft" aria-label="Notes this step writes">
        <figcaption>
          The notes of “{view.doc}”, word by word from the old to the new ({view.wordsBefore} words to {view.wordsAfter}), shown before approval
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
    return (
      <figure className="plan-draft" aria-label="Shots this step creates">
        <figcaption>
          {view.shots.length === 1 ? 'One shot' : `${view.shots.length} shots`}, in a new folder “{view.folder}”, shown before approval
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
          <pre className="plan-prompt" aria-label="Target tree">
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
      <figure className="plan-draft" aria-label="Dialogue this step writes">
        <figcaption>Dialogue this step writes to “{view.container}”, shown before approval</figcaption>
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
    return (
      <figure className="plan-draft" aria-label="Synopses this step writes">
        <figcaption>
          {view.rows.length === 1 ? 'One synopsis' : `${view.rows.length} synopses`}, shown before approval
        </figcaption>
        <ul>
          {view.rows.map((row, index) => (
            <li key={`${row.doc}:${index}`}>
              <strong>{row.doc}</strong> ({row.action === 'create' ? 'new' : 'replaces the current one'}, {row.words} words): {row.synopsis}
            </li>
          ))}
        </ul>
      </figure>
    );
  }
  if (view.kind === 'codex') {
    return (
      <figure className="plan-draft" aria-label="Codex entries this step writes">
        <figcaption>What this step writes to the codex</figcaption>
        <ul>
          {view.entries.map((entry, index) => (
            <li key={`${entry.name}:${index}`}>
              <strong>{entry.action === 'create' ? `New entry: ${entry.name}` : `Changes to ${entry.name}`}</strong>
              {entry.changes.length > 0 ? (
                <ul>
                  {entry.changes.map((change) => (
                    <li key={change.field}>
                      {/* A new entry has no earlier value, so its fields read as "label: value" rather than "(new entry) → value". */}
                      {change.from === NEW_ENTRY_FROM ? `${change.field}: ${change.to}` : `${change.field}: ${change.from} → ${change.to}`}
                    </li>
                  ))}
                </ul>
              ) : null}
              {entry.attached.length > 0 ? <p>Attached to {entry.attached.join(', ')}</p> : null}
              {entry.detached.length > 0 ? <p>Taken off {entry.detached.join(', ')}</p> : null}
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
    <figure className="plan-draft" aria-label="Tree this step changes">
      <figcaption>Where each item sits now, and where this step puts it</figcaption>
      <ul>
        {view.rows.map((row, index) => (
          <li key={`${row.title}:${index}`}>
            <strong>{row.title}</strong>: {row.change.toLowerCase()}, from {row.from} to {row.to}
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
  if (step.status === 'done') return 'Done';
  if (step.status === 'refused') return 'Refused';
  if (step.status === 'deferred') return 'Waits for an earlier step';
  return 'Ready';
}

/**
 * The expectation of a step. An empty edit is not sent, and the field goes back to the card's own text, as a refused edit does.
 */
function ExpectField({ step, live, onEdit }: { step: PlanStepView; live: boolean; onEdit: (edits: PlanEdit[]) => void }): ReactNode {
  const [value, setValue] = useFollowed(step.expect);
  const label = `Expected effect of step ${step.index + 1}`;
  return (
    <label className="plan-expect">
      <span className="visually-hidden">{label}</span>
      <input
        type="text"
        aria-label={label}
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
          if (event.key === 'Enter') event.currentTarget.blur();
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
  const label = `${name} of step ${step.index + 1}`;
  const send = (next: unknown): void => onEdit([{ op: 'set', index: step.index, path: ['params', name], value: next }]);
  if (typeof value === 'boolean') {
    return (
      <label className="check plan-param">
        <input type="checkbox" aria-label={label} checked={value} disabled={!live} onChange={(event) => send(event.target.checked)} />
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
        <textarea aria-label={label} value={draft} rows={3} disabled={!live} onChange={(event) => setDraft(event.target.value)} onBlur={commit} />
      ) : (
        <input
          type="text"
          aria-label={label}
          value={draft}
          disabled={!live}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
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
        aria-label={label}
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
  const [error, setError] = useState<string | null>(null);
  // A new value from the store replaces the draft; the error belonged to the draft it followed, so it goes too.
  const [seen, setSeen] = useState(text);
  if (seen !== text) {
    setSeen(text);
    setError(null);
  }
  return (
    <label className="plan-param">
      <span className="plan-param-name">{name}</span>
      <textarea
        aria-label={label}
        value={draft}
        rows={Math.min(8, draft.split('\n').length + 1)}
        disabled={!live}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(draft);
            setError(null);
            if (JSON.stringify(parsed) !== JSON.stringify(value)) onSend(parsed);
          } catch {
            setError(`${name} is not valid JSON, so the change was not sent.`);
          }
        }}
      />
      {error !== null ? <span className="plan-param-error" role="alert">{error}</span> : null}
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
  // Shown only when the profile has a price (provider-gateway §6); an unpriced profile shows the tokens and nothing else.
  const cost = costLineOf(context.cost);
  return (
    <details className="context-preview">
      <summary>
        Prompt for this step: about {context.promptTokens} tokens in, {context.completionTokens} out
      </summary>
      {cost !== undefined ? <p className="context-cost">{cost}</p> : null}
      <ul className="context-layers" aria-label="Layers">
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
                {layer.tokens}
                {budget > 0 ? ` of ${budget}` : ''} tokens
              </span>
            </li>
          );
        })}
      </ul>
      {context.codex.included.length > 0 ? (
        <ul className="context-reasons" aria-label="Codex included">
          {context.codex.included.map((entry, index) => (
            <li key={`${entry.name}:${index}`}>
              <strong>{entry.name}</strong>: {entry.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {leftOut(context).length > 0 ? (
        <ul className="context-dropped" aria-label="Left out">
          {leftOut(context).map((reason, index) => (
            <li key={`${index}:${reason}`}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {context.focus !== undefined ? (
        <p className="context-focus">
          <strong>Focus</strong>: {context.focus.summary}
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
    // A read rule keeps these from the agent (agent-harness §4): each is named here, to the writer only, so a draft that is thinner than
    // expected can be traced to the rule.
    ...context.layers.flatMap((layer) => layer.drops.filter((drop) => drop.reason.kind === 'withheld').map((drop) => `${drop.label}: ${drop.text}`)),
  ];
}
