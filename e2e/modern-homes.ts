/**
 * MODERN_HOMES: modern-interface.md §7 as data (M12, #313; §1 G2, §15.3). Every Classic surface, action and chord, and the routes
 * that reach its Modern home. e2e/modern-reachability.spec.ts walks every route in Modern, one test each, in Chromium, Firefox and
 * WebKit; e2e/unit/modern-homes.spec.ts checks that the table names every shell action (app/shell-actions.ts), every chord
 * (`KeyAction`, app/keymap.ts) and every row of §7.
 *
 * A route is a list of steps a writer takes, each ending in something they see (`see`). The steps are plain data, read by
 * e2e/modern-walk.ts, so the table reads like §7 and a test can check it without a browser.
 *
 * A route whose home is still being built carries `pending`: the issue that builds it. The walk marks it `test.fixme` with that
 * number, so the branch stays green and the gap stays listed; when the issue lands, the line loses `pending` and the walk holds it.
 * `pending: 313` is a gap no open issue builds: this issue closes it before Modern becomes the default.
 */

/** The issue that builds a home still in flight; 313 is a gap this issue closes. */
export type Pending = 306 | 311 | 312 | 313;

/** How the walk starts: on the projects screen, in a project with nothing in it, or in a project with one scene open. */
export type Setup = 'home' | 'empty' | 'scene';

/**
 * Something on the screen. `role` with `name` (exact unless `pattern` gives a regular expression instead), or a test id, or a CSS
 * selector; `within` narrows it to inside another target.
 */
export interface Target {
  readonly role?: string;
  readonly name?: string;
  readonly pattern?: string;
  readonly testId?: string;
  readonly css?: string;
  readonly within?: Target;
}

export type Step =
  /** Opens **⋯** (the top ornament's More) and runs one of its items; `download` waits for the file it saves. */
  | { readonly more: string; readonly download?: true }
  /** Opens the palette with Ctrl+K (Cmd+K), types `query`, and runs the option whose label is `option` (the query when left out). */
  | { readonly palette: string; readonly option?: string; readonly download?: true }
  /** Opens the palette, types `offers`, and sees an option with that label (and that detail, when given); Escape closes it. */
  | { readonly offers: string; readonly detail?: string }
  /** Opens **⋯** and sees an item named `menuHas`; Escape closes it. */
  | { readonly menuHas: string }
  /** Presses a chord, after clicking `on` (or focusing `focus`) when given, so the chord lands where a writer would be. */
  | { readonly press: string; readonly on?: Target; readonly focus?: Target }
  /** Clicks something; `right` opens its context menu. */
  | { readonly click: Target; readonly right?: boolean }
  /** Types into what has focus. */
  | { readonly type: string }
  /** Shows the binder: Manuscript in the tab bar opens the sidebar on it (#307); nothing when it is open already. */
  | { readonly binder: true }
  /** Sets something up a route needs that no control shows by itself. */
  | { readonly provoke: 'storage-banner' | 'deleted-scene' | 'screenplay' | 'storyboard' | 'dialogue' }
  /** Expects a target: visible (default), focused, or gone. */
  | { readonly see: Target; readonly focused?: boolean; readonly gone?: boolean };

export interface Route {
  /** What the route is, in a few words: the test's title after the row's. */
  readonly via: string;
  readonly steps: readonly Step[];
  readonly pending?: Pending;
  /** Why it is pending, or what is missing, for the fixme's reason. */
  readonly why?: string;
  /** Only in Chromium (a File System Access route). */
  readonly chromiumOnly?: boolean;
}

export interface Home {
  /** A stable id, unique in the table. */
  readonly id: string;
  /** The §7 table the row is in. */
  readonly section: '7.1' | '7.2' | '7.3' | '7.4' | '7.5' | '7.6' | '7.7';
  /** The Classic surface, as §7 names it. */
  readonly classic: string;
  /** Its Modern home, as §7 names it. */
  readonly modern: string;
  /** The shell action (app/shell-actions.ts) the row is, if it is one. */
  readonly action?: string;
  /** The chords (app/keymap.ts `KeyAction`) the row covers. */
  readonly keys?: readonly string[];
  readonly setup: Setup;
  readonly routes: readonly Route[];
}

// ---- Targets used often. ----

const page: Target = { css: '#modern-page' };
const editor: Target = { role: 'textbox', name: 'Document text', within: page };
const projects: Target = { role: 'heading', name: 'Projects in this browser' };
const settings: Target = { testId: 'settings' };
const binderTree: Target = { role: 'tree', name: 'Binder' };
const sceneInfo: Target = { role: 'dialog', name: 'Scene info' };
const agent: Target = { role: 'complementary', name: 'Agent' };
const corkboard: Target = { css: '#modern-page .corkboard' };
const codexOnPage: Target = { role: 'searchbox', name: 'Search the codex', within: page };
const bottom: Target = { role: 'navigation', name: 'Views and tools' };
const titleCapsule: Target = { testId: 'modern-title-capsule' };
const binderBar: Target = { role: 'navigation', name: 'Binder' };
const manuscript: Target = { role: 'button', name: 'Manuscript', within: binderBar };
const panels: Target = { role: 'button', name: 'Panels', within: binderBar };
const sidebar: Target = { testId: 'modern-sidebar' };
const sidebarTab = (name: string): Target => ({ role: 'tab', name, within: sidebar });
/** A sidebar tab that is the chosen one. */
const selectedTab = (name: string): Target => ({ css: '[role="tab"][aria-selected="true"]', pattern: `^${name}`, within: sidebar });
const goals: Target = { role: 'button', name: 'Goals and sprint', within: sidebar };
/** The scene the `scene` setup opens. */
export const SCENE = 'The Landing';
const sceneRow: Target = { css: '.row-title', pattern: `^${SCENE}$` };
/**
 * A row as the keyboard reaches it: focused, not clicked, since a click chooses the scene and choosing one closes an unpinned
 * sidebar (#307), so the chord would land on the page.
 */
const sceneItem: Target = { role: 'treeitem', pattern: `^${SCENE}` };
const chapterItem: Target = { role: 'treeitem', pattern: '^Chapter 1' };

const see = (target: Target, extra: { focused?: boolean; gone?: boolean } = {}): Step => ({ see: target, ...extra });

/** A shell action's routes: **⋯** and the palette (§7.1), each ending at what the action opens. */
function actionRoutes(label: string, opens: Target, extra: readonly Route[] = []): Route[] {
  return [
    { via: `⋯ › ${label}`, steps: [{ more: label }, see(opens)] },
    { via: `palette › ${label}`, steps: [{ palette: label }, see(opens)] },
    ...extra,
  ];
}

export const MODERN_HOMES: readonly Home[] = [
  // ---- §7.1 Shell and toolbar ----
  { id: 'projects', section: '7.1', action: 'projects', classic: 'Projects (toolbar)', modern: '⋯ › Projects; palette', setup: 'scene', routes: actionRoutes('Projects', projects) },
  {
    id: 'details',
    section: '7.1',
    action: 'details',
    classic: 'Project name → Project details (title, author, language, ISBN, cover)',
    modern: '⋯ › Project details; palette; the project line in Scene info',
    setup: 'scene',
    routes: actionRoutes('Project details', { role: 'dialog', name: 'Project' }, [
      {
        via: 'Scene info › the project’s name',
        steps: [{ palette: 'Scene info' }, { click: { role: 'button', pattern: 'Gate Book', within: sceneInfo } }, see({ role: 'dialog', name: 'Project' })],
        pending: 313,
        why: 'Scene info has no project line that links to Project details (§7.1)',
      },
    ]),
  },
  {
    id: 'undo',
    section: '7.1',
    action: 'undo',
    keys: ['undo'],
    classic: 'Undo (toolbar, with its label as title)',
    modern: '⋯ › Undo, with the same label; Ctrl+Z; palette',
    setup: 'scene',
    routes: [
      { via: '⋯ › Undo brings a deleted scene back', steps: [{ provoke: 'deleted-scene' }, { more: 'Undo' }, { binder: true }, see({ ...sceneRow })] },
      { via: 'palette › Undo brings it back', steps: [{ provoke: 'deleted-scene' }, { palette: 'Undo' }, { binder: true }, see({ ...sceneRow })] },
      {
        via: 'Ctrl+Z on the binder brings it back',
        steps: [{ provoke: 'deleted-scene' }, { binder: true }, { press: 'ControlOrMeta+z', focus: chapterItem }, { binder: true }, see({ ...sceneRow })],
      },
    ],
  },
  {
    id: 'focus',
    section: '7.1',
    action: 'focus',
    keys: ['focus-mode'],
    classic: 'Focus / Ctrl+Shift+F',
    modern: '⋯ › Focus mode; Ctrl+Shift+F; palette; the Leave focus mode capsule (§8.8)',
    setup: 'scene',
    routes: [
      { via: '⋯ › Focus mode', steps: [{ more: 'Focus mode' }, see(manuscript, { gone: true }), { more: 'Leave focus mode' }, see(editor)] },
      { via: 'palette › Focus mode', steps: [{ palette: 'Focus mode' }, see(manuscript, { gone: true }), see(editor)] },
      { via: 'Ctrl+Shift+F in the text', steps: [{ press: 'ControlOrMeta+Shift+F', on: editor }, see(manuscript, { gone: true }), { press: 'ControlOrMeta+Shift+F', on: editor }, see(manuscript)] },
      {
        via: 'the Leave focus mode capsule',
        steps: [{ more: 'Focus mode' }, { click: { role: 'button', name: 'Leave focus mode' } }, see(manuscript)],
        pending: 313,
        why: 'no 44 px Leave focus mode capsule stays at the top in focus mode (§8.8)',
      },
    ],
  },
  { id: 'skills', section: '7.1', action: 'skills', classic: 'Skills', modern: '⋯ › Skills; palette', setup: 'scene', routes: actionRoutes('Skills', { role: 'dialog', name: 'Skills' }) },
  {
    id: 'instructions',
    section: '7.1',
    action: 'instructions',
    classic: 'Instructions',
    modern: '⋯ › Instructions; palette',
    setup: 'scene',
    routes: actionRoutes('Instructions', { role: 'dialog', name: 'Agent instructions' }),
  },
  { id: 'compile', section: '7.1', action: 'compile', classic: 'Compile…', modern: '⋯ › Compile…; palette', setup: 'scene', routes: actionRoutes('Compile…', { role: 'dialog', name: 'Export' }) },
  {
    id: 'bundle',
    section: '7.1',
    action: 'bundle',
    classic: 'Export bundle',
    modern: '⋯ › Export bundle; palette',
    setup: 'scene',
    routes: [
      { via: '⋯ › Export bundle saves the file', steps: [{ more: 'Export bundle', download: true }] },
      { via: 'palette › Export bundle saves the file', steps: [{ palette: 'Export bundle', download: true }] },
    ],
  },
  {
    id: 'folder',
    section: '7.1',
    action: 'folder',
    classic: 'Save to folder (Chromium)',
    modern: '⋯ › Save to folder; palette',
    setup: 'scene',
    routes: [
      { via: '⋯ offers Save to folder', steps: [{ menuHas: 'Save to folder' }], chromiumOnly: true },
      { via: 'the palette offers Save to folder', steps: [{ offers: 'Save to folder' }], chromiumOnly: true },
    ],
  },
  {
    id: 'settings',
    section: '7.1',
    action: 'settings',
    classic: 'Settings',
    modern: '⋯ › Settings; palette (each section by name)',
    setup: 'scene',
    routes: actionRoutes('Settings', settings, [
      {
        via: 'palette › each of the nine sections by name',
        steps: ['Providers', 'Context', 'Agent', 'Macros', 'Writing', 'Coherence', 'MCP & tools', 'Appearance', 'Data'].map((section): Step => ({ offers: section, detail: 'Settings' })),
      },
    ]),
  },
  {
    id: 'theme',
    section: '7.1',
    action: 'theme',
    classic: 'Theme toggle',
    modern: '⋯ › Appearance: Light / Dark, Reduce transparency, Interface; palette',
    setup: 'scene',
    routes: [
      { via: 'palette › Dark theme', steps: [{ palette: 'Dark theme' }, see({ css: "html[data-theme='dark']" })] },
      {
        via: '⋯ › Appearance › Dark',
        steps: [{ more: 'Dark' }, see({ css: "html[data-theme='dark']" })],
      },
      {
        via: '⋯ › Appearance › Reduce transparency',
        steps: [{ more: 'Reduce transparency' }, see({ css: "html[data-transparency='reduced']" })],
      },
      {
        via: '⋯ › Appearance › the Classic interface',
        steps: [{ more: 'Use the Classic interface' }, see({ css: "html[data-shell='classic']" })],
      },
      { via: 'palette › Switch to the Classic interface', steps: [{ palette: 'Switch to the Classic interface' }, see({ css: "html[data-shell='classic']" })] },
    ],
  },
  {
    id: 'save-state',
    section: '7.1',
    classic: 'Save state (and Export a backup on failure)',
    modern: 'Scene info (state in words); on failure a persistent toast with Export a backup, and a dot on the title capsule',
    setup: 'scene',
    routes: [
      { via: 'Scene info › Progress says it in words', steps: [{ palette: 'Scene info' }, see({ testId: 'scene-info-save-state', within: sceneInfo })] },
      {
        via: 'the title capsule’s ring and dot',
        steps: [see({ testId: 'modern-title-capsule' })],
      },
    ],
  },
  {
    id: 'status-line',
    section: '7.1',
    classic: 'Status line (messages, inline link, Dismiss)',
    modern: 'Toast capsule with the same text, link and Dismiss',
    setup: 'scene',
    routes: [
      {
        via: 'a deletion’s message, with Dismiss',
        steps: [{ provoke: 'deleted-scene' }, see({ role: 'button', name: 'Dismiss', within: { testId: 'modern-notices' } }), { click: { role: 'button', name: 'Dismiss', within: { testId: 'modern-notices' } } }, see({ role: 'status', pattern: 'Deleted', within: { testId: 'modern-notices' } }, { gone: true })],
      },
      { via: 'as a toast at the top centre', steps: [{ provoke: 'deleted-scene' }, see({ testId: 'modern-toast', pattern: 'Deleted' })] },
    ],
  },
  {
    id: 'storage-banner',
    section: '7.1',
    classic: 'Storage banner (Export a backup, Learn why, Dismiss)',
    modern: 'A glass notice above the page with the same words and buttons',
    setup: 'scene',
    routes: [
      {
        via: 'Export a backup, Learn why and Dismiss',
        steps: [
          { provoke: 'storage-banner' },
          see({ role: 'button', name: 'Export a backup', within: { testId: 'storage-banner' } }),
          { click: { role: 'button', name: 'Learn why', within: { testId: 'storage-banner' } } },
          see({ testId: 'storage-banner', pattern: 'Browsers may remove stored data' }),
          { click: { role: 'button', name: 'Dismiss', within: { testId: 'storage-banner' } } },
          see({ testId: 'storage-banner' }, { gone: true }),
        ],
      },
    ],
  },
  {
    id: 'confirms',
    section: '7.1',
    classic: 'Stale-tab notice, folder-save questions, delete confirm, not-empty folder',
    modern: 'Same dialogs, thick glass',
    setup: 'scene',
    routes: [
      { via: 'the delete confirm', steps: [{ binder: true }, { click: { ...sceneRow }, right: true }, { click: { role: 'menuitem', pattern: '^Delete' } }, see({ role: 'dialog', name: `Delete “${SCENE}”?` })] },
      { via: 'the stale-tab notice', steps: [see({ role: 'dialog', name: 'This project is open in another tab' })], pending: 313, why: 'the walk does not yet open a second tab' },
    ],
  },
  {
    id: 'narrow-toolbar',
    section: '7.1',
    classic: 'Narrow toolbar (Binder, Inspector, More)',
    modern: '§13: the compact top ornament, the bottom tab bar, the drawer and sheets',
    setup: 'scene',
    routes: [{ via: 'the narrow Modern layout', steps: [see({ testId: 'modern-narrow' })], pending: 312, why: 'the narrow Modern layout is #312’s' }],
  },

  // ---- §7.2 The rail ----
  {
    id: 'binder',
    section: '7.2',
    keys: ['new-document', 'rename', 'delete', 'move-up', 'move-down', 'move-left', 'move-right', 'reorder-up', 'reorder-down', 'reparent-out', 'reparent-in'],
    classic: 'Binder tab: tree, rename, drag and drop, row menus (new items, media items, status and label pickers, vocabulary, Edit synopsis, agent access, delete), Actions for … buttons',
    modern: 'Sidebar › Binder (same Binder); Edit synopsis opens Scene info on the synopsis',
    setup: 'scene',
    routes: [
      { via: 'the tree', steps: [{ binder: true }, see(binderTree), see({ ...sceneRow })] },
      { via: 'a row’s menu › Edit synopsis opens Scene info on it', steps: [{ binder: true }, { click: { ...sceneRow }, right: true }, { click: { role: 'menuitem', name: 'Edit synopsis' } }, see({ css: '#inspector-synopsis', within: sceneInfo }, { focused: true })] },
      { via: 'F2 renames the row', steps: [{ binder: true }, { press: 'F2', focus: sceneItem }, see({ role: 'textbox', pattern: '^Rename' }, { focused: true }), { press: 'Escape' }, see({ role: 'textbox', pattern: '^Rename' }, { gone: true })] },
      { via: 'Delete asks first', steps: [{ binder: true }, { press: 'Delete', focus: sceneItem }, see({ role: 'dialog', name: `Delete “${SCENE}”?` })] },
      { via: 'Ctrl+N makes a new document', steps: [{ binder: true }, { press: 'ControlOrMeta+n', focus: sceneItem }, see({ role: 'textbox', name: 'Rename Untitled' }, { focused: true })] },
      { via: 'Manuscript in the tab bar opens it', steps: [{ click: manuscript }, see(binderTree)] },
    ],
  },
  {
    id: 'script-import',
    section: '7.2',
    classic: 'Script import actions above the tree',
    modern: 'Sidebar › Binder, above the tree',
    setup: 'scene',
    routes: [{ via: 'the binder’s actions above the tree', steps: [{ binder: true }, see({ role: 'toolbar', name: 'Binder actions' })] }],
  },
  {
    id: 'filter',
    section: '7.2',
    keys: ['focus-filter'],
    classic: 'Binder filter bar and Ctrl+Alt+F',
    modern: 'Sidebar › Binder; Ctrl+Alt+F opens the sidebar and focuses the filter',
    setup: 'scene',
    routes: [
      { via: 'Ctrl+Alt+F from the text', steps: [{ press: 'Control+Alt+F', on: editor }, see({ role: 'searchbox', name: 'Filter the binder by text' }, { focused: true })] },
    ],
  },
  {
    id: 'footer',
    section: '7.2',
    classic: 'Binder footer: saved filters, goals, sprint timer, totals, History, kept words of a stopped tab',
    modern: 'Sidebar › Binder, in the disclosure Goals and sprint; kept words also as a toast',
    setup: 'scene',
    routes: [
      {
        via: 'the Goals and sprint disclosure under the tree',
        steps: [{ binder: true }, { click: goals }, see({ testId: 'binder-footer', within: sidebar }), see({ testId: 'sprint', within: sidebar })],
      },
    ],
  },
  {
    id: 'codex',
    section: '7.2',
    classic: 'Codex tab (list, filters, entry editor, appearances, visual references)',
    modern: 'The Codex view: the page morphs to the codex (same CodexPanel); a mention chip opens it',
    setup: 'scene',
    routes: [
      { via: 'Codex in the bottom ornament', steps: [{ click: { role: 'radio', name: 'Codex', within: bottom } }, see(codexOnPage)] },
      { via: 'palette › Codex', steps: [{ palette: 'Codex', option: 'Codex' }, see(codexOnPage)] },
    ],
  },
  ...(['Activity', 'Trace', 'Findings'] as const).map(
    (tab): Home => ({
      id: tab.toLowerCase(),
      section: '7.2',
      classic: { Activity: 'Activity tab and its export', Trace: 'Trace tab and its export', Findings: 'Findings tab (scan, model review, groups, history, knowledge, dismissal picker), with its count' }[tab],
      modern: `Sidebar › ${tab}`,
      setup: 'scene',
      routes: [
        { via: `palette › ${tab}`, steps: [{ palette: tab, option: tab }, see(selectedTab(tab))] },
        { via: `Panels › ${tab}`, steps: [{ click: panels }, { click: sidebarTab(tab) }, see(selectedTab(tab)), see({ role: 'tabpanel', within: sidebar })] },
        ...(tab === 'Findings'
          ? [
              { via: 'the count on the title capsule’s dot', steps: [see({ testId: 'modern-title-dot' })], pending: 313 as const, why: 'the dot shows only with open findings, and the walk does not yet raise one' },
              {
                via: 'Scene info › Show in Findings',
                steps: [{ palette: 'Scene info' }, see({ role: 'button', name: 'Show in Findings', within: sceneInfo })],
                pending: 313 as const,
                why: 'Scene info does not list the scene’s open findings (§7.2)',
              },
            ]
          : []),
      ],
    }),
  ),

  // ---- §7.3 The centre ----
  {
    id: 'views',
    section: '7.3',
    classic: 'Editor / Corkboard radio',
    modern: 'Write / Board in the bottom ornament (Codex is the third)',
    setup: 'scene',
    routes: [
      { via: 'the centre radios keep their ids', steps: [{ click: { css: '#center-corkboard' } }, see(corkboard), { click: { css: '#center-editor' } }, see(editor)] },
      { via: 'Write and Board by name', steps: [{ click: { role: 'radio', name: 'Board', within: bottom } }, see(corkboard), { click: { role: 'radio', name: 'Write', within: bottom } }, see(editor)] },
      { via: 'palette › Board', steps: [{ palette: 'Board', option: 'Board' }, see(corkboard)] },
    ],
  },
  {
    id: 'editor',
    section: '7.3',
    classic: 'Editor: the scene, its title, the load banner, the empty state (New document, New chapter)',
    modern: 'The page in Write (same EditorPane)',
    setup: 'scene',
    routes: [{ via: 'the scene on the page', steps: [see({ role: 'main', name: 'Gate Book' }), see(editor)] }],
  },
  {
    id: 'editor-empty',
    section: '7.3',
    classic: 'Editor: the empty state (New document, New chapter)',
    modern: 'The page in Write',
    setup: 'empty',
    routes: [{ via: 'the empty manuscript’s button', steps: [{ binder: true }, see({ role: 'button', name: 'Create Chapter 1' })] }],
  },
  {
    id: 'ghost-bar',
    section: '7.3',
    classic: 'Ghost bar (draft preview: apply, discard)',
    modern: 'Same, as a glass capsule pinned inside the page above the bottom ornament',
    setup: 'scene',
    routes: [{ via: 'a draft’s Apply and Discard', steps: [see({ role: 'button', name: 'Apply', within: page })], pending: 313, why: 'the walk does not yet run a demo draft' }],
  },
  {
    id: 'review-bar',
    section: '7.3',
    classic: 'Review bar (Previous, Next, Accept, Reject, Accept all, Reject all)',
    modern: 'Same bar, as a capsule inside the page',
    setup: 'scene',
    routes: [{ via: 'a marked change’s review bar', steps: [see({ role: 'button', name: 'Accept all', within: page })], pending: 313, why: 'the walk does not yet make a marked change' }],
  },
  {
    id: 'target',
    section: '7.3',
    classic: 'Editor footer: word count, daily target quick-set and session ring',
    modern: 'Scene info › Progress (same TargetQuickSet); the ring also on the title capsule',
    setup: 'scene',
    routes: [
      { via: 'Scene info › Progress', steps: [{ palette: 'Scene info' }, see({ testId: 'scene-info-progress', within: sceneInfo })] },
      { via: 'the ring on the title capsule', steps: [see(titleCapsule)] },
    ],
  },
  {
    id: 'corkboard',
    section: '7.3',
    keys: ['select-card', 'open-in-editor', 'open-menu'],
    classic: 'Corkboard (cards, S/M/L zoom, synopsis edit, card menu, keyboard reorder)',
    modern: 'Board view (same Corkboard), the zoom in the top ornament',
    setup: 'scene',
    routes: [
      { via: 'the cards on the page', steps: [{ click: { css: '#center-corkboard' } }, see(corkboard), see({ css: '#modern-page article.card' })] },
      {
        via: 'Shift+F10 opens a card’s menu',
        // The first card on the page: the Board's scope is wherever the writer left it (a reopened project starts at the manuscript).
        steps: [{ click: { css: '#center-corkboard' } }, { press: 'Shift+F10', focus: { css: '#modern-page article.card' } }, see({ role: 'menu', pattern: '^Actions for ' })],
      },
      { via: 'the zoom on the Board’s page, meanwhile', steps: [{ click: { role: 'radio', name: 'Board', within: bottom } }, see({ role: 'radio', pattern: '^S: Small cards', within: page })] },
      { via: 'the zoom in the top ornament', steps: [{ click: { role: 'radio', name: 'Board', within: bottom } }, see({ role: 'radiogroup', pattern: 'zoom|Zoom', within: { testId: 'modern-top-ornament' } })], pending: 306, why: '#306 landed without the Board’s zoom in the top ornament (§7.3); it is still to be placed' },
    ],
  },
  {
    id: 'screenplay',
    section: '7.3',
    classic: 'Screenplay scene (Script / Source / Pages, element menu, preview, chords)',
    modern: 'Write view (same ScreenplayView), its mode switch in the page header',
    setup: 'scene',
    routes: [{ via: 'a screenplay scene on the page', steps: [{ provoke: 'screenplay' }, see({ role: 'region', name: 'Screenplay: Untitled scene', within: page })] }],
  },
  {
    id: 'storyboard',
    section: '7.3',
    classic: 'Storyboard (shot board, coverage, lightbox, prompt packs, zoom)',
    modern: 'Board view when a storyboard is selected (same StoryboardView)',
    setup: 'scene',
    routes: [{ via: 'a storyboard on the page', steps: [{ provoke: 'storyboard' }, see({ role: 'region', pattern: '^Storyboard: ', within: page })] }],
  },
  {
    id: 'dialogue',
    section: '7.3',
    classic: 'Dialogue container (graph, Ink text, Ink gate)',
    modern: 'Write view (same DialogueView)',
    setup: 'scene',
    routes: [{ via: 'a dialogue on the page', steps: [{ provoke: 'dialogue' }, see({ role: 'region', name: 'Dialogue: Untitled dialogue', within: page })] }],
  },
  {
    id: 'open-on-desktop',
    section: '7.3',
    classic: '"Open on desktop" notices',
    modern: '§13',
    setup: 'scene',
    routes: [{ via: 'Board on a phone', steps: [see({ testId: 'modern-narrow' })], pending: 312, why: 'the narrow Modern layout is #312’s' }],
  },

  // ---- §7.4 The agent drawer ----
  {
    id: 'agent-header',
    section: '7.4',
    keys: ['agent-toggle', 'agent-stop'],
    classic: "Header: the panel's title, Mode radio group, Stop, open and close",
    modern: 'Companion window header: Agent, Mode, Stop, Close',
    setup: 'scene',
    routes: [
      { via: 'Ctrl+J from the text', steps: [{ press: 'ControlOrMeta+j', on: editor }, see(agent), see({ role: 'group', name: 'Mode', within: agent }), see({ testId: 'agent-close', within: agent })] },
      { via: 'palette › Ask the agent', steps: [{ palette: 'Ask the agent' }, see(agent)] },
      { via: 'Ask in the bottom ornament', steps: [{ click: { role: 'button', name: 'Ask', within: bottom } }, see(agent)] },
    ],
  },
  {
    id: 'agent-composer',
    section: '7.4',
    keys: ['agent-send', 'agent-steer'],
    classic: 'Intent box, slash list, @, Enter / Ctrl+Enter / Esc',
    modern: 'Window footer (same CommandComposer and keys)',
    setup: 'scene',
    routes: [
      {
        via: 'the Intent box and its slash list',
        steps: [{ press: 'ControlOrMeta+j', on: editor }, { click: { role: 'combobox', name: 'Intent', within: agent } }, { type: '/' }, see({ role: 'listbox', within: agent })],
      },
    ],
  },
  {
    id: 'agent-body',
    section: '7.4',
    classic: 'Demo intents, turns, status cards, plan and plan-offer cards, task checklist, ask-backs, findings, held plan, report, turn menu (restore, rewind), turn review, Save as macro…, queue, notes sent during a turn, background tasks, interrupted runs, task offers, recurring tasks, skills note, command notes',
    modern: 'Window body, in order (same components)',
    setup: 'scene',
    routes: [{ via: 'the panel in the window', steps: [{ press: 'ControlOrMeta+j', on: editor }, see({ testId: 'agent-panel', within: agent })] }],
  },

  // ---- §7.5 The inspector ----
  {
    id: 'inspector-first',
    section: '7.5',
    classic: 'Title, synopsis (#inspector-synopsis), status and label, keywords',
    modern: 'Scene info, first section (same ids)',
    setup: 'scene',
    routes: [
      { via: 'palette › Scene info', steps: [{ palette: 'Scene info' }, see({ css: '#inspector-synopsis', within: sceneInfo }), see({ role: 'heading', name: SCENE, within: sceneInfo })] },
      { via: 'the title capsule', steps: [{ click: titleCapsule }, see(sceneInfo)] },
    ],
  },
  {
    id: 'inspector-notes',
    section: '7.5',
    classic: 'Notes',
    modern: 'Scene info › Notes disclosure',
    setup: 'scene',
    routes: [{ via: 'Scene info › Notes', steps: [{ palette: 'Scene info' }, see({ testId: 'inspector-notes-disclosure', within: sceneInfo })] }],
  },
  {
    id: 'inspector-story',
    section: '7.5',
    classic: 'Export style, codex attachments and mention chips, scene declarations (POV, day, duration, after, expected present, timeline mode, threads, knowledge), dialogue container, story part, goals, dialogue meta',
    modern: 'Scene info › Story details disclosure (same InspectorSections)',
    setup: 'scene',
    routes: [{ via: 'Scene info › Story details', steps: [{ palette: 'Scene info' }, see({ testId: 'inspector-story-disclosure', within: sceneInfo })] }],
  },
  {
    id: 'inspector-empty',
    section: '7.5',
    classic: 'Empty state and its demo intents',
    modern: 'Scene info when nothing is selected',
    setup: 'empty',
    routes: [{ via: 'palette › Scene info with nothing selected', steps: [{ palette: 'Scene info' }, see(sceneInfo)] }],
  },

  // ---- §7.6 Dialogs, Settings, Home ----
  {
    id: 'dialogs',
    section: '7.6',
    classic: 'Export (recipes, preview, proof), Project, Skills, Instructions and memory, Vocabulary, Save as macro, Encoding review, Recovery, Twee import, Ink gate, every Confirm and Choice dialog, context menus',
    modern: 'Same components; container and menu styles from the material layer',
    setup: 'scene',
    routes: [
      { via: 'a row’s context menu', steps: [{ binder: true }, { click: { ...sceneRow }, right: true }, see({ role: 'menu', name: `Actions for ${SCENE}` })] },
      { via: 'Project, from ⋯', steps: [{ more: 'Project details' }, see({ role: 'dialog', name: 'Project' })] },
      { via: 'Export, from the palette', steps: [{ palette: 'Compile…' }, see({ css: 'dialog.export-dialog' })] },
    ],
  },
  {
    id: 'settings-sections',
    section: '7.6',
    classic: 'Settings, all nine sections',
    modern: 'Same; Appearance gains Interface, Reduce transparency and Reduce motion',
    setup: 'scene',
    routes: [
      {
        via: 'Appearance › Interface and the two Modern switches',
        steps: [
          { palette: 'Appearance', option: 'Appearance' },
          see({ role: 'group', name: 'Interface', within: settings }),
          see({ role: 'checkbox', name: 'Reduce transparency', within: settings }),
          see({ role: 'checkbox', name: 'Reduce motion', within: settings }),
        ],
      },
    ],
  },
  {
    id: 'home',
    section: '7.6',
    classic: 'Home: new project, the leave suggestion, projects list (open, rename, remove), bring a project in, first-run card, Settings',
    modern: 'Same Home on the wallpaper',
    setup: 'home',
    routes: [
      { via: 'the projects screen in Modern', steps: [see(projects), see({ role: 'button', name: 'Create project' }), see({ role: 'button', name: 'Settings' })] },
      { via: 'Home in Modern’s frame', steps: [see({ css: "html[data-shell='modern'] .home" })] },
    ],
  },

  // ---- §7.7 Keys ----
  {
    id: 'keys-modern',
    section: '7.7',
    keys: ['palette', 'escape'],
    classic: 'Every chord of ui-modules §2.5 and §5.6, and the screenplay chords',
    modern: 'Unchanged; Ctrl+K and Ctrl+J added (§8.11)',
    setup: 'scene',
    routes: [
      { via: 'Search in the bottom ornament opens the palette', steps: [{ click: { role: 'button', name: 'Search', within: bottom } }, see({ role: 'dialog', name: 'Search and commands' })] },
      { via: 'Ctrl+K opens the palette, Escape closes it', steps: [{ press: 'ControlOrMeta+k', on: editor }, see({ role: 'dialog', name: 'Search and commands' }), { press: 'Escape' }, see({ role: 'dialog', name: 'Search and commands' }, { gone: true })] },
      {
        via: 'Ctrl+Shift+Y in a screenplay opens Scene info on the synopsis',
        steps: [{ provoke: 'screenplay' }, { click: { role: 'radio', name: 'Source', within: page } }, { press: 'Control+Shift+KeyY', on: { role: 'textbox', name: 'Fountain source' } }, see({ css: '#inspector-synopsis', within: sceneInfo }, { focused: true })],
      },
      {
        via: 'Ctrl+Shift+S in a screenplay opens the sidebar on its section, in Board',
        steps: [{ provoke: 'screenplay' }, { click: { role: 'radio', name: 'Source', within: page } }, { press: 'Control+Shift+KeyS', on: { role: 'textbox', name: 'Fountain source' } }, see(corkboard), see(selectedTab('Binder')), see({ css: '.binder-tree [role="treeitem"]:focus', within: sidebar })],
      },
    ],
  },
];
