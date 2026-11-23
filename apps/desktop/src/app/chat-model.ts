/**
 * What the chat window's model picker offers (provider-gateway §2, "One connection, many models"): every model picked under every
 * provider connection, grouped by the connection that holds it, and where the chat role currently runs. Pure, so the groups and the
 * record the panel writes can be tested without a render.
 */

import { modelsOf, type ProfileView, type ThinkingLevel } from '@caotang/gateway';

import type { RoleSettings } from './settings.js';

/** One connection's models, in the order its picker stores them: the default first. */
export interface ChatModelGroup {
  readonly profileId: string;
  readonly name: string;
  readonly models: readonly string[];
}

/** Where the chat role's next turn runs: the connection, and the model it was pinned to. */
export interface ChatModelChoice {
  readonly profileId: string;
  readonly model: string;
}

/**
 * The connections a writer can pick a chat model from. A provider connection (`endpoint`) offers every model it holds; the demo
 * profile is left out, because its one model answers the three scripted intents and nothing else, so offering it would promise a
 * choice the demo does not have. A connection being set up is not listed by the caller in the first place.
 */
export function chatModelGroups(profiles: readonly ProfileView[]): readonly ChatModelGroup[] {
  return profiles
    .filter((profile) => profile.kind === 'endpoint')
    .map((profile) => ({ profileId: profile.id, name: profile.name, models: modelsOf(profile) }));
}

/**
 * What the chat row shows and what a pick writes. The chat role resolves to its own pin when it has one, else to the active
 * profile; a pin naming a connection that is gone reads as the active profile, exactly as the router treats it.
 */
export function currentChatModel(profiles: readonly ProfileView[], roles: RoleSettings | undefined, activeId: string | null): ChatModelChoice | null {
  // `chat` is a `RoleRef` and never `'follow'` in a loaded record; a hand-written one that says so reads as no pin.
  const rawChat: unknown = roles?.chat;
  const pin = rawChat === undefined || rawChat === 'follow' ? undefined : roles?.chat;
  const pinned = pin === undefined ? undefined : profiles.find((profile) => profile.id === pin.profileId);
  if (pin !== undefined && pinned !== undefined) return { profileId: pinned.id, model: pin.model ?? pinned.defaultModel };
  const active = profiles.find((profile) => profile.id === activeId);
  return active === undefined ? null : { profileId: active.id, model: active.defaultModel };
}

/**
 * The routing record after a pick: chat runs on that connection and model from now on. Drafting and background, a fallback and a
 * step the writer set are kept, so picking a chat model never unpins another role. Picking the active connection's own default model
 * leaves chat following the active connection, which is the state it is in before any pick: that way activating another provider in
 * Settings still moves chat, until the writer asks for a particular model.
 *
 * The thinking level is a stated choice when `level` says so (`''` is the provider default) and is written even where chat follows the
 * active connection, because it is not the connection's default: it needs a pin to live in. Without a stated level it carries over only
 * on the same connection and only where the newly picked model documents it, since a level names one model's ladder.
 */
export function withChatModel(
  roles: RoleSettings | undefined,
  choice: ChatModelChoice,
  active: { readonly profileId: string; readonly defaultModel: string } | null,
  options: { readonly level?: string; readonly levels?: readonly ThinkingLevel[] } = {},
): RoleSettings {
  const { chat, ...others } = roles ?? {};
  const pin = chat === undefined || (chat as unknown) === 'follow' ? undefined : chat;
  const carries = pin !== undefined && pin.profileId === choice.profileId && pin.thinking !== undefined && (options.levels === undefined || options.levels.includes(pin.thinking));
  const stated = options.level ?? (carries ? pin?.thinking : undefined);
  const thinking = stated === undefined || stated === '' ? undefined : stated;
  // What the writer set on the chat role itself rides every pick, whatever the connection: it is their standing choice about chat, and
  // "no pin" is the only state that could hold it.
  const kept = {
    ...(pin?.fallbacks === undefined ? {} : { fallbacks: pin.fallbacks }),
    ...(pin?.steps === undefined ? {} : { steps: pin.steps }),
  };
  // The active connection's own default, with no level and nothing kept, is exactly "follow the active connection", so no pin is written.
  if (thinking === undefined && Object.keys(kept).length === 0 && active !== null && choice.profileId === active.profileId && choice.model === active.defaultModel) return others;
  return {
    ...others,
    chat: {
      ...kept,
      ...(thinking === undefined ? {} : { thinking: thinking as ThinkingLevel }),
      profileId: choice.profileId,
      model: choice.model,
    },
  };
}

/**
 * The picker as the panel draws it, built where the services are and handed to the panel as data: the groups, the current choice,
 * and the thinking levels that choice's model documents. `levels` empty leaves the level control out entirely, the rule the task-role
 * rows follow — a level the model does not list is never sent.
 */
export interface ChatModelView {
  readonly groups: readonly ChatModelGroup[];
  readonly value: ChatModelChoice | null;
  /** The connection the picked model runs through, so the header can name it rather than only the active one. */
  readonly connection: string | null;
  readonly levels: readonly ThinkingLevel[];
  readonly thinking: string;
}

export function chatModelView(
  profiles: readonly ProfileView[],
  roles: RoleSettings | undefined,
  activeId: string | null,
  levelsFor: (profileId: string, model: string) => readonly ThinkingLevel[],
): ChatModelView {
  const value = currentChatModel(profiles, roles, activeId);
  const rawChat: unknown = roles?.chat;
  const pin = rawChat === undefined || rawChat === 'follow' ? undefined : roles?.chat;
  const groups = chatModelGroups(profiles);
  // The level in force: the pin's, but only while the pin is what runs — a pin naming a connection that is gone reads as the active
  // profile, and its level would name a ladder nobody is using.
  const inForce = pin !== undefined && value !== null && pin.profileId === value.profileId;
  return {
    groups,
    value,
    connection: value === null ? null : (groups.find((group) => group.profileId === value.profileId)?.name ?? null),
    levels: value === null ? [] : levelsFor(value.profileId, value.model),
    thinking: inForce ? (pin.thinking ?? '') : '',
  };
}
