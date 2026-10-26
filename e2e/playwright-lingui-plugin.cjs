/**
 * Playwright's Babel pipeline has no Lingui transform, so the app modules that the pure-model specs
 * import would execute `@lingui/core/macro`'s "outside compilation" shim. `PW_TEST_SOURCE_TRANSFORM`
 * installs this plugin for the files in scope: it runs the Lingui macros through babel-plugin-macros
 * (the same macro the app's Vite build uses) and imports the English activation shim before the
 * file's own imports, so the compiled `i18n._` calls have a locale.
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- Playwright's Babel hook loads this file with require(). */
const macros = require('babel-plugin-macros');

const ACTIVATE_ENGLISH = require.resolve('./playwright-english.mjs');

module.exports = function linguiInPlaywright(babel) {
  const plugin = macros.default ?? macros;
  const inner = plugin(babel);
  return {
    name: 'lingui-macros-in-playwright',
    visitor: {
      ...inner.visitor,
      Program(path, state) {
        inner.visitor.Program(path, state);
        path.unshiftContainer('body', babel.types.importDeclaration([], babel.types.stringLiteral(ACTIVATE_ENGLISH)));
      },
    },
  };
};
