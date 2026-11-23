/**
 * The chat window's model picker (provider-gateway §2, "One connection, many models"; modern-controls.md): every model picked under
 * every provider connection, in one list, grouped by the connection that holds it, so a writer changes models in the chat window
 * instead of opening Settings. It is a menu button in the agent header — the same `Select` the rest of the app uses — and a pick
 * writes the chat role's model and level, which is the route the next turn pins.
 */

import { useId, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectTrigger, SelectValue } from '@ui-sdk/react/select';
import { isolate } from '@caotang/i18n';

import './chat-model-picker.css';

import type { ChatModelGroup } from '../app/chat-model.js';

/** A pick's value: the connection and the model, joined so one string carries both through the list. */
export const modelValue = (profileId: string, model: string): string => `${profileId}\u0000${model}`;

export function readModelValue(value: string): { readonly profileId: string; readonly model: string } | null {
  const [profileId, model] = value.split('\u0000');
  return profileId === undefined || model === undefined || model === '' ? null : { profileId, model };
}

/** The value of the level menu's "follow the provider" row: not a level, so the model's own mapping applies. */
const DEFAULT_LEVEL = '';

function SelectCaret(): ReactNode {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>;
}

export function ChatModelPicker({
  groups,
  value,
  levels,
  thinking,
  showConnection,
  disabled,
  onPick,
  onPickThinking,
}: {
  readonly groups: readonly ChatModelGroup[];
  readonly value: { readonly profileId: string; readonly model: string } | null;
  /** The levels the picked model documents; empty leaves the thinking control out, as the roles panel does. */
  readonly levels: readonly { readonly id: string; readonly label: string }[];
  readonly thinking: string;
  /**
   * Name the connection under the model inside the trigger. The wide header names it in its provider line; on a narrow one that line
   * is not drawn, and a model id alone would not say where the turn goes.
   */
  readonly showConnection: boolean;
  readonly disabled: boolean;
  readonly onPick: (profileId: string, model: string) => void;
  readonly onPickThinking: (level: string) => void;
}): ReactNode {
  const modelId = useId();
  const levelId = useId();
  if (groups.length === 0 || value === null) return null;
  const current = `${value.profileId}\u0000${value.model}`;
  // A model that left the list (its connection was edited mid-session) still shows, so the trigger never reads blank.
  const known = groups.some((group) => group.profileId === value.profileId && group.models.includes(value.model));
  const held = groups.find((group) => group.profileId === value.profileId);
  // A pick pins chat to its connection, so the trigger carries that connection's name where the header has no room for a line of its own.
  const connection = showConnection && held !== undefined ? held.name : null;
  return (
    <div className="agent-model" data-testid="agent-model">
      <Select
        required
        value={current}
        items={[
          ...groups.flatMap((group) => group.models.map((model) => ({ value: modelValue(group.profileId, model), label: model }))),
          ...(known ? [] : [{ value: current, label: value.model }]),
        ]}
        onValueChange={(next) => {
          if (typeof next !== 'string') return;
          const picked = readModelValue(next);
          if (picked !== null) onPick(picked.profileId, picked.model);
        }}
      >
        <SelectTrigger className="button agent-model-trigger" aria-labelledby={modelId} disabled={disabled}>
          {connection === null ? <SelectValue /> : (
            <span className="agent-model-value" data-slot="select-value">
              <span className="agent-model-value-model">{value.model}</span>
              <span className="agent-model-value-connection">{isolate(connection)}</span>
            </span>
          )}
          <SelectCaret />
        </SelectTrigger>
        <SelectContent className="agent-model-options">
          {groups.map((group) => (
            <SelectGroup key={group.profileId}>
              <SelectGroupLabel>{isolate(group.name)}</SelectGroupLabel>
              {group.models.map((model) => (
                <SelectItem key={model} value={modelValue(group.profileId, model)}>{model}</SelectItem>
              ))}
            </SelectGroup>
          ))}
          {known ? null : (
            <SelectGroup>
              {/* The connection's own group is right above this one, so it says why the model is here rather than repeating the name. */}
              <SelectGroupLabel>{t`No longer listed by this provider`}</SelectGroupLabel>
              <SelectItem value={current}>{value.model}</SelectItem>
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      <span id={modelId} className="visually-hidden"><Trans>Chat model</Trans></span>
      {levels.length === 0 ? null : (
        <Select
          required
          value={levels.some((level) => level.id === thinking) ? thinking : DEFAULT_LEVEL}
          items={[{ value: DEFAULT_LEVEL, label: t`Provider default` }, ...levels.map((level) => ({ value: level.id, label: level.label }))]}
          onValueChange={(next) => {
            if (typeof next === 'string') onPickThinking(next);
          }}
        >
          <SelectTrigger className="button agent-model-trigger agent-model-level" aria-labelledby={levelId} disabled={disabled}>
            <SelectValue />
            <SelectCaret />
          </SelectTrigger>
          <SelectContent className="agent-model-options">
            <SelectItem value={DEFAULT_LEVEL}>{t`Provider default`}</SelectItem>
            {levels.map((level) => (
              <SelectItem key={level.id} value={level.id}>{level.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <span id={levelId} className="visually-hidden"><Trans>Chat thinking level</Trans></span>
    </div>
  );
}
