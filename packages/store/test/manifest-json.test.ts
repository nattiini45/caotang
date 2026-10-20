/**
 * Manifest serializer layout — [project-format.md §2](docs/architecture/project-format.md).
 *
 * §2 does not just define the manifest, it defines how it is *written*:
 * "Pretty-printed JSON, 2-space indent, keys in the fixed order shown below
 * (stable ordering so git diffs stay readable). One array element per line for
 * the `tree` array (writers, formatters keep this)."
 *
 * That is a testable contract, and it is the reason a rename shows up as one
 * changed line in git rather than a reformatted file. These tests lock the
 * layout so a future writer cannot quietly regress it.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyManifest, serializeManifest, validateManifest, type Manifest } from '../src/index.js';

const T = new Date('2026-09-08T15:32:10.000Z');

/** Every optional v1 field populated, so no emitter path goes unexercised. */
function rich(): Manifest {
  const m = createEmptyManifest('The Lighthouse Keeper', T);
  m.vocabulary.labels = [{ id: 'act-1', name: 'Act 1', color: '#d9a44a' }];
  m.tree[1]!.createdAt = T.toISOString();
  m.tree[1]!.updatedAt = T.toISOString();
  m.codex = [
    {
      id: 'c_5H8QK2M9RT',
      name: 'Elena Voss',
      aliases: ['Lena'],
      type: 'character',
      description: 'The keeper’s daughter.',
      includePolicy: 'detected',
      caseSensitive: false,
      exclude: ['Barge'],
      attachments: ['n_3W8RN2TQ6C'],
      keywords: ['protagonist'],
      origin: 'manual',
      sources: [{ docId: 'n_3W8RN2TQ6C', quote: 'the ferry was late' }],
      createdAt: T.toISOString(),
      updatedAt: T.toISOString(),
    },
  ];
  m.filters = [
    { id: 'f_1', name: 'Stale scenes', criteria: { status: 'draft' }, createdAt: T.toISOString(), updatedAt: T.toISOString() },
  ];
  m.goals = [
    {
      id: 'g_1',
      nodeId: 'manuscript',
      metric: 'words',
      comparator: 'at-least',
      target: 80_000,
      createdAt: T.toISOString(),
      updatedAt: T.toISOString(),
    },
  ];
  m.derived = { wordCounts: { n_3W8RN2TQ6C: 2143 }, computedAt: T.toISOString() };
  return m;
}

describe('manifest serializer', () => {
  // The serializer wrote a citation's docId and quote and nothing
  // else, so the offsets and the time codex.md §2 names were lost on the next save.
  it('keeps every field of a codex citation, and a citation without the optional ones is unchanged', () => {
    const m = rich();
    m.codex = [
      {
        ...m.codex![0]!,
        sources: [
          { docId: 'n_3W8RN2TQ6C', quote: 'The ferry was late.', from: 0, to: 19, extractedAt: '2026-10-01T00:00:00.000Z' },
          { docId: 'n_3W8RN2TQ6C', quote: 'Older citation.' },
        ],
      },
    ];

    const back = JSON.parse(serializeManifest(m)) as Manifest;

    expect(back.codex?.[0]?.sources).toEqual(m.codex![0]!.sources);
  });

  // The EPUB floor (epub-metadata.md) and the saved recipes
  // (exporter.md §2) were specified and not stored. A save drops what the type does
  // not carry, so they are carried now, and a project that set none is unchanged.
  it('keeps the EPUB floor and saved recipes through a save, and writes neither unless set', () => {
    const m = rich();
    m.project.language = 'en';
    m.project.identifier = { uuid: 'urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', isbn: null };
    m.project.coverAssetId = null;
    m.recipes = [{ name: 'beta read', includeRootIds: ['manuscript'], format: 'docx', templateId: 'manuscript' }];

    const back = JSON.parse(serializeManifest(m)) as Manifest;
    expect(back.project.language).toBe('en');
    expect(back.project.identifier).toEqual(m.project.identifier);
    expect(back.project.coverAssetId).toBeNull();
    expect(back.recipes).toEqual(m.recipes);

    // A new project now carries a language, an identifier and the default recipe, so "a project that set none" is
    // the one with those removed: the writer omits each key it was not given.
    const fresh = createEmptyManifest('Bare', T);
    delete (fresh.project as { language?: string }).language;
    delete (fresh.project as { identifier?: unknown }).identifier;
    delete fresh.recipes;
    const bare = JSON.parse(serializeManifest(fresh)) as Manifest;
    expect(bare.project).not.toHaveProperty('language');
    expect(bare.project).not.toHaveProperty('identifier');
    expect(bare).not.toHaveProperty('recipes');
  });

  it('writes the author and recipe options only when set, in the order the types declare them', () => {
    const m = rich();
    m.project.author = 'Ada Writer';
    m.recipes = [
      { name: 'beta', includeRootIds: ['manuscript'], format: 'epub', options: { toc: false, titlePage: true, author: 'A. N. Other' } },
      { name: 'plain', includeRootIds: ['manuscript'], format: 'md', options: {} },
    ];
    const text = serializeManifest(m);
    expect(text).toContain('"author": "Ada Writer"');
    expect(text).toContain('"options": { "titlePage": true, "toc": false, "author": "A. N. Other" }');
    expect(text).toContain('"options": {}');
    const back = JSON.parse(text) as Manifest;
    expect(back.recipes).toEqual(m.recipes);
    expect(back.project.author).toBe('Ada Writer');
  });

  it('drops a malformed EPUB slot or recipe with a warning, and keeps the rest (load tolerance)', () => {
    const m = rich();
    (m.project as unknown as Record<string, unknown>)['language'] = '';
    m.recipes = [
      { name: 'good', includeRootIds: [], format: 'md' },
      { name: '', includeRootIds: [], format: 'md' },
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['project.language', 'recipes[1]']));
    expect((r.manifest as Manifest).recipes?.map((x) => x.name)).toEqual(['good']);
    expect(r.manifest?.project).not.toHaveProperty('language');
  });

  // A recipe's character limit is a whole number from 1 to 10000, the bound `recipe.save` checks. A limit outside it is dropped
  // on load with a warning, and nothing the load rejected is written back, so the next save still parses.
  it('drops a recipe whose character limit is not a whole number from 1 to 10000, and the manifest still writes as valid JSON', () => {
    for (const bad of ['abc', -3, 1.5, 0, 10_001, null]) {
      const m = rich();
      m.recipes = [
        { name: 'subs', includeRootIds: ['manuscript'], format: 'dialogue-csv', options: { charLimit: bad as unknown as number } },
      ];

      const r = validateManifest(m, { docFiles: [] });

      expect(r.ok, String(bad)).toBe(true);
      expect(r.warnings.map((w) => w.path), String(bad)).toContain('recipes[0].options');
      const kept = (r.manifest as Manifest).recipes?.[0];
      expect(kept?.name, String(bad)).toBe('subs');
      expect(kept?.options, String(bad)).toBeUndefined();
      expect(() => JSON.parse(serializeManifest(r.manifest as Manifest)), String(bad)).not.toThrow();
    }
  });

  it('keeps a whole-number character limit from 1 to 10000 through a load, with no warning', () => {
    for (const good of [1, 42, 10_000]) {
      const m = rich();
      m.recipes = [{ name: 'subs', includeRootIds: ['manuscript'], format: 'dialogue-csv', options: { charLimit: good } }];

      const r = validateManifest(m, { docFiles: [] });

      expect(r.warnings.map((w) => w.path), String(good)).not.toContain('recipes[0].options');
      expect((r.manifest as Manifest).recipes?.[0]?.options).toEqual({ charLimit: good });
    }
  });

  it('keeps the contact sheet’s paper size, A4 or Letter, through a save and a load, and drops any other value with a warning', () => {
    for (const good of ['A4', 'Letter'] as const) {
      const m = rich();
      m.recipes = [{ name: 'sheets', includeRootIds: ['manuscript'], format: 'contact-sheet-pdf', options: { pageSize: good } }];
      const reloaded = JSON.parse(serializeManifest(m)) as Manifest;
      expect(reloaded.recipes?.[0]?.options).toEqual({ pageSize: good });
      const r = validateManifest(reloaded, { docFiles: [] });
      expect(r.warnings.map((w) => w.path), good).not.toContain('recipes[0].options');
      expect((r.manifest as Manifest).recipes?.[0]?.options).toEqual({ pageSize: good });
    }
    const m = rich();
    m.recipes = [{ name: 'sheets', includeRootIds: ['manuscript'], format: 'contact-sheet-pdf', options: { pageSize: 'A3' as unknown as 'A4' } }];
    expect((JSON.parse(serializeManifest(m)) as Manifest).recipes?.[0]?.options).toEqual({});
    const r = validateManifest(m, { docFiles: [] });
    expect(r.warnings.map((w) => w.path)).toContain('recipes[0].options');
  });

  // screenplay.md §5.3: the screenplay PDF's options round-trip, and a placement the bus would refuse is dropped on load.
  it('keeps the screenplay PDF’s scene numbers and continuation switch through a write and a load', () => {
    const m = rich();
    m.recipes = [{ name: 'shoot', includeRootIds: ['manuscript'], format: 'pdf', options: { sceneNumbers: 'both', continued: false } }];
    const text = serializeManifest(m);
    expect(text).toContain('"sceneNumbers": "both"');
    expect(text).toContain('"continued": false');
    const r = validateManifest(JSON.parse(text) as Manifest, { docFiles: [] });
    expect(r.warnings.map((w) => w.path)).not.toContain('recipes[0].options');
    expect((r.manifest as Manifest).recipes?.[0]?.options).toEqual({ sceneNumbers: 'both', continued: false });
  });

  it('drops recipe options with a scene-number placement the bus would refuse', () => {
    const m = rich();
    m.recipes = [{ name: 'shoot', includeRootIds: ['manuscript'], format: 'pdf', options: { sceneNumbers: 'middle' as unknown as 'left' } }];
    const r = validateManifest(m, { docFiles: [] });
    expect(r.warnings.map((w) => w.path)).toContain('recipes[0].options');
    expect((r.manifest as Manifest).recipes?.[0]?.options).toBeUndefined();
    // A write never puts the unknown placement in the file either.
    const fresh = rich();
    fresh.recipes = [{ name: 'shoot', includeRootIds: ['manuscript'], format: 'pdf', options: { sceneNumbers: 'middle' as unknown as 'left' } }];
    expect((JSON.parse(serializeManifest(fresh)) as Manifest).recipes?.[0]?.options).toEqual({});
  });

  it('writes only the recipe options a load keeps, so a value of another type cannot put unquoted text in the file', () => {
    const m = rich();
    m.recipes = [
      {
        name: 'subs',
        includeRootIds: ['manuscript'],
        format: 'dialogue-csv',
        options: { charLimit: 'abc' as unknown as number, toc: 'yes' as unknown as boolean },
      },
    ];

    const text = serializeManifest(m);

    expect(() => JSON.parse(text)).not.toThrow();
    expect((JSON.parse(text) as Manifest).recipes?.[0]?.options).toEqual({});
  });

  it('emits the spec §2 key order verbatim', () => {
    const text = serializeManifest(createEmptyManifest('The Lighthouse Keeper', T));
    const keys = [...text.matchAll(/^ {2}"([a-zA-Z]+)":/gm)].map((m) => m[1]);
    // `recipes` is last: new projects seed the default recipe, and an additive array is written after `codex`.
    expect(keys).toEqual(['app', 'formatVersion', 'project', 'vocabulary', 'tree', 'derived', 'codex', 'recipes']);
  });

  it('uses 2-space indentation throughout', () => {
    const text = serializeManifest(createEmptyManifest('K', T));
    expect(text).toContain('\n  "formatVersion": 1,');
    expect(text).toContain('\n    "id": "p_');
    expect(text).not.toMatch(/^\t/m);
  });

  it('puts one tree element per line (§2)', () => {
    const text = serializeManifest(createEmptyManifest('K', T));
    const treeBlock = text.slice(text.indexOf('"tree"'), text.indexOf('"derived"'));
    const nodeLines = treeBlock.split('\n').filter((l) => l.includes('"parentId"'));
    expect(nodeLines).toHaveLength(3);
    for (const line of nodeLines) {
      expect(line.trimStart().startsWith('{ "id": "')).toBe(true);
      expect(line.endsWith('}') || line.endsWith('},')).toBe(true);
    }
  });

  it('keeps scalar arrays inline and object arrays expanded', () => {
    const text = serializeManifest(createEmptyManifest('K', T));
    expect(text).toContain('"keywords": []');
    expect(text).toContain('"statuses": [');
  });

  it('sorts derived.wordCounts so a reorg cannot churn the derived block', () => {
    const m = createEmptyManifest('K', T);
    m.derived = {
      wordCounts: { n_ZZZZZZZZZZ: 3, n_3W8RN2TQ6C: 2143, n_7K2QX9M4A1: 512 },
      computedAt: T.toISOString(),
    };
    const text = serializeManifest(m);
    const order = [...text.matchAll(/"(n_[A-Z0-9]{10})": (\d+)/g)].map((mt) => mt[1]);
    expect(order).toEqual(['n_3W8RN2TQ6C', 'n_7K2QX9M4A1', 'n_ZZZZZZZZZZ']);
  });

  it('emits an empty wordCounts map as {} rather than a blank block', () => {
    expect(serializeManifest(createEmptyManifest('K', T))).toContain('"wordCounts": {}');
  });

  it('omits additive arrays that were never set, rather than inventing entries', () => {
    const m = createEmptyManifest('K', T);
    delete m.codex;
    delete m.filters;
    delete m.goals;
    const text = serializeManifest(m);
    expect(text).not.toContain('"codex"');
    expect(text).not.toContain('"filters"');
    expect(text).not.toContain('"goals"');
  });

  it('emits the additive node timestamps only when they are set', () => {
    const without = createEmptyManifest('K', T);
    const line = (m: Manifest): string =>
      serializeManifest(m).split('\n').find((l) => l.includes('"id": "manuscript"')) ?? '';
    expect(line(without)).not.toContain('"createdAt"');
    expect(line(without)).not.toContain('"updatedAt"');

    const with_ = createEmptyManifest('K', T);
    with_.tree[1]!.createdAt = T.toISOString();
    with_.tree[1]!.updatedAt = T.toISOString();
    expect(line(with_)).toContain('"notes": "", "createdAt"');
    expect(line(with_)).toContain('"updatedAt"');
  });

  it('ends with exactly one newline and is valid JSON when parsed back', () => {
    // One fixture instance: `createEmptyManifest` mints a random project id, so
    // calling `rich()` twice would compare two different projects.
    const m = rich();
    const text = serializeManifest(m);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(m)));
  });

  it('emits a fully-populated manifest as parseable JSON — no trailing commas anywhere', () => {
    // The empty `wordCounts` path and the populated one are different emitters;
    // only a full manifest exercises both plus every additive array at once.
    const shapes: Record<string, number>[] = [
      {},
      { n_3W8RN2TQ6C: 1 },
      { n_3W8RN2TQ6C: 1, n_7K2QX9M4A1: 2 },
    ];
    for (const wordCounts of shapes) {
      const m = rich();
      m.derived = { wordCounts, computedAt: T.toISOString() };
      expect(() => JSON.parse(serializeManifest(m)), JSON.stringify(wordCounts)).not.toThrow();
    }
  });

  it('is idempotent: serialize(parse(serialize(x))) is byte-identical', () => {
    const m = rich();
    const once = serializeManifest(m);
    const twice = serializeManifest(JSON.parse(once) as Manifest);
    expect(twice).toBe(once);
  });

  /**
   * A field the writer does not have is a refusal, not a word in the file.
   *
   * `JSON.stringify(undefined)` is `undefined`, and the emitter pasted it into
   * the file as the bare word `undefined` — which is not JSON, so the manifest
   * a save had just written could not be parsed by the next open. The write
   * fails instead, and the error names the field, so the caller can say which
   * one is missing.
   */
  it('refuses to write a field it does not have, naming it', () => {
    const withoutStamp = rich();
    delete (withoutStamp.filters![0] as { createdAt?: string }).createdAt;
    expect(() => serializeManifest(withoutStamp)).toThrow(/createdAt/);

    const withoutMetric = rich();
    delete (withoutMetric.goals![0] as { metric?: string }).metric;
    expect(() => serializeManifest(withoutMetric)).toThrow(/metric/);

    const withoutName = rich();
    delete (withoutName.goals![0] as { comparator?: string }).comparator;
    expect(() => serializeManifest(withoutName)).toThrow(/comparator/);
  });

  it('refuses a criterion value it cannot write as JSON, rather than writing it bare', () => {
    const m = rich();
    (m.filters![0] as { criteria: Record<string, unknown> }).criteria = { text: undefined };

    expect(() => serializeManifest(m)).toThrow(/criteria/);
  });
});
