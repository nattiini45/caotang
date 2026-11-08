/**
 * The XLSX interop gate (tools/office-interop/check_xlsx.py) is wired to the office-interop job in ci.yml: the job installs what the
 * checker runs, writes the corpus the checker reads, and keeps the workflow's read-only token. The checker itself runs in CI only
 * (it needs LibreOffice), so this is what keeps the job and the checker from drifting apart on a machine without either.
 *
 * The job also runs the negative controls (tools/office-interop/xlsx_negative_controls.py): three deliberate breakages that the
 * checker must reject, so a checker that has stopped failing cannot pass the job. The controls are pinned here too.
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
  const controls = read('tools', 'office-interop', 'xlsx_negative_controls.py');

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

  it('runs the three negative controls after the positive check, with the same interpreter', () => {
    expect(job).toContain('tools/office-interop/xlsx_negative_controls.py');
    expect(job).toContain('"$RUNNER_TEMP/venv/bin/python" tools/office-interop/xlsx_negative_controls.py');
    expect(job.indexOf('tools/office-interop/check_xlsx.py')).toBeGreaterThan(-1);
    expect(job.indexOf('tools/office-interop/check_xlsx.py')).toBeLessThan(job.indexOf('xlsx_negative_controls.py'));
  });

  it('breaks a string cell, the styles relationship and a number cell, and names each failure', () => {
    expect(controls).toContain('t="inlineStr"');
    expect(controls).toContain('/styles');
    expect(controls).toContain('no styles relationship');
    expect(controls).toContain('should be the number');
    expect(controls).toContain('dialogue.xlsx');
    expect(controls).toContain('shot-list.xlsx');
    // The control on the control: pointing the script at another checker is what proves it fails when a broken copy is accepted.
    expect(controls).toContain('--checker');
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

describe('the XLSX interop documentation', () => {
  const doc = read('docs', 'testing', 'office-interop.md');
  const changelog = read('CHANGELOG.md');

  it('describes the three negative controls the job runs', () => {
    expect(doc).toMatch(/negative control/i);
    expect(doc).toContain('xlsx_negative_controls.py');
    expect(doc).toContain('t="inlineStr"');
    expect(doc).toContain('styles relationship');
    expect(doc).toContain('a text cell');
  });

  it('keeps Excel, Numbers and Google Sheets unrecorded, because none of them ran', () => {
    expect(doc).toContain('| Excel 365 for Windows | | | not recorded | |');
    expect(doc).toContain('| Numbers (current macOS) | | | not recorded | |');
    expect(doc).toContain('| Google Sheets | | | not recorded | |');
  });

  it('says in the changelog that the job breaks copies and fails unless they are rejected', () => {
    expect(changelog).toContain('breaks a temporary copy of the corpus three ways');
    expect(changelog).toContain('fails unless each broken copy is rejected');
  });
});
