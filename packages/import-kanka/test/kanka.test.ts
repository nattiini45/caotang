/**
 * The Kanka reader (#293, epic #263): a synthetic campaign export written to the layout Kanka's own export produces
 * — `info.json`, `campaign.json`, `settings/modules.json`, one file per entity under its module, and the gallery.
 * No real campaign is copied; the shape is Kanka's, the text is invented.
 */

import { describe, expect, it } from 'vitest';

import { rawZip } from '../../import-read/test/zip-fixtures.js';

import { codexTypeOf, parseEntityFile, moduleOfPath, versionAtLeast } from '../src/index.js';
import { readKanka } from '../src/reader.js';
import { rewriteMentions } from '../src/mentions.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const zipOf = (files: Record<string, string | Uint8Array>): Uint8Array =>
  rawZip(Object.entries(files).map(([name, value]) => ({ name, data: typeof value === 'string' ? enc(value) : value })));

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const entity = (id: number, name: string, extra: Record<string, unknown> = {}, own: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id,
    name,
    is_private: false,
    ...own,
    entity: {
      id,
      name,
      type: '',
      entry: '',
      is_private: false,
      image_path: '',
      parent_id: null,
      entityTags: [],
      relationships: [],
      posts: [],
      entityAttributes: [],
      reminders: [],
      ...extra,
    },
  });

const CAMPAIGN: Record<string, string | Uint8Array> = {
  'info.json': JSON.stringify({ kanka_version: '2.1.4', export_version: '2.1.4', started: '2026-11-15 10:00:00' }),
  'campaign.json': JSON.stringify({ id: 1, name: 'The Ninth House', locale: 'en' }),
  'settings/modules.json': JSON.stringify({ characters: { enabled: true, name_plural: 'Dramatis Personae' }, locations: { enabled: true } }),
  'characters/elena_11.json': entity(
    11,
    'Elena',
    {
      type: 'Cartographer',
      entry: '<p>Elena maps the harbour with <a href="https://kanka.io/e/12">[entity:12]</a>.</p><script>alert(1)</script><p><img src="https://example.com/x.png" alt="x"/></p>',
      image_path: 'campaigns/1/elena.png',
      entityTags: [{ entity_id: 11, tag_id: 31 }],
      entityAttributes: [
        { id: 1, name: 'Age', value: '34', is_private: false, default_order: 2 },
        { id: 2, name: 'Background', value: '', is_private: false, default_order: 1 },
      ],
      relationships: [{ id: 5, owner_id: 11, target_id: 12, relation: 'sister', attitude: 3, mirror_id: 6, is_pinned: false }],
      posts: [{ id: 7, name: 'The letter', entry: '<p>She never sent it.</p>', position: 1 }],
      reminders: [
        { id: 1, type_id: 2, year: 1204, month: 3, day: 2, comment: '' },
        { id: 2, type_id: 3, year: 1260, month: null, day: null, comment: 'at sea' },
      ],
    },
    { title: 'Keeper' },
  ),
  'characters/mara_12.json': entity(12, 'Mara', {
    entry: '<p>Mara keeps the light.</p>',
    relationships: [{ id: 6, owner_id: 12, target_id: 11, relation: 'sister', attitude: 3, mirror_id: 5 }],
  }),
  'locations/pier_13.json': entity(13, 'The Pier', { entry: '<p>Nine steps down.</p>' }),
  'items/compass_14.json': entity(14, 'The Compass'),
  'quests/find-the-letter_15.json': entity(15, 'Find the letter'),
  'journals/private-notes_16.json': entity(16, 'Private notes', { is_private: true, entry: '<p>Only the writer sees this.</p>' }),
  'events/the-flood_17.json': entity(17, 'The Flood', { entry: '<p>The water came at night.</p>', reminders: [{ id: 3, type_id: 4, year: 1204, month: 8, day: 1, comment: 'the ninth wave' }] }, { date: 'Year 1204' }),
  'tags/slow-burn_31.json': entity(31, 'Slow Burn'),
  'gallery/90.json': JSON.stringify({ id: 90, name: 'Harbour at dawn', ext: 'png' }),
  'gallery/90.png': PNG,
  'gallery/91.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  'campaigns/1/elena.png': PNG,
};

describe('the Kanka export’s front matter (#293)', () => {
  it('reads the version and refuses an export older than 2.1', async () => {
    expect(versionAtLeast('2.1', 2, 1)).toBe(true);
    expect(versionAtLeast('2.1.4', 2, 1)).toBe(true);
    expect(versionAtLeast('3.0', 2, 1)).toBe(true);
    expect(versionAtLeast('2.0.9', 2, 1)).toBe(false);
    expect(versionAtLeast('1.0.34', 2, 1)).toBe(false);
    expect(versionAtLeast('', 2, 1)).toBe(false);

    const old = await readKanka(zipOf({ ...CAMPAIGN, 'info.json': JSON.stringify({ kanka_version: '1.0.34' }) }));
    expect(old.ok).toBe(false);
    if (old.ok) return;
    expect(old.error).toEqual({ kind: 'old-export', version: '1.0.34' });
  });

  it('refuses a zip that is not a Kanka export, and one with no entities', async () => {
    const plain = await readKanka(zipOf({ 'notes.txt': 'a letter' }));
    expect(plain.ok).toBe(false);
    if (plain.ok) return;
    expect(plain.error.kind).toBe('not-kanka');

    const empty = await readKanka(zipOf({ 'info.json': CAMPAIGN['info.json'] as string, 'campaign.json': CAMPAIGN['campaign.json'] as string }));
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.kind).toBe('empty');
  });

  it('reads the module and id a file path names', () => {
    expect(moduleOfPath('characters/elena_11.json')).toEqual({ module: 'characters', id: 11 });
    expect(moduleOfPath('settings/modules.json')).toBeNull();
    expect(moduleOfPath('gallery/90.json')).toBeNull();
    expect(moduleOfPath('campaign.json')).toBeNull();
  });
});

describe('the Kanka entities (#293)', () => {
  it('maps each module to a codex type, and everything else to lore', () => {
    expect(codexTypeOf('characters')).toBe('character');
    expect(codexTypeOf('locations')).toBe('location');
    expect(codexTypeOf('items')).toBe('object');
    expect(codexTypeOf('quests')).toBe('subplot');
    for (const module of ['organisations', 'families', 'races', 'creatures', 'abilities', 'journals', 'notes', 'events', 'spells_9']) {
      expect(codexTypeOf(module)).toBe('lore');
    }
  });

  it('reads the entity, its attributes in order, its relations, posts and reminders', () => {
    const parsed = parseEntityFile('characters', JSON.parse(CAMPAIGN['characters/elena_11.json'] as string));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.name).toBe('Elena');
    expect(parsed.type).toBe('Cartographer');
    expect(parsed.attributes.map((row) => row.name)).toEqual(['Background', 'Age']);
    expect(parsed.relations).toEqual([{ targetId: 12, relation: 'sister', attitude: 3, mirrored: true }]);
    expect(parsed.posts.map((post) => post.name)).toEqual(['The letter']);
    expect(parsed.reminders.map((row) => row.typeId)).toEqual([2, 3]);
    expect(parsed.tagIds).toEqual([31]);
  });

  it('imports every entity with its type, keywords and private flag', async () => {
    const read = await readKanka(zipOf(CAMPAIGN));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const value = read.value;
    expect(value.campaign).toBe('The Ninth House');
    // The tag module is not an entity of its own: its names become keywords.
    expect(value.entities.map((row) => row.name)).toEqual(['Elena', 'Mara', 'The Flood', 'The Compass', 'Private notes', 'The Pier', 'Find the letter']);
    expect(value.entities.map((row) => codexTypeOf(row.module))).toEqual(['character', 'character', 'lore', 'object', 'lore', 'location', 'subplot']);
    expect(value.keywords.get(11)).toEqual(['Dramatis Personae', 'Cartographer', 'Slow Burn']);
    expect(value.keywords.get(13)).toEqual(['locations']);
    expect(value.privateEntities).toBe(1);
  });

  it('writes the page in the spec’s order, with the mention as a plain name', async () => {
    const read = await readKanka(zipOf(CAMPAIGN));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const page = read.value.pages.find((row) => row.entityId === 11);
    expect(page).toBeDefined();
    const body = page?.body ?? '';
    expect(body.startsWith('# Elena\n\nDramatis Personae · Cartographer')).toBe(true);
    expect(body).toContain('![Elena](import:kanka-image-1)');
    expect(body).toContain('Elena maps the harbour with Mara.');
    expect(body.indexOf('## Details')).toBeLessThan(body.indexOf('## Connections'));
    expect(body.indexOf('## Connections')).toBeLessThan(body.indexOf('## Posts'));
    expect(body.indexOf('## Posts')).toBeLessThan(body.indexOf('## Life'));
    expect(body).toContain('### Background');
    expect(body).toContain('- Age: 34');
    expect(body).toContain('- Mara — sister (attitude 3, two-way)');
    expect(body).toContain('### The letter');
    expect(body).toContain('- Born: year 1204, month 3, day 2');
    expect(body).toContain('- Died: year 1260 (at sea)');
    expect(body).not.toContain('alert(1)');
    expect(read.value.dropped.scripts).toBe(1);
    expect(read.value.remoteImages).toEqual(['https://example.com/x.png']);
    expect(page?.description).toContain('Elena maps the harbour');
  });

  it('keeps the event and the calendar reminder in one world-history index', async () => {
    const read = await readKanka(zipOf(CAMPAIGN));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.history?.title).toBe('World history');
    expect(read.value.history?.body).toContain('- Year 1204 — The Flood');
    expect(read.value.history?.body).toContain('- year 1204, month 8, day 1 — The Flood (the ninth wave)');
    // A birth or a death is a lifespan, not a world event.
    expect(read.value.history?.body).not.toContain('Elena');
  });

  it('keeps the gallery, refuses SVG and counts a picture the export does not carry', async () => {
    const read = await readKanka(zipOf(CAMPAIGN));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.gallery?.title).toBe('Campaign gallery');
    expect(read.value.gallery?.body).toContain('Harbour at dawn');
    expect(read.value.refusedSvg).toBe(1);
    expect(read.value.assetData.size).toBe(2);

    const missing = await readKanka(zipOf({ ...CAMPAIGN, 'characters/elena_11.json': (CAMPAIGN['characters/elena_11.json'] as string).replace('campaigns/1/elena.png', 'campaigns/1/gone.png') }));
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.missingPictures).toBe(1);
  });

  it('skips an unsupported picture as a named loss and imports the rest of the campaign', async () => {
    const unsupported = Uint8Array.from(atob('R0lGODlhAQABAAAAACw='), (c) => c.charCodeAt(0));
    const withGif = {
      ...CAMPAIGN,
      'characters/elena_11.json': (CAMPAIGN['characters/elena_11.json'] as string).replace('campaigns/1/elena.png', 'campaigns/1/elena.gif'),
      'campaigns/1/elena.gif': unsupported,
    };
    const read = await readKanka(zipOf(withGif));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const page = read.value.pages.find((row) => row.entityId === 11)?.body ?? '';
    expect(page).toContain('Elena maps the harbour');
    expect(page).not.toContain('import:kanka-image-1');
    expect(read.value.assetData.size).toBe(1);
    expect(read.value.gallery?.body).toContain('Harbour at dawn');
    const loss = read.value.losses.find((row) => row.code === 'image-unreadable');
    expect(loss?.message).toContain('campaigns/1/elena.gif');
    expect(loss?.message).toContain('not a PNG, JPEG or WebP');
  });

  it('removes an unsupported inline picture whose alt text holds a closing bracket', async () => {
    const unsupported = Uint8Array.from(atob('R0lGODlhAQABAAAAACw='), (c) => c.charCodeAt(0));
    const withInlineGif = {
      ...CAMPAIGN,
      'characters/elena_11.json': entity(11, 'Elena', {
        entry: '<p>Before <img src="campaigns/1/inline.gif" alt="bracket]alt"/> after.</p>',
      }),
      'campaigns/1/inline.gif': unsupported,
    };
    const read = await readKanka(zipOf(withInlineGif));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const page = read.value.pages.find((row) => row.entityId === 11)?.body ?? '';
    expect(page).toContain('Before  after.');
    expect(page).not.toContain('import:kanka-entry-11-');
    expect(page).not.toContain('bracket]alt');
    expect(read.value.losses.some((row) => row.code === 'image-unreadable' && row.message?.includes('campaigns/1/inline.gif'))).toBe(true);
  });

  it('names an uppercase data URI as an embedded picture, not by its payload', async () => {
    const withDataUri = {
      ...CAMPAIGN,
      'characters/elena_11.json': entity(11, 'Elena', {
        entry: '<p>Before <img src="DATA:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="embedded"/> after.</p>',
      }),
    };
    const read = await readKanka(zipOf(withDataUri));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const loss = read.value.losses.find((row) => row.code === 'image-unreadable');
    expect(loss?.message).toContain('an embedded picture');
    expect(loss?.message).not.toContain('R0lGODlh');
  });

  it('never lets a script’s text through, even when an entry is not readable HTML', async () => {
    const broken =
      '<p>Unclosed <b>bold<script>alert(1)</script><style>p{color:red}</style> and a stray </p> tag.' +
      ' <<script>alert(2)</script> <script>alert(3)';
    const read = await readKanka(zipOf({ ...CAMPAIGN, 'characters/mara_12.json': entity(12, 'Mara', { entry: broken }) }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const body = read.value.pages.find((row) => row.entityId === 12)?.body ?? '';
    expect(body).toContain('Unclosed');
    expect(body).not.toContain('alert(1)');
    expect(body).not.toContain('alert(2)');
    expect(body).not.toContain('alert(3)');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('color:red');
    expect(read.value.losses.some((loss) => loss.message?.includes('not readable HTML'))).toBe(true);
  });

  it('keeps an entry’s picture and a post’s picture under their own refs', async () => {
    const withTwo = {
      ...CAMPAIGN,
      'characters/elena_11.json': (CAMPAIGN['characters/elena_11.json'] as string)
        .replace('She never sent it.', 'She never sent it.<img src=\\"campaigns/1/post.png\\" alt=\\"post\\"/>')
        .replace('https://example.com/x.png', 'campaigns/1/inline.png'),
      'campaigns/1/inline.png': PNG,
      'campaigns/1/post.png': PNG,
    };
    const read = await readKanka(zipOf(withTwo));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const body = read.value.pages.find((row) => row.entityId === 11)?.body ?? '';
    const refs = [...body.matchAll(/!\[[^\]]*\]\((import:kanka-entry-11-[^)]+)\)/g)].map((match) => match[1]);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    for (const ref of refs) expect(read.value.assetData.has(ref ?? '')).toBe(true);
  });

  it('caps an entity’s keywords at the field’s limit and names the rest', async () => {
    const many = { ...CAMPAIGN };
    const tags = Array.from({ length: 40 }, (_, index) => `tag ${index + 1}`);
    many['characters/elena_11.json'] = entity(11, 'Elena', {
      entry: '<p>Elena maps the harbour.</p>',
      entityTags: tags.map((_tag, index) => ({ entity_id: 11, tag_id: 100 + index })),
    });
    for (const [index, tag] of tags.entries()) many[`tags/t${100 + index}_${100 + index}.json`] = entity(100 + index, tag);
    const read = await readKanka(zipOf(many));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // 41 offered (the module word plus 40 tags): 32 kept, the rest named.
    expect(read.value.keywords.get(11)).toHaveLength(32);
    expect(read.value.keywordOverflow).toHaveLength(9);
    expect(read.value.keywordOverflow[0]).toBe('tag 32');
  });

  it('names a mention whose target the export does not carry, and counts it', () => {
    const names = new Map([[12, 'Mara']]);
    expect(rewriteMentions('with [entity:12]', names)).toEqual({ text: 'with Mara', unresolved: 0, targets: [12] });
    expect(rewriteMentions('with [entity:99|the stranger]', names)).toEqual({ text: 'with the stranger', unresolved: 1, targets: [] });
    expect(rewriteMentions('with [entity:99]', names)).toEqual({ text: 'with #99', unresolved: 1, targets: [] });
    // A label stops at a nested or unclosed `[entity:` instead of spanning it.
    expect(rewriteMentions('with [entity:99|a [entity:12]', names)).toEqual({
      text: 'with [entity:99|a Mara',
      unresolved: 0,
      targets: [12],
    });
  });
});
