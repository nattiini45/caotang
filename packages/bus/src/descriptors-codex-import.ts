/**
 * `codex.importBatch` — the writer's batch import of codex entries, one command and so one undo group (codex.md §7.1).
 *
 * **Why a command of its own.** The agent's `codex.import` (a harness tool over `codex.upsert`) is capped at 20 entries per
 * call, and that cap stays: it bounds what one plan card shows. An import the writer runs from the app (a Kanka campaign, a
 * Scrivener Characters folder, a CSV of 600 rows) needs every entry, and the Research pages that hold their full text, in one
 * Undo. That is the `shot.importImages` precedent (storyboard.md §6): one user command = one undo group. The descriptor is
 * `agentRisk: 'never'`, so the gate refuses an agent's call outright, and the harness lists it as never exposed.
 *
 * **Shape.** `entries` are create-only, and may be empty when `pages` are not (every row imported as a page only). Each names the one document it attaches to and cites: an existing document
 * (`attachTo`), or one of the `pages` this same command creates (`page`, an index into `pages`), the two-layer pattern
 * where the full article is a Research document and the entry cites it. `cite` is the passage, `{from, to, quote}`, in UTF-16
 * offsets into that document's body; the caller locates it (the harness's `planCodexImportBatch` does, by codex.md §4's
 * rules), and validate checks the quote is the text at those offsets. `pages` are created under `parentId`, which defaults to
 * the research folder. The provenance is the command's own: every entry is stamped `origin: 'import'`, and no param names it.
 *
 * **Validation is whole-batch and per entry.** Every entry is checked before anything is written, and every failure is listed
 * in one refusal, each naming the entry by its name: the field limits of codex.md §2, the type and policy enums, the document
 * or page it cites, the citation, and collisions. A name or alias equal (case-insensitively) to an existing entry's name or
 * alias, or to another entry's in the batch, is refused naming the holder: an import never merges (codex.md §7). The
 * writer's per-row answer to a collision (Skip, Rename, Import as page only) is made in the preview, before the command.
 */

import type { CodexImportBatchEntry, CodexImportBatchParams, CodexImportPage, CommandDescriptor, ValidationNode, ValidationSnapshot } from './command.js';
import { CODEX_POLICIES, CODEX_TYPES } from './codex-enums.js';
import {
  CHAPTERLESS_DOCUMENT_REFUSAL,
  CODEX_ALIAS_CHARS_MAX,
  CODEX_ALIASES_MAX,
  CODEX_DESCRIPTION_MAX,
  CODEX_EXCLUDE_CHARS_MAX,
  CODEX_EXCLUDE_MAX,
  CODEX_NAME_MAX,
  CODEX_SOURCE_QUOTE_MAX,
  KEYWORD_CHARS_MAX,
  KEYWORDS_MAX,
} from './descriptors.js';
import { ok, type CommandError, type PerOpFailure, type Result } from './result.js';
import { batchRefusal, invalid, invalidError, isContainer, isRecord, limitExceeded, limitExceededError, notFound, requireDeclaredParams, showValue } from './params.js';

/**
 * The most entries one `codex.importBatch` takes. Far above a real campaign (the acceptance fixture is 600), and a ceiling so
 * one command's undo artifact and its refusal list stay bounded.
 */
export const CODEX_IMPORT_BATCH_MAX = 5000;
/** The most Research pages one batch creates: one per entry at most, in practice. */
export const CODEX_IMPORT_PAGES_MAX = 5000;
/** A page's title, in characters: the binder shows it. */
export const CODEX_IMPORT_PAGE_TITLE_MAX = 200;
/** The text of every page of one batch, summed, in characters. */
export const CODEX_IMPORT_PAGES_TEXT_MAX = 20_000_000;

/** The keys one entry carries. A key outside the set is refused, never dropped (§9's closed key set). */
export const CODEX_IMPORT_ENTRY_KEYS = [
  'name',
  'aliases',
  'type',
  'description',
  'includePolicy',
  'caseSensitive',
  'exclude',
  'keywords',
  'attachTo',
  'page',
  'cite',
] as const;
const PAGE_KEYS = ['title', 'body'] as const;
const CITE_KEYS = ['from', 'to', 'quote'] as const;

/** The folder the pages land in when the caller names none: research, the home of imported wiki pages (codex.md §7.1). */
const DEFAULT_PAGE_PARENT = 'research';

const codePoints = (text: string): number => [...text].length;

/** The parent the pages are created under, resolved and checked. Absent means research. */
function pageParentOf(snapshot: ValidationSnapshot, params: Record<string, unknown>, creating: boolean): Result<string, CommandError> {
  const raw = params['parentId'];
  const id = raw === undefined ? DEFAULT_PAGE_PARENT : raw;
  if (typeof id !== 'string' || id.length === 0) return invalid(`params.parentId must be a node id, got ${showValue(raw)}`, 'name the folder the pages go into, or leave it out for research', 'parentId');
  const node: ValidationNode | undefined = snapshot.manifest.tree.find((candidate) => candidate.id === id);
  if (node === undefined) return notFound(`no node with id "${id}" to create the pages under`, 'use binder.read_tree to list valid ids', 'parentId');
  if (node.id === 'root') {
    return invalid(
      'the project root is not a place for a node: the binder shows only the manuscript and research, so a page made here would never appear',
      'leave parentId out to put the pages in research, or name a folder inside it',
      'parentId',
    );
  }
  if (!isContainer(node)) return invalid(`parent "${node.id}" is a ${node.type} and cannot hold children`, 'name a folder: only folders hold children', 'parentId');
  if (node.kind === 'storyboard' || node.kind === 'show') {
    return invalid(`"${node.id}" is a ${node.kind} folder, which does not hold research pages`, 'name a plain folder, or leave parentId out for research', 'parentId');
  }
  if (creating && node.id === 'manuscript') return invalid(CHAPTERLESS_DOCUMENT_REFUSAL, 'leave parentId out to put the pages in research, or name a chapter', 'parentId');
  return ok(node.id);
}

/** A string list within `max` items, each `min`–`maxChars` code points. The first problem, or the list. */
function stringList(value: unknown, field: string, max: number, maxChars: number, minChars: number): Result<string[], CommandError> {
  if (!Array.isArray(value)) return invalid(`${field} must be an array of strings, got ${showValue(value)}`, undefined, field);
  if (value.length > max) return limitExceeded(`${field} holds ${value.length} items, limit ${max}`, `keep at most ${max}`, field);
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string') return invalid(`${field}[${i}] must be a string, got ${showValue(item)}`, undefined, `${field}[${i}]`);
    const length = codePoints(item);
    if (length < minChars || length > maxChars || (minChars > 0 && item.trim() === '')) {
      return invalid(`${field}[${i}] is ${length} characters, must be ${minChars}–${maxChars}${minChars > 0 ? ' and not blank' : ''}`, undefined, `${field}[${i}]`);
    }
    out.push(item);
  }
  return ok(out);
}

/** Every name and alias the codex holds, keyed by its lowercase form, with the entry that holds it. Names first. */
function heldTerms(snapshot: ValidationSnapshot): Map<string, { readonly name: string; readonly id: string }> {
  const terms = new Map<string, { readonly name: string; readonly id: string }>();
  const entries = snapshot.manifest.codex ?? [];
  for (const entry of entries) terms.set(entry.name.toLowerCase(), { name: entry.name, id: entry.id });
  for (const entry of entries) {
    for (const alias of entry.aliases ?? []) {
      const key = alias.toLowerCase();
      if (!terms.has(key)) terms.set(key, { name: entry.name, id: entry.id });
    }
  }
  return terms;
}

/** The pages, each checked. Failures are pushed per page; the list holds a page only when it is valid. */
function validatePages(value: unknown, failures: PerOpFailure[]): (CodexImportPage | undefined)[] | CommandError {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalidError(`params.pages must be an array of {title, body}, got ${showValue(value)}`, 'pass one page for each Research document the import creates', 'pages');
  if (value.length > CODEX_IMPORT_PAGES_MAX) {
    return limitExceededError(`params.pages has ${value.length} pages, limit ${CODEX_IMPORT_PAGES_MAX}`, `create at most ${CODEX_IMPORT_PAGES_MAX} pages in one import`, 'pages');
  }
  let total = 0;
  const pages: (CodexImportPage | undefined)[] = [];
  for (const [index, raw] of value.entries()) {
    const target = `pages[${index}]`;
    const fail = (message: string, hint?: string, at: string = target): void => {
      failures.push({ target: at, code: 'invalid-params', message: `${target}: ${message}`, ...(hint === undefined ? {} : { correctiveHint: hint }) });
      pages.push(undefined);
    };
    if (!isRecord(raw)) {
      fail(`must be an object {title, body}, got ${showValue(raw)}`);
      continue;
    }
    const extra = Object.keys(raw).find((key) => !(PAGE_KEYS as readonly string[]).includes(key));
    if (extra !== undefined) {
      fail(`"${extra}" is not a field of a page`, 'a page carries only title and body', `${target}.${extra}`);
      continue;
    }
    const { title, body } = raw;
    if (typeof title !== 'string' || title.trim() === '') {
      fail('title must be a non-blank string', 'give each page the title the binder shows', `${target}.title`);
      continue;
    }
    if (codePoints(title) > CODEX_IMPORT_PAGE_TITLE_MAX) {
      fail(`title is ${codePoints(title)} characters, limit ${CODEX_IMPORT_PAGE_TITLE_MAX}`, `shorten the title to ${CODEX_IMPORT_PAGE_TITLE_MAX} characters`, `${target}.title`);
      continue;
    }
    if (typeof body !== 'string') {
      fail(`body must be a string, got ${showValue(body)}`, undefined, `${target}.body`);
      continue;
    }
    total += body.length;
    pages.push({ title, body });
  }
  if (total > CODEX_IMPORT_PAGES_TEXT_MAX) {
    return limitExceededError(`the pages hold ${total} characters, limit ${CODEX_IMPORT_PAGES_TEXT_MAX}`, 'split the import into smaller batches', 'pages');
  }
  return pages;
}

export const codexImportBatch: CommandDescriptor<CodexImportBatchParams> = {
  mutates: 'project',
  // The writer's own import, from the app. An agent imports through `codex.import`, which keeps its 20-entry cap.
  agentRisk: 'never',
  // One restore for the whole batch: every entry it created and every page it made go, newest first.
  undo: 'compensable',
  validate: (params, snapshot): Result<CodexImportBatchParams, CommandError> => {
    const p = requireDeclaredParams('codex.importBatch', params);
    if (!p.ok) return p;
    const list = p.value['entries'];
    if (!Array.isArray(list)) {
      return invalid(`params.entries must be an array of entries, got ${showValue(list)}`, 'pass one entry for each codex entry the import creates', 'entries');
    }
    if (list.length > CODEX_IMPORT_BATCH_MAX) {
      return limitExceeded(`params.entries has ${list.length} entries, limit ${CODEX_IMPORT_BATCH_MAX}`, `import at most ${CODEX_IMPORT_BATCH_MAX} entries at once`, 'entries');
    }

    const failures: PerOpFailure[] = [];
    const pages = validatePages(p.value['pages'], failures);
    if (!Array.isArray(pages)) return { ok: false, error: pages };
    // An import of pages only (every row answered "Import as page only") is still an import; an import of nothing is not.
    if (list.length === 0 && pages.length === 0) {
      return invalid('the import holds no entries and no pages, so there is nothing to create', 'pass at least one entry or one page', 'entries');
    }
    const parent = pageParentOf(snapshot, p.value, pages.length > 0);
    if (!parent.ok) return parent;

    const held = heldTerms(snapshot);
    const claimed = new Map<string, string>();
    const nodes = new Map(snapshot.manifest.tree.map((node) => [node.id, node] as const));
    const entries: CodexImportBatchEntry[] = [];

    for (const [index, raw] of list.entries()) {
      const target = `entries[${index}]`;
      const label = isRecord(raw) && typeof raw['name'] === 'string' && raw['name'].trim() !== '' ? `"${raw['name']}"` : '(no name)';
      const problems: { message: string; hint?: string; at: string; code?: PerOpFailure['code'] }[] = [];
      const fail = (message: string, field?: string, hint?: string, code?: PerOpFailure['code']): void => {
        problems.push({ message, at: field === undefined ? target : `${target}.${field}`, ...(hint === undefined ? {} : { hint }), ...(code === undefined ? {} : { code }) });
      };

      if (!isRecord(raw)) {
        failures.push({ target, code: 'invalid-params', message: `${target} ${label}: must be an object, got ${showValue(raw)}` });
        continue;
      }
      const extra = Object.keys(raw).filter((key) => !(CODEX_IMPORT_ENTRY_KEYS as readonly string[]).includes(key));
      if (extra.length > 0) {
        failures.push({
          target: `${target}.${extra[0]}`,
          code: 'invalid-params',
          message: `${target} ${label}: ${extra.map((key) => `"${key}"`).join(', ')} ${extra.length === 1 ? 'is not a field' : 'are not fields'} an imported entry carries`,
          correctiveHint: extra.includes('origin')
            ? `origin is the command's own (every entry is stamped import); an entry's fields are: ${CODEX_IMPORT_ENTRY_KEYS.join(', ')}`
            : `an entry carries only: ${CODEX_IMPORT_ENTRY_KEYS.join(', ')}`,
        });
        continue;
      }

      const name = raw['name'];
      if (typeof name !== 'string' || name.trim() === '') fail('name is required and must not be blank — an entry is found by its name', 'name', 'give the entry a name');
      else if (codePoints(name) > CODEX_NAME_MAX) fail(`name is ${codePoints(name)} characters, limit ${CODEX_NAME_MAX}`, 'name', `shorten the name to ${CODEX_NAME_MAX} characters`, 'limit-exceeded');

      let aliases: string[] = [];
      if (raw['aliases'] !== undefined) {
        const result = stringList(raw['aliases'], 'aliases', CODEX_ALIASES_MAX, CODEX_ALIAS_CHARS_MAX, 1);
        if (result.ok) aliases = result.value;
        else fail(result.error.message, 'aliases', result.error.correctiveHint, result.error.code);
      }
      const type = raw['type'];
      if (type !== undefined && !(typeof type === 'string' && CODEX_TYPES.includes(type))) {
        fail(`type must be one of ${CODEX_TYPES.join(', ')}, got ${showValue(type)}`, 'type', 'map the source type to one of these, or to other');
      }
      const policy = raw['includePolicy'];
      if (policy !== undefined && !(typeof policy === 'string' && CODEX_POLICIES.includes(policy))) {
        fail(`includePolicy must be one of ${CODEX_POLICIES.join(', ')}, got ${showValue(policy)}`, 'includePolicy');
      }
      const description = raw['description'];
      if (description !== undefined) {
        if (typeof description !== 'string') fail(`description must be a string, got ${showValue(description)}`, 'description');
        else if (codePoints(description) > CODEX_DESCRIPTION_MAX) {
          fail(`description is ${codePoints(description)} characters, limit ${CODEX_DESCRIPTION_MAX}`, 'description', 'cut it at a paragraph boundary and keep the full text on the page', 'limit-exceeded');
        }
      }
      let keywords: string[] | undefined;
      if (raw['keywords'] !== undefined) {
        const result = stringList(raw['keywords'], 'keywords', KEYWORDS_MAX, KEYWORD_CHARS_MAX, 0);
        if (result.ok) keywords = result.value;
        else fail(result.error.message, 'keywords', result.error.correctiveHint, result.error.code);
      }
      let exclude: string[] | undefined;
      if (raw['exclude'] !== undefined) {
        const result = stringList(raw['exclude'], 'exclude', CODEX_EXCLUDE_MAX, CODEX_EXCLUDE_CHARS_MAX, 1);
        if (result.ok) exclude = result.value;
        else fail(result.error.message, 'exclude', result.error.correctiveHint, result.error.code);
      }
      const caseSensitive = raw['caseSensitive'];
      if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') fail(`caseSensitive must be a boolean, got ${showValue(caseSensitive)}`, 'caseSensitive');

      // The one document the entry attaches to and cites: an existing document, or a page of this batch. Exactly one.
      const attachTo = raw['attachTo'];
      const page = raw['page'];
      let body: string | undefined;
      if ((attachTo === undefined) === (page === undefined)) {
        fail('names neither a document nor a page to attach to, or names both', undefined, 'name the existing document with attachTo, or the page this import creates with page');
      } else if (attachTo !== undefined) {
        const node = typeof attachTo === 'string' ? nodes.get(attachTo) : undefined;
        if (node === undefined) fail(`attachTo names no node of this project (${showValue(attachTo)})`, 'attachTo', 'use binder.read_tree to list valid ids', 'not-found');
        else if (node.type !== 'document') fail(`attachTo "${node.id}" is a ${node.type}; an entry attaches to the document that names it`, 'attachTo');
        else body = snapshot.documents.get(node.id)?.body;
        if (node !== undefined && node.type === 'document' && body === undefined) fail(`the body of "${node.id}" is not loaded, so the citation cannot be checked`, 'attachTo', undefined, 'not-found');
      } else if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page >= pages.length) {
        fail(`page must be the index of one of the ${pages.length} pages, got ${showValue(page)}`, 'page');
      } else if (pages[page] === undefined) {
        fail(`page ${page} is refused itself (see pages[${page}])`, 'page');
      } else {
        body = pages[page]!.body;
      }

      // The citation: a verbatim slice of that document, at most 300 characters (codex.md §2).
      const cite = raw['cite'];
      let citation: CodexImportBatchEntry['cite'] | undefined;
      if (!isRecord(cite)) {
        fail(`cite must be {from, to, quote}, got ${showValue(cite)}`, 'cite', 'cite the first passage of the document that names the entry');
      } else if (Object.keys(cite).some((key) => !(CITE_KEYS as readonly string[]).includes(key))) {
        fail('cite carries only from, to and quote', 'cite');
      } else {
        const { from, to, quote } = cite;
        if (typeof from !== 'number' || !Number.isInteger(from) || from < 0 || typeof to !== 'number' || !Number.isInteger(to) || to < from) {
          fail(`cite needs whole offsets with 0 ≤ from ≤ to, got from ${showValue(from)} and to ${showValue(to)}`, 'cite');
        } else if (typeof quote !== 'string' || quote.length === 0) {
          fail('cite.quote must be the non-empty text at [from, to)', 'cite');
        } else if (codePoints(quote) > CODEX_SOURCE_QUOTE_MAX) {
          fail(`cite.quote is ${codePoints(quote)} characters, limit ${CODEX_SOURCE_QUOTE_MAX}`, 'cite', undefined, 'limit-exceeded');
        } else if (body !== undefined && body.slice(from, to) !== quote) {
          fail(`cite.quote is not the text at [${from}, ${to}) of the document it cites`, 'cite', 'locate the passage again in the body the entry attaches to');
        } else {
          citation = { from, to, quote };
        }
      }

      // Create-only: a term the codex or this batch already holds is a collision, never a merge.
      if (typeof name === 'string' && name.trim() !== '') {
        const own = new Set<string>();
        for (const term of [name, ...aliases]) {
          const key = term.toLowerCase();
          if (own.has(key)) {
            fail(`"${term}" is given twice for this entry, case-insensitively`, term === name ? 'name' : 'aliases', 'keep each name or alias once');
            continue;
          }
          own.add(key);
          const holder = held.get(key);
          if (holder !== undefined) {
            fail(
              `"${term}" collides with the existing entry "${holder.name}" (${holder.id}), case-insensitively; an import never merges into an entry`,
              term === name ? 'name' : 'aliases',
              'choose Skip, Rename or Import as page only for this row in the preview',
            );
            continue;
          }
          const sibling = claimed.get(key);
          if (sibling !== undefined) {
            fail(`"${term}" collides with "${sibling}" in this same import, case-insensitively`, term === name ? 'name' : 'aliases', 'choose Skip, Rename or Import as page only for one of the two rows');
          }
        }
      }

      if (problems.length > 0) {
        for (const problem of problems) {
          failures.push({
            target: problem.at,
            code: problem.code ?? 'invalid-params',
            message: `${target} ${label}: ${problem.message}`,
            ...(problem.hint === undefined ? {} : { correctiveHint: problem.hint }),
          });
        }
        continue;
      }
      const entryName = name as string;
      for (const term of [entryName, ...aliases]) claimed.set(term.toLowerCase(), entryName);
      entries.push({
        name: entryName,
        ...(raw['aliases'] === undefined ? {} : { aliases }),
        ...(type === undefined ? {} : { type: type as string }),
        ...(description === undefined ? {} : { description: description as string }),
        ...(policy === undefined ? {} : { includePolicy: policy as string }),
        ...(caseSensitive === undefined ? {} : { caseSensitive: caseSensitive as boolean }),
        ...(exclude === undefined ? {} : { exclude }),
        ...(keywords === undefined ? {} : { keywords }),
        ...(attachTo === undefined ? { page: page as number } : { attachTo: attachTo as string }),
        cite: citation!,
      });
    }

    if (failures.length > 0) {
      return batchRefusal(failures, 'fix every listed entry (or skip it in the preview) and import again — nothing was written');
    }
    return ok({
      entries,
      ...(pages.length === 0 ? {} : { pages: pages as CodexImportPage[] }),
      ...(pages.length === 0 && p.value['parentId'] === undefined ? {} : { parentId: parent.value }),
    });
  },
};
