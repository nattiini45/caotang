/**
 * The import actions for a whole script and a whole Ink story (screenplay.md §2.2, dialogue-narrative.md §4). The file is read
 * in the browser and handed to the bus: `screenplay.import` takes a Fountain or FDX file, and `dialogue.importInk` takes the
 * containers an Ink plan makes. Each import is one undo group, and what it could not bring in is read back on the status line.
 */

import { useRef, type ReactNode } from 'react';

import { planInkImport } from '@caotang/dialogue';

import { explain } from './actions.js';
import { requestInkCompiler } from '../app/ink-compiler.js';
import type { ProjectSession } from '../app/session.js';
import { useReport, useSession } from './shared.js';

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

  const importScript = async (file: File): Promise<void> => {
    const format = /\.fdx$/i.test(file.name) ? 'fdx' : 'fountain';
    const text = await file.text();
    const outcome = session.dispatch('screenplay.import', { format, text });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    const result = outcome.value.result as ScriptImportResult;
    const made = `Imported ${countOf(result.scenes, 'scene')} and ${countOf(result.folders, 'section')} from ${file.name}.`;
    report({ text: [made, ...result.notices].join(' '), tone: 'info' });
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
    const outcome = session.dispatch('dialogue.importInk', {
      containers: plan.containers.map((container) => ({ title: container.title, body: container.body })),
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
    report({ text: [made, ...plan.notes, ...left].join(' '), tone: 'info' });
  };

  return (
    <div className="script-import" role="group" aria-label="Import a script or an Ink story">
      <button type="button" className="button is-quiet" onClick={() => scriptFile.current?.click()}>
        Import script
      </button>
      <button type="button" className="button is-quiet" onClick={() => inkFile.current?.click()}>
        Import Ink
      </button>
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
    </div>
  );
}

function countOf(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
