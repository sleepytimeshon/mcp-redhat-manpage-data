# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases up to 0.2.1 are described in their [GitHub releases](https://github.com/sleepytimeshon/mcp-redhat-manpage-data/releases).

## [Unreleased]

## [0.2.2] - 2026-11-27

### Added
- `pageSource(version, name, section)` returns the source package (NEVRA) and license of a stored or aliased page from `sources.tsv`, or null when unknown.

### Changed
- `storedPages` reads a packed version's `pages.gz` once instead of opening it for every page: a full scan of RHEL 9 takes about 0.6 seconds instead of 2.4.

### Fixed
- A version that is not a major version number (such as `9/../..`) is rejected instead of being joined into a file system path.
- An unknown version's error lists the available versions instead of the man pages directory path.
- `index.d.ts` documents that functions taking a version throw for an unknown one.

The man page data is unchanged.

[Unreleased]: https://github.com/sleepytimeshon/mcp-redhat-manpage-data/compare/v0.2.2...HEAD
[0.2.2]: https://www.npmjs.com/package/mcp-redhat-manpage-data/v/0.2.2
