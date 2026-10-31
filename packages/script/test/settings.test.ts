/**
 * A show's and an episode's settings as read from the manifest (av-script.md §2): tolerant of a hand edit, the defaults,
 * the show an episode belongs to, and the vocabulary lists shared with the bus.
 */

import { EPISODE_META_KEYS, SHOW_META_KEYS, SPEECH_RATE_PRESET_NAMES } from '@caotang/bus';
import { addDocument, addFolder, addNode, createEmptyManifest, createProjectState } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  cueVocabularyOf,
  DEFAULT_CUE_VOCABULARY,
  isEpisodeDocument,
  isShowFolder,
  readEpisodeMeta,
  readShowMeta,
  showFolderOf,
  SPEECH_RATE_PRESETS,
} from '../src/index.js';

const NOW = new Date('2026-10-30T12:00:00Z');

describe('reading the settings', () => {
  it('reads every show setting the command writes', () => {
    const stored = {
      feedTitle: 'The Long Way',
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
      cueVocabulary: ['music', 'bed'],
      fundingUrl: 'https://example.com/support',
    };
    expect(Object.keys(stored)).toEqual([...SHOW_META_KEYS]);
    expect(readShowMeta(stored)).toEqual({ meta: stored, notices: [] });
  });

  it('reads every episode setting the command writes', () => {
    const stored = {
      audioUrl: 'https://cdn.example.com/12.mp3',
      audioBytes: 123456,
      audioMime: 'audio/mpeg',
      episode: 12,
      season: 2,
      episodeType: 'bonus',
      transcriptUrl: 'https://example.com/12.vtt',
      chaptersUrl: 'https://example.com/12.json',
    };
    expect(Object.keys(stored)).toEqual([...EPISODE_META_KEYS]);
    expect(readEpisodeMeta(stored)).toEqual({ meta: stored, notices: [] });
  });

  it('leaves out a value of the wrong type with a notice, and keeps the rest', () => {
    const read = readShowMeta({ speechRateWpm: 'fast', ratePreset: 'whisper', feedTitle: 'Kept', cueVocabulary: [] });
    expect(read.meta).toEqual({ feedTitle: 'Kept' });
    expect(read.notices).toHaveLength(3);
    expect(readEpisodeMeta('nope').notices).toEqual(['episodeMeta is not an object, so none of its settings are used']);
    expect(readEpisodeMeta(undefined)).toEqual({ meta: {}, notices: [] });
  });

  it('has a words-per-minute value for each preset name the bus accepts, and six default cue labels', () => {
    expect(Object.keys(SPEECH_RATE_PRESETS)).toEqual([...SPEECH_RATE_PRESET_NAMES]);
    expect(DEFAULT_CUE_VOCABULARY).toEqual(['music', 'sfx', 'ambience', 'ad', 'pause', 'sting']);
    expect(cueVocabularyOf()).toBe(DEFAULT_CUE_VOCABULARY);
    expect(cueVocabularyOf({ cueVocabulary: ['bed'] })).toEqual(['bed']);
  });
});

describe('the show an episode belongs to', () => {
  it('is the nearest folder above it marked show, and an episode outside a show has none', () => {
    const state = createProjectState(createEmptyManifest('Show', NOW));
    const show = addNode(state, { parentId: 'manuscript', title: 'The Show', kind: 'show', now: NOW }).id;
    const season = addFolder(state, { parentId: show, title: 'Season 1', now: NOW }).id;
    const episode = addDocument(state, { parentId: season, title: 'Ep 1', kind: 'av-script', now: NOW }).id;
    const chapter = addFolder(state, { parentId: 'manuscript', title: 'Ch', now: NOW }).id;
    const loose = addDocument(state, { parentId: chapter, title: 'Loose', kind: 'av-script', now: NOW }).id;
    expect(showFolderOf(state, episode)?.id).toBe(show);
    expect(showFolderOf(state, loose)).toBeUndefined();
    const byId = (id: string) => state.manifest.tree.find((n) => n.id === id)!;
    expect(isShowFolder(byId(show))).toBe(true);
    expect(isShowFolder(byId(season))).toBe(false);
    expect(isEpisodeDocument(byId(episode))).toBe(true);
  });
});
