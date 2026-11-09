/**
 * The rules part of Settings › Agent (agent-harness §4, Rules): every rule the agent is held to, with where it comes from and a way to
 * remove it. A project's rules live in its file and are made from the binder menu; the writer's own rules live in the app's settings, hold
 * in every project, and name a tool.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { TOOL_NAMES, ruleWarnings, type PermissionRule, type RuleEffect } from '@caotang/harness';

import { describeRule } from '../app/agent-rules-model.js';
import type { ProjectSession } from '../app/session.js';
import type { AppServices } from '../app/services.js';
import { useSession } from './shared.js';

function RuleList({
  label,
  rules,
  state,
  empty,
  onRemove,
}: {
  readonly label: string;
  readonly rules: readonly PermissionRule[];
  readonly state: ProjectSession['state'] | null;
  readonly empty: string;
  readonly onRemove: (index: number) => void;
}): ReactNode {
  if (rules.length === 0) return <p className="settings-note">{empty}</p>;
  return (
    <ul className="settings-rules" aria-label={label}>
      {rules.map((rule, index) => {
        const { text, inert } = describeRule(rule, state);
        return (
          <li key={`${index}:${text}`}>
            <span>
              {text}
              {rule.note === undefined ? '' : ` — ${rule.note}`}
              {inert ? ' (no effect)' : ''}
            </span>
            <button type="button" className="button is-quiet" aria-label={`Remove rule: ${text}`} onClick={() => onRemove(index)}>
              Remove
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The project's rules, re-read whenever the session changes. */
function ProjectRules({ session }: { readonly session: ProjectSession }): ReactNode {
  useSession(session);
  const warnings = ruleWarnings({ rules: session.rulesNow().filter((rule) => rule.source === 'project') }, session.state, TOOL_NAMES);
  return (
    <>
      <h5>This project</h5>
      <RuleList
        label="Rules in this project"
        rules={session.agentRules()}
        state={session.state}
        empty="This project has no rules. Right-click a folder or document in the binder and choose “Agent: may read only” or “Agent: may not read”."
        onRemove={(index) => session.removeAgentRule(index)}
      />
      {warnings.length > 0 ? (
        <ul className="settings-note" aria-label="Rules that need a look">
          {warnings.map((warning) => (
            <li key={warning}>{warning}.</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function AgentRulesSettings({ services, session }: { readonly services: AppServices; readonly session: ProjectSession | null }): ReactNode {
  const [rules, setRules] = useState<readonly PermissionRule[]>(services.settings.current().agent.rules);
  const [tool, setTool] = useState('');
  const [effect, setEffect] = useState<RuleEffect>('deny');
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: 'info' | 'error' } | null>(null);
  const warnings = ruleWarnings({ rules: rules.map((rule) => ({ ...rule, source: 'app' as const })) }, session?.state, TOOL_NAMES);

  const save = (next: readonly PermissionRule[], done: string): void => {
    void services.settings.update({ agent: { rules: next } }).then((error) => {
      if (error === null) setRules(services.settings.current().agent.rules);
      setMessage(error === null ? { text: done, tone: 'info' } : { text: error, tone: 'error' });
    });
  };

  const add = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const named = tool.trim();
    if (named === '') {
      setMessage({ text: 'Name a tool, such as scene.draft, or * for every tool.', tone: 'error' });
      return;
    }
    save([...rules, { effect, tool: named }], 'Saved. It applies from the agent’s next call.');
    setTool('');
  };

  return (
    <div className="settings-agent-rules" data-testid="agent-rules-settings">
      <h4 id="settings-agent-rules">Rules</h4>
      <p className="settings-note">
        <Trans>A “never” rule wins over an “ask first” rule, and an “ask first” rule wins over an “allow” rule. Asking first keeps approval cards even in Auto. Allow can skip a native tool’s approval card in Ask mode only when you create the rule here in Settings. Each automatic approval is logged with its rule.</Trans>
      </p>
      <p className="settings-note">
        <Trans>Allow never overrides Plan, read-only access, a mode’s restrictions or a turn marked as untrusted. External writes and tools that change agent memory or instructions still need your approval. Rules from projects, imports, MCP servers or the agent cannot grant approval.</Trans>
      </p>
      <p className="settings-note">
        <Trans>Make folder rules from the binder menu; they stay in the project’s file and travel with it. Your Settings rules below apply to every project.</Trans>
      </p>
      {session === null ? null : <ProjectRules session={session} />}
      <h5>In every project</h5>
      <RuleList
        label="Rules in every project"
        rules={rules}
        state={session?.state ?? null}
        empty="You have no rules of your own."
        onRemove={(index) => save(rules.filter((_, at) => at !== index), 'Removed. It applies from the agent’s next call.')}
      />
      {warnings.length > 0 ? (
        <ul className="settings-note" aria-label={t`Settings rules that need a look`}>
          {warnings.map((warning) => <li key={warning}>{warning}.</li>)}
        </ul>
      ) : null}
      <form className="settings-form" noValidate onSubmit={add}>
        <label>
          <span>Tool</span>
          <input list="agent-rule-tools" value={tool} placeholder="scene.draft" onChange={(event) => setTool(event.target.value)} />
          <datalist id="agent-rule-tools">
            <option value="*" />
            {TOOL_NAMES.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label>
          <span>Rule</span>
          <select value={effect} onChange={(event) => setEffect(event.target.value as RuleEffect)}>
            <option value="deny">The agent may never use it</option>
            <option value="ask">The agent must ask me first</option>
            <option value="allow"><Trans>The agent may skip approval in Ask mode</Trans></option>
          </select>
        </label>
        <button type="submit" className="button">
          Add rule
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
