/**
 * The codex engine, headless — codex.md §4–§7.
 *
 * Nothing in here touches the editor, the store's runtime or the network. The entry
 * shape is `CodexEntry` from `@caotang/store`, imported and not redefined.
 */

export {
  atWordBoundary,
  canonical,
  caseFold,
  estimateTokens,
  isLatinTerm,
  isWordCodePoint,
  tokensForChars,
} from './text.js';

export { CODEX_TYPE_ORDER, compareCodex, sortCodex } from './order.js';

export {
  compileCodex,
  countMentions,
  detect,
  detectCompiled,
  firstMentionOffsets,
  scanMentions,
  type CompiledCodex,
  type DetectionDoc,
  type DetectionHit,
  type DetectionResult,
  type DocumentTerm,
  type Phrase,
  type Term,
} from './detect.js';

export { cueTermsOf, entryForCue } from './cues.js';

export {
  createMentionIndex,
  type IndexedDoc,
  type MentionIndex,
  type MentionIndexStats,
} from './mention-index.js';

export {
  expandAttachments,
  focusScope,
  selectCandidates,
  type Candidate,
  type CandidateInput,
  type CandidateReason,
  type CandidateSet,
  type SuppressionReason,
  type Suppressed,
} from './candidates.js';

export {
  CODEX_READ_DEFAULT_LIMIT,
  CODEX_READ_MAX_LIMIT,
  CODEX_READ_PREVIEW,
  CODEX_READ_TOKEN_CAP,
  CODEX_READ_WINDOW,
  codexRead,
  type CodexEntryLinks,
  type CodexMatchField,
  type CodexReadItem,
  type CodexReadQuery,
  type CodexReadReference,
  type CodexReadRelation,
  type CodexReadResult,
  type CodexReadSource,
} from './read.js';
