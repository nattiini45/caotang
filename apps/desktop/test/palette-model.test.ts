/**
 * The palette's model (app/palette-model.ts; modern-interface.md §8.9, §15.1): what Ctrl+K lists for a query, grouped and in order.
 * Scenes and folders go through the binder filter's text criterion, codex entries through the codex collation, commands through the
 * shell actions; the empty palette shows the recent scenes and the commands; no match offers the agent, unsent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, addFolder, createEmptyManifest, createProjectState, type CodexEntry, type ProjectState } from '@caotang/store';

import { SHELL_ACTION_IDS, shellActions, type ShellActionHandlers } from '../src/app/shell-actions.js';
import {
  PALETTE_LIMITS,
  PALETTE_SETTINGS_SECTIONS,
  PALETTE_TABS,
  PALETTE_VIEWS,
  binderOrder,
  collatorIncludes,
  matchCodex,
  matchScenes,
  paletteResults,
  recentScenes,
  stepActive,
  type PaletteResults,
  type PaletteSources,
} from '../src/app/palette-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

beforeEach(activateEnglish);
afterEach(activateEnglish);

const NOW = new Date('2026-10-01T09:00:00Z');

function entry(id: string, name: string, aliases: string[] = [], type = 'character'): CodexEntry {
  return {
    id,
    name,
    aliases,
    type,
    description: '',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  } as CodexEntry;
}

function project(language?: string): ProjectState {
  const state = createProjectState(createEmptyManifest('Harbour Book', NOW), { now: NOW });
  if (language !== undefined) state.manifest.project.language = language;
  addFolder(state, { id: 'fOne', parentId: 'manuscript', title: 'Chapter 1', now: NOW });
  addDocument(state, { id: 'sTicket', parentId: 'fOne', title: 'Lin’s ticket', body: 'The ferry left at dawn.', now: NOW });
  addDocument(state, { id: 'sHarbour', parentId: 'fOne', title: 'The harbour', body: '', now: NOW });
  addFolder(state, { id: 'fTwo', parentId: 'manuscript', title: '第二章 港口', now: NOW });
  addDocument(state, { id: 'sZoe', parentId: 'fTwo', title: 'Zoë at the pier', body: '', now: NOW });
  addDocument(state, { id: 'sLin', parentId: 'fTwo', title: '林在码头', body: '', now: NOW });
  addDocument(state, { id: 'sNote', parentId: 'research', title: 'Ferry timetable', body: '', now: NOW });
  const node = (id: string) => state.manifest.tree.find((candidate) => candidate.id === id);
  const harbour = node('sHarbour');
  if (harbour !== undefined) harbour.synopsis = 'Lin waits for the night ferry with a stolen ticket.';
  const stamps: Record<string, string> = {
    sTicket: '2026-10-03T10:00:00Z',
    sHarbour: '2026-10-05T10:00:00Z',
    sZoe: '2026-10-04T10:00:00Z',
    sLin: '2026-10-02T10:00:00Z',
  };
  for (const [id, at] of Object.entries(stamps)) {
    const found = node(id);
    if (found !== undefined) found.updatedAt = at;
  }
  const noted = node('sNote');
  if (noted !== undefined) delete noted.updatedAt;
  state.manifest.codex = [
    entry('cMuller', 'Herr Müller'),
    entry('cZoe', 'Zoë Hart', ['The Pilot']),
    entry('cLin', '林黛玉', ['颦儿']),
    entry('cAnna', 'Anna', ['Annie']),
    entry('cStrasse', 'Hafenstraße', [], 'location'),
    entry('cAeon', 'Æon Lighthouse', [], 'location'),
  ];
  return state;
}

const noop: ShellActionHandlers = Object.fromEntries(SHELL_ACTION_IDS.map((id) => [id, () => undefined])) as unknown as ShellActionHandlers;

function sources(state: ProjectState = project(), overrides: Partial<PaletteSources> = {}): PaletteSources {
  const actions = shellActions({ undoLabel: null, focusMode: false, theme: 'light', folderPicker: true }, noop);
  return { state, actions, activeDocId: null, ...overrides };
}

const groupIds = (results: PaletteResults) => results.groups.map((group) => group.id);
const labels = (results: PaletteResults, group: string) => results.groups.find((candidate) => candidate.id === group)?.items.map((item) => item.label) ?? [];

describe('the empty palette', () => {
  it('shows the recent scenes, newest first, then every shell action', () => {
    const results = paletteResults('', sources());
    expect(groupIds(results)).toEqual(['recent', 'commands']);
    expect(labels(results, 'recent')).toEqual(['The harbour', 'Zoë at the pier', 'Lin’s ticket', '林在码头']);
    expect(results.groups[1]?.items.map((item) => item.target)).toEqual(
      SHELL_ACTION_IDS.map((actionId) => ({ kind: 'action', actionId })),
    );
    expect(results.noMatch).toBe(false);
    expect(results.items).toHaveLength(results.groups.reduce((sum, group) => sum + group.items.length, 0));
  });

  it('puts the open scene first, leaves an unstamped document out and keeps to the limit', () => {
    const state = project();
    for (let n = 0; n < 8; n += 1) {
      addDocument(state, { id: `sExtra${n}`, parentId: 'fOne', title: `Extra ${n}`, body: '', now: NOW });
      const extra = state.manifest.tree.find((node) => node.id === `sExtra${n}`);
      if (extra !== undefined) extra.updatedAt = `2026-09-0${n + 1}T10:00:00Z`;
    }
    const recent = recentScenes(sources(state, { activeDocId: 'sLin' })).map((node) => node.id);
    expect(recent[0]).toBe('sLin');
    expect(recent).toHaveLength(PALETTE_LIMITS.recent);
    expect(recent).not.toContain('sNote');
    expect(new Set(recent).size).toBe(recent.length);
  });

  it('treats a query of spaces as empty', () => {
    expect(groupIds(paletteResults('   ', sources()))).toEqual(['recent', 'commands']);
  });

  it('marks an action that cannot run now as disabled, and carries its chord', () => {
    const undo = paletteResults('', sources()).items.find((item) => item.id === 'action-undo');
    expect(undo?.disabled).toBe(true);
    expect(undo?.shortcut).toBe('undo');
    expect(paletteResults('', sources()).items.find((item) => item.id === 'action-compile')?.disabled).toBeUndefined();
  });
});

describe('scenes and folders, by the binder filter’s text criterion', () => {
  it('lists the binder in its own order, below the two sections', () => {
    expect(binderOrder(project()).map((node) => node.id)).toEqual(['fOne', 'sTicket', 'sHarbour', 'fTwo', 'sZoe', 'sLin', 'sNote']);
  });

  it('matches titles case-insensitively and puts a synopsis-only match after the title matches', () => {
    const items = matchScenes('TICKET', project());
    expect(items.map((item) => item.label)).toEqual(['Lin’s ticket', 'The harbour']);
    expect(items[0]?.detail).toBe('Chapter 1');
    expect(items[1]?.detail).toBe('Lin waits for the night ferry with a stolen ticket.');
    expect(items[0]?.target).toEqual({ kind: 'node', nodeId: 'sTicket' });
  });

  it('folds typographic apostrophes and Unicode forms the way the binder filter does', () => {
    expect(matchScenes("lin's", project()).map((item) => item.label)).toEqual(['Lin’s ticket']);
    // "Zoë" typed with a combining diaeresis finds the title stored composed.
    expect(matchScenes('zoe\u0308', project()).map((item) => item.label)).toEqual(['Zoë at the pier']);
  });

  it('is accent-sensitive, as the filter is: "zoe" does not find "Zoë"', () => {
    expect(matchScenes('zoe at', project())).toEqual([]);
  });

  it('finds CJK titles and folders by any run of their characters', () => {
    const items = matchScenes('码头', project());
    expect(items.map((item) => item.label)).toEqual(['林在码头']);
    expect(items[0]?.detail).toBe('第二章 港口');
    expect(matchScenes('港口', project()).map((item) => [item.label, item.icon])).toEqual([['第二章 港口', 'folder']]);
  });

  it('never lists the manuscript or research sections, and searches research items too', () => {
    expect(matchScenes('manuscript', project())).toEqual([]);
    expect(matchScenes('timetable', project()).map((item) => item.label)).toEqual(['Ferry timetable']);
  });

  it('does not read the body', () => {
    expect(matchScenes('dawn', project())).toEqual([]);
  });

  it('keeps to the limit', () => {
    const state = project();
    for (let n = 0; n < 12; n += 1) addDocument(state, { id: `sMany${n}`, parentId: 'fOne', title: `Many ${n}`, body: '', now: NOW });
    expect(matchScenes('many', state)).toHaveLength(PALETTE_LIMITS.scenes);
  });

  it('names an untitled node', () => {
    const state = project();
    addDocument(state, { id: 'sBlank', parentId: 'fOne', title: ' ', body: '', now: NOW });
    const blank = state.manifest.tree.find((node) => node.id === 'sBlank');
    if (blank !== undefined) blank.synopsis = 'a blank page';
    expect(matchScenes('blank page', state).map((item) => item.label)).toEqual(['Untitled']);
  });
});

describe('codex entries, by name and alias with the codex collation', () => {
  it('ignores accents and case at the collator’s base strength', () => {
    expect(matchCodex('muller', project()).map((item) => item.label)).toEqual(['Herr Müller']);
    expect(matchCodex('ZOE', project()).map((item) => item.label)).toEqual(['Zoë Hart']);
  });

  it('lines up a letter written as two: ß and ss, Æ and ae', () => {
    expect(matchCodex('hafenstrasse', project('de')).map((item) => item.label)).toEqual(['Hafenstraße']);
    expect(matchCodex('aeon', project()).map((item) => item.label)).toEqual(['Æon Lighthouse']);
  });

  it('finds CJK names and aliases', () => {
    expect(matchCodex('黛玉', project('zh')).map((item) => item.label)).toEqual(['林黛玉']);
    const byAlias = matchCodex('颦儿', project('zh'));
    expect(byAlias.map((item) => item.label)).toEqual(['林黛玉']);
    expect(byAlias[0]?.detail).toBe('Character · 颦儿');
  });

  it('puts a name that starts with the query first, then one that holds it, then an alias', () => {
    const state = project();
    state.manifest.codex = [entry('c1', 'Mary', ['Ann']), entry('c2', 'Anna'), entry('c3', 'Joanna'), entry('c4', 'Annabel')];
    expect(matchCodex('ann', state).map((item) => item.label)).toEqual(['Anna', 'Annabel', 'Joanna', 'Mary']);
  });

  it('orders within a rank by the project language’s collation (German: Ä sorts with A)', () => {
    const state = project('de');
    state.manifest.codex = [entry('c1', 'Zander'), entry('c2', 'Äpfel'), entry('c3', 'Apfelbaum'), entry('c4', 'Bäcker')];
    expect(matchCodex('a', state).map((item) => item.label)).toEqual(['Äpfel', 'Apfelbaum', 'Bäcker', 'Zander']);
  });

  it('shows the type and the alias it matched, and targets the entry', () => {
    const [pilot] = matchCodex('pilot', project());
    expect(pilot?.label).toBe('Zoë Hart');
    expect(pilot?.detail).toBe('Character · The Pilot');
    expect(pilot?.target).toEqual({ kind: 'codex', entryId: 'cZoe' });
    expect(matchCodex('lighthouse', project())[0]?.detail).toBe('Location');
  });

  it('reads a project with no codex', () => {
    const state = project();
    delete state.manifest.codex;
    expect(matchCodex('anna', state)).toEqual([]);
  });
});

describe('collatorIncludes', () => {
  const de = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
  it('finds a run anywhere, ignoring case and accents', () => {
    expect(collatorIncludes(de, 'Frau Müller-Lüdenscheidt', 'MULLER')).toBe(true);
    expect(collatorIncludes(de, 'Frau Müller', 'mueller')).toBe(false);
    expect(collatorIncludes(de, 'Straße', 'strasse')).toBe(true);
    expect(collatorIncludes(de, 'Anna', '')).toBe(true);
    expect(collatorIncludes(de, 'Ann', 'Anna Karenina')).toBe(false);
  });
});

describe('commands, places and settings', () => {
  it('reaches every shell action by its own words', () => {
    for (const action of sources().actions) {
      const results = paletteResults(action.label, sources());
      expect(results.items.some((item) => item.target.kind === 'action' && item.target.actionId === action.id), action.label).toBe(true);
    }
  });

  it('ranks a label that starts with the query first', () => {
    const results = paletteResults('fo', sources());
    expect(labels(results, 'commands')[0]).toBe('Focus mode');
    expect(labels(results, 'commands')).toContain('Save to folder');
  });

  it('matches every word of the query, in any order, against the label and the words that place it', () => {
    expect(labels(paletteResults('settings appearance', sources()), 'settings')).toEqual(['Appearance']);
    expect(labels(paletteResults('appearance settings', sources()), 'settings')).toEqual(['Appearance']);
    expect(labels(paletteResults('sidebar findings', sources()), 'places')).toEqual(['Findings']);
  });

  it('lists each view, each sidebar tab, Scene info and the agent', () => {
    const view = (label: string) => paletteResults(label, sources()).items.find((item) => item.label === label)?.target;
    expect(PALETTE_VIEWS.map((id) => paletteResults('view', sources()).items.find((item) => item.target.kind === 'view' && item.target.view === id)?.label)).toEqual([
      'Write',
      'Board',
      'Codex',
      'Timeline',
      'Pictures',
    ]);
    expect(PALETTE_TABS.map((tab) => paletteResults('sidebar', sources()).items.some((item) => item.target.kind === 'tab' && item.target.tab === tab))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(view('Scene info')).toEqual({ kind: 'scene-info' });
    expect(view('Ask the agent')).toEqual({ kind: 'agent' });
  });

  it('lists every Settings section under Settings', () => {
    const results = paletteResults('settings', sources());
    const sections = results.items.filter((item) => item.target.kind === 'settings').map((item) => (item.target.kind === 'settings' ? item.target.section : ''));
    expect(sections).toEqual([...PALETTE_SETTINGS_SECTIONS]);
    // The shell action Settings is a command; the sections are their own group.
    expect(groupIds(results)).toEqual(['commands', 'settings']);
  });

  it('offers the way back to Classic', () => {
    const results = paletteResults('classic', sources());
    expect(results.items.map((item) => item.target)).toEqual([{ kind: 'classic' }]);
    expect(results.items[0]?.label).toBe('Switch to the Classic interface');
  });

  it('groups a query that hits several sources in a fixed order, and leaves empty groups out', () => {
    const state = project();
    state.manifest.codex = [...(state.manifest.codex ?? []), entry('cCodexer', 'Writer of Codexes')];
    const results = paletteResults('codex', sources(state));
    expect(groupIds(results)).toEqual(['codex', 'places']);
    expect(labels(results, 'places')).toEqual(['Codex']);
  });
});

describe('no match', () => {
  it('offers one thing: asking the agent with the text, unsent', () => {
    const results = paletteResults('  a scene where the lighthouse fails  ', sources());
    expect(results.noMatch).toBe(true);
    expect(groupIds(results)).toEqual(['ask']);
    expect(results.items).toHaveLength(1);
    expect(results.items[0]?.target).toEqual({ kind: 'ask', text: 'a scene where the lighthouse fails' });
    expect(results.items[0]?.label).toBe('Ask the agent: “a scene where the lighthouse fails”');
  });
});

describe('stepActive', () => {
  const results = paletteResults('', sources());
  const count = results.items.length;
  const recent = results.groups[0]?.items.length ?? 0;

  it('moves with Down and Up and wraps at both ends', () => {
    expect(stepActive(results, 0, 'ArrowDown')).toBe(1);
    expect(stepActive(results, count - 1, 'ArrowDown')).toBe(0);
    expect(stepActive(results, 0, 'ArrowUp')).toBe(count - 1);
    expect(stepActive(results, -1, 'ArrowDown')).toBe(0);
  });

  it('jumps between groups with PageDown and PageUp', () => {
    expect(stepActive(results, 0, 'PageDown')).toBe(recent);
    expect(stepActive(results, recent, 'PageDown')).toBe(count - 1);
    expect(stepActive(results, recent + 2, 'PageUp')).toBe(recent);
    expect(stepActive(results, recent, 'PageUp')).toBe(0);
  });

  it('leaves every other key, Home and End included, to the field', () => {
    expect(stepActive(results, 0, 'Home')).toBeNull();
    expect(stepActive(results, 0, 'End')).toBeNull();
    expect(stepActive(results, 0, 'a')).toBeNull();
  });
});

describe('in German', () => {
  it('lists the groups and the places in the interface language, and matches the German words', async () => {
    await activateCatalogue('de');
    const results = paletteResults('', sources());
    expect(results.groups.map((group) => group.label)).not.toEqual(['Recent scenes', 'Commands']);
    const settings = paletteResults('Einstellungen', sources());
    expect(settings.items.some((item) => item.target.kind === 'action' && item.target.actionId === 'settings')).toBe(true);
    expect(settings.items.filter((item) => item.target.kind === 'settings')).toHaveLength(PALETTE_SETTINGS_SECTIONS.length);
    const classic = paletteResults('klassisch', sources());
    expect(classic.items.map((item) => item.target)).toContainEqual({ kind: 'classic' });
    const none = paletteResults('xyzzy', sources());
    expect(none.items[0]?.label).not.toContain('Ask the agent');
    expect(none.items[0]?.label).toContain('xyzzy');
  });
});
