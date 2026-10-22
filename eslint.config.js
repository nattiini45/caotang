import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/** The browser globals `packages/sdk/src` may not touch (see the last block). */
const SDK_BROWSER_GLOBALS = ['window', 'document', 'indexedDB', 'localStorage', 'sessionStorage', 'navigator', 'location', 'self'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', '.claude/**', '.local/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // `tools/` is Node CLI code. The block above scopes `globals.node` to
    // `**/*.{ts,tsx}`, so a plain `.mjs` file there would be linted with no Node
    // globals at all and `Buffer`/`process`/`console` would be `no-undef`. This block gives the root the globals and nothing else: the
    // TypeScript-only rules and the `no-console` budget above stay scoped to the
    // app and packages, where they were written.
    files: ['tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // `@caotang/sdk` runs in Node: a script, a CLI or CI, with no window. The block above gives every TypeScript file the browser's
    // globals, so a browser API there would lint clean and fail at runtime. The names below are the ones that tie code to a page or to
    // the browser's storage; `globalThis.<name>` is the same reach by another route, so it is closed too.
    files: ['packages/sdk/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...SDK_BROWSER_GLOBALS.map((name) => ({ name, message: `@caotang/sdk runs in Node, which has no ${name}. Take it from the caller, or leave the feature to the app.` })),
      ],
      'no-restricted-properties': [
        'error',
        ...SDK_BROWSER_GLOBALS.map((property) => ({ object: 'globalThis', property, message: `@caotang/sdk runs in Node, which has no ${property}.` })),
      ],
    },
  },
);
