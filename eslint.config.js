/**
 * ESLint configuration (#99). `npm run lint` runs it on assets/.
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
 * tests/ and scripts/ are not linted. They are Node and Playwright code in
 * modern syntax that never reaches a site, and CI runs them, so a defect
 * there already fails a job.
 *
 * This file does not ship (.distignore).
 */
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'vendor/**', 'build/**', 'tests/**', 'scripts/**', '*.config.js'],
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
];
