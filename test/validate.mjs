#!/usr/bin/env node
// Validate the extracted man pages. Each RHEL version directory must hold only gzipped
// pages in sections 1, 5, 7, and 8 that decompress to non-empty text, an aliases.tsv whose
// aliases have no file of their own and point at stored pages, every required page
// (stored or aliased), and a sources.tsv that lists exactly the stored and aliased pages.

import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { manpagesDir } = require("../index.js");

const VERSIONS = ["rhel8", "rhel9", "rhel10"];
const SECTION = /\.[1578][A-Za-z0-9]*$/;
const SUFFIX = ".txt.gz";

const required = (await readFile(new URL("../scripts/required-pages.txt", import.meta.url), "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const failures = [];
const check = (ok, message) => ok || failures.push(message);

// Parse a TSV file with the expected header into rows of fields
async function readTsv(file, header, version) {
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  check(lines.shift() === header, `${version}: ${file} header is not "${header.replace(/\t/g, "\\t")}"`);
  return lines.map((line) => line.split("\t"));
}

for (const version of VERSIONS) {
  const dir = join(manpagesDir, version);
  const files = await readdir(dir);

  const stored = new Set(files.filter((f) => f.endsWith(SUFFIX)).map((f) => f.slice(0, -SUFFIX.length)));
  check(stored.size > 0, `${version}: no pages`);
  for (const page of stored) {
    check(SECTION.test(page), `${version}: ${page} is not in section 1, 5, 7, or 8`);
    let text = "";
    try {
      text = gunzipSync(await readFile(join(dir, page + SUFFIX))).toString("utf8");
    } catch (err) {
      failures.push(`${version}: ${page}${SUFFIX} does not decompress: ${err.message}`);
      continue;
    }
    check(text.trim().length > 0, `${version}: ${page} is empty`);
  }

  // aliases.tsv: page -> stored page with identical content
  const aliases = new Map();
  for (const [page, target] of await readTsv(join(dir, "aliases.tsv"), "page\ttarget", version)) {
    check(page && target, `${version}: incomplete aliases.tsv row for ${page}`);
    check(SECTION.test(page), `${version}: alias ${page} is not in section 1, 5, 7, or 8`);
    check(!stored.has(page), `${version}: alias ${page} also has its own file`);
    check(stored.has(target), `${version}: alias ${page} points at missing page ${target}`);
    aliases.set(page, target);
  }
  const all = new Set([...stored, ...aliases.keys()]);

  for (const page of required) {
    check(all.has(page), `${version}: required page ${page} is missing`);
  }

  // sources.tsv: page -> source package and license
  const sources = await readTsv(join(dir, "sources.tsv"), "page\tpackage\tlicense", version);
  const listed = new Set();
  for (const [page, pkg, license] of sources) {
    check(page && pkg && license, `${version}: incomplete sources.tsv row for ${page}`);
    listed.add(page);
  }
  const unlisted = [...all].filter((p) => !listed.has(p));
  const stale = [...listed].filter((p) => !all.has(p));
  check(unlisted.length === 0, `${version}: pages missing from sources.tsv: ${unlisted.slice(0, 5).join(", ")}`);
  check(stale.length === 0, `${version}: sources.tsv lists missing pages: ${stale.slice(0, 5).join(", ")}`);

  const others = files.filter((f) => !f.endsWith(SUFFIX) && f !== "aliases.tsv" && f !== "sources.tsv");
  check(others.length === 0, `${version}: unexpected files: ${others.slice(0, 5).join(", ")}`);

  const packages = new Set(sources.map(([, pkg]) => pkg)).size;
  console.log(`${version}: ${all.size} pages (${stored.size} stored, ${aliases.size} aliases) from ${packages} packages`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):\n  ${failures.slice(0, 50).join("\n  ")}`);
  process.exit(1);
}
console.log("ok");
