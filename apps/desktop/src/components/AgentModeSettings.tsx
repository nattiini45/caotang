/**
 * The permission-mode part of Settings › Agent (agent-harness §4): the mode a panel starts in, the switch that turns Auto off, the
 * run limits a turn is held to in every mode (§7.1) and the limits it is also held to while Accept edits or Auto decides its cards.
 * App settings only; no project file carries any of it. An empty limit keeps the harness's default, or is not a limit. A typed one is
 * checked on save against the range it loads in.
 *
 * The mode names and hints are translated here (I5): the harness's constants are English for the model and the CLI, and the settings
 * surface is the writer's. A field's label travels inside its own sentence via `select`, so no sentence is assembled from fragments.
 */
/* lingui-set comment="Interpolated values: defaultSteps, defaultTokens, field, max, min" */

import { useState, type FormEvent, type ReactNode } from 'react';
import { select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { DEFAULT_ACTIVE_MS, DEFAULT_TURN_BUDGET, PERMISSION_MODES, type PermissionMode } from '@caotang/harness';

import type { AppServices } from '../app/services.js';
import { AGENT_BUDGET_RANGES, type AgentBudgetSettings } from '../app/settings.js';
import { useComposingEnter, formatCount } from './shared.js';

/** The run limits: held in every mode, each model call's worst case reserved before it is sent (agent-harness §7.1). */
const RUN_FIELDS = ['maxModelCalls', 'maxActiveMinutes', 'maxTokens', 'maxSteps'] as const;

/** The limits Accept edits and Auto also hold a turn to, measured after a card applies. */
const FIELDS = ['maxWordsChanged', 'maxDocuments'] as const;

const ALL_FIELDS = [...RUN_FIELDS, ...FIELDS] as const;

type BudgetField = (typeof ALL_FIELDS)[number];

/** A limit's field label, in the words the writer reads. */
function budgetLabel(key: BudgetField): string {
  switch (key) {
    case 'maxModelCalls':
      return t`Model calls per turn`;
    case 'maxActiveMinutes':
      return t`Minutes of work per turn`;
    case 'maxTokens':
      return t`Tokens per turn`;
    case 'maxSteps':
      return t`Steps per turn`;
    case 'maxWordsChanged':
      return t`Words changed per turn`;
    case 'maxDocuments':
      return t`Documents touched per turn`;
  }
}

function budgetPlaceholder(key: BudgetField): string {
  switch (key) {
    case 'maxModelCalls':
      return String(DEFAULT_TURN_BUDGET.maxModelCalls);
    case 'maxActiveMinutes':
      return String(DEFAULT_ACTIVE_MS / 60_000);
    case 'maxWordsChanged':
      return String(DEFAULT_TURN_BUDGET.maxWordsChanged);
    case 'maxDocuments':
      return String(DEFAULT_TURN_BUDGET.maxDocuments);
    case 'maxTokens':
    case 'maxSteps':
      return t`no limit`;
  }
}

/** A mode name, in the words the writer reads. */
function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'plan-only':
      return t`Plan only`;
    case 'ask':
      return t`Ask`;
    case 'accept-edits':
      return t`Accept edits`;
    case 'auto':
      return t`Auto`;
  }
}

/** What a mode decides, as one sentence. */
function modeHint(mode: PermissionMode): string {
  switch (mode) {
    case 'plan-only':
      return t`Reads run. Every write is refused and kept as a plan you can run later.`;
    case 'ask':
      return t`Every plan and confirm card waits for your decision.`;
    case 'accept-edits':
      return t`Cards that change the project’s own text or fields (including dialogue drafts, prompt drafts and storyboard shots) are approved as shown. Everything else asks.`;
    case 'auto':
      return t`Every card of the agent’s own tools is approved as shown, inside the turn’s budgets.`;
  }
}

/** A typed limit: `null` for an empty field (the default applies), `undefined` for a value outside its range. */
function readLimit(text: string, key: BudgetField): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  const [min, max] = AGENT_BUDGET_RANGES[key];
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

export function AgentModeSettings({ services }: { services: AppServices }): ReactNode {
  const current = services.settings.current().agent;
  const [mode, setMode] = useState<PermissionMode>(current.defaultMode);
  const [locked, setLocked] = useState(current.lockAuto);
  const [limits, setLimits] = useState<Record<BudgetField | 'maxCostUsd', string>>({
    maxModelCalls: String(current.budget.maxModelCalls ?? ''),
    maxActiveMinutes: String(current.budget.maxActiveMinutes ?? ''),
    maxTokens: String(current.budget.maxTokens ?? ''),
    maxWordsChanged: String(current.budget.maxWordsChanged ?? ''),
    maxDocuments: String(current.budget.maxDocuments ?? ''),
    maxSteps: String(current.budget.maxSteps ?? ''),
    maxCostUsd: String(current.budget.maxCostUsd ?? ''),
  });
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: 'info' | 'error' } | null>(null);
  // The run limits save on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving them.
  const ime = useComposingEnter();

  const saved = (error: string | null): void =>
    setMessage(error === null ? { text: t`Saved. It applies from the next card.`, tone: 'info' } : { text: error, tone: 'error' });

  const pickMode = (next: PermissionMode): void => {
    setMode(next);
    void services.settings.update({ agent: { defaultMode: next } }).then(saved);
  };

  const lock = (next: boolean): void => {
    setLocked(next);
    if (next && mode === 'auto') setMode('ask');
    void services.settings.update({ agent: { lockAuto: next } }).then(saved);
  };

  const saveLimits = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const budget: { -readonly [K in keyof AgentBudgetSettings]: AgentBudgetSettings[K] } = {};
    for (const field of ALL_FIELDS) {
      const value = readLimit(limits[field], field);
      if (value === undefined) {
        const [min, max] = AGENT_BUDGET_RANGES[field];
        setMessage({
          text: t`${select(field, {
            maxModelCalls: 'Model calls per turn',
            maxActiveMinutes: 'Minutes of work per turn',
            maxTokens: 'Tokens per turn',
            maxSteps: 'Steps per turn',
            maxWordsChanged: 'Words changed per turn',
            maxDocuments: 'Documents touched per turn',
            other: 'This limit',
          })} is a whole number from ${{ min: formatCount(min) }} to ${{ max: formatCount(max) }}, or empty for the default.`,
          tone: 'error',
        });
        return;
      }
      if (value !== null) budget[field] = value;
    }
    const cost = limits.maxCostUsd.trim();
    if (cost !== '') {
      const dollars = Number(cost);
      if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 1_000_000) {
        setMessage({ text: t`Cost per turn is an amount in dollars above 0, or empty for no cost limit.`, tone: 'error' });
        return;
      }
      budget.maxCostUsd = dollars;
    }
    void services.settings.update({ agent: { budget } }).then(saved);
  };

  // A JSX interpolation must be a bare name to reach the catalogue as `{defaultTokens}`, not positional `{0}`.
  const defaultTokens = formatCount(DEFAULT_TURN_BUDGET.maxTokens ?? 0);
  const defaultSteps = DEFAULT_TURN_BUDGET.maxSteps ?? 0;

  return (
    <div className="settings-agent-modes" data-testid="agent-mode-settings">
      <h4 id="settings-agent-mode"><Trans>Permission mode</Trans></h4>
      <p className="settings-note">
        <Trans>
          The mode decides who answers the agent’s cards. Ask is the default: every card waits for you. The agent panel can pick another
          mode for the project you have open; this is the one a panel starts in. Nothing about it is saved in a project.
        </Trans>
      </p>
      <fieldset className="settings-radios" aria-labelledby="settings-agent-mode">
        {PERMISSION_MODES.filter((candidate) => candidate !== 'auto' || !locked).map((candidate) => (
          <label key={candidate} className="settings-check">
            <input type="radio" name="agent-default-mode" value={candidate} checked={mode === candidate} onChange={() => pickMode(candidate)} />
            <span>
              {modeLabel(candidate)}
              <span className="muted"> — {modeHint(candidate)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="settings-check">
        <input type="checkbox" checked={locked} data-testid="agent-lock-auto" onChange={(event) => lock(event.target.checked)} />
        <Trans><span>Turn Auto mode off</span></Trans>
      </label>
      <h4><Trans>Run limits</Trans></h4>
      <p className="settings-note">
        <Trans>
          Limits you set on your own key. A turn is held to them in every mode: it stops on a question before a model call that could pass
          one, and a turn that works for its minutes is ended mid-call. Leave a field empty for its default, or for no limit. The cost
          limit needs prices on the active profile (Settings › Providers). In Accept edits and Auto, a turn is also held to {defaultTokens} tokens and {defaultSteps} steps when those are empty.
        </Trans>
      </p>
      <form className="settings-form" noValidate onKeyDown={ime.noteKey} onSubmit={saveLimits}>
        {RUN_FIELDS.map((field) => (
          <label key={field}>
            <span>{budgetLabel(field)}</span>
            <input
              type="number"
              min={AGENT_BUDGET_RANGES[field][0]}
              max={AGENT_BUDGET_RANGES[field][1]}
              step={1}
              placeholder={budgetPlaceholder(field)}
              value={limits[field]}
              onChange={(event) => setLimits({ ...limits, [field]: event.target.value })}
            />
          </label>
        ))}
        <label>
          <span><Trans>Cost per turn, in dollars</Trans></span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder={t`no limit`}
            value={limits.maxCostUsd}
            onChange={(event) => setLimits({ ...limits, maxCostUsd: event.target.value })}
          />
        </label>
        <h4><Trans>Also while Accept edits or Auto decides</Trans></h4>
        {FIELDS.map((field) => (
          <label key={field}>
            <span>{budgetLabel(field)}</span>
            <input
              type="number"
              min={AGENT_BUDGET_RANGES[field][0]}
              max={AGENT_BUDGET_RANGES[field][1]}
              step={1}
              placeholder={budgetPlaceholder(field)}
              value={limits[field]}
              onChange={(event) => setLimits({ ...limits, [field]: event.target.value })}
            />
          </label>
        ))}
        <button type="submit" className="button is-primary">
          <Trans>Save limits</Trans>
        </button>
      </form>
      {message === null ? null : (
        <p className={`form-message is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </div>
  );
}
