#!/usr/bin/env bash
# Extract RHEL man pages and render them to plain text under manpages/rhel<N>/.
#
# Every package in the RHEL BaseOS and AppStream repositories that ships man pages in
# sections 1, 5, 7, or 8 is downloaded (not installed), only its man pages are unpacked,
# and each page is rendered to ASCII with the man-db of the same RHEL release. Pages with
# identical content are stored once and listed in aliases.tsv, and every stored page is
# gzip-compressed (<page>.<section>.txt.gz). Each version is built in a staging
# directory, validated, and only then replaces manpages/rhel<N>/.
#
# Usage: scripts/extract.sh [8|9|10 ...]   (no argument extracts all versions)
#
# Requires a subscribed RHEL host with podman: podman passes the host's entitlement into
# UBI containers, which gives them the full BaseOS and AppStream repositories. The UBI
# repositories alone lack most of the packages (sssd, chrony, NetworkManager, man-pages).

set -euo pipefail

# ==============================================================================
# Configuration
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MANPAGES_DIR="$PROJECT_DIR/manpages"

SECTIONS="1 5 7 8"
SUPPORTED_VERSIONS=(8 9 10)

# Pages every version must contain; a missing one means the extraction went wrong
mapfile -t REQUIRED_PAGES < <(grep -vE '^\s*(#|$)' "$SCRIPT_DIR/required-pages.txt")

# Refuse to replace existing pages when the new set is this much smaller
MAX_DROP_PERCENT=10

# ==============================================================================
# Helpers
# ==============================================================================

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Count the pages in sections $SECTIONS in a version directory, stored or aliased
page_count() {
  local dir="$1" count=0 s
  for s in $SECTIONS; do
    count=$((count + $(find "$dir" -maxdepth 1 \( -name "*.${s}*.txt" -o -name "*.${s}*.txt.gz" \) | wc -l)))
  done
  if [ -f "$dir/aliases.tsv" ]; then
    count=$((count + $(wc -l < "$dir/aliases.tsv") - 1))
  fi
  echo "$count"
}

# ==============================================================================
# Host prerequisites
# ==============================================================================

command -v podman >/dev/null 2>&1 || die "podman is required"
compgen -G "/etc/pki/entitlement/*-key.pem" >/dev/null \
  || die "this host has no RHEL entitlement; run on a registered RHEL host (subscription-manager status)"

WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/manpage-extract.XXXXXX")"

cleanup() {
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

# ==============================================================================
# Container extraction (runs inside the UBI container for one RHEL version)
# ==============================================================================

# shellcheck disable=SC2016
CONTAINER_SCRIPT='
set -euo pipefail
trap "echo \"ERROR: container step failed at line \$LINENO: \$BASH_COMMAND\" >&2" ERR
version="$1"; sections="$2"
arch="$(uname -m)"
repos=(--repo "rhel-${version}-for-${arch}-baseos-rpms" --repo "rhel-${version}-for-${arch}-appstream-rpms")

echo "    Installing tools"
dnf -q -y install man-db groff-base cpio findutils dnf-plugins-core >/dev/null

echo "    Finding packages with man pages in sections ${sections}"
for s in $sections; do
  dnf -q repoquery "${repos[@]}" --latest-limit 1 --arch "${arch},noarch" \
    --qf "%{name}" --file "/usr/share/man/man${s}/*" 2>/dev/null
done | sort -u > /work/packages.txt
echo "    $(wc -l < /work/packages.txt) packages"

echo "    Downloading packages"
mkdir -p /work/rpms
xargs -a /work/packages.txt -n 100 \
  dnf -q download "${repos[@]}" --arch "${arch},noarch" --destdir /work/rpms >/dev/null 2>&1 || true
echo "    $(find /work/rpms -name "*.rpm" | wc -l) RPMs downloaded"

echo "    Unpacking man pages"
patterns=()
for s in $sections; do patterns+=("./usr/share/man/man${s}/*"); done
mkdir -p /work/root
: > /work/sources.raw
# Sorted order makes the winner deterministic when two packages ship the same page
find /work/rpms -name "*.rpm" | sort | while read -r rpm; do
  (cd /work/root && rpm2cpio "$rpm" | cpio -idm --quiet "${patterns[@]}" 2>/dev/null) || true
  meta="$(rpm -qp --qf "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\t%{LICENSE}" "$rpm" 2>/dev/null || true)"
  { rpm -qlp "$rpm" 2>/dev/null || true; } | { grep -E "^/usr/share/man/man[0-9]/" || true; } | while read -r f; do
    printf "%s\t%s\n" "$(basename "$f")" "$meta"
  done >> /work/sources.raw
  rm -f "$rpm"
done

echo "    Rendering"
mkdir -p /work/out
cat > /work/render.sh <<"EOF"
#!/bin/bash
# Render each man page argument to /work/out/<page>.<section>.txt
for f in "$@"; do
  [ -e "$f" ] || continue                      # dangling symlink
  name="$(basename "$f")"; name="${name%.gz}"; name="${name%.xz}"; name="${name%.bz2}"
  out="/work/out/${name}.txt"
  LC_ALL=C MANWIDTH=120 man --nh --nj -l "$f" 2>/dev/null | col -bx > "$out" || true
  [ -s "$out" ] || rm -f "$out"
done
EOF
chmod +x /work/render.sh
cd /work/root/usr/share/man                    # .so includes resolve relative to here
dirs=(); for s in $sections; do [ -d "man${s}" ] && dirs+=("man${s}"); done
find "${dirs[@]}" \( -type f -o -type l \) -print0 | xargs -0 -r -P "$(nproc)" -n 50 /work/render.sh

# Map each rendered page to the package that shipped it (last package wins, as above)
awk -F "\t" -v OFS="\t" "{ n = \$1; sub(/\\.(gz|xz|bz2)\$/, \"\", n); src[n] = \$2; lic[n] = \$3 }
  END { for (n in src) print n, src[n], lic[n] }" /work/sources.raw > /work/sources.all
'

# ==============================================================================
# Per-version extraction, validation, and replacement
# ==============================================================================

extract_version() {
  local version="$1"
  local image="registry.access.redhat.com/ubi${version}/ubi:latest"
  local work="$WORK_ROOT/rhel${version}"
  local target="$MANPAGES_DIR/rhel${version}"
  local staging="$MANPAGES_DIR/.rhel${version}.new"

  echo "=== RHEL ${version} (${image}) ==="
  mkdir -p "$work"
  podman pull -q "$image" >/dev/null
  podman run --rm -v "$work:/work:Z" "$image" bash -c "$CONTAINER_SCRIPT" extract "$version" "$SECTIONS" \
    || die "RHEL ${version}: extraction in the container failed; ${target} unchanged"

  # Stage the rendered pages with their sources file
  rm -rf "$staging"
  mkdir -p "$staging"
  find "$work/out" -name '*.txt' -exec mv -t "$staging" {} +
  {
    printf 'page\tpackage\tlicense\n'
    while IFS=$'\t' read -r page pkg lic; do
      [ -f "$staging/${page}.txt" ] && printf '%s\t%s\t%s\n' "$page" "$pkg" "$lic"
    done < "$work/sources.all" | LC_ALL=C sort
  } > "$staging/sources.tsv"
  rm -rf "$work"

  # Store pages with identical content once; the others become aliases of the first by name
  local rendered
  rendered=$(find "$staging" -name '*.txt' | wc -l)
  {
    printf 'page\ttarget\n'
    (cd "$staging" && find . -maxdepth 1 -name '*.txt' -printf '%f\0' | xargs -0 -r sha256sum) \
      | LC_ALL=C sort \
      | awk '{ hash = $1; name = substr($0, 67); sub(/\.txt$/, "", name) }
             hash == prev { print name "\t" target; next }
             { prev = hash; target = name }' \
      | LC_ALL=C sort
  } > "$staging/aliases.tsv"
  tail -n +2 "$staging/aliases.tsv" | cut -f1 | while IFS= read -r page; do
    rm -f "$staging/${page}.txt"
  done
  find "$staging" -name '*.txt' -print0 | xargs -0 -r -P "$(nproc)" -n 200 gzip -9n

  # Validate before replacing anything
  local new_count old_count missing=()
  new_count=$(( $(page_count "$staging") ))
  old_count=0
  [ -d "$target" ] && old_count=$(page_count "$target")
  for page in "${REQUIRED_PAGES[@]}"; do
    [ -f "$staging/${page}.txt.gz" ] || cut -f1 "$staging/aliases.tsv" | grep -qxF "$page" \
      || missing+=("$page")
  done
  echo "    Rendered ${rendered} pages: $(find "$staging" -name '*.txt.gz' | wc -l) stored, $(( $(wc -l < "$staging/aliases.tsv") - 1 )) aliases (previously ${old_count} in sections ${SECTIONS})"

  if [ "${#missing[@]}" -gt 0 ]; then
    die "RHEL ${version}: required pages missing: ${missing[*]}; kept ${target} unchanged, staging left in ${staging}"
  fi
  if [ "$old_count" -gt 0 ] && [ $((new_count * 100)) -lt $((old_count * (100 - MAX_DROP_PERCENT))) ]; then
    die "RHEL ${version}: page count fell from ${old_count} to ${new_count}; kept ${target} unchanged, staging left in ${staging}"
  fi

  rm -rf "$target"
  mv "$staging" "$target"
  echo "    Replaced ${target}"
}

# ==============================================================================
# Main
# ==============================================================================

if [ $# -eq 0 ]; then
  set -- "${SUPPORTED_VERSIONS[@]}"
fi
for v in "$@"; do
  [[ " ${SUPPORTED_VERSIONS[*]} " == *" $v "* ]] \
    || die "unknown RHEL version: $v (supported: ${SUPPORTED_VERSIONS[*]})"
done
for v in "$@"; do
  extract_version "$v"
done

echo "=== Done ==="
