/**
 * Puts the MCP server bundle beside the shell's own, where `mcp.mts` forks it: `dist/mcp/caotang-mcp.mjs`.
 *
 * The bundle is `packages/mcp-server`'s own build output, so this copies it rather than rebuilding it. A tree where that package
 * was never built still builds the shell: the copy is skipped and the app says the server's bundle is missing, which is the same
 * sentence a packaged app without it would show. `pnpm --filter @caotang/mcp-server build` makes it.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shell = fileURLToPath(new URL('..', import.meta.url));
const source = fileURLToPath(new URL('../../../packages/mcp-server/dist/caotang-mcp.mjs', import.meta.url));
const target = join(shell, 'dist', 'mcp', 'caotang-mcp.mjs');

if (!existsSync(source)) {
  console.warn('The MCP server bundle is not built, so the app will say it is missing. Run pnpm --filter @caotang/mcp-server build.');
  process.exit(0);
}
mkdirSync(join(shell, 'dist', 'mcp'), { recursive: true });
copyFileSync(source, target);
