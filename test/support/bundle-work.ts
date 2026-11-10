import { fileURLToPath } from 'node:url';

import { build, normalizePath } from 'vite';

export async function bundleWorkSource(file: URL, names: readonly string[], overrides: Record<string, string> = {}): Promise<string> {
  const entry = '\0measured-work-entry';
  const sources = new Map(Object.entries(overrides).map(([file, source]) => [normalizePath(file), source]));
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'measured-work-entry',
      resolveId(id) {
        if (id.endsWith('measured-work-entry')) return entry;
      },
      load(id) {
        if (id === entry) return `export { ${names.join(', ')} } from ${JSON.stringify(normalizePath(fileURLToPath(file)))};`;
        return sources.get(id);
      },
    }],
    build: { write: false, minify: false, lib: { entry: 'measured-work-entry', formats: ['cjs'] } },
  });
  const output = [result].flat().flatMap((build) => 'output' in build ? build.output : []);
  if (output.length !== 1 || output[0]?.type !== 'chunk' || output[0].imports.length !== 0 || output[0].dynamicImports.length !== 0) {
    throw new Error('The work counter needs one self-contained source bundle');
  }
  return output[0].code;
}
