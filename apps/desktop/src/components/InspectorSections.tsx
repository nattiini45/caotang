import { useState, type ReactNode } from 'react';
import { plural, select, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DAY_OFFSET_LIMIT, SCENE_STYLES, STORY_PARTS, THREAD_ID_LIMIT, THREAD_NOTE_LIMIT, TIMELINE_MODES, isDayOffset, type DeclaredStoryPart, type KnowledgeLinkRecord, type ScenePatch, type SceneThread } from '@caotang/bus';
import { isolate } from '@caotang/i18n';
import type { CodexEntry, TreeNode } from '@caotang/store';
import { attachEntry, explain, setSceneStyle } from './actions.js';
import { afterCandidates, dayLabel, dialogueContainerChoices, inheritedStoryPartOf, modeLabel, povCandidates, sceneMetaOf, storyPartLabel } from '../app/findings-model.js';
import { characterCandidates, pairWords } from '../app/knowledge-model.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { UserText } from '../i18n/UserText.js';
import { isImeEnter } from '../app/keymap.js';
import type { ProjectSession } from '../app/session.js';
import { projectCollator } from '../i18n/project-collator.js';
import { useStoreDraft } from './store-draft.js';
import { useReport, useSession } from './shared.js';

/* lingui-set comment="Names, titles, notes and thread handles are writer content. kind is a stored document or knowledge-relation token; count is the number of mentions." */

export function SceneStyleSection({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useSession(session);
  useLingui();
  const report = useReport();
  const stored = node.style ?? 'normal';
  const known = (SCENE_STYLES as readonly string[]).includes(stored);
  return (
    <section className="inspector-section" aria-label={t`Export style`} data-testid="scene-style">
      <label className="scene-field">
        <span className="field-label"><Trans>Export style</Trans></span>
        <select aria-label={t`Export style`} value={stored} onChange={(event) => {
          const outcome = setSceneStyle(session, node.id, event.target.value);
          if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
        }}>
          {known ? null : <option value={stored} disabled>{t`${{ style: isolate(stored) }} (unknown, exported as Normal)`}</option>}
          {SCENE_STYLES.map((style) => <option key={style} value={style}>{style === 'normal' ? t`Normal` : t`Section`}</option>)}
        </select>
      </label>
      <p className="field-note"><Trans>Section prints this scene’s title as a heading above it in Word, EPUB, Markdown and plain-text files.</Trans></p>
    </section>
  );
}

export function CodexSection({ session, node, onOpenCodex }: {
  session: ProjectSession;
  node: TreeNode;
  onOpenCodex?: (entryId: string) => void;
}): ReactNode {
  useSession(session);
  useLingui();
  const report = useReport();
  const entries = session.mentions.entriesOf(session.state);
  const attached = entries.filter((entry) => entry.attachments.includes(node.id));
  const available = entries.filter((entry) => !entry.attachments.includes(node.id)).sort(byNameOf(session.state.manifest.project.language));
  const mentions = node.type === 'document' ? entries.map((entry) => ({ entry, count: session.mentions.countsIn(session.state, node.id, entries).get(entry.id) ?? 0 })).filter((row) => row.count > 0) : [];
  const lang = session.state.manifest.project.language;
  const attach = (entry: CodexEntry): void => {
    const outcome = attachEntry(session, entry.id, [node.id], []);
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };
  const detach = (entry: CodexEntry): void => {
    const outcome = attachEntry(session, entry.id, [], [node.id]);
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };
  const kind = node.type;
  return (
    <section className="inspector-section codex-section" aria-labelledby="inspector-codex-label" data-testid="inspector-codex">
      <h3 id="inspector-codex-label" className="field-label"><Trans>Codex</Trans></h3>
      <ul className="keyword-list codex-attached" aria-label={t`Attached codex entries`}>
        {attached.length === 0 ? <li className="field-note"><Trans>Nothing is attached here.</Trans></li> : null}
        {attached.map((entry) => (
          <li key={entry.id} className="chip chip-codex" data-codex-attached={entry.name}>
            <span><UserText value={entry.name} lang={lang} /></span>
            <button type="button" className="chip-remove" aria-label={accessibleText(t`Detach ${{ name: entry.name }}`)} onClick={() => detach(entry)}>×</button>
          </li>
        ))}
      </ul>
      {available.length > 0 ? (
        <label className="codex-attach">
          <span className="field-note">{select(kind, { document: 'Attach an entry to this document', other: 'Attach an entry to this folder' })}</span>
          <select aria-label={t`Attach a codex entry`} value="" onChange={(event) => {
            const entry = available.find((candidate) => candidate.id === event.target.value);
            if (entry !== undefined) attach(entry);
          }}>
            <option value=""><Trans>Choose an entry…</Trans></option>
            {available.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
      ) : null}
      {node.type === 'document' ? (
        <div className="codex-mentions">
          <p className="field-label"><Trans>Mentioned in this document</Trans></p>
          {mentions.length === 0 ? <p className="field-note"><Trans>No codex entry is mentioned here.</Trans></p> : null}
          <ul className="mention-chips" aria-label={t`Mentioned codex entries`}>
            {mentions.map(({ entry, count }) => (
              <li key={entry.id}>
                <button type="button" className="chip mention-chip" data-mention={entry.name} aria-label={accessibleText(t`Show in the codex: ${{ name: entry.name }}, mentioned here ${plural(count, { one: '# time', other: '# times' })}`)} onClick={() => onOpenCodex?.(entry.id)}>
                  <span><UserText value={entry.name} lang={lang} /></span><span className="mention-count">{count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function byNameOf(projectLanguage: string | undefined): (a: CodexEntry, b: CodexEntry) => number {
  const collator = projectCollator(projectLanguage);
  return (a, b) => collator.compare(a.name, b.name);
}

export function SceneMetaSection({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useSession(session);
  useLingui();
  const report = useReport();
  const meta = sceneMetaOf(session.coherenceFile(), node.id);
  const entries = session.mentions.entriesOf(session.state);
  const characters = povCandidates(entries, session.state.manifest.project.language);
  const documents = afterCandidates(session.state, node.id);
  const afterTitles = (meta.after ?? []).map((id) => ({ id, title: documents.find((doc) => doc.id === id)?.title ?? t`a document that is gone` }));
  const expected = (meta.expectedPresent ?? []).map((id) => ({ id, name: entries.find((entry) => entry.id === id)?.name ?? t`an entry that is gone` }));
  const dialogue = dialogueContainerChoices(session.state, meta.dialogueContainer);
  const apply = (patch: ScenePatch): void => {
    const outcome = session.dispatch('coherence.setSceneMeta', { docId: node.id, patch });
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };
  return (
    <details className="inspector-section scene-meta" data-testid="scene-meta">
      <summary className="field-label"><Trans>Scene declarations</Trans></summary>
      <p className="field-note"><Trans>Only what you declare here is checked. Nothing is inferred from the text.</Trans></p>
      <label className="scene-field">
        <span><Trans>Point of view</Trans></span>
        <select aria-label={t`Point of view`} value={meta.pov ?? ''} onChange={(event) => apply({ pov: event.target.value === '' ? null : event.target.value })}>
          <option value=""><Trans>No point of view declared</Trans></option>
          {characters.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      <NumberField label={t`Day offset`} value={meta.dayOffset} signed {...(meta.dayOffset === undefined ? {} : { note: dayLabel(meta.dayOffset) })} onCommit={(value) => apply({ dayOffset: value })} />
      <NumberField label={t`Duration in days`} value={meta.durationDays} onCommit={(value) => apply({ durationDays: value })} />
      <StoryPartSelect session={session} node={node} />
      <label className="scene-field">
        <span><Trans>Timeline mode</Trans></span>
        <select aria-label={t`Timeline mode`} value={meta.timelineMode ?? 'linear'} onChange={(event) => apply({ timelineMode: event.target.value })}>
          {TIMELINE_MODES.map((mode) => <option key={mode} value={mode}>{modeLabel(mode)}</option>)}
        </select>
      </label>
      <label className="scene-field">
        <span><Trans>Dialogue container</Trans></span>
        <select aria-label={t`Dialogue container`} value={meta.dialogueContainer ?? ''} onChange={(event) => apply({ dialogueContainer: event.target.value === '' ? null : event.target.value })}>
          <option value=""><Trans>No dialogue container linked</Trans></option>
          {dialogue.missing && meta.dialogueContainer !== undefined ? <option value={meta.dialogueContainer}><Trans>A container that is missing</Trans></option> : null}
          {dialogue.containers.map((container) => <option key={container.id} value={container.id}>{container.title}</option>)}
        </select>
      </label>
      {dialogue.missing ? <p className="field-note" data-testid="dialogue-container-missing">
        <Trans>The linked dialogue container is archived, outside the manuscript or gone, so this scene is not compared with it.</Trans>{' '}
        <button type="button" onClick={() => apply({ dialogueContainer: null })}><Trans>Clear the link</Trans></button>
      </p> : <p className="field-note"><Trans>A screenplay scene is compared with its linked dialogue on speakers only.</Trans></p>}
      <ChipList label={t`Follows these scenes`} items={afterTitles} addLabel={t`Add a scene this follows`} placeholder={t`Add a scene this follows…`}
        candidates={documents.filter((doc) => !(meta.after ?? []).includes(doc.id)).map((doc) => ({ id: doc.id, label: doc.title }))}
        onAdd={(id) => apply({ after_add: [id] })} onRemove={(id) => apply({ after_remove: [id] })} removeLabel={(title) => accessibleText(t`Stop following ${{ title }}`)} />
      <ChipList label={t`Expected to appear`} items={expected.map((item) => ({ id: item.id, title: item.name }))} addLabel={t`Add an entry expected here`} placeholder={t`Add an entry expected here…`}
        candidates={entries.filter((entry) => !(meta.expectedPresent ?? []).includes(entry.id)).sort(byNameOf(session.state.manifest.project.language)).map((entry) => ({ id: entry.id, label: entry.name }))}
        onAdd={(id) => apply({ expectedPresent_add: [id] })} onRemove={(id) => apply({ expectedPresent_remove: [id] })} removeLabel={(title) => accessibleText(t`Stop expecting ${{ title }}`)} />
      <ThreadsEditor key={node.id} threads={meta.threads ?? []} documents={documents} apply={apply} />
      <KnowledgeEditor learns={meta.learns ?? []} knows={meta.knows ?? []} entries={entries} facts={session.coherenceFile()?.knowledge ?? []} projectLanguage={session.state.manifest.project.language} apply={apply} />
    </details>
  );
}

function KnowledgeEditor({ learns, knows, entries, facts, projectLanguage, apply }: {
  learns: readonly KnowledgeLinkRecord[];
  knows: readonly KnowledgeLinkRecord[];
  entries: readonly CodexEntry[];
  facts: readonly { readonly id: string; readonly text: string }[];
  projectLanguage: string | undefined;
  apply: (patch: ScenePatch) => void;
}): ReactNode {
  useLingui();
  const characters = characterCandidates(entries, projectLanguage);
  const readyToDeclare = characters.length > 0 && facts.length > 0;
  return (
    <div className="scene-chips scene-knowledge" data-testid="scene-knowledge">
      <p className="field-label"><Trans>Knowledge</Trans></p>
      {readyToDeclare ? null : <p className="field-note">{facts.length === 0 ? t`Add a fact in the Knowledge list of the Findings tab first.` : t`Add a character to the codex first.`}</p>}
      <KnowledgeRowEditor kind="learns" links={learns} characters={characters} entries={entries} facts={facts} enabled={readyToDeclare} onAdd={(link) => apply({ learns_add: [link] })} onRemove={(link) => apply({ learns_remove: [link] })} />
      <KnowledgeRowEditor kind="knows" links={knows} characters={characters} entries={entries} facts={facts} enabled={readyToDeclare} onAdd={(link) => apply({ knows_add: [link] })} onRemove={(link) => apply({ knows_remove: [link] })} />
    </div>
  );
}

function KnowledgeRowEditor({ kind, links, characters, entries, facts, enabled, onAdd, onRemove }: {
  kind: 'learns' | 'knows';
  links: readonly KnowledgeLinkRecord[];
  characters: readonly CodexEntry[];
  entries: readonly CodexEntry[];
  facts: readonly { readonly id: string; readonly text: string }[];
  enabled: boolean;
  onAdd: (link: KnowledgeLinkRecord) => void;
  onRemove: (link: KnowledgeLinkRecord) => void;
}): ReactNode {
  useLingui();
  const [entryId, setEntryId] = useState('');
  const [factId, setFactId] = useState('');
  const label = kind === 'learns' ? t`Learns` : t`Knows`;
  return (
    <div className="knowledge-row">
      <p className="field-label">{label}</p>
      <ul className="keyword-list" aria-label={accessibleText(label)}>
        {links.length === 0 ? <li className="field-note"><Trans>None declared.</Trans></li> : null}
        {links.map((link) => {
          const words = pairWords(link, entries, facts);
          return (
            <li key={`${link.entryId}:${link.factId}`} className="chip chip-keyword">
              <span>{words}</span>
              <button type="button" className="chip-remove" aria-label={accessibleText(kind === 'learns' ? t`Stop declaring ${{ words }} under Learns` : t`Stop declaring ${{ words }} under Knows`)} onClick={() => onRemove(link)}>×</button>
            </li>
          );
        })}
      </ul>
      {enabled ? (
        <div className="knowledge-pick">
          <select aria-label={kind === 'learns' ? t`Character who learns` : t`Character who knows`} value={entryId} onChange={(event) => setEntryId(event.target.value)}>
            <option value=""><Trans>Choose a character…</Trans></option>
            {characters.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <select aria-label={kind === 'learns' ? t`Fact learned` : t`Fact known`} value={factId} onChange={(event) => setFactId(event.target.value)}>
            <option value=""><Trans>Choose a fact…</Trans></option>
            {facts.map((fact) => <option key={fact.id} value={fact.id}>{fact.text}</option>)}
          </select>
          <button type="button" disabled={entryId === '' || factId === ''} aria-label={kind === 'learns' ? t`Add to Learns` : t`Add to Knows`} onClick={() => {
            onAdd({ entryId, factId });
            setEntryId('');
            setFactId('');
          }}><Trans>Add</Trans></button>
        </div>
      ) : null}
    </div>
  );
}

function ThreadsEditor({ threads, documents, apply }: {
  threads: readonly SceneThread[];
  documents: readonly { readonly id: string; readonly title: string }[];
  apply: (patch: ScenePatch) => void;
}): ReactNode {
  useLingui();
  const [editing, setEditing] = useState<string | null>(null);
  const [handle, setHandle] = useState('');
  const [payoff, setPayoff] = useState('');
  const [note, setNote] = useState('');
  const reset = (): void => { setEditing(null); setHandle(''); setPayoff(''); setNote(''); };
  const submit = (): void => {
    const thread: SceneThread = note.trim() === '' ? { id: handle.trim(), payoff } : { id: handle.trim(), payoff, note: note.trim() };
    apply(editing === null ? { threads_add: [thread] } : { threads_remove: [editing], threads_add: [thread] });
    reset();
  };
  const titleOf = (id: string): string => documents.find((doc) => doc.id === id)?.title ?? t`a document that is gone`;
  return (
    <div className="scene-chips scene-threads" data-testid="scene-threads">
      <p className="field-label"><Trans>Threads this scene sets up</Trans></p>
      <ul className="thread-list" aria-label={t`Threads`}>
        {threads.length === 0 ? <li className="field-note"><Trans>None declared.</Trans></li> : null}
        {threads.map((thread) => (
          <li key={thread.id} className="thread-row">
            <span>{thread.note === undefined
              ? <Trans><strong><UserText value={thread.id} /></strong> is paid off in <UserText value={titleOf(thread.payoff)} /></Trans>
              : <Trans><strong><UserText value={thread.id} /></strong> is paid off in <UserText value={titleOf(thread.payoff)} />: <UserText value={thread.note} /></Trans>}</span>
            <button type="button" className="chip-remove" aria-label={accessibleText(t`Edit the thread ${{ name: thread.id }}`)} onClick={() => { setEditing(thread.id); setHandle(thread.id); setPayoff(thread.payoff); setNote(thread.note ?? ''); }}><Trans>Edit</Trans></button>
            <button type="button" className="chip-remove" aria-label={accessibleText(t`Remove the thread ${{ name: thread.id }}`)} onClick={() => apply({ threads_remove: [thread.id] })}>×</button>
          </li>
        ))}
      </ul>
      <label className="scene-field"><span><Trans>Thread name</Trans></span><input type="text" aria-label={t`Thread name`} maxLength={THREAD_ID_LIMIT} value={handle} onChange={(event) => setHandle(event.target.value)} /></label>
      <label className="scene-field">
        <span><Trans>Paid off in</Trans></span>
        <select aria-label={t`Paid off in`} value={payoff} onChange={(event) => setPayoff(event.target.value)}>
          <option value=""><Trans>Choose a scene…</Trans></option>
          {documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
        </select>
      </label>
      <label className="scene-field"><span><Trans>What the payoff is for</Trans></span><input type="text" aria-label={t`What the payoff is for`} maxLength={THREAD_NOTE_LIMIT} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="thread-actions">
        <button type="button" disabled={handle.trim() === '' || payoff === ''} onClick={submit}>{editing === null ? t`Add thread` : t`Save thread`}</button>
        {editing === null ? null : <button type="button" onClick={reset}><Trans>Cancel</Trans></button>}
      </div>
    </div>
  );
}

/**
 * A whole-number field. A day may be negative, within the one limit the patch and the file share (coherence.md §5.2.2); a
 * duration is zero or more. An entry the rule would refuse is put back, never sent.
 */
function NumberField({ label, value, signed = false, onCommit, note }: {
  label: string;
  value: number | undefined;
  signed?: boolean;
  onCommit: (value: number | null) => void;
  note?: string;
}): ReactNode {
  const draft = useStoreDraft(value === undefined ? '' : String(value));
  const commit = (): void => {
    const trimmed = draft.value.trim();
    if (trimmed === '') {
      if (value !== undefined) onCommit(null);
      return;
    }
    const parsed = Number(trimmed) + 0;
    if (signed ? !isDayOffset(parsed) : !Number.isInteger(parsed) || parsed < 0) { draft.reset(); return; }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <label className="scene-field">
      <span>{label}</span>
      <input type="number" {...(signed ? { min: -DAY_OFFSET_LIMIT, max: DAY_OFFSET_LIMIT } : { min: 0 })} step={1} aria-label={accessibleText(label)} value={draft.value} onChange={(event) => draft.change(event.target.value)} onBlur={commit} onKeyDown={(event) => {
        if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) commit();
      }} />
      {note === undefined ? null : <span className="field-note" data-testid="day-reading">{note}</span>}
    </label>
  );
}

/**
 * The Story part select (coherence.md §5.2.2). "Inherit" writes `null` and names the part it returns to; "Main story" is a
 * declaration of its own, so it overrides a prologue or epilogue folder above without moving the node.
 */
export function StoryPartSelect({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useSession(session);
  useLingui();
  const report = useReport();
  const file = session.coherenceFile();
  const declared = sceneMetaOf(file, node.id).storyPart;
  const inherited = storyPartLabel(inheritedStoryPartOf(session.state, file, node.id));
  const change = (value: string): void => {
    const outcome = session.dispatch('coherence.setSceneMeta', { docId: node.id, patch: { storyPart: value === '' ? null : (value as DeclaredStoryPart) } });
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };
  return (
    <label className="scene-field">
      <span><Trans>Story part</Trans></span>
      <select aria-label={t`Story part`} data-testid="story-part" value={declared ?? ''} onChange={(event) => change(event.target.value)}>
        <option value="">{node.type === 'folder' ? t`Inherit the part of the folder above (${{ part: inherited }})` : t`Inherit this folder’s part (${{ part: inherited }})`}</option>
        {STORY_PARTS.map((part) => <option key={part} value={part}>{storyPartLabel(part)}</option>)}
      </select>
    </label>
  );
}

/** A folder's own declarations: its part, which every scene under it inherits unless it declares one itself. */
export function FolderPartSection({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useLingui();
  return (
    <section className="inspector-section folder-part" aria-label={t`Story part`} data-testid="folder-part">
      <StoryPartSelect session={session} node={node} />
      <p className="field-note"><Trans>Scenes in this folder are in this part unless they declare their own.</Trans></p>
    </section>
  );
}

function ChipList({ label, items, addLabel, placeholder, candidates, onAdd, onRemove, removeLabel }: {
  label: string;
  items: readonly { readonly id: string; readonly title: string }[];
  addLabel: string;
  placeholder: string;
  candidates: readonly { readonly id: string; readonly label: string }[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  removeLabel: (title: string) => string;
}): ReactNode {
  return (
    <div className="scene-chips">
      <p className="field-label">{label}</p>
      <ul className="keyword-list" aria-label={accessibleText(label)}>
        {items.length === 0 ? <li className="field-note"><Trans>None declared.</Trans></li> : null}
        {items.map((item) => <li key={item.id} className="chip chip-keyword">
          <span><UserText value={item.title} /></span>
          <button type="button" className="chip-remove" aria-label={removeLabel(item.title)} onClick={() => onRemove(item.id)}>×</button>
        </li>)}
      </ul>
      {candidates.length > 0 ? <select aria-label={accessibleText(addLabel)} value="" onChange={(event) => { if (event.target.value !== '') onAdd(event.target.value); }}>
        <option value="">{placeholder}</option>
        {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
      </select> : null}
    </div>
  );
}
