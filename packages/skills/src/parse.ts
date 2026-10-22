/**
 * Reading one skill folder, and its review pin — [extensibility.md §10](../../../docs/architecture/extensibility.md).
 *
 * `parseSkillFolder` turns the files of `.agents/skills/<folder>/` into a {@link Skill}, or into the reasons it is not one. A skill that
 * is not valid is not offered to the model: the reasons are for the writer, who can fix the file.
 */

import { canonicalJson } from '@caotang/ids';

import { FrontMatterError, readFrontMatter, type FieldValue } from './frontmatter.js';
import { SKILL_FILE, SKILL_LIMITS, SKILL_SCRIPTS_DIR, isSkillName } from './limits.js';
import { sha256HexOfBytes, sha256HexOfText } from './sha256.js';
import type { Skill, SkillFile, SkillFrontMatter, SkillLoadIssue } from './types.js';

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'argument-hint',
]);

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of a file, or `undefined` when its bytes are not UTF-8. */
export function textOfBytes(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Whether a folder's files include anything under `scripts/`. */
export function hasScripts(files: readonly SkillFile[]): boolean {
  return files.some((file) => file.path.startsWith(`${SKILL_SCRIPTS_DIR}/`));
}

/**
 * The review pin of a skill: SHA-256 over the canonical JSON of its name, its front matter text, its body and the hash of every file
 * in the folder. A change to any byte of any file is a different pin, so the writer reviews again (extensibility §10, D13).
 */
export function skillPin(parts: { readonly name: string; readonly frontMatterText: string; readonly body: string; readonly files: readonly SkillFile[] }): string {
  const files = [...parts.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({ path: file.path, sha256: sha256HexOfBytes(file.bytes) }));
  return sha256HexOfText(canonicalJson({ name: parts.name, frontMatter: parts.frontMatterText, body: parts.body, files }));
}

const BOOLEANS: Readonly<Record<string, boolean>> = { true: true, True: true, TRUE: true, false: false, False: false, FALSE: false };

class Refusal extends Error {}

function text(field: FieldValue | undefined, key: string): string | undefined {
  if (field === undefined) return undefined;
  if (field.kind !== 'scalar') throw new Refusal(`“${key}” should be text`);
  return field.value;
}

function flag(field: FieldValue | undefined, key: string): boolean | undefined {
  if (field === undefined) return undefined;
  const value = field.kind === 'scalar' && field.style === 'plain' ? BOOLEANS[field.value] : undefined;
  if (value === undefined) throw new Refusal(`“${key}” should be true or false`);
  return value;
}

/** The skill folder's front matter, checked against the spec. Throws {@link Refusal} or a `too_long` issue. */
function frontMatterOf(fields: ReadonlyMap<string, FieldValue>, folder: string): { frontMatter: SkillFrontMatter; issue?: SkillLoadIssue } {
  const name = text(fields.get('name'), 'name');
  if (name === undefined || name === '') throw new Refusal('it has no “name”');
  if (!isSkillName(name)) {
    throw new Refusal(`the name “${name.slice(0, 70)}” should be lower-case letters, digits and hyphens, up to ${SKILL_LIMITS.maxNameChars} characters, with no hyphen at either end`);
  }
  const description = text(fields.get('description'), 'description')?.trim();
  if (description === undefined || description === '') throw new Refusal('it has no “description”, which is what tells the agent when to use it');
  const compatibility = text(fields.get('compatibility'), 'compatibility');
  let issue: SkillLoadIssue | undefined;
  if (description.length > SKILL_LIMITS.maxDescriptionChars) {
    issue = { code: 'too_long', folder, field: 'description', limit: SKILL_LIMITS.maxDescriptionChars };
  } else if (compatibility !== undefined && compatibility.length > SKILL_LIMITS.maxCompatibilityChars) {
    issue = { code: 'too_long', folder, field: 'compatibility', limit: SKILL_LIMITS.maxCompatibilityChars };
  }
  const license = text(fields.get('license'), 'license');
  const hint = text(fields.get('argument-hint'), 'argument-hint');
  const metadataField = fields.get('metadata');
  let metadata: Record<string, string> | undefined;
  if (metadataField !== undefined) {
    if (metadataField.kind === 'map') metadata = { ...metadataField.entries };
    else if (metadataField.kind === 'scalar' && metadataField.value === '') metadata = undefined;
    else throw new Refusal('“metadata” should be a map of text to text');
  }
  const toolsField = fields.get('allowed-tools');
  let tools: string | undefined;
  if (toolsField !== undefined) {
    if (toolsField.kind === 'scalar') tools = toolsField.value;
    else if (toolsField.kind === 'list') tools = toolsField.items.join(' ');
    else throw new Refusal('“allowed-tools” should be a line of tool names');
  }
  const disable = flag(fields.get('disable-model-invocation'), 'disable-model-invocation');
  const invocable = flag(fields.get('user-invocable'), 'user-invocable');
  const frontMatter: SkillFrontMatter = {
    name,
    description,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(tools === undefined ? {} : { 'allowed-tools': tools }),
    ...(disable === undefined ? {} : { 'disable-model-invocation': disable }),
    ...(invocable === undefined ? {} : { 'user-invocable': invocable }),
    ...(hint === undefined ? {} : { 'argument-hint': hint }),
  };
  return { frontMatter, ...(issue === undefined ? {} : { issue }) };
}

function unknownOf(fields: ReadonlyMap<string, FieldValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of fields) {
    if (KNOWN_KEYS.has(key)) continue;
    out[key] = field.kind === 'scalar' ? field.value : field.kind === 'list' ? [...field.items] : field.kind === 'map' ? { ...field.entries } : null;
  }
  return out;
}

/**
 * Reads the skill in `folder` (its directory name) from its files. A skill comes back only when it is valid and its name is its
 * folder's; the issues say why not otherwise. The files are taken as given: the caller has already applied the caps
 * (`skillFilesProblem`).
 */
export function parseSkillFolder(folder: string, files: readonly SkillFile[]): { readonly skill?: Skill; readonly issues: readonly SkillLoadIssue[] } {
  const entry = files.find((file) => file.path === SKILL_FILE);
  if (entry === undefined) return { issues: [{ code: 'missing_skill_md', folder }] };
  const source = textOfBytes(entry.bytes);
  if (source === undefined) return { issues: [{ code: 'bad_front_matter', folder, message: `${SKILL_FILE} is not UTF-8 text` }] };
  let parsed;
  try {
    parsed = readFrontMatter(source);
  } catch (cause) {
    if (cause instanceof FrontMatterError) return { issues: [{ code: 'bad_front_matter', folder, message: cause.message }] };
    throw cause;
  }
  let checked;
  try {
    checked = frontMatterOf(parsed.fields, folder);
  } catch (cause) {
    if (cause instanceof Refusal) return { issues: [{ code: 'bad_front_matter', folder, message: cause.message }] };
    throw cause;
  }
  if (checked.issue !== undefined) return { issues: [checked.issue] };
  const { frontMatter } = checked;
  if (frontMatter.name !== folder) return { issues: [{ code: 'name_mismatch', folder, name: frontMatter.name }] };
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skill: Skill = {
    folder,
    frontMatter,
    unknownFrontMatter: unknownOf(parsed.fields),
    frontMatterText: parsed.text,
    body: parsed.body,
    files: sorted,
    hasScripts: hasScripts(sorted),
    pin: skillPin({ name: frontMatter.name, frontMatterText: parsed.text, body: parsed.body, files: sorted }),
  };
  return { skill, issues: [] };
}

/** A sentence for an issue, in the writer's words. */
export function skillIssueText(issue: SkillLoadIssue): string {
  switch (issue.code) {
    case 'missing_skill_md':
      return `The folder “${issue.folder}” has no ${SKILL_FILE}, so it is not a skill.`;
    case 'name_mismatch':
      return `The skill in the folder “${issue.folder}” is named “${issue.name}”. Its name and its folder must be the same, so it is not offered.`;
    case 'bad_front_matter':
      return `The skill “${issue.folder}” cannot be read: ${issue.message}.`;
    case 'too_long':
      return `The skill “${issue.folder}” has a ${issue.field} longer than ${issue.limit} characters, so it is not offered.`;
  }
}
