/**
 * Where the production build put the German catalogue chunk, or `undefined` in development and tests, where there is no chunk file.
 * The build (`catalogueChunkUrl` in vite.config.ts) rewrites this module; the source below is what every other pipeline reads.
 */
export const deCatalogueUrl: string | undefined = undefined;
