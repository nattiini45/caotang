/**
 * The live editor's schema is §3's schema — checked on the schema Tiptap builds, not
 * on the list of extensions that is supposed to build it.
 *
 * ## What is compared, and against what
 *
 * `caotangSchema` is the §3 transcription the save path reads (`spec-parity.test.ts`
 * already compares it to the spec file). This file builds a real `@tiptap/core`
 * editor from `caotangExtensions()` with no element, which is enough to construct the
 * schema without a DOM, and compares the two schemas field by field: node and mark
 * names, mark rank, group membership, content expressions, the inline and atom
 * flags, attribute names and whether each attribute has a default. The comparison
 * reads both schemas, so neither side's values are copied into this file.
 *
 * ## The one divergence that is asserted by name
 *
 * `bullet_list` and `ordered_list` carry the group `block list` on the live side
 * and `block` in §3.1. The extra `list` token is what `isList` in `@tiptap/core`
 * requires for the toggle-list commands, and `extensions.ts` explains why it stays.
 * The comparator accepts exactly that superset on exactly those two nodes, and
 * reports any other extra group, so a new divergence cannot hide behind the allowance.
 *
 * ## Controls, in the direction each can fail
 *
 * 1. The stock Tiptap names (`bulletList`, `listItem`) must be reported as not in
 *    §3.1, and §3.1's names as missing. A comparator that passed the stock set would
 *    pass anything.
 * 2. A link at Tiptap's default priority must be reported as a mark-order divergence,
 *    because mark rank is the one property that changes saved bytes and nothing
 *    else in the comparison would notice it.
 */
import { Editor } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import Bold from '@tiptap/extension-bold';
import BulletList from '@tiptap/extension-bullet-list';
import Document from '@tiptap/extension-document';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import ListItem from '@tiptap/extension-list-item';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { describe, expect, it } from 'vitest';
import { caotangSchema } from '../src/schema.js';
import { caotangExtensions } from '../src/tiptap/extensions.js';

/** §3.1's names that are allowed to carry the extra `list` group token. */
const LIST_GROUP_ALLOWANCE = new Set(['bullet_list', 'ordered_list']);

/** Build the live schema through Tiptap, with no element, so no DOM is needed. */
const liveSchemaOf = (extensions: ReturnType<typeof caotangExtensions>): Schema => {
  const editor = new Editor({
    element: null,
    extensions,
    injectCSS: false,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  const schema = editor.schema;
  editor.destroy();
  return schema;
};

const tokens = (group: string | undefined): string[] => (group ?? '').split(' ').filter(Boolean);

/** Whether an attribute spec carries an own `default`, which is what makes it optional. */
const hasDefault = (spec: object): boolean => Object.prototype.hasOwnProperty.call(spec, 'default');

/**
 * Every field the comparison reads, as a list of human-readable divergences. An
 * empty list means the two schemas agree on everything measured here.
 */
const divergencesOf = (live: Schema, caotang: Schema): string[] => {
  const out: string[] = [];
  const liveNodes = Object.keys(live.nodes);
  const caotangNodes = Object.keys(caotang.nodes);
  for (const name of caotangNodes) if (!live.nodes[name]) out.push(`node ${name}: missing from the live schema`);
  for (const name of liveNodes) if (!caotang.nodes[name]) out.push(`node ${name}: not in §3.1`);

  const liveMarkOrder = Object.keys(live.marks);
  const caotangMarkOrder = Object.keys(caotang.marks);
  if (liveMarkOrder.join(',') !== caotangMarkOrder.join(',')) {
    out.push(`mark order: live [${liveMarkOrder.join(', ')}] vs §3.2 [${caotangMarkOrder.join(', ')}]`);
  }

  for (const name of caotangNodes) {
    const caotangSpec = caotang.nodes[name]!.spec;
    const liveType = live.nodes[name];
    if (!liveType) continue;
    const liveSpec = liveType.spec;
    const caotangGroups = tokens(caotangSpec.group);
    const liveGroups = tokens(liveSpec.group);
    const missing = caotangGroups.filter((t) => !liveGroups.includes(t));
    const extra = liveGroups.filter((t) => !caotangGroups.includes(t));
    if (missing.length > 0) out.push(`node ${name}: group ${missing.join(' ')} missing`);
    if (extra.length > 0 && !(LIST_GROUP_ALLOWANCE.has(name) && extra.join(' ') === 'list')) {
      out.push(`node ${name}: unexpected group token ${extra.join(' ')}`);
    }
    if ((caotangSpec.content ?? '') !== (liveSpec.content ?? '')) {
      out.push(`node ${name}: content "${liveSpec.content ?? ''}" vs §3.1 "${caotangSpec.content ?? ''}"`);
    }
    if ((caotangSpec.marks ?? '') !== (liveSpec.marks ?? '')) {
      out.push(`node ${name}: marks "${liveSpec.marks ?? ''}" vs "${caotangSpec.marks ?? ''}"`);
    }
    const flags: Array<[string, boolean, boolean]> = [
      ['inline', !!caotangSpec.inline, !!liveSpec.inline],
      ['atom', !!caotangSpec.atom, !!liveSpec.atom],
      ['selectable', caotangSpec.selectable !== false, liveSpec.selectable !== false],
      ['draggable', !!caotangSpec.draggable, !!liveSpec.draggable],
      ['code', !!caotangSpec.code, !!liveSpec.code],
      ['defining', !!caotangSpec.defining, !!liveSpec.defining],
      ['isolating', !!caotangSpec.isolating, !!liveSpec.isolating],
    ];
    for (const [flag, want, got] of flags) {
      if (want !== got) out.push(`node ${name}: ${flag} ${got} vs §3.1 ${want}`);
    }
    out.push(...attrDivergences(`node ${name}`, caotangSpec.attrs, liveSpec.attrs));
  }

  for (const name of caotangMarkOrder) {
    const caotangSpec = caotang.marks[name]!.spec;
    const liveType = live.marks[name];
    if (!liveType) {
      out.push(`mark ${name}: missing from the live schema`);
      continue;
    }
    const liveSpec = liveType.spec;
    // ProseMirror's default for an absent `excludes` is the mark itself, so the
    // effective exclusion is compared rather than the literal, which the code mark
    // spells out as `'code'`.
    const effective = (excludes: string | undefined): string => excludes ?? name;
    if (effective(liveSpec.excludes) !== effective(caotangSpec.excludes)) {
      out.push(`mark ${name}: excludes ${effective(liveSpec.excludes)} vs §3.2 ${effective(caotangSpec.excludes)}`);
    }
    // ProseMirror treats an absent `inclusive` as true, so compare the effective value.
    if ((liveSpec.inclusive ?? true) !== (caotangSpec.inclusive ?? true)) {
      out.push(`mark ${name}: inclusive ${String(liveSpec.inclusive)} vs §3.2 ${String(caotangSpec.inclusive)}`);
    }
    if (!!liveSpec.code !== !!caotangSpec.code) out.push(`mark ${name}: code flag differs`);
    out.push(...attrDivergences(`mark ${name}`, caotangSpec.attrs, liveSpec.attrs));
  }
  return out;
};

/** Attribute names, and for each name whether it has a default and what it is. */
const attrDivergences = (
  where: string,
  caotang: Record<string, object> | undefined,
  live: Record<string, object> | undefined,
): string[] => {
  const out: string[] = [];
  const want = caotang ?? {};
  const got = live ?? {};
  for (const name of Object.keys(want)) {
    if (!(name in got)) {
      out.push(`${where}: attr ${name} missing`);
      continue;
    }
    const w = want[name]!;
    const g = got[name]!;
    if (hasDefault(w) !== hasDefault(g)) {
      out.push(`${where}: attr ${name} ${hasDefault(g) ? 'has' : 'lacks'} a default, §3 says ${hasDefault(w) ? 'optional' : 'required'}`);
    } else if (hasDefault(w) && JSON.stringify((w as { default?: unknown }).default) !== JSON.stringify((g as { default?: unknown }).default)) {
      out.push(`${where}: attr ${name} default ${JSON.stringify((g as { default?: unknown }).default)} vs §3 ${JSON.stringify((w as { default?: unknown }).default)}`);
    }
  }
  for (const name of Object.keys(got)) if (!(name in want)) out.push(`${where}: attr ${name} not in §3`);
  return out;
};

describe('the live Tiptap schema is §3’s schema', () => {
  const live = liveSchemaOf(caotangExtensions());

  it('builds every §3.1 node and every §3.2 mark, and nothing else', () => {
    expect(Object.keys(live.nodes).sort()).toEqual(Object.keys(caotangSchema.nodes).sort());
    expect(Object.keys(live.marks).sort()).toEqual(Object.keys(caotangSchema.marks).sort());
  });

  it('agrees with §3 on every measured field, bar the one allowance named in this file', () => {
    expect(divergencesOf(live, caotangSchema)).toEqual([]);
  });

  it('gives the list nodes the §3.1 group, and only the one extra token the toggle commands need', () => {
    expect(tokens(live.nodes['bullet_list']!.spec.group)).toEqual(['block', 'list']);
    expect(tokens(live.nodes['ordered_list']!.spec.group)).toEqual(['block', 'list']);
    expect(tokens(live.nodes['paragraph']!.spec.group)).toEqual(['block']);
  });

  it('reads the mark rank from the mark order, which is what changes saved bytes', () => {
    expect(Object.keys(live.marks)).toEqual(['em', 'strong', 'strike', 'code', 'link']);
  });

  it('control: the stock Tiptap names are reported as not in §3.1, and §3.1’s names as missing', () => {
    const stock = liveSchemaOf([Document, Paragraph, Text, BulletList, ListItem]);
    const report = divergencesOf(stock, caotangSchema);
    expect(report).toContain('node bulletList: not in §3.1');
    expect(report).toContain('node bullet_list: missing from the live schema');
  });

  it('control: a link at Tiptap’s default priority is reported as a mark-order divergence', () => {
    const unranked = liveSchemaOf([Document, Paragraph, Text, Italic.extend({ name: 'em' }), Bold.extend({ name: 'strong' }), Link]);
    const report = divergencesOf(unranked, caotangSchema);
    expect(report.some((line) => line.startsWith('mark order:'))).toBe(true);
  });
});

describe('the focus extension set — what each entry is for', () => {
  it('mounts no character counter, because nothing reads one', () => {
    // §10 named "CharacterCount (feeds §9)", and §9's counts are computed by
    // the store's `countBody` over the body projection — one rule, pinned by
    // `test/tiptap-adapter.test.ts` ("wordCount is the store's count of the
    // body, not a second copy of its rule").
    //
    // CharacterCount was the **second** rule, and a different one: it counts
    // the PM text, so it misses the body projection's blockquote marker that
    // §9's pinned reading counts (`> quoted` → 2 words). Nothing ever read
    // its storage, so the number on screen was `countBody`'s and the plugin's
    // was discarded — while it recomputed both figures over the whole
    // document on every transaction, on the hot path, for a value no one
    // displayed.
    //
    // The claim is on the **mounted set**, not on a grep: an extension that is
    // imported but not mounted costs nothing, and one that is mounted and read
    // nowhere costs the transaction it runs on.
    const names = caotangExtensions({ role: 'focus' }).map((extension) => extension.name);
    expect(names).not.toContain('characterCount');
  });

  it('still mounts the extensions §10 does name, so the removal is not a shortcut', () => {
    // The control for the assertion above: a set that mounted *nothing* would
    // satisfy it. The interactive half of §10's list is named here so the
    // removal of one entry cannot be a removal of several.
    const names = caotangExtensions({ role: 'focus' }).map((extension) => extension.name);
    for (const expected of [
      'listKeymap',
      'dropCursor',
      'gapCursor',
      'placeholder',
      'undoRedo',
      'caotangPaste',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });
});
