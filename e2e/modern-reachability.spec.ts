import { expect } from '@playwright/test';

import { MODERN_HOMES } from './modern-homes.js';
import { cspViolations, test, walk, watchCsp } from './modern-walk.js';

/**
 * The reachability walk (M12, #313; modern-interface.md §1 G2, §7, §15.3): nothing becomes unreachable. Every route of
 * MODERN_HOMES (§7 as data, e2e/modern-homes.ts) is walked in Modern, one test each, as a writer would take it, in Chromium, Firefox
 * and WebKit. The project is built in Classic (once per worker, kept as a storage state: `test` in e2e/modern-walk.ts), opened, and
 * switched to Modern live, so the walk starts where a writer who switched does.
 * No walk may raise a Content-Security-Policy violation (§11).
 *
 * A route whose home is still being built is `test.fixme` with the issue that builds it, so the gap stays listed and the branch stays
 * green; the issue that lands it removes `pending` from the line. A route only Chromium can take (File System Access) is skipped
 * elsewhere.
 */

test.use({ viewport: { width: 1440, height: 900 } });

for (const home of MODERN_HOMES) {
  test.describe(`§${home.section} ${home.classic}`, () => {
    test.use({ setup: home.setup });
    for (const route of home.routes) {
      // A route with a setup of its own (open findings) starts from that project; its title stays the same.
      test.describe(() => {
        if (route.setup !== undefined) test.use({ setup: route.setup });
        test(`${home.modern}: ${route.via}`, async ({ page, browserName }) => {
          test.fixme(route.pending !== undefined, `#${route.pending ?? ''}: ${route.why ?? 'its home is still being built'}`);
          test.skip(route.chromiumOnly === true && browserName !== 'chromium', 'File System Access is Chromium-only');
          await watchCsp(page);
          await walk(page, home.setup, route);
          expect(await cspViolations(page)).toEqual([]);
        });
      });
    }
  });
}
