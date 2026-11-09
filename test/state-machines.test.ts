import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { machineTables } from './state-machines.registry.js';
import { renderMachineTables } from './state-machines-render.js';

describe('the registered machine tables', () => {
  it('match the committed documentation', () => {
    const path = fileURLToPath(new URL('../docs/architecture/state-machines.tables.md', import.meta.url));
    const rendered = renderMachineTables(machineTables);
    if (process.env.UPDATE_STATE_MACHINES === '1') writeFileSync(path, rendered);
    expect(readFileSync(path, 'utf8'), 'Regenerate with UPDATE_STATE_MACHINES=1 pnpm exec vitest run test/state-machines.test.ts')
      .toBe(rendered);
  });

  it('renders deterministically even when registry, row, event or target order changes', () => {
    const table = {
      id: 'fixture', initial: 'a', final: ['z', 'b'],
      on: { z: {}, b: {}, a: { second: ['z', 'b'], first: ['a'] } },
    };
    const reordered = {
      ...table, final: ['b', 'z'],
      on: { a: { first: ['a'], second: ['b', 'z'] }, b: {}, z: {} },
    };
    expect(renderMachineTables([table, ...machineTables]))
      .toBe(renderMachineTables([reordered, ...[...machineTables].reverse()]));
  });

  it('rejects duplicate identifiers rather than producing ambiguous sections', () => {
    const table = machineTables[0];
    expect(() => renderMachineTables([table, table])).toThrow(`Duplicate machine id: ${table.id}`);
  });
});
