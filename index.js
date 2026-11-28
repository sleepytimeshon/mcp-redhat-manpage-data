// Read the RHEL man pages in this package, or in another directory with the same layout.
//
// Layout: <dir>/rhel<N>/pages.gz holds every stored page as its own gzip member, and
// index.tsv gives each page's byte offset and length in it. A directory of loose
// <page>.<section>.txt or .txt.gz files works too. An optional aliases.tsv maps pages with
// identical content to one stored page, and sources.tsv records where each page came from.
// Callers use the reader functions below rather than the files, so the layout can change
// without changing them.

const { existsSync, readdirSync } = require("node:fs");
const { open, readdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { gunzipSync } = require("node:zlib");

const manpagesDir = join(__dirname, "manpages");

// Split "<name>.<section>" at its last dot
function splitPage(base) {
  const dot = base.lastIndexOf(".");
  return { name: base.slice(0, dot), section: base.slice(dot + 1) };
}

// RHEL major versions in a man pages directory, in numeric order
function listVersions(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^rhel\d+$/.test(d))
    .map((d) => d.slice(4))
    .sort((a, b) => Number(a) - Number(b));
}

function createReader(dir = manpagesDir) {
  const indexes = new Map();
  const sources = new Map();

  // A version is a major version number; anything else never reaches the file system
  function versionDir(version) {
    const v = String(version);
    const path = join(dir, `rhel${v}`);
    if (!/^\d+$/.test(v) || !existsSync(path)) {
      const available = listVersions(dir);
      throw new Error(`No man pages for RHEL ${v}. Available versions: ${available.length ? available.join(", ") : "none"}.`);
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

  // The package and license of each page, from sources.tsv when the directory has one
  async function loadSources(version) {
    if (sources.has(version)) return sources.get(version);
    const file = join(versionDir(version), "sources.tsv");
    const map = new Map();
    if (existsSync(file)) {
      for (const [page, pkg, license] of await readRows(file)) {
        if (page) map.set(page, { package: pkg, license });
      }
    }
    sources.set(version, map);
    return map;
  }

  // One stored page from a pages.gz already read into memory
  function unpackMember(pack, entry, base) {
    if (entry.offset + entry.length > pack.length) throw new Error(`pages.gz is truncated at ${base}`);
    return gunzipSync(pack.subarray(entry.offset, entry.offset + entry.length)).toString("utf8");
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
      return listVersions(dir);
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

    // The source package and license of a page (stored or aliased), or null when unknown
    async pageSource(version, name, section) {
      const index = await loadIndex(version);
      const base = `${name}.${section}`;
      if (!index.files.has(base) && !index.aliases.has(base)) return null;
      return (await loadSources(version)).get(base) ?? null;
    },

    // Iterate over each distinct page text once (aliases share their stored page's text).
    // A packed version is read in one pass instead of one file read per page.
    async *storedPages(version) {
      const index = await loadIndex(version);
      const packFile = join(index.path, "pages.gz");
      const pack = existsSync(join(index.path, "index.tsv")) ? await readFile(packFile) : null;
      for (const [base, entry] of index.files) {
        const read = pack && !entry.file
          ? async () => unpackMember(pack, entry, base)
          : () => readStored(index, base);
        yield { ...splitPage(base), read };
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
  pageSource: reader.pageSource,
  storedPages: reader.storedPages,
};
