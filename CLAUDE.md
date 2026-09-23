# EditRail — notes for Claude Code sessions

This file does not ship. `.distignore` excludes it from the plugin zip and from WordPress.org.

## Issues and pull requests

The templates in this repository define the shape. Issues use `.github/ISSUE_TEMPLATE/feature.md` or `.github/ISSUE_TEMPLATE/bug.md`. Pull requests use `.github/pull_request_template.md`. Keep their headings in their order, and delete a heading that has nothing real under it. When any other guide disagrees with a template, the template wins for this repository.

- **Keep the core promise.** Both issue templates and the pull request template carry it: EditRail inserts ordinary core blocks and writes nothing into posts, so deactivating it changes nothing about how authored content renders or stays editable. The wording comes from `readme.txt`. A change that cannot keep it does not belong in this plugin.
- **Anchor claims to evidence.** Current behavior comes from a `file:line`, a merged pull request or a test, never from memory. Write "to verify" when a claim has not been checked. A search that finds nothing proves nothing until the same search finds a known match.
- **Write in ASD-STE100 Simplified Technical English**, with American spelling, and put one paragraph per line. GitHub shows a line break inside a paragraph as a visible break.
