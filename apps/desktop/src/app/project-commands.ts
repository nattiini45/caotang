import { t } from '@lingui/core/macro';
import { BUILTIN_COMMANDS, expandTemplate, parseSlash, type SlashArgument } from '@caotang/harness';
import type { ProjectMacro } from '@caotang/bus';
import { isSkillName, sha256HexOfText } from '@caotang/skills';
import type { ExternalPromptDescriptor } from '@caotang/mcp-client';
import type { SkillRow } from './skills-model.js';

export interface CommandChoice {
  readonly name: string;
  readonly description: string;
  readonly args: readonly SlashArgument[];
  readonly source?: string;
  readonly argumentHint?: string;
}

export type ProjectCommand = CommandChoice & (
  | { readonly kind: 'skill'; readonly row: SkillRow }
  | { readonly kind: 'macro'; readonly macro: ProjectMacro }
  | { readonly kind: 'mcp'; readonly prompt: ExternalPromptDescriptor }
);

const argument = (name: string, required = true): SlashArgument => ({ name, required, kind: 'text', hint: required ? `<${name}>` : `[${name}]` });
const reserved = (name: string): boolean => BUILTIN_COMMANDS.some((command) => command.name === name) || name.startsWith('macro-') || name.startsWith('mcp-');

export function projectCommands(skills: readonly SkillRow[], macros: readonly ProjectMacro[], prompts: readonly ExternalPromptDescriptor[]): ProjectCommand[] {
  return [
    ...skills.filter((row) => row.enabled && row.skill.frontMatter['user-invocable'] !== false && !reserved(row.name)).map((row): ProjectCommand => ({
      kind: 'skill', name: row.name, description: row.description, row,
      source: row.review === 'reviewed' ? t`Project skill` : t`Review this skill first`,
      ...(row.skill.frontMatter['argument-hint'] === undefined ? {} : { argumentHint: row.skill.frontMatter['argument-hint'] }),
      args: row.skill.frontMatter.arguments?.map((name) => argument(name)) ?? (row.skill.frontMatter['argument-hint'] === undefined ? [] : [argument(row.skill.frontMatter['argument-hint'], false)]),
    })),
    ...macros.map((macro): ProjectCommand => ({
      kind: 'macro', name: `macro-${macro.slug}`, description: macro.description, macro, source: t`Project macro`,
      args: Object.entries(macro.params.properties).map(([name, spec]) => argument(name, macro.params.required.includes(name) && !('default' in spec && spec.default !== undefined))),
    })),
    ...prompts.map((prompt): ProjectCommand => ({
      kind: 'mcp', name: `mcp-${prompt.name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').slice(0, 18)}-${sha256HexOfText(`${prompt.serverKey}/${prompt.name}`).slice(0, 10)}`,
      description: prompt.description, prompt, source: prompt.serverName,
      args: prompt.arguments.map((arg) => argument(arg.name, arg.required)),
    })),
  ];
}

export function commandArguments(line: string, args: readonly SlashArgument[], supplied: Readonly<Record<string, string>> = {}): { readonly values: Record<string, string>; readonly missing?: string } {
  const parsed = parseSlash(line);
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const positional = parsed?.positional.filter((_, index) => !parsed.namedPositions.includes(index)) ?? [];
  let at = 0;
  args.forEach((arg) => {
    const parsedValue = parsed?.named[arg.name] ?? positional[at++];
    const value = Object.hasOwn(supplied, arg.name) ? supplied[arg.name] : parsedValue;
    if (value !== undefined) values[arg.name] = value;
  });
  const missing = args.find((arg) => arg.required && !values[arg.name]?.trim())?.name;
  return { values, ...(missing === undefined ? {} : { missing }) };
}

export function expandSkillCommand(command: Extract<ProjectCommand, { kind: 'skill' }>, line: string, placeholders: { readonly SELECTION?: string; readonly DOC?: string }) {
  const parsed = parseSlash(line)!;
  const names = command.row.skill.frontMatter.arguments ?? [];
  const args = commandArguments(line, names.map((name) => argument(name)));
  return expandTemplate(command.row.skill.body, { ...parsed, named: Object.assign(Object.create(null) as Record<string, string>, parsed.named, args.values) }, placeholders, names);
}

export function savedCommandProblem(name: string, existing: readonly string[]): string | undefined {
  if (!isSkillName(name)) return t`Use up to 64 lower-case letters, numbers and hyphens, with no hyphen at either end.`;
  if (reserved(name) || existing.includes(name)) return t`That command name is already used or reserved. Choose another name.`;
  return undefined;
}

export function savedCommandText(name: string, intent: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(intent.trim().replace(/\s+/gu, ' ').slice(0, 200))}\ndisable-model-invocation: true\nuser-invocable: true\n---\n${intent}\n`;
}
