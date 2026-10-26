/**
 * `memory.read` — the writer's instructions and the agent's memory notes (context-assembly.md §2, layer LI). A read, so no command: it
 * reads `ProjectState.agentFiles`, as `codex.read` reads the codex.
 *
 * With no `slug` it lists what the project keeps: whether `CAOTANG.md` is there and its digest, and one row per note (slug, type, title,
 * size and digest). With a `slug` it returns that note whole. The digest is what `memory.write` and `instructions.propose` take as
 * `expectedDigest`, so a change made against a stale read is a conflict and not an overwrite.
 *
 * The layer already sends `CAOTANG.md` and the memory index with every call, so the list is for the digests and for notes the index line
 * does not say enough about.
 */

import { MEMORY_BODY_MAX_CHARS, ok, textDigest, type CommandError, type Result } from '@caotang/bus';

import { failure, notFound } from '../errors.js';
import { capOf } from '../metadata.js';
import { param, type ObjectSpec } from '../schema.js';
import { fitsCap } from '../tokens.js';
import type { CallParams, PreparedCall, PrepareContext } from '../types.js';

export const memoryReadParams: ObjectSpec = param.object(
  'The memory note to read, or nothing to list what the project keeps.',
  {
    slug: param.string('The note’s slug, as the memory index and the list show it. Leave it out to list every note.', { nonBlank: true, maxLength: 64 }),
  },
  [],
);

export function prepareMemoryRead(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const files = context.state.agentFiles;
  const slug = typeof params['slug'] === 'string' ? params['slug'] : undefined;
  const cap = capOf('memory.read');

  if (slug !== undefined) {
    const note = files.memory.find((held) => held.slug === slug);
    if (note === undefined) {
      const declined = files.declined.has(`memory/${slug}.md`);
      return failure(
        notFound(
          declined ? `the note “${slug}” could not be read, so the agent does not see it` : `the project has no memory note “${slug}”`,
          declined ? 'ask the writer to fix or forget it in the Agent instructions panel' : 'call memory.read with no slug to list the notes',
          'slug',
        ),
      ) as Result<PreparedCall, CommandError>;
    }
    const data = {
      slug: note.slug,
      type: note.type,
      title: note.title,
      body: note.body,
      origin: note.origin,
      digest: textDigest(note.body),
    };
    return ok({ commands: [], finish: () => ok({ data, summary: `read the memory note “${note.title}”`, affected: [] }) });
  }

  const instructions = files.instructions;
  const data: Record<string, unknown> = {
    instructions:
      instructions === undefined
        ? { file: null, characters: 0, digest: textDigest('') }
        : { file: instructions.path, characters: instructions.text.length, digest: textDigest(instructions.text) },
    notes: files.memory.map((note) => ({
      slug: note.slug,
      type: note.type,
      title: note.title,
      origin: note.origin,
      characters: note.body.length,
      digest: textDigest(note.body),
    })),
    noteLimit: { bodyCharacters: MEMORY_BODY_MAX_CHARS },
    ...(files.declined.size === 0 ? {} : { unreadable: [...files.declined.keys()].sort() }),
  };
  const notes: string[] = [];
  if (!fitsCap(data, cap)) {
    const rows = data['notes'] as unknown[];
    while (rows.length > 0 && !fitsCap(data, cap)) rows.pop();
    notes.push(`The list is longer than the ${cap}-token cap, so it stops at ${rows.length} notes. Read one by its slug.`);
  }
  return ok({
    commands: [],
    finish: () =>
      ok({
        data,
        summary: `listed ${files.memory.length} memory ${files.memory.length === 1 ? 'note' : 'notes'}`,
        affected: [],
        ...(notes.length === 0 ? {} : { notes }),
      }),
  });
}
