/**
 * The import actions for a whole script, a whole Ink story and a Twee story (screenplay.md §2.2, dialogue-narrative.md §4). The file
 * is read in the browser and handed to the bus: `screenplay.import` takes a Fountain or FDX file, and `dialogue.importInk` takes the
 * containers an Ink or Twee plan makes. Each import is one undo group, and what it could not bring in is read back on the status
 * line. A Twee story strips logic, so its report is shown first, and nothing is written until the writer confirms it.
 */

import { useRef, useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';

import { compileInk, mintImportIds, planInkImport, planTweeImport, type TweeImportPlan } from '@caotang/dialogue';

import { explain } from './actions.js';
import { requestInkCompiler } from '../app/ink-compiler.js';
import type { ProjectSession } from '../app/session.js';
import { importLineIdsSentence } from '../media/ink-model.js';
import { useReport, useSession } from './shared.js';
import { TweeImportDialog } from './TweeImportDialog.js';

/* lingui-set comment="Interpolated values: choices, count, file, name, scenes, sections, stripped" */

/** What `screenplay.import` hands back (screenplay.md §2.2): the counts it made, and the notices it raised. */
interface ScriptImportResult {
  readonly scenes: number;
  readonly folders: number;
  readonly notices: readonly string[];
}

export function ScriptImportActions({ session }: { session: ProjectSession }): ReactNode {
  useSession(session);
  const report = useReport();
  const scriptFile = useRef<HTMLInputElement>(null);
  const inkFile = useRef<HTMLInputElement>(null);
  const tweeFile = useRef<HTMLInputElement>(null);
  const [addIds, setAddIds] = useState(false);
  const [pendingTwee, setPendingTwee] = useState<{ readonly fileName: string; readonly plan: TweeImportPlan } | null>(null);

  const importScript = async (file: File): Promise<void> => {
    const format = /\.fdx$/i.test(file.name) ? 'fdx' : 'fountain';
    const text = await file.text();
    const outcome = session.dispatch('screenplay.import', { format, text });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    const result = outcome.value.result as ScriptImportResult;
    const scenes = result.scenes;
    const sections = result.folders;
    const name = isolate(file.name);
    const made = t`Imported ${plural(scenes, { one: '# scene', other: '# scenes' })} and ${plural(sections, { one: '# section', other: '# sections' })} from ${{ file: name }}.`;
    report({ text: [made, ...result.notices].join(' '), tone: 'info' });
  };

  const importInk = async (file: File): Promise<void> => {
    const text = await file.text();
    // The imported containers are read with the Ink compiler, so it loads before they are made (ink-compiler.ts).
    await requestInkCompiler();
    const plan = planInkImport(text);
    if (plan.containers.length === 0) {
      report({ text: t`${{ file: isolate(file.name) }} has no knot to import. An Ink story makes one container for each knot.`, tone: 'error' });
      return;
    }
    // The ids are minted here, before the one dispatch, so one undo takes the containers and their ids together (dialogue-narrative.md A3).
    const minted = addIds ? mintImportIds(plan.containers, { compiles: (body) => compileInk(body).ok }) : null;
    const outcome = session.dispatch('dialogue.importInk', {
      containers: (minted?.containers ?? plan.containers).map((container) => ({ title: container.title, body: container.body })),
    });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    const containers = plan.containers.length;
    const made = t`Imported ${plural(containers, { one: '# dialogue container', other: '# dialogue containers' })} from ${{ file: isolate(file.name) }}.`;
    // The text above the first knot is the story's entry, and the planner keeps it out of the containers (import-ink.ts): say so.
    const above = plan.preamble.split('\n').filter((line) => line.trim() !== '').length;
    const left =
      above === 0
        ? []
        : [
            above === 1
              ? t`${{ count: above }} line above the first knot was not imported. Copy it by hand if you need it.`
              : t`${{ count: above }} lines above the first knot were not imported. Copy them by hand if you need them.`,
          ];
    const ids = minted === null ? [] : [importLineIdsSentence(minted)];
    report({ text: [made, ...plan.notes, ...left, ...ids].join(' '), tone: 'info' });
  };

  const planTwee = async (file: File): Promise<void> => {
    const plan = planTweeImport(await file.text());
    if (plan.container === null) {
      report({ text: t`${{ file: isolate(file.name) }} has no passage to import. A Twee story makes one knot for each passage.`, tone: 'error' });
      return;
    }
    setPendingTwee({ fileName: file.name, plan });
  };

  const importTwee = async (): Promise<void> => {
    if (pendingTwee === null) return;
    const { fileName, plan } = pendingTwee;
    setPendingTwee(null);
    const container = plan.container;
    if (container === null) return;
    await requestInkCompiler();
    const outcome = session.dispatch('dialogue.importInk', { containers: [{ title: container.title, body: container.body }] });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    const { report: made } = plan;
    const stripped = made.strippedMacros;
    const passages = made.passages;
    const choices = made.choices;
    const text = t`Imported ${{ file: isolate(fileName) }} as one dialogue container: ${plural(passages, { one: '# knot', other: '# knots' })}, ${plural(choices, { one: '# choice', other: '# choices' })}, ${plural(stripped, { one: '# logic block', other: '# logic blocks' })} stripped.`;
    report({ text, tone: 'info' });
  };

  return (
    <div className="script-import" role="group" aria-label={t`Import a script, an Ink story or a Twee story`}>
      <button type="button" className="button is-quiet" onClick={() => scriptFile.current?.click()}>
        <Trans>Import script</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => inkFile.current?.click()}>
        <Trans>Import Ink</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => tweeFile.current?.click()}>
        <Trans>Import Twee</Trans>
      </button>
      <label className="script-import-ids">
        <input type="checkbox" checked={addIds} onChange={(event) => setAddIds(event.currentTarget.checked)} />
        <Trans>Add line ids to the imported containers (one time)</Trans>
      </label>
      <input
        ref={scriptFile}
        type="file"
        hidden
        accept=".fountain,.fdx"
        aria-label={t`Script file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void importScript(file);
        }}
      />
      <input
        ref={inkFile}
        type="file"
        hidden
        accept=".ink"
        aria-label={t`Ink file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void importInk(file);
        }}
      />
      <input
        ref={tweeFile}
        type="file"
        hidden
        accept=".twee,.tw"
        aria-label={t`Twee file`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void planTwee(file);
        }}
      />
      <TweeImportDialog
        fileName={pendingTwee?.fileName ?? null}
        plan={pendingTwee?.plan ?? null}
        onImport={() => void importTwee()}
        onCancel={() => setPendingTwee(null)}
      />
    </div>
  );
}
