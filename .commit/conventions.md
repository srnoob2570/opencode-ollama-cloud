# Commit conventions

## Why

- The changelog is `CHANGELOG.md`: entries collect under `## [Unreleased]`
  until a release cuts the section into `## [x.y.z] - date (short-hash)` with
  an inline full-changelog compare link.

## Gotchas

- Entries are in English, user-facing phrasing, one detailed bullet per
  change — behavior, not commit references.
- `## [Unreleased]` can already carry entries from earlier unpushed commits:
  append new bullets under the existing `###` headings, never rewrite.
- `### Docs` is a house category beyond Keep a Changelog's standard set.
- Release commits are `chore(release): v<x.y.z>`; release conventions live in
  `.release/`.

## Preferences

- Conventional commits with scopes: `catalog`, `tui`, `plugin`, `release`.
- Subject at most 72 characters, imperative.
