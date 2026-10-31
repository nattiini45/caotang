/**
 * The non-UTF-8 review an open pauses on (the encoding half of the providers plan): the pieces the
 * EncodingDialog and the open's continuation share.
 *
 * `applyEncodingDecisions` is the write half. A file the writer converts is decoded strictly as the
 * encoding picked for it, its original bytes are copied to `.caotang-backup/<path>` — a folder the
 * project format does not name, a sibling of `docs/` and `codex/` — and only when that copy has
 * landed is the file itself replaced with the decoded text. A file the backup cannot be written for
 * is left untouched. A file the writer leaves is not touched at all: the loader's hold on it is the
 * same as before, and nothing here weakens it.
 *
 * `encodingAskerFor` is the "ask the AI" half. It is offered only when the background role resolves
 * to a real (non-mock) profile, it sends a short decoded excerpt and the candidate list and nothing
 * else — never the path, never the file — and its answer picks a preview encoding. It cannot write:
 * the writer's Convert is still the only thing that changes a file.
 */

import { select, t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import {
  decodeStrict,
  detectEncoding,
  encodingName,
  type ArtifactFs,
  type DecodableEncoding,
  type EncodingIssue,
  type ProjectState,
} from '@caotang/store';
import { bodyStemOf, CODEX_DIR, DOCS_DIR } from '@caotang/store';
import { textOf, type ProviderGateway, type TaskRole } from '@caotang/gateway';

import { encodingFromReply, encodingSystemPrompt, encodingUserPrompt } from './model-prompts.js';

export { encodingFromReply } from './model-prompts.js';

/* lingui-set comment="Encoding conversion results. Interpolated values: name is a document title, codex entry name or file path of the writer's project; from and named are text encoding names; why and reason are failure messages; backup is a file path." */
/** The folder a converted file's original bytes are kept in, inside the project. */
export const ENCODING_BACKUP_DIR = '.caotang-backup';

/** Where the original bytes of `path` are kept when it is converted. */
export function encodingBackupPath(path: string): string {
  return `${ENCODING_BACKUP_DIR}/${path}`;
}

/** The writer's answer for one reported file. A path absent from the decisions is left as it is. */
export interface EncodingDecision {
  readonly path: string;
  readonly action: 'leave' | 'convert';
  /** The encoding a `convert` decodes the file with. Absent means the detection's best reading. */
  readonly encoding?: DecodableEncoding;
}

/** What applying the decisions did, per file. */
export interface EncodingConversionResult {
  /** The files converted, each with the encoding its text decoded as. */
  readonly converted: readonly { readonly path: string; readonly encoding: DecodableEncoding }[];
  /** The files a convert was asked for that could not be converted, each with the plain reason. */
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The encoding a convert decodes the file with: the writer's pick when there is one, else the
 * detection's best reading — the issue's own guess, or the scorer's top candidate for a file the
 * guess could not name. `undefined` when nothing names a reading, which fails the file rather than
 * guessing at its bytes.
 */
function encodingForConversion(issue: EncodingIssue, decision: EncodingDecision, bytes: Uint8Array): DecodableEncoding | undefined {
  if (decision.encoding !== undefined) return decision.encoding;
  if (issue.encoding !== 'unknown') return issue.encoding;
  const { best } = detectEncoding(bytes);
  return best === 'unknown' || best === 'utf-8' ? undefined : best;
}

/**
 * Applies the writer's decisions to the project filesystem. Order is the safety: the original bytes
 * are copied to `.caotang-backup` first, and the decoded text replaces the file only after that copy
 * has landed — a backup that fails leaves the file exactly as it was. Each failure is named in plain
 * words and stops nothing else. Decisions for paths the load did not report are ignored.
 */
export async function applyEncodingDecisions(
  fs: ArtifactFs,
  issues: readonly EncodingIssue[],
  decisions: readonly EncodingDecision[],
): Promise<EncodingConversionResult> {
  const byPath = new Map(decisions.map((decision) => [decision.path, decision]));
  const converted: { path: string; encoding: DecodableEncoding }[] = [];
  const failed: { path: string; reason: string }[] = [];
  for (const issue of issues) {
    const decision = byPath.get(issue.path);
    if (decision?.action !== 'convert') continue;
    let bytes: Uint8Array;
    try {
      bytes = await fs.readBytes(issue.path);
    } catch (error) {
      const why = reasonOf(error);
      failed.push({ path: issue.path, reason: t`its file could not be read — ${why}` });
      continue;
    }
    const encoding = encodingForConversion(issue, decision, bytes);
    if (encoding === undefined) {
      failed.push({ path: issue.path, reason: t`Caotang could not tell which encoding to read it with` });
      continue;
    }
    let text: string;
    try {
      text = decodeStrict(bytes, encoding);
    } catch {
      const named = encoding === 'utf-8' ? 'UTF-8' : encodingName(encoding);
      failed.push({ path: issue.path, reason: t`its bytes do not decode as ${named}` });
      continue;
    }
    const backup = encodingBackupPath(issue.path);
    try {
      await fs.ensureDir(ENCODING_BACKUP_DIR);
      await fs.writeBytesAtomic(backup, bytes);
    } catch (error) {
      const why = reasonOf(error);
      failed.push({ path: issue.path, reason: t`its backup copy could not be written — ${why}` });
      continue;
    }
    try {
      await fs.writeAtomic(issue.path, text);
    } catch (error) {
      const why = reasonOf(error);
      failed.push({ path: issue.path, reason: t`its converted text could not be written — ${why}. Its original bytes are kept at ${backup}` });
      continue;
    }
    converted.push({ path: issue.path, encoding });
  }
  return { converted, failed };
}

/**
 * What an open's notices call a converted file: the document by its title, the codex entry by its
 * name — both resolved from the state the project re-read after the conversion — and a file the
 * layout does not name by its path, which is all there is to call it.
 */
function encodingFileOf(path: string, state: ProjectState): { readonly kind: 'document' | 'codex' | 'file'; readonly name: string } {
  const slash = path.indexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const stem = bodyStemOf(name);
  if (dir === DOCS_DIR) {
    const node = state.manifest.tree.find((entry) => entry.id === stem);
    if (node !== undefined && node.title !== '') return { kind: 'document', name: node.title };
  }
  if (dir === CODEX_DIR) {
    const entry = (state.manifest.codex ?? []).find((candidate) => candidate.id === stem);
    if (entry !== undefined && entry.name !== '') return { kind: 'codex', name: entry.name };
  }
  return { kind: 'file', name: path };
}

/**
 * The sentences an open says for what applying the decisions did: each converted file, named as a
 * person knows it, with where its bytes went, and each file that could not be converted with the
 * reason. Files the writer left say nothing extra here — the load's own notices already say they are
 * held.
 */
export function encodingResultLines(result: EncodingConversionResult, state: ProjectState): string[] {
  const lines: string[] = [];
  for (const { path, encoding } of result.converted) {
    const { kind, name: shown } = encodingFileOf(path, state);
    const name = isolate(shown);
    const from = encoding === 'utf-8' ? 'UTF-8' : encodingName(encoding);
    const backup = encodingBackupPath(path);
    lines.push(
      t`The text of ${select(kind, { document: `the document “${name}”`, codex: `the codex entry “${name}”`, other: `the file “${name}”` })} was converted from ${from} and opens with the project. Its original bytes are kept at “${backup}”.`,
    );
  }
  for (const { path, reason } of result.failed) {
    const { kind, name: shown } = encodingFileOf(path, state);
    const name = isolate(shown);
    lines.push(
      t`${select(kind, { document: `The document “${name}”`, codex: `The codex entry “${name}”`, other: `The file “${name}”` })} could not be converted: ${reason}. The file is left as it was.`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * Ask the AI
 * ------------------------------------------------------------------ */

/** How much of a decoded preview an "ask the AI" sends: a head of the text, never the whole file. */
export const ASK_EXCERPT_CHARS = 2000;

/** The narrow piece of the provider service the ask needs: the role's resolution and the gateway it sends through. */
export interface EncodingAskerSource {
  resolveForRole(role: TaskRole): { readonly profile: { readonly id: string; readonly kind: string; readonly name: string }; readonly model: string } | undefined;
  readonly gateway: ProviderGateway;
}

/**
 * The ask the dialog offers for one file: which profile it goes through (named so the consent line
 * can say it), and `ask`, which sends the excerpt and the candidate list and answers with the
 * candidate the reply names — or `undefined` when the reply names none.
 */
export interface EncodingAsker {
  readonly profileName: string;
  ask(input: { readonly excerpt: string; readonly candidates: readonly DecodableEncoding[] }): Promise<DecodableEncoding | undefined>;
}

/**
 * The "ask the AI" helper for the encoding dialog, or `null` when there is no one to ask: the
 * background role resolves no profile, or resolves the demo profile — a mock model cannot tell a
 * Windows-1252 file from a Big5 one, and must never be queried here.
 *
 * What `ask` sends is exactly this: a one-line system prompt, the candidate names, and the excerpt
 * the dialog is already showing the writer — capped at {@link ASK_EXCERPT_CHARS} characters, so a
 * large file still sends a head, never the whole text. The file's path is not sent. The answer picks
 * the encoding the reply names; nothing it answers is ever written.
 */
export function encodingAskerFor(providers: EncodingAskerSource): EncodingAsker | null {
  const resolved = providers.resolveForRole('background');
  if (resolved === undefined || resolved.profile.kind === 'mock') return null;
  const profileName = resolved.profile.name;
  const { gateway } = providers;
  const model = resolved.model;
  const profileId = resolved.profile.id;
  return {
    profileName,
    async ask({ excerpt, candidates }) {
      const reply = await gateway.completeOnce({
        role: 'background',
        profileId,
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: encodingSystemPrompt() },
          { role: 'user', content: encodingUserPrompt(excerpt.slice(0, ASK_EXCERPT_CHARS), candidates) },
        ],
      });
      return encodingFromReply(textOf(reply.content), candidates);
    },
  };
}
