/**
 * stylelint configuration (#99). `npm run lint` runs it on
 * assets/editor-rail.css.
 *
 * The rules look for real defects: unknown properties, units, functions,
 * selectors and at-rules, invalid values and hex colors, duplicate
 * selectors and properties, and a shorthand that overrides its own
 * longhand. They do not enforce a code style. stylelint 16 removed its
 * formatting rules, and stylelint-config-recommended holds "possible
 * errors" only.
 *
 * Do not rename a `--toolrail-*` custom property or a selector to satisfy
 * a rule: extensions and a theme read them. Suppress the finding with a
 * comment that gives the reason.
 *
 * This file does not ship (.distignore).
 */
module.exports = {
  extends: 'stylelint-config-recommended',
  // A disable comment that suppresses nothing, or names no rule, is an
  // error, so suppressions do not outlive the code they were written for.
  reportNeedlessDisables: true,
  reportInvalidScopeDisables: true,
  rules: {
    // Defect rules that the recommended set does not turn on.
    'color-no-invalid-hex': true,
    'unit-no-unknown': true,
    'function-no-unknown': true,

    // Off. This rule asks for source order by specificity; it finds no
    // defect, because the more specific selector wins wherever it sits.
    // On the first run it reported 26 rules that work as intended: dock
    // variants (`[data-dock="left"] #toolrail-rail`) and states
    // (`:hover`, `body.toolrail-dragging *`). Satisfying it means
    // reordering much of the file, which can change the winner between
    // selectors of EQUAL specificity.
    'no-descending-specificity': null,
  },
};
