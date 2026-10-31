import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImportBlock, ImportDocument, ProposedNode, Signals } from '../src/index.js';

export function fixture(name: string): ImportDocument {
  return JSON.parse(readFileSync(resolve(__dirname, 'fixtures', `${name}.json`), 'utf8')) as ImportDocument;
}

/** The proposed tree as indented lines: `role: title`, with the story part and keywords when set. Scenes carry no word counts. */
export function outline(nodes: ProposedNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const extra = [node.kind === 'folder' && node.storyPart ? ` [${node.storyPart}]` : '', node.kind === 'folder' && node.keywords ? ` {${node.keywords.join(', ')}}` : ''].join('');
    const line = `${'  '.repeat(depth)}${node.role}: ${node.title}${extra}`;
    return node.kind === 'folder' ? [line, ...outline(node.children, depth + 1)] : [line];
  });
}

const FILLER = 'The ferry came at noon and the keeper watched it cross the grey water while gulls wheeled over the rocks.';

/** A paragraph of about `words` words (multiples of 20). */
export function prose(words = 40): string {
  const out: string[] = [];
  for (let w = 0; w < words; w += 20) out.push(FILLER);
  return out.join(' ');
}

export const p = (text: string = prose(), src?: Signals): ImportBlock => (src ? { kind: 'para', md: text, text, src } : { kind: 'para', md: text, text });
export const h = (level: number, text: string, src?: Signals): ImportBlock =>
  src ? { kind: 'heading', level, text, md: `${'#'.repeat(level)} ${text}`, src } : { kind: 'heading', level, text, md: `${'#'.repeat(level)} ${text}` };
export const br = (marker = '***'): ImportBlock => ({ kind: 'break', marker });
export const pb = (): ImportBlock => ({ kind: 'pagebreak' });
export const empty = (): ImportBlock => ({ kind: 'para', md: '', text: '' });
