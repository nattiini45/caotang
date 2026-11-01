/**
 * The shared import preview (import-preview.md, issue #267): one dialog for every structured import, after the Twee and Script
 * import precedent. Nothing is written until **Import**; the import is one undo step (`binder.importTree`, or the source's own
 * command); the losses, the sanity flags and the passages that read like instructions to an AI are listed before it.
 *
 * Loaded on first use with the Import action (`ImportPreviewHost`), so the first load carries none of it.
 *
 * Layout, top to bottom: what was detected; the rule chips and the destination; the proposed binder (a `tree`) beside the text it
 * splits (virtualised: only the blocks in view are in the DOM, so 200,000 words scroll as smoothly as 2,000); the field mapping;
 * the codex rows; the reader's options; the report; Cancel and Import.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { ProjectSession } from '../app/session.js';
import { chordKey, keyFacts } from '../app/keymap.js';
import { formatCount } from '../i18n/locale.js';
import { explain } from '../components/actions.js';
import { InlineText, useReport, useSession } from '../components/shared.js';
import {
  FIELD_TARGETS,
  NO_EDITS,
  addSplit,
  applyEdits,
  buildCommit,
  collisions,
  defaultCodexAnswer,
  editCount,
  estimateHeight,
  findNode,
  headerLine,
  importedSentence,
  initialSettings,
  isExcluded,
  mergeWithNext,
  move,
  networkLabel,
  nodeAtBlock,
  offsetsOf,
  removeSplit,
  rename,
  scanTree,
  toggleExcluded,
  unknownValues,
  visibleRange,
  visibleRows,
  type CodexAnswer,
  type FieldTarget,
  type PreviewBlock,
  type PreviewCodexRow,
  type PreviewEdits,
  type PreviewHelpers,
  type PreviewMarker,
  type PreviewNode,
  type PreviewPlan,
  type PreviewSettings,
  type ValueAnswer,
} from './model.js';
import { closeImportPreview, type ImportPreviewRequest } from './requests.js';
import './import-preview.css';

type Phase = { readonly kind: 'loading'; readonly progress: string } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'ready' };

const FIELD_WORDS: Readonly<Record<FieldTarget, string>> = {
  synopsis: 'Synopsis',
  keywords: 'Keywords',
  status: 'Status',
  label: 'Label',
  notes: 'Notes',
  ignore: 'Ignore',
};

const CODEX_TYPES = ['character', 'location', 'object', 'lore', 'subplot', 'other'] as const;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export default function ImportPreviewDialog({ session, request, helpers }: { session: ProjectSession; request: ImportPreviewRequest; helpers: PreviewHelpers }): ReactNode {
  useSession(session);
  const report = useReport();
  const { source } = request;
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const [phase, setPhase] = useState<Phase>(() => (source.load === undefined ? { kind: 'ready' } : { kind: 'loading', progress: `Reading ${source.fileName}…` }));
  const [settings, setSettings] = useState<PreviewSettings>(() => (source.load === undefined ? initialSettings(source.chips(), source.options()) : { chips: {}, options: {} }));
  const [edits, setEdits] = useState<PreviewEdits>(NO_EDITS);
  const [pendingRule, setPendingRule] = useState<{ readonly id: string; readonly value: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [destination, setDestination] = useState('manuscript');
  const [mapping, setMapping] = useState<Record<string, FieldTarget>>({});
  const [statusAnswers, setStatusAnswers] = useState<Record<string, ValueAnswer>>({});
  const [labelAnswers, setLabelAnswers] = useState<Record<string, ValueAnswer>>({});
  const [codexAnswers, setCodexAnswers] = useState<Record<string, CodexAnswer>>({});
  const [codexTypes, setCodexTypes] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ readonly block: number; readonly seq: number } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  // The reader runs once, with a progress line and a cancel; the dialog opens on its result.
  useEffect(() => {
    if (source.load === undefined) return;
    const controller = new AbortController();
    abort.current = controller;
    source
      .load((progress) => {
        if (!controller.signal.aborted) setPhase({ kind: 'loading', progress });
      }, controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        setSettings(initialSettings(source.chips(), source.options()));
        setMapping(Object.fromEntries((source.fields?.() ?? []).map((field) => [field.key, field.suggested ?? 'ignore'])));
        setPhase({ kind: 'ready' });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: 'failed', message: failure instanceof Error ? failure.message : String(failure) });
      });
    return () => controller.abort();
  }, [source]);

  const ready = phase.kind === 'ready';
  const plan: PreviewPlan | null = useMemo(() => (ready ? source.plan(settings, edits.overrides) : null), [ready, source, settings, edits.overrides]);
  const shown = useMemo(() => (plan === null ? [] : applyEdits(plan.tree, edits)), [plan, edits]);
  const rows = useMemo(() => visibleRows(shown, collapsed), [shown, collapsed]);
  const extraScan = useMemo(() => (ready ? (source.scanExtra?.() ?? []) : []), [ready, source]);
  const scan = useMemo(() => scanTree(shown, helpers, extraScan), [shown, helpers, extraScan]);
  const codexRows: readonly PreviewCodexRow[] = useMemo(() => (ready ? (source.codexRows?.() ?? []) : []), [ready, source]);
  const held = useMemo(() => (session.state.manifest.codex ?? []).flatMap((entry) => [entry.name, ...entry.aliases]), [session.state.manifest.codex]);
  const colliding = useMemo(() => collisions(codexRows, held), [codexRows, held]);
  const fields = ready ? (source.fields?.() ?? []) : [];
  const vocabulary = session.state.manifest.vocabulary;
  const statusValues = useMemo(() => valuesFor(shown, mapping, 'status'), [shown, mapping]);
  const labelValues = useMemo(() => valuesFor(shown, mapping, 'label'), [shown, mapping]);
  const unknownStatuses = unknownValues(statusValues, vocabulary.statuses);
  const unknownLabels = unknownValues(labelValues, vocabulary.labels);
  const folders = session.state.manifest.tree.filter((node) => node.type === 'folder' && node.parentId === 'manuscript' && node.kind === undefined);

  const close = (committed: boolean): void => {
    abort.current?.abort();
    ref.current?.close();
    closeImportPreview(committed);
  };

  const changeRule = (id: string, value: string, keep: boolean): void => {
    setSettings((current) => ({ ...current, chips: { ...current.chips, [id]: value } }));
    if (!keep) setEdits(NO_EDITS);
    setPendingRule(null);
  };

  const askRule = (id: string, value: string): void => {
    if (editCount(edits) === 0) changeRule(id, value, true);
    else setPendingRule({ id, value });
  };

  const select = (nodeId: string): void => {
    setSelected(nodeId);
    const node = findNode(shown, nodeId);
    if (node !== undefined) setScrollTo((current) => ({ block: node.startBlock, seq: (current?.seq ?? 0) + 1 }));
  };

  const commit = async (): Promise<void> => {
    if (plan === null) return;
    setCommitting(true);
    setError(null);
    if (source.commit !== undefined) {
      const done = await source.commit(plan);
      if (!done.ok) {
        setError(done.message);
        setCommitting(false);
        return;
      }
      if (done.message !== undefined) report({ text: done.message, tone: 'info' });
      close(true);
      return;
    }
    const pictures = source.picturesOption === undefined || settings.options[source.picturesOption] === true ? (source.pictures?.() ?? []) : [];
    const built = buildCommit({
      plan,
      edits,
      destination,
      mapping,
      statuses: vocabulary.statuses,
      labels: vocabulary.labels,
      statusAnswers,
      labelAnswers,
      codexRows: codexRows.map((row) => ({ ...row, type: codexTypes[row.id] ?? row.type })),
      codexAnswers: Object.fromEntries(codexRows.map((row) => [row.id, codexAnswers[row.id] ?? defaultCodexAnswer(row.id, colliding)])),
      codexHeld: held,
      pictures,
    }, helpers);
    if (built.params.nodes.length === 0) {
      setError('Everything is left out, so there is nothing to import. Tick at least one chapter or scene.');
      setCommitting(false);
      return;
    }
    if (built.unkept.length > 0) {
      setError(`${built.unkept.map((title) => `“${title}”`).join(', ')} would not come back unchanged from a save, so nothing was imported. Leave ${built.unkept.length === 1 ? 'it' : 'them'} out and import again.`);
      setCommitting(false);
      return;
    }
    const result = await session.importTree(built.params, built.pictures);
    if (!result.ok) {
      setError(explain(result.error));
      setCommitting(false);
      return;
    }
    const scanned = scan.sentence(source.fileName);
    report({ text: [importedSentence(source.fileName, built), ...(scanned === undefined ? [] : [scanned])].join(' '), tone: 'info' });
    close(true);
  };

  const importLabel = plan === null ? 'Import' : (source.importLabel?.(plan) ?? `Import ${plural(plan.counts.chapters, 'chapter')}`);
  const sourceReport = plan === null ? [] : (source.report?.(plan) ?? []);

  return (
    <dialog
      ref={ref}
      className="confirm import-preview"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close(false);
      }}
    >
      <div className="confirm-body import-preview-body">
        <h2 id={titleId}>{source.title}</h2>
        {phase.kind === 'loading' ? (
          <p className="import-preview-progress" role="status" aria-live="polite">
            {phase.progress}
          </p>
        ) : null}
        {phase.kind === 'failed' ? (
          <p className="import-preview-error" role="alert">
            {source.fileName} could not be read: {phase.message}
          </p>
        ) : null}
        {plan !== null ? (
          <>
            {source.intro === undefined ? null : <p className="import-preview-intro">{source.intro}</p>}
            <p className="import-preview-detected" role="status" aria-live="polite">
              Detected: {headerLine(plan.counts, codexRows.length)}
            </p>

            <RuleChips source={source} settings={settings} onChange={askRule} destination={destination} folders={folders} onDestination={setDestination} customCommit={source.commit !== undefined} />
            {pendingRule === null ? null : (
              <div className="import-preview-ask" role="group" aria-label="Keep your manual edits?">
                <p>
                  You made {plural(editCount(edits), 'manual edit')}. Keep {editCount(edits) === 1 ? 'it' : 'them'} with the new rule?
                </p>
                <button type="button" className="button" onClick={() => changeRule(pendingRule.id, pendingRule.value, true)}>
                  Keep my edits
                </button>
                <button type="button" className="button" onClick={() => changeRule(pendingRule.id, pendingRule.value, false)}>
                  Discard them
                </button>
                <button type="button" className="button is-quiet" onClick={() => setPendingRule(null)}>
                  Keep the old rule
                </button>
              </div>
            )}

            <div className="import-preview-panes">
              <BinderPane
                readOnly={source.readOnly === true}
                rows={rows}
                tree={shown}
                edits={edits}
                selected={selected}
                renaming={renaming}
                onSelect={select}
                onToggleCollapsed={(id) =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onRename={(id) => setRenaming(id)}
                onRenamed={(id, title) => {
                  setRenaming(null);
                  if (title !== '') setEdits((current) => rename(current, id, title));
                }}
                onExclude={(id) => setEdits((current) => toggleExcluded(current, id))}
                onMerge={(id) => setEdits((current) => mergeWithNext(current, plan.tree, id))}
                onMove={(id, by) => setEdits((current) => move(current, plan.tree, id, by))}
              />
              <TextPane
                readOnly={source.readOnly === true}
                blocks={plan.blocks}
                markers={plan.markers}
                scrollTo={scrollTo}
                onRemoveSplit={(block) => setEdits((current) => removeSplit(current, block))}
                onAddSplit={(block, kind) => setEdits((current) => addSplit(current, block, kind))}
                onSelectBlock={(block) => {
                  const node = nodeAtBlock(shown, block);
                  if (node !== undefined) setSelected(node.id);
                }}
              />
            </div>

            {fields.length === 0 ? null : (
              <section className="import-preview-section" aria-label="Fields">
                <h3>Fields</h3>
                <table className="import-preview-table">
                  <tbody>
                    {fields.map((field) => (
                      <tr key={field.key}>
                        <th scope="row">{field.key}</th>
                        <td className="import-preview-muted">
                          {plural(field.count, 'value')}
                          {field.samples.length === 0 ? '' : `, e.g. ${field.samples.slice(0, 2).join(', ')}`}
                        </td>
                        <td>
                          <select
                            aria-label={`Field ${field.key} becomes`}
                            value={mapping[field.key] ?? 'ignore'}
                            onChange={(event) => {
                              const value = event.currentTarget.value as FieldTarget;
                              setMapping((current) => ({ ...current, [field.key]: value }));
                            }}
                          >
                            {FIELD_TARGETS.map((target) => (
                              <option key={target} value={target}>
                                {FIELD_WORDS[target]}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ValueAnswers kind="status" values={unknownStatuses} terms={vocabulary.statuses} answers={statusAnswers} onAnswer={(value, answer) => setStatusAnswers((current) => ({ ...current, [value]: answer }))} />
                <ValueAnswers kind="label" values={unknownLabels} terms={vocabulary.labels} answers={labelAnswers} onAnswer={(value, answer) => setLabelAnswers((current) => ({ ...current, [value]: answer }))} />
              </section>
            )}

            {codexRows.length === 0 ? null : (
              <section className="import-preview-section" aria-label="Codex rows">
                <h3>Codex</h3>
                <table className="import-preview-table">
                  <tbody>
                    {codexRows.map((row) => {
                      const answer = codexAnswers[row.id] ?? defaultCodexAnswer(row.id, colliding);
                      return (
                        <tr key={row.id}>
                          <th scope="row">
                            {row.name}
                            {colliding.has(row.id) ? <span className="import-preview-warn"> already in the codex</span> : null}
                          </th>
                          <td>
                            <select aria-label={`Type of ${row.name}`} value={codexTypes[row.id] ?? row.type} onChange={(event) => {
                              const value = event.currentTarget.value;
                              setCodexTypes((current) => ({ ...current, [row.id]: value }));
                            }}>
                              {CODEX_TYPES.map((type) => (
                                <option key={type} value={type}>
                                  {type}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              aria-label={`What to do with ${row.name}`}
                              value={answer.action}
                              onChange={(event) => {
                                const action = event.currentTarget.value as CodexAnswer['action'];
                                const next: CodexAnswer = action === 'rename' ? { action, name: `${row.name} (imported)` } : { action };
                                setCodexAnswers((current) => ({ ...current, [row.id]: next }));
                              }}
                            >
                              <option value="import" disabled={colliding.has(row.id)}>
                                Import
                              </option>
                              <option value="skip">Skip</option>
                              <option value="rename">Rename</option>
                              <option value="page" disabled={row.page === undefined}>
                                Import as page only
                              </option>
                            </select>
                            {answer.action === 'rename' ? (
                              <input
                                type="text"
                                aria-label={`New name for ${row.name}`}
                                value={answer.name}
                                onChange={(event) => {
                                  const name = event.currentTarget.value;
                                  setCodexAnswers((current) => ({ ...current, [row.id]: { action: 'rename', name } }));
                                }}
                              />
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}

            {source.options().length === 0 ? null : (
              <fieldset className="import-preview-section import-preview-options">
                <legend>Options</legend>
                {source.options().map((option) => (
                  <label key={option.id}>
                    <input
                      type="checkbox"
                      checked={settings.options[option.id] ?? false}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSettings((current) => ({ ...current, options: { ...current.options, [option.id]: checked } }));
                      }}
                    />
                    {networkLabel(option)}
                    {option.detail === undefined ? null : <span className="import-preview-muted"> {option.detail}</span>}
                  </label>
                ))}
              </fieldset>
            )}

            <section className="import-preview-section import-preview-report" aria-label="Report">
              <h3>Report</h3>
              {sourceReport.map((list) => (
                <div key={list.label}>
                  {list.heading === '' ? null : <h4>{list.heading}</h4>}
                  <ul aria-label={list.label}>
                    {list.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {plan.losses.length === 0 ? null : (
                <ul aria-label="What the import cannot keep">
                  {plan.losses.map((loss) => (
                    <li key={`${loss.message}-${loss.blockIndex ?? ''}`}>
                      {loss.count === undefined ? '' : `${formatCount(loss.count)} × `}
                      {loss.message}
                    </li>
                  ))}
                </ul>
              )}
              {plan.flags.length === 0 ? null : (
                <ul aria-label="Checks">
                  {plan.flags.map((flag) => (
                    <li key={flag.message}>
                      ⚠ {flag.message}{' '}
                      {flag.fix === undefined ? null : (
                        <button
                          type="button"
                          className="button is-quiet"
                          onClick={() => {
                            const fix = flag.fix?.overrides ?? {};
                            setEdits((current) => ({
                              ...current,
                              overrides: {
                                noSplit: [...current.overrides.noSplit, ...(fix.noSplit ?? [])],
                                sceneAt: [...current.overrides.sceneAt, ...(fix.sceneAt ?? [])],
                                chapterAt: [...current.overrides.chapterAt, ...(fix.chapterAt ?? [])],
                              },
                            }));
                          }}
                        >
                          {flag.fix.label}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {scan.total === 0 ? (
                <p className="import-preview-muted">No passage reads like instructions to an AI.</p>
              ) : (
                <>
                  <p>
                    {plural(scan.total, 'passage reads', 'passages read')} like instructions to an AI. The text is imported as it is; read it before you ask the agent to work from it.
                  </p>
                  <ul aria-label="Passages that read like instructions to an AI">
                    {scan.rows.map((row, index) => (
                      <li key={`${row.nodeId}-${index}`}>
                        {row.nodeId === '' ? (
                          row.where
                        ) : (
                          <button type="button" className="button is-quiet" onClick={() => select(row.nodeId)}>
                            {row.where}
                          </button>
                        )}
                        : “{row.excerpt}”
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </>
        ) : null}
        {error === null ? null : (
          <p className="import-preview-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          {plan === null ? null : (
            <button type="button" className="button is-primary" disabled={committing || pendingRule !== null} onClick={() => void commit()}>
              {importLabel}
            </button>
          )}
          <button type="button" className="button" autoFocus disabled={committing} onClick={() => close(false)}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Every value the documents give a field mapped to `target`. */
function valuesFor(tree: readonly PreviewNode[], mapping: Readonly<Record<string, FieldTarget>>, target: FieldTarget): string[] {
  const keys = Object.entries(mapping)
    .filter(([, value]) => value === target)
    .map(([key]) => key);
  const out: string[] = [];
  const walk = (nodes: readonly PreviewNode[]): void => {
    for (const node of nodes) {
      for (const key of keys) {
        const raw = node.fields?.[key];
        if (typeof raw === 'string') out.push(raw);
        else if (raw !== undefined && raw[0] !== undefined) out.push(raw[0]);
      }
      walk(node.children ?? []);
    }
  };
  walk(tree);
  return out;
}

function RuleChips({
  source,
  settings,
  onChange,
  destination,
  folders,
  onDestination,
  customCommit,
}: {
  source: ImportPreviewRequest['source'];
  settings: PreviewSettings;
  onChange: (id: string, value: string) => void;
  destination: string;
  folders: readonly { readonly id: string; readonly title: string }[];
  onDestination: (id: string) => void;
  customCommit: boolean;
}): ReactNode {
  const chips = source.chips();
  return (
    <div className="import-preview-chips" role="group" aria-label="Rules">
      {chips.map((chip) => (
        <label key={chip.id}>
          <span>{chip.label}</span>
          <select value={settings.chips[chip.id] ?? chip.value} onChange={(event) => onChange(chip.id, event.currentTarget.value)}>
            {chip.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {customCommit ? null : (
        <label>
          <span>Into</span>
          <select value={destination} onChange={(event) => onDestination(event.currentTarget.value)}>
            <option value="manuscript">This project, Manuscript (new folders at the end)</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                This project, under “{folder.title}”
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function ValueAnswers({
  kind,
  values,
  terms,
  answers,
  onAnswer,
}: {
  kind: 'status' | 'label';
  values: readonly string[];
  terms: readonly { readonly id: string; readonly name: string }[];
  answers: Readonly<Record<string, ValueAnswer>>;
  onAnswer: (value: string, answer: ValueAnswer) => void;
}): ReactNode {
  if (values.length === 0) return null;
  return (
    <ul className="import-preview-values" aria-label={kind === 'status' ? 'Status values the project does not have' : 'Label values the project does not have'}>
      {values.map((value) => {
        const answer = answers[value] ?? { action: 'ignore' };
        const current = answer.action === 'map' ? `map:${answer.termId}` : answer.action;
        return (
          <li key={value}>
            “{value}” is not a {kind} of this project:{' '}
            <select
              aria-label={`${kind === 'status' ? 'Status' : 'Label'} “${value}”`}
              value={current}
              onChange={(event) => {
                const picked = event.currentTarget.value;
                onAnswer(value, picked === 'add' ? { action: 'add' } : picked === 'ignore' ? { action: 'ignore' } : { action: 'map', termId: picked.slice(4) });
              }}
            >
              <option value="add">Add it to the vocabulary</option>
              {terms.map((term) => (
                <option key={term.id} value={`map:${term.id}`}>
                  Use “{term.name}”
                </option>
              ))}
              <option value="ignore">Ignore it</option>
            </select>
          </li>
        );
      })}
    </ul>
  );
}

const ROLE_WORDS: Readonly<Record<PreviewNode['role'], string>> = {
  part: 'part',
  chapter: 'chapter',
  scene: 'scene',
  text: 'text',
  front: 'front matter',
  back: 'back matter',
  container: 'container',
};

function BinderPane({
  readOnly,
  rows,
  tree,
  edits,
  selected,
  renaming,
  onSelect,
  onToggleCollapsed,
  onRename,
  onRenamed,
  onExclude,
  onMerge,
  onMove,
}: {
  readOnly: boolean;
  rows: ReturnType<typeof visibleRows>;
  tree: readonly PreviewNode[];
  edits: PreviewEdits;
  selected: string | null;
  renaming: string | null;
  onSelect: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
  onRename: (id: string) => void;
  onRenamed: (id: string, title: string) => void;
  onExclude: (id: string) => void;
  onMerge: (id: string) => void;
  onMove: (id: string, by: -1 | 1) => void;
}): ReactNode {
  const focusId = selected ?? rows[0]?.node.id ?? null;
  const items = useRef(new Map<string, HTMLLIElement>());

  const focusRow = (id: string): void => {
    onSelect(id);
    items.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (renaming !== null || event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
    // A key an input method is composing with is the input method's (i18n §7.3).
    if (event.nativeEvent.isComposing) return;
    const facts = keyFacts(event);
    const at = rows.findIndex((row) => row.node.id === focusId);
    const row = rows[at];
    if (row === undefined) return;
    const key = chordKey(facts.key, facts.code);
    let handled = true;
    if (readOnly && (facts.alt || key === 'F2' || key === ' ' || key === 'm')) handled = false;
    else if (facts.alt && key === 'ArrowUp') onMove(row.node.id, -1);
    else if (facts.alt && key === 'ArrowDown') onMove(row.node.id, 1);
    else if (key === 'ArrowDown') focusRow(rows[Math.min(rows.length - 1, at + 1)]?.node.id ?? row.node.id);
    else if (key === 'ArrowUp') focusRow(rows[Math.max(0, at - 1)]?.node.id ?? row.node.id);
    else if (key === 'Home') focusRow(rows[0]?.node.id ?? row.node.id);
    else if (key === 'End') focusRow(rows[rows.length - 1]?.node.id ?? row.node.id);
    else if (key === 'ArrowRight' && row.hasChildren) onToggleCollapsed(row.node.id);
    else if (key === 'ArrowLeft' && row.hasChildren) onToggleCollapsed(row.node.id);
    else if (key === 'F2') onRename(row.node.id);
    else if (key === ' ') onExclude(row.node.id);
    else if ((facts.ctrl || facts.meta) && key === 'm') onMerge(row.node.id);
    else handled = false;
    if (handled) event.preventDefault();
  };

  return (
    <div className="import-preview-binder">
      <h3 id="import-preview-binder-label">Binder (proposed)</h3>
      {readOnly ? null : <p className="import-preview-hint">Arrows move, F2 renames, Space leaves out, Alt+arrows reorder, Ctrl+M merges with the next.</p>}
      <ul role="tree" aria-labelledby="import-preview-binder-label" className="import-preview-tree" onKeyDown={onKeyDown}>
        {rows.map((row) => {
          const { node } = row;
          const excluded = isExcluded(edits, tree, node.id);
          const canMerge = node.role === 'chapter' || node.role === 'part';
          return (
            <li
              key={node.id}
              ref={(element) => {
                if (element === null) items.current.delete(node.id);
                else items.current.set(node.id, element);
              }}
              role="treeitem"
              aria-level={row.level}
              aria-setsize={row.setSize}
              aria-posinset={row.position}
              aria-selected={node.id === selected}
              {...(row.hasChildren ? { 'aria-expanded': true } : {})}
              tabIndex={node.id === focusId ? 0 : -1}
              className={`import-preview-row is-${node.role}${excluded ? ' is-excluded' : ''}${node.id === selected ? ' is-selected' : ''}`}
              data-level={row.level}
              onClick={() => onSelect(node.id)}
              onDoubleClick={() => {
                if (!readOnly) onRename(node.id);
              }}
            >
              {readOnly ? null : <input type="checkbox" aria-label={`Import ${node.title}`} checked={!excluded} onChange={() => onExclude(node.id)} onClick={(event) => event.stopPropagation()} />}
              {renaming === node.id ? (
                <InlineText initial={node.title} label={`Rename ${node.title}`} onCommit={(title) => onRenamed(node.id, title)} onCancel={() => onRenamed(node.id, '')} />
              ) : (
                <span className="import-preview-title">{node.title}</span>
              )}
              <span className="import-preview-muted">
                {' '}
                {ROLE_WORDS[node.role]} · {formatCount(node.words)} words
              </span>
              {canMerge && !readOnly ? (
                <button type="button" className="button is-quiet" aria-label={`Merge ${node.title} with the next`} onClick={(event) => {
                  event.stopPropagation();
                  onMerge(node.id);
                }}>
                  Merge
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The text pane: only the blocks in view are rendered; the spacers above and below keep the scroll height of the whole. */
function TextPane({
  readOnly,
  blocks,
  markers,
  scrollTo,
  onRemoveSplit,
  onAddSplit,
  onSelectBlock,
}: {
  readOnly: boolean;
  blocks: readonly PreviewBlock[];
  markers: readonly PreviewMarker[];
  scrollTo: { readonly block: number; readonly seq: number } | null;
  onRemoveSplit: (block: number) => void;
  onAddSplit: (block: number, kind: 'scene' | 'chapter') => void;
  onSelectBlock: (block: number) => void;
}): ReactNode {
  const pane = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 480 });
  const [measured, setMeasured] = useState<ReadonlyMap<number, number>>(new Map());
  const observer = useRef<ResizeObserver | null>(null);
  const byBlock = useMemo(() => new Map(markers.map((marker) => [marker.blockIndex, marker] as const)), [markers]);
  const offsets = useMemo(() => offsetsOf(blocks.map((block, index) => measured.get(index) ?? estimateHeight(block) + (byBlock.has(index) ? 30 : 0))), [blocks, measured, byBlock]);
  const range = visibleRange(offsets, view.top, view.height);

  // One observer for the rendered rows: a row's real height replaces its estimate, so the spacers stay true as the writer scrolls.
  useEffect(() => {
    const watch = new ResizeObserver((entries) => {
      setMeasured((current) => {
        let next: Map<number, number> | null = null;
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset['block']);
          const height = (entry.target as HTMLElement).offsetHeight;
          if (Number.isNaN(index) || height === 0 || current.get(index) === height) continue;
          next ??= new Map(current);
          next.set(index, height);
        }
        return next ?? current;
      });
    });
    observer.current = watch;
    return () => watch.disconnect();
  }, []);

  // The pane's own size and scroll, so the window of rendered blocks follows it.
  useEffect(() => {
    const element = pane.current;
    if (element === null) return;
    const watch = new ResizeObserver(() => setView({ top: element.scrollTop, height: element.clientHeight }));
    watch.observe(element);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (scrollTo === null) return;
    const element = pane.current;
    if (element === null) return;
    element.scrollTop = offsets[scrollTo.block] ?? 0;
    // Only a new request scrolls; a re-measure must not pull the pane back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTo]);

  const indices = Array.from({ length: Math.max(0, range.end - range.start) }, (_, offset) => range.start + offset);
  const rendered = indices.map((index) => {
    const block = blocks[index] as PreviewBlock;
    const marker = byBlock.get(index);
    return (
      <div
        key={index}
        data-block={index}
        className={`import-preview-block is-${block.kind}`}
        ref={(element) => {
          if (element !== null) observer.current?.observe(element);
        }}
      >
        {marker === undefined ? (
          index === 0 || readOnly ? null : (
            <div className="import-preview-gap">
              <button type="button" className="button is-quiet" onClick={() => onAddSplit(index, 'scene')}>
                + split here
              </button>
              <button type="button" className="button is-quiet" onClick={() => onAddSplit(index, 'chapter')}>
                + chapter here
              </button>
            </div>
          )
        ) : (
          <div className={`import-preview-marker is-${marker.kind}`} role="note" aria-label={`Split: ${marker.kind}, because ${marker.reason}`}>
            <span aria-hidden="true">✂</span> {marker.kind === 'scene' ? 'scene' : marker.kind} · {marker.reason}
            {readOnly ? null : <button type="button" className="button is-quiet" aria-label={`Remove this split (${marker.reason})`} onClick={() => onRemoveSplit(index)}>
              ×
            </button>}
          </div>
        )}
        <p className="import-preview-text" onClick={() => onSelectBlock(index)}>
          {block.kind === 'break' || block.kind === 'pagebreak' ? <span className="import-preview-muted">{block.text === '' ? '(page break)' : block.text}</span> : block.text}
        </p>
      </div>
    );
  });

  return (
    <div className="import-preview-textpane">
      <h3>Text</h3>
      <div
        ref={pane}
        className="import-preview-scroll"
        role="region"
        aria-label="Text of the file"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          setView({ top: element.scrollTop, height: element.clientHeight });
        }}
      >
        <div style={{ height: `${offsets[range.start] ?? 0}px` }} aria-hidden="true" />
        {rendered}
        <div style={{ height: `${Math.max(0, (offsets[blocks.length] ?? 0) - (offsets[range.end] ?? 0))}px` }} aria-hidden="true" />
      </div>
    </div>
  );
}
