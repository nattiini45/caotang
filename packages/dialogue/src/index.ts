/**
 * `@caotang/dialogue` — cutscene and game-narrative authoring on Ink, headless
 * ([dialogue-narrative.md](../../../docs/architecture/dialogue-narrative.md), the media track's branching dialogue).
 *
 * What is in here, and what is not:
 *  - the container kinds and their metadata (`kinds.ts`), the Ink parse layer (`ink-parse.ts`),
 *    the inkjs compile gate (`compile.ts`), and the deterministic findings (`validate.ts`);
 *  - line ids, minted by Caotang and kept in the Ink text (`line-ids.ts`), the dialogue table and
 *    its RFC 4180 CSV (`table.ts`), speaker resolution against the codex (`speakers.ts`);
 *  - the `ink-json` export (`export-ink.ts`), the whole-story `.ink` import plan (`import-ink.ts`),
 *    the draft placement and gate (`draft.ts`), and the graph view's pure layout (`layout.ts`);
 *  - the two agent tools in the harness registry's entry shape, with model-facing handlers (`tools.ts`).
 *
 * What is not: the UI (the graph view, the inspector, the table dialog), the store's dialogue node
 * types and the bus commands that write a container's body, the exporter's recipe enum and renderer
 * wiring, the harness registration of these tools and the model call that drafts the Ink (the agent
 * loop stages it), the Twee importer (v0.3 candidate), the XLSX writer (the exporter's, shared with the shot list),
 * and the play mode over inkjs's runtime (v0.3 candidate).
 */

export {
  DIALOGUE_KIND,
  DIALOGUE_NODE_TYPES,
  ENGINE_TARGETS,
  INK_BODY_EXTENSION,
  isBranchingContainer,
  isDialogueNodeType,
  isEngineTarget,
  markBranching,
  readDialogueMeta,
  type DialogueContainerMeta,
  type DialogueNodeType,
  type EngineTarget,
} from './kinds.js';

export {
  END_TARGET,
  DYNAMIC_TARGET,
  FALLTHROUGH_TARGET,
  LINE_ID_PATTERN,
  ROOT_NODE_ID,
  beatIds,
  findNode,
  maskComments,
  nodeAtOffset,
  parseInk,
  physicalLines,
  type ChoiceRecord,
  type DialogueGraph,
  type DialogueLine,
  type DivertRecord,
  type FunctionDecl,
  type GraphNode,
  type GraphNodeKind,
  type MintMode,
  type ParseWarning,
  type ParsedInk,
  type PhysicalLine,
  type VariableDecl,
} from './ink-parse.js';

export { compileInk, type InkCompileResult, type InkMessage } from './compile.js';
export { InkCompilerNotLoaded, inkCompilerLoaded, loadInkCompiler } from './ink-loader.js';

export {
  ensureLineIds,
  lineIdsOf,
  missingLineIds,
  mintLineId,
  stripLineIdTags,
  type EnsureResult,
  type MintOptions,
  type MintedId,
  type UnplaceableLine,
} from './line-ids.js';

export { resolveSpeakerId, resolveSpeakerName, speakersOf, type ContainerSpeaker, type SpeakerResolution } from './speakers.js';

export {
  BRANCH_CHECK_IDS,
  BRANCH_SEVERITY,
  groupKey,
  unreachableNodes,
  validateContainer,
  type BranchCheckId,
  type ContainerStats,
  type DialogueFinding,
  type ValidateOptions,
  type ValidationReport,
} from './validate.js';

export {
  TABLE_COLUMNS,
  YARN_COLUMNS,
  buildRows,
  csvField,
  exportCsv,
  toCsv,
  toJsonRows,
  toYarnCsv,
  type CsvExport,
  type CsvRefusal,
  type DialogueSource,
  type TableOptions,
  type TableRow,
  type YarnCsvOptions,
} from './table.js';

export { INK_JSON_FORMAT, INK_JSON_MIME, exportInkJson, type InkJsonArtifact, type InkJsonRefusal } from './export-ink.js';

export { planInkImport, type ImportedContainer, type InkImportPlan } from './import-ink.js';

export { checkDraft, planDraft, type DraftCheck, type DraftMode, type DraftPlan, type PlanResult } from './draft.js';

export { LAYOUT_COLUMN_WIDTH, LAYOUT_ROW_HEIGHT, layoutGraph, type GraphLayout, type NodePlacement } from './layout.js';

export { binderOrder, dialogueSourcesIn, resolveContainer, type ContainerResolution } from './container.js';

export {
  DIALOGUE_TOOL_ENTRIES,
  DIALOGUE_TOOL_NAMES,
  asDialogueProposal,
  dialogueDraftTool,
  dialogueTableTool,
  isDialogueToolName,
  runDialogueTool,
  type DialogueProposal,
  type DialogueToolContext,
  type DialogueToolEntry,
  type DialogueToolMeta,
  type DialogueToolName,
  type DialogueToolResult,
  type DialogueToolRisk,
} from './tools.js';
