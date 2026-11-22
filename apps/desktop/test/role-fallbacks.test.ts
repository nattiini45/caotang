/**
 * A role's fallbacks as the settings record loads them (provider-gateway §6): at most two destinations, the role's own profile and
 * a repeated profile never among them, malformed entries dropped, and a record written before fallbacks existed read unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderService } from '../src/app/providers.js';
import { normalizeRoleSettings } from '../src/app/settings.js';

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeRoleSettings — role fallbacks (provider-gateway §6)', () => {
  it('keeps an ordered list of two destinations with their model and level', () => {
    expect(normalizeRoleSettings({
      chat: { profileId: 'prv_a', fallbacks: [{ profileId: 'prv_b', model: 'model-y', thinking: 'high' }, { profileId: 'prv_c' }] },
    })).toEqual({ chat: { profileId: 'prv_a', fallbacks: [{ profileId: 'prv_b', model: 'model-y', thinking: 'high' }, { profileId: 'prv_c' }] } });
  });

  it('drops the role’s own profile, a repeated profile, and anything past the second', () => {
    expect(normalizeRoleSettings({
      drafting: { profileId: 'prv_a', fallbacks: [{ profileId: 'prv_a' }, { profileId: 'prv_b' }, { profileId: 'prv_b' }, { profileId: 'prv_c' }] },
    })).toEqual({ drafting: { profileId: 'prv_a', fallbacks: [{ profileId: 'prv_b' }, { profileId: 'prv_c' }] } });
  });

  it('drops malformed entries and an empty list', () => {
    expect(normalizeRoleSettings({
      background: { profileId: 'prv_a', fallbacks: ['prv_b', null, 7, { model: 'x' }, { profileId: '' }] },
    })).toEqual({ background: { profileId: 'prv_a' } });
  });

  it('reads a record written before fallbacks existed unchanged', () => {
    expect(normalizeRoleSettings({ chat: { profileId: 'prv_a', model: 'model-x' }, background: 'follow' }))
      .toEqual({ chat: { profileId: 'prv_a', model: 'model-x' }, background: 'follow' });
  });

  it('keeps a role’s list when the role follows chat', () => {
    expect(normalizeRoleSettings({ drafting: { profileId: 'prv_b', fallbacks: [{ profileId: 'prv_c' }] } }))
      .toEqual({ drafting: { profileId: 'prv_b', fallbacks: [{ profileId: 'prv_c' }] } });
  });

  it('refuses a nested list: a fallback is one destination, never a chain of its own', () => {
    expect(normalizeRoleSettings({
      chat: { profileId: 'prv_a', fallbacks: [{ profileId: 'prv_b', fallbacks: [{ profileId: 'prv_c' }] }] },
    })).toEqual({ chat: { profileId: 'prv_a', fallbacks: [{ profileId: 'prv_b' }] } });
  });
});

describe('a role that follows chat (provider-gateway §6)', () => {
  it('takes chat’s profile, model and level but never chat’s fallbacks', async () => {
    const providers = (await ProviderService.open({ db: null, vault: null })).service;
    const chatProfile = await providers.addProfile({ name: 'Chat', kind: 'mock', isActive: true, defaultModel: 'mock/echo-1' });
    const spare = await providers.addProfile({ name: 'Spare', kind: 'mock', defaultModel: 'mock/echo-1' });
    providers.applyRoleSettings({
      chat: { profileId: chatProfile.view.id, fallbacks: [{ profileId: spare.view.id }] },
      drafting: 'follow',
      background: 'follow',
    });

    expect(providers.resolveForRole('chat')?.fallbacks?.map((entry) => entry.profile.id)).toEqual([spare.view.id]);
    // Consent is per role: drafting follows chat's destination and inherits none of its list, so it may not send to Spare.
    expect(providers.resolveForRole('drafting')).toMatchObject({ profile: { id: chatProfile.view.id } });
    expect(providers.resolveForRole('drafting')?.fallbacks).toBeUndefined();
    expect(providers.roleAllows('drafting', spare.view.id)).toBe(false);
  });
});

describe('per-step routing inside a role (provider-gateway §6)', () => {
  it('reads the steps the writer set, dropping malformed ones, and an old record still loads unchanged', () => {
    expect(normalizeRoleSettings({
      chat: {
        profileId: 'prv_a',
        steps: { plan: { profileId: 'prv_b', model: 'model-y', thinking: 'high' }, draft: 'follow', summarize: { model: 'x' }, mystery: { profileId: 'prv_c' } },
      },
    })).toEqual({ chat: { profileId: 'prv_a', steps: { plan: { profileId: 'prv_b', model: 'model-y', thinking: 'high' } } } });
    // A step left on follow is not stored at all: absent already means the role's own choice.
    expect(normalizeRoleSettings({ chat: { profileId: 'prv_a', steps: { draft: 'follow' } } })).toEqual({ chat: { profileId: 'prv_a' } });
    expect(normalizeRoleSettings({ chat: { profileId: 'prv_a', model: 'model-x' } }))
      .toEqual({ chat: { profileId: 'prv_a', model: 'model-x' } });
  });

  it('resolves a step to its own profile with the role’s fallbacks behind it', async () => {
    const providers = (await ProviderService.open({ db: null, vault: null })).service;
    const chat = await providers.addProfile({ name: 'Chat', kind: 'mock', isActive: true, defaultModel: 'mock/echo-1' });
    const drafts = await providers.addProfile({ name: 'Drafts', kind: 'mock', defaultModel: 'mock/echo-2' });
    const spare = await providers.addProfile({ name: 'Spare', kind: 'mock', defaultModel: 'mock/echo-1' });
    providers.applyRoleSettings({
      chat: { profileId: chat.view.id, fallbacks: [{ profileId: spare.view.id }], steps: { draft: { profileId: drafts.view.id, model: 'mock/echo-3' } } },
      drafting: 'follow',
      background: 'follow',
    });

    expect(providers.resolveForRole('chat', 'draft')).toMatchObject({
      profile: { id: drafts.view.id },
      model: 'mock/echo-3',
      fallbacks: [{ profile: { id: spare.view.id } }],
    });
    // A step the writer did not route keeps the role's own destination, and the role itself is unchanged.
    expect(providers.resolveForRole('chat', 'plan')).toMatchObject({ profile: { id: chat.view.id } });
    expect(providers.resolveForRole('chat')).toMatchObject({ profile: { id: chat.view.id } });
    // The step's profile is one the writer named for this role, so it is in the egress set; another role's is not.
    expect(providers.roleAllows('chat', drafts.view.id)).toBe(true);
    expect(providers.roleAllows('drafting', drafts.view.id)).toBe(false);
    expect(providers.resolveForRole('drafting')?.profile.id).toBe(chat.view.id);
    expect(providers.limitsForRole('chat', 'draft')).toBeDefined();
  });

  it('keeps the role’s own destination for a step whose profile is gone, and stores nothing for a step that follows', async () => {
    const providers = (await ProviderService.open({ db: null, vault: null })).service;
    const chat = await providers.addProfile({ name: 'Chat', kind: 'mock', isActive: true, defaultModel: 'mock/echo-1' });
    providers.applyRoleSettings({
      chat: { profileId: chat.view.id, steps: { draft: { profileId: 'prv_gone' } } },
      drafting: 'follow',
      background: 'follow',
    });

    expect(providers.resolveForRole('chat', 'draft')).toMatchObject({ profile: { id: chat.view.id } });
    expect(normalizeRoleSettings({ chat: { profileId: 'prv_a', steps: { draft: 'follow', plan: 'follow' } } }))
      .toEqual({ chat: { profileId: 'prv_a' } });
  });
});
