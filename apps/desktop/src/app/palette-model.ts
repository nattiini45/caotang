/**
 * The palette's model — modern-interface.md §8.9. **Search** and Ctrl+K (Cmd+K) open one box that finds the project's scenes and
 * folders, its codex entries, every shell action, the places of the interface (the views, the sidebar's tabs, Scene info, the agent),
 * each Settings section, and the way back to Classic. This module decides what is listed for a query, in which groups and in what
 * order; the Modern shell's `Palette` only draws it and runs the chosen item's target.
 *
 * Pure and shell-free on purpose (§4.3, §15.1): it reads the project state, the shell actions and the query, never the DOM, a store
 * or the interface, so its rules are tested without a browser. Three rules keep it one search and not a second one:
 *
 * - Scenes and folders are matched by the binder filter's own text criterion (`matchNode` from @caotang/furniture, binder-filters
 *   §2) over their titles and synopses, so a word that finds a scene in the binder's filter finds it here, folded the same way.
 * - Codex entries are matched by name and alias with the codex panel's collation (`namesCollator`, D9): the project language's
 *   collator at base strength, so "Muller" finds "Müller" and "zoe" finds "Zoë", and they are ordered as the codex panel orders them.
 * - Commands are the shell actions (app/shell-actions.ts) with their own words, so the palette and the toolbar never disagree.
 *
 * Empty, the palette offers the recent scenes and the commands. With no match, it offers one thing: asking the agent with the text,
 * which the shell puts in the Intent box **unsent** (a send can spend the writer's money).
 */
/* lingui-set comment="The Modern interface's search and commands palette (Ctrl+K). A group heading, an item, or the line under an item." */

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { foldText, matchNode, type FilterProbe } from '@caotang/furniture';
import type { CodexEntry, ProjectState, TreeNode } from '@caotang/store';

import { childrenOf, enclosingFolders, isSectionId, synopsisPreview } from './binder-model.js';
import { TYPE_LABELS } from './codex-model.js';
import type { KeyAction } from './keymap.js';
import { newGroups, type NewKind } from './new-menu.js';
import type { ShellAction, ShellActionId } from './shell-actions.js';
import { namesCollator } from '../i18n/locale.js';

/** The Modern views a writer can go to (§6): Write, Board and Codex, and the two lazy views. */
export const PALETTE_VIEWS = ['editor', 'corkboard', 'codex', 'timeline', 'pictures'] as const;
export type PaletteView = (typeof PALETTE_VIEWS)[number];

/** The sidebar's own tabs (§7.2): Binder, Findings, Activity and Trace. The codex is a view, not a tab. */
export const PALETTE_TABS = ['binder', 'findings', 'activity', 'trace'] as const;
export type PaletteTab = (typeof PALETTE_TABS)[number];

/** The Settings sections, in the dialog's order. components/shell/modern/palette.tsx checks at compile time that none is missing. */
export const PALETTE_SETTINGS_SECTIONS = [
  'providers',
  'context',
  'agent',
  'macros',
  'writing',
  'coherence',
  'mcp',
  'appearance',
  'data',
] as const;
export type PaletteSettingsSection = (typeof PALETTE_SETTINGS_SECTIONS)[number];

/** What running an item does. The shell maps each kind to a handler it already has (§4.3 rule 3). */
export type PaletteTarget =
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'codex'; readonly entryId: string }
  | { readonly kind: 'action'; readonly actionId: ShellActionId }
  | { readonly kind: 'view'; readonly view: PaletteView }
  | { readonly kind: 'tab'; readonly tab: PaletteTab }
  | { readonly kind: 'agent-logs' }
  | { readonly kind: 'scene-info' }
  | { readonly kind: 'agent' }
  | { readonly kind: 'settings'; readonly section: PaletteSettingsSection }
  | { readonly kind: 'classic' }
  /** Make a new item through the one New (app/new-menu.ts, #478). */
  | { readonly kind: 'new'; readonly newKind: NewKind }
  /** No match: the agent opens with `text` in its Intent box, not sent. */
  | { readonly kind: 'ask'; readonly text: string };

export type PaletteGroupId = 'recent' | 'new' | 'scenes' | 'codex' | 'commands' | 'places' | 'settings' | 'ask';

/** What an item is, so the shell can give it an icon. */
export type PaletteIcon = 'new' | 'scene' | 'folder' | 'codex' | 'command' | 'view' | 'tab' | 'info' | 'agent' | 'settings' | 'interface';

export interface PaletteItem {
  /** Unique within one result and safe as a DOM id suffix. */
  readonly id: string;
  readonly label: string;
  /** The quieter line: a scene's folders, a codex entry's type, a command's hint. */
  readonly detail?: string;
  readonly icon: PaletteIcon;
  readonly target: PaletteTarget;
  /** A shell action that cannot run now (Undo with nothing to undo). Listed, and Enter does nothing. */
  readonly disabled?: boolean;
  /** The chord that does the same, for the shell to name (keymap.ts `shortcutLabel`). */
  readonly shortcut?: KeyAction;
}

export interface PaletteGroup {
  readonly id: PaletteGroupId;
  readonly label: string;
  readonly items: readonly PaletteItem[];
}

export interface PaletteResults {
  readonly query: string;
  readonly groups: readonly PaletteGroup[];
  /** Every item of every group, in the order the listbox shows them: what the arrow keys walk. */
  readonly items: readonly PaletteItem[];
  /** The query found nothing, so the only item is the ask. */
  readonly noMatch: boolean;
}

/** The parts of a shell action the palette reads. */
export type PaletteAction = Pick<ShellAction, 'id' | 'label' | 'disabled'> & Partial<Pick<ShellAction, 'hint' | 'shortcut'>>;

export interface PaletteSources {
  readonly state: ProjectState;
  readonly actions: readonly PaletteAction[];
  /** The scene open in the editor, listed first among the recent ones. */
  readonly activeDocId?: string | null;
  /** A hall's order of the New kinds (#430, #482); none keeps the base order. */
  readonly newOrder?: readonly string[];
}

/** How many of each long list one query shows; the writer narrows the query for more. */
export const PALETTE_LIMITS = { recent: 5, scenes: 8, codex: 8 } as const;

const GROUP_LABELS = {
  recent: msg`Recent scenes`,
  new: msg`New`,
  scenes: msg`Scenes and folders`,
  codex: msg`Codex`,
  commands: msg`Commands`,
  places: msg`Go to`,
  settings: msg`Settings`,
  ask: msg`Agent`,
} satisfies Readonly<Record<PaletteGroupId, MessageDescriptor>>;

const VIEW_LABELS = {
  editor: msg`Write`,
  corkboard: msg`Board`,
  codex: msg`Codex`,
  timeline: msg`Timeline`,
  pictures: msg`Pictures`,
} satisfies Readonly<Record<PaletteView, MessageDescriptor>>;

const TAB_LABELS = {
  binder: msg`Binder`,
  findings: msg`Findings`,
  activity: msg`Activity`,
  trace: msg`Trace`,
} satisfies Readonly<Record<PaletteTab, MessageDescriptor>>;

/** The Settings dialog's own section names (components/Settings.tsx), the same catalogue messages. */
const SETTINGS_LABELS = {
  providers: msg`Providers`,
  context: msg`Context`,
  agent: msg`Agent`,
  macros: msg`Macros`,
  writing: msg`Writing`,
  coherence: msg`Coherence`,
  mcp: msg`MCP & tools`,
  appearance: msg`Appearance`,
  data: msg`Data`,
} satisfies Readonly<Record<PaletteSettingsSection, MessageDescriptor>>;

export function paletteGroupLabel(group: PaletteGroupId): string {
  return i18n._(GROUP_LABELS[group]);
}

export function paletteViewLabel(view: PaletteView): string {
  return i18n._(VIEW_LABELS[view]);
}

export function paletteTabLabel(tab: PaletteTab): string {
  return i18n._(TAB_LABELS[tab]);
}

export function paletteSettingsLabel(section: PaletteSettingsSection): string {
  return i18n._(SETTINGS_LABELS[section]);
}

/** The list for a query: grouped, ordered, and flat for the arrow keys. */
export function paletteResults(query: string, sources: PaletteSources): PaletteResults {
  const trimmed = query.trim();
  const groups = trimmed === '' ? emptyGroups(sources) : matchedGroups(trimmed, sources);
  const nonEmpty = groups.filter((group) => group.items.length > 0);
  if (trimmed !== '' && nonEmpty.length === 0) {
    const ask: PaletteGroup = {
      id: 'ask',
      label: paletteGroupLabel('ask'),
      items: [
        {
          id: 'ask',
          label: t`Ask the agent: “${{ text: trimmed }}”`,
          detail: t`Opens the agent with this in the Intent box. Nothing is sent until you send it.`,
          icon: 'agent',
          target: { kind: 'ask', text: trimmed },
        },
      ],
    };
    return { query, groups: [ask], items: ask.items, noMatch: true };
  }
  return { query, groups: nonEmpty, items: nonEmpty.flatMap((group) => group.items), noMatch: false };
}

/**
 * The next active index for a key in the combobox (APG): Down and Up move and wrap, Home and End are left to the text field (they
 * move its caret), and PageDown and PageUp jump to the next or previous group's first item. `null` means the key is not the list's.
 */
export function stepActive(results: PaletteResults, active: number, key: string): number | null {
  const count = results.items.length;
  if (count === 0) return null;
  const at = Math.min(Math.max(active, 0), count - 1);
  switch (key) {
    case 'ArrowDown':
      return active < 0 ? 0 : (at + 1) % count;
    case 'ArrowUp':
      return active < 0 ? count - 1 : (at - 1 + count) % count;
    case 'PageDown':
    case 'PageUp': {
      const starts: number[] = [];
      let offset = 0;
      for (const group of results.groups) {
        starts.push(offset);
        offset += group.items.length;
      }
      if (key === 'PageDown') return starts.find((start) => start > at) ?? count - 1;
      return [...starts].reverse().find((start) => start < at) ?? 0;
    }
    default:
      return null;
  }
}

/* ---- The empty palette: recent scenes and the commands. ---- */

function emptyGroups(sources: PaletteSources): PaletteGroup[] {
  return [
    { id: 'recent', label: paletteGroupLabel('recent'), items: recentScenes(sources).map((node) => nodeItem(sources.state, node)) },
    { id: 'places', label: paletteGroupLabel('places'), items: viewItems().map(({ item }) => item) },
    { id: 'new', label: paletteGroupLabel('new'), items: newItems(sources.newOrder).map(({ item }) => item) },
    { id: 'commands', label: paletteGroupLabel('commands'), items: sources.actions.map(actionItem) },
  ];
}

/**
 * The scenes most recently written in, the open one first: documents by their `updatedAt`, newest first, ties in binder order.
 * A document never stamped is not recent.
 */
export function recentScenes(sources: PaletteSources): TreeNode[] {
  const { state, activeDocId } = sources;
  const order = new Map(binderOrder(state).map((node, index) => [node.id, index] as const));
  const stamped = state.manifest.tree
    .filter((node) => node.type === 'document' && order.has(node.id) && node.id !== activeDocId)
    .map((node) => ({ node, at: node.updatedAt === undefined ? Number.NaN : Date.parse(node.updatedAt) }))
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((a, b) => b.at - a.at || (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0))
    .map((entry) => entry.node);
  const active = activeDocId === null || activeDocId === undefined ? undefined : state.manifest.tree.find((node) => node.id === activeDocId);
  const first = active !== undefined && active.type === 'document' && order.has(active.id) ? [active] : [];
  return [...first, ...stamped].slice(0, PALETTE_LIMITS.recent);
}

/* ---- A query: every source, matched. ---- */

function matchedGroups(query: string, sources: PaletteSources): PaletteGroup[] {
  return [
    { id: 'scenes', label: paletteGroupLabel('scenes'), items: matchScenes(query, sources.state) },
    { id: 'new', label: paletteGroupLabel('new'), items: rank(query, newItems(sources.newOrder)) },
    { id: 'codex', label: paletteGroupLabel('codex'), items: matchCodex(query, sources.state) },
    { id: 'commands', label: paletteGroupLabel('commands'), items: rank(query, commandItems(sources.actions)) },
    { id: 'places', label: paletteGroupLabel('places'), items: rank(query, placeItems()) },
    { id: 'settings', label: paletteGroupLabel('settings'), items: rank(query, settingsItems()) },
  ];
}

/** The binder's nodes below the two sections, depth first in sibling order: the order the binder lists them. */
export function binderOrder(state: ProjectState): TreeNode[] {
  const out: TreeNode[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null): void => {
    for (const node of childrenOf(state, parentId)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if ((node.type === 'document' || node.type === 'folder') && !isSectionId(node.id)) out.push(node);
      walk(node.id);
    }
  };
  walk(null);
  return out;
}

/** A probe for the text criterion over titles and synopses: the body, the word counts and the clock are never read. */
const TITLE_AND_SYNOPSIS_PROBE: FilterProbe = {
  bodyOf: () => '',
  wordsOf: () => 0,
  now: new Date(0),
  vocabulary: { statusIds: new Set<string>(), labelIds: new Set<string>() },
};

/**
 * Scenes and folders whose title or synopsis holds the query, by the binder filter's text criterion. A title match comes before a
 * synopsis-only match; within each, binder order.
 */
export function matchScenes(query: string, state: ProjectState): PaletteItem[] {
  const byTitle: TreeNode[] = [];
  const bySynopsis: TreeNode[] = [];
  for (const node of binderOrder(state)) {
    if (matchNode(node, { text: query, textIn: ['title'] }, TITLE_AND_SYNOPSIS_PROBE)) byTitle.push(node);
    else if (matchNode(node, { text: query, textIn: ['synopsis'] }, TITLE_AND_SYNOPSIS_PROBE)) bySynopsis.push(node);
  }
  return [
    ...byTitle.map((node) => nodeItem(state, node)),
    ...bySynopsis.map((node) => nodeItem(state, node, true)),
  ].slice(0, PALETTE_LIMITS.scenes);
}

function nodeItem(state: ProjectState, node: TreeNode, bySynopsis = false): PaletteItem {
  const folders = enclosingFolders(state, node.id)
    .reverse()
    .map((folder) => untitled(folder.title));
  const preview = bySynopsis ? synopsisPreview(node.synopsis) : undefined;
  const detail = preview ?? (folders.length > 0 ? folders.join(' › ') : undefined);
  return {
    id: `node-${node.id}`,
    label: untitled(node.title),
    ...(detail === undefined ? {} : { detail }),
    icon: node.type === 'folder' ? 'folder' : 'scene',
    target: { kind: 'node', nodeId: node.id },
  };
}

function untitled(title: string): string {
  return title.trim() === '' ? t`Untitled` : title;
}

/**
 * Whether `needle` occurs in `haystack` by the collator: some run of the haystack's characters compares equal to the needle. At base
 * strength that ignores case and accents and treats a German "ß" as "ss"; the run may be one character longer or shorter than the
 * needle, so a letter written as two (ß, æ) still lines up. Both are folded to NFC first. A collator equal to none of the runs, as
 * for a needle longer than the text, answers false.
 */
export function collatorIncludes(collator: Intl.Collator, haystack: string, needle: string): boolean {
  const hay = [...haystack.normalize('NFC')];
  const want = needle.normalize('NFC');
  const length = [...want].length;
  if (length === 0) return true;
  if (foldText(haystack).includes(foldText(needle))) return true;
  for (let start = 0; start < hay.length; start += 1) {
    for (const size of [length, length + 1, length - 1]) {
      if (size < 1 || start + size > hay.length) continue;
      if (collator.compare(hay.slice(start, start + size).join(''), want) === 0) return true;
    }
  }
  return false;
}

/**
 * Codex entries whose name or an alias holds the query, by the codex panel's collation. A name that starts with the query comes
 * first, then a name that holds it, then an alias; within each, the codex panel's alphabetical order in the project language.
 */
export function matchCodex(query: string, state: ProjectState): PaletteItem[] {
  const entries = state.manifest.codex ?? [];
  const collator = namesCollator(state.manifest.project.language);
  const ranked: { entry: CodexEntry; rank: number; alias?: string }[] = [];
  for (const entry of entries) {
    const head = [...entry.name.normalize('NFC')].slice(0, [...query.normalize('NFC')].length + 1);
    if (collatorStarts(collator, head, query)) ranked.push({ entry, rank: 0 });
    else if (collatorIncludes(collator, entry.name, query)) ranked.push({ entry, rank: 1 });
    else {
      const alias = entry.aliases.find((name) => collatorIncludes(collator, name, query));
      if (alias !== undefined) ranked.push({ entry, rank: 2, alias });
    }
  }
  ranked.sort(
    (a, b) => a.rank - b.rank || collator.compare(a.entry.name, b.entry.name) || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
  return ranked.slice(0, PALETTE_LIMITS.codex).map(({ entry, alias }) => {
    const type = TYPE_LABELS[entry.type] ?? entry.type;
    return {
      id: `codex-${entry.id}`,
      label: entry.name,
      detail: alias === undefined ? type : `${type} · ${alias}`,
      icon: 'codex',
      target: { kind: 'codex', entryId: entry.id },
    };
  });
}

/** Whether the first characters of a name (`head`, one longer than the query) begin with the query by the collator. */
function collatorStarts(collator: Intl.Collator, head: readonly string[], query: string): boolean {
  const want = query.normalize('NFC');
  const length = [...want].length;
  for (const size of [length, length + 1, length - 1]) {
    if (size < 1 || size > head.length) continue;
    if (collator.compare(head.slice(0, size).join(''), want) === 0) return true;
  }
  return false;
}

/**
 * An action's detail line says only what its label does not (Stageshow polish #362): a hint that opens with the label keeps what
 * follows ("Project details: title, author…" shows "title, author…"), and a bracketed shortcut goes, because the chip shows it.
 */
export function actionDetail(action: Pick<PaletteAction, 'label' | 'hint' | 'shortcut'>): string | undefined {
  const { hint, label } = action;
  if (hint === undefined || !hint.startsWith(label)) return hint;
  const rest = hint.slice(label.length).replace(/^[\s:：]+/u, '');
  return rest === '' || (action.shortcut !== undefined && /^[(（]/u.test(rest)) ? undefined : rest;
}

function actionItem(action: PaletteAction): PaletteItem {
  const detail = actionDetail(action);
  return {
    id: `action-${action.id}`,
    label: action.label,
    ...(detail === undefined ? {} : { detail }),
    icon: 'command',
    target: { kind: 'action', actionId: action.id },
    ...(action.disabled ? { disabled: true } : {}),
    ...(action.shortcut === undefined ? {} : { shortcut: action.shortcut }),
  };
}

/** The shell actions, then the way back to Classic. */
function commandItems(actions: readonly PaletteAction[]): Searchable[] {
  return [
    ...actions.map((action) => ({ item: actionItem(action), words: [action.label] })),
    {
      item: { id: 'classic', label: t`Switch to the Classic interface`, icon: 'interface', target: { kind: 'classic' } },
      words: [t`Switch to the Classic interface`, t`Interface`],
    },
  ];
}

/** Everything the one New makes (#478), in the hall's order, each found by its name or by "New". */
function newItems(order?: readonly string[]): Searchable[] {
  const word = t`New`;
  return newGroups(order)
    .flatMap((group) => group.entries)
    .map((entry) => ({
      item: { id: `new-${entry.kind}`, label: entry.label, detail: entry.detail, icon: 'new' as const, target: { kind: 'new' as const, newKind: entry.kind } },
      words: [entry.label, word],
    }));
}

/** The views, each a place to go. */
function viewItems(): Searchable[] {
  const view = t`View`;
  return PALETTE_VIEWS.map((id) => ({
    item: { id: `view-${id}`, label: paletteViewLabel(id), detail: view, icon: 'view' as const, target: { kind: 'view' as const, view: id } },
    words: [paletteViewLabel(id), view],
  }));
}

/** The views, the sidebar's tabs, Scene info and the agent. */
function placeItems(): Searchable[] {
  const sidebar = t`Sidebar`;
  return [
    ...viewItems(),
    { item: { id: 'agent-logs', label: t`Agent`, detail: sidebar, icon: 'tab' as const, target: { kind: 'agent-logs' as const } }, words: [t`Agent`, sidebar] },
    ...PALETTE_TABS.map((id) => ({
      item: { id: `tab-${id}`, label: paletteTabLabel(id), detail: sidebar, icon: 'tab' as const, target: { kind: 'tab' as const, tab: id } },
      words: [paletteTabLabel(id), sidebar],
    })),
    { item: { id: 'scene-info', label: t`Scene info`, icon: 'info', target: { kind: 'scene-info' } }, words: [t`Scene info`] },
    { item: { id: 'agent', label: t`Ask the agent`, icon: 'agent', target: { kind: 'agent' } }, words: [t`Ask the agent`, t`Agent`] },
  ];
}

function settingsItems(): Searchable[] {
  const settings = paletteGroupLabel('settings');
  return PALETTE_SETTINGS_SECTIONS.map((section) => ({
    item: { id: `settings-${section}`, label: paletteSettingsLabel(section), detail: settings, icon: 'settings', target: { kind: 'settings', section } },
    words: [paletteSettingsLabel(section), settings],
  }));
}

interface Searchable {
  readonly item: PaletteItem;
  /** What the query is matched against: the label first, then the words that place it ("Settings", "View"). */
  readonly words: readonly string[];
}

/**
 * The items every word of the query is found in (each word somewhere in the label or the placing words, folded as the binder
 * filter folds), best first: the label starts with the query, then a word of the label does, then the rest; ties keep their order.
 */
export function rank(query: string, candidates: readonly Searchable[]): PaletteItem[] {
  const folded = foldText(query.trim());
  const terms = folded.split(/\s+/u).filter((term) => term !== '');
  const scored: { item: PaletteItem; score: number; at: number }[] = [];
  candidates.forEach(({ item, words }, at) => {
    const hay = words.map(foldText).join(' ');
    if (!terms.every((term) => hay.includes(term))) return;
    const label = foldText(item.label);
    const score = label.startsWith(folded) ? 0 : label.split(/[\s\p{P}]+/u).some((word) => word.startsWith(terms[0] ?? '')) ? 1 : 2;
    scored.push({ item, score, at });
  });
  return scored.sort((a, b) => a.score - b.score || a.at - b.at).map(({ item }) => item);
}
