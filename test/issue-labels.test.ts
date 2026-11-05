/**
 * Type and area labels on issues (.github/ISSUE_TEMPLATE/ and .github/workflows/issue-labels.yml). GitHub cannot require a label,
 * so the forms set the type label and ask a required Area question, and the workflow turns the answer into area:* labels and marks
 * anything still unlabelled `needs-triage`. The workflow cannot run here; these tests keep the forms and the workflow in step.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('\r\n').join('\n');

const TYPES = ['bug', 'enhancement', 'tech-debt', 'documentation', 'roadmap', 'known-limit', 'accessibility'];
const FORMS: Record<string, string> = {
  'bug_report.yml': 'bug',
  'feature_request.yml': 'enhancement',
  'documentation.yml': 'documentation',
  'tech_debt.yml': 'tech-debt',
};

const workflow = read('.github/workflows/issue-labels.yml');
const formFiles = readdirSync(resolve(root, '.github/ISSUE_TEMPLATE')).filter((n) => n.endsWith('.yml') && n !== 'config.yml');

/** The Area dropdown's block: from `id: area` to the next body item. */
function areaBlock(form: string): string {
  const start = form.indexOf('    id: area\n');
  if (start < 0) throw new Error('form has no area dropdown');
  const next = form.indexOf('\n  - type:', start);
  return form.slice(start, next < 0 ? form.length : next);
}
const areaOptions = (form: string): string[] =>
  [...areaBlock(form).matchAll(/^ {8}- '(area:[a-z0-9-]+) — [^']+'$/gm)].map((m) => m[1]!);

describe('the issue forms', () => {
  it('are exactly the four typed forms, and blank issues are off', () => {
    expect(formFiles.sort()).toEqual(Object.keys(FORMS).sort());
    expect(read('.github/ISSUE_TEMPLATE/config.yml')).toMatch(/^blank_issues_enabled: false$/m);
  });

  it('each set one type label', () => {
    for (const [file, type] of Object.entries(FORMS)) {
      expect(TYPES).toContain(type);
      expect(read(`.github/ISSUE_TEMPLATE/${file}`), file).toMatch(new RegExp(`^labels: \\[${type}\\]$`, 'm'));
    }
  });

  it('each ask a required, multi-choice Area question with the same options, every one an area label', () => {
    const first = areaOptions(read(`.github/ISSUE_TEMPLATE/${formFiles[0]}`));
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first).size).toBe(first.length);
    for (const file of formFiles) {
      const form = read(`.github/ISSUE_TEMPLATE/${file}`);
      const block = areaBlock(form);
      expect(block, file).toMatch(/^ {6}label: '?Area'?$/m);
      expect(block, file).toMatch(/^ {6}multiple: true$/m);
      expect(block, file).toMatch(/^ {4}validations:\n {6}required: true$/m);
      // Every option line is a label name and a description; nothing else is listed.
      expect(block.match(/^ {8}- /gm)?.length, file).toBe(areaOptions(form).length);
      expect(areaOptions(form), file).toEqual(first);
    }
  });
});

describe('the issue-labels workflow', () => {
  it('runs on the issue events that can change an issue’s labels or Area answer', () => {
    expect(workflow).toMatch(/^on:\n {2}issues:\n {4}types: \[opened, edited, labeled, unlabeled, reopened\]$/m);
  });

  it('holds only issues: write, and pins github-script to a commit', () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(/^ {4}permissions:\n {6}issues: write\n {4}steps:/m);
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/^actions\/github-script@[0-9a-f]{40}$/);
  });

  it('knows the same type labels as the forms', () => {
    expect(workflow).toContain(`TYPE_LABELS: ${TYPES.join(',')}`);
  });

  it('reads the Area section, adds only labels the repository has, and never comments', () => {
    expect(workflow).toContain("/^###\\s+Area\\s*$");
    expect(workflow).toContain('repoAreas.has(n)');
    expect(workflow).toContain('TRIAGE_LABEL: needs-triage');
    expect(workflow).not.toMatch(/createComment|removeAllLabels|setLabels/);
  });
});
