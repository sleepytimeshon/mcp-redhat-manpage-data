// Read the RHEL man pages in this package, or in another directory with the same layout.
//
// Layout: <dir>/rhel<N>/pages.gz holds every stored page as its own gzip member, and
// index.tsv gives each page's byte offset and length in it. A directory of loose
// <page>.<section>.txt or .txt.gz files works too. An optional aliases.tsv maps pages with
// identical content to one stored page, and sources.tsv records where each page came from.
// Callers use the reader functions below rather than the files, so the layout can change
// without changing them.

const { existsSync } = require("node:fs");
const { open, readdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { gunzipSync } = require("node:zlib");

const manpagesDir = join(__dirname, "manpages");

// Split "<name>.<section>" at its last dot
function splitPage(base) {
  const dot = base.lastIndexOf(".");
  return { name: base.slice(0, dot), section: base.slice(dot + 1) };
}

function createReader(dir = manpagesDir) {
  const indexes = new Map();

  function versionDir(version) {
    const path = join(dir, `rhel${version}`);
    if (!existsSync(path)) {
      throw new Error(`No man pages for RHEL ${version} in ${dir}`);
    }
    return path;
  }

  // Read the rows of a TSV file after its header
  async function readRows(file) {
    return (await readFile(file, "utf8")).trimEnd().split("\n").slice(1).map((row) => row.split("\t"));
  }

  // Index a version once: stored page -> where its text is, alias -> stored page
  async function loadIndex(version) {
    if (indexes.has(version)) return indexes.get(version);

    const path = versionDir(version);
    const files = new Map();
    const indexFile = join(path, "index.tsv");
    if (existsSync(indexFile)) {
      for (const [page, offset, length] of await readRows(indexFile)) {
        if (page) files.set(page, { offset: Number(offset), length: Number(length) });
      }
    } else {
      for (const f of await readdir(path)) {
        if (f.endsWith(".txt.gz")) files.set(f.slice(0, -7), { file: f });
        else if (f.endsWith(".txt")) files.set(f.slice(0, -4), { file: f });
      }
    }

    const aliases = new Map();
    const aliasFile = join(path, "aliases.tsv");
    if (existsSync(aliasFile)) {
      for (const [page, target] of await readRows(aliasFile)) {
        if (page && files.has(target)) aliases.set(page, target);
      }
    }

    const index = { path, files, aliases };
    indexes.set(version, index);
    return index;
  }

  async function readStored(index, base) {
    const entry = index.files.get(base);
    if (entry.file) {
      const data = await readFile(join(index.path, entry.file));
      return (entry.file.endsWith(".gz") ? gunzipSync(data) : data).toString("utf8");
    }
    const handle = await open(join(index.path, "pages.gz"), "r");
    try {
      const data = Buffer.alloc(entry.length);
      const { bytesRead } = await handle.read(data, 0, entry.length, entry.offset);
      if (bytesRead !== entry.length) throw new Error(`pages.gz is truncated at ${base}`);
      return gunzipSync(data).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  return {
    dir,

    // RHEL major versions available, in numeric order, e.g. ["8", "9", "10"]
    async versions() {
      if (!existsSync(dir)) return [];
      return (await readdir(dir))
        .filter((d) => /^rhel\d+$/.test(d))
        .map((d) => d.slice(4))
        .sort((a, b) => Number(a) - Number(b));
    },

    // Every page of a version, stored or aliased, sorted by name then section
    async listPages(version) {
      const { files, aliases } = await loadIndex(version);
      return [...files.keys(), ...aliases.keys()]
        .map(splitPage)
        .sort((a, b) => a.name.localeCompare(b.name) || a.section.localeCompare(b.section));
    },

    // The text of one page, or null when the version has no such page
    async readPage(version, name, section) {
      const index = await loadIndex(version);
      const base = `${name}.${section}`;
      const stored = index.files.has(base) ? base : index.aliases.get(base);
      return stored ? readStored(index, stored) : null;
    },

    // Iterate over each distinct page text once (aliases share their stored page's text)
    async *storedPages(version) {
      const index = await loadIndex(version);
      for (const base of index.files.keys()) {
        yield { ...splitPage(base), read: () => readStored(index, base) };
      }
    },
  };
}

const reader = createReader();

module.exports = {
  manpagesDir,
  createReader,
  versions: reader.versions,
  listPages: reader.listPages,
  readPage: reader.readPage,
  storedPages: reader.storedPages,
};
