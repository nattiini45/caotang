import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fresh copy of the modules, so the loader's cached compiler is not the one the setup file loaded. */
async function freshModules() {
  vi.resetModules();
  const loader = await import('../src/ink-loader.js');
  const compile = await import('../src/compile.js');
  const validate = await import('../src/validate.js');
  const exportInk = await import('../src/export-ink.js');
  return { ...loader, ...compile, ...validate, ...exportInk };
}

afterEach(() => {
  vi.doUnmock('inkjs/full');
  vi.resetModules();
});

describe('the Ink compiler loader', () => {
  it('fails closed before the compiler is loaded: compileInk, validateContainer and exportInkJson throw, none answers valid', async () => {
    const ink = await freshModules();
    expect(ink.inkCompilerLoaded()).toBe(false);
    expect(() => ink.compileInk('Hello.\n-> END\n')).toThrow(ink.InkCompilerNotLoaded);
    expect(() => ink.validateContainer('d1', 'Hello.\n-> END\n')).toThrow(ink.InkCompilerNotLoaded);
    expect(() => ink.exportInkJson('d1', 'Hello.\n-> END\n')).toThrow(ink.InkCompilerNotLoaded);
  });

  it('names the miss in a typed error a caller can tell from a compile error', async () => {
    const ink = await freshModules();
    const thrown = (() => {
      try {
        ink.compileInk('-> END\n');
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(ink.InkCompilerNotLoaded);
    expect((thrown as Error).name).toBe('InkCompilerNotLoaded');
    expect((thrown as Error).message).toContain('loadInkCompiler');
  });

  it('compiles once loaded, and loads one time however many callers wait', async () => {
    const ink = await freshModules();
    const first = ink.loadInkCompiler();
    expect(ink.loadInkCompiler()).toBe(first);
    await first;
    expect(ink.inkCompilerLoaded()).toBe(true);
    const result = ink.compileInk('Hello.\n-> END\n');
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    await expect(ink.loadInkCompiler()).resolves.toBeUndefined();
  });

  it('forgets a failed load, so the next call tries again and compileInk still fails closed meanwhile', async () => {
    const attempts = { count: 0 };
    vi.doMock('inkjs/full', () => {
      attempts.count += 1;
      if (attempts.count === 1) throw new Error('chunk 404');
      return { Compiler: class {}, CompilerOptions: class {} };
    });
    const ink = await freshModules();
    await expect(ink.loadInkCompiler()).rejects.toThrow();
    expect(ink.inkCompilerLoaded()).toBe(false);
    expect(() => ink.compileInk('-> END\n')).toThrow(ink.InkCompilerNotLoaded);
    await expect(ink.loadInkCompiler()).resolves.toBeUndefined();
    expect(ink.inkCompilerLoaded()).toBe(true);
    expect(attempts.count).toBe(2);
  });
});
