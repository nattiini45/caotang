/**
 * The dialogue view — dialogue-narrative.md §3 and §5. A dialogue container shows its branching structure as a graph
 * (knots and stitches as cards, choices and diverts as arrows) beside an outline, with each loose end and dead end
 * marked on the node it sits in. The Ink text is edited in this view, below the outline, through the session's autosave
 * (the path the prose editor uses), and the graph and the findings are read from that text once the writer pauses.
 */

import { accessibleText } from '../i18n/accessible-text.js';
import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import { getBody, getRevision, type TreeNode } from '@caotang/store';

import type { ProjectSession } from '../app/session.js';
import type { RevealRequest } from '../components/EditorPane.js';
import { useReport, useSession } from '../components/shared.js';
import { LAYOUT_COLUMN_WIDTH, LAYOUT_ROW_HEIGHT, readDialogueMeta, type DialogueFinding } from './engines.js';
import { caretOfNode, dialogueModelOf, type DialogueModel, type OutlineNode } from './dialogue-model.js';
import { useCodexEntries } from './hooks.js';
import {
  INK_IDLE_MS,
  addLineIds,
  addLineIdsLabel,
  addLineIdsSentence,
  confirmLineIdsSentence,
  linesMissingIds,
  textOnSave,
} from './ink-model.js';
import { knotCompletion } from './ink-keys.js';
import { SourceField } from './SourceField.js';
import { inkSegments } from './source-decor.js';
import { caretAfterEdit, isOwnWrite } from './rebase-model.js';
import { saveLineOf, unwrittenFlushOf } from './screenplay-model.js';


/* lingui-set comment="The dialogue view. Interpolated values: title, name, condition, targets and expected are the writer's own Ink text or names; line is a line number; counts are numbers." */
export interface DialogueViewProps {
  readonly session: ProjectSession;
  /** The dialogue container. */
  readonly node: TreeNode;
  /** A passage a finding quotes, when it is in this container (coherence.md §8). The view selects it and then calls `onRevealHandled`. */
  readonly reveal?: RevealRequest | null;
  readonly onRevealHandled?: () => void;
}

/** Inset of a card inside its layout cell, so the arrows have room between cards. */
const CARD_INSET = 16;

/** The longest a choice's label reads on its edge. The full label is the edge's tooltip, and the choices list shows it whole. */
const EDGE_LABEL_CHARS = 28;

const NOOP = (): void => undefined;

export function DialogueView({ session, node, reveal = null, onRevealHandled = NOOP }: DialogueViewProps): ReactNode {
  useLingui();
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
  // The codex is read through the hook: a memo keyed on the store's array would keep the speakers it read before a rename or an alias
  // The model reads the same entries the Findings scan reads, through the same speaker resolution.
  const codex = useCodexEntries(session);
  const autoLineIds = readDialogueMeta(node.dialogue).meta.autoLineIds === true;
  // What the writer has typed (`draft`), and the text the graph and findings are read from (`live`). `live` catches up
  // when the writer pauses, so the parse is not redone on every keystroke (dialogue-narrative.md §3).
  const [draft, setDraft] = useState(stored);
  const [live, setLive] = useState(stored);
  const [confirming, setConfirming] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inkField = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once the idle mint has rewritten the text it sat in (see the layout effect below).
  const caretAt = useRef<number | null>(null);
  const rebases = useRef(0);
  // The body and revision this view last agreed with the store, so an effect tells its own write from a change made
  // underneath it, the way the screenplay view does.
  const [opened] = useState(() => ({ body: stored, revision }));
  const synced = useRef<{ body: string; revision: number }>(opened);
  const model = useMemo(() => dialogueModelOf(docId, live, codex), [live, codex, docId]);
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked !== null && model.outline.some((item) => item.id === picked) ? picked : model.entry;
  const selected = model.outline.find((item) => item.id === selectedId) ?? model.outline[0] ?? null;
  const flagged = model.outline.filter((item) => item.findings.length > 0);
  // The Ink source's decorations, from the draft as the writer typed it (dialogue-narrative.md §3): a knot header, a choice and
  // a divert are styled on the keystroke, and no reparse waits for the pause the graph waits for.
  const inkSegmentsOf = useMemo(() => inkSegments(draft), [draft]);

  // Open the container on the session's autosave, at the revision the store holds, and flush it when the view goes. A
  // flush that did not write is named on the status line, because nothing on screen is left to say so.
  useEffect(() => {
    session.autosave.open(docId, opened);
    return () => {
      if (idle.current !== null) clearTimeout(idle.current);
      idle.current = null;
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
      // A pause that was still waiting on the text the store just replaced has nothing left to mint into.
      if (idle.current !== null) clearTimeout(idle.current);
      idle.current = null;
      setDraft(stored);
      setLive(stored);
      setConfirming(false);
    });
  }, [session, docId, stored, revision]);

  // The idle mint can rewrite the text under the caret, because ids are written at line ends. The caret the mint computed
  // (see onSourceChange) is put back once the text it was computed for is on screen, so a writer who paused and went on
  // typing does not land at the end of the text.
  useLayoutEffect(() => {
    const at = caretAt.current;
    const field = inkField.current;
    if (at === null || field === null) return;
    caretAt.current = null;
    field.setSelectionRange(at, at);
  }, [draft]);

  /** Each keystroke is written through the autosave; the graph and findings follow once the writer pauses. */
  const onSourceChange = (text: string): void => {
    setDraft(text);
    session.autosave.noteEdit(docId, text);
    if (idle.current !== null) clearTimeout(idle.current);
    idle.current = setTimeout(() => {
      idle.current = null;
      // On this cadence the container's own rule applies: with autoLineIds on, the ids are minted into the text the writer sees.
      const kept = textOnSave(text, autoLineIds);
      if (kept.text !== text) {
        caretAt.current = caretAfterEdit(text, kept.text, inkField.current?.selectionStart ?? text.length);
        setDraft(kept.text);
        session.autosave.noteEdit(docId, kept.text);
      }
      setLive(kept.text);
    }, INK_IDLE_MS);
  };

  /**
   * Tab after a divert arrow completes the knot or stitch the writer has started (dialogue-narrative.md §3). A Tab with no
   * name to complete keeps its meaning, which moves focus.
   */
  const onInkKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const field = event.currentTarget;
    if (field.selectionStart !== field.selectionEnd) return;
    // The knots are read from the text as it is at the keypress: the graph catches up with the text only when the writer pauses.
    const knots = dialogueModelOf(docId, field.value, codex).targets;
    const edit = knotCompletion(field.value, field.selectionStart, knots);
    if (edit === null) return;
    event.preventDefault();
    caretAt.current = edit.caret;
    onSourceChange(edit.text);
  };

  /**
   * A graph card chosen: the card is selected, and the caret goes to the header of its knot or stitch in the Ink text, which is
   * where the writer edits it (dialogue-narrative.md §3, "click = jump to the knot's line in the text"). The offset is read from the
   * text on screen, because the graph is drawn from the text the writer last paused on.
   */
  const chooseNode = (id: string): void => {
    setPicked(id);
    const at = caretOfNode(docId, draft, codex, id);
    const field = inkField.current;
    if (at === null || field === null) return;
    field.focus();
    field.setSelectionRange(at, at);
  };

  /**
   * A passage a finding quotes (coherence.md §8): the passage is selected in the Ink text, where the writer edits it, and the request is
   * answered. The offsets are the stored body's; the view's text is the same text until the writer types, and a finding whose quote has
   * moved is not offered a reveal (findings-model's quoteIsCurrent).
   */
  useEffect(() => {
    if (reveal === null || reveal.docId !== docId) return;
    const field = inkField.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(reveal.from, reveal.to);
    onRevealHandled();
  }, [reveal, docId, onRevealHandled]);

  /** The confirmed action. The writer asked for it and saw the count, so the text it writes is the text they approved. */
  const addIds = (): void => {
    if (idle.current !== null) clearTimeout(idle.current);
    idle.current = null;
    const result = addLineIds(draft);
    setConfirming(false);
    if (result.text !== draft) {
      setDraft(result.text);
      session.autosave.noteEdit(docId, result.text);
    }
    setLive(result.text);
    report({ text: addLineIdsSentence(result), tone: result.unplaceable.length > 0 ? 'error' : 'info' });
  };

  const missing = linesMissingIds(draft);
  const save = session.autosave.status(docId);

  return (
    <section className="media-view dlg-view" aria-label={accessibleText(t`Dialogue: ${{ title: isolate(node.title) }}`)}>
      <header className="media-head">
        <div>
          <p className="eyebrow"><Trans>Dialogue container</Trans></p>
          <h2 className="media-title">{node.title}</h2>
        </div>
        <ul className="dlg-stats" aria-label={t`Structure`}>
          <li className="chip">{countLabel(model.stats.knots, 'knot')}</li>
          <li className="chip">{countLabel(model.stats.stitches, 'stitch', 'stitches')}</li>
          <li className="chip">{countLabel(model.stats.choices, 'choice')}</li>
          <li className="chip">{countLabel(model.findings.length, 'finding')}</li>
        </ul>
      </header>

      {model.errors.length === 0 ? null : (
        <section className="dlg-errors" role="alert" aria-label={t`Compile errors`}>
          <p><Trans>The Ink does not compile. Fix these errors in the Ink text below.</Trans></p>
          <ul className="findings">
            {model.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="dlg-layout">
        <div className="dlg-canvas-wrap" aria-label={t`Branch graph`}>
          <Graph model={model} selectedId={selectedId} onSelect={chooseNode} />
        </div>

        <aside className="dlg-side" aria-label={t`Outline and findings`}>
          {model.findings.length === 0 ? (
            <p className="muted"><Trans>No loose end, dead end or unknown speaker in this container.</Trans></p>
          ) : (
            <section className="inspector-section" aria-label={t`Findings`}>
              <h3 className="field-label"><Trans>Findings</Trans></h3>
              <ul className="dlg-findings">
                {flagged.flatMap((item) =>
                  item.findings.map((finding, index) => (
                    <li key={`${item.id}:${index}`}>
                      <button type="button" className="dlg-finding" onClick={() => setPicked(item.id)}>
                        <FindingBadge finding={finding} />
                        <span>{finding.message}</span>
                      </button>
                    </li>
                  )),
                )}
              </ul>
            </section>
          )}

          {selected === null ? null : <NodeDetail item={selected} />}

          {model.notes.length === 0 && model.parseWarnings.length === 0 && model.variables.length === 0 ? null : (
            <section className="inspector-section" aria-label={t`Declarations and notes`}>
              {model.variables.length === 0 ? null : (
                <>
                  <h3 className="field-label"><Trans>Variables</Trans></h3>
                  <ul className="keyword-list">
                    {model.variables.map((variable) => (
                      <li key={variable} className="chip">
                        {variable}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {[...model.parseWarnings, ...model.notes].map((note) => (
                <p key={note} className="muted">
                  {note}
                </p>
              ))}
            </section>
          )}

          <section className="inspector-section dlg-source-edit" aria-label={t`The Ink text`}>
            <div className="dlg-source-head">
              <h3 className="field-label"><Trans>The Ink text</Trans></h3>
              {missing === 0 || confirming ? null : (
                <button type="button" className="button is-quiet" onClick={() => setConfirming(true)}>
                  {plural(missing, { one: 'Add line ids to # line', other: 'Add line ids to # lines' })}
                </button>
              )}
            </div>
            {confirming ? (
              <div className="dlg-confirm" role="group" aria-label={t`Confirm adding line ids`}>
                <p className="field-note">{confirmLineIdsSentence(missing)}</p>
                <button type="button" className="button" onClick={addIds}>
                  {addLineIdsLabel(missing)}
                </button>
                <button type="button" className="button is-quiet" onClick={() => setConfirming(false)}>
                  <Trans>Cancel</Trans>
                </button>
              </div>
            ) : null}
            <SourceField
              label={t`Ink source`}
              inputRef={inkField}
              inputClassName="notes ink-source"
              rows={14}
              value={draft}
              segments={inkSegmentsOf}
              onChange={onSourceChange}
              onKeyDown={onInkKeyDown}
            />
            <p className="counter" role="status">
              {saveLineOf(save)}
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** A choice's label cut to the room an edge has, with an ellipsis. The whole label is the edge's tooltip, and the choices list shows it whole. */
function shortLabelOf(label: string): string {
  const chars = [...label];
  return chars.length <= EDGE_LABEL_CHARS ? label : `${chars.slice(0, EDGE_LABEL_CHARS - 1).join('')}…`;
}

interface GraphProps {
  readonly model: DialogueModel;
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}

/** The layered graph: the engine's placement for each card, arrows between cards, and no drag (view-only, §3). */
function Graph({ model, selectedId, onSelect }: GraphProps): ReactNode {
  const { layout } = model;
  const placed = new Map(layout.placements.map((placement) => [placement.id, placement]));
  const byId = new Map(model.outline.map((item) => [item.id, item]));
  const cardWidth = LAYOUT_COLUMN_WIDTH - CARD_INSET * 2;
  const cardHeight = LAYOUT_ROW_HEIGHT - CARD_INSET * 2;

  return (
    <div className="dlg-canvas" style={{ width: layout.width, height: layout.height }}>
      <svg className="dlg-edges" width={layout.width} height={layout.height} aria-hidden="true">
        <defs>
          <marker id="dlg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="dlg-arrowhead" />
          </marker>
        </defs>
        {model.edges.map((edge) => {
          const from = placed.get(edge.from);
          const to = placed.get(edge.to);
          if (from === undefined || to === undefined) return null;
          const x1 = from.x + LAYOUT_COLUMN_WIDTH / 2;
          const y1 = from.y + LAYOUT_ROW_HEIGHT - CARD_INSET;
          const x2 = to.x + LAYOUT_COLUMN_WIDTH / 2;
          const y2 = to.y + CARD_INSET;
          const bend = Math.max(24, Math.abs(y2 - y1) / 2);
          // The curve's midpoint is the mean of its two ends, which is where a choice's label sits on the edge (§3: choice labels as edges).
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          return (
            <g key={`${edge.kind}:${edge.from}:${edge.to}:${edge.label}`}>
              <path d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`} className={`dlg-edge is-${edge.kind}`} markerEnd="url(#dlg-arrow)" />
              {edge.kind === 'choice' && edge.label !== '' ? (
                <text className="dlg-edge-label" x={midX} y={midY} textAnchor="middle" dominantBaseline="central">
                  <title>{edge.label}</title>
                  {shortLabelOf(edge.label)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {layout.placements.map((placement) => {
        const item = byId.get(placement.id);
        if (item === undefined) return null;
        const style: CSSProperties = {
          left: placement.x + CARD_INSET,
          top: placement.y + CARD_INSET,
          width: cardWidth,
          height: cardHeight,
        };
        const flagged = item.findings.length > 0;
        return (
          <button
            key={item.id}
            type="button"
            className={`dlg-node${item.id === selectedId ? ' is-selected' : ''}${item.reached ? '' : ' is-unreached'}${flagged ? ' is-flagged' : ''}`}
            style={style}
            aria-pressed={item.id === selectedId}
            aria-label={`${item.name}: ${countLabel(item.lines.length, 'line')}, ${countLabel(item.choices.length, 'choice')}${flagged ? ', has a finding' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            <span className="dlg-node-name">{item.name}</span>
            <span className="dlg-node-meta">
              {countLabel(item.lines.length, 'line')} · {countLabel(item.choices.length, 'choice')}
            </span>
            {item.findings.map((finding, index) => (
              <FindingBadge key={index} finding={finding} />
            ))}
          </button>
        );
      })}
    </div>
  );
}

/** The node's own content, read from the parse: its lines, its choices and its diverts. */
function NodeDetail({ item }: { readonly item: OutlineNode }): ReactNode {
  useLingui();
  const line = item.line;
  const where = item.kind === 'root' ? t`The first lines of the container.` : t`Line ${line}`;
  return (
    <section className="inspector-section dlg-detail" aria-label={accessibleText(t`Node ${{ name: isolate(item.name) }}`)}>
      <p className="eyebrow">{item.kind === 'stitch' ? t`Stitch` : item.kind === 'knot' ? t`Knot` : t`Top of the body`}</p>
      <h3 className="inspector-title">{item.name}</h3>
      <p className="inspector-meta">
        {item.reached ? where : t`${where} · no divert or choice reaches it`}
      </p>
      {item.lines.length === 0 ? (
        <p className="muted"><Trans>No spoken line in this node.</Trans></p>
      ) : (
        <ol className="dlg-lines">
          {item.lines.map((line) => (
            <li key={line.line} className={line.kind === 'choice' ? 'is-choice' : undefined}>
              {line.speaker === null ? null : <span className="chip chip-label">{line.speaker}</span>} {line.text}
              {line.lineId === null ? null : <code className="dlg-line-id">{line.lineId}</code>}
            </li>
          ))}
        </ol>
      )}
      {item.choices.length === 0 ? null : (
        <ul className="dlg-choices" aria-label={t`Choices`}>
          {item.choices.map((choice) => (
            <li key={`${choice.line}:${choice.label}`}>
              “{choice.label}” → {choice.target}
              {choice.condition === null ? '' : ` ${t`when ${{ condition: choice.condition }}`}`}
              {choice.onceOnly ? ` ${t`(once)`}` : ''}
            </li>
          ))}
        </ul>
      )}
      {item.diverts.length === 0 ? null : <p className="muted">{t`Diverts to ${{ targets: item.diverts.join(', ') }}.`}</p>}
      {item.findings.map((finding, index) => (
        <p key={index} className="field-note">
          {finding.message}
          {finding.expected === undefined ? '' : ` ${t`Expected: ${{ expected: finding.expected }}.`}`}
        </p>
      ))}
    </section>
  );
}

function FindingBadge({ finding }: { readonly finding: DialogueFinding }): ReactNode {
  useLingui();
  const label = finding.checkId === 'branch.loose-end' ? t`Loose end` : finding.checkId === 'branch.dead-end' ? t`Unreached` : t`Unknown speaker`;
  return <span className={`badge ${finding.severity === 'warning' ? 'is-warn' : ''} dlg-badge`}>{label}</span>;
}
