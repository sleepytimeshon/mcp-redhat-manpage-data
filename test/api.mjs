#!/usr/bin/env node
// Test the reader API against a small fixture (plain, gzipped, and aliased pages) and
// against the bundled man pages.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const data = require("../index.js");

// Build a fixture directory with one version holding each kind of page
const fixture = await mkdtemp(join(tmpdir(), "manpage-data-test-"));
try {
  const v = join(fixture, "rhel9");
  await mkdir(v);
  await mkdir(join(fixture, "notaversion"));
  await writeFile(join(v, "plain.conf.5.txt"), "plain text page\n");
  await writeFile(join(v, "packed.8.txt.gz"), gzipSync("gzipped page\n"));
  await writeFile(join(v, "aliases.tsv"), "page\ttarget\nother.8\tpacked.8\nbroken.1\tmissing.1\n");

  const reader = data.createReader(fixture);
  assert.deepEqual(await reader.versions(), ["9"]);
  assert.equal(await reader.readPage("9", "plain.conf", "5"), "plain text page\n");
  assert.equal(await reader.readPage("9", "packed", "8"), "gzipped page\n");
  assert.equal(await reader.readPage("9", "other", "8"), "gzipped page\n", "alias resolves to its target");
  assert.equal(await reader.readPage("9", "broken", "1"), null, "alias to a missing page is ignored");
  assert.equal(await reader.readPage("9", "absent", "5"), null);
  assert.deepEqual(await reader.listPages("9"), [
    { name: "other", section: "8" },
    { name: "packed", section: "8" },
    { name: "plain.conf", section: "5" },
  ]);

  const stored = [];
  for await (const page of reader.storedPages("9")) stored.push(`${page.name}.${page.section}=${(await page.read()).trim()}`);
  assert.deepEqual(stored.sort(), ["packed.8=gzipped page", "plain.conf.5=plain text page"]);

  await assert.rejects(reader.listPages("7"), /No man pages for RHEL 7/);
  assert.deepEqual(await data.createReader(join(fixture, "nonexistent")).versions(), []);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

// The bundled pages, through the default reader
assert.deepEqual(await data.versions(), ["8", "9", "10"]);
for (const version of await data.versions()) {
  const sssd = await data.readPage(version, "sssd.conf", "5");
  assert.match(sssd, /the configuration file for SSSD/, `RHEL ${version}: sssd.conf(5)`);
  const pages = await data.listPages(version);
  assert.ok(pages.some((p) => p.name === "sshd_config" && p.section === "5"), `RHEL ${version}: sshd_config(5) listed`);
}
assert.match(await data.readPage("9", "podman-run", "1"), /podman-run/i, "RHEL 9: aliased podman-run(1)");

console.log("ok: reader API on fixture and bundled pages");
