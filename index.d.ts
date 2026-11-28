/** A man page name and section, e.g. { name: "sssd.conf", section: "5" }. */
export interface PageRef {
  name: string;
  section: string;
}

/** A distinct stored page; read() returns its text. */
export interface StoredPage extends PageRef {
  read(): Promise<string>;
}

/** Where a page came from: its source RPM (NEVRA) and that package's License tag. */
export interface PageSource {
  package: string;
  license: string;
}

/**
 * Every function that takes a version throws when the directory has no such version, or the
 * version is not a major version number; the message lists the available versions.
 */
export interface Reader {
  /** The man pages directory this reader reads. */
  readonly dir: string;
  /** RHEL major versions available, in numeric order, e.g. ["8", "9", "10"]. */
  versions(): Promise<string[]>;
  /** Every page of a version, stored or aliased, sorted by name then section. */
  listPages(version: string): Promise<PageRef[]>;
  /** The text of one page, or null when the version has no such page. */
  readPage(version: string, name: string, section: string): Promise<string | null>;
  /** The source package and license of a page, stored or aliased, or null when unknown. */
  pageSource(version: string, name: string, section: string): Promise<PageSource | null>;
  /** Each distinct page text once; aliases share their stored page's text. */
  storedPages(version: string): AsyncIterable<StoredPage>;
}

/** The man pages directory bundled in this package. */
export const manpagesDir: string;

/** Create a reader for this package's pages, or another directory with the same layout. */
export function createReader(dir?: string): Reader;

export const versions: Reader["versions"];
export const listPages: Reader["listPages"];
export const readPage: Reader["readPage"];
export const pageSource: Reader["pageSource"];
export const storedPages: Reader["storedPages"];
