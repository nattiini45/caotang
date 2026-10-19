/** Types for tools/third-party-notices.mjs, so TypeScript callers (the desktop's Vite config, the MCP pack tests) can import it. */

/** The workspace packages whose production closure ships, relative to the repository root. */
export const SHIPPED_FILTERS: readonly string[];

/** The notices file name, in the repository and beside each shipped build. */
export const NOTICES_FILE: string;

/** Dual-licensed packages and the license each is used under. */
export const ELECTED_LICENSES: Readonly<Record<string, string>>;

/** Workspace packages that vendor third-party work under its own license, listed like external packages. */
export const VENDORED_WORKSPACE_PACKAGES: readonly string[];

/** Third-party files shipped inside Caotang's own packages, with the license text kept beside each. */
export interface BundledAsset {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly repository: string;
  readonly shippedAs: string;
  readonly licenseFile: string;
}

export const BUNDLED_ASSETS: readonly BundledAsset[];

/** The label a README-sourced notice carries in place of a license file name. */
export const README_NOTICE_NAME: string;

/** README license sections, verbatim, for packages that ship no license file, keyed `name@version`. */
export const README_LICENSE_OVERRIDES: Readonly<Record<string, string>>;

/** One external package in the production tree. */
export interface ExternalPackage {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}

/** A package with what its files say: its declared license, source and license or notice texts. */
export interface PackageNotice {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly repository: string;
  readonly files: readonly { readonly name: string; readonly text: string }[];
}

/** `pnpm list --prod --json` for the given filters, parsed. */
export function listProductionTree(root: string, filters?: readonly string[]): unknown[];

/** Every external package in a production tree, once per name and version. */
export function externalPackages(tree: readonly unknown[]): ExternalPackage[];

/** Reads one package directory's manifest and license files. */
export function describePackage(record: ExternalPackage): PackageNotice;

/** The deterministic notices document for the given packages. */
export function renderNotices(
  packages: readonly PackageNotice[],
  options?: { readonly filters?: readonly string[]; readonly assets?: readonly (BundledAsset & { readonly text: string })[] },
): string;

/** The bundled assets with their license texts; throws when an asset's `shippedAs` file does not exist in `root`. */
export function bundledAssetNotices(root?: string, assets?: readonly BundledAsset[]): (BundledAsset & { readonly text: string })[];

/** The notices document for the shipped packages (or the given filters) in `root`. */
export function generateNotices(options?: { readonly root?: string; readonly filters?: readonly string[] }): string;
