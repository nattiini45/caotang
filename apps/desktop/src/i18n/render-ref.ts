/**
 * Rendering a package's `MessageRef` ([i18n.md §3.2](docs/architecture/i18n.md), I7).
 *
 * A package keeps its English string and adds `{ id, values, message }`. This module is the one
 * place the app turns that ref into text:
 *
 * 1. **The active catalogue has the id** — `i18n._(id, values)` renders it, translated or (for a
 *    message with no translation) through the merged English catalogue.
 * 2. **The id is unknown** (an older or newer package, a row saved before extraction) — the ref's
 *    own `message` is compiled as ICU with its values. A writer sees an English sentence, never a
 *    raw `{title}` template.
 *
 * Values that name writer content are isolated here, exactly once, with the same FSI…PDI rule as
 * {@link isolatedText}. A caller names those keys; the findings surface uses {@link titleValues},
 * because every value it passes that is writer text ends in `Title`.
 */
import { I18n, i18n } from '@lingui/core';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import { isolate, type MessageRef } from '@caotang/i18n';

/** The English compiler for ids the catalogue does not hold. Separate from the app's active catalogue. */
const fallback = new I18n({});
fallback.setMessagesCompiler(compileMessage);
fallback.load('en-refs', {});
fallback.activate('en-refs');
const compiled = new Set<string>();

export interface RenderRefOptions {
  /** Value keys that hold writer text; each is isolated once before the message is formatted. */
  readonly userValues?: readonly string[];
}

/** Value names that are writer content: scene, shot and folder titles, codex names, a fact's text. */
const WRITER_KEYS = new Set([
  'title',
  'entry',
  'firstEntry',
  'secondEntry',
  'screenplayEntry',
  'dialogueEntry',
  'screenplayName',
  'dialogueName',
  'speaker',
  'pov',
  'fact',
]);

/** The keys of a finding's (or notice's) ref values that are writer content, isolated once by the caller. */
export function titleValues(ref: MessageRef): string[] {
  return Object.keys(ref.values ?? {}).filter((key) => key.endsWith('Title') || WRITER_KEYS.has(key));
}

/** The text a surface shows for a ref: the active catalogue when it has the id, else compiled English. */
export function renderRef(ref: MessageRef, options: RenderRefOptions = {}): string {
  const values = isolateValues(ref, options.userValues ?? []);
  if (Object.prototype.hasOwnProperty.call(i18n.messages, ref.id)) return i18n._(ref.id, values);
  if (!compiled.has(ref.id)) {
    fallback.load('en-refs', { [ref.id]: ref.message });
    compiled.add(ref.id);
  }
  return fallback._(ref.id, values);
}

function isolateValues(ref: MessageRef, keys: readonly string[]): Record<string, string | number> | undefined {
  if (ref.values === undefined) return undefined;
  if (keys.length === 0) return ref.values;
  const out: Record<string, string | number> = { ...ref.values };
  for (const key of keys) {
    const value = out[key];
    if (typeof value === 'string') out[key] = isolate(value);
  }
  return out;
}
