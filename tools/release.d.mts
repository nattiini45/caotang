/** Types for tools/release.mjs, so the repository tests can import it. */

/** The versions a release tag has to agree with. */
export interface ReleaseVersions {
  readonly packageVersion: string;
  readonly manifestVersion: string;
  readonly serverVersion: string;
}

/** The ways a tag disagrees with the versions the release would ship; empty when it is fit to release. */
export function tagProblems(tag: string, versions: ReleaseVersions): string[];

/** The body of the `## <version>` section of a changelog, or undefined when it has none. */
export function changelogSection(changelog: string, version: string): string | undefined;
