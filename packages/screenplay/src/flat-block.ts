/**
 * The flattened block shape the renderers take: the exporter's `FlatBlock`
 * ([exporter.md §2](../../../docs/architecture/exporter.md) stage 1), declared here structurally.
 *
 * The exporter depends on this package for its screenplay formats, so importing the type back
 * from `@caotang/exporter` made the two packages a workspace cycle. The exporter's tests assert
 * the two declarations are the same type (`packages/exporter/test/flat-block-parity.test.ts`),
 * so a change on either side fails there rather than drifting.
 */
export type FlatBlock =
  | { readonly kind: 'frontmatter'; readonly fmKind: 'titlepage' | 'copyright' | 'custom'; readonly docId?: string }
  // `synopsis` is the section's `=` line (screenplay.md §2.2): present only when the folder has one, so a section with none
  // has the same block it always had.
  | { readonly kind: 'chapter'; readonly title: string; readonly level: number; readonly number: number; readonly synopsis?: string }
  // `style` is the scene's export style (exporter.md §2), present only when it is not `normal`.
  | { readonly kind: 'scene'; readonly docId: string; readonly body: string; readonly title: string; readonly number: number; readonly style?: string }
  | { readonly kind: 'separator' }
  | { readonly kind: 'backmatter'; readonly bmKind: 'about-author' | 'custom'; readonly docId?: string };
