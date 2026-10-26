/**
 * The preset registry — provider-gateway.md §2/§3's provider table made data. These
 * tests pin the contract the rest of the gateway reads: every preset's route, base
 * URL shape, key and CORS metadata, and what `resolveRoute` answers for known and
 * unknown (preset, model) pairs. Capability values themselves are transcribed from
 * provider documentation; the tests check the *shape* (conservative fallbacks, the
 * per-model route map) rather than re-listing every row.
 */

import { describe, expect, it } from 'vitest';
import { PRESETS, presetFor, modelRowFor, resolveRoute } from '../src/index.js';

const EXPECTED_IDS = [
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'muse',
  'mistral',
  'cohere',
  'deepseek',
  'alibaba',
  'tencent-hunyuan',
  'byteplus-ark',
  'moonshot',
  'zhipu-zai',
  'minimax',
  'xiaomi-mimo',
  'nanogpt',
  'openrouter',
  'opencode',
  'perplexity',
  'together',
  'fireworks',
  'deepinfra',
  'groq',
  'cerebras',
  'huggingface',
  'ollama',
  'lmstudio',
  'llamacpp',
  'generic',
  'mock',
] as const;

describe('the registry', () => {
  it('ships every registered provider exactly once, plus the generic endpoint', () => {
    expect(PRESETS.map((p) => p.id).sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it('names only the three shipped adapters across presets and model routes', () => {
    const adapters = new Set(['openai-chat', 'openai-responses', 'anthropic-messages']);
    for (const preset of PRESETS) {
      expect(adapters.has(preset.adapter), `${preset.id} adapter`).toBe(true);
      for (const routed of Object.values(preset.quirks.modelRoutes ?? {})) {
        expect(adapters.has(routed), `${preset.id} model route`).toBe(true);
      }
    }
  });

  it('gives every shipped provider an https base URL — the contract is https-only, except a local server on loopback', () => {
    for (const preset of PRESETS) {
      if (preset.id === 'generic') continue; // the hand-rolled endpoint supplies its own
      if (preset.id === 'mock') continue; // the local seam — 'mock://caotang' is not an address
      if (preset.local !== undefined) continue; // a server on this computer: pinned in the local presets block below
      if (preset.baseUrlFor !== undefined) {
        expect(preset.baseUrl, preset.id).toMatch(/^https:\/\//);
      } else {
        const url = new URL(preset.baseUrl);
        expect(url.protocol, preset.id).toBe('https:');
      }
    }
  });

  it('marks keys optional only where calls can run keyless: opencode, generic, the mock and the local servers', () => {
    expect(PRESETS.filter((p) => p.keyOptional === true).map((p) => p.id).sort()).toEqual(['generic', 'llamacpp', 'lmstudio', 'mock', 'ollama', 'opencode']);
  });

  it('says which presets have no /models route to call (the table is their catalogue)', () => {
    expect(PRESETS.filter((p) => p.noModelsRoute === true).map((p) => p.id)).toEqual(['cohere']);
  });

  it('says which presets a browser can reach, and says so honestly where the docs are silent', () => {
    const cors = new Map(PRESETS.map((p) => [p.id, p.cors]));
    expect(cors.get('anthropic')).toBe('ok'); // documents the browser-access header
    expect(cors.get('mock')).toBe('ok'); // the local seam is not a network call
    // The sweep asks the chat route (POST) a browser would need, not just the model list: both of these answer the list's preflight
    // and refuse the chat route's, so a page cannot use them (e2e/providers-cors.spec.ts, providers-browser-cors.md §2).
    expect(cors.get('zhipu-zai')).toBe('blocked');
    expect(cors.get('opencode')).toBe('blocked');
    for (const id of ['ollama', 'lmstudio', 'llamacpp']) expect(cors.get(id), id).toBe('local'); // the server's own setting decides
    // Everything else is 'unknown' — never claimed reachable without documentation.
    for (const preset of PRESETS) {
      if (!['anthropic', 'mock', 'zhipu-zai', 'opencode', 'ollama', 'lmstudio', 'llamacpp'].includes(preset.id)) {
        expect(preset.cors, preset.id).toBe('unknown');
      }
      if (preset.cors === 'blocked') expect(preset.corsNote, preset.id).toBeTruthy();
    }
  });

  it('opts into the browser-access header on every anthropic-messages preset pointed at an Anthropic host', () => {
    // api.anthropic.com rejects browser calls that lack anthropic-dangerous-direct-browser-access,
    // and the adapter sends that header only where the preset declares `browserAccess: true`. A
    // preset that routes the Messages adapter at Anthropic without the flag would break browser
    // calls, so the flag is pinned here rather than left to the preset author's memory.
    const guarded: string[] = [];
    for (const preset of PRESETS) {
      const routesMessages =
        preset.adapter === 'anthropic-messages' ||
        Object.values(preset.quirks.modelRoutes ?? {}).includes('anthropic-messages');
      if (!routesMessages) continue;
      // `.hostname`, not `.host`: a port is not part of the host name, and a preset that
      // carries one still routes at Anthropic.
      const host = new URL(preset.baseUrl).hostname;
      if (!/(^|\.)anthropic\.com$/.test(host)) continue;
      guarded.push(`${preset.id} → ${host}`);
      expect(preset.quirks.browserAccess, `${preset.id} → ${host}`).toBe(true);
    }
    // The loop must reach an assertion: a registry edit that moved every Anthropic route
    // away would otherwise leave this test green with nothing guarded.
    expect(guarded.length).toBeGreaterThan(0);
  });
});

describe('resolveRoute', () => {
  it('returns the preset’s adapter, quirks and the model row’s caps', () => {
    const route = resolveRoute({ preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }, 'claude-sonnet-5-5');
    expect(route.adapter).toBe('anthropic-messages');
    expect(route.quirks.browserAccess).toBe(true);
    expect(route.caps.tools).toBe(true);
    expect(route.caps.denylist).toContain('temperature');
    expect(route.caps.effortLevels).toContain('max');
  });

  it('routes OpenCode models by the documented per-model family map', () => {
    const profile = { preset: 'opencode', baseUrl: 'https://opencode.ai/inference/v1' };
    expect(resolveRoute(profile, 'claude-sonnet-5-5').adapter).toBe('anthropic-messages');
    expect(resolveRoute(profile, 'qwen3.8-flash').adapter).toBe('anthropic-messages');
    expect(resolveRoute(profile, 'qwen3.7-plus').adapter).toBe('anthropic-messages');
    // qwen3.8-max is deliberately a Chat id on OpenCode — no broad qwen* glob.
    expect(resolveRoute(profile, 'qwen3.8-max').adapter).toBe('openai-chat');
    expect(resolveRoute(profile, 'kimi-k3').adapter).toBe('openai-chat');
    expect(resolveRoute(profile, 'anything-unlisted').adapter).toBe('openai-chat');
  });

  it('sends OpenCode requests with the documented user-agent', () => {
    const route = resolveRoute({ preset: 'opencode', baseUrl: 'https://opencode.ai/inference/v1' }, 'kimi-k3');
    expect(route.quirks.extraHeaders).toMatchObject({ 'user-agent': 'caotang' });
  });

  it('falls back to conservative empty caps for a model the table does not name', () => {
    const route = resolveRoute({ preset: 'anthropic', baseUrl: 'x' }, 'claude-future-9-9');
    expect(route.adapter).toBe('anthropic-messages'); // the preset's default route
    expect(route.caps).toEqual({}); // unknown model: nothing claimed
  });

  it('answers the generic OpenAI-Chat route for the generic preset, with its honest defaults', () => {
    const route = resolveRoute({ preset: 'generic', baseUrl: 'https://x.example/v1' }, 'whatever-model');
    expect(route.adapter).toBe('openai-chat');
    expect(route.caps.tools).toBe(true);
    expect(route.caps.jsonObject).toBe(true);
  });

  it('answers the generic route with empty caps when no preset is recorded at all', () => {
    const route = resolveRoute({ baseUrl: 'https://x.example/v1' }, 'whatever-model');
    expect(route.adapter).toBe('openai-chat');
    expect(route.caps).toEqual({});
  });

  it('treats an unknown preset id as the generic route, not an error', () => {
    const route = resolveRoute({ preset: 'gone-provider', baseUrl: 'https://x.example/v1' }, 'm');
    expect(route.adapter).toBe('openai-chat');
  });
});

describe('modelRowFor', () => {
  it('prefers an exact id over a glob, and a glob over the default row', () => {
    const opencode = presetFor('opencode')!;
    expect(modelRowFor(opencode, 'kimi-k3')?.pattern).toBe('kimi-k3');
    expect(modelRowFor(opencode, 'nothing-listed')).toBeUndefined();
    const generic = presetFor('generic')!;
    expect(modelRowFor(generic, 'anything')?.pattern).toBe('*');
  });
});

describe('the Claude rows state the published window (provider-gateway §2)', () => {
  // Anthropic's model overview, "Compare models", read 2026-10-20: 1M window and 128K output for all four ids.
  // A change here is a deliberate edit to a documented number, not drift.
  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'])('%s: 1M window, 128K output', (id) => {
    const row = modelRowFor(presetFor('anthropic')!, id);
    expect(row?.contextWindow).toBe(1_000_000);
    expect(row?.maxOutputTokens).toBe(128_000);
  });

  it('states no window for a Claude id the page does not name, and no wildcard row guesses one', () => {
    const anthropic = presetFor('anthropic')!;
    expect(modelRowFor(anthropic, 'claude-future-9-9')).toBeUndefined();
    expect(anthropic.models.some((row) => row.pattern.includes('*'))).toBe(false);
  });

  it('changes no price: Sonnet and Opus keep theirs, Haiku and Fable stay unpriced', () => {
    const anthropic = presetFor('anthropic')!;
    expect(modelRowFor(anthropic, 'claude-sonnet-5-5')?.pricePer1k).toEqual({ prompt: 0.002, completion: 0.01 });
    expect(modelRowFor(anthropic, 'claude-opus-5-5')?.pricePer1k).toEqual({ prompt: 0.004, completion: 0.02 });
    expect(modelRowFor(anthropic, 'claude-haiku-5-5')?.pricePer1k).toBeUndefined();
    expect(modelRowFor(anthropic, 'claude-fable-5-1')?.pricePer1k).toBeUndefined();
  });
});

describe('preset lookups', () => {
  it('resolves presetFor by id, and generic for an absent id', () => {
    expect(presetFor('openai')?.name).toContain('OpenAI');
    expect(presetFor('generic')?.adapter).toBe('openai-chat');
    expect(presetFor(undefined)?.id).toBe('generic');
    expect(presetFor('not-real')).toBeUndefined();
  });
});

describe('the local model presets (Ollama, LM Studio, llama.cpp)', () => {
  const LOCAL = [
    ['ollama', 'http://127.0.0.1:11434/v1'],
    ['lmstudio', 'http://127.0.0.1:1234/v1'],
    ['llamacpp', 'http://127.0.0.1:8080/v1'],
  ] as const;

  it.each(LOCAL)('%s: the Chat route on a literal loopback address, with the setting that fixes a CORS refusal named', (id, baseUrl) => {
    const preset = presetFor(id)!;
    expect(preset.adapter).toBe('openai-chat');
    expect(preset.baseUrl).toBe(baseUrl);
    expect(new URL(preset.baseUrl).hostname).toBe('127.0.0.1');
    expect(preset.keyOptional).toBe(true);
    expect(preset.cors).toBe('local');
    expect(preset.local?.corsFix).toBeTruthy();
    expect(preset.local?.setup).toBeTruthy();
    expect(preset.local?.product).toBeTruthy();
  });

  it('names each product’s own fix', () => {
    expect(presetFor('ollama')!.local!.corsFix).toContain('OLLAMA_ORIGINS');
    expect(presetFor('lmstudio')!.local!.corsFix).toContain('Enable CORS');
    expect(presetFor('llamacpp')!.local!.corsFix).toContain('--cors-origins');
  });

  it('carries the longer deadlines: 180 s to the first token, 120 s between chunks, and a connect that waits for the model', () => {
    for (const [id] of LOCAL) {
      expect(presetFor(id)!.timeouts, id).toEqual({ connectMs: 180_000, firstTokenMs: 180_000, idleMs: 120_000 });
    }
    // No hosted preset overrides the deadlines.
    expect(PRESETS.filter((p) => p.timeouts !== undefined).map((p) => p.id).sort()).toEqual(['llamacpp', 'lmstudio', 'ollama']);
  });

  it('claims no native tools and no images for any model, and a conservative window', () => {
    for (const [id] of LOCAL) {
      const route = resolveRoute({ preset: id, baseUrl: presetFor(id)!.baseUrl }, 'any-pulled-model');
      expect(route.adapter, id).toBe('openai-chat');
      expect(route.caps, id).toEqual({});
      expect(modelRowFor(presetFor(id)!, 'any-pulled-model')?.contextWindow, id).toBe(4_096);
    }
  });

  it('is the only kind of preset with a local block', () => {
    expect(PRESETS.filter((p) => p.local !== undefined).map((p) => p.id).sort()).toEqual(['llamacpp', 'lmstudio', 'ollama']);
  });
});
