import { INTERFACE_CATALOGUES } from './catalogues.js';
import { SOURCE_LOCALE_TAG, loadCatalogue } from './runtime.js';

export async function preloadCatalogues(): Promise<string[]> {
  const loads = INTERFACE_CATALOGUES.flatMap(({ id, pseudo }) =>
    id === SOURCE_LOCALE_TAG || pseudo ? [] : loadCatalogue(id).then(() => [id], () => []),
  );
  return (await Promise.all(loads)).flat();
}
