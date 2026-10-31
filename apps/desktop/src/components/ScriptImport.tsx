/**
 * The import actions for a whole script, a whole Ink story and a Twee story (screenplay.md §2.2, dialogue-narrative.md §4). The file
 * is read in the browser and handed to the bus: `screenplay.import` takes a Fountain or FDX file, and `dialogue.importInk` takes the
 * containers an Ink or Twee plan makes. Each import is one undo group, and what it could not bring in is read back on the status
 * line. A Twee story strips logic and a Final Draft file carries notes and dual dialogue, so the report of each is shown first, and
 * nothing is written until the writer confirms it. Each file is scanned
 * for passages that read like instructions to an AI (hidden characters, role markers, "ignore previous instructions"), and the status line
 * says so; the file is imported as it is either way (issue #54).
 */

import { useRef, useState, type ReactNode } from 'react';

import { compileInk, mintImportIds, planInkImport, planTweeImport, type TweeImportPlan } from '@caotang/dialogue';
import { importScanSentence, scanImport } from '@caotang/harness';
import { importFdx, type FdxImportedScript } from '@caotang/screenplay';

import { explain } from './actions.js';
import { requestInkCompiler } from '../app/ink-compiler.js';
import type { ProjectSession } from '../app/session.js';
import { importLineIdsSentence } from '../media/ink-model.js';
import { useReport, useSession } from './shared.js';
import { FdxImportDialog } from './FdxImportDialog.js';
import { TweeImportDialog } from './TweeImportDialog.js';

/** What `screenplay.import` hands back (screenplay.md §2.2): the counts it made, and the notices it raised. */
interface ScriptImportResult {
  readonly scenes: number;
  readonly folders: number;
  readonly notices: readonly string[];
}

/** The status line's sentence about a file's instruction-like passages, or nothing when the scan finds none. */
function scanSentenceOf(fileName: string, text: string): string[] {
  const sentence = importScanSentence(fileName, scanImport([{ where: 'file', text }]));
  return sentence === undefined ? [] : [sentence];
}

export function ScriptImportActions({ session }: { session: ProjectSession }): ReactNode {
  useSession(session);
  const report = useReport();
  const scriptFile = useRef<HTMLInputElement>(null);
  const inkFile = useRef<HTMLInputElement>(null);
  const tweeFile = useRef<HTMLInputElement>(null);
  const [addIds, setAddIds] = useState(false);
  const [pendingTwee, setPendingTwee] = useState<{ readonly fileName: string; readonly plan: TweeImportPlan; readonly scan: string[] } | null>(null);
  const [pendingFdx, setPendingFdx] = useState<{
    readonly fileName: string;
    readonly text: string;
    readonly script: FdxImportedScript;
    readonly scan: string[];
  } | null>(null);

  const writeScript = (fileName: string, format: 'fdx' | 'fountain', text: string, scan: readonly string[]): void => {
    const outcome = session.dispatch('screenplay.import', { format, text });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    const result = outcome.value.result as ScriptImportResult;
    const made = `Imported ${countOf(result.scenes, 'scene')} and ${countOf(result.folders, 'section')} from ${fileName}.`;
    report({ text: [made, ...result.notices, ...scan].join(' '), tone: 'info' });
  };

  const importScript = async (file: File): Promise<void> => {
    const text = await file.text();
    // The scan reads the whole file, so the text of script notes and hidden runs is scanned as well as the script.
    const scan = scanSentenceOf(file.name, text);
    if (!/\.fdx$/i.test(file.name)) {
      writeScript(file.name, 'fountain', text, scan);
      return;
    }
    // A Final Draft file is read first, so the dialog can count the notes and dual dialogue it keeps before anything is written.
    setPendingFdx({ fileName: file.name, text, script: importFdx(text), scan });
  };

  const importFdxFile = (): void => {
    if (pendingFdx === null) return;
    const { fileName, text, scan } = pendingFdx;
    setPendingFdx(null);
    writeScript(fileName, 'fdx', text, scan);
  };

  const importInk = async (file: File): Promise<void> => {
    const text = await file.text();
    // The imported containers are read with the Ink compiler, so it loads before they are made (ink-compiler.ts).
    await requestInkCompiler();
    const plan = planInkImport(text);
    if (plan.containers.length === 0) {
      report({ text: `${file.name} has no knot to import. An Ink story makes one container for each knot.`, tone: 'error' });
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
    const made = `Imported ${countOf(plan.containers.length, 'dialogue container')} from ${file.name}.`;
    // The text above the first knot is the story's entry, and the planner keeps it out of the containers (import-ink.ts): say so.
    const above = plan.preamble.split('\n').filter((line) => line.trim() !== '').length;
    const left =
      above === 0
        ? []
        : [`${countOf(above, 'line')} above the first knot ${above === 1 ? 'was' : 'were'} not imported. Copy ${above === 1 ? 'it' : 'them'} by hand if you need ${above === 1 ? 'it' : 'them'}.`];
    const ids = minted === null ? [] : [importLineIdsSentence(minted)];
    report({ text: [made, ...plan.notes, ...left, ...ids, ...scanSentenceOf(file.name, text)].join(' '), tone: 'info' });
  };

  const planTwee = async (file: File): Promise<void> => {
    const text = await file.text();
    const plan = planTweeImport(text);
    if (plan.container === null) {
      report({ text: `${file.name} has no passage to import. A Twee story makes one knot for each passage.`, tone: 'error' });
      return;
    }
    setPendingTwee({ fileName: file.name, plan, scan: scanSentenceOf(file.name, text) });
  };

  const importTwee = async (): Promise<void> => {
    if (pendingTwee === null) return;
    const { fileName, plan, scan } = pendingTwee;
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
    const text = `Imported ${fileName} as one dialogue container: ${countOf(made.passages, 'knot')}, ${countOf(made.choices, 'choice')}, ${made.strippedMacros} logic ${made.strippedMacros === 1 ? 'block' : 'blocks'} stripped.`;
    report({ text: [text, ...scan].join(' '), tone: 'info' });
  };

  return (
    <div className="script-import" role="group" aria-label="Import a script, an Ink story or a Twee story">
      <button type="button" className="button is-quiet" onClick={() => scriptFile.current?.click()}>
        Import script
      </button>
      <button type="button" className="button is-quiet" onClick={() => inkFile.current?.click()}>
        Import Ink
      </button>
      <button type="button" className="button is-quiet" onClick={() => tweeFile.current?.click()}>
        Import Twee
      </button>
      <label className="script-import-ids">
        <input type="checkbox" checked={addIds} onChange={(event) => setAddIds(event.currentTarget.checked)} />
        Add line ids to the imported containers (one time)
      </label>
      <input
        ref={scriptFile}
        type="file"
        hidden
        accept=".fountain,.fdx"
        aria-label="Script file"
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
        aria-label="Ink file"
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
        aria-label="Twee file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void planTwee(file);
        }}
      />
      <FdxImportDialog
        fileName={pendingFdx?.fileName ?? null}
        script={pendingFdx?.script ?? null}
        warnings={pendingFdx?.scan ?? []}
        onImport={importFdxFile}
        onCancel={() => setPendingFdx(null)}
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

function countOf(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
