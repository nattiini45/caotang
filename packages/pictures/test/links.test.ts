import { describe, expect, it } from 'vitest';

import {
  addLink,
  cascadeNodeDeletion,
  makeCard,
  mintLinkId,
  nextLinkOrder,
  placeLink,
  removeLink,
  reorderLinks,
  setLinkNote,
  targetKey,
} from '../src/links.js';
import type { AssetLink, ParagraphAnchor } from '../src/model.js';
import { cardAssetOf, linkedNodeIds, linksOf, linksToAsset } from '../src/uses.js';
import { readAssetLinks, validateAssetLink, validateLinkSet } from '../src/validate.js';

const A1 = 'a_AAAAAAAAA1';
const A2 = 'a_AAAAAAAAA2';

const anchor: ParagraphAnchor = { from: 0, to: 5, exact: 'Hello', prefix: '', suffix: ' there', capturedRevision: 1, blockHash: '0123456789abcdef', ordinal: 0 };

function link(id: string, over: Partial<AssetLink> = {}): AssetLink {
  return { id, assetId: A1, target: { kind: 'node', nodeId: 'n_1' }, role: 'reference', order: 10, ...over };
}

const ok = <T>(result: { ok: boolean; value?: T; issues?: unknown }): T => {
  expect(result.ok).toBe(true);
  return result.value as T;
};

describe('validating one link', () => {
  it('accepts project, node and paragraph targets', () => {
    expect(validateAssetLink(link('l_0000000001', { target: { kind: 'project' } })).ok).toBe(true);
    expect(validateAssetLink(link('l_0000000002')).ok).toBe(true);
    expect(validateAssetLink(link('l_0000000003', { target: { kind: 'paragraph', nodeId: 'n_1', anchor, orphaned: true, moved: true } })).ok).toBe(true);
  });

  it('accepts the reserved when field', () => {
    expect(validateAssetLink(link('l_0000000004', { when: { dayOffset: -12, label: 'the flood' } })).ok).toBe(true);
    expect(validateAssetLink({ ...link('l_0000000005'), when: { dayOffset: 1.5 } }).ok).toBe(false);
  });

  it('keeps cards to nodes', () => {
    expect(validateAssetLink(link('l_0000000006', { role: 'card' })).ok).toBe(true);
    expect(validateAssetLink(link('l_0000000007', { role: 'card', target: { kind: 'project' } })).ok).toBe(false);
    expect(validateAssetLink(link('l_0000000008', { role: 'card', target: { kind: 'paragraph', nodeId: 'n_1', anchor } })).ok).toBe(false);
  });

  it('refuses on a new write what a read would keep', () => {
    expect(validateAssetLink({ ...link('l_0000000009'), role: 'moodboard' }).ok).toBe(false);
    expect(validateAssetLink({ ...link('l_000000000A'), target: { kind: 'timeline-lane', lane: 2 } }).ok).toBe(false);
    expect(validateAssetLink({ ...link('l_000000000B'), extra: 1 }).ok).toBe(false);
    expect(validateAssetLink(link('l_000000000C', { note: 'x'.repeat(2001) })).ok).toBe(false);
    expect(validateAssetLink(link('bad-id')).ok).toBe(false);
    expect(validateAssetLink({ ...link('l_000000000D'), assetId: 'not-an-asset' }).ok).toBe(false);
    expect(validateAssetLink(link('l_000000000E', { order: -10 })).ok).toBe(false);
    expect(validateAssetLink(link('l_000000000F', { target: { kind: 'paragraph', nodeId: 'n_1', anchor: { ...anchor, ordinal: -1 } } })).ok).toBe(false);
  });
});

describe('reading links tolerantly', () => {
  it('keeps an unknown role and an unknown target kind as written', () => {
    const future = { id: 'l_0000000010', assetId: A1, target: { kind: 'timeline-lane', lane: 2 }, role: 'moodboard', order: 10, extra: { x: 1 } };
    const read = readAssetLinks([future, link('l_0000000011')]);
    expect(read.unreadable).toEqual([]);
    expect(read.links[0]).toEqual(future);
    expect(read.links[0]?.role).toBe('moodboard');
    expect(read.links[0]?.target.kind).toBe('timeline-lane');
  });

  it('hands back a link whose known target is malformed, untouched', () => {
    const broken = [
      { id: 'l_0000000012', assetId: A1, target: { kind: 'node' }, role: 'reference', order: 10 },
      { id: 'l_0000000013', assetId: A1, target: { kind: 'paragraph', nodeId: 'n_1', anchor: { from: 1 } }, role: 'reference', order: 10 },
      { id: 'l_0000000014', assetId: A1, role: 'reference', order: 10 },
      { id: 'x', assetId: A1, target: { kind: 'project' }, role: 'reference', order: 10 },
      'nope',
    ];
    const read = readAssetLinks(broken);
    expect(read.links).toEqual([]);
    expect(read.unreadable).toEqual(broken);
  });

  it('keeps an over-long note, drops a wrong-typed one, and reports both', () => {
    const long = 'n'.repeat(2500);
    const read = readAssetLinks([link('l_0000000015', { note: long }), { ...link('l_0000000016'), note: 5 }]);
    expect(read.links[0]?.note).toBe(long);
    expect(read.links[1]).not.toHaveProperty('note');
    expect(read.notices.map((n) => n.code).sort()).toEqual(['dropped', 'over-limit']);
  });

  it('reports a card conflict but keeps both links, and picks the first by order', () => {
    const read = readAssetLinks([link('l_0000000017', { role: 'card', order: 20 }), link('l_0000000018', { role: 'card', assetId: A2, order: 10 })]);
    expect(read.links).toHaveLength(2);
    expect(read.notices.some((n) => n.code === 'card-conflict')).toBe(true);
    expect(cardAssetOf(read.links, 'n_1')).toBe(A2);
  });

  it('keeps orphaned and moved paragraph links', () => {
    const p = link('l_0000000019', { target: { kind: 'paragraph', nodeId: 'n_1', anchor, orphaned: true } });
    expect(readAssetLinks([p]).links).toEqual([p]);
  });
});

describe('link sets', () => {
  it('allows the same picture at many targets', () => {
    const links = [
      link('l_0000000020', { target: { kind: 'project' } }),
      link('l_0000000021'),
      link('l_0000000022', { target: { kind: 'node', nodeId: 'n_2' } }),
      link('l_0000000023', { target: { kind: 'paragraph', nodeId: 'n_2', anchor } }),
    ];
    expect(validateLinkSet(links)).toEqual([]);
  });

  it('allows at most one card link per node, but one on each node', () => {
    const two = [link('l_0000000024', { role: 'card' }), link('l_0000000025', { role: 'card', assetId: A2, order: 20 })];
    expect(validateLinkSet(two)).toMatchObject([{ code: 'card-conflict' }]);
    const apart = [link('l_0000000026', { role: 'card' }), link('l_0000000027', { role: 'card', target: { kind: 'node', nodeId: 'n_2' } })];
    expect(validateLinkSet(apart)).toEqual([]);
  });

  it('reports duplicate ids and, given a context, dangling asset and node references', () => {
    const links = [link('l_0000000028'), link('l_0000000028', { assetId: A2, target: { kind: 'node', nodeId: 'n_9' } })];
    const issues = validateLinkSet(links, { assetIds: new Set([A1]), nodeIds: new Set(['n_1']) });
    expect(issues.map((i) => i.code).sort()).toEqual(['duplicate-id', 'unknown-asset', 'unknown-node']);
  });

  it('does not judge a link whose target kind it cannot read', () => {
    const read = readAssetLinks([{ id: 'l_0000000029', assetId: A1, target: { kind: 'timeline-lane', nodeId: 'n_9' }, role: 'card', order: 10 }]);
    expect(validateLinkSet(read.links, { nodeIds: new Set(['n_1']) }).map((i) => i.code)).toEqual(['card-target']);
  });
});

describe('adding, ordering and the card rule', () => {
  it('gap-encodes order within each target and keeps targets apart', () => {
    let links: AssetLink[] = [];
    const add = (nodeId: string | null, assetId = A1): AssetLink => {
      const edit = ok(addLink(links, { assetId, target: nodeId === null ? { kind: 'project' } : { kind: 'node', nodeId } }));
      links = edit.links as AssetLink[];
      return edit.link;
    };
    const a = add('n_1');
    const b = add('n_1', A2);
    const c = add('n_2');
    const d = add(null);
    expect([a.order, b.order, c.order, d.order]).toEqual([10, 20, 10, 10]);
    expect(nextLinkOrder(links, { kind: 'node', nodeId: 'n_1' })).toBe(30);
    expect(nextLinkOrder(links, { kind: 'node', nodeId: 'n_7' })).toBe(10);
    expect(new Set(links.map((l) => l.id)).size).toBe(4);
    expect(links.every((l) => /^l_[0-9A-HJKMNP-TV-Z]{10}$/.test(l.id))).toBe(true);
  });

  it('puts paragraph links in their own group', () => {
    const base = [link('l_0000000030')];
    const edit = ok(addLink(base, { assetId: A1, target: { kind: 'paragraph', nodeId: 'n_1', anchor } }));
    expect(edit.link.order).toBe(10);
    expect(targetKey({ kind: 'paragraph', nodeId: 'n_1', anchor })).toBe('paragraph:n_1');
  });

  it('refuses a second card for a node and names the holder', () => {
    const base = [link('l_0000000031', { role: 'card' })];
    const refused = addLink(base, { assetId: A2, target: { kind: 'node', nodeId: 'n_1' }, role: 'card' });
    expect(!refused.ok && refused.issues[0]).toMatchObject({ code: 'card-conflict' });
    expect(!refused.ok && refused.issues[0]?.message).toContain('l_0000000031');
    expect(addLink(base, { assetId: A2, target: { kind: 'node', nodeId: 'n_2' }, role: 'card' }).ok).toBe(true);
  });

  it('refuses an invalid draft and a reused id', () => {
    expect(addLink([], { assetId: 'nope', target: { kind: 'project' } }).ok).toBe(false);
    expect(addLink([], { assetId: A1, target: { kind: 'project' }, role: 'card' }).ok).toBe(false);
    expect(addLink([link('l_0000000032')], { id: 'l_0000000032', assetId: A1, target: { kind: 'project' } }).ok).toBe(false);
  });

  it('does not mutate its input', () => {
    const base = [link('l_0000000033')];
    const snapshot = JSON.stringify(base);
    addLink(base, { assetId: A2, target: { kind: 'project' } });
    makeCard(base, 'l_0000000033');
    reorderLinks(base, { kind: 'node', nodeId: 'n_1' }, ['l_0000000033']);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('mints distinct ids and re-rolls a taken one', () => {
    const fixed = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    const first = mintLinkId(new Set(), () => fixed);
    expect(() => mintLinkId(new Set([first]), () => fixed)).toThrow();
  });
});

describe('makeCard replaces the card without losing anything else', () => {
  const base = (): AssetLink[] => [
    link('l_0000000040', { role: 'card', note: 'old cover note', order: 10 }),
    link('l_0000000041', { assetId: A2, note: 'keep me', order: 20 }),
  ];

  it('promotes one reference and turns the previous card into a reference, notes intact', () => {
    const edit = ok(makeCard(base(), 'l_0000000041'));
    const byId = new Map(edit.links.map((l) => [l.id, l]));
    expect(byId.get('l_0000000041')).toMatchObject({ role: 'card', note: 'keep me', assetId: A2 });
    expect(byId.get('l_0000000040')).toMatchObject({ role: 'reference', note: 'old cover note' });
    expect(edit.links).toHaveLength(2);
    expect(edit.changes.map((c) => c.linkId).sort()).toEqual(['l_0000000040', 'l_0000000041']);
    expect(edit.changes.every((c) => c.before !== undefined && c.after !== undefined)).toBe(true);
    expect(validateLinkSet(edit.links)).toEqual([]);
  });

  it('changes nothing when the link is already the card', () => {
    const edit = ok(makeCard(base(), 'l_0000000040'));
    expect(edit.changes).toEqual([]);
  });

  it('refuses links that cannot be cards', () => {
    const links = [link('l_0000000043', { target: { kind: 'project' } }), link('l_0000000044', { role: 'source' })];
    expect(makeCard(links, 'l_0000000043').ok).toBe(false);
    expect(makeCard(links, 'l_0000000044').ok).toBe(false);
    expect(makeCard(links, 'l_0000000099').ok).toBe(false);
  });

  it('leaves another node\'s card alone', () => {
    const links = [link('l_0000000045', { role: 'card', target: { kind: 'node', nodeId: 'n_2' } }), link('l_0000000046')];
    const edit = ok(makeCard(links, 'l_0000000046'));
    expect(edit.links.find((l) => l.id === 'l_0000000045')?.role).toBe('card');
  });
});

describe('placing a picture that is already linked', () => {
  const held = (): AssetLink[] => [
    link('l_0000000050', { role: 'card', order: 10 }),
    link('l_0000000051', { assetId: A2, note: 'keep me', order: 20 }),
  ];

  it('makes a linked reference the card in place, keeping its note and order', () => {
    const placed = ok(placeLink(held(), { assetId: A2, target: { kind: 'node', nodeId: 'n_1' }, role: 'card' }));
    expect(placed.link).toMatchObject({ id: 'l_0000000051', role: 'card', note: 'keep me', order: 20 });
    expect(placed.links.find((l) => l.id === 'l_0000000050')?.role).toBe('reference');
    expect(placed.links).toHaveLength(2);
    expect(placed.changes.map((c) => c.linkId).sort()).toEqual(['l_0000000050', 'l_0000000051']);
  });

  it('still refuses the same picture placed twice at one target as anything else', () => {
    expect(placeLink(held(), { assetId: A2, target: { kind: 'node', nodeId: 'n_1' } }).ok).toBe(false);
    expect(placeLink(held(), { assetId: A1, target: { kind: 'node', nodeId: 'n_1' }, role: 'card' }).ok).toBe(false);
  });
});

describe('reordering', () => {
  const group = (): AssetLink[] => [
    link('l_0000000050', { order: 10 }),
    link('l_0000000051', { order: 20 }),
    link('l_0000000052', { order: 30 }),
    link('l_0000000053', { order: 10, target: { kind: 'node', nodeId: 'n_2' } }),
  ];

  it('renumbers the target\'s links in steps of 10 and leaves other targets alone', () => {
    const edit = ok(reorderLinks(group(), { kind: 'node', nodeId: 'n_1' }, ['l_0000000052', 'l_0000000050', 'l_0000000051']));
    const order = linksOf(edit.links, { kind: 'node', nodeId: 'n_1' }).map((l) => [l.id, l.order]);
    expect(order).toEqual([['l_0000000052', 10], ['l_0000000050', 20], ['l_0000000051', 30]]);
    expect(edit.links.find((l) => l.id === 'l_0000000053')?.order).toBe(10);
    expect(edit.changes.map((c) => c.linkId).sort()).toEqual(['l_0000000050', 'l_0000000051', 'l_0000000052']);
  });

  it('refuses a partial, repeated or foreign list', () => {
    const target = { kind: 'node', nodeId: 'n_1' } as const;
    expect(reorderLinks(group(), target, ['l_0000000050']).ok).toBe(false);
    expect(reorderLinks(group(), target, ['l_0000000050', 'l_0000000050', 'l_0000000051']).ok).toBe(false);
    expect(reorderLinks(group(), target, ['l_0000000050', 'l_0000000051', 'l_0000000053']).ok).toBe(false);
  });

  it('reads back in stored order, breaking ties by id', () => {
    const tied = [link('l_0000000061', { order: 10 }), link('l_0000000060', { order: 10 })];
    expect(linksOf(tied, { kind: 'node', nodeId: 'n_1' }).map((l) => l.id)).toEqual(['l_0000000060', 'l_0000000061']);
  });
});

describe('notes, removal and the delete cascade', () => {
  it('sets and clears a link note without touching the picture', () => {
    const edit = ok(setLinkNote([link('l_0000000070')], 'l_0000000070', 'placed at dawn'));
    expect(edit.links[0]?.note).toBe('placed at dawn');
    const cleared = ok(setLinkNote(edit.links, 'l_0000000070', null));
    expect(cleared.links[0]).not.toHaveProperty('note');
    expect(setLinkNote([], 'l_0000000070', 'x').ok).toBe(false);
  });

  it('removes one link and records it for undo', () => {
    const edit = ok(removeLink([link('l_0000000071'), link('l_0000000072', { order: 20 })], 'l_0000000071'));
    expect(edit.links.map((l) => l.id)).toEqual(['l_0000000072']);
    expect(edit.changes[0]?.before?.id).toBe('l_0000000071');
    expect(removeLink([], 'l_0000000071').ok).toBe(false);
  });

  it('takes node and paragraph links with a deleted subtree, keeps the rest, and keeps unknown targets', () => {
    const unknown = readAssetLinks([{ id: 'l_0000000077', assetId: A1, target: { kind: 'timeline-lane', nodeId: 'n_1' }, role: 'reference', order: 10 }]).links[0];
    const links = [
      link('l_0000000073'),
      link('l_0000000074', { target: { kind: 'paragraph', nodeId: 'n_1', anchor } }),
      link('l_0000000075', { target: { kind: 'node', nodeId: 'n_2' } }),
      link('l_0000000076', { target: { kind: 'project' } }),
      ...(unknown === undefined ? [] : [unknown]),
    ];
    const { kept, removed } = cascadeNodeDeletion(links, new Set(['n_1']));
    expect(removed.map((l) => l.id)).toEqual(['l_0000000073', 'l_0000000074']);
    expect(kept.map((l) => l.id)).toEqual(['l_0000000075', 'l_0000000076', 'l_0000000077']);
    expect(cascadeNodeDeletion(links, new Set()).removed).toEqual([]);
  });

  it('answers the timeline and the card surfaces', () => {
    const links = [
      link('l_0000000080', { role: 'card', assetId: A2 }),
      link('l_0000000081', { target: { kind: 'paragraph', nodeId: 'n_1', anchor }, order: 10 }),
      link('l_0000000082', { target: { kind: 'node', nodeId: 'n_2' } }),
    ];
    expect(linksOf(links, { kind: 'node', nodeId: 'n_1' }).map((l) => l.id)).toEqual(['l_0000000080']);
    expect(linksOf(links, { kind: 'node', nodeId: 'n_1' }, { includeParagraphs: true }).map((l) => l.id)).toEqual(['l_0000000080', 'l_0000000081']);
    expect(linksOf(links, { kind: 'project' })).toEqual([]);
    expect(cardAssetOf(links, 'n_1')).toBe(A2);
    expect(cardAssetOf(links, 'n_2')).toBeUndefined();
    expect(linksToAsset(links, A1).map((l) => l.id)).toEqual(['l_0000000081', 'l_0000000082']);
    expect(linkedNodeIds(links, A1).sort()).toEqual(['n_1', 'n_2']);
  });
});
