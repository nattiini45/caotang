/**
 * The agent's files: the descriptors of the three commands that change `CAOTANG.md` and the `memory/` folder (context-assembly.md §2, layer
 * LI; project-format.md §1). Their applies are the store's (`packages/store/src/commands-agent-files.ts`).
 *
 * **`project.setInstructions` and `memory.write` are `write-confirm` for an agent.** Both change every later prompt, which is exactly what
 * a prompt-injected tool result would want to do, so an agent writes one only inside an approved plan or a one-step confirm card. They are
 * not relaxed to `write-auto` here; a later setting may relax `memory.write` for turns that called no external tool.
 *
 * **`memory.forget` is `never` and hard-denied (class `deletion`).** A note the writer can read in the panel is the writer's to remove,
 * like a node or a codex entry. The agent may propose a removal in its report.
 *
 * Validation is pure and total (command-bus §2): it checks the key set, the shape, the caps and the refusals that need the project, all
 * against the snapshot.
 */

import type { CommandDescriptor, MemoryForgetParams, MemoryWriteParams, ProjectSetInstructionsParams } from './command.js';
import {
  INSTRUCTIONS_MAX_CHARS,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_MAX_FILES,
  MEMORY_SLUG_MAX_CHARS,
  MEMORY_TITLE_MAX_CHARS,
  MEMORY_TYPES,
  isMemorySlug,
  textDigest,
  type MemoryType,
} from './agent-files-rules.js';
import { invalid, limitExceeded, notFound, requireDeclaredParams, requireString, showValue } from './params.js';
import { err, ok } from './result.js';

const SLUG_HINT = `use lowercase letters and digits joined by hyphens, up to ${MEMORY_SLUG_MAX_CHARS} characters, such as style-dialogue`;

function slugOfParams(params: Record<string, unknown>) {
  const slug = params['slug'];
  if (typeof slug !== 'string' || !isMemorySlug(slug)) {
    return invalid(`${showValue(slug)} is not a memory slug`, SLUG_HINT, 'slug');
  }
  return ok(slug);
}

function expectedDigestOf(params: Record<string, unknown>) {
  const value = params['expectedDigest'];
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string' || value === '' || value.length > 64) {
    return invalid('params.expectedDigest must be the digest memory.read or the panel gave, as a string', 'pass the digest you read, or leave it out', 'expectedDigest');
  }
  return ok(value);
}

const staleHint = (what: string): string => `read ${what} again, and send the change against what it says now`;

export const projectSetInstructions: CommandDescriptor<ProjectSetInstructionsParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('project.setInstructions', params);
    if (!p.ok) return p;
    const text = requireString(p.value, 'text');
    if (!text.ok) return text;
    if (text.value.length > INSTRUCTIONS_MAX_CHARS) {
      return limitExceeded(
        `params.text is ${text.value.length} characters, limit ${INSTRUCTIONS_MAX_CHARS}`,
        'CAOTANG.md is the short, always-sent part: keep the rules there and move the rest to the codex or a skill',
        'text',
      );
    }
    const digest = expectedDigestOf(p.value);
    if (!digest.ok) return digest;
    const held = snapshot.agentFiles;
    if (held?.unreadable.includes('CAOTANG.md') === true) {
      return invalid('CAOTANG.md is not UTF-8 text, so it is left as it is and cannot be changed here', 'convert the file to UTF-8 outside Caotang, then open the project again', 'text');
    }
    const current = held?.instructions?.text ?? '';
    if (digest.value !== undefined && digest.value !== textDigest(current)) {
      return err({
        code: 'revision-conflict',
        message: 'CAOTANG.md changed since it was read',
        correctiveHint: staleHint('CAOTANG.md'),
        target: 'expectedDigest',
      });
    }
    if (text.value === current && held?.instructions?.path === 'CAOTANG.md') {
      return invalid('CAOTANG.md already says that', 'nothing to change', 'text');
    }
    return ok({ text: text.value, ...(digest.value === undefined ? {} : { expectedDigest: digest.value }) });
  },
};

export const memoryWrite: CommandDescriptor<MemoryWriteParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('memory.write', params);
    if (!p.ok) return p;
    const slug = slugOfParams(p.value);
    if (!slug.ok) return slug;
    const type = p.value['type'];
    if (typeof type !== 'string' || !(MEMORY_TYPES as readonly string[]).includes(type)) {
      return invalid(`${showValue(type)} is not a memory type`, `type is one of ${MEMORY_TYPES.join(', ')}`, 'type');
    }
    const title = requireString(p.value, 'title');
    if (!title.ok) return title;
    const name = title.value.trim();
    if (name === '') return invalid('params.title must not be blank', 'name the note in a few words', 'title');
    if (name.length > MEMORY_TITLE_MAX_CHARS) {
      return limitExceeded(`params.title is ${name.length} characters, limit ${MEMORY_TITLE_MAX_CHARS}`, 'shorten the title', 'title');
    }
    if (name.includes('\n') || name.includes('\r')) return invalid('params.title must be one line', 'put the detail in the body', 'title');
    const body = requireString(p.value, 'body');
    if (!body.ok) return body;
    if (body.value.trim() === '') return invalid('params.body must not be blank', 'write the note, or forget it from the panel', 'body');
    if (body.value.length > MEMORY_BODY_MAX_CHARS) {
      return limitExceeded(`params.body is ${body.value.length} characters, limit ${MEMORY_BODY_MAX_CHARS}`, 'split it into two notes, or shorten it', 'body');
    }
    const digest = expectedDigestOf(p.value);
    if (!digest.ok) return digest;

    // One home per kind of fact: a story fact belongs to the codex, which has mention detection and include policies.
    const folded = name.toLowerCase();
    const clash = (snapshot.manifest.codex ?? []).find(
      (entry) => entry.name.trim().toLowerCase() === folded || (entry.aliases ?? []).some((alias) => alias.trim().toLowerCase() === folded),
    );
    if (clash !== undefined) {
      return invalid(
        `“${name}” is the name of a codex entry, and a story fact belongs in the codex, not in memory`,
        'use codex.write to add to that entry, or name the note for the habit it records, such as “Dialogue tags”',
        'title',
      );
    }

    const held = snapshot.agentFiles;
    const existing = held?.memory.find((note) => note.slug === slug.value);
    if (held?.declined.has(`memory/${slug.value}.md`) === true) {
      return invalid(
        `memory/${slug.value}.md exists but could not be read, so it is kept as it is`,
        'choose another slug, or fix or forget that note from the Agent instructions panel',
        'slug',
      );
    }
    if (held?.unreadable.includes(`memory/${slug.value}.md`) === true) {
      return invalid(`memory/${slug.value}.md is not UTF-8 text, so it is left as it is`, 'choose another slug', 'slug');
    }
    if (existing === undefined) {
      if (digest.value !== undefined) {
        return notFound(`there is no memory note “${slug.value}” to change`, 'leave expectedDigest out to create a note, or call memory.read for the slugs', 'expectedDigest');
      }
      if ((held?.memory.length ?? 0) + (held?.declined.size ?? 0) >= MEMORY_MAX_FILES) {
        return limitExceeded(`a project keeps at most ${MEMORY_MAX_FILES} memory notes`, 'ask the writer to forget a note they no longer need', 'slug');
      }
    } else if (digest.value !== undefined && digest.value !== textDigest(existing.body)) {
      return err({
        code: 'revision-conflict',
        message: `the note “${slug.value}” changed since it was read`,
        correctiveHint: staleHint('the note with memory.read'),
        target: 'expectedDigest',
      });
    }
    const other = held?.memory.find((note) => note.slug !== slug.value && note.title.trim().toLowerCase() === folded);
    if (other !== undefined) {
      return invalid(`the note “${other.slug}” already has the title “${other.title}”`, `update that note (slug ${other.slug}) instead of adding a second one`, 'title');
    }
    return ok({
      slug: slug.value,
      type: type as MemoryType,
      title: name,
      body: body.value,
      ...(digest.value === undefined ? {} : { expectedDigest: digest.value }),
    });
  },
};

export const memoryForget: CommandDescriptor<MemoryForgetParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('memory.forget', params);
    if (!p.ok) return p;
    const slug = slugOfParams(p.value);
    if (!slug.ok) return slug;
    const held = snapshot.agentFiles;
    const known = held?.memory.some((note) => note.slug === slug.value) === true || held?.declined.has(`memory/${slug.value}.md`) === true;
    if (!known) return notFound(`the project has no memory note “${slug.value}”`, 'the notes are listed in the Agent instructions panel', 'slug');
    return ok({ slug: slug.value });
  },
};

/** The agent-file descriptors by name, for the registry and for a test that reads them as a set. */
export const AGENT_FILE_DESCRIPTORS = {
  'project.setInstructions': projectSetInstructions,
  'memory.write': memoryWrite,
  'memory.forget': memoryForget,
} as const;
