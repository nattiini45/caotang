import { expect, test } from '@playwright/test';
import { XML_LIMITS } from '../packages/import-read/src/xml.js';
import { ARCHIVE_LIMITS } from '../packages/import-read/src/zip.js';

import { createProject } from './support.js';

for (const { fileName, format, cap } of [
  { fileName: 'oversized.docx', format: 'Word', cap: ARCHIVE_LIMITS.maxArchiveBytes },
  { fileName: 'oversized.odt', format: 'OpenDocument', cap: ARCHIVE_LIMITS.maxArchiveBytes },
  { fileName: 'oversized.fodt', format: 'OpenDocument', cap: XML_LIMITS.maxInput },
]) {
  test(`refuses ${fileName} before reading the file`, async ({ page }) => {
    await createProject(page, 'Office Import');
    const input = page.locator(`input[type="file"][aria-label="${format} file"]`);
    await input.evaluate((element, { name, size }) => {
      const file = new File([], name);
      Object.defineProperties(file, {
        size: { value: size },
        arrayBuffer: {
          value: () => {
            element.setAttribute('data-read-attempted', '');
            throw new Error('The oversized file must not be read');
          },
        },
      });
      Object.defineProperty(element, 'files', { value: [file] });
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name: fileName, size: cap + 1 });
    await expect(page.getByRole('alert').filter({ hasText: fileName })).toContainText(
      `is too large to import as ${format === 'Word' ? 'a Word' : 'an OpenDocument'} file (${cap / (1024 * 1024)} MB max).`,
    );
    await expect(input).not.toHaveAttribute('data-read-attempted', '');
  });
}
