/**
 * Kanka's mentions (#293): `[entity:123]` and `[entity:123|Label]` in an entry, an attribute value or a post. They
 * become the target's plain name — a campaign export is read offline, so a link back to Kanka would point at
 * nothing the writer has. A target the export does not carry keeps the label, or is named by its id and counted.
 */

export interface MentionResult {
  text: string;
  /** Mentions whose target the export does not carry. */
  unresolved: number;
  /** The ids this text names, in order, deduplicated: the connections a mention makes. */
  targets: number[];
}

const MENTION = /\[entity:(\d+)(?:\|([^\]]*))?\]/g;

/** Rewrite every entity mention in `text` to a plain name. */
export function rewriteMentions(text: string, names: ReadonlyMap<number, string>): MentionResult {
  let unresolved = 0;
  const targets: number[] = [];
  const rewritten = text.replace(MENTION, (_whole, rawId: string, label: string | undefined) => {
    const id = Number(rawId);
    const name = names.get(id);
    if (name !== undefined) {
      if (!targets.includes(id)) targets.push(id);
      return name;
    }
    unresolved += 1;
    const fallback = (label ?? '').trim();
    return fallback === '' ? `entity ${rawId}` : fallback;
  });
  return { text: rewritten, unresolved, targets };
}
