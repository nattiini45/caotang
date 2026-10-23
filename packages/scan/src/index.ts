/**
 * `@caotang/scan` — the deterministic continuity checks over a project folder, for a writer's own CI (coherence.md §10).
 *
 * A library: no command, no argument parsing and no process code. It reads a folder through `ArtifactFs`, calls no model and reads no
 * key, and writes nothing unless asked. It imports the exporter's `coherence-report` subpath only, never the exporter itself, so it
 * pulls in no font and no document writer.
 */

export { bodyStartOf, placeFinding, type PlacedLines } from './place.js';
export { DEFAULT_FAIL_ON, FAIL_ON_VALUES, SCAN_EXIT, exitCodeFor, isFailOn, severityRank, type FailOn, type ScanExitCode } from './exit.js';
export {
  GITHUB_MESSAGE_LIMIT,
  SCAN_FORMATS,
  capText,
  escapeData,
  escapeProperty,
  formatGithub,
  formatJson,
  formatMarkdown,
  formatScan,
  formatText,
  githubCommand,
  isScanFormat,
  type ScanFormat,
} from './format.js';
export { isContainedPath, runScan, type PlacedFinding, type ScanDeps, type ScanOptions, type ScanResult } from './scan.js';
export { coherenceStateOf, reportInputOf } from './state.js';
