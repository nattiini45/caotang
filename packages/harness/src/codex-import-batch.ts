/**
 * The plan of a writer's codex import — the pure step between a reader's rows and `codex.importBatch` (codex.md §7.1).
 *
 * A reader (CSV, Kanka, Plottr, Scrivener's Characters folder, Obsidian notes) hands over rows; the import preview shows what
 * this plan says, the writer answers each collision and toggles what it offers, and **Import** dispatches the one command the
 * plan built. Nothing here writes: a writer who cancels has changed nothing, because nothing was dispatched.
 *
 * **What the plan decides, per row.**
 * - The fields are fitted to codex.md §2, and every change is said in the row's notes: aliases trimmed, repeats of the name or of
 *   each other dropped case-insensitively, at most 10 kept; keywords at most 32 × 64; a description over 2,000 characters cut at
 *   the last paragraph boundary that fits (the full text stays on the page); a type outside the enum becomes `other`.
 * - **Collisions are never merged.** A name or alias the codex already holds, or an earlier row of the same import, is a
 *   collision, and the row is refused until the writer answers it: `skip` (nothing is made), `rename` (the name gets the source
 *   in brackets, "Hamlet (Kanka)", and any alias that still collides is dropped), or `page-only` (the row's page is made, with no
 *   entry). No answer leads to a merge.
 * - **The two-layer pattern.** An entry attaches to the document whose text names it: `attachTo`, an existing document, or the
 *   row's `page` (the full article), which becomes a Research document in the same command. A row with neither gets a page made
 *   from its name and description. The citation is the first passage that names the entry, by codex.md §4's rules, located the
 *   way `codex.import` locates it; a renamed row is located by the name its source used, since that is what the page says.
 * - **Include policy.** The row's own answer stands. Without one, a row the source marks private, secret or GM-only is
 *   `manual`, and so is a row the import scan flags (issue #54); everything else is `detected`.
 *
 * Every refused row is listed by name with its reason, and the plan carries no command until none is refused.
 */

import {
  CODEX_ALIAS_CHARS_MAX,
  CODEX_ALIASES_MAX,
  CODEX_DESCRIPTION_MAX,
  COMMAND_REGISTRY,
  KEYWORD_CHARS_MAX,
  KEYWORDS_MAX,
  type CodexImportBatchEntry,
  type CodexImportBatchParams,
  type CodexImportPage,
  type PerOpFailure,
} from '@caotang/bus';
import { CODEX_TYPES, type CodexEntry, type CodexIncludePolicy, type ProjectState } from '@caotang/store';

import { scanImport, type ImportHit } from './agent/untrusted.js';
import { locatePassage, nfcProblem } from './tools/codex-import.js';

/** The writer's answer to a collision, made in the preview. */
export type CodexImportCollisionChoice = 'skip' | 'rename' | 'page-only';

/** One row a reader hands over: an entry to be, and the text that holds it. */
export interface CodexImportRow {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** A Caotang type; a reader maps its vendor's type first. Anything else becomes `other`, with a note. */
  readonly type?: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  /** The writer's own answer in the preview. Absent, the plan picks (see the module comment). */
  readonly includePolicy?: CodexIncludePolicy;
  /** The source marks the row private, secret or GM-only. */
  readonly private?: boolean;
  readonly caseSensitive?: boolean;
  readonly exclude?: readonly string[];
  /** An existing document of the project whose text names the entry. */
  readonly attachTo?: string;
  /** The full article, made a Research document the entry attaches to. */
  readonly page?: { readonly title: string; readonly body: string };
  /** The writer's answer when the row collides. */
  readonly collision?: CodexImportCollisionChoice;
}

export interface CodexImportBatchOptions {
  /** The source's name, for a renamed row: "Kanka" gives "Hamlet (Kanka)". */
  readonly source: string;
  /** The folder the pages go into. Absent, research. */
  readonly parentId?: string;
}

export type CodexImportRowOutcome = 'create' | 'rename' | 'skip' | 'page-only' | 'refused';

/** What the plan does with one row, for the preview. */
export interface CodexImportRowPlan {
  readonly index: number;
  /** The row's name as the source gave it. */
  readonly name: string;
  readonly outcome: CodexImportRowOutcome;
  /** The name the entry is created with, when one is created. */
  readonly finalName?: string;
  readonly includePolicy?: CodexIncludePolicy;
  /** The collision the row met, when it met one, whatever the answer. */
  readonly collision?: string;
  /** Why the row is refused. Empty unless the outcome is `refused`. */
  readonly reasons: readonly string[];
  /** What the plan changed to fit the row to the codex. */
  readonly notes: readonly string[];
  readonly flags: readonly ('private' | 'injection')[];
}

export interface CodexImportBatchPlan {
  readonly rows: readonly CodexImportRowPlan[];
  /** Every refused row, by name, with its reasons: what the preview lists before Import can be pressed. */
  readonly refused: readonly { readonly index: number; readonly name: string; readonly reasons: readonly string[] }[];
  /**
   * Refusals of the whole command that belong to no row (the parent folder, the batch's size): what the preview shows above the rows.
   * Never pinned on a row, so a row the writer already answered is not shown as broken. Empty when the bus would take the batch.
   */
  readonly batch: readonly string[];
  /** The command's params. Absent while any row is refused or `batch` is not empty, or when there is nothing to create. */
  readonly params?: CodexImportBatchParams;
  readonly counts: { readonly create: number; readonly rename: number; readonly skip: number; readonly pageOnly: number; readonly refused: number; readonly pages: number };
  /** What the import scan found, across every name, description and page. Nothing is changed by it. */
  readonly scan: { readonly total: number; readonly hits: readonly ImportHit[] };
}

const HITS_MAX = 10;

/** Every name and alias the codex holds, keyed by its lowercase form. Names first, so an alias equal to a name is reported against the name's owner. */
function heldTerms(state: ProjectState): Map<string, string> {
  const terms = new Map<string, string>();
  const entries = state.manifest.codex ?? [];
  for (const entry of entries) terms.set(entry.name.toLowerCase(), entry.name);
  for (const entry of entries) {
    for (const alias of entry.aliases) if (!terms.has(alias.toLowerCase())) terms.set(alias.toLowerCase(), entry.name);
  }
  return terms;
}

const codePoints = (text: string): number => [...text].length;

/** A description within the limit: whole when it fits, else cut at the last paragraph boundary that fits, else at the limit. */
export function fitDescription(text: string): { readonly value: string; readonly cut: boolean } {
  if (codePoints(text) <= CODEX_DESCRIPTION_MAX) return { value: text, cut: false };
  const head = [...text].slice(0, CODEX_DESCRIPTION_MAX).join('');
  const boundary = head.lastIndexOf('\n\n');
  return { value: (boundary > 0 ? head.slice(0, boundary) : head).trimEnd(), cut: true };
}

/** The page a row without one gets: its name as the title and a heading, its description as the text. */
function defaultPage(name: string, description: string): CodexImportPage {
  return { title: name, body: description.trim() === '' ? `# ${name}\n` : `# ${name}\n\n${description.trim()}\n` };
}

/** The row a bus failure's target points at: `entries[i]` through the entries' rows, `pages[k]` through the pages' rows; else none. */
function failureRow(target: string, entryRow: readonly number[], pageRow: readonly number[]): number | undefined {
  const entry = /^entries\[(\d+)\]/.exec(target)?.[1];
  if (entry !== undefined) return entryRow[Number(entry)];
  const page = /^pages\[(\d+)\]/.exec(target)?.[1];
  if (page !== undefined) return pageRow[Number(page)];
  return undefined;
}

export function planCodexImportBatch(state: ProjectState, rows: readonly CodexImportRow[], options: CodexImportBatchOptions): CodexImportBatchPlan {
  const held = heldTerms(state);
  /** Terms earlier rows of this import claimed, with the name that claimed them. */
  const claimed = new Map<string, string>();
  const nodes = new Map(state.manifest.tree.map((node) => [node.id, node] as const));
  const plans: CodexImportRowPlan[] = [];
  const entries: CodexImportBatchEntry[] = [];
  /** The row each entry came from, so a bus failure can name the row. */
  const entryRow: number[] = [];
  const pages: CodexImportPage[] = [];
  /** The row each page came from, so a bus failure on `pages[k]` names the row too. */
  const pageRow: number[] = [];
  /** Command-level refusals, which belong to no row. */
  const batch: string[] = [];
  const hits: ImportHit[] = [];
  let hitTotal = 0;

  for (const [index, row] of rows.entries()) {
    const name = row.name.trim();
    const notes: string[] = [];
    const reasons: string[] = [];
    const flags: ('private' | 'injection')[] = [];
    if (row.private === true) flags.push('private');
    const refuse = (reason: string, extra: Partial<CodexImportRowPlan> = {}): void => {
      reasons.push(reason);
      plans.push({ index, name: row.name, outcome: 'refused', reasons, notes, flags, ...extra });
    };
    if (name === '') {
      refuse('the row has no name, and an entry is found by its name');
      continue;
    }

    // The fields, fitted to codex.md §2.
    const type = row.type !== undefined && (CODEX_TYPES as readonly string[]).includes(row.type) ? row.type : 'other';
    if (row.type !== undefined && type !== row.type) notes.push(`type "${row.type}" is not a codex type, so the entry is "other"`);
    const seen = new Set([name.toLowerCase()]);
    let aliases: string[] = [];
    for (const raw of row.aliases ?? []) {
      const alias = raw.trim();
      if (alias === '' || seen.has(alias.toLowerCase())) continue;
      if (codePoints(alias) > CODEX_ALIAS_CHARS_MAX) {
        notes.push(`the alias "${alias}" is over ${CODEX_ALIAS_CHARS_MAX} characters and is left out`);
        continue;
      }
      seen.add(alias.toLowerCase());
      aliases.push(alias);
    }
    if (aliases.length > CODEX_ALIASES_MAX) {
      notes.push(`${aliases.length - CODEX_ALIASES_MAX} aliases over the ${CODEX_ALIASES_MAX} an entry holds are left out: ${aliases.slice(CODEX_ALIASES_MAX).join(', ')}`);
      aliases = aliases.slice(0, CODEX_ALIASES_MAX);
    }
    const keywordSeen = new Set<string>();
    let keywords: string[] = [];
    for (const raw of row.keywords ?? []) {
      let keyword = raw.trim();
      if (keyword === '') continue;
      if (codePoints(keyword) > KEYWORD_CHARS_MAX) {
        keyword = [...keyword].slice(0, KEYWORD_CHARS_MAX).join('');
        notes.push(`the keyword "${raw.trim()}" is cut to ${KEYWORD_CHARS_MAX} characters`);
      }
      if (keywordSeen.has(keyword.toLowerCase())) continue;
      keywordSeen.add(keyword.toLowerCase());
      keywords.push(keyword);
    }
    if (keywords.length > KEYWORDS_MAX) {
      notes.push(`${keywords.length - KEYWORDS_MAX} keywords over the ${KEYWORDS_MAX} an entry holds are left out`);
      keywords = keywords.slice(0, KEYWORDS_MAX);
    }
    const rawDescription = row.description ?? '';
    const fitted = fitDescription(rawDescription);
    if (fitted.cut) notes.push(`the description is cut to ${codePoints(fitted.value)} characters at a paragraph boundary; the full text stays on the page`);

    // Collisions: never a merge. Only the writer's answer moves a colliding row on.
    const collidingTerm = (terms: readonly string[]): string | undefined => {
      for (const term of terms) {
        const key = term.toLowerCase();
        const holder = held.get(key);
        if (holder !== undefined) return `"${term}" is already the codex entry "${holder}"`;
        const sibling = claimed.get(key);
        if (sibling !== undefined) return `"${term}" is already taken by the row "${sibling}" of this import`;
      }
      return undefined;
    };
    const collision = collidingTerm([name, ...aliases]);
    let finalName = name;
    let outcome: CodexImportRowOutcome = 'create';
    if (collision !== undefined) {
      if (row.collision === undefined) {
        refuse(`${collision}; an import never merges, so choose Skip, Rename or Import as page only`, { collision });
        continue;
      }
      if (row.collision === 'skip') {
        plans.push({ index, name: row.name, outcome: 'skip', collision, reasons, notes, flags });
        continue;
      }
      if (row.collision === 'rename') {
        finalName = `${name} (${options.source})`;
        outcome = 'rename';
        const kept = aliases.filter((alias) => collidingTerm([alias]) === undefined && alias.toLowerCase() !== finalName.toLowerCase());
        if (kept.length < aliases.length) notes.push(`aliases that collide are left out: ${aliases.filter((alias) => !kept.includes(alias)).join(', ')}`);
        aliases = kept;
        const still = collidingTerm([finalName]);
        if (still !== undefined) {
          refuse(`renamed to "${finalName}", which collides too: ${still}`, { collision });
          continue;
        }
      } else {
        outcome = 'page-only';
      }
    }

    // The document the entry cites: an existing one, or the row's page (made from its name and description when it has none).
    let body: string;
    let page: CodexImportPage | undefined;
    if (row.attachTo !== undefined && outcome !== 'page-only') {
      const node = nodes.get(row.attachTo);
      if (node === undefined || node.type !== 'document') {
        refuse(`attachTo "${row.attachTo}" is not a document of this project`, collision === undefined ? {} : { collision });
        continue;
      }
      body = state.documents.get(node.id)?.body ?? '';
    } else {
      page = row.page ?? defaultPage(name, rawDescription);
      body = page.body;
    }

    // The scan, over everything this row brings in. A hit changes nothing in the text; it defaults the row to `manual`.
    const scan = scanImport([
      { where: `rows[${index}].name`, text: row.name },
      { where: `rows[${index}].description`, text: rawDescription },
      ...(page === undefined ? [] : [{ where: `rows[${index}].page`, text: page.body }]),
    ]);
    if (scan.total > 0) {
      flags.push('injection');
      hitTotal += scan.total;
      for (const hit of scan.hits) if (hits.length < HITS_MAX) hits.push(hit);
    }

    if (outcome === 'page-only') {
      pages.push(page!);
      pageRow.push(index);
      plans.push({ index, name: row.name, outcome, ...(collision === undefined ? {} : { collision }), reasons, notes, flags });
      continue;
    }

    const unlocatable = nfcProblem(body);
    if (unlocatable !== undefined) {
      refuse(`the text it attaches to ${unlocatable}`, collision === undefined ? {} : { collision });
      continue;
    }
    // Located by the names the source used: a renamed row's page still says "Hamlet", not "Hamlet (Kanka)".
    const probe = { id: 'probe', name, aliases, caseSensitive: row.caseSensitive === true, exclude: [...(row.exclude ?? [])] } as unknown as CodexEntry;
    const passage = locatePassage(body, probe);
    if (passage === undefined) {
      refuse(`its ${page === undefined ? 'document' : 'page'} names "${name}" nowhere, so there is no passage to cite`, collision === undefined ? {} : { collision });
      continue;
    }

    const includePolicy: CodexIncludePolicy = row.includePolicy ?? (flags.length > 0 ? 'manual' : 'detected');
    let target: { attachTo: string } | { page: number };
    if (page === undefined) target = { attachTo: row.attachTo! };
    else {
      pages.push(page);
      pageRow.push(index);
      target = { page: pages.length - 1 };
    }
    entries.push({
      name: finalName,
      ...(aliases.length === 0 ? {} : { aliases }),
      type,
      ...(fitted.value === '' ? {} : { description: fitted.value }),
      includePolicy,
      ...(row.caseSensitive === undefined ? {} : { caseSensitive: row.caseSensitive }),
      ...(row.exclude === undefined || row.exclude.length === 0 ? {} : { exclude: [...row.exclude] }),
      ...(keywords.length === 0 ? {} : { keywords }),
      ...target,
      cite: { from: passage.from, to: passage.to, quote: passage.quote },
    });
    entryRow.push(index);
    for (const term of [finalName, ...aliases]) claimed.set(term.toLowerCase(), finalName);
    plans.push({ index, name: row.name, outcome, finalName, includePolicy, ...(collision === undefined ? {} : { collision }), reasons, notes, flags });
  }

  let params: CodexImportBatchParams | undefined;
  if (!plans.some((plan) => plan.outcome === 'refused') && (entries.length > 0 || pages.length > 0)) {
    const candidate: CodexImportBatchParams = {
      entries,
      ...(pages.length === 0 ? {} : { pages }),
      ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    };
    // The bus's own validate, before the preview offers Import: what it would refuse is listed now, against the row it came from.
    const checked = COMMAND_REGISTRY['codex.importBatch'].descriptor.validate(candidate, state);
    if (checked.ok) params = checked.value;
    else {
      const failures = (checked.error.details?.['failures'] as PerOpFailure[] | undefined) ?? [];
      // A refusal of the whole command (the parent folder, say) belongs to no row: it is the plan's, not the first row's.
      if (failures.length === 0) batch.push(checked.error.message);
      for (const failure of failures) {
        const rowIndex = failureRow(failure.target, entryRow, pageRow);
        const at = rowIndex === undefined ? -1 : plans.findIndex((plan) => plan.index === rowIndex);
        const plan = plans[at];
        // Only a row that put something into the command can be its cause, and so only that row is refused (a skipped row put nothing in).
        if (plan === undefined || plan.outcome === 'skip') batch.push(failure.message);
        else plans[at] = { ...plan, outcome: 'refused', reasons: [...plan.reasons, failure.message] };
      }
    }
  }

  const count = (outcome: CodexImportRowOutcome): number => plans.filter((plan) => plan.outcome === outcome).length;
  return {
    rows: plans,
    refused: plans.filter((plan) => plan.outcome === 'refused').map((plan) => ({ index: plan.index, name: plan.name, reasons: plan.reasons })),
    batch,
    ...(params === undefined ? {} : { params }),
    counts: { create: count('create'), rename: count('rename'), skip: count('skip'), pageOnly: count('page-only'), refused: count('refused'), pages: params?.pages?.length ?? 0 },
    scan: { total: hitTotal, hits },
  };
}
