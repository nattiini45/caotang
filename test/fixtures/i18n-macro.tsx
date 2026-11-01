/**
 * A macro-bearing fixture for the toolchain gate (I3 / #193). It exists to prove that the repository's
 * **actual** Vitest transform runs Lingui's macro transform on a real `msg` macro, not merely that the
 * plugin appears in a config file. `test/i18n-build.test.ts` imports it and inspects the descriptor.
 *
 * English descriptor for a fixture message.
 */
import { msg } from '@lingui/core/macro';

export const fixtureMessage = msg`A macro fixture message`;

/**
 * The same English text as the startup witness in `components/Home.tsx`. Lingui derives the catalogue
 * id from the source text, so this descriptor's id is the catalogue key the witness renders under — and
 * the test can name that key without copying a generated hash into the test.
 */
export const witnessMessage = msg`Settings`;
