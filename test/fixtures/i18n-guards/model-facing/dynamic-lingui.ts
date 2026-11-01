// i18n: model-facing

/** A dynamic import of the message runtime is still an import (I8). */
export async function load(): Promise<unknown> {
  return import('@lingui/core');
}
