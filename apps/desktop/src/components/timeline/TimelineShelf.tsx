/**
 * The shelf of scenes that have no day ([timeline.md §3.7](docs/architecture/timeline.md)): chains of scenes that follow each
 * other first, in the order they follow, then the loose ones. Nothing here is given a day. A chain step is announced with its place:
 * "chain 2, step 3 of 5, after ‘Storm’".
 */

import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { Chain, TimelineItem, TimelineLabels, TimelineModel } from '@caotang/timeline';

import { SEVERITY_GLYPH, SHELF_LIMIT, badgeOf } from '../../app/timeline-model.js';
import { accessibleText } from '../../i18n/accessible-text.js';
import { formatCount } from './timeline-count.js';
import { UserText } from '../../i18n/UserText.js';

/* lingui-set comment="The shelf of scenes without a day. Interpolated values: chain, step, steps, after, name, count, part are positions and part words; title is a scene title." */

export interface TimelineShelfProps {
  readonly model: TimelineModel;
  readonly labels: TimelineLabels;
  readonly language: string | undefined;
  readonly selected: ReadonlySet<string>;
  readonly activeDocId: string | null;
  readonly focusKey: string | undefined;
  readonly onFocusKey: (key: string) => void;
  readonly onToggle: (nodeId: string) => void;
  readonly onOpen: (nodeId: string) => void;
  readonly onOpenAgenda: () => void;
  /** A press on a scene: a drag from here onto the story axis proposes its day. */
  readonly onGrab?: (event: ReactPointerEvent<HTMLElement>, item: TimelineItem) => void;
}

interface Row {
  readonly item: TimelineItem;
  readonly description: string;
  readonly cycle: boolean;
}

function chainRows(chain: Chain, index: number, labels: TimelineLabels): Row[] {
  const steps = chain.steps.length;
  return chain.steps.map((step, at) => {
    const pieces = [t`chain ${{ chain: index + 1 }}, step ${{ step: at + 1 }} of ${{ steps }}`];
    const previous = chain.steps[at - 1];
    if (previous !== undefined) {
      const title = `\u2018${previous.item.title}\u2019`;
      pieces.push(t`after ${{ title }}`);
    } else if (step.anchor !== undefined) pieces.push(step.anchor.hint);
    if (step.inCycle) pieces.push(t`in a circle of scenes that each follow the next`);
    pieces.push(labels.partName(chain.part));
    return { item: step.item, description: pieces.join(', '), cycle: step.inCycle };
  });
}

export function TimelineShelf(props: TimelineShelfProps): ReactNode {
  const { model, labels, language, selected, activeDocId, focusKey } = props;
  const { sequenced, loose } = model.unscheduled;
  const total = sequenced.reduce((sum, chain) => sum + chain.steps.length, 0) + loose.length;
  if (total === 0) return null;

  let budget = SHELF_LIMIT;
  const shownChains: { chain: Chain; index: number; rows: Row[] }[] = [];
  sequenced.forEach((chain, index) => {
    if (budget <= 0) return;
    const rows = chainRows(chain, index, labels).slice(0, budget);
    budget -= rows.length;
    shownChains.push({ chain, index, rows });
  });
  const looseShown = budget > 0 ? loose.slice(0, budget) : [];
  const shown = shownChains.reduce((sum, entry) => sum + entry.rows.length, 0) + looseShown.length;

  const button = (row: Row | { item: TimelineItem; description: string; cycle: boolean }): ReactNode => {
    const { item } = row;
    const badge = badgeOf(item.findings);
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        props.onOpen(item.nodeId);
      }
    };
    const name = `${item.a11yLabel}${row.description === '' ? '' : `, ${row.description}`}`;
    return (
      <button
        type="button"
        className={`tl-shelf-item${selected.has(item.nodeId) ? ' is-selected' : ''}${row.cycle ? ' is-cycle' : ''}`}
        data-key={item.key}
        data-node={item.nodeId}
        aria-pressed={selected.has(item.nodeId)}
        aria-current={item.nodeId === activeDocId ? 'true' : undefined}
        aria-label={accessibleText(name)}
        onFocus={() => props.onFocusKey(item.key)}
        onPointerDown={props.onGrab === undefined ? undefined : (event) => props.onGrab?.(event, item)}
        onClick={() => props.onToggle(item.nodeId)}
        onDoubleClick={() => props.onOpen(item.nodeId)}
        onKeyDown={onKeyDown}
        data-focused={focusKey === item.key ? 'true' : undefined}
      >
        <span aria-hidden="true" className="tl-glyph">
          {row.cycle ? '\u2715' : item.glyph.glyph}
        </span>
        <UserText value={item.label} lang={language} />
        {badge === undefined ? null : (
          <span aria-hidden="true" className={`tl-badge is-${badge.severity}`}>
            {SEVERITY_GLYPH[badge.severity]}
            {badge.count}
          </span>
        )}
      </button>
    );
  };

  return (
    <section className="tl-shelf" aria-label={t`Scenes without a day`} data-testid="timeline-shelf">
      <h3 className="tl-shelf-title">
        {t`Scenes without a day`} <span className="tl-count">{formatCount(total)}</span>
      </h3>
      {shownChains.map(({ chain, index, rows }) => {
        const number = index + 1;
        const part = labels.partName(chain.part);
        return (
          <div key={chain.id} role="group" aria-label={t`Chain ${{ number }}: ${{ part }}`} className="tl-chain" data-part={chain.part}>
            <p className="tl-chain-title">
              {chain.cycle ? <Trans>Chain {number} is broken: some scenes follow each other in a circle.</Trans> : <Trans>Chain {number}</Trans>}{' '}
              <span className="tl-part">{part}</span>
            </p>
            <ol className="tl-chain-steps">
              {rows.map((row) => (
                <li key={row.item.key}>{button(row)}</li>
              ))}
            </ol>
          </div>
        );
      })}
      {looseShown.length > 0 ? (
        <ul className="tl-loose" aria-label={t`Loose scenes, in reading order`}>
          {looseShown.map((item) => (
            <li key={item.key}>{button({ item, description: labels.partName(item.part), cycle: false })}</li>
          ))}
        </ul>
      ) : null}
      {shown < total ? (
        <p className="field-note">
          {t`Showing ${{ shown: formatCount(shown) }} of ${plural(total, { one: '# scene', other: '# scenes' })}.`}{' '}
          <button type="button" className="button is-quiet" onClick={props.onOpenAgenda}>
            <Trans>See them all in the Agenda</Trans>
          </button>
        </p>
      ) : null}
    </section>
  );
}
