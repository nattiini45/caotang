/**
 * The SignPath Foundation code signing preparation (#409): the words SignPath Foundation requires on the home page and in the policy,
 * the switched-off signing job and its pinned action, and the metadata the artifact configuration enforces.
 *
 * The desktop release cannot run here (there is no desktop shell yet), so these tests hold the parts the application and the later
 * switch-on rely on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('\r\n').join('\n');
/** Text with its markup removed and its whitespace collapsed, as a reader sees it. */
const plain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ');

const REQUIRED = 'Free code signing provided by SignPath.io, certificate by SignPath Foundation';
const PRIVACY =
  'will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it';

/** The text of one top-level job of a workflow, from its `  id:` line to the next job (or the end). */
function jobBlock(workflow: string, id: string): string {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  const start = new RegExp(`^ {2}${id}:\\s*$`, 'm').exec(jobs);
  if (!start) throw new Error(`workflow has no top-level ${id} job`);
  const from = start.index + start[0].length;
  const next = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(jobs.slice(from));
  return jobs.slice(start.index, next ? from + next.index : jobs.length);
}

describe('the code signing policy', () => {
  const site = read('site/index.html');
  const policy = read('docs/CODE-SIGNING.md');

  it('has a "Code signing policy" section on the home page with the required credit, links, roles and privacy statement', () => {
    const at = site.indexOf('<section id="code-signing"');
    expect(at).toBeGreaterThan(-1);
    const section = site.slice(at, site.indexOf('</section>', at));
    expect(section).toContain('<h2>Code signing policy</h2>');
    expect(plain(section)).toContain(REQUIRED);
    expect(section).toContain('href="https://about.signpath.io"');
    expect(section).toContain('href="https://signpath.org"');
    expect(plain(section)).toMatch(/Authors, reviewers and approvers: @nattiini45/);
    expect(plain(section)).toContain(PRIVACY);
  });

  it('is linked from the footer', () => {
    const footer = site.slice(site.indexOf('<footer>'));
    expect(footer).toContain('<a href="#code-signing">Code signing policy</a>');
  });

  it('is written out in docs/CODE-SIGNING.md with every role, the privacy statement and the uninstaller', () => {
    expect(policy.startsWith('# Code signing policy\n')).toBe(true);
    expect(policy).toContain('Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).');
    for (const role of ['Authors (committers)', 'Reviewers', 'Approvers']) expect(policy).toContain(`| ${role} | [@nattiini45](https://github.com/nattiini45) |`);
    expect(policy).toContain(`This program ${PRIVACY}.`);
    expect(policy).toContain('## Uninstalling');
  });
});

describe('the desktop release workflow', () => {
  const workflow = read('.github/workflows/desktop-release.yml');

  it('starts only from desktop-v tags, so it never shares a tag with release.yml', () => {
    expect(workflow).toContain("tags: ['desktop-v*']");
    expect(workflow).not.toMatch(/tags: \['v\*'\]/);
  });

  const SIGNING_JOBS = ['sign-windows-exe', 'sign-windows-installer'];

  it('keeps signing switched off until SIGNPATH_ENABLED is true', () => {
    for (const id of SIGNING_JOBS) expect(jobBlock(workflow, id), id).toContain("if: ${{ vars.SIGNPATH_ENABLED == 'true' }}");
    expect(jobBlock(workflow, 'sign-windows-exe')).toContain('needs: build-windows');
  });

  it('pins the SignPath action to a full commit SHA and gives its jobs no write access', () => {
    for (const id of SIGNING_JOBS) {
      const sign = jobBlock(workflow, id);
      const uses = /uses: signpath\/github-action-submit-signing-request@(\S+)/.exec(sign);
      expect(uses?.[1], id).toMatch(/^[0-9a-f]{40}$/);
      expect(sign, id).not.toMatch(/: write/);
      expect(sign, id).toContain('environment: code-signing');
      expect(sign, id).toContain('api-token: ${{ secrets.SIGNPATH_API_TOKEN }}');
      expect(sign, id).toContain('wait-for-completion: true');
    }
  });

  it('signs Caotang.exe before the installer is built around it, then signs the installer and writes its SHA-256 again', () => {
    expect(jobBlock(workflow, 'sign-windows-exe')).toContain('github-artifact-id: ${{ needs.build-windows.outputs.exe-artifact-id }}');
    const installer = jobBlock(workflow, 'package-windows-installer');
    expect(installer).toContain('needs: [build-windows, sign-windows-exe]');
    expect(installer).toContain("needs.sign-windows-exe.result == 'success' || (needs.sign-windows-exe.result == 'skipped' && vars.SIGNPATH_ENABLED != 'true')");
    expect(installer).toContain('name: caotang-windows-exe-signed');
    const sign = jobBlock(workflow, 'sign-windows-installer');
    expect(sign).toContain('needs: [build-windows, package-windows-installer]');
    expect(sign).toContain('github-artifact-id: ${{ needs.package-windows-installer.outputs.installer-artifact-id }}');
    expect(sign.indexOf('sha256sum')).toBeGreaterThan(sign.indexOf('signpath/github-action-submit-signing-request'));
  });

  it('hashes the macOS and Linux packages with a Bash glob, not GNU-only find options', () => {
    const build = jobBlock(workflow, 'build-mac-linux');
    expect(build).toContain('packages=(*.dmg *.AppImage)');
    expect(build).not.toMatch(/\bfind\b.*-print0/);
  });

  it('holds only read permission at the workflow level and in the build jobs', () => {
    const header = workflow.slice(0, workflow.indexOf('\njobs:\n'));
    expect(header).toContain('permissions:\n  contents: read');
    expect(jobBlock(workflow, 'build-windows')).not.toContain('permissions:');
    expect(jobBlock(workflow, 'build-mac-linux')).not.toContain('permissions:');
    expect(jobBlock(workflow, 'package-windows-installer')).not.toContain('permissions:');
  });
});

describe('the SignPath artifact configuration', () => {
  const config = read('.signpath/artifact-configuration.xml');

  it('restricts every signed file to the product name Caotang and the release version', () => {
    const files = [...config.matchAll(/<pe-file\b([^>]*)>/g)].map((match) => match[1] ?? '');
    expect(files.length).toBeGreaterThan(0);
    for (const attributes of files) {
      expect(attributes).toContain('product-name="Caotang"');
      expect(attributes).toContain('product-version="${version}"');
    }
    expect(config).toContain('<parameter name="version" required="true" />');
  });
});
