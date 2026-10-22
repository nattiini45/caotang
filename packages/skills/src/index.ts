/**
 * `@caotang/skills` — Agent Skills folders (agentskills.io) as the project holds them: `.agents/skills/<name>/SKILL.md` and the files
 * beside it ([extensibility.md §10](../../../docs/architecture/extensibility.md)).
 *
 * No DOM and no I/O. The reader, the caps, the review pin and the model's catalog live here; the store holds the files, the bus
 * changes them, and the harness offers them to the model.
 */

export type { Skill, SkillFile, SkillFrontMatter, SkillLoadIssue, SkillName, SkillReview, SkillState } from './types.js';
export {
  SKILL_FILE,
  SKILL_LIMITS,
  SKILL_SCRIPTS_DIR,
  isSkillJunk,
  isSkillName,
  sizeInWords,
  skillFilesProblem,
  skillPathProblem,
  type SkillFileSize,
  type SkillFilesProblem,
} from './limits.js';
export { FrontMatterError, readFrontMatter, type FieldValue, type ReadFrontMatter } from './frontmatter.js';
export { hasScripts, parseSkillFolder, skillIssueText, skillPin, textOfBytes } from './parse.js';
export { SKILL_CATALOG_HEADER, SKILL_CATALOG_TOKENS, isOffered, oneLine, skillCatalog, type SkillCatalog } from './catalog.js';
export { findHidden, isHiddenCode, revealHidden, type HiddenFindings } from './reveal.js';
export { sha256HexOfBytes, sha256HexOfText } from './sha256.js';
