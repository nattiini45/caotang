/**
 * The dialogue container's settings in the Inspector (dialogue-narrative.md §2.1, §3): the default speaker, the engine the
 * container compiles for, the line-id opt-in and the locale the text is written in. Each change is one `dialogue.setMeta`
 * command, so it has its undo and its row. The counts under them are read from the Ink text on screen.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { DIALOGUE_ENGINE_TARGETS, type DialogueMetaPatch } from '@caotang/bus';
import { readDialogueMeta, validateContainer } from '@caotang/dialogue';
import { getBody, type CodexEntry, type TreeNode } from '@caotang/store';

import { explain } from './actions.js';
import { InkGate } from './InkGate.js';
import type { ProjectSession } from '../app/session.js';
import { useCodexEntries } from '../media/hooks.js';
import { useReport, useSession } from './shared.js';

/** The engine each target names, in the words the writer sees. The targets are the bus's list (dialogue-narrative.md §2.1). */
const TARGET_LABELS: Readonly<Record<(typeof DIALOGUE_ENGINE_TARGETS)[number], string>> = {
  'ink-json': 'Ink, compiled to JSON',
  'yarn-csv': 'Yarn string table (CSV)',
  'generic-csv': 'Any engine: a CSV table',
};

export function DialogueMetaSection({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useSession(session);
  const report = useReport();
  const meta = readDialogueMeta(node.dialogue).meta;
  // The codex through the hook: the store changes an entry in place, so a memo keyed on the stored array would keep the names it read before
  // a rename or an alias, and the findings count would go stale (the same fault the dialogue view had).
  const codex = useCodexEntries(session);
  const characters = codex.filter((entry) => entry.type === 'character');
  const body = getBody(session.state, node.id);

  const apply = (patch: DialogueMetaPatch): void => {
    const outcome = session.dispatch('dialogue.setMeta', { nodeId: node.id, patch });
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };

  return (
    <details className="inspector-section dlg-meta" data-testid="dialogue-meta" open>
      <summary className="field-label">Container settings</summary>
      <p className="field-note">
        These apply to the whole container. The default speaker fills the speaker column of the dialogue table. Add line ids on save
        writes the missing line ids into the Ink text as it saves.
      </p>

      <label className="scene-field">
        <span>Default speaker</span>
        <select
          aria-label="Default speaker"
          value={meta.speaker ?? ''}
          onChange={(event) => apply({ speaker: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">No default speaker</option>
          {characters.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      <label className="scene-field">
        <span>Engine target</span>
        <select
          aria-label="Engine target"
          value={meta.engineTarget ?? ''}
          onChange={(event) =>
            apply({ engineTarget: event.target.value === '' ? null : (event.target.value as (typeof DIALOGUE_ENGINE_TARGETS)[number]) })
          }
        >
          <option value="">No engine hint</option>
          {DIALOGUE_ENGINE_TARGETS.map((target) => (
            <option key={target} value={target}>
              {TARGET_LABELS[target]}
            </option>
          ))}
        </select>
      </label>
      <p className="field-note">
        The dialogue table follows it: a Yarn target writes a Yarn strings file, and any other target writes the dialogue table. The Ink
        story is the same for every target.
      </p>

      <label className="scene-check">
        <input type="checkbox" checked={meta.autoLineIds === true} onChange={(event) => apply({ autoLineIds: event.target.checked })} />
        <span>Add line ids on save</span>
      </label>

      <LocaleField key={`${node.id}:${meta.locBaseline ?? ''}`} value={meta.locBaseline ?? ''} onCommit={(locale) => apply({ locBaseline: locale === '' ? null : locale })} />
      <p className="field-note">
        The dialogue table writes it on each line. The Ink story puts it in the file name. Empty uses the project’s language in the table.
      </p>

      {/* The counts come from the Ink compiler, which loads on demand: the settings above work without it. */}
      <InkGate variant="inline">
        <DialogueCounts id={node.id} body={body} codex={codex} />
      </InkGate>
    </details>
  );
}

/** The structure of the container, read from its Ink with the compiler. */
function DialogueCounts({ id, body, codex }: { id: string; body: string; codex: readonly CodexEntry[] }): ReactNode {
  // The check runs the Ink compiler, so it is read again only when the body or the codex changes, not on every render of the Inspector.
  const check = useMemo(() => validateContainer(id, body, { entries: codex }), [id, body, codex]);
  return (
    <dl className="sp-readout dlg-counts" aria-label="Structure of the container">
      <div>
        <dt>Knots</dt>
        <dd>{check.stats.knots}</dd>
      </div>
      <div>
        <dt>Choices</dt>
        <dd>{check.stats.choices}</dd>
      </div>
      <div>
        <dt>Findings</dt>
        <dd>{check.findings.length}</dd>
      </div>
    </dl>
  );
}

/** The locale the text is written in, committed when the field loses focus (or on Enter), as one settings change. */
function LocaleField({ value, onCommit }: { value: string; onCommit: (locale: string) => void }): ReactNode {
  const [text, setText] = useState(value);
  return (
    <label className="scene-field">
      <span>Locale</span>
      <input
        aria-label="Locale"
        value={text}
        placeholder="For example en or en-GB"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() !== value) onCommit(text.trim());
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}
