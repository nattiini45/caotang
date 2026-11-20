/**
 * A role's fallbacks as the settings record loads them (provider-gateway §6): at most two destinations, the role's own profile and
 * a repeated profile never among them, malformed entries dropped, and a record written before fallbacks existed read unchanged.
 */

import { describe, expect, it } from 'vitest';
import { normalizeRoleSettings } from '../src/app/settings.js';

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
