/**
 * What the approval card says besides the call (extensibility §4 rule 5, issue #54): the outside text the turn read, the project text the
 * arguments quote, the lead sentence of the cross-server shape and the second click. All of it is information; none of it refuses a call.
 */

import { describe, expect, it } from 'vitest';

import { approvalCardFor, cautionOf, type ExternalToolDescriptor } from '../src/index.js';

const TOOL = {
  qualifiedName: 'mcp__s_WIKI__write_page',
  serverKey: 's_WIKI',
  serverName: 'Wiki',
  toolName: 'write_page',
  description: 'Writes a page.',
  inputSchema: { type: 'object' },
  candidateHash: 'h',
  pinState: 'pinned',
  enabled: true,
  effectiveRisk: 'write-confirm',
} as unknown as ExternalToolDescriptor;

const QUOTE = { nodeId: 'n_1', title: 'Chapter 3', words: 14, argPath: 'args.body' };
const FROM_BIBLE = { serverName: 'Story Bible', label: 'Story Bible › search' };

describe('cautionOf', () => {
  it('says nothing when there is nothing to say', () => {
    expect(cautionOf('Wiki', {})).toBeUndefined();
  });

  it('names what the turn read, and asks for no second click without a quotation', () => {
    expect(cautionOf('Wiki', { followsUntrusted: [FROM_BIBLE, FROM_BIBLE] })).toEqual({ followsUntrusted: ['Story Bible › search'], quotes: [], hits: [], requiresSecondClick: false });
  });

  it('asks for a second click when the arguments quote the project, with no lead when the turn read nothing from another server', () => {
    const caution = cautionOf('Wiki', { quotes: [QUOTE], followsUntrusted: [{ serverName: 'Wiki', label: 'Wiki › search' }] });
    expect(caution?.requiresSecondClick).toBe(true);
    expect(caution?.lead).toBeUndefined();
  });

  it('leads with the cross-server sentence when project text would go to one server after content from another', () => {
    expect(cautionOf('Wiki', { quotes: [QUOTE], followsUntrusted: [FROM_BIBLE] })?.lead).toBe('This call would send text from “Chapter 3” to “Wiki” after reading content from “Story Bible”.');
    expect(cautionOf('Wiki', { quotes: [QUOTE, { ...QUOTE, nodeId: 'n_2', title: 'Chapter 4' }], followsUntrusted: [FROM_BIBLE] })?.lead).toContain('“Chapter 3” and 1 more');
  });
});

describe('approvalCardFor', () => {
  it('keeps the contract of the card and adds the second click, false when nothing is quoted', () => {
    const card = approvalCardFor(TOOL, { body: 'x' }, false);
    expect(card).toMatchObject({ badge: 'write', requiresConfirm: true, requiresSecondClick: false });
    expect(card.quotes).toBeUndefined();
  });

  it('carries the quotes, the hits, the sources and the lead', () => {
    const card = approvalCardFor(TOOL, { body: 'x' }, false, { quotes: [QUOTE], followsUntrusted: [FROM_BIBLE], hits: [{ kind: 'override-phrase', excerpt: 'ignore previous instructions' }] });
    expect(card.requiresSecondClick).toBe(true);
    expect(card.quotes).toEqual([QUOTE]);
    expect(card.hits).toHaveLength(1);
    expect(card.followsUntrusted).toEqual(['Story Bible › search']);
    expect(card.lead).toContain('after reading content from “Story Bible”');
    expect(card.argumentsJson).toBe(JSON.stringify({ body: 'x' }, null, 2));
  });
});
