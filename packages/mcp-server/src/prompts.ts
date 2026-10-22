/**
 * The writer's workflows, as MCP prompts — extensibility.md §9.
 *
 * Caotang's own agent drafts a scene, fills a synopsis or checks continuity with the context it assembles from the codex, the
 * structure, the story so far and the focus (context-assembly.md). That context is the one thing only Caotang can build. Each prompt
 * here runs `assemble()` on the same task the in-app tool builds and hands the result to the host, whose own model does the writing.
 * Nothing on this server calls a model, and it holds no key: the manuscript text goes to the host the writer chose, as `doc.read`
 * already sends it.
 *
 * MCP prompt messages are `user` or `assistant`, so the assembled system message is folded into the first user message, under a
 * heading, and one closing instruction says what to do with the result: which write tool stores it, or that it is shown to the writer
 * and not written. The closing instruction depends on whether the server was started with `--allow-writes`.
 *
 * A prompt that names a node the tool would refuse (a folder where a document is wanted) is refused with the tool's words.
 */

import type { CommandError } from '@caotang/bus';
import { assemble, ContextError, type AgentTask, type AssembledPrompt } from '@caotang/context';
import {
  CONTAINER,
  CONTINUITY_MAX_DOCS,
  DOCUMENT,
  codexInOrder,
  continuityTask,
  descendantsOf,
  draftModeRefusal,
  refusalSentence,
  resolveNode,
  sceneTask,
  synopsisInstruction,
} from '@caotang/harness';
import { getBody, type ProjectState, type TreeNode } from '@caotang/store';
import {
  completable,
  ProtocolError,
  ProtocolErrorCode,
  type GetPromptResult,
  type McpServer,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';

import type { ToolRuntime } from './tools.js';

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CommandError };

const done = <T>(value: T): Result<T> => ({ ok: true, value });
const refused = (message: string, correctiveHint: string, target: string): Result<never> => ({
  ok: false,
  error: { code: 'invalid-params', message, correctiveHint, target },
});

export interface PromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  /** What a host may complete the argument from: the documents, or the folders. */
  readonly complete?: 'doc' | 'container';
}

export interface CaotangPromptDef {
  readonly name: 'draft-scene' | 'fill-synopsis' | 'continuity-check' | 'codex-from-doc' | 'revise-with-codex';
  readonly title: string;
  readonly description: string;
  readonly arguments: readonly PromptArgument[];
  /** Builds the in-app task. A refusal (an unknown id, a wrong node kind) has the words of the tool that would give it. */
  readonly task: (args: Readonly<Record<string, string>>, state: ProjectState) => Result<AgentTask>;
  /** The closing instruction, which depends on whether the server may write. */
  readonly handBack: (allowWrites: boolean) => string;
}

const DOC_ARG: PromptArgument = { name: 'doc', description: 'The document: its id, or a title.', required: true, complete: 'doc' };
const INSTRUCTION_ARG = (what: string): PromptArgument => ({ name: 'instruction', description: what, required: true });

const READ_ONLY = 'This server is read-only, so do not try to store it.';

/** The document a prompt is about, or the refusal `doc.read` gives for it. */
function documentOf(state: ProjectState, ref: string | undefined): Result<TreeNode> {
  const node = resolveNode(state, ref ?? '', DOCUMENT, 'document', 'params.doc');
  return node.ok ? done(node.value) : { ok: false, error: node.error };
}

/** The whole text of a document as the selection of a rewrite, which is how the in-app tool is asked to revise a scene. */
function wholeBody(state: ProjectState, node: TreeNode): Result<{ from: number; to: number; exact: string }> {
  const body = getBody(state, node.id);
  if (body.trim() === '') {
    return refused(`"${node.title}" has no text to rewrite`, 'draft it first, with draft-scene', 'params.doc');
  }
  return done({ from: 0, to: body.length, exact: body });
}

const DRAFT_MODES = ['draft', 'continue', 'rewrite_selection'] as const;
type DraftMode = (typeof DRAFT_MODES)[number];

function sceneTaskOf(args: Readonly<Record<string, string>>, state: ProjectState): Result<AgentTask> {
  const node = documentOf(state, args['doc']);
  if (!node.ok) return node;
  const mode = args['mode'] ?? 'draft';
  if (!(DRAFT_MODES as readonly string[]).includes(mode)) {
    return refused(`mode "${mode}" is not one of ${DRAFT_MODES.join(', ')}`, 'pass draft, continue or rewrite_selection', 'params.mode');
  }
  const refusal = draftModeRefusal(mode, getBody(state, node.value.id));
  if (refusal !== undefined) return { ok: false, error: refusal };
  const selection = mode === 'rewrite_selection' ? wholeBody(state, node.value) : undefined;
  if (selection !== undefined && !selection.ok) return selection;
  return done(
    sceneTask(node.value.title, node.value.id, mode as DraftMode, args['instruction'] ?? '', selection?.value, undefined, false),
  );
}

/** The documents a continuity check covers: those under a part or folder, or the whole manuscript when none is named. */
function continuityScope(state: ProjectState, ref: string | undefined): Result<readonly string[]> {
  if (ref === undefined || ref.trim() === '') {
    return done(descendantsOf(state, 'manuscript').filter(DOCUMENT).map((node) => node.id));
  }
  const node = resolveNode(state, ref, (candidate) => CONTAINER(candidate) || DOCUMENT(candidate), 'part or folder', 'params.scope');
  if (!node.ok) return { ok: false, error: node.error };
  return done(DOCUMENT(node.value) ? [node.value.id] : descendantsOf(state, node.value.id).filter(DOCUMENT).map((child) => child.id));
}

function continuityTaskOf(args: Readonly<Record<string, string>>, state: ProjectState): Result<AgentTask> {
  const scope = continuityScope(state, args['scope']);
  if (!scope.ok) return scope;
  if (scope.value.length === 0) {
    return refused('there are no documents to check in that scope', 'name a part or folder that holds documents, or leave scope out to check the manuscript', 'params.scope');
  }
  if (scope.value.length > CONTINUITY_MAX_DOCS) {
    return refused(
      `continuity-check covers at most ${CONTINUITY_MAX_DOCS} documents per prompt, and this scope holds ${scope.value.length}`,
      'name a smaller part or folder as scope, and run the check once for each',
      'params.scope',
    );
  }
  return done(continuityTask(scope.value, []));
}

/** The brief of codex-from-doc: what to extract, and the codex as it stands, so the host does not propose what is already there. */
function codexBrief(node: TreeNode, state: ProjectState): string {
  const held = codexInOrder(state).map((entry) => `${entry.name} (${entry.type})`);
  const codex = held.length === 0 ? 'The codex is empty.' : `The codex already holds: ${held.join(', ')}.`;
  return (
    `Document "${node.title}":\nBrief: list the characters, places, objects, lore and subplots this document introduces or develops ` +
    'that the codex does not hold yet. For each, give a name, a type (character, location, object, lore, subplot or other), ' +
    `any aliases, and a description of at most 2000 characters drawn from the document alone.\n${codex}`
  );
}

export const PROMPTS: readonly CaotangPromptDef[] = [
  {
    name: 'draft-scene',
    title: 'Draft a scene',
    description: 'Draft, continue or rewrite a scene with the codex, the structure and the story so far Caotang gathers for it.',
    arguments: [
      DOC_ARG,
      INSTRUCTION_ARG('The brief for the scene.'),
      { name: 'mode', description: 'draft (an empty document), continue (write on from the end), or rewrite_selection (rewrite the whole text). Default draft.', required: false },
    ],
    task: sceneTaskOf,
    handBack: (writes) =>
      writes
        ? 'Show the draft to the writer; do not write it into the project on your own. If they want to keep it, offer to store it as a new document in the same chapter with doc.import, which asks them to confirm. The existing text stays as it is.'
        : `Show the draft to the writer. ${READ_ONLY} The writer can paste it into Caotang.`,
  },
  {
    name: 'fill-synopsis',
    title: 'Write a synopsis',
    description: 'Write the synopsis of a document from its text and notes.',
    arguments: [DOC_ARG],
    task: (args, state) => {
      const node = documentOf(state, args['doc']);
      return node.ok ? done({ tool: 'synopsis.fill', instruction: synopsisInstruction(node.value, 'both'), focus: node.value.id }) : node;
    },
    handBack: (writes) =>
      writes
        ? 'Show the synopsis to the writer. If they accept it, store it with synopsis.set.'
        : `Show the synopsis to the writer. ${READ_ONLY}`,
  },
  {
    name: 'continuity-check',
    title: 'Check continuity',
    description: 'Check a part, a folder or the whole manuscript for continuity problems, with the codex and the story so far.',
    arguments: [{ name: 'scope', description: 'A part or folder id, or a title. Left out, the whole manuscript.', required: false, complete: 'container' }],
    task: continuityTaskOf,
    handBack: () => 'Report each problem to the writer with the document it is in and the passage, and say what would fix it. Do not change the project.',
  },
  {
    name: 'codex-from-doc',
    title: 'Find codex entries in a document',
    description: 'List the codex entries a document introduces that the codex does not hold yet.',
    arguments: [DOC_ARG],
    task: (args, state) => {
      const node = documentOf(state, args['doc']);
      return node.ok
        ? done({ tool: 'synopsis.fill', instruction: codexBrief(node.value, state), params: { for: 'codex-from-doc' }, focus: node.value.id })
        : node;
    },
    handBack: (writes) =>
      writes
        ? 'Show the proposed entries to the writer. For the ones they accept, create them with codex.write, which asks them to confirm.'
        : `Show the proposed entries to the writer. ${READ_ONLY} The writer can add them in Caotang.`,
  },
  {
    name: 'revise-with-codex',
    title: 'Revise a scene against the codex',
    description: 'Rewrite a whole scene to a brief, with the codex entries it mentions in front of the model.',
    arguments: [DOC_ARG, INSTRUCTION_ARG('What to change.')],
    task: (args, state) => sceneTaskOf({ ...args, mode: 'rewrite_selection' }, state),
    handBack: (writes) =>
      writes
        ? 'Show the revision to the writer; do not replace the document’s text with it on your own. If they want to keep it, offer to store it as a new document in the same chapter with doc.import, which asks them to confirm.'
        : `Show the revision to the writer. ${READ_ONLY}`,
  },
];

/**
 * The messages of a prompt. MCP has no system role, so the assembled system message opens the first user message under a heading, and the
 * assembled user message follows it unchanged. The closing instruction is the last paragraph.
 */
export function toPromptMessages(
  prompt: AssembledPrompt,
  handBack: string,
): readonly { readonly role: 'user' | 'assistant'; readonly content: { readonly type: 'text'; readonly text: string } }[] {
  const system = prompt.messages.filter((message) => message.role === 'system').map((message) => message.content);
  const rest = prompt.messages.filter((message) => message.role !== 'system').map((message) => message.content);
  const text = [...(system.length === 0 ? [] : ['# Caotang context', ...system]), ...rest, handBack].join('\n\n');
  return [{ role: 'user', content: { type: 'text', text } }];
}

/** The assembled prompt for a task over the state, as Caotang's own agent would send it (no tools, no earlier turns). */
export function assembleFor(task: AgentTask, state: ProjectState): AssembledPrompt {
  return assemble(task, { state }, {});
}

const COMPLETION_LIMIT = 100;

function completionsFor(kind: 'doc' | 'container', state: ProjectState, typed: string): string[] {
  const needle = typed.trim().toLowerCase();
  const wanted = kind === 'doc' ? DOCUMENT : (node: TreeNode): boolean => node.type === 'folder';
  return state.manifest.tree
    .filter((node) => wanted(node) && (needle === '' || node.title.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle)))
    .slice(0, COMPLETION_LIMIT)
    .map((node) => node.id);
}

/** One argument's schema, which the SDK reads for its completer. A fresh object each time, because completion is marked on the object itself. */
function stringField(): StandardSchemaV1<unknown, unknown> {
  return { '~standard': { version: 1, vendor: 'caotang', validate: (value: unknown) => ({ value }) } };
}

type ArgsSchema = StandardSchemaWithJSON<Record<string, string>, Record<string, string>> & { readonly shape: Record<string, object> };

/**
 * The arguments a prompt advertises. Like the tools' schemas, only the shape is advertised here: the prompt's own task builder checks
 * the values and refuses in the tool's words. `shape` is where the SDK looks for an argument's completer.
 */
function argsSchemaOf(def: CaotangPromptDef, runtime: ToolRuntime): ArgsSchema {
  const json = {
    type: 'object',
    properties: Object.fromEntries(def.arguments.map((arg) => [arg.name, { type: 'string', description: arg.description }])),
    required: def.arguments.filter((arg) => arg.required).map((arg) => arg.name),
  };
  const shape = Object.fromEntries(
    def.arguments.map((arg) => {
      const kind = arg.complete;
      const field = stringField();
      return [arg.name, kind === undefined ? field : completable(field, (typed: unknown) => completionsFor(kind, runtime.session.state, String(typed)))];
    }),
  );
  return {
    '~standard': {
      version: 1,
      vendor: 'caotang',
      validate: (value: unknown) => ({ value: (value ?? {}) as Record<string, string> }),
      jsonSchema: { input: () => json, output: () => json },
    },
    shape,
  };
}

/** The refusal of a prompt, as the error a prompt request answers with. */
function refusalError(error: CommandError): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, refusalSentence(error.message, error.correctiveHint));
}

/** Registers the five prompts on `server`. Returns their names, in the order listed. */
export function registerCaotangPrompts(server: McpServer, runtime: ToolRuntime): readonly string[] {
  for (const def of PROMPTS) {
    server.registerPrompt(
      def.name,
      { title: def.title, description: def.description, argsSchema: argsSchemaOf(def, runtime) },
      (args: Record<string, string>): GetPromptResult => {
        const { state } = runtime.session;
        for (const arg of def.arguments) {
          if (arg.required && (args[arg.name] ?? '').trim() === '') {
            throw refusalError({
              code: 'invalid-params',
              message: `${arg.name} must not be blank`,
              correctiveHint: `pass ${arg.description.charAt(0).toLowerCase()}${arg.description.slice(1)}`,
              target: `params.${arg.name}`,
            });
          }
        }
        const task = def.task(args, state);
        if (!task.ok) throw refusalError(task.error);
        let prompt: AssembledPrompt;
        try {
          prompt = assembleFor(task.value, state);
        } catch (error) {
          if (error instanceof ContextError) throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
          throw error;
        }
        return { description: def.description, messages: [...toPromptMessages(prompt, def.handBack(runtime.session.allowWrites))] };
      },
    );
  }
  return PROMPTS.map((def) => def.name);
}
