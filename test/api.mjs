#!/usr/bin/env node
// Test the reader API against small fixtures (packed pages, loose plain and gzipped pages,
// aliases) and against the bundled man pages.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const data = require("../index.js");

// Pack pages the way scripts/pack.sh does: one gzip member each, indexed by offset and length
async function writePack(dir, pages) {
  const members = [];
  const rows = ["page\toffset\tlength"];
  let offset = 0;
  for (const [page, text] of Object.entries(pages).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const member = gzipSync(text);
    members.push(member);
    rows.push(`${page}\t${offset}\t${member.length}`);
    offset += member.length;
  }
  await writeFile(join(dir, "pages.gz"), Buffer.concat(members));
  await writeFile(join(dir, "index.tsv"), rows.join("\n") + "\n");
}

// Build a fixture directory with a packed version and a version of loose files
const fixture = await mkdtemp(join(tmpdir(), "manpage-data-test-"));
try {
  const packed = join(fixture, "rhel9");
  await mkdir(packed);
  await mkdir(join(fixture, "notaversion"));
  await writePack(packed, {
    "packed.8": "packed page\n",
    "error::dwarf.7stap": "colon page\n",
    "HEAD.1": "HEAD page\n",
    "head.1": "head page\n",
  });
  await writeFile(join(packed, "aliases.tsv"), "page\ttarget\nother.8\tpacked.8\nbroken.1\tmissing.1\n");
  await writeFile(join(packed, "sources.tsv"), "page\tpackage\tlicense\npacked.8\tpkg-1.0-1.el9.x86_64\tMIT\nother.8\tpkg-1.0-1.el9.x86_64\tMIT\n");

  const loose = join(fixture, "rhel10");
  await mkdir(loose);
  await writeFile(join(loose, "plain.conf.5.txt"), "plain text page\n");
  await writeFile(join(loose, "zipped.8.txt.gz"), gzipSync("gzipped page\n"));
  await writeFile(join(loose, "aliases.tsv"), "page\ttarget\nother.8\tzipped.8\n");

  const reader = data.createReader(fixture);
  assert.deepEqual(await reader.versions(), ["9", "10"]);

  assert.equal(await reader.readPage("9", "packed", "8"), "packed page\n");
  assert.equal(await reader.readPage("9", "other", "8"), "packed page\n", "alias resolves to its target");
  assert.equal(await reader.readPage("9", "broken", "1"), null, "alias to a missing page is ignored");
  assert.equal(await reader.readPage("9", "absent", "5"), null);
  assert.equal(await reader.readPage("9", "error::dwarf", "7stap"), "colon page\n");
  assert.equal(await reader.readPage("9", "HEAD", "1"), "HEAD page\n");
  assert.equal(await reader.readPage("9", "head", "1"), "head page\n");
  assert.deepEqual(
    (await reader.listPages("9")).map((p) => `${p.name}(${p.section})`).sort(),
    ["HEAD(1)", "error::dwarf(7stap)", "head(1)", "other(8)", "packed(8)"].sort()
  );

  const stored = [];
  for await (const page of reader.storedPages("9")) stored.push(`${page.name}.${page.section}=${(await page.read()).trim()}`);
  assert.deepEqual(stored.sort(), [
    "HEAD.1=HEAD page",
    "error::dwarf.7stap=colon page",
    "head.1=head page",
    "packed.8=packed page",
  ].sort());

  assert.equal(await reader.readPage("10", "plain.conf", "5"), "plain text page\n", "loose plain page");
  assert.equal(await reader.readPage("10", "zipped", "8"), "gzipped page\n", "loose gzipped page");
  assert.equal(await reader.readPage("10", "other", "8"), "gzipped page\n", "loose alias");

  // Each stored page read through storedPages matches readPage
  for await (const page of reader.storedPages("9")) {
    assert.equal(await page.read(), await reader.readPage("9", page.name, page.section), `storedPages ${page.name}.${page.section}`);
  }

  assert.deepEqual(await reader.pageSource("9", "packed", "8"), { package: "pkg-1.0-1.el9.x86_64", license: "MIT" });
  assert.deepEqual(await reader.pageSource("9", "other", "8"), { package: "pkg-1.0-1.el9.x86_64", license: "MIT" }, "alias source");
  assert.equal(await reader.pageSource("9", "HEAD", "1"), null, "stored page missing from sources.tsv");
  assert.equal(await reader.pageSource("9", "absent", "5"), null);
  assert.equal(await reader.pageSource("10", "zipped", "8"), null, "no sources.tsv");

  await assert.rejects(reader.listPages("7"), /No man pages for RHEL 7\. Available versions: 9, 10\./);
  await assert.rejects(reader.listPages("7"), (err) => !err.message.includes(fixture), "error omits the directory path");
  for (const bad of ["9/../..", "../rhel9", "9 ", "", "rhel9"]) {
    await assert.rejects(reader.readPage(bad, "packed", "8"), /No man pages for RHEL/, `version ${JSON.stringify(bad)} is rejected`);
  }
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
assert.match(await data.readPage("10", "error::dwarf", "7stap"), /dwarf/i, "RHEL 10: name with colons");
assert.notEqual(await data.readPage("9", "HEAD", "1"), await data.readPage("9", "head", "1"), "HEAD(1) and head(1) differ");
for (const version of await data.versions()) {
  const src = await data.pageSource(version, "sssd.conf", "5");
  assert.match(src?.package ?? "", new RegExp(`^sssd-.*\\.el${version}`), `RHEL ${version}: sssd.conf(5) source package`);
  assert.ok(src.license, `RHEL ${version}: sssd.conf(5) license`);
}

// storedPages reads a packed version in one pass and matches readPage
let checked = 0;
for await (const page of data.storedPages("9")) {
  if (checked++ % 1000) continue;
  assert.equal(await page.read(), await data.readPage("9", page.name, page.section), `RHEL 9: storedPages ${page.name}.${page.section}`);
}

console.log("ok: reader API on fixture and bundled pages");
