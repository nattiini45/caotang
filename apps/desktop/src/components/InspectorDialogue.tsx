/**
 * The dialogue container's settings in the Inspector (dialogue-narrative.md §2.1, §3): the default speaker, the engine the
 * container compiles for, the line-id opt-in and the locale the text is written in. Each change is one `dialogue.setMeta`
 * command, so it has its undo and its row. The counts under them are read from the Ink text on screen.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useMemo, useState, type ReactNode } from 'react';

import { DIALOGUE_ENGINE_TARGETS, type DialogueMetaPatch } from '@caotang/bus';
import { readDialogueMeta, validateContainer } from '@caotang/dialogue';
import { getBody, type CodexEntry, type TreeNode } from '@caotang/store';

import { explain } from './actions.js';
import { InkGate } from './InkGate.js';
import { isImeEnter } from '../app/keymap.js';
import type { ProjectSession } from '../app/session.js';
import { useCodexEntries } from '../media/hooks.js';
import { useReport, useSession } from './shared.js';

/** The engine each target names, in the words the writer sees. The targets are the bus's list (dialogue-narrative.md §2.1). */
const TARGET_LABELS: Readonly<Record<(typeof DIALOGUE_ENGINE_TARGETS)[number], string>> = {
  get 'ink-json'() {
    return t`Ink, compiled to JSON`;
  },
  get 'yarn-csv'() {
    return t`Yarn string table (CSV)`;
  },
  get 'generic-csv'() {
    return t`Any engine: a CSV table`;
  },
};

export function DialogueMetaSection({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useLingui();
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
      <summary className="field-label"><Trans>Container settings</Trans></summary>
      <p className="field-note">
        <Trans>These apply to the whole container. The default speaker fills the speaker column of the dialogue table. Add line ids on save
        writes the missing line ids into the Ink text as it saves.</Trans>
      </p>

      <label className="scene-field">
        <span><Trans>Default speaker</Trans></span>
        <select
          aria-label={t`Default speaker`}
          value={meta.speaker ?? ''}
          onChange={(event) => apply({ speaker: event.target.value === '' ? null : event.target.value })}
        >
          <option value=""><Trans>No default speaker</Trans></option>
          {characters.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      <label className="scene-field">
        <span><Trans>Engine target</Trans></span>
        <select
          aria-label={t`Engine target`}
          value={meta.engineTarget ?? ''}
          onChange={(event) =>
            apply({ engineTarget: event.target.value === '' ? null : (event.target.value as (typeof DIALOGUE_ENGINE_TARGETS)[number]) })
          }
        >
          <option value=""><Trans>No engine hint</Trans></option>
          {DIALOGUE_ENGINE_TARGETS.map((target) => (
            <option key={target} value={target}>
              {TARGET_LABELS[target]}
            </option>
          ))}
        </select>
      </label>
      <p className="field-note">
        <Trans>The dialogue table follows it: a Yarn target writes a Yarn strings file, and any other target writes the dialogue table. The Ink
        story is the same for every target.</Trans>
      </p>

      <label className="scene-check">
        <input type="checkbox" checked={meta.autoLineIds === true} onChange={(event) => apply({ autoLineIds: event.target.checked })} />
        <span><Trans>Add line ids on save</Trans></span>
      </label>

      <LocaleField key={`${node.id}:${meta.locBaseline ?? ''}`} value={meta.locBaseline ?? ''} onCommit={(locale) => apply({ locBaseline: locale === '' ? null : locale })} />
      <p className="field-note">
        <Trans>The dialogue table writes it on each line. The Ink story puts it in the file name. Empty uses the project’s language in the table.</Trans>
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
  useLingui();
  // The check runs the Ink compiler, so it is read again only when the body or the codex changes, not on every render of the Inspector.
  const check = useMemo(() => validateContainer(id, body, { entries: codex }), [id, body, codex]);
  return (
    <dl className="sp-readout dlg-counts" aria-label={t`Structure of the container`}>
      <div>
        <dt><Trans>Knots</Trans></dt>
        <dd>{check.stats.knots}</dd>
      </div>
      <div>
        <dt><Trans>Choices</Trans></dt>
        <dd>{check.stats.choices}</dd>
      </div>
      <div>
        <dt><Trans>Findings</Trans></dt>
        <dd>{check.findings.length}</dd>
      </div>
    </dl>
  );
}

/** The locale the text is written in, committed when the field loses focus (or on Enter), as one settings change. */
function LocaleField({ value, onCommit }: { value: string; onCommit: (locale: string) => void }): ReactNode {
  useLingui();
  const [text, setText] = useState(value);
  return (
    <label className="scene-field">
      <span><Trans>Locale</Trans></span>
      <input
        aria-label={t`Locale`}
        value={text}
        placeholder={t`For example en or en-GB`}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() !== value) onCommit(text.trim());
        }}
        onKeyDown={(event) => {
          // The Enter that commits an IME candidate must not leave the field: the committed text is saved on blur.
          if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) event.currentTarget.blur();
        }}
      />
    </label>
  );
}
