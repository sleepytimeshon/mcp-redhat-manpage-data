#!/usr/bin/env bash
# Pack the gzipped pages of one version directory into a single archive.
#
# Concatenates every <page>.<section>.txt.gz in DIR, in byte order of the page name, into
# DIR/pages.gz and writes DIR/index.tsv with each page's byte offset and length, then
# removes the individual files. Each page stays its own gzip member, so the reader can
# decompress one page without the rest, and `zcat pages.gz` prints them all.
#
# Usage: scripts/pack.sh DIR
#
# One archive per version keeps the npm package to a handful of files and keeps page
# names such as error::dwarf.7stap or HEAD.1 next to head.1 out of the file system.

set -euo pipefail

# ==============================================================================
# Arguments
# ==============================================================================

die() {
  echo "ERROR: $*" >&2
  exit 1
}

[ $# -eq 1 ] || die "usage: $0 DIR"
DIR="$1"
[ -d "$DIR" ] || die "$DIR is not a directory"
[ ! -e "$DIR/pages.gz" ] || die "$DIR already holds pages.gz"

PACK="$DIR/.pages.gz.tmp"
INDEX="$DIR/.index.tsv.tmp"

cleanup() {
  rm -f "$PACK" "$INDEX"
}
trap cleanup EXIT INT TERM

# ==============================================================================
# Pack
# ==============================================================================

mapfile -d '' -t FILES < <(cd "$DIR" && find . -maxdepth 1 -type f -name '*.txt.gz' -printf '%f\0' | LC_ALL=C sort -z)
[ "${#FILES[@]}" -gt 0 ] || die "$DIR has no .txt.gz pages"

: > "$PACK"
offset=0
{
  printf 'page\toffset\tlength\n'
  for f in "${FILES[@]}"; do
    [[ "$f" != *[$'\t\n']* ]] || die "page file name has a tab or newline: $f"
    size=$(stat -c %s -- "$DIR/$f")
    cat -- "$DIR/$f" >> "$PACK"
    printf '%s\t%s\t%s\n' "${f%.txt.gz}" "$offset" "$size"
    offset=$((offset + size))
  done
} > "$INDEX"

[ "$(stat -c %s -- "$PACK")" -eq "$offset" ] || die "pages.gz size does not match the index"

mv -- "$PACK" "$DIR/pages.gz"
mv -- "$INDEX" "$DIR/index.tsv"
for f in "${FILES[@]}"; do
  rm -f -- "${DIR:?}/$f"
done
echo "Packed ${#FILES[@]} pages ($offset bytes) into $DIR/pages.gz"
