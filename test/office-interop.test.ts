/**
 * The XLSX interop gate (tools/office-interop/check_xlsx.py) is wired to the office-interop job in ci.yml: the job installs what the
 * checker runs, writes the corpus the checker reads, and keeps the workflow's read-only token. The checker itself runs in CI only
 * (it needs LibreOffice), so this is what keeps the job and the checker from drifting apart on a machine without either.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...parts: string[]) => readFileSync(resolve(__dirname, '..', ...parts), 'utf8');

describe('the office-interop job in ci.yml', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  const start = ci.indexOf('\n  office-interop:');
  const end = ci.indexOf('\n  pdf-validate:');
  const job = start < 0 ? '' : ci.slice(start, end < start ? undefined : end);
  const checker = read('tools', 'office-interop', 'check_xlsx.py');

  it('exists, and installs LibreOffice and the openpyxl version the checker documents', () => {
    expect(job).not.toBe('');
    const install = job.split('\n').filter((line) => line.includes(' install') || line.includes('tools/ci/apt-install.sh'));
    expect(install.join('\n')).toContain('libreoffice-calc');
    const pin = /openpyxl==[\d.]+/.exec(job)?.[0];
    expect(pin).toBeDefined();
    expect(checker).toContain(`pip install ${pin}`);
    expect(checker).toContain('shutil.which("soffice")');
  });

  it('writes the corpus, runs the checker on it, and uploads the corpus and logs on failure', () => {
    expect(job).toContain('CAOTANG_XLSX_OUT');
    expect(job).toContain('packages/exporter/test/xlsx-write-corpus.test.ts');
    expect(job).toContain('tools/office-interop/check_xlsx.py');
    expect(job).not.toContain('--skip-libreoffice');
    expect(job).toContain('if: failure()');
  });

  it('sets the corpus folder with a context a job-level env allows (runner exists only inside steps)', () => {
    const env = job.slice(job.indexOf('\n    env:'), job.indexOf('\n    steps:'));
    expect(env).toContain('CAOTANG_XLSX_OUT');
    expect(env).not.toContain('runner.');
  });

  it('keeps the workflow-wide read-only token, and the first-party actions at the version the verify job uses', () => {
    expect(ci).toContain('permissions:\n  contents: read');
    expect(job).not.toContain('permissions:');
    for (const action of ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']) {
      const pins = new Set([...ci.matchAll(new RegExp(`${action}@(v[0-9]+)`, 'g'))].map((m) => m[1]));
      expect(pins.size, action).toBe(1);
      expect(job).toContain(`${action}@${[...pins][0]}`);
    }
  });
});
