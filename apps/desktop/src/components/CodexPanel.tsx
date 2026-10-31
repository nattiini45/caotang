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

import { accessibleText } from '../i18n/accessible-text.js';
import { defaultTitleOf, isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
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

import { isImeEnter } from '../app/keymap.js';
import {
  NO_FILTER,
  POLICY_ORDER,
  TYPE_LABELS,
  appearancesOf,
  groupByType,
  isFiltered,
  matchesFilter,
  policyHelp,
  policyLabel,
  totalsOf,
  uniqueName,
  type CodexFilter,
} from '../app/codex-model.js';
import { childrenOf, isSectionId, nodeById } from '../app/binder-model.js';
import { compileCodex, firstMentionOffsets } from '@caotang/codex';
import { getBody, type ArtifactFs } from '@caotang/store';

import { EMPTY_STATE_INTENTS } from '../app/empty-intents.js';
import { useAssetRecords, useImageUrl } from '../media/hooks.js';
import { pickerLabelOf } from '../media/picture-board-model.js';
import type { ProjectSession } from '../app/session.js';
import { attachEntry, explain, saveEntry } from './actions.js';
import { KEYWORDS_MAX, KEYWORD_CHARS_MAX } from './Inspector.js';
import { EmptyState, formatCount, useDebouncedText, useReport, useSession } from './shared.js';


/* lingui-set comment="The codex. Interpolated values: item, name, title and value are the writer's own text; field names a field; limit and itemLimit are counts; mentions and documents are counts grouped for the formatter locale." */
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
  useLingui();
  const report = useReport();
  const [filter, setFilter] = useState<CodexFilter>(NO_FILTER);
  const totals = totalsOf(session.state, session.mentions, entries);
  const visible = entries.filter((entry) => matchesFilter(entry, filter));
  const groups = groupByType(visible, session.state.manifest.project.language);
  const contentLang = session.state.manifest.project.language;

  const create = (): void => {
    const name = uniqueName(entries, defaultTitleOf('entry', session.state.manifest.project.language));
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
            <Trans>New entry</Trans>
          </button>
        </div>
      ) : null}

      <input
        type="search"
        className="codex-search"
        aria-label={t`Search the codex`}
        placeholder={t`Search names, aliases and descriptions`}
        value={filter.query}
        onChange={(event) => setFilter({ ...filter, query: event.target.value })}
      />

      <div className="codex-chips" role="group" aria-label={t`Filter by type`}>
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
      <div className="codex-chips" role="group" aria-label={t`Filter by include policy`}>
        {POLICY_ORDER.map((policy) => (
          <button
            key={policy}
            type="button"
            className={`chip-toggle is-policy-${policy}`}
            aria-pressed={filter.policies.has(policy)}
            onClick={() => setFilter({ ...filter, policies: toggle(filter.policies, policy) })}
          >
            {policyLabel(policy)}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title={t`The codex is empty`}
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
          <Trans>Characters, places and lore that recur in the prose are kept here. Their mentions are found as you write.</Trans>
        </EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState
          title={t`No entries match`}
          actions={
            isFiltered(filter) ? (
              <button type="button" className="button" onClick={() => setFilter(NO_FILTER)}>
                Clear the search and filters
              </button>
            ) : null
          }
        >
          <Trans>Nothing in the codex matches the search or the chips.</Trans>
        </EmptyState>
      ) : (
        <section className="codex-groups" aria-label={t`Codex entries`}>
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
                        <span className="codex-row-name" lang={contentLang} dir="auto">{entry.name}</span>
                        <span className={`codex-row-policy is-${entry.includePolicy}`}>
                          {policyLabel(entry.includePolicy)}
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
  useLingui();
  const report = useReport();
  const entries = session.mentions.entriesOf(session.state);
  const appearances = appearancesOf(session.state, entry.id, session.mentions, entries);
  const mentionCount = appearances.reduce((sum, appearance) => sum + appearance.count, 0);
  const contentLang = session.state.manifest.project.language;

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
          <Trans>← All entries</Trans>
        </button>
      </div>

      <header className="codex-entry-head">
        <p className="eyebrow">
          {TYPE_LABELS[entry.type] ?? entry.type} · {originLabel(entry)}
        </p>
        <h2 className="codex-entry-title" lang={contentLang} dir="auto">{entry.name}</h2>
      </header>

      <NameField value={entry.name} onCommit={(name) => change({ name })} />

      <section className="inspector-section" aria-label={t`Type and include policy`}>
        <label className="field-label" htmlFor={`codex-type-${entry.id}`}>
          <Trans>Type</Trans>
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
          <legend className="field-label"><Trans>Include</Trans></legend>
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
                {policyLabel(policy)}
              </label>
            ))}
          </div>
          <p className="field-help">{policyHelp(entry.includePolicy)}</p>
        </fieldset>

        <label className="check">
          <input
            type="checkbox"
            checked={entry.caseSensitive}
            onChange={(event) => change({ caseSensitive: event.target.checked })}
          />
          <Trans>Match case</Trans>
        </label>
      </section>

      <ChipField
        label={t`Aliases`}
        items={entry.aliases}
        limit={CODEX_ALIASES_MAX}
        itemLimit={CODEX_ALIAS_CHARS_MAX}
        placeholder={t`Add an alias and press Enter`}
        help={t`Other names it is called. Matched the way the name is.`}
        onChange={(aliases) => change({ aliases })}
      />

      <ChipField
        label={t`Exclude phrases`}
        items={entry.exclude}
        limit={CODEX_EXCLUDE_MAX}
        itemLimit={CODEX_EXCLUDE_CHARS_MAX}
        placeholder={t`Add a phrase and press Enter`}
        help={t`A mention inside one of these phrases is not counted.`}
        onChange={(exclude) => change({ exclude })}
      />

      <DescriptionField entry={entry} onCommit={(description) => change({ description })} />

      <ChipField
        label={t`Keywords`}
        items={entry.keywords}
        limit={KEYWORDS_MAX}
        itemLimit={KEYWORD_CHARS_MAX}
        placeholder={t`Add a keyword and press Enter`}
        help={t`For you. Never sent to the model.`}
        onChange={(keywords) => change({ keywords })}
      />

      <AttachmentsField session={session} entry={entry} onAttach={attachTo} onDetach={detach} />

      <VisualRefsField session={session} entry={entry} onChange={(visualRefs) => change({ visualRefs })} />

      <section className="codex-section" aria-label={t`Appears in`}>
        <h3 className="field-label"><Trans>Appears in</Trans></h3>
        {appearances.length === 0 ? (
          <p className="field-help">
            <Trans>No mentions yet. A mention is found when the name or an alias is written into a scene.</Trans>
          </p>
        ) : (
          <>
            <p className="field-help">
              {appearsText(mentionCount, appearances.length)}
            </p>
            <ul className="codex-rows">
              {appearances.map((appearance) => (
                <li key={appearance.docId}>
                  <button
                    type="button"
                    className="codex-row is-appearance"
                    onClick={() => onOpenDocument(appearance.docId, firstMentionIn(session, appearance.docId, entry.id))}
                  >
                    <span className="codex-row-name" lang={contentLang} dir="auto">{appearance.title}</span>
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
  useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commit = (): void => {
    const next = shown.trim();
    if (next !== value) onCommit(next);
    setDraft(null);
  };
  return (
    <section className="inspector-section" aria-label={t`Name`}>
      <label className="field-label" htmlFor="codex-name">
        <Trans>Name</Trans>
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
          // The Enter that commits an IME candidate is the input method's: it does not commit the name.
          if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) {
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
  useLingui();
  const field = useDebouncedText(entry.description, onCommit);
  const count = [...field.value].length;
  return (
    <section className="inspector-section" aria-label={t`Description`}>
      <label className="field-label" htmlFor="codex-description">
        <Trans>Description</Trans>
      </label>
      <textarea
        id="codex-description"
        className="codex-description"
        rows={6}
        maxLength={CODEX_DESCRIPTION_MAX}
        placeholder={t`What the writer and the model should know about it.`}
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
      setComplaint(t`Keep each one to ${itemLimit} characters.`);
      return;
    }
    if (items.some((existing) => existing.toLowerCase() === value.toLowerCase())) {
      setComplaint(t`“${{ value: isolate(value) }}” is already here.`);
      return;
    }
    if (items.length >= limit) {
      setComplaint(t`Up to ${limit} here. Remove one to add another.`);
      return;
    }
    setComplaint(null);
    if (onChange([...items, value])) setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // The Enter that commits an IME candidate adds nothing; the candidate's text is still being composed.
    if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) {
      event.preventDefault();
      add();
    }
  };

  return (
    <section className="inspector-section" aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`} className="field-label">
        {label}
      </h3>
      <ul className="keyword-list" aria-label={accessibleText(label)}>
        {items.map((item) => (
          <li key={item} className="chip chip-keyword">
            <span>{item}</span>
            <button
              type="button"
              className="chip-remove"
              aria-label={accessibleText(t`Remove ${{ item: isolate(item) }} from ${{ field: label }}`)}
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
        aria-label={accessibleText(t`Add to ${{ field: label }}`)}
        maxLength={itemLimit}
        disabled={items.length >= limit}
        placeholder={items.length >= limit ? t`Up to ${limit} here` : placeholder}
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
  useLingui();
  const attached = entry.attachments.map((id) => ({ id, node: nodeById(session.state, id) }));
  const choices = attachable(session.state).filter((node) => !entry.attachments.includes(node.id));
  return (
    <section className="inspector-section" aria-label={t`Attached to`}>
      <h3 className="field-label"><Trans>Attached to</Trans></h3>
      {attached.length === 0 ? (
        <p className="field-help">
          <Trans>Attached to no items yet. A Manual entry is sent only in the items it is attached to (codex.md §5).</Trans>
        </p>
      ) : (
        <ul className="keyword-list" aria-label={t`Attachments`}>
          {attached.map(({ id, node }) => (
            <li key={id} className="chip chip-keyword">
              <span>{node?.title ?? t`A removed item`}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={accessibleText(node === undefined ? t`Detach from a removed item` : t`Detach from ${{ title: isolate(node.title) }}`)}
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
            <Trans>Attach to a document or folder</Trans>
          </label>
          <select
            id={`attach-${entry.id}`}
            className="codex-select"
            aria-label={t`Attach to`}
            value=""
            onChange={(event) => {
              if (event.target.value !== '') onAttach(event.target.value);
            }}
          >
            <option value=""><Trans>Choose…</Trans></option>
            {choices.map((node) => (
              <option key={node.id} value={node.id}>
                {node.type === 'folder' ? t`${{ title: isolate(node.title) }} (folder)` : node.title}
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
  useLingui();
  useSession(session);
  const assets = session.assets.artifactFs();
  // The images are listed when they can have changed, not on every change of the session (media/hooks.ts).
  const records = useAssetRecords(assets, session.assetsVersion());
  const chosen = entry.visualRefs ?? [];
  const choices = [...records.values()].filter((record) => !chosen.includes(record.id));
  return (
    <section className="inspector-section" aria-label={t`Visual references`}>
      <h3 className="field-label"><Trans>Visual references</Trans></h3>
      <p className="field-help">
        <Trans>The prompt pack names these pictures for the scenes this entry appears in, so you can attach them in your video tool. Caotang uploads none of them.</Trans>
      </p>
      {chosen.length === 0 ? (
        <p className="field-help"><Trans>None yet.</Trans></p>
      ) : (
        <ul className="keyword-list" aria-label={t`Chosen pictures`}>
          {chosen.map((id) => {
            const listed = records.get(id);
            const name = listed === undefined ? t`A picture that is no longer in the project` : pickerLabelOf(session.state, id, listed.fileName);
            return (
              <li key={id} className="chip chip-keyword">
                <RefThumb assets={assets} assetId={id} alt={name} />
                <span>{name}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={accessibleText(t`Remove ${{ name: isolate(name) }}`)}
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
            <Trans>Add a picture</Trans>
          </label>
          <select
            id={`visual-ref-${entry.id}`}
            className="codex-select"
            aria-label={t`Add a picture`}
            value=""
            onChange={(event) => {
              if (event.target.value !== '') onChange([...chosen, event.target.value]);
            }}
          >
            <option value=""><Trans>Choose…</Trans></option>
            {choices.map((record) => (
              <option key={record.id} value={record.id}>
                {pickerLabelOf(session.state, record.id, record.fileName)}
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
  const shown = formatCount(count);
  return t`${shown} ${plural(count, { one: 'mention', other: 'mentions' })}`;
}

function appearsText(mentionCount: number, documentCount: number): string {
  const mentions = formatCount(mentionCount);
  const documents = formatCount(documentCount);
  return t`${mentions} ${plural(mentionCount, { one: 'mention', other: 'mentions' })} in ${documents} ${plural(documentCount, { one: 'document', other: 'documents' })}`;
}

function originLabel(entry: CodexEntry): string {
  if (entry.origin === 'agent') return t`Drafted by the agent`;
  if (entry.origin === 'import') return t`Imported`;
  return t`Written by hand`;
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
