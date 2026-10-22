/**
 * What a skill is, as the rest of the product sees it — [extensibility.md §10](../../../docs/architecture/extensibility.md).
 *
 * A skill is an Agent Skills folder (agentskills.io): `SKILL.md`, which is YAML front matter and Markdown, plus any files beside it.
 * The reader keeps the front matter's original text and never writes it back from the parsed fields, so a skill a program other
 * than Caotang edits keeps its bytes.
 */

/** A skill's name: lower-case letters, digits and hyphens, at most 64 characters, neither starting nor ending with a hyphen ({@link isSkillName}). It is also its folder's name. */
export type SkillName = string & { readonly __brand: 'SkillName' };

/** One file of a skill folder: a path relative to the folder (`SKILL.md`, `references/style.md`) and its bytes. */
export interface SkillFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The front matter fields Caotang reads. Every other key is kept in the file and ignored. */
export interface SkillFrontMatter {
  readonly name: SkillName;
  /** 1 to 1024 characters. */
  readonly description: string;
  readonly license?: string;
  /** At most 500 characters. */
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Space-separated tool names. Shown on the review card and not enforced in this build; it can only ever narrow. */
  readonly 'allowed-tools'?: string;
  /** Claude Code's extensions, which Caotang honours. */
  readonly 'disable-model-invocation'?: boolean;
  readonly 'user-invocable'?: boolean;
  readonly 'argument-hint'?: string;
}

export interface Skill {
  /** The folder's name under `.agents/skills/`. Equal to the front matter's name. */
  readonly folder: string;
  readonly frontMatter: SkillFrontMatter;
  /** The keys the reader does not use, with what it could read of their values. Never written back. */
  readonly unknownFrontMatter: Readonly<Record<string, unknown>>;
  /** The front matter exactly as the file has it, delimiters and line endings included. */
  readonly frontMatterText: string;
  /** What follows the front matter, exactly as the file has it. */
  readonly body: string;
  /** Every file in the folder, `SKILL.md` included, sorted by path. */
  readonly files: readonly SkillFile[];
  /** Whether the folder has anything under `scripts/`. Caotang never runs it. */
  readonly hasScripts: boolean;
  /** SHA-256 over the skill's name, front matter, body and the hash of every file: what a review approves ({@link skillPin}). */
  readonly pin: string;
}

export type SkillLoadIssue =
  | { readonly code: 'missing_skill_md'; readonly folder: string }
  | { readonly code: 'name_mismatch'; readonly folder: string; readonly name: string }
  | { readonly code: 'bad_front_matter'; readonly folder: string; readonly message: string }
  | { readonly code: 'too_long'; readonly folder: string; readonly field: 'description' | 'compatibility'; readonly limit: number };

/** A skill with the writer's two decisions about it. The app supplies both: the toggle and the review. */
export interface SkillState {
  readonly skill: Skill;
  readonly enabled: boolean;
  /** The pin of the skill as the writer last reviewed it equals the skill's pin now. */
  readonly reviewed: boolean;
}

/** The writer's review of one skill: the pin they approved, and when. Kept in app settings, never in the project. */
export interface SkillReview {
  readonly pin: string;
  readonly reviewedAt: string;
}
