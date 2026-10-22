/**
 * The registry: one entry per tool, each joining its metadata row (metadata.ts),
 * its params declaration (and so its schema), and its behaviour.
 *
 * **The join is checked in both directions.** Every metadata row must have a
 * definition here, and every definition must have a metadata row. `buildEntries`
 * throws on either gap, so the table cannot drift from the spec's table without
 * the first test run failing.
 */

import { COHERENCE_TOOL_ENTRIES, type CoherenceToolName } from '@caotang/coherence';
import { DIALOGUE_TOOL_ENTRIES } from '@caotang/dialogue';
import { TOOL_SEARCH_ENTRY } from '@caotang/mcp-client';
import { STORYBOARD_TOOL_ENTRIES } from '@caotang/storyboard';
import { PROMPT_PACK_TOOL_ENTRIES } from '@caotang/video-prompt-pack';

import { invalidParams } from '../errors.js';
import { metadataFor, TOOL_METADATA, type ToolMetadata, type ToolName } from '../metadata.js';
import { toJsonSchema, type ObjectSpec } from '../schema.js';
import type { NativeEntry, PortEntry, PortToolName, PrepareFn, ProtocolEntry, ToolEntry } from '../types.js';
import { planParams } from '../plan.js';
import { prepareCodexImport, codexImportParams } from './codex-import.js';
import { prepareCodexWrite, codexWriteParams } from './codex-write.js';
import { exportCompileParams, prepareExportCompile } from './export-compile.js';
import { docImportParams, prepareDocImport } from './doc-import.js';
import { PRIMITIVE_TOOLS } from './primitive-tools.js';
import { PRIMITIVE_TOOL_NAMES, type PrimitiveToolName } from './primitive.js';
import { prepareRestructure, restructureParams } from './restructure.js';
import {
  docReadParams,
  notesReadParams,
  prepareDocRead,
  prepareNotesRead,
  prepareProjectOverview,
  prepareReadTree,
  projectOverviewParams,
  readTreeParams,
  refineDocRead,
} from './reads.js';
import { notesAppendParams, prepareNotesAppend, metaSetParams, prepareMetaSet, refineMetaSet } from './writes.js';
import {
  codexReadParams,
  continuityScanParams,
  refineSceneDraft,
  sceneDraftParams,
  synopsisFillParams,
} from './ports.js';
import { skillLoadParams } from './skills.js';
import type { CallParams } from '../types.js';
import type { CommandError } from '@caotang/bus';

type Refine = (params: CallParams) => CommandError | undefined;

type Definition =
  | { readonly kind: 'native'; readonly params: ObjectSpec; readonly prepare: PrepareFn; readonly refine?: Refine }
  | { readonly kind: 'port'; readonly port: PortToolName; readonly params: ObjectSpec; readonly refine?: Refine }
  | { readonly kind: 'protocol'; readonly params: ObjectSpec };

const DEFINITIONS: Readonly<Record<ToolName, Definition>> = {
  'project.overview': { kind: 'native', params: projectOverviewParams, prepare: prepareProjectOverview },
  'binder.read_tree': { kind: 'native', params: readTreeParams, prepare: prepareReadTree },
  'doc.read': { kind: 'native', params: docReadParams, prepare: prepareDocRead, refine: refineDocRead },
  'notes.read': { kind: 'native', params: notesReadParams, prepare: prepareNotesRead },
  'meta.set': { kind: 'native', params: metaSetParams, prepare: prepareMetaSet, refine: refineMetaSet },
  'notes.append': { kind: 'native', params: notesAppendParams, prepare: prepareNotesAppend },
  'synopsis.fill': { kind: 'port', port: 'synopsis.fill', params: synopsisFillParams },
  'scene.draft': { kind: 'port', port: 'scene.draft', params: sceneDraftParams, refine: refineSceneDraft },
  'binder.restructure': { kind: 'native', params: restructureParams, prepare: prepareRestructure },
  'continuity.scan': { kind: 'port', port: 'continuity.scan', params: continuityScanParams },
  'export.compile': { kind: 'native', params: exportCompileParams, prepare: prepareExportCompile },
  'codex.read': { kind: 'port', port: 'codex.read', params: codexReadParams },
  'codex.write': { kind: 'native', params: codexWriteParams, prepare: prepareCodexWrite },
  'agent.plan': { kind: 'protocol', params: planParams },
  'doc.import': { kind: 'native', params: docImportParams, prepare: prepareDocImport },
  'codex.import': { kind: 'native', params: codexImportParams, prepare: prepareCodexImport },
  'coherence.scan': coherenceDefinition('coherence.scan'),
  'coherence.review': coherenceDefinition('coherence.review'),
  'coherence.setFindingStatus': coherenceDefinition('coherence.setFindingStatus'),
  // The Tier-2 gateway, read from the MCP client's entry (extensibility §5).
  'tool.search': { kind: 'port', port: 'tool.search', params: TOOL_SEARCH_ENTRY.params as unknown as ObjectSpec },
  // The storyboard and prompt-pack modules' tools, read from each module's own entries.
  'shots.derive': extensionDefinition(STORYBOARD_TOOL_ENTRIES, 'shots.derive'),
  'shots.annotate': extensionDefinition(STORYBOARD_TOOL_ENTRIES, 'shots.annotate'),
  'prompt.draft': extensionDefinition(PROMPT_PACK_TOOL_ENTRIES, 'prompt.draft'),
  'prompt.variant': extensionDefinition(PROMPT_PACK_TOOL_ENTRIES, 'prompt.variant'),
  // The dialogue module's two tools (dialogue-narrative.md §7), read from the module's own entries.
  'dialogue.draft': extensionDefinition(DIALOGUE_TOOL_ENTRIES, 'dialogue.draft'),
  'dialogue.table': extensionDefinition(DIALOGUE_TOOL_ENTRIES, 'dialogue.table'),
  // The project's skills (extensibility.md §10).
  'skill.load': { kind: 'port', port: 'skill.load', params: skillLoadParams },
  // The allowlisted bus primitives, each built from its command's descriptor (tools/primitive.ts).
  ...Object.fromEntries(PRIMITIVE_TOOL_NAMES.map((name) => [name, primitiveDefinition(name)])) as Record<PrimitiveToolName, Definition>,
};

/** An allowlisted primitive's definition: native, its prepare is the factory's, and its params are the spec's. */
function primitiveDefinition(name: PrimitiveToolName): Definition {
  const tool = PRIMITIVE_TOOLS.find((candidate) => candidate.meta.name === name);
  if (tool === undefined) throw new Error(`no primitive tool for "${name}"`);
  return { kind: 'native', params: tool.params, prepare: tool.prepare };
}

/** The fields of a module's registry entry that the registry reads. Each module declares its own, in the harness entry shape. */
interface ExtensionEntry {
  readonly meta: { readonly name: string };
  readonly params: unknown;
  readonly port: PortToolName;
  /** Some modules return a message string and some a bus error. Both are a refusal. */
  readonly refine?: (params: CallParams) => unknown;
}

/**
 * A module's tool, as a registry definition. Its params and its refusal rule are the module's, written once, and
 * its port is the name the injected port map is keyed by. A refusal that is only a string becomes `invalid-params`.
 */
function extensionDefinition(entries: readonly ExtensionEntry[], name: ToolName): Definition {
  const entry = entries.find((candidate) => candidate.meta.name === name);
  if (entry === undefined) throw new Error(`no module entry for tool "${name}"`);
  const refine = entry.refine;
  const refineHarness: Refine | undefined =
    refine === undefined
      ? undefined
      : (params) => {
          const refused = refine(params);
          if (refused === undefined) return undefined;
          return typeof refused === 'string' ? invalidParams(refused, undefined, name) : (refused as CommandError);
        };
  return {
    kind: 'port',
    port: entry.port,
    params: entry.params as ObjectSpec,
    ...(refineHarness === undefined ? {} : { refine: refineHarness }),
  };
}

/**
 * A coherence tool's definition, read from the coherence package's own entry (coherence.md §7), so the
 * params and the refusal rule are written once. Its port is the name the harness's port map is keyed by.
 */
function coherenceDefinition(name: CoherenceToolName): Definition {
  const entry = COHERENCE_TOOL_ENTRIES.find((candidate) => candidate.meta.name === name);
  if (entry === undefined) throw new Error(`no coherence tool entry for "${name}"`);
  // The coherence package's ParamSpec is the harness's, by design (its header says so), and the
  // registry derives the JSON Schema from it with `toJsonSchema`, which would refuse a wrong shape.
  const params = entry.params as unknown as ObjectSpec;
  const refine = entry.refine;
  const refineHarness: Refine | undefined =
    refine === undefined
      ? undefined
      : (params) => {
          const message = refine(params);
          return message === undefined ? undefined : invalidParams(message, undefined, name);
        };
  return {
    kind: 'port',
    port: entry.port,
    params,
    ...(refineHarness === undefined ? {} : { refine: refineHarness }),
  };
}

function requireMetadata(name: ToolName): ToolMetadata {
  const meta = metadataFor(name);
  if (meta === undefined) throw new Error(`tool "${name}" has a definition but no metadata row`);
  return meta;
}

/** Joins every definition to its metadata row and derives its schema. Throws on any gap, in either direction. */
export function buildEntries(): ReadonlyMap<ToolName, ToolEntry> {
  const entries = new Map<ToolName, ToolEntry>();
  for (const meta of TOOL_METADATA) {
    if (!(meta.name in DEFINITIONS)) throw new Error(`tool "${meta.name}" has a metadata row but no definition`);
  }
  for (const name of Object.keys(DEFINITIONS) as ToolName[]) {
    const definition = DEFINITIONS[name];
    const meta = requireMetadata(name);
    const base = { meta, params: definition.params, schema: toJsonSchema(definition.params) };
    if (definition.kind === 'native') {
      const entry: NativeEntry = {
        ...base,
        kind: 'native',
        prepare: definition.prepare,
        ...(definition.refine === undefined ? {} : { refine: definition.refine }),
      };
      entries.set(name, entry);
    } else if (definition.kind === 'port') {
      const entry: PortEntry = {
        ...base,
        kind: 'port',
        port: definition.port,
        ...(definition.refine === undefined ? {} : { refine: definition.refine }),
      };
      entries.set(name, entry);
    } else {
      const entry: ProtocolEntry = { ...base, kind: 'protocol' };
      entries.set(name, entry);
    }
  }
  return entries;
}
