/**
 * The AV script's settings descriptors and binder kinds — av-script.md §2.
 *
 * `binder.create` takes `show` on a folder and `av-script` on a document. `script.setShowMeta` and `script.setEpisodeMeta`
 * take a patch of their own keys, check each value, and refuse a node that is not a show folder or an episode.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  EPISODE_META_KEYS,
  SHOW_META_KEYS,
  type CommandError,
  type ValidationNode,
  type ValidationSnapshot,
} from '../src/index.js';

const NODE = (overrides: Partial<ValidationNode> & { id: string; type: string }): ValidationNode => ({
  parentId: null,
  title: overrides.id,
  status: null,
  label: null,
  keywords: [],
  synopsis: '',
  notes: '',
  ...overrides,
});

const SHOW = 'n_SHOWONE000';
const EPISODE = 'n_EPISODE001';
const PROSE = 'n_SCENEONE00';

const SNAPSHOT: ValidationSnapshot = {
  manifest: {
    tree: [
      NODE({ id: 'root', type: 'root' }),
      NODE({ id: 'manuscript', type: 'folder', parentId: 'root', title: 'Manuscript' }),
      NODE({ id: 'research', type: 'folder', parentId: 'root', title: 'Research' }),
      NODE({ id: SHOW, type: 'folder', parentId: 'manuscript', title: 'The Show', kind: 'show' }),
      NODE({ id: EPISODE, type: 'document', parentId: SHOW, title: 'Episode 1', kind: 'av-script' }),
      NODE({ id: PROSE, type: 'document', parentId: SHOW, title: 'Notes' }),
    ],
    vocabulary: { statuses: [], labels: [] },
    codex: [],
  },
  documents: new Map(),
};

function run(name: 'binder.create' | 'script.setShowMeta' | 'script.setEpisodeMeta', params: Record<string, unknown>) {
  return COMMAND_REGISTRY[name].descriptor.validate(params, SNAPSHOT);
}

function refused(result: ReturnType<typeof run>): CommandError {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

describe('binder.create takes the two AV script kinds', () => {
  it('makes a show folder and an av-script document', () => {
    expect(run('binder.create', { parentId: 'manuscript', type: 'folder', title: 'Show', kind: 'show' })).toEqual({
      ok: true,
      value: { parentId: 'manuscript', type: 'folder', title: 'Show', kind: 'show' },
    });
    expect(run('binder.create', { parentId: SHOW, type: 'document', title: 'Ep 2', kind: 'av-script' })).toEqual({
      ok: true,
      value: { parentId: SHOW, type: 'document', title: 'Ep 2', kind: 'av-script' },
    });
  });

  it('refuses show on a document and av-script on a folder, naming what each type takes', () => {
    const doc = refused(run('binder.create', { parentId: SHOW, type: 'document', title: 'X', kind: 'show' }));
    expect(doc.target).toBe('kind');
    expect(doc.correctiveHint).toBe('a document takes "screenplay" or "av-script", or no kind at all');
    const folder = refused(run('binder.create', { parentId: SHOW, type: 'folder', title: 'X', kind: 'av-script' }));
    expect(folder.correctiveHint).toBe('a folder takes "storyboard" or "show", or no kind at all');
  });
});

describe('script.setShowMeta', () => {
  it('accepts every show key with a valid value, trimming text', () => {
    const patch = {
      feedTitle: '  The Long Way  ',
      description: 'A show.',
      defaultSpeaker: 'c_HOST000001',
      author: 'Caspar',
      language: 'en-GB',
      explicit: false,
      category: 'Arts',
      link: 'https://example.com',
      imageAssetId: 'a_0000000001',
      targetRuntimeSec: 1800,
      speechRateWpm: 160,
      ratePreset: 'broadcast',
      cueVocabulary: ['music', ' BED ', 'O.C.'],
      fundingUrl: 'https://example.com/support',
    };
    expect(Object.keys(patch)).toEqual([...SHOW_META_KEYS]);
    const result = COMMAND_REGISTRY['script.setShowMeta'].descriptor.validate({ nodeId: SHOW, patch }, SNAPSHOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.patch).toMatchObject({ feedTitle: 'The Long Way', cueVocabulary: ['music', 'BED', 'O.C.'] });
  });

  it('passes null through to clear a key', () => {
    expect(run('script.setShowMeta', { nodeId: SHOW, patch: { speechRateWpm: null, cueVocabulary: null } })).toEqual({
      ok: true,
      value: { nodeId: SHOW, patch: { speechRateWpm: null, cueVocabulary: null } },
    });
  });

  it('refuses a node that is not a show folder', () => {
    const e = refused(run('script.setShowMeta', { nodeId: 'manuscript', patch: { author: 'A' } }));
    expect(e.target).toBe('nodeId');
    expect(e.message).toContain('not a show folder');
  });

  it.each([
    [{}, 'patch', /changes nothing/],
    [{ colour: 'red' }, 'patch.colour', /not a show setting/],
    [{ link: 'http://example.com' }, 'patch.link', /https/],
    [{ link: 'example.com' }, 'patch.link', /absolute/],
    [{ fundingUrl: '/support' }, 'patch.fundingUrl', /absolute/],
    [{ language: 'English' }, 'patch.language', /language code/],
    [{ explicit: 'no' }, 'patch.explicit', /true or false/],
    [{ targetRuntimeSec: 0 }, 'patch.targetRuntimeSec', /above zero/],
    [{ speechRateWpm: -1 }, 'patch.speechRateWpm', /above zero/],
    [{ speechRateWpm: 5000 }, 'patch.speechRateWpm', /above 1000/],
    [{ ratePreset: 'fast' }, 'patch.ratePreset', /narration, broadcast/],
    [{ cueVocabulary: [] }, 'patch.cueVocabulary', /no labels/],
    [{ cueVocabulary: ['music', 'MUSIC'] }, 'patch.cueVocabulary[1]', /twice/],
    [{ cueVocabulary: ['2nd'] }, 'patch.cueVocabulary[0]', /not a label/],
    [{ cueVocabulary: 'music' }, 'patch.cueVocabulary', /list of labels/],
    [{ author: '   ' }, 'patch.author', /non-blank/],
    [{ description: 'x'.repeat(4001) }, 'patch.description', /4000/],
  ])('refuses %j at %s', (patch, target, message) => {
    const e = refused(run('script.setShowMeta', { nodeId: SHOW, patch }));
    expect(e.target).toBe(target);
    expect(e.message).toMatch(message);
  });
});

describe('script.setEpisodeMeta', () => {
  it('accepts every episode key with a valid value', () => {
    const patch = {
      audioUrl: 'https://cdn.example.com/1.mp3',
      audioBytes: 123456,
      audioMime: 'audio/mpeg',
      episode: 0,
      season: 1,
      episodeType: 'trailer',
      transcriptUrl: 'https://example.com/1.vtt',
      chaptersUrl: 'https://example.com/1.json',
    };
    expect(Object.keys(patch)).toEqual([...EPISODE_META_KEYS]);
    expect(run('script.setEpisodeMeta', { nodeId: EPISODE, patch })).toEqual({ ok: true, value: { nodeId: EPISODE, patch } });
  });

  it('refuses a document that is not an episode', () => {
    const e = refused(run('script.setEpisodeMeta', { nodeId: PROSE, patch: { episode: 1 } }));
    expect(e.target).toBe('nodeId');
    expect(e.message).toContain('not an episode');
  });

  it.each([
    [{ audioUrl: 'ftp://x/1.mp3' }, 'patch.audioUrl', /https/],
    [{ audioBytes: 0 }, 'patch.audioBytes', /at least 1/],
    [{ audioBytes: 1.5 }, 'patch.audioBytes', /whole number/],
    [{ audioMime: 'audio/ogg' }, 'patch.audioMime', /one of/],
    [{ episode: -1 }, 'patch.episode', /at least 0/],
    [{ season: 0 }, 'patch.season', /at least 1/],
    [{ episodeType: 'special' }, 'patch.episodeType', /full, trailer, bonus/],
    [{ guid: 'x' }, 'patch.guid', /not an episode setting/],
  ])('refuses %j at %s', (patch, target, message) => {
    const e = refused(run('script.setEpisodeMeta', { nodeId: EPISODE, patch }));
    expect(e.target).toBe(target);
    expect(e.message).toMatch(message);
  });
});
