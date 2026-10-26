/**
 * The document resolver a slash command reads its arguments through: the title rule `doc.read` uses (resolve.ts), over the nodes the agent
 * may see. A node a read rule withholds is answered as a title that matches nothing, so a command cannot name it, and its title is not
 * listed as a candidate or written into the turn's intent (agent-harness §4, "Rules").
 */

import type { ProjectState } from '@caotang/store';

import { ANY_NODE, DOCUMENT, resolveNode } from '../resolve.js';
import type { DocResolver } from './slash.js';

export function docResolverFor(state: ProjectState, withheld: ReadonlySet<string> = new Set()): DocResolver {
  return (query, scope) => {
    const base = scope === 'document' ? DOCUMENT : ANY_NODE;
    const found = resolveNode(state, query, (node) => !withheld.has(node.id) && base(node), scope === 'document' ? 'document' : 'node', 'command');
    if (found.ok) return { id: found.value.id, title: found.value.title };
    const details = found.error.details as { candidates?: readonly { title: string }[] } | undefined;
    return details?.candidates === undefined ? undefined : { candidates: details.candidates.map((candidate) => candidate.title) };
  };
}
