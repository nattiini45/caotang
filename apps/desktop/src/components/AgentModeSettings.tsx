/**
 * The permission-mode part of Settings › Agent (agent-harness §4): the mode a panel starts in, the switch that turns Auto off, and
 * the limits a turn is held to while Accept edits or Auto decides its cards. App settings only; no project file carries any of it.
 * An empty limit keeps the harness's default. A typed one is checked on save against the range it loads in.
 */

import { useState, type FormEvent, type ReactNode } from 'react';

import { DEFAULT_TURN_BUDGET, MODE_LABELS, PERMISSION_MODES, type PermissionMode } from '@caotang/harness';

import { MODE_HINTS } from '../app/agent-model.js';
import type { AppServices } from '../app/services.js';
import { AGENT_BUDGET_RANGES, type AgentBudgetSettings } from '../app/settings.js';

const FIELDS = [
  { key: 'maxTokens', label: 'Tokens per turn', fallback: DEFAULT_TURN_BUDGET.maxTokens },
  { key: 'maxWordsChanged', label: 'Words changed per turn', fallback: DEFAULT_TURN_BUDGET.maxWordsChanged },
  { key: 'maxDocuments', label: 'Documents touched per turn', fallback: DEFAULT_TURN_BUDGET.maxDocuments },
  { key: 'maxSteps', label: 'Steps per turn', fallback: DEFAULT_TURN_BUDGET.maxSteps },
] as const;

type BudgetField = (typeof FIELDS)[number]['key'];

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
    maxTokens: String(current.budget.maxTokens ?? ''),
    maxWordsChanged: String(current.budget.maxWordsChanged ?? ''),
    maxDocuments: String(current.budget.maxDocuments ?? ''),
    maxSteps: String(current.budget.maxSteps ?? ''),
    maxCostUsd: String(current.budget.maxCostUsd ?? ''),
  });
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: 'info' | 'error' } | null>(null);

  const saved = (error: string | null): void =>
    setMessage(error === null ? { text: 'Saved. It applies from the next card.', tone: 'info' } : { text: error, tone: 'error' });

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
    const budget: { -readonly [K in keyof AgentBudgetSettings]: AgentBudgetSettings[K] } = {};
    for (const field of FIELDS) {
      const value = readLimit(limits[field.key], field.key);
      if (value === undefined) {
        const [min, max] = AGENT_BUDGET_RANGES[field.key];
        setMessage({ text: `${field.label} is a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}, or empty for the default.`, tone: 'error' });
        return;
      }
      if (value !== null) budget[field.key] = value;
    }
    const cost = limits.maxCostUsd.trim();
    if (cost !== '') {
      const dollars = Number(cost);
      if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 1_000_000) {
        setMessage({ text: 'Cost per turn is an amount in dollars above 0, or empty for no cost limit.', tone: 'error' });
        return;
      }
      budget.maxCostUsd = dollars;
    }
    void services.settings.update({ agent: { budget } }).then(saved);
  };

  return (
    <div className="settings-agent-modes" data-testid="agent-mode-settings">
      <h4 id="settings-agent-mode">Permission mode</h4>
      <p className="settings-note">
        The mode decides who answers the agent’s cards. Ask is the default: every card waits for you. The agent panel can pick another
        mode for the project you have open; this is the one a panel starts in. Nothing about it is saved in a project.
      </p>
      <fieldset className="settings-radios" aria-labelledby="settings-agent-mode">
        {PERMISSION_MODES.filter((candidate) => candidate !== 'auto' || !locked).map((candidate) => (
          <label key={candidate} className="settings-check">
            <input type="radio" name="agent-default-mode" value={candidate} checked={mode === candidate} onChange={() => pickMode(candidate)} />
            <span>
              {MODE_LABELS[candidate]}
              <span className="muted"> — {MODE_HINTS[candidate]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="settings-check">
        <input type="checkbox" checked={locked} data-testid="agent-lock-auto" onChange={(event) => lock(event.target.checked)} />
        <span>Turn Auto mode off</span>
      </label>
      <h4>Limits while Accept edits or Auto decides</h4>
      <p className="settings-note">
        A turn stops on a question when the next step would pass a limit. Leave a field empty for its default. Model calls per turn are
        {` ${DEFAULT_TURN_BUDGET.maxModelCalls}`} in every mode. The cost limit needs a price on the active profile.
      </p>
      <form className="settings-form" noValidate onSubmit={saveLimits}>
        {FIELDS.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <input
              type="number"
              min={AGENT_BUDGET_RANGES[field.key][0]}
              max={AGENT_BUDGET_RANGES[field.key][1]}
              step={1}
              placeholder={String(field.fallback)}
              value={limits[field.key]}
              onChange={(event) => setLimits({ ...limits, [field.key]: event.target.value })}
            />
          </label>
        ))}
        <label>
          <span>Cost per turn, in dollars</span>
          <input type="number" min={0} step="any" placeholder="no limit" value={limits.maxCostUsd} onChange={(event) => setLimits({ ...limits, maxCostUsd: event.target.value })} />
        </label>
        <button type="submit" className="button is-primary">
          Save limits
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
