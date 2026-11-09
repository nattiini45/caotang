import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

export interface WorkCall {
  name: string;
  args: unknown[];
}

export interface WorkResult<T> {
  result: T;
  steps: number;
  scanned: number;
  backtracks: number;
}

export function measureWork<T>(source: string, calls: WorkCall[], modules: Record<string, string> = {}): WorkResult<T>[] {
  const child = spawnSync(process.execPath, [
    '--allow-natives-syntax', '--regexp-interpret-all', '--no-regexp-optimization',
    '--no-enable-experimental-regexp-engine-on-excessive-backtracks',
    fileURLToPath(import.meta.url), '--measure',
  ], { input: JSON.stringify({ source, calls, modules }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  if (child.error !== undefined) throw child.error;
  if (child.status !== 0) throw new Error(`Work counter failed (${child.status}): ${child.stderr}`);
  return JSON.parse(child.stdout) as WorkResult<T>[];
}

export function measureFile<T>(file: URL, calls: WorkCall[]): WorkResult<T>[] {
  return measureWork<T>(readFileSync(file, 'utf8'), calls);
}

function instrument(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: { before: [(context) => {
      const f = context.factory;
      const tick = () => f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('__work'), 'tick'), undefined, []);
      const bodyWithTick = (body: ts.Statement): ts.Block => f.createBlock([
        f.createExpressionStatement(tick()),
        ...(ts.isBlock(body) ? body.statements : [body]),
      ]);
      const visit: ts.Visitor = (node) => {
        const next = ts.visitEachChild(node, visit, context);
        if (ts.isForStatement(next)) return f.updateForStatement(next, next.initializer, next.condition, next.incrementor, bodyWithTick(next.statement));
        if (ts.isForOfStatement(next)) return f.updateForOfStatement(next, next.awaitModifier, next.initializer, next.expression, bodyWithTick(next.statement));
        if (ts.isForInStatement(next)) return f.updateForInStatement(next, next.initializer, next.expression, bodyWithTick(next.statement));
        if (ts.isWhileStatement(next)) return f.updateWhileStatement(next, next.expression, bodyWithTick(next.statement));
        if (ts.isDoStatement(next)) return f.updateDoStatement(next, bodyWithTick(next.statement), next.expression);
        if (ts.isArrowFunction(next) && !ts.isBlock(next.body)) {
          return f.updateArrowFunction(next, next.modifiers, next.typeParameters, next.parameters, next.type, next.equalsGreaterThanToken,
            f.createParenthesizedExpression(f.createComma(tick(), next.body)));
        }
        if (ts.isBlock(next) && node.parent !== undefined && ts.isFunctionLike(node.parent)) return bodyWithTick(next);
        return next;
      };
      return (file) => ts.visitNode(file, visit) as ts.SourceFile;
    }] },
  }).outputText;
}

if (process.argv[2] === '--measure') {
  const { source, calls, modules } = JSON.parse(readFileSync(0, 'utf8')) as { source: string; calls: WorkCall[]; modules: Record<string, string> };
  const work = {
    steps: 0, scanned: 0, backtracks: 0,
    tick() {
      this.steps++;
      if (this.steps > 100_000_000) throw new Error('The loop work ceiling was exceeded');
    },
  };
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  const limited = new Function('source', 'flags', 'limit', 'return %NewRegExpWithBacktrackLimit(source, flags, limit)') as (source: string, flags: string, limit: number) => RegExp;
  runInNewContext(String.raw`
    const exec = RegExp.prototype.exec;
    const probes = new Map();
    RegExp.prototype.exec = function (value) {
      const text = String(value);
      const start = this.global || this.sticky ? this.lastIndex : 0;
      if (start <= text.length) {
        const source = '(?:' + this.source + ')|' + (this.sticky ? '(?:)' : '(?![\\s\\S])');
        const succeeds = (budget) => {
          const key = JSON.stringify([source, this.flags, budget]);
          let re = probes.get(key);
          if (re === undefined) {
            re = __limited(source, this.flags, budget);
            probes.set(key, re);
          }
          re.lastIndex = start;
          return exec.call(re, text) !== null;
        };
        let upper = 1;
        let lower = 1;
        while (!succeeds(upper)) {
          lower = upper + 1;
          upper *= 2;
          if (upper > 256 * (text.length + 1)) throw new Error('The regex work ceiling was exceeded: ' + this.source);
        }
        while (lower < upper) {
          const middle = Math.floor((lower + upper) / 2);
          if (succeeds(middle)) upper = middle;
          else lower = middle + 1;
        }
        __work.backtracks += lower;
      }
      return exec.call(this, text);
    };
    const indexOf = String.prototype.indexOf;
    String.prototype.indexOf = function (needle, from = 0) {
      const result = indexOf.call(this, needle, from);
      const start = Math.min(this.length, Math.max(0, Math.trunc(from) || 0));
      __work.scanned += Math.max(0, (result < 0 ? this.length : result + String(needle).length) - start);
      return result;
    };
    const slice = String.prototype.slice;
    String.prototype.slice = function (...args) {
      const result = slice.apply(this, args);
      __work.scanned += result.length;
      return result;
    };
    const modules = {};
    const cache = {};
    function require(name) {
      if (cache[name] !== undefined) return cache[name];
      if (modules[name] === undefined) throw new Error('Missing test module: ' + name);
      const exports = {};
      cache[name] = exports;
      modules[name](exports, require);
      return exports;
    }
    ${Object.entries(modules).map(([name, source]) => `modules[${JSON.stringify(name)}] = function(exports, require) { ${instrument(source)} };`).join(String.fromCharCode(10))}
    (function(exports, require) { ${instrument(source)} })(exports, require);
  `, { exports, __work: work, __limited: limited, TextEncoder, TextDecoder });
  const results = calls.map(({ name, args }) => {
    work.steps = work.scanned = work.backtracks = 0;
    const result = exports[name]!(...args);
    return { result, steps: work.steps, scanned: work.scanned, backtracks: work.backtracks };
  });
  process.stdout.write(JSON.stringify(results));
}
