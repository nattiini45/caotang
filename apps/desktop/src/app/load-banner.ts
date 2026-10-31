/**
 * What the editor's load banner says ([editor-engine.md] §3.3 and §5), as the sentences a writer reads.
 *
 * Pure, so the wording is checked without a browser: the banner component renders these strings and
 * nothing else. Nothing here is an error. The text is kept as it was typed, and the banner says what a
 * save will do to it.
 */

import type { LossWarningGroup } from '@caotang/editor';
import { numberFormat } from '@caotang/i18n';
import { plural, select, t } from '@lingui/core/macro';

/* lingui-set comment="The editor load banner. Interpolated values: count and blocks are numbers; noun is the kind of Markdown construct a load kept as it was typed; line is a line number." */

import { formatterLocale } from '../i18n/format-locale.js';

/**
 * One line for one group of losses: how many, what they are, what a save does to them, and where. The effect is
 * a phrase that does not change with the count, so "1 table" and "2 tables" read the same way. The construct and the
 * effect are branches of one message, so a translator sees the whole line.
 */
export function describeLossGroup(group: LossWarningGroup, locale: string = formatterLocale()): string {
  const nodes = group.nodes;
  const count = formatCount(nodes, locale);
  const kind = group.mdastType;
  const other = group.mdastType;
  const effect = group.code === 'unsupported-node' ? 'unsupported' : group.code === 'lossy-attribute' ? 'lossy' : 'flattened';
  const line = group.line;
  const noun = select(kind, {
    table: plural(nodes, { one: 'table', other: 'tables' }),
    html: plural(nodes, { one: 'raw HTML block', other: 'raw HTML blocks' }),
    footnoteReference: plural(nodes, { one: 'footnote', other: 'footnotes' }),
    footnoteDefinition: plural(nodes, { one: 'footnote', other: 'footnotes' }),
    definition: plural(nodes, { one: 'reference definition', other: 'reference definitions' }),
    linkReference: plural(nodes, { one: 'reference link', other: 'reference links' }),
    imageReference: plural(nodes, { one: 'reference image', other: 'reference images' }),
    listItem: plural(nodes, { one: 'task-list item', other: 'task-list items' }),
    code: plural(nodes, { one: 'code block', other: 'code blocks' }),
    emphasis: 'nested emphasis',
    strong: 'nested bold',
    delete: 'nested strikethrough',
    other: `${other}`,
  });
  if (line === null) {
    return t`${count} ${noun}: ${select(effect, { unsupported: 'kept as plain text', lossy: 'a detail not kept', other: 'structure flattened' })}.`;
  }
  return t`${count} ${noun}: ${select(effect, { unsupported: 'kept as plain text', lossy: 'a detail not kept', other: 'structure flattened' })} (line ${line}).`;
}

/**
 * The dialect notice's sentence (§5): a save writes these blocks in Caotang's spelling. The words do not change, so
 * the sentence says so.
 */
export function reStyleSentence(blocks: number, locale: string = formatterLocale()): string {
  const count = formatCount(blocks, locale);
  return t`Saving will re-style ${count} ${plural(blocks, { one: 'block', other: 'blocks' })} to Caotang’s Markdown spelling. The words stay the same.`;
}

/** A count grouped the way the formatter locale groups numbers (i18n.md §4.2). */
function formatCount(n: number, locale: string): string {
  return numberFormat(locale).format(n);
}
