# mcp-redhat-manpage-data

Pre-extracted RHEL man pages for [mcp-redhat-manpage](https://github.com/sleepytimeshon/mcp-redhat-manpage). Contains plain-text man pages for RHEL 8, 9, and 10, rendered from the packages in each release's BaseOS and AppStream repositories.

This package is a data dependency — install [mcp-redhat-manpage](https://github.com/sleepytimeshon/mcp-redhat-manpage) to use it.

## Contents

Every package in the RHEL BaseOS and AppStream repositories that ships man pages in these sections contributes all of its pages in them:

| Section | Contents |
|---------|----------|
| 1 | User commands |
| 5 | File formats and configuration files |
| 7 | Conventions, overviews, and miscellany |
| 8 | System administration commands |

Library and API sections (2, 3, and their variants) are not included.

Each `manpages/rhel<N>/` directory contains:

| File | Contents |
|------|----------|
| `<page>.<section>.txt.gz` | A page rendered to ASCII text at 120 columns, without hyphenation, gzip-compressed |
| `aliases.tsv` | Pages whose content is identical to a stored page (`page`, `target`); each is stored once |
| `sources.tsv` | The package and license of every page, stored or aliased (`page`, `package`, `license`) |

## Usage

Read pages through the exported functions rather than the files, so the storage layout can change between releases:

```js
const { versions, listPages, readPage, storedPages, createReader } = require("mcp-redhat-manpage-data");

await versions();                          // ["8", "9", "10"]
await readPage("9", "sssd.conf", "5");     // page text, or null if absent
await listPages("9");                      // [{ name, section }, ...] including aliases
for await (const page of storedPages("9")) // each distinct page once, for full-text search
  if ((await page.read()).includes("ldap_uri")) console.log(page.name, page.section);

const custom = createReader("/path/to/manpages"); // same functions for another directory
```

`createReader` accepts a directory with the same layout, with pages either gzipped (`.txt.gz`) or plain (`.txt`). `manpagesDir` is the path of the bundled `manpages` directory. TypeScript declarations are in `index.d.ts`.

## How it's built

[`scripts/extract.sh`](scripts/extract.sh) runs on a subscribed RHEL host with podman. The UBI repositories that GitHub-hosted runners can reach lack most of the packages, so extraction cannot run in CI. For each RHEL version, the script:

1. Starts the `registry.access.redhat.com/ubi<N>/ubi` container, which podman gives the host's BaseOS and AppStream repositories.
2. Finds every package that ships man pages in sections 1, 5, 7, or 8.
3. Downloads each package without installing it and unpacks only its man pages.
4. Renders every page with the `man` of the same RHEL release, including symlinked and `.so` alias pages.
5. Stores pages with identical content once, listing the others in `aliases.tsv`, and compresses each stored page.
6. Fails without replacing anything if a page in [`scripts/required-pages.txt`](scripts/required-pages.txt) is missing or the page count fell by more than 10%.

```bash
scripts/extract.sh          # RHEL 8, 9, and 10
scripts/extract.sh 9        # one version
```

## Releasing

Every push to `main` runs CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): `npm test` validates every page, alias, and source entry, and `shellcheck` checks the extraction script.

To release new man pages, run `scripts/extract.sh` on a subscribed RHEL host, review the changes, bump `version` in `package.json`, and push to `main`. When that version is not yet on npm, CI publishes it with provenance through npm trusted publishing and creates a `vX.Y.Z` GitHub release.

## Related MCP Servers

- [mcp-redhat-account](https://github.com/sleepytimeshon/mcp-redhat-account) - Account management
- [mcp-redhat-knowledge](https://github.com/sleepytimeshon/mcp-redhat-knowledge) - Knowledge Base search
- [mcp-redhat-manpage](https://github.com/sleepytimeshon/mcp-redhat-manpage) - MCP server that serves this data
- [mcp-redhat-subscription](https://github.com/sleepytimeshon/mcp-redhat-subscription) - Subscription management
- [mcp-redhat-support](https://github.com/sleepytimeshon/mcp-redhat-support) - Support case management

## License

The package code (`index.js` and `scripts/`) is licensed under the MIT License; see [LICENSE](LICENSE). The man pages under `manpages/` keep the licenses of their source RPM packages; see [NOTICES](NOTICES).
