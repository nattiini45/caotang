import { describe, expect, it } from 'vitest';

import type { AssetLink, AssetRecord, ParagraphAnchor } from '../src/model.js';
import {
  collectUses,
  decideDedup,
  deletionBlockers,
  planBackfill,
  usedAssetIds,
  usesOf,
  type AssetListing,
  type UsesSnapshot,
} from '../src/uses.js';
import { readAssetLinks } from '../src/validate.js';

const A1 = 'a_AAAAAAAAA1';
const A2 = 'a_AAAAAAAAA2';
const A3 = 'a_AAAAAAAAA3';
const A4 = 'a_AAAAAAAAA4';
const sha = (c: string): string => c.repeat(64);

const anchor: ParagraphAnchor = { from: 0, to: 1, exact: 'x', prefix: '', suffix: '', capturedRevision: 1, blockHash: '0000000000000000', ordinal: 0 };

function link(id: string, assetId: string, over: Partial<AssetLink> = {}): AssetLink {
  return { id, assetId, target: { kind: 'node', nodeId: 'n_1' }, role: 'reference', order: 10, ...over };
}

describe('usesOf', () => {
  const snapshot: UsesSnapshot = {
    coverAssetId: A1,
    nodes: [
      { id: 'n_shot1', shot: { image: A1, other: 1 } },
      { id: 'n_shot2', shot: { image: A2 } },
      { id: 'n_plain' },
      { id: 'n_bad', shot: { image: 'not-an-id' } },
      { id: 'n_empty', shot: {} },
    ],
    codex: [
      { id: 'c_1', visualRefs: [A2, A3] },
      { id: 'c_2', visualRefs: undefined },
    ],
    inline: [
      { assetId: A1, nodeId: 'n_doc' },
      { assetId: A1, nodeId: 'n_doc2' },
    ],
    vendor: [
      { assetId: A3, owner: { kind: 'shot', nodeId: 'n_shot1' } },
      { assetId: A3, owner: { kind: 'codex', entryId: 'c_1' } },
    ],
    panels: [{ assetId: A4, nodeId: 'n_page', panelId: 'p1' }],
    links: [link('l_0000000002', A1, { order: 20 }), link('l_0000000001', A1, { target: { kind: 'project' }, order: 10 }), link('l_0000000003', A2, { target: { kind: 'paragraph', nodeId: 'n_doc', anchor }, role: 'source' })],
  };

  it('lists every kind of use, typed, in a stable order', () => {
    expect(usesOf(snapshot, A1)).toEqual([
      { kind: 'cover' },
      { kind: 'shot', nodeId: 'n_shot1' },
      { kind: 'inline', nodeId: 'n_doc' },
      { kind: 'inline', nodeId: 'n_doc2' },
      { kind: 'link', linkId: 'l_0000000001', target: { kind: 'project' }, role: 'reference', understood: true },
      { kind: 'link', linkId: 'l_0000000002', target: { kind: 'node', nodeId: 'n_1' }, role: 'reference', understood: true },
    ]);
    expect(usesOf(snapshot, A2).map((u) => u.kind)).toEqual(['shot', 'codex', 'link']);
    expect(usesOf(snapshot, A3)).toEqual([
      { kind: 'codex', entryId: 'c_1' },
      { kind: 'vendor', owner: { kind: 'shot', nodeId: 'n_shot1' } },
      { kind: 'vendor', owner: { kind: 'codex', entryId: 'c_1' } },
    ]);
    expect(usesOf(snapshot, A4)).toEqual([{ kind: 'comic-panel', nodeId: 'n_page', panelId: 'p1' }]);
  });

  it('returns nothing for an unused picture and ignores unusable references', () => {
    expect(usesOf(snapshot, 'a_ZZZZZZZZZ9')).toEqual([]);
    expect(collectUses(snapshot).has('not-an-id')).toBe(false);
    expect(collectUses({}).size).toBe(0);
  });

  it('is deterministic whatever order the caller listed links in', () => {
    const shuffled = { ...snapshot, links: [...(snapshot.links ?? [])].reverse() };
    expect(usesOf(shuffled, A1)).toEqual(usesOf(snapshot, A1));
  });
});

describe('what blocks deleting a record', () => {
  it('lets understood links go with the record, and blocks on everything else', () => {
    const snapshot: UsesSnapshot = { links: [link('l_0000000010', A1)] };
    expect(deletionBlockers(usesOf(snapshot, A1))).toEqual([]);
    expect(deletionBlockers(usesOf({ coverAssetId: A1 }, A1))).toEqual([{ kind: 'cover' }]);
    expect(deletionBlockers(usesOf({ inline: [{ assetId: A1, nodeId: 'n' }] }, A1))).toHaveLength(1);
    expect(deletionBlockers(usesOf({ vendor: [{ assetId: A1, owner: { kind: 'other', label: 'pack' } }] }, A1))).toHaveLength(1);
  });

  it('blocks on a link whose role or target this build cannot read', () => {
    const { links } = readAssetLinks([
      { id: 'l_0000000011', assetId: A1, target: { kind: 'timeline-lane', lane: 1 }, role: 'reference', order: 10 },
      { id: 'l_0000000012', assetId: A2, target: { kind: 'project' }, role: 'moodboard', order: 10 },
    ]);
    expect(deletionBlockers(usesOf({ links }, A1))).toMatchObject([{ kind: 'link', understood: false }]);
    expect(deletionBlockers(usesOf({ links }, A2))).toMatchObject([{ kind: 'link', understood: false }]);
  });

  it('names the files something other than a link depends on', () => {
    const ids = usedAssetIds({ coverAssetId: A1, links: [link('l_0000000013', A2)], inline: [{ assetId: A3, nodeId: 'n' }] });
    expect([...ids].sort()).toEqual([A1, A3]);
  });
});

describe('decideDedup', () => {
  const records = [
    { id: A1, sha256: sha('a') },
    { id: A2, sha256: sha('b'), missing: true },
  ];

  it('reuses a record with the same hash and writes no file', () => {
    expect(decideDedup(sha('a'), records)).toEqual({ action: 'reuse', assetId: A1, restoreBytes: false });
  });

  it('reuses a record whose bytes are gone and asks for the bytes to be restored', () => {
    expect(decideDedup(sha('b'), records)).toEqual({ action: 'reuse', assetId: A2, restoreBytes: true });
  });

  it('prefers the record whose file is present when two share a hash', () => {
    const twins = [{ id: A2, sha256: sha('a'), missing: true }, { id: A1, sha256: sha('a') }];
    expect(decideDedup(sha('a'), twins)).toMatchObject({ assetId: A1, restoreBytes: false });
  });

  it('re-creates the record over an unrecorded file with the same hash, only from an authoritative listing', () => {
    const files = [{ assetId: A4, file: `${A4}.png`, sha256: sha('c') }, { assetId: A3, file: `${A3}.png`, sha256: sha('c') }];
    expect(decideDedup(sha('c'), records, { authoritative: true, files })).toEqual({ action: 'adopt', assetId: A3, file: `${A3}.png` });
    expect(decideDedup(sha('c'), records, { authoritative: false, files })).toEqual({ action: 'new' });
    expect(decideDedup(sha('c'), records)).toEqual({ action: 'new' });
  });

  it('prefers a record over an unrecorded file', () => {
    const files = [{ assetId: A3, file: `${A3}.png`, sha256: sha('a') }];
    expect(decideDedup(sha('a'), records, { authoritative: true, files })).toMatchObject({ action: 'reuse', assetId: A1 });
  });

  it('says new for bytes nobody has', () => {
    expect(decideDedup(sha('d'), records, { authoritative: true, files: [] })).toEqual({ action: 'new' });
  });
});

describe('planBackfill', () => {
  const NOW = '2026-03-01T00:00:00.000Z';
  const listing = (authoritative: boolean, files: AssetListing['files']): AssetListing => ({ authoritative, files });

  it('makes a record for every used file without one, from the facts known about it', () => {
    const plan = planBackfill({
      records: [{ id: A3 }],
      used: new Set([A1, A2, A3]),
      listing: listing(true, [
        { file: `${A1}.png`, bytes: 100, sha256: sha('1'), width: 10, height: 20 },
        { file: `${A2}.jpg`, bytes: 200, sha256: sha('2') },
        { file: `${A3}.webp`, bytes: 300, sha256: sha('3') },
      ]),
      now: NOW,
    });
    expect(plan.create).toEqual([
      { id: A1, file: `${A1}.png`, mime: 'image/png', sha256: sha('1'), bytes: 100, width: 10, height: 20, createdAt: NOW },
      { id: A2, file: `${A2}.jpg`, mime: 'image/jpeg', sha256: sha('2'), bytes: 200, createdAt: NOW },
    ]);
    expect(plan.needFacts).toEqual([]);
    expect(plan.missingFiles).toEqual([]);
  });

  it('is idempotent: applying the plan and planning again changes nothing', () => {
    const files: AssetListing['files'] = [
      { file: `${A1}.png`, bytes: 1, sha256: sha('1') },
      { file: `${A2}.png`, bytes: 2, sha256: sha('2') },
    ];
    const first = planBackfill({ records: [], used: new Set([A1, A2]), listing: listing(true, files), now: NOW });
    expect(first.create).toHaveLength(2);
    const records: Pick<AssetRecord, 'id' | 'file'>[] = first.create.map((r) => ({ id: r.id, file: r.file }));
    const second = planBackfill({ records, used: new Set([A1, A2]), listing: listing(true, files), now: '2027-01-01T00:00:00.000Z' });
    expect(second).toEqual({ create: [], needFacts: [], missingFiles: [], missingRecords: [] });
  });

  it('waits for facts that idle hashing has not produced yet, and plans again once they arrive', () => {
    const pending = planBackfill({ records: [], used: new Set([A1]), listing: listing(true, [{ file: `${A1}.png` }]), now: NOW });
    expect(pending).toMatchObject({ create: [], needFacts: [{ assetId: A1, file: `${A1}.png` }] });
    const ready = planBackfill({ records: [], used: new Set([A1]), listing: listing(true, [{ file: `${A1}.png`, bytes: 5, sha256: sha('e') }]), now: NOW });
    expect(ready.create).toHaveLength(1);
    expect(ready.needFacts).toEqual([]);
  });

  it('keeps a record whose bytes are missing and reports it; invents no record for a missing used file', () => {
    const plan = planBackfill({
      records: [{ id: A1, file: `${A1}.png` }, { id: A2, file: `${A2}.png` }],
      used: new Set([A1, A3]),
      listing: listing(true, [{ file: `${A2}.png` }]),
      now: NOW,
    });
    expect(plan.missingRecords).toEqual([A1]);
    expect(plan.missingFiles).toEqual([A3]);
    expect(plan.create).toEqual([]);
  });

  it('never concludes a file or a record is missing from a listing that is not authoritative', () => {
    const plan = planBackfill({ records: [{ id: A1, file: `${A1}.png` }], used: new Set([A3]), listing: listing(false, []), now: NOW });
    expect(plan).toEqual({ create: [], needFacts: [], missingFiles: [], missingRecords: [] });
  });

  it('still records the files a partial listing does show', () => {
    const plan = planBackfill({ records: [], used: new Set([A1]), listing: listing(false, [{ file: `${A1}.png`, bytes: 1, sha256: sha('1') }]), now: NOW });
    expect(plan.create).toHaveLength(1);
  });

  it('ignores files that are not assets: temp files, stray names and hash names', () => {
    const plan = planBackfill({
      records: [],
      used: new Set([A1]),
      listing: listing(true, [{ file: `${A1}.png.tmp-3`, bytes: 1, sha256: sha('1') }, { file: `${sha('f')}.png`, bytes: 1, sha256: sha('f') }, { file: 'notes.txt' }]),
      now: NOW,
    });
    expect(plan.create).toEqual([]);
    expect(plan.missingFiles).toEqual([A1]);
  });

  it('gives a used id with two files one record, from the first by name', () => {
    const plan = planBackfill({
      records: [],
      used: new Set([A1]),
      listing: listing(true, [{ file: `${A1}.png`, bytes: 1, sha256: sha('1') }, { file: `${A1}.jpg`, bytes: 2, sha256: sha('2') }]),
      now: NOW,
    });
    expect(plan.create.map((r) => r.file)).toEqual([`${A1}.jpg`]);
  });

  it('is deterministic regardless of the order used ids and files arrive in', () => {
    const files: AssetListing['files'] = [A3, A1, A2].map((id, i) => ({ file: `${id}.png`, bytes: i + 1, sha256: sha(String(i + 1)) }));
    const a = planBackfill({ records: [], used: new Set([A3, A1, A2]), listing: listing(true, files), now: NOW });
    const b = planBackfill({ records: [], used: new Set([A1, A2, A3]), listing: listing(true, [...files].reverse()), now: NOW });
    expect(a).toEqual(b);
    expect(a.create.map((r) => r.id)).toEqual([A1, A2, A3]);
  });
});
