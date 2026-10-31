/**
 * What a Final Draft import will do, shown before anything is written (issues #264 and #265): the scenes and sections it makes,
 * the script notes and dual-dialogue pairs it keeps (counted even when there are none, so the writer can see nothing was lost),
 * what it makes of scene titles, colours and outline elements, and every notice about what it could not keep.
 *
 * The characters and places Final Draft already lists (SmartType, the cast, the character highlighting, Cast List lines) are
 * offered as optional codex rows, unticked. A name the codex already holds is shown and cannot be ticked: an import never
 * merges into an entry. **Import** writes the script and the ticked rows in one undo step; **Cancel** changes nothing.
 */

import { useState, type ReactNode } from 'react';

import { describeFdxImport, type FdxCodexSeed, type FdxImportedScript } from '@caotang/screenplay';

import { ChoiceDialog } from './shared.js';

/** Where a row's name was read, in the writer's words. */
const SOURCE_WORDS: Readonly<Record<FdxCodexSeed['sources'][number], string>> = {
  smarttype: 'SmartType',
  cast: 'cast',
  highlighting: 'character highlighting',
  'cast-list': 'Cast List',
};

function seedKey(seed: FdxCodexSeed): string {
  return `${seed.type}:${seed.name.toLowerCase()}`;
}

export function FdxImportDialog({
  fileName,
  script,
  warnings,
  existingNames = [],
  onImport,
  onCancel,
}: {
  /** The file being read, or null while no file is waiting on an answer. */
  fileName: string | null;
  script: FdxImportedScript | null;
  /** The import scan's sentence about instruction-like passages, notes included, when it found any. */
  warnings: readonly string[];
  /** The names and aliases the codex already holds, for the rows an import would collide with. */
  existingNames?: readonly string[];
  /** Called with the codex rows the writer ticked (none by default). */
  onImport: (seeds: readonly FdxCodexSeed[]) => void;
  onCancel: () => void;
}): ReactNode {
  const open = fileName !== null && script !== null;
  const notices = open ? script.notices : [];
  const seeds = open ? script.seeds : [];
  // The ticks belong to the file they were made for, so a new file starts with every row unticked.
  const [ticks, setTicks] = useState<{ readonly script: FdxImportedScript | null; readonly keys: ReadonlySet<string> }>({ script: null, keys: new Set() });
  const ticked: ReadonlySet<string> = ticks.script === script ? ticks.keys : new Set();
  const setTicked = (update: (current: ReadonlySet<string>) => ReadonlySet<string>): void => {
    setTicks((current) => ({ script, keys: update(current.script === script ? current.keys : new Set()) }));
  };
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const free = seeds.filter((seed) => !taken.has(seed.name.toLowerCase()));
  const toggle = (key: string, on: boolean): void => {
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const allTicked = free.length > 0 && free.every((seed) => ticked.has(seedKey(seed)));
  const chosen = (): FdxCodexSeed[] => free.filter((seed) => ticked.has(seedKey(seed)));
  return (
    <ChoiceDialog
      open={open}
      title="Import this Final Draft script?"
      choices={[{ label: 'Import', onChoose: () => onImport(chosen()) }]}
      onCancel={onCancel}
    >
      {open ? (
        <div className="twee-report">
          <p>
            <strong>{fileName}</strong> will become screenplay scenes. Read what the import keeps first.
          </p>
          <ul aria-label="What the import does">
            {describeFdxImport(script).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {seeds.length > 0 ? (
            <fieldset className="fdx-seeds">
              <legend>Codex entries (optional)</legend>
              <p>
                Final Draft lists these characters and places. Tick the ones to add to the codex; each attaches to the first scene that names
                it, in the same undo step as the script.
              </p>
              {free.length > 1 ? (
                <label className="fdx-seed">
                  <input
                    type="checkbox"
                    checked={allTicked}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setTicked(() => (on ? new Set(free.map(seedKey)) : new Set()));
                    }}
                  />
                  Tick all {free.length}
                </label>
              ) : null}
              <ul aria-label="Codex entries to add">
                {seeds.map((seed) => {
                  const key = seedKey(seed);
                  const collides = taken.has(seed.name.toLowerCase());
                  const from = seed.sources.map((source) => SOURCE_WORDS[source]).join(', ');
                  return (
                    <li key={key}>
                      <label className="fdx-seed">
                        <input
                          type="checkbox"
                          disabled={collides}
                          checked={!collides && ticked.has(key)}
                          onChange={(event) => toggle(key, event.currentTarget.checked)}
                        />
                        <span>
                          <strong>{seed.name}</strong> ({seed.type === 'character' ? 'character' : 'place'}, from {from})
                          {seed.description !== '' ? `: ${seed.description}` : ''}
                          {collides ? ' — already in the codex, left as it is' : ''}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ) : null}
          {notices.length + warnings.length > 0 ? (
            <>
              <h3>Notices</h3>
              <ul aria-label="Notices">
                {[...notices, ...warnings].map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </ChoiceDialog>
  );
}
