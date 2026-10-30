/**
 * The inspector — ui-modules §4. The selected node's own fields: synopsis, notes,
 * keywords, status and label. A folder shows the same panel without notes (§4.2: "folders
 * carry synopsis + keywords + status/label only"). Nothing is shown with no selection
 * except the empty state (§4.3).
 *
 * The codex section (attach picker and mention chips, codex.md §8) and the scene declarations (SceneMeta, coherence.md §8)
 * are in `InspectorSections.tsx`, shown below the node's own fields.
 */

import { useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { ProjectState, TreeNode } from '@caotang/store';

import { isContainer, nodeById, wordCountOf } from '../app/binder-model.js';
import type { ProjectSession } from '../app/session.js';
import { DEMO_CHOICES } from '../app/demo.js';
import { hasDivider, splitNotes } from '../app/notes-model.js';
import { InspectorGoals } from './InspectorGoals.js';
import { SynopsisField } from './SynopsisField.js';
import { openDialog } from './dialog-requests.js';
import { CodexSection, FolderStoryPartSection, SceneMetaSection, SceneStyleSection } from './InspectorSections.js';
import { DialogueMetaSection } from './InspectorDialogue.js';
import { addKeyword, explain, removeKeyword, setLabel, setNotes, setStatus } from './actions.js';
import {
  EmptyState,
  Menu,
  formatCount,
  useDebouncedText,
  useReport,
  useSession,
  wordsLabel,
  type MenuAnchor,
  type MenuItem,
} from './shared.js';
import { isImeEnter } from '../app/ime.js';

/** ui-modules §4.1 and project-format §2: the limits the inspector enforces before the command does. */
export const NOTES_MAX_CHARS = 50_000;
export const KEYWORDS_MAX = 32;
export const KEYWORD_CHARS_MAX = 64;

export function Inspector({
  session,
  nodeId,
  onOpenCodex,
  onAgentIntent,
}: {
  session: ProjectSession;
  nodeId: string | null;
  /** Shows a codex entry in the codex panel (a mention chip's click). */
  onOpenCodex?: (entryId: string) => void;
  /** Sends a demo request to the agent (ui-modules §4.3): the empty state's three next steps. */
  onAgentIntent?: (intent: string) => void;
}): ReactNode {
  useSession(session);
  const node = nodeId === null ? undefined : nodeById(session.state, nodeId);
  if (node === undefined) {
    return (
      <aside className="inspector is-empty" aria-label="Inspector">
        <EmptyState
          title="Select a document"
          actions={
            onAgentIntent === undefined ? undefined : (
              <div className="demo-choices">
                {DEMO_CHOICES.map((choice) => (
                  <button key={choice.intent} type="button" className="button" onClick={() => onAgentIntent(choice.intent)}>
                    {choice.label}
                  </button>
                ))}
              </div>
            )
          }
        >
          Choose a document in the binder to see and edit its synopsis, notes and keywords.
        </EmptyState>
      </aside>
    );
  }
  // Keyed by node: a debounced field holds a draft, and a draft must never outlive the
  // node it was typed for. Switching selection remounts the fields, so a pending commit
  // is flushed to the node that was edited, and nothing is written to the next one.
  return (
    <aside className="inspector" aria-label="Inspector">
      <InspectorContent key={node.id} session={session} node={node} onOpenCodex={onOpenCodex} />
    </aside>
  );
}

function InspectorContent({
  session,
  node,
  onOpenCodex,
}: {
  session: ProjectSession;
  node: TreeNode;
  onOpenCodex: ((entryId: string) => void) | undefined;
}): ReactNode {
  return (
    <>
      <header className="inspector-head">
        <p className="eyebrow">{node.type === 'document' ? 'Document' : isContainer(node) ? 'Folder' : 'Item'}</p>
        <h2 className="inspector-title">{node.title}</h2>
        <p className="inspector-meta">{metaLine(session.state, node)}</p>
      </header>

      <section className="inspector-section" aria-labelledby="inspector-synopsis-label">
        <h3 id="inspector-synopsis-label" className="field-label">
          Synopsis
        </h3>
        <SynopsisField session={session} nodeId={node.id} variant="inspector" fieldId="inspector-synopsis" />
      </section>

      {node.type === 'document' ? <NotesField session={session} node={node} /> : null}

      <KeywordsField key={node.id} session={session} node={node} />
      {node.type === 'document' ? null : <InspectorGoals session={session} node={node} />}

      <section className="inspector-section" aria-label="Status and label">
        <div className="picker-row">
          <MetaPicker session={session} node={node} kind="status" />
          <MetaPicker session={session} node={node} kind="label" />
        </div>
      </section>

      {node.type === 'document' ? <SceneStyleSection session={session} node={node} /> : null}

      <CodexSection session={session} node={node} onOpenCodex={onOpenCodex} />
      {node.type === 'document' ? <SceneMetaSection session={session} node={node} /> : null}
      {node.type === 'folder' ? <FolderStoryPartSection session={session} node={node} /> : null}
      {node.type === 'dialogue' ? <DialogueMetaSection session={session} node={node} /> : null}
    </>
  );
}

function metaLine(state: ProjectState, node: TreeNode): string {
  if (node.type === 'document') return wordsLabel(wordCountOf(state, node.id));
  const count = state.manifest.tree.filter((child) => child.parentId === node.id).length;
  return count === 1 ? '1 item inside' : `${formatCount(count)} items inside`;
}

function NotesField({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  const report = useReport();
  const field = useDebouncedText(node.notes, (text) => {
    const outcome = setNotes(session, node.id, text);
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return false;
    }
    return true;
  });
  const [editing, setEditing] = useState(false);
  const count = [...field.value].length;
  // ui-modules §4.1: the agent's divider is a separator. Notes that carry one open as a read view with the separators drawn,
  // and the textarea is one button away, so the divider never shows as literal text in the field the writer types in.
  const reading = hasDivider(field.value) && !editing;
  return (
    <section className="inspector-section" aria-labelledby="inspector-notes-label">
      <h3 id="inspector-notes-label" className="field-label">
        Notes
      </h3>
      {reading ? (
        <div className="notes-read" data-testid="notes-read">
          {splitNotes(field.value).map((segment, index) =>
            segment.kind === 'divider' ? (
              <div key={`divider-${index}`} className="notes-divider" role="separator" aria-label={`Agent note, ${segment.date}`}>
                <span>Agent note · {segment.date}</span>
              </div>
            ) : (
              <p key={`run-${index}`} className="notes-run">
                {segment.text}
              </p>
            ),
          )}
          <button type="button" className="button is-quiet" onClick={() => setEditing(true)}>
            Edit notes
          </button>
        </div>
      ) : (
      <textarea
        className="notes"
        aria-label="Notes"
        maxLength={NOTES_MAX_CHARS}
        rows={8}
        placeholder="Notes for this scene. Plain text, kept out of the manuscript."
        value={field.value}
        onChange={(event) => field.change(event.target.value)}
        onBlur={field.flush}
      />
      )}
      <span className={`counter${count > NOTES_MAX_CHARS * 0.9 ? ' is-near' : ''}`}>
        {formatCount(count)} / {formatCount(NOTES_MAX_CHARS)}
      </span>
    </section>
  );
}

function KeywordsField({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  const report = useReport();
  const [draft, setDraft] = useState('');
  const [complaint, setComplaint] = useState<string | null>(null);
  const suggestions = allKeywords(session.state);
  const full = node.keywords.length >= KEYWORDS_MAX;

  const add = (): void => {
    const keyword = draft.trim();
    if (keyword.length === 0) return;
    if (keyword.length > KEYWORD_CHARS_MAX) {
      setComplaint(`A keyword is at most ${KEYWORD_CHARS_MAX} characters.`);
      return;
    }
    if (node.keywords.some((existing) => existing.toLowerCase() === keyword.toLowerCase())) {
      setComplaint(`“${keyword}” is already a keyword here.`);
      return;
    }
    const outcome = addKeyword(session, node.id, keyword);
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    setDraft('');
    setComplaint(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !isImeEnter(event)) {
      event.preventDefault();
      add();
    }
  };

  return (
    <section className="inspector-section" aria-labelledby="inspector-keywords-label">
      <h3 id="inspector-keywords-label" className="field-label">
        Keywords
      </h3>
      <ul className="keyword-list" aria-label="Keywords">
        {node.keywords.map((keyword) => (
          <li key={keyword} className="chip chip-keyword">
            <span>{keyword}</span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove keyword ${keyword}`}
              onClick={() => {
                // A complaint about the keyword list is about the list as it was; removing a keyword changes it, so it goes.
                setComplaint(null);
                const outcome = removeKeyword(session, node.id, keyword);
                if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <input
        type="text"
        className="keyword-input"
        aria-label="Add keyword"
        list="keyword-suggestions"
        maxLength={KEYWORD_CHARS_MAX}
        disabled={full}
        placeholder={full ? `Up to ${KEYWORDS_MAX} keywords` : 'Add a keyword and press Enter'}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setComplaint(null);
        }}
        onKeyDown={onKeyDown}
      />
      <datalist id="keyword-suggestions">
        {suggestions.map((keyword) => (
          <option key={keyword} value={keyword} />
        ))}
      </datalist>
      {complaint ? (
        <p className="field-note" role="status">
          {complaint}
        </p>
      ) : null}
    </section>
  );
}

/** Every keyword any node in the project carries, for the suggestion list (§4.1: "autocomplete from existing keywords in-project"). */
function allKeywords(state: ProjectState): string[] {
  const seen = new Map<string, string>();
  for (const node of state.manifest.tree) {
    for (const keyword of node.keywords) {
      const key = keyword.toLowerCase();
      if (!seen.has(key)) seen.set(key, keyword);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * A status or label chip that opens a picker (ui-modules §2.2: "vocabulary picker").
 * A value the vocabulary no longer lists shows as "Unknown …", never as nothing —
 * project-format §2's tolerant rule keeps the data and says so.
 */
function MetaPicker({
  session,
  node,
  kind,
}: {
  session: ProjectSession;
  node: TreeNode;
  kind: 'status' | 'label';
}): ReactNode {
  const report = useReport();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const vocab = kind === 'status' ? session.state.manifest.vocabulary.statuses : session.state.manifest.vocabulary.labels;
  const current = kind === 'status' ? node.status : node.label;
  const term = current === null ? undefined : vocab.find((entry) => entry.id === current);
  const shown = term?.name ?? (current === null ? (kind === 'status' ? 'No status' : 'No label') : `Unknown ${kind}`);
  const color = term && kind === 'status' ? term.color : undefined;

  const apply = (value: string | null): void => {
    const outcome = kind === 'status' ? setStatus(session, node.id, value) : setLabel(session, node.id, value);
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };

  // "+ Add" opens the vocabulary editor (ui-modules §2.2). With no label yet, it is the only entry.
  const addTerm: MenuItem = {
    key: `${kind}-add`,
    label: kind === 'status' ? '+ Add status…' : '+ Add label…',
    separatorBefore: vocab.length > 0,
    onSelect: () => openDialog({ kind: 'vocabulary', term: kind }),
  };
  const items: MenuItem[] =
    kind === 'label' && vocab.length === 0
      ? [addTerm]
      : [
          ...vocab.map((entry) => ({
            key: `${kind}-${entry.id}`,
            label: entry.name,
            checked: current === entry.id,
            onSelect: () => apply(entry.id),
          })),
          {
            key: `${kind}-none`,
            label: kind === 'status' ? 'No status' : 'No label',
            checked: current === null,
            separatorBefore: true,
            onSelect: () => apply(null),
          },
          addTerm,
        ];

  return (
    <div className="picker">
      <span className="field-label">{kind === 'status' ? 'Status' : 'Label'}</span>
      <button
        type="button"
        className="picker-button"
        aria-haspopup="menu"
        aria-label={`${kind === 'status' ? 'Status' : 'Label'}: ${shown}. Change ${kind}`}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        {color ? <span className="chip-dot" style={{ background: color }} aria-hidden="true" /> : null}
        {shown}
      </button>
      {anchor ? (
        <Menu label={kind === 'status' ? 'Status' : 'Label'} anchor={anchor} items={items} onClose={() => setAnchor(null)} />
      ) : null}
    </div>
  );
}
