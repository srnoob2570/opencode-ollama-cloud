# Release conventions

## Why

- `branchPrefix: release/` — every version keeps a branch to backport fixes
  onto; the remote already carries release/v0.1.0 through release/v0.1.12.
- Changelog links are inline: each section ends with its own
  `**Full changelog:** compare/vA...vB` line.
- Release commits are `chore(release): v<x.y.z>` and cut the whole
  `## [Unreleased]` section into `## [x.y.z] - date (short-hash)`, with the
  short hash of the last commit in the range.

## Gotchas

- `publish.yml` fires on the `v*` tag push and publishes to npm via OIDC
  trusted publishing — no local `npm publish`, no npm token secret;
  npmjs.com trusts this repo + workflow filename.
- The workflow refuses a tag that does not match `package.json`'s version,
  and tolerates a re-pushed tag when the version is already on the registry.
- The tag's subject is the released section's first changelog entry and its
  body is the whole section; `gh release create v<x.y.z> --title v<x.y.z>
--notes-from-tag` builds the GitHub release from it.
- The release memory was a single legacy `.release-state.json` until
  v0.1.13, which migrated it to `.release/`.

## Preferences

- GitHub releases: yes, created from the annotated tag's notes.
