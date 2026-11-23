import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url).href), 'utf8');
}

function transpile(path: string): string {
  return ts.transpileModule(read(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}

export function workerModules(appendToEntry = ''): { type: 'ESModule'; path: string; contents: string }[] {
  return [
    { type: 'ESModule', path: 'src/index.mjs', contents: transpile('../src/index.ts') + appendToEntry },
    { type: 'ESModule', path: 'src/account-key-record.js', contents: transpile('../src/account-key-record.ts') },
    { type: 'ESModule', path: 'src/account-vault.js', contents: transpile('../src/account-vault.ts') },
    { type: 'ESModule', path: 'src/accounts.js', contents: transpile('../src/accounts.ts') },
    { type: 'ESModule', path: 'src/fingerprint.js', contents: transpile('../src/fingerprint.ts') },
    { type: 'ESModule', path: 'src/project-lease.js', contents: transpile('../src/project-lease.ts') },
    { type: 'ESModule', path: 'src/project-records.js', contents: transpile('../src/project-records.ts') },
    { type: 'ESModule', path: 'src/quota-lifecycle.js', contents: transpile('../src/quota-lifecycle.ts') },
    { type: 'ESModule', path: 'src/quota.js', contents: transpile('../src/quota.ts') },
    { type: 'ESModule', path: 'src/storage.js', contents: transpile('../src/storage.ts') },
    { type: 'ESModule', path: 'account-policy.mjs', contents: read('../account-policy.mjs') },
  ];
}
