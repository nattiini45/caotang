/**
 * The screenplay view — screenplay.md §3. A screenplay document (one scene, `kind: 'screenplay'`) opens here in place
 * of the prose editor. The Fountain body is the source of truth: the Script tab draws it, and the Source tab edits it
 * as plain text. Both read the one body, and the Source tab writes through the session's autosave, which is the path
 * the editor uses (editor-engine §9), so an edit here is an ordinary `doc.write`.
 */

import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { getBody, getRevision, type TreeNode } from '@caotang/store';

import type { ProjectSession } from '../app/session.js';
import type { RevealRequest } from '../components/EditorPane.js';
import { radioStep } from '../components/radio-keys.js';
import { Menu, useReport, useSession, type MenuAnchor } from '../components/shared.js';
import { LINE_ELEMENT_TYPES, type LineConversion, type LineElementType, type LocatedElement } from './engines.js';
import { useCodexEntries } from './hooks.js';
import { printedOf, saveLineOf, screenplayModelOf, sceneOffset, unwrittenFlushOf, type DialogueBlock, type ScreenplayUnit } from './screenplay-model.js';
import { deriveIntentOf, shotsFolderOf } from './storyboard-model.js';
import { isOwnWrite } from './rebase-model.js';
import { SourceField } from './SourceField.js';
import { fountainSegments } from './source-decor.js';
import { cueCompletion, cueNames, enterAfterCue, enterOnEmptyDialogue, type KeyEdit } from './screenplay-keys.js';
import { ScreenplayPreview } from './ScreenplayPreview.js';
import { ELEMENT_MENU_LABEL, chordAria, chordPlatform, chordRange, elementChord, elementEntries, opensElementMenu, type ElementEntry } from './element-menu.js';

export interface ScreenplayViewProps {
  readonly session: ProjectSession;
  readonly node: TreeNode;
  /** A passage a finding quotes, when it is in this scene (coherence.md §8). The view selects it and then calls `onRevealHandled`. */
  readonly reveal?: RevealRequest | null;
  readonly onRevealHandled?: () => void;
  /** Sends a request to the agent. Absent: the scene does not offer to derive its shots (storyboard.md §4). */
  readonly onAgentIntent?: (intent: string) => void;
}

type Mode = 'script' | 'source' | 'pages';

/** The three views, in the order the radio group has them. */
const MODES: readonly Mode[] = ['script', 'source', 'pages'];

const MODE_LABEL: Readonly<Record<Mode, string>> = {
  script: 'The formatted script, as it reads',
  source: 'The Fountain source, edited as text',
  pages: 'The pages, as they print. A line opens in the Source tab',
};

/** The visible words are the names of the views (WCAG 2.5.3), so a writer who speaks what they see is understood. */
const MODE_NAME: Readonly<Record<Mode, string>> = { script: 'Script', source: 'Source', pages: 'Pages' };

const NOOP = (): void => undefined;

/** The element menu while it is open: where it sits, the text its entries were worked out on, and the entries. */
interface OpenElementMenu {
  readonly anchor: MenuAnchor;
  readonly text: string;
  readonly entries: readonly ElementEntry[];
}

export function ScreenplayView({ session, node, reveal = null, onRevealHandled = NOOP, onAgentIntent }: ScreenplayViewProps): ReactNode {
  useSession(session);
  const report = useReport();
  // The cleanup below runs after the view is gone, so it calls the report it last saw, and the effect does not restart for it.
  const reportRef = useRef(report);
  useEffect(() => {
    reportRef.current = report;
  });
  const docId = node.id;
  const stored = getBody(session.state, docId);
  const revision = getRevision(session.state, docId);
  const [mode, setMode] = useState<Mode>('script');
  const [draft, setDraft] = useState(stored);
  // The body and revision this view last agreed with the store. The effect below tells its own write from a change made
  // underneath it, the way the editor does (EditorPane).
  const [opened] = useState(() => ({ body: stored, revision }));
  const synced = useRef<{ body: string; revision: number }>(opened);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  // The formatted view reads the draft a moment late, so a fast typist never waits on a re-parse.
  const deferred = useDeferredValue(draft);
  const model = useMemo(() => screenplayModelOf(deferred), [deferred]);
  // The caret a key edit leaves. It is put back once the text the edit was computed for is on screen, so the writer lands
  // where the key put them (the same device the Ink view uses for its idle mint).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    const field = sourceRef.current;
    if (at === null || field === null) return;
    pendingCaret.current = null;
    field.setSelectionRange(at, at);
  }, [draft]);
  // The decorations of the Source tab: from the draft as the writer typed it, so a heading turns styled on the keystroke.
  const segments = useMemo(() => fountainSegments(draft), [draft]);
  // The names Tab completes a cue to: the characters cued in this scene, and the codex's characters and their aliases. The codex is read
  // through the hook, so a character renamed or given an alias is offered at once (the array keeps its identity in the store).
  const codex = useCodexEntries(session);
  const completions = useMemo(() => cueNames(model.cues, codex), [model.cues, codex]);

  // Open the document on the session's autosave, at the revision the store holds, and flush it when the view goes. A flush
  // that did not write is named on the status line, because nothing on screen is left to say so.
  useEffect(() => {
    session.autosave.open(docId, opened);
    return () => {
      void session.autosave.flush(docId).then((reports) => {
        const line = unwrittenFlushOf(reports);
        if (line !== null) reportRef.current({ text: line, tone: 'error' });
      });
    };
  }, [session, docId, opened]);

  // A store change that is not this view's own write is an undo, a restore or an agent apply. The view quiets its slot, then
  // re-seeds it with `open` on the body and revision the store holds, so the next write is checked against the store's number. An
  // undo is a write of its own, so it raises that number. The prose editor takes the same change in EditorPane (setContent, then
  // setRevision).
  const rebases = useRef(0);
  useEffect(() => {
    const seen = synced.current;
    if (seen.body === stored && seen.revision === revision) return;
    synced.current = { body: stored, revision };
    if (isOwnWrite(session.lastWritten(docId), stored, revision)) return;
    const turn = ++rebases.current;
    void session.autosave.flush(docId).then(() => {
      // A later store change has begun its own rebase, and that one is the one to apply.
      if (turn !== rebases.current) return;
      session.autosave.open(docId, { body: stored, revision });
      setDraft(stored);
    });
  }, [session, docId, stored, revision]);

  const onSourceChange = (text: string): void => {
    setDraft(text);
    session.autosave.noteEdit(docId, text);
  };

  /**
   * The Source tab's keys (screenplay.md §3): Ctrl+E (Cmd+E) opens the element menu, the element chords (Ctrl+Shift+1..9, or
   * Cmd+Alt+1..9 on a Mac) rewrite the caret's line, Enter works after a cue and on empty dialogue, and Tab on a half-typed cue.
   * Any other key with a modifier, or one that is not one of these, keeps its meaning, and so does Enter or Tab with a selection.
   */
  const onSourceKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (opensElementMenu(event)) {
      event.preventDefault();
      openElementMenu();
      return;
    }
    const chosen = elementChord(event.nativeEvent, platform);
    if (chosen !== null) {
      event.preventDefault();
      changeElement(event.currentTarget, chosen);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const field = event.currentTarget;
    if (field.selectionStart !== field.selectionEnd) return;
    const at = field.selectionStart;
    let edit: KeyEdit | null = null;
    if (event.key === 'Enter') edit = enterAfterCue(field.value, at) ?? enterOnEmptyDialogue(field.value, at);
    else if (event.key === 'Tab') edit = cueCompletion(field.value, at, completions);
    if (edit === null) return;
    event.preventDefault();
    // A key that only moves the caret changes no text, so no render follows it: the caret is set here, on the field.
    if (edit.text === field.value) {
      field.setSelectionRange(edit.caret, edit.caret);
      return;
    }
    pendingCaret.current = edit.caret;
    setDraft(edit.text);
    session.autosave.noteEdit(docId, edit.text);
  };

  // The element menu (screenplay.md §3, the element palette): it rewrites the caret's line as the element chosen. It opens from
  // the Element button and from Ctrl+E (Cmd+E) in the source, below the button either way. With a selection, the line is the
  // one where the selection starts.
  const [elementMenu, setElementMenu] = useState<OpenElementMenu | null>(null);
  const elementButtonRef = useRef<HTMLButtonElement>(null);
  // The chord family the platform has (element-menu.ts), which the menu and the Element button name.
  const [platform] = useState(() => chordPlatform(typeof navigator === 'undefined' ? undefined : navigator));

  const openElementMenu = (): void => {
    const field = sourceRef.current;
    if (field === null) return;
    const rect = (elementButtonRef.current ?? field).getBoundingClientRect();
    setElementMenu({
      anchor: { x: rect.left, y: rect.bottom + 4 },
      text: field.value,
      entries: elementEntries(field.value, field.selectionStart, platform),
    });
  };

  // The one place a conversion reaches the draft, for the menu and for the chords: the same edit, autosave note and caret.
  const applyConversion = (field: HTMLTextAreaElement, edit: LineConversion): void => {
    if (edit.text !== field.value) {
      setDraft(edit.text);
      session.autosave.noteEdit(docId, edit.text);
    }
    // The menu hands focus back to the control that opened it as it closes, so the caret is placed on the next frame, after it.
    requestAnimationFrame(() => {
      const target = sourceRef.current;
      if (target === null) return;
      target.focus();
      target.setSelectionRange(edit.caret, edit.caret);
    });
  };

  const chooseElement = (entry: ElementEntry): void => {
    const field = sourceRef.current;
    const edit = entry.edit;
    // A text that changed under the open menu (an undo, a restore, an agent apply) is not the one the edit was worked out on.
    if (field === null || edit === null || elementMenu === null || field.value !== elementMenu.text) return;
    applyConversion(field, edit);
  };

  // An element chord. A line that already is the element is left as it is, and one that cannot be it says so on the status line.
  const changeElement = (field: HTMLTextAreaElement, type: LineElementType): void => {
    const entry = elementEntries(field.value, field.selectionStart).find((candidate) => candidate.type === type);
    if (entry === undefined || entry.checked) return;
    if (entry.edit === null) {
      report({ text: `This line cannot be ${entry.label.toLowerCase()} here.`, tone: 'info' });
      return;
    }
    applyConversion(field, entry.edit);
  };

  /** The Source tab with the caret at this offset of the draft, scrolled to where the caret is. */
  const showSourceAt = (from: number): void => {
    setMode('source');
    // The source tab mounts on this render, so the caret is placed on the next frame.
    requestAnimationFrame(() => {
      const field = sourceRef.current;
      if (field === null) return;
      field.focus();
      const at = Math.min(from, field.value.length);
      field.setSelectionRange(at, at);
      const top = caretTop(field, at);
      if (top !== null) field.scrollTop = Math.max(0, top - field.clientHeight / 3);
    });
  };

  const jumpToScene = (index: number): void => {
    const from = sceneOffset(model, index);
    if (from !== null) showSourceAt(from);
  };

  // A passage a finding quotes, in this scene (coherence.md §8), is shown on the Source tab. The tab is switched while this render runs, so
  // its field is on screen when the layout effect below selects the passage and answers the request.
  const revealHere = reveal !== null && reveal.docId === docId ? reveal : null;
  if (revealHere !== null && mode !== 'source') setMode('source');
  useLayoutEffect(() => {
    if (revealHere === null || mode !== 'source') return;
    const field = sourceRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(revealHere.from, revealHere.to);
    onRevealHandled();
  }, [revealHere, mode, onRevealHandled]);

  /** The arrow keys move the choice and the focus with it, as the centre switch does (the WAI-ARIA radio pattern). */
  const onModeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = radioStep(MODES, mode, event.key);
    if (next === null) return;
    event.preventDefault();
    setMode(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };

  // The storyboard folder this scene's shots live in, when one exists (the derive action is offered only while it does not).
  const shotsFolder = shotsFolderOf(session.state, node);

  const { readout } = model;
  // The footer reads the same status the prose editor's footer reads, and re-renders on each autosave event through useSession.
  const save = session.autosave.status(docId);

  return (
    <section className="media-view sp-view" aria-label={`Screenplay: ${node.title}`}>
      <header className="media-head">
        <div>
          <p className="eyebrow">Screenplay scene</p>
          <h2 className="media-title">{node.title}</h2>
        </div>
        <div className="media-controls">
          <p className="chip sp-readout-chip" title="One page is about one minute of screen time. An estimate, not a timing.">
            {pagesLabel(readout.pages)} · about {readout.minutes} min
          </p>
          <div role="radiogroup" aria-label="View of the scene" className="segmented" onKeyDown={onModeKey}>
            {MODES.map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                data-mode={item}
                aria-checked={mode === item}
                tabIndex={mode === item ? 0 : -1}
                title={MODE_LABEL[item]}
                className="segmented-item"
                onClick={() => setMode(item)}
              >
                {MODE_NAME[item]}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="sp-layout">
        <div className="sp-main">
          {mode === 'script' ? (
            <article className="sp-page" aria-label="Formatted script">
              {model.titlePage === null ? null : <TitlePage entries={model.titlePage} />}
              {model.units.length === 0 ? (
                <p className="muted">This scene is empty. Switch to Source and write its heading, which starts with INT. or EXT.</p>
              ) : (
                model.units.map((unit) => <UnitView key={keyOf(unit)} unit={unit} />)
              )}
            </article>
          ) : mode === 'pages' ? (
            <ScreenplayPreview source={deferred} title={node.title} onOpenSource={(range) => showSourceAt(range.from)} />
          ) : (
            <div className="sp-source-pane">
              <div className="sp-source-bar">
                <button
                  ref={elementButtonRef}
                  type="button"
                  className="button is-quiet"
                  aria-haspopup="menu"
                  aria-expanded={elementMenu !== null}
                  aria-keyshortcuts={`Control+E Meta+E ${LINE_ELEMENT_TYPES.map((type) => chordAria(type, platform)).join(' ')}`}
                  title={`Change the element of the line the caret is on (Ctrl+E, or Cmd+E on a Mac). ${chordRange(platform)} chooses one directly.`}
                  onClick={openElementMenu}
                >
                  Element
                </button>
              </div>
              <SourceField
                label="Fountain source"
                inputRef={sourceRef}
                inputClassName="sp-source"
                value={draft}
                segments={segments}
                onChange={onSourceChange}
                onKeyDown={onSourceKeyDown}
              />
              {elementMenu === null ? null : (
                <Menu
                  label={ELEMENT_MENU_LABEL}
                  anchor={elementMenu.anchor}
                  items={elementMenu.entries.map((entry) => ({
                    key: entry.type,
                    label: entry.label,
                    shortcut: entry.shortcut,
                    chord: entry.chord,
                    checked: entry.checked,
                    disabled: entry.edit === null,
                    onSelect: () => chooseElement(entry),
                  }))}
                  onClose={() => setElementMenu(null)}
                />
              )}
            </div>
          )}
        </div>

        <aside className="sp-side" aria-label="Scene navigator and checks">
          <dl className="sp-readout">
            <div>
              <dt>Pages</dt>
              <dd>{readout.pages}</dd>
            </div>
            <div>
              <dt>Scene headings</dt>
              <dd>{readout.scenes}</dd>
            </div>
            <div>
              <dt>Characters cued</dt>
              <dd>{readout.characters}</dd>
            </div>
          </dl>

          <section className="inspector-section">
            <h3 className="field-label">Scenes in this document</h3>
            {model.scenes.length === 0 ? (
              <p className="muted">No scene heading yet. A heading starts with INT. or EXT.</p>
            ) : (
              <ol className="sp-scenes">
                {model.scenes.map((scene) => (
                  <li key={scene.index}>
                    <button type="button" className="sp-scene-link" onClick={() => jumpToScene(scene.index)}>
                      {scene.heading}
                      {scene.sceneNumber === null ? null : <span className="sp-scene-number"> #{scene.sceneNumber}</span>}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="inspector-section">
            <h3 className="field-label">Characters</h3>
            {model.cues.length === 0 ? (
              <p className="muted">No character is cued yet.</p>
            ) : (
              <ul className="keyword-list" aria-label="Characters cued in this scene">
                {model.cues.map((name) => (
                  <li key={name} className="chip chip-label">
                    {name}
                  </li>
                ))}
              </ul>
            )}
            {model.spellingGroups.map((group) => (
              <p key={group.key} className="field-note">
                {group.spellings.map((spelling) => `“${spelling}”`).join(' and ')} are cued as one character. Use one spelling.
              </p>
            ))}
          </section>

          {/* The shots of this scene. Derive makes its storyboard folder, so it is offered only while the scene has none (storyboard.md §2.1). */}
          {shotsFolder !== undefined ? (
            <section className="inspector-section" aria-label="Shots of this scene">
              <h3 className="field-label">Shots</h3>
              <p className="muted">Its shots are in “{shotsFolder.title}”.</p>
            </section>
          ) : onAgentIntent === undefined ? null : (
            <section className="inspector-section" aria-label="Shots of this scene">
              <h3 className="field-label">Shots</h3>
              <p className="muted">The agent can draft this scene’s shots from its script. They land in a new storyboard named for the scene.</p>
              <button type="button" className="button" onClick={() => onAgentIntent(deriveIntentOf(node))}>
                Derive shots from this scene
              </button>
            </section>
          )}

          {model.notices.length === 0 ? null : (
            <section className="inspector-section">
              <h3 className="field-label">The reader kept these as written</h3>
              <ul className="findings">
                {model.notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>

      <footer className="editor-status" aria-label="Scene status">
        <span className="editor-save" aria-live="polite">
          {saveLineOf(save)}
        </span>
      </footer>
    </section>
  );
}

/**
 * Where the caret at this offset sits in the field, in pixels from the top of its text. A textarea does not scroll to a caret
 * that code sets, so the offset is read from the styled layer under it (SourceField), which wraps the same text the same way.
 */
function caretTop(field: HTMLTextAreaElement, at: number): number | null {
  const layer = field.previousElementSibling;
  if (!(layer instanceof HTMLElement)) return null;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let left = at;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (left > length) {
      left -= length;
      continue;
    }
    const range = document.createRange();
    range.setStart(node, left);
    range.collapse(true);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return rect.top - layer.getBoundingClientRect().top + layer.scrollTop;
  }
  return null;
}

function pagesLabel(pages: number): string {
  return pages === 1 ? '1 page' : `${pages} pages`;
}

function keyOf(unit: ScreenplayUnit): string {
  if (unit.kind === 'element') return `e${unit.element.range.from}`;
  if (unit.kind === 'block') return `b${unit.block.cue.range.from}`;
  return `d${unit.left.cue.range.from}`;
}

function TitlePage({ entries }: { readonly entries: Readonly<Record<string, string>> }): ReactNode {
  return (
    <header className="sp-title-page">
      {Object.entries(entries).map(([key, value]) => (
        <p key={key}>
          <span className="sp-title-key">{key}</span> {value}
        </p>
      ))}
    </header>
  );
}

function UnitView({ unit }: { readonly unit: ScreenplayUnit }): ReactNode {
  if (unit.kind === 'block') return <BlockView block={unit.block} />;
  if (unit.kind === 'dual') {
    return (
      <div className="sp-dual">
        <BlockView block={unit.left} />
        <BlockView block={unit.right} />
      </div>
    );
  }
  return <ElementView element={unit.element} />;
}

function BlockView({ block }: { readonly block: DialogueBlock }): ReactNode {
  return (
    <div className="sp-block">
      <p className="sp-character">{printedOf(block.cue)}</p>
      {block.lines.map((line) => (
        <LineView key={line.range.from} line={line} />
      ))}
    </div>
  );
}

function LineView({ line }: { readonly line: LocatedElement }): ReactNode {
  if (line.type === 'parenthetical') return <p className="sp-parenthetical">{printedOf(line)}</p>;
  return <p className="sp-dialogue">{printedOf(line)}</p>;
}

/** One element that stands alone. Each type has its own class, so the styling is the classification (screenplay.md §3). */
function ElementView({ element }: { readonly element: LocatedElement }): ReactNode {
  switch (element.type) {
    case 'scene_heading':
      return <h3 className="sp-scene">{printedOf(element)}</h3>;
    case 'transition':
      return <p className="sp-transition">{printedOf(element)}</p>;
    case 'centered':
      return <p className="sp-centered">{printedOf(element)}</p>;
    case 'page_break':
      return <hr className="sp-break" aria-label="Page break" />;
    case 'section':
      return <p className="sp-section">{printedOf(element)}</p>;
    default:
      return <p className="sp-action">{printedOf(element)}</p>;
  }
}
