/**
 * What a server lists beyond tools: resources, resource templates and prompts — [extensibility.md §3.5](../../../docs/architecture/extensibility.md).
 *
 * The client reads these only as a listing. A resource is read when the writer picks it (`mcp.readResource`), and a prompt is
 * never run by anything in this package. The text a server writes about them is attacker-controlled, so it is kept verbatim,
 * and a prompt and a template are pinned under their own kinds (`canonical.ts`): a changed one is reported until it is reviewed.
 * A plain resource is not pinned. Its contents are data, and what it is called is only a label on a picker.
 */

import { canonicalJson, sha256Hex, subjectHash } from './canonical.js';
import type { ToolPin } from './config.js';
import { pinStateOf, type PinState } from './pins.js';
import type { WirePrompt, WireResource, WireResourceTemplate } from './wire.js';

/** The most of each kind that is kept from one server. A listing past it is cut, and the card says so. */
export const CATALOG_LIMIT = 500;

export interface ListedResource {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType?: string;
}

export interface ListedTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType?: string;
  readonly candidateHash: string;
}

export interface ListedPromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface ListedPrompt {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly ListedPromptArgument[];
  readonly candidateHash: string;
}

/** One server's listing of resources, templates and prompts, and why a part of it is missing. */
export interface Catalog {
  readonly resources: readonly ListedResource[];
  readonly templates: readonly ListedTemplate[];
  readonly prompts: readonly ListedPrompt[];
  /** Why the resource and template list is not here: the reason the list failed. Absent when it was listed, or when the server offers none. */
  readonly resourcesUnavailable?: string;
  readonly promptsUnavailable?: string;
  /** True when a list was longer than {@link CATALOG_LIMIT} and was cut. */
  readonly cut: boolean;
  /** Over the listed prompts and templates, so a review approves exactly the list it was shown. Empty when there is none. */
  readonly fingerprint: string;
}

export const EMPTY_CATALOG: Catalog = { resources: [], templates: [], prompts: [], cut: false, fingerprint: '' };

function byName<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))) {
    const key = keyOf(item);
    // A name that would be an own key of a pin map under the wrong name is not kept; the rest of the list is.
    if (seen.has(key) || key === '__proto__') continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}

export function listResources(resources: readonly WireResource[]): ListedResource[] {
  return byName(resources, (resource) => resource.uri).map((resource) => ({
    uri: resource.uri,
    name: resource.title ?? resource.name,
    description: resource.description ?? '',
    ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
  }));
}

export async function listTemplates(templates: readonly WireResourceTemplate[]): Promise<ListedTemplate[]> {
  const listed: ListedTemplate[] = [];
  for (const template of byName(templates, (item) => item.uriTemplate)) {
    listed.push({
      uriTemplate: template.uriTemplate,
      name: template.title ?? template.name,
      description: template.description ?? '',
      ...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
      candidateHash: await subjectHash({
        kind: 'resourceTemplate',
        uriTemplate: template.uriTemplate,
        description: template.description ?? '',
        ...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
      }),
    });
  }
  return listed;
}

export async function listPrompts(prompts: readonly WirePrompt[]): Promise<ListedPrompt[]> {
  const listed: ListedPrompt[] = [];
  for (const prompt of byName(prompts, (item) => item.name)) {
    const args = (prompt.arguments ?? []).map((argument) => ({ name: argument.name, description: argument.description ?? '', required: argument.required === true }));
    listed.push({
      name: prompt.name,
      description: prompt.description ?? '',
      arguments: args,
      candidateHash: await subjectHash({ kind: 'prompt', name: prompt.name, description: prompt.description ?? '', arguments: args }),
    });
  }
  return listed;
}

/** The fingerprint a listing's prompts and templates earn, or `''` when there is nothing to review. */
export async function catalogFingerprint(
  prompts: readonly ListedPrompt[],
  templates: readonly ListedTemplate[],
  removed: { readonly prompts: readonly string[]; readonly templates: readonly string[] },
): Promise<string> {
  if (prompts.length + templates.length + removed.prompts.length + removed.templates.length === 0) return '';
  return sha256Hex(
    canonicalJson({
      prompts: prompts.map((prompt) => [prompt.name, prompt.candidateHash]),
      templates: templates.map((template) => [template.uriTemplate, template.candidateHash]),
      removed: { prompts: [...removed.prompts].sort(), templates: [...removed.templates].sort() },
    }),
  );
}

/** A pin map, whether or not the server has one yet. */
export function pinsOf(pins: Readonly<Record<string, ToolPin>> | undefined): Readonly<Record<string, ToolPin>> {
  return pins ?? {};
}

/** The pins a review keeps for a list: each listed item at its candidate hash, keeping `firstSeen` for one it already knew. */
export function reviewedPins(
  previous: Readonly<Record<string, ToolPin>> | undefined,
  listed: readonly { readonly key: string; readonly hash: string }[],
  reviewedAt: string,
): Record<string, ToolPin> | undefined {
  const next: Record<string, ToolPin> = {};
  for (const item of listed) {
    const prior = previous !== undefined && Object.prototype.hasOwnProperty.call(previous, item.key) ? previous[item.key] : undefined;
    next[item.key] = { hash: item.hash, firstSeen: prior?.firstSeen ?? reviewedAt, lastReviewedAt: reviewedAt };
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export function stateOf(pins: Readonly<Record<string, ToolPin>> | undefined, key: string, hash: string): PinState {
  return pinStateOf(pinsOf(pins), key, hash);
}

/** The pinned names that a listing no longer has. */
export function removedFrom(pins: Readonly<Record<string, ToolPin>> | undefined, listedKeys: readonly string[]): string[] {
  const kept = new Set(listedKeys);
  return Object.keys(pinsOf(pins)).filter((key) => !kept.has(key)).sort();
}
