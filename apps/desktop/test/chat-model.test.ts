/**
 * The chat window's model picker (provider-gateway §2, "One connection, many models"): every model a provider connection holds,
 * grouped by the connection, and the routing record a pick writes. Pure, so a pick can be tested without a render.
 */
import { describe, expect, it } from 'vitest';
import type { ProfileView } from '@caotang/gateway';

import { chatModelGroups, chatModelView, currentChatModel, withChatModel } from '../src/app/chat-model.js';
import type { RoleSettings } from '../src/app/settings.js';

const endpoint = (id: string, name: string, defaultModel: string, pickedModels?: readonly string[]): ProfileView => ({
  id,
  name,
  kind: 'endpoint',
  baseUrl: 'https://a.example/v1',
  defaultModel,
  ...(pickedModels === undefined ? {} : { pickedModels }),
  isActive: false,
  hasKey: true,
});

const demo: ProfileView = { id: 'prv_demo', name: 'Demo (no key)', kind: 'mock', baseUrl: 'mock://caotang', defaultModel: 'mock/echo-1', isActive: false, hasKey: false };

const PROFILES = [
  endpoint('prv_anthropic', 'Anthropic (Claude)', 'claude-sonnet-5-5', ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']),
  endpoint('prv_local', 'LM Studio', 'qwen3', undefined),
  demo,
];

describe('the models a chat picker offers', () => {
  it('groups every connection’s models in the order the connection holds them, its default first', () => {
    expect(chatModelGroups(PROFILES)).toEqual([
      { profileId: 'prv_anthropic', name: 'Anthropic (Claude)', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] },
      { profileId: 'prv_local', name: 'LM Studio', models: ['qwen3'] },
    ]);
  });

  it('leaves the demo profile out: its one model answers three scripted intents and nothing else', () => {
    expect(chatModelGroups([demo]).map((group) => group.profileId)).toEqual([]);
  });

  it('names where chat runs now: its own pin, else the active profile’s default', () => {
    expect(currentChatModel(PROFILES, undefined, 'prv_local')).toEqual({ profileId: 'prv_local', model: 'qwen3' });
    const pinned: RoleSettings = { chat: { profileId: 'prv_anthropic', model: 'claude-opus-5-5' } };
    expect(currentChatModel(PROFILES, pinned, 'prv_local')).toEqual({ profileId: 'prv_anthropic', model: 'claude-opus-5-5' });
    // A pin with no model of its own is the connection's default.
    expect(currentChatModel(PROFILES, { chat: { profileId: 'prv_anthropic' } }, null)).toEqual({ profileId: 'prv_anthropic', model: 'claude-sonnet-5-5' });
    // A pin naming a connection that is gone reads as the active profile, as the router treats it.
    expect(currentChatModel(PROFILES, { chat: { profileId: 'prv_gone' } }, 'prv_local')).toEqual({ profileId: 'prv_local', model: 'qwen3' });
    expect(currentChatModel([], undefined, null)).toBeNull();
  });
});

describe('what a pick writes', () => {
  const active = { profileId: 'prv_local', defaultModel: 'qwen3' };

  it('pins chat to the picked connection and model, and keeps every other role as it was', () => {
    const roles: RoleSettings = {
      chat: { profileId: 'prv_local', thinking: 'high' },
      drafting: { profileId: 'prv_local', model: 'qwen3' },
      background: 'follow',
    };
    const next = withChatModel(roles, { profileId: 'prv_anthropic', model: 'claude-opus-5-5' }, active);
    expect(next.chat).toEqual({ profileId: 'prv_anthropic', model: 'claude-opus-5-5' });
    expect(next.drafting).toEqual({ profileId: 'prv_local', model: 'qwen3' });
    expect(next.background).toBe('follow');
  });

  it('keeps the level while the pick stays on one connection, and drops it when the connection changes', () => {
    const roles: RoleSettings = { chat: { profileId: 'prv_local', thinking: 'high' } };
    expect(withChatModel(roles, { profileId: 'prv_anthropic', model: 'claude-opus-5-5' }, active).chat).toEqual({ profileId: 'prv_anthropic', model: 'claude-opus-5-5' });
    const other: RoleSettings = { chat: { profileId: 'prv_anthropic', model: 'claude-sonnet-5-5', thinking: 'high' } };
    expect(withChatModel(other, { profileId: 'prv_anthropic', model: 'claude-opus-5-5' }, active).chat).toEqual({ profileId: 'prv_anthropic', model: 'claude-opus-5-5', thinking: 'high' });
  });

  it('leaves chat following the active connection when the active connection’s own default is picked', () => {
    // The state chat is in before any pick: activating another provider in Settings still moves chat.
    expect(withChatModel({ chat: { profileId: 'prv_anthropic', model: 'claude-opus-5-5' }, drafting: 'follow' }, { profileId: 'prv_local', model: 'qwen3' }, active))
      .toEqual({ drafting: 'follow' });
    expect(withChatModel(undefined, { profileId: 'prv_local', model: 'qwen3' }, active)).toEqual({});
  });

  it('writes a level the writer states even where chat would otherwise follow the active connection', () => {
    // The blocking case: chat follows the active connection, and a level picked there is not that connection's default, so it needs
    // a pin of its own; dropping it silently would send the model's own mapping instead.
    const next = withChatModel(undefined, { profileId: 'prv_local', model: 'qwen3' }, active, { level: 'high', levels: ['low', 'high'] });
    expect(next.chat).toEqual({ profileId: 'prv_local', model: 'qwen3', thinking: 'high' });
    // The provider default clears a level and writes no pin at all when the pick is the active connection's own default.
    expect(withChatModel({ chat: { profileId: 'prv_local', model: 'qwen3', thinking: 'high' } }, { profileId: 'prv_local', model: 'qwen3' }, active, { level: '' })).toEqual({});
    // A level stated on another connection pins that connection.
    expect(withChatModel(undefined, { profileId: 'prv_anthropic', model: 'claude-opus-5-5' }, active, { level: 'max', levels: ['max'] }).chat)
      .toEqual({ profileId: 'prv_anthropic', model: 'claude-opus-5-5', thinking: 'max' });
  });

  it('carries a stored level onto another model of the same connection only where that model documents it', () => {
    const roles: RoleSettings = { chat: { profileId: 'prv_anthropic', model: 'claude-sonnet-5-5', thinking: 'max' } };
    const documented = withChatModel(roles, { profileId: 'prv_anthropic', model: 'claude-opus-5-5' }, active, { levels: ['low', 'medium', 'high', 'max'] });
    expect(documented.chat).toEqual({ profileId: 'prv_anthropic', model: 'claude-opus-5-5', thinking: 'max' });
    const shorter = withChatModel(roles, { profileId: 'prv_anthropic', model: 'claude-haiku-5-5' }, active, { levels: ['low', 'medium'] });
    expect(shorter.chat).toEqual({ profileId: 'prv_anthropic', model: 'claude-haiku-5-5' });
  });

  it('keeps a fallback list and the step choices a writer set on chat', () => {
    const roles: RoleSettings = {
      chat: {
        profileId: 'prv_local',
        fallbacks: [{ profileId: 'prv_anthropic' }, { profileId: 'prv_other' }],
        steps: { plan: { profileId: 'prv_anthropic', model: 'claude-sonnet-5-5' } },
      },
    };
    const next = withChatModel(roles, { profileId: 'prv_anthropic', model: 'claude-opus-5-5' }, active);
    expect(next.chat?.fallbacks).toEqual([{ profileId: 'prv_anthropic' }, { profileId: 'prv_other' }]);
    expect(next.chat?.steps).toEqual({ plan: { profileId: 'prv_anthropic', model: 'claude-sonnet-5-5' } });
  });
});

describe('the picker’s view', () => {
  it('reports the levels the picked model documents, and the level chat is pinned to', () => {
    const levels = { 'prv_anthropic': ['low', 'medium', 'high'] as const, 'prv_local': [] as const };
    const view = chatModelView(
      PROFILES,
      { chat: { profileId: 'prv_anthropic', model: 'claude-opus-5-5', thinking: 'high' } },
      'prv_local',
      (profileId) => levels[profileId as keyof typeof levels] ?? [],
    );
    expect(view.value).toEqual({ profileId: 'prv_anthropic', model: 'claude-opus-5-5' });
    expect(view.levels).toEqual(['low', 'medium', 'high']);
    expect(view.thinking).toBe('high');
    expect(view.groups).toHaveLength(2);
  });

  it('reports no levels where the model documents none, so no control is drawn', () => {
    const view = chatModelView(PROFILES, undefined, 'prv_local', () => []);
    expect(view.value).toEqual({ profileId: 'prv_local', model: 'qwen3' });
    expect(view.levels).toEqual([]);
    expect(view.thinking).toBe('');
  });

  it('names the connection the picked model runs through, so the header can say where the turn goes', () => {
    const view = chatModelView(PROFILES, { chat: { profileId: 'prv_anthropic', model: 'claude-opus-5-5' } }, 'prv_local', () => []);
    expect(view.connection).toBe('Anthropic (Claude)');
    expect(chatModelView(PROFILES, undefined, 'prv_local', () => []).connection).toBe('LM Studio');
    // A pin naming a connection that is gone reads as the active profile, so the name follows the value.
    expect(chatModelView(PROFILES, { chat: { profileId: 'prv_gone' } }, 'prv_local', () => []).connection).toBe('LM Studio');
    expect(chatModelView([], undefined, null, () => []).connection).toBeNull();
  });
});
