/**
 * The scan starts fast and ships small: nothing it imports, directly or through the workspace packages it uses, reaches a font or a
 * document writer. The exporter's `.` entry pulls in fontkit, pdf-lib and docx, so the scan takes the report from the font-free
 * `@caotang/exporter/coherence-report` subpath, and this walks the import graph to prove it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY = join(PACKAGES, 'scan/src/index.ts');

/** What the scan must never load. */
const FORBIDDEN = ['fontkit', '@pdf-lib/fontkit', 'pdf-lib', 'docx'];

/**
 * The budget for the wide walk below — explicit and per-test, never `vitest.config.ts`'s default.
 *
 * The walk parses **202** TypeScript source files with the compiler API, because it counts the
 * on-demand imports the exporter's entry only reaches at runtime. It does not measure wall clock:
 * the count of forbidden packages it must find is the claim. Measured on one development machine:
 * **450 ms** alone; **3 176–4 741 ms** under the full suite's worker pool, which is what a
 * 5 000 ms default cannot reliably cover. 30 000 ms clears every figure recorded with headroom and
 * still fails a hang. Raising the config default instead would move every other test's budget,
 * which the timeout decision in `packages/editor/test/dialect.test.ts` rules out.
 */
const WIDE_WALK_TIMEOUT = 30_000;

interface Graph {
  readonly files: Set<string>;
  readonly external: Set<string>;
  readonly workspace: Set<string>;
}

/** The workspace packages by name, with where each one's entry points are. */
function workspacePackages(): Map<string, { dir: string; exports: Record<string, string> }> {
  const byName = new Map<string, { dir: string; exports: Record<string, string> }>();
  for (const name of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, name, 'package.json');
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; exports?: Record<string, string> | string; main?: string };
    const exports = typeof parsed.exports === 'object' ? parsed.exports : { '.': parsed.main ?? './src/index.ts' };
    byName.set(parsed.name, { dir: join(PACKAGES, name), exports });
  }
  return byName;
}

/** The package name and subpath of a bare specifier: `@scope/name/sub` → `@scope/name`, `./sub`. */
function splitSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/');
  const nameLength = specifier.startsWith('@') ? 2 : 1;
  const rest = parts.slice(nameLength).join('/');
  return { name: parts.slice(0, nameLength).join('/'), subpath: rest === '' ? '.' : `./${rest}` };
}

/**
 * The modules a file names. Always its `import` and `export ... from` declarations (a type-only one is erased, so it is not a load).
 * With `dynamic`, also every `import()` call: those load on demand, as the PDF and DOCX writers load their fonts and libraries, so
 * they are not part of what loading a package costs, but they are part of what it could reach.
 */
function importsOf(file: string, dynamic: boolean): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (dynamic && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function walk(entry: string, dynamic = false): Graph {
  const packages = workspacePackages();
  const graph: Graph = { files: new Set(), external: new Set(), workspace: new Set() };
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (graph.files.has(file)) continue;
    graph.files.add(file);
    for (const specifier of importsOf(file, dynamic)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
        continue;
      }
      const { name, subpath } = splitSpecifier(specifier);
      const target = packages.get(name);
      if (target === undefined) {
        graph.external.add(name);
        continue;
      }
      graph.workspace.add(name);
      const path = target.exports[subpath];
      expect(path, `${specifier} is not an export of ${name}`).toBeDefined();
      queue.push(resolve(target.dir, path as string));
    }
  }
  return graph;
}

describe('the scan import graph', () => {
  const graph = walk(ENTRY);

  it('is walked, not skipped: it reaches the coherence module, the store and the report', () => {
    expect(graph.files.size).toBeGreaterThan(40);
    expect([...graph.workspace]).toEqual(expect.arrayContaining(['@caotang/coherence', '@caotang/store', '@caotang/codex', '@caotang/exporter']));
    expect(graph.files.has(join(PACKAGES, 'exporter/src/coherence-report.ts'))).toBe(true);
  });

  it('never reaches the exporter’s main entry or any renderer', () => {
    const exporterFiles = [...graph.files].filter((file) => file.startsWith(join(PACKAGES, 'exporter/src')));
    expect(exporterFiles).toEqual([join(PACKAGES, 'exporter/src/coherence-report.ts')]);
  });

  it('loads no font, PDF or document-writer package', () => {
    const reached = [...graph.external, ...graph.workspace];
    expect(reached.filter((name) => FORBIDDEN.includes(name))).toEqual([]);
  });

  it('names none of them in its own files or the report it takes from the exporter, not even to load on demand', () => {
    const own = [...graph.files].filter((file) => file.startsWith(join(PACKAGES, 'scan/src')) || file === join(PACKAGES, 'exporter/src/coherence-report.ts'));
    expect(own.length).toBeGreaterThan(6);
    for (const file of own) {
      expect(importsOf(file, true).filter((specifier) => FORBIDDEN.includes(splitSpecifier(specifier).name)), file).toEqual([]);
    }
  });

  it('declares none of them either', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGES, 'scan/package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).filter((name) => FORBIDDEN.includes(name))).toEqual([]);
  });

  it('would notice one: counting on-demand imports, the walk finds all of them from the exporter’s own entry', () => {
    const wide = walk(join(PACKAGES, 'exporter/src/index.ts'), true);
    expect(FORBIDDEN.filter((name) => wide.external.has(name)).sort()).toEqual(['@pdf-lib/fontkit', 'docx', 'fontkit', 'pdf-lib']);
  }, WIDE_WALK_TIMEOUT);
});
