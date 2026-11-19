import { type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { Button } from '@ui-sdk/react/button';
import { readCodexRelation } from '@caotang/bus';
import type { CodexEntry } from '@caotang/store';
import { isolate } from '@caotang/i18n';
import { formatCount } from './shared.js';
import './codex-graph.css';

const VIEW = 600;
const CENTRE = VIEW / 2;
const RADIUS = 218;
const NODE = 6;
/** Longer names are cut in the drawing only; the list beside it always shows the whole name. */
const NAME_CHARS = 18;

type Node = { readonly entry: CodexEntry; readonly x: number; readonly y: number };

type Edge = { readonly id: string; readonly from: Node; readonly to: Node; readonly label: string | undefined };

function nameIn(entry: CodexEntry | undefined, fallback: string): string {
  if (entry === undefined) return fallback;
  const characters = [...entry.name];
  return characters.length > NAME_CHARS ? `${characters.slice(0, NAME_CHARS - 1).join('')}…` : entry.name;
}

/**
 * The project's whole codex as one picture (codex.md §2.3, the owner's D3): every entry a node on a circle, every stored
 * relation an arrow from the entry that states it. The drawing is decoration for the sighted reader; the list under it is
 * the surface that keyboard and screen-reader users work, so nothing lives only in the drawing.
 */
export function CodexGraph({ entries, onOpen }: {
  readonly entries: readonly CodexEntry[];
  readonly onOpen: (entryId: string) => void;
}): ReactNode {
  useLingui();
  const nodes: Node[] = entries.map((entry, index) => {
    const angle = (2 * Math.PI * index) / Math.max(entries.length, 1) - Math.PI / 2;
    return { entry, x: CENTRE + RADIUS * Math.cos(angle), y: CENTRE + RADIUS * Math.sin(angle) };
  });
  const byId = new Map(nodes.map((node) => [node.entry.id, node] as const));
  const edges: Edge[] = nodes.flatMap((node) => (node.entry.relations ?? []).flatMap((value) => {
    const relation = readCodexRelation(value);
    const to = relation === undefined ? undefined : byId.get(relation.targetId);
    return relation === undefined || to === undefined ? [] : [{ id: relation.id, from: node, to, label: relation.label }];
  }));
  const outgoing = new Map<string, { target: CodexEntry | undefined; label: string | undefined; id: string }[]>();
  const incoming = new Map<string, CodexEntry[]>();
  for (const node of nodes) {
    for (const value of node.entry.relations ?? []) {
      const relation = readCodexRelation(value);
      if (relation === undefined) continue;
      const target = byId.get(relation.targetId)?.entry;
      outgoing.set(node.entry.id, [...(outgoing.get(node.entry.id) ?? []), { id: relation.id, target, label: relation.label }]);
      if (target !== undefined) incoming.set(target.id, [...(incoming.get(target.id) ?? []), node.entry]);
    }
  }
  const linked = nodes.filter((node) => (outgoing.get(node.entry.id)?.length ?? 0) > 0 || (incoming.get(node.entry.id)?.length ?? 0) > 0);
  const alone = nodes.length - linked.length;

  return (
    <div className="codex-graph">
      <p className="codex-graph-summary">
        {edges.length === 0
          ? <Trans>No entry links yet.</Trans>
          : t({ message: `${{ entries: formatCount(entries.length) }} entries with ${{ links: formatCount(edges.length) }} links.`, comment: 'entries counts codex entries and links the links between them; both are formatted numbers.' })}
      </p>

      {entries.length === 0 ? null : (
        <svg className="codex-graph-drawing" viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true" focusable="false">
          <defs>
            <marker id="codex-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="codex-graph-arrowhead" />
            </marker>
          </defs>
          {edges.map((edge) => (
            <line key={edge.id} className="codex-graph-edge" markerEnd="url(#codex-graph-arrow)"
              x1={edge.from.x} y1={edge.from.y} x2={edge.to.x} y2={edge.to.y} />
          ))}
          {nodes.map((node) => (
            <g key={node.entry.id}>
              <circle className="codex-graph-node" cx={node.x} cy={node.y} r={NODE} />
              <text className="codex-graph-name" x={node.x} y={node.y} textAnchor={node.x >= CENTRE ? 'start' : 'end'}
                dx={node.x >= CENTRE ? 12 : -12} dy={4}>
                {nameIn(node.entry, node.entry.name)}
              </text>
            </g>
          ))}
        </svg>
      )}

      {edges.length === 0 ? null : (
        <ul className="codex-graph-list" aria-label={t`Entries and their links`}>
          {linked.map((node) => (
            <li key={node.entry.id} className="codex-graph-item">
              <Button className="button is-plain codex-graph-entry" onClick={() => onOpen(node.entry.id)}>
                <span dir="auto">{node.entry.name}</span>
              </Button>
              {(outgoing.get(node.entry.id) ?? []).length === 0 ? null : (
                <ul className="codex-graph-links">
                  {(outgoing.get(node.entry.id) ?? []).map((link) => (
                    <li key={link.id}>
                      <Button className="button is-quiet codex-graph-link" disabled={link.target === undefined}
                        aria-label={link.target === undefined
                          ? t`Links to a missing entry.`
                          : t({ message: `Links to ${{ name: link.target.name }}.`, comment: 'name is the name of the codex entry the link points at.' })}
                        onClick={() => { if (link.target !== undefined) onOpen(link.target.id); }}>
                        <span className="codex-graph-arrow" aria-hidden="true">→</span>
                        <span dir="auto">{link.target === undefined ? t`A missing entry` : link.target.name}</span>
                      </Button>
                      {link.label === undefined ? null : <span className="codex-graph-label" dir="auto">{link.label}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {(incoming.get(node.entry.id) ?? []).length === 0 ? null : (
                <p className="codex-graph-back">
                  {t({ message: `Linked from ${{ names: isolate(incoming.get(node.entry.id)?.map((entry) => entry.name).join(', ') ?? '') }}.`, comment: 'names is the list of codex entry names that link to this entry.' })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {alone === 0 ? null : (
        <p className="codex-graph-back">
          {t({ message: `${{ count: formatCount(alone) }} entries link to nothing.`, comment: 'count is a number of codex entries that have no link in either direction.' })}
        </p>
      )}
    </div>
  );
}
