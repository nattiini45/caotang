/**
 * The codex panel — codex.md §8 and codex-panels.md §1–§2, in the left rail's Codex tab.
 *
 * The list groups the entries by type and filters them by a search box and the type and policy
 * chips (codex-panels §2). An entry opens in its editor, where each change is one bus command:
 * `codex.upsert` for the fields (codex.md §7) and `codex.attach` for the attachments (codex.md §5).
 * The panel owns only what the spec says a view owns: the selection, the filter, and drafts a
 * field has not yet committed. Nothing here writes the project.
 *
 * The appearance view (codex-panels §1) lists the documents that mention the entry, in manuscript
 * order, with each count. It is read from the session's mention cache, so it runs no detection of
 * its own, and it follows the text as the text is saved.
 */

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CodexEntry, CodexIncludePolicy, ProjectState, TreeNode } from '@caotang/store';
import { CODEX_INCLUDE_POLICIES, CODEX_TYPES } from '@caotang/store';
import type { CodexUpsertOp, CommandError, ExecutionOutcome, Result } from '@caotang/bus';
import {
  CODEX_ALIASES_MAX,
  CODEX_ALIAS_CHARS_MAX,
  CODEX_DESCRIPTION_MAX,
  CODEX_EXCLUDE_CHARS_MAX,
  CODEX_EXCLUDE_MAX,
  CODEX_VISUAL_REFS_MAX,
} from '@caotang/bus';

import {
  NO_FILTER,
  POLICY_HELP,
  POLICY_LABELS,
  POLICY_ORDER,
  TYPE_LABELS,
  appearancesOf,
  groupByType,
  isFiltered,
  matchesFilter,
  totalsOf,
  uniqueName,
  type CodexFilter,
} from '../app/codex-model.js';
import { childrenOf, isSectionId, nodeById } from '../app/binder-model.js';
import { compileCodex, firstMentionOffsets } from '@caotang/codex';
import { getBody, type ArtifactFs } from '@caotang/store';

import { EMPTY_STATE_INTENTS } from '../app/empty-intents.js';
import { useAssetRecords, useImageUrl } from '../media/hooks.js';
import type { ProjectSession } from '../app/session.js';
import { attachEntry, explain, saveEntry } from './actions.js';
import { KEYWORDS_MAX, KEYWORD_CHARS_MAX } from './Inspector.js';
import { EmptyState, formatCount, useDebouncedText, useReport, useSession } from './shared.js';
import { isImeEnter } from '../app/ime.js';

type Outcome = Result<ExecutionOutcome, CommandError>;

export interface CodexPanelProps {
  readonly session: ProjectSession;
  /**
   * Opens a document in the editor, as the binder does: the appearance view's click-through (codex-panels §1). With an offset,
   * the editor reveals the first hit of the entry in that document.
   */
  readonly onOpenDocument: (docId: string, offset?: number) => void;
  /** Sends a request to the agent through the usual path: the empty codex's seed card (codex.md §8). */
  readonly onAgentIntent: (intent: string) => void;
  /**
   * An entry the shell asked the panel to show: a mention chip in the inspector (codex.md §8). A new `serial` opens the entry
   * again even when it is already the one shown.
   */
  readonly focus?: { readonly entryId: string; readonly serial: number } | null;
}

export function CodexPanel({ session, onOpenDocument, onAgentIntent, focus = null }: CodexPanelProps): ReactNode {
  useSession(session);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A new focus request opens its entry. The serial is the request, so the same entry asked for again opens again. The
  // comparison is made while rendering, so the panel never paints the entry it was not asked to show.
  const [answered, setAnswered] = useState<number | null>(null);
  if (focus !== null && focus.serial !== answered) {
    setAnswered(focus.serial);
    setSelectedId(focus.entryId);
  }
  const entries = session.mentions.entriesOf(session.state);
  const selected = selectedId === null ? undefined : entries.find((entry) => entry.id === selectedId);

  if (selected === undefined) {
    return <CodexList session={session} entries={entries} onOpen={setSelectedId} onAgentIntent={onAgentIntent} />;
  }
  return (
    <CodexEntryEditor
      key={selected.id}
      session={session}
      entry={selected}
      onBack={() => setSelectedId(null)}
      onOpenDocument={onOpenDocument}
    />
  );
}

/* ------------------------------------------------------------------ *
 * The list: search, chips, and the entries by type.
 * ------------------------------------------------------------------ */

function CodexList({
  session,
  entries,
  onOpen,
  onAgentIntent,
}: {
  session: ProjectSession;
  entries: readonly CodexEntry[];
  onOpen: (entryId: string) => void;
  onAgentIntent: (intent: string) => void;
}): ReactNode {
  const report = useReport();
  const [filter, setFilter] = useState<CodexFilter>(NO_FILTER);
  const totals = totalsOf(session.state, session.mentions, entries);
  const visible = entries.filter((entry) => matchesFilter(entry, filter));
  const groups = groupByType(visible, session.state.manifest.project.language);

  const create = (): void => {
    const name = uniqueName(entries, 'Untitled entry');
    const outcome = saveEntry(session, { action: 'create', name, type: 'character' });
    if (!outcome.ok) {
      report({ text: refusal(outcome.error), tone: 'error' });
      return;
    }
    const id = createdEntryId(outcome);
    if (id !== undefined) onOpen(id);
  };

  const toggle = <T extends string>(set: ReadonlySet<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <div className="codex">
      {/* With no entries the empty state below carries the one action, so the toolbar does not repeat it. */}
      {entries.length > 0 ? (
        <div className="codex-toolbar">
          <button type="button" className="button is-primary" onClick={create}>
            New entry
          </button>
        </div>
      ) : null}

      <input
        type="search"
        className="codex-search"
        aria-label="Search the codex"
        placeholder="Search names, aliases and descriptions"
        value={filter.query}
        onChange={(event) => setFilter({ ...filter, query: event.target.value })}
      />

      <div className="codex-chips" role="group" aria-label="Filter by type">
        {CODEX_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className="chip-toggle"
            aria-pressed={filter.types.has(type)}
            onClick={() => setFilter({ ...filter, types: toggle(filter.types, type) })}
          >
            {TYPE_LABELS[type] ?? type}
          </button>
        ))}
      </div>
      <div className="codex-chips" role="group" aria-label="Filter by include policy">
        {POLICY_ORDER.map((policy) => (
          <button
            key={policy}
            type="button"
            className={`chip-toggle is-policy-${policy}`}
            aria-pressed={filter.policies.has(policy)}
            onClick={() => setFilter({ ...filter, policies: toggle(filter.policies, policy) })}
          >
            {POLICY_LABELS[policy]}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title="The codex is empty"
          actions={
            <>
              <button type="button" className="button is-primary" onClick={create}>
                New entry
              </button>
              <button type="button" className="button" onClick={() => onAgentIntent(EMPTY_STATE_INTENTS.codexSeed)}>
                Let the agent draft entries from your manuscript
              </button>
            </>
          }
        >
          Characters, places and lore that recur in the prose are kept here. Their mentions are found as you write.
        </EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState
          title="No entries match"
          actions={
            isFiltered(filter) ? (
              <button type="button" className="button" onClick={() => setFilter(NO_FILTER)}>
                Clear the search and filters
              </button>
            ) : null
          }
        >
          Nothing in the codex matches the search or the chips.
        </EmptyState>
      ) : (
        <section className="codex-groups" aria-label="Codex entries">
          {groups.map((group) => (
            <div key={group.type} className="codex-group">
              <h3 className="codex-group-title">
                {group.label} <span className="codex-group-count">{formatCount(group.entries.length)}</span>
              </h3>
              <ul className="codex-rows">
                {group.entries.map((entry) => {
                  const mentions = totals.get(entry.id) ?? 0;
                  return (
                    <li key={entry.id}>
                      <button type="button" className="codex-row" onClick={() => onOpen(entry.id)}>
                        <span className="codex-row-name">{entry.name}</span>
                        <span className={`codex-row-policy is-${entry.includePolicy}`}>
                          {POLICY_LABELS[entry.includePolicy]}
                        </span>
                        <span className="codex-row-count">{mentionsLabel(mentions)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One entry: its fields, its attachments, and where it appears.
 * ------------------------------------------------------------------ */

function CodexEntryEditor({
  session,
  entry,
  onBack,
  onOpenDocument,
}: {
  session: ProjectSession;
  entry: CodexEntry;
  onBack: () => void;
  onOpenDocument: (docId: string, offset?: number) => void;
}): ReactNode {
  const report = useReport();
  const entries = session.mentions.entriesOf(session.state);
  const appearances = appearancesOf(session.state, entry.id, session.mentions, entries);
  const mentionCount = appearances.reduce((sum, appearance) => sum + appearance.count, 0);

  /** One `codex.upsert` update that names only what it changes. A refusal is said, and the field keeps the stored value. */
  const change = (patch: Omit<CodexUpsertOp, 'action' | 'id'>): boolean => {
    const outcome = saveEntry(session, { action: 'update', id: entry.id, ...patch });
    if (!outcome.ok) {
      report({ text: refusal(outcome.error), tone: 'error' });
      return false;
    }
    return true;
  };

  const attachTo = (nodeId: string): void => {
    const outcome = attachEntry(session, entry.id, [nodeId], []);
    if (!outcome.ok) report({ text: refusal(outcome.error), tone: 'error' });
  };

  const detach = (nodeId: string): void => {
    const outcome = attachEntry(session, entry.id, [], [nodeId]);
    if (!outcome.ok) report({ text: refusal(outcome.error), tone: 'error' });
  };

  return (
    <div className="codex codex-entry">
      <div className="codex-toolbar">
        <button type="button" className="button is-quiet" onClick={onBack}>
          ← All entries
        </button>
      </div>

      <header className="codex-entry-head">
        <p className="eyebrow">
          {TYPE_LABELS[entry.type] ?? entry.type} · {originLabel(entry)}
        </p>
        <h2 className="codex-entry-title">{entry.name}</h2>
      </header>

      <NameField value={entry.name} onCommit={(name) => change({ name })} />

      <section className="inspector-section" aria-label="Type and include policy">
        <label className="field-label" htmlFor={`codex-type-${entry.id}`}>
          Type
        </label>
        <select
          id={`codex-type-${entry.id}`}
          className="codex-select"
          value={entry.type}
          onChange={(event) => change({ type: event.target.value })}
        >
          {CODEX_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type] ?? type}
            </option>
          ))}
        </select>

        <fieldset className="policy">
          <legend className="field-label">Include</legend>
          <div className="policy-options">
            {CODEX_INCLUDE_POLICIES.map((policy: CodexIncludePolicy) => (
              <label key={policy} className={`policy-option${entry.includePolicy === policy ? ' is-chosen' : ''}`}>
                <input
                  type="radio"
                  name={`policy-${entry.id}`}
                  value={policy}
                  checked={entry.includePolicy === policy}
                  onChange={() => change({ includePolicy: policy })}
                />
                {POLICY_LABELS[policy]}
              </label>
            ))}
          </div>
          <p className="field-help">{POLICY_HELP[entry.includePolicy]}</p>
        </fieldset>

        <label className="check">
          <input
            type="checkbox"
            checked={entry.caseSensitive}
            onChange={(event) => change({ caseSensitive: event.target.checked })}
          />
          Match case
        </label>
      </section>

      <ChipField
        label="Aliases"
        items={entry.aliases}
        limit={CODEX_ALIASES_MAX}
        itemLimit={CODEX_ALIAS_CHARS_MAX}
        placeholder="Add an alias and press Enter"
        help="Other names it is called. Matched the way the name is."
        onChange={(aliases) => change({ aliases })}
      />

      <ChipField
        label="Exclude phrases"
        items={entry.exclude}
        limit={CODEX_EXCLUDE_MAX}
        itemLimit={CODEX_EXCLUDE_CHARS_MAX}
        placeholder="Add a phrase and press Enter"
        help="A mention inside one of these phrases is not counted."
        onChange={(exclude) => change({ exclude })}
      />

      <DescriptionField entry={entry} onCommit={(description) => change({ description })} />

      <ChipField
        label="Keywords"
        items={entry.keywords}
        limit={KEYWORDS_MAX}
        itemLimit={KEYWORD_CHARS_MAX}
        placeholder="Add a keyword and press Enter"
        help="For you. Never sent to the model."
        onChange={(keywords) => change({ keywords })}
      />

      <AttachmentsField session={session} entry={entry} onAttach={attachTo} onDetach={detach} />

      <VisualRefsField session={session} entry={entry} onChange={(visualRefs) => change({ visualRefs })} />

      <section className="codex-section" aria-label="Appears in">
        <h3 className="field-label">Appears in</h3>
        {appearances.length === 0 ? (
          <p className="field-help">
            No mentions yet. A mention is found when the name or an alias is written into a scene.
          </p>
        ) : (
          <>
            <p className="field-help">
              {mentionsLabel(mentionCount)} in {formatCount(appearances.length)}{' '}
              {appearances.length === 1 ? 'document' : 'documents'}
            </p>
            <ul className="codex-rows">
              {appearances.map((appearance) => (
                <li key={appearance.docId}>
                  <button
                    type="button"
                    className="codex-row is-appearance"
                    onClick={() => onOpenDocument(appearance.docId, firstMentionIn(session, appearance.docId, entry.id))}
                  >
                    <span className="codex-row-name">{appearance.title}</span>
                    <span className="codex-row-count">{formatCount(appearance.count)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/** The name, committed on Enter or on blur, and reverted when the bus refuses it (a duplicate, a blank). */
function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => boolean }): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commit = (): void => {
    const next = shown.trim();
    if (next !== value) onCommit(next);
    setDraft(null);
  };
  return (
    <section className="inspector-section" aria-label="Name">
      <label className="field-label" htmlFor="codex-name">
        Name
      </label>
      <input
        id="codex-name"
        type="text"
        className="codex-input"
        maxLength={120}
        value={shown}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !isImeEnter(event)) {
            event.preventDefault();
            commit();
          }
        }}
      />
    </section>
  );
}

/** The description, committed 800 ms after the last keystroke, with the 2,000-character counter codex.md §2 names. */
function DescriptionField({
  entry,
  onCommit,
}: {
  entry: CodexEntry;
  onCommit: (description: string) => boolean;
}): ReactNode {
  const field = useDebouncedText(entry.description, onCommit);
  const count = [...field.value].length;
  return (
    <section className="inspector-section" aria-label="Description">
      <label className="field-label" htmlFor="codex-description">
        Description
      </label>
      <textarea
        id="codex-description"
        className="codex-description"
        rows={6}
        maxLength={CODEX_DESCRIPTION_MAX}
        placeholder="What the writer and the model should know about it."
        value={field.value}
        onChange={(event) => field.change(event.target.value)}
        onBlur={field.flush}
      />
      <span className={`counter${count > CODEX_DESCRIPTION_MAX * 0.9 ? ' is-near' : ''}`}>
        {formatCount(count)} / {formatCount(CODEX_DESCRIPTION_MAX)}
      </span>
    </section>
  );
}

/**
 * A list of short strings, edited as chips: Enter adds one, a × removes one. The limits are the bus's
 * (codex.md §2), and a refusal here is said here, before the bus is asked.
 */
function ChipField({
  label,
  items,
  limit,
  itemLimit,
  placeholder,
  help,
  onChange,
}: {
  label: string;
  items: readonly string[];
  limit: number;
  itemLimit: number;
  placeholder: string;
  help: string;
  onChange: (next: string[]) => boolean;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const [complaint, setComplaint] = useState<string | null>(null);
  const id = `chips-${label.replace(/\W+/g, '-').toLowerCase()}`;

  const add = (): void => {
    const value = draft.trim();
    if (value.length === 0) return;
    if ([...value].length > itemLimit) {
      setComplaint(`Keep each one to ${itemLimit} characters.`);
      return;
    }
    if (items.some((existing) => existing.toLowerCase() === value.toLowerCase())) {
      setComplaint(`“${value}” is already here.`);
      return;
    }
    if (items.length >= limit) {
      setComplaint(`Up to ${limit} here. Remove one to add another.`);
      return;
    }
    setComplaint(null);
    if (onChange([...items, value])) setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !isImeEnter(event)) {
      event.preventDefault();
      add();
    }
  };

  return (
    <section className="inspector-section" aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`} className="field-label">
        {label}
      </h3>
      <ul className="keyword-list" aria-label={label}>
        {items.map((item) => (
          <li key={item} className="chip chip-keyword">
            <span>{item}</span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${item} from ${label.toLowerCase()}`}
              onClick={() => onChange(items.filter((existing) => existing !== item))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <input
        type="text"
        className="keyword-input"
        aria-label={`Add to ${label.toLowerCase()}`}
        maxLength={itemLimit}
        disabled={items.length >= limit}
        placeholder={items.length >= limit ? `Up to ${limit} here` : placeholder}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setComplaint(null);
        }}
        onKeyDown={onKeyDown}
      />
      <p className="field-help">{help}</p>
      {complaint ? (
        <p className="field-note is-complaint" role="status">
          {complaint}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The binder nodes the entry is attached to, each removable, and a picker for the rest. Documents and folders
 * only: the two sections are never attached to (codex.md §5 attaches to a document or to a folder).
 */
function AttachmentsField({
  session,
  entry,
  onAttach,
  onDetach,
}: {
  session: ProjectSession;
  entry: CodexEntry;
  onAttach: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}): ReactNode {
  const attached = entry.attachments.map((id) => ({ id, node: nodeById(session.state, id) }));
  const choices = attachable(session.state).filter((node) => !entry.attachments.includes(node.id));
  return (
    <section className="inspector-section" aria-label="Attached to">
      <h3 className="field-label">Attached to</h3>
      {attached.length === 0 ? (
        <p className="field-help">
          Attached to no items yet. A Manual entry is sent only in the items it is attached to (codex.md §5).
        </p>
      ) : (
        <ul className="keyword-list" aria-label="Attachments">
          {attached.map(({ id, node }) => (
            <li key={id} className="chip chip-keyword">
              <span>{node?.title ?? 'A removed item'}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Detach from ${node?.title ?? 'a removed item'}`}
                onClick={() => onDetach(id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {choices.length > 0 ? (
        <>
          <label className="field-label" htmlFor={`attach-${entry.id}`}>
            Attach to a document or folder
          </label>
          <select
            id={`attach-${entry.id}`}
            className="codex-select"
            aria-label="Attach to"
            value=""
            onChange={(event) => {
              if (event.target.value !== '') onAttach(event.target.value);
            }}
          >
            <option value="">Choose…</option>
            {choices.map((node) => (
              <option key={node.id} value={node.id}>
                {node.type === 'folder' ? `${node.title} (folder)` : node.title}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </section>
  );
}

/**
 * The pictures an entry's visual references name (video-prompt-pack.md §3, A5): a picture already in the project, chosen from the
 * ones its storyboard shows, each removable. A reference is kept by id, so a picture that has since gone is named as missing rather
 * than dropped, and the pack says the same. Nothing here uploads a file: the pack names the pictures for the writer to attach.
 */
function VisualRefsField({
  session,
  entry,
  onChange,
}: {
  session: ProjectSession;
  entry: CodexEntry;
  onChange: (visualRefs: string[]) => boolean;
}): ReactNode {
  useSession(session);
  const assets = session.assets.artifactFs();
  // The images are listed when they can have changed, not on every change of the session (media/hooks.ts).
  const records = useAssetRecords(assets, session.assetsVersion());
  const chosen = entry.visualRefs ?? [];
  const choices = [...records.values()].filter((record) => !chosen.includes(record.id));
  return (
    <section className="inspector-section" aria-label="Visual references">
      <h3 className="field-label">Visual references</h3>
      <p className="field-help">
        The prompt pack names these pictures for the scenes this entry appears in, so you can attach them in your video tool. Caotang uploads none of them.
      </p>
      {chosen.length === 0 ? (
        <p className="field-help">None yet.</p>
      ) : (
        <ul className="keyword-list" aria-label="Chosen pictures">
          {chosen.map((id) => {
            const name = records.get(id)?.fileName ?? 'A picture that is no longer in the project';
            return (
              <li key={id} className="chip chip-keyword">
                <RefThumb assets={assets} assetId={id} alt={name} />
                <span>{name}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange(chosen.filter((other) => other !== id))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {choices.length > 0 && chosen.length < CODEX_VISUAL_REFS_MAX ? (
        <>
          <label className="field-label" htmlFor={`visual-ref-${entry.id}`}>
            Add a picture
          </label>
          <select
            id={`visual-ref-${entry.id}`}
            className="codex-select"
            aria-label="Add a picture"
            value=""
            onChange={(event) => {
              if (event.target.value !== '') onChange([...chosen, event.target.value]);
            }}
          >
            <option value="">Choose…</option>
            {choices.map((record) => (
              <option key={record.id} value={record.id}>
                {record.fileName}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </section>
  );
}

/** One chosen picture's thumbnail. A picture that will not load shows an empty frame, and its name beside it says what it is. */
function RefThumb({ assets, assetId, alt }: { assets: ArtifactFs; assetId: string; alt: string }): ReactNode {
  const url = useImageUrl(assets, assetId);
  const size = { width: 24, height: 24, objectFit: 'cover' as const, borderRadius: 3 };
  return url === null ? (
    <span aria-hidden="true" style={{ ...size, display: 'inline-block', background: 'var(--surface-2, #ddd)' }} />
  ) : (
    <img src={url} alt={alt} style={size} />
  );
}

/** Every document and folder in the binder, in binder order: what an entry can be attached to. */
/**
 * The body offset of an entry's first mention in one document (codex-panels §1, `firstOffset`): the point the appearance's click
 * reveals. The same scan the cache counts with, so a click lands on the mention the count is about.
 */
function firstMentionIn(session: ProjectSession, docId: string, entryId: string): number | undefined {
  const entries = session.state.manifest.codex ?? [];
  return firstMentionOffsets(getBody(session.state, docId), compileCodex(entries)).get(entryId);
}

function attachable(state: ProjectState): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (parentId: string): void => {
    for (const node of childrenOf(state, parentId)) {
      if (!isSectionId(node.id) && (node.type === 'document' || node.type === 'folder')) out.push(node);
      visit(node.id);
    }
  };
  visit('root');
  return out;
}

/* ------------------------------------------------------------------ *
 * Small helpers.
 * ------------------------------------------------------------------ */

function mentionsLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'mention' : 'mentions'}`;
}

function originLabel(entry: CodexEntry): string {
  if (entry.origin === 'agent') return 'Drafted by the agent';
  if (entry.origin === 'import') return 'Imported';
  return 'Written by hand';
}

/** The refusal's words for the status line: the first per-op failure when the batch names one. */
function refusal(error: CommandError): string {
  const first = error.details?.failures?.[0];
  return first ? explain({ ...error, message: first.message, correctiveHint: first.correctiveHint }) : explain(error);
}

/** The id `codex.upsert` created, from the digest it returns. `undefined` when the outcome carries none. */
function createdEntryId(outcome: Outcome): string | undefined {
  if (!outcome.ok) return undefined;
  const result = outcome.value.result as { created?: unknown } | null;
  const created = Array.isArray(result?.created) ? result.created : [];
  const first: unknown = created[0];
  return typeof first === 'string' ? first : undefined;
}
