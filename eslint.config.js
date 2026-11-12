/**
 * ESLint configuration (#99, #105). `npm run lint` runs it on assets/,
 * tests/ and scripts/.
 *
 * The rules look for real defects: undeclared, unused, shadowed and
 * redeclared names, unsafe syntax, and syntax that is too new. They do
 * not enforce a code style: no formatting rule is turned on here.
 *
 * The scripts in assets/ ship as they are, with no build step (README.md,
 * "Requirements"), so they must stay ES5: the parser reports `let`,
 * `const`, an arrow function or a template literal as a parse error.
 * ES2015+ BUILT-INS (Promise, Map, Object.assign, ...) are declared,
 * because the browsers the block editor supports have them. Only the
 * syntax is held to ES5.
 *
 * tests/ and scripts/ get the same defect rules in a second block (#105).
 * They are Node and Playwright code in modern syntax that never reaches a
 * site, so that block allows the latest syntax. Code in them also runs in
 * the browser (page.evaluate callbacks), so it knows browser globals too.
 * The NVDA suite (tests/e2e-sr/) does not run in CI, so lint is the only
 * check its code gets there.
 *
 * This file does not ship (.distignore).
 */
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'vendor/**', 'build/**', '*.config.js'],
  },
  {
    files: ['assets/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.es2021,
        // The block editor's script global.
        wp: 'readonly',
      },
    },
    linterOptions: {
      // A disable comment that no longer suppresses anything is an error,
      // so suppressions do not outlive the code they were written for.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // The recommended set: undeclared names (no-undef), unused names,
      // redeclared names, dead stores, duplicate keys and cases,
      // unreachable code, and similar.
      ...js.configs.recommended.rules,

      // Callback parameters are positional, so an unused leading
      // parameter cannot be removed. ES5 has no optional catch binding,
      // so `catch (e)` must name the error even when it is not used.
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],

      // A name that hides one from an outer scope. In one 12,000-line
      // closure, this is how a function reads or writes the wrong state.
      'no-shadow': ['error', { builtinGlobals: false, hoist: 'functions' }],

      // A `var` read before its declaration in the same function: hoisting
      // makes it `undefined`, not an error. Uses from inner functions (which
      // run later) and function declarations are allowed.
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],

      // Unsafe syntax.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-caller': 'error',
      'no-proto': 'error',
      'no-script-url': 'error',
      'no-implicit-globals': 'error',
    },
  },
  {
    // Node and Playwright code (#105): the e2e and NVDA suites, the
    // packaging, version, screenshot and Playground scripts. CommonJS in
    // the latest syntax. Browser globals too, for the callbacks that
    // page.evaluate() runs in the page.
    files: ['tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        // The block editor's global, read in page.evaluate() callbacks.
        wp: 'readonly',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
      // `_` is the placeholder for an unused leading parameter, also in
      // nested callbacks: `Array.from({ length }, (_, i) => …)`.
      'no-shadow': ['error', { builtinGlobals: false, hoist: 'functions', allow: ['_'] }],
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
];
