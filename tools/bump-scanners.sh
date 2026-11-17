#!/usr/bin/env bash
# Bumps the Trivy/Grype pins, Dockerfile digests and docs to the newest signed, settled releases.
set -euo pipefail

MIN_AGE_DAYS="${MIN_AGE_DAYS:-7}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PINS="$ROOT/packages/depinder-core/src/vuln/scanner-versions.ts"
DOCKERFILE="$ROOT/packages/depinder-server/Dockerfile"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for cmd in gh cosign jq docker; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd is required" >&2; exit 1; }
done

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# GET <api path> for a public repo; anonymous retry if the token is refused (e.g. an org IP allow list).
public_api() {
  local out
  if out="$(gh api "$1" 2>/dev/null)"; then printf '%s\n' "$out"; return; fi
  curl -fsSL --retry 3 -H 'Accept: application/vnd.github+json' "https://api.github.com/$1"
}

# Downloads <files...> of <owner/repo> release <tag> into <dir> over public HTTPS, no token needed.
fetch_assets() {
  local repo="$1" tag="$2" dir="$3" f; shift 3
  for f in "$@"; do curl -fsSL --retry 3 -o "$dir/$f" "https://github.com/$repo/releases/download/$tag/$f"; done
}

# Newest non-draft, non-prerelease tag of <owner/repo> published at least MIN_AGE_DAYS before the
# last daily 05:00 UTC (same cutoff as the depinder server), without the leading "v".
newest_settled() {
  local now day=86400 run=18000 cutoff   # run: 05:00 UTC
  now=$(date -u +%s)
  cutoff=$(( now - (now - run) % day - MIN_AGE_DAYS * day ))
  public_api "repos/$1/releases?per_page=30" | jq -r "
    [ .[] | select(.draft == false and .prerelease == false)
          | select((.published_at | fromdateiso8601) <= $cutoff) ][0].tag_name // empty" \
    | sed 's/^v//'
}

# Prints <candidate> if it is a plain x.y.z newer than <pinned>, else nothing.
newer() {
  local pinned="$1" candidate="$2"
  [[ "$candidate" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 0
  [ "$candidate" != "$pinned" ] || return 0
  [ "$(printf '%s\n%s\n' "$pinned" "$candidate" | sort -V | tail -1)" = "$candidate" ] && echo "$candidate"
  return 0
}

pinned() { sed -n "s/^ *$1: '\\([^']*\\)',\$/\\1/p" "$PINS"; }

# Verifies <tool> <version> from <repo> and prints the image's index digest (sha256:...).
#   <image>            publisher image, tag included (aquasec/trivy:0.76.2)
#   <path-in-image>    where the binary sits in it
#   <amd64-tarball> <arm64-tarball>   release assets holding the same binary at their root
verified_digest() {
  local repo="$1" tool="$2" version="$3" image="$4" inner="$5" amd64="$6" arm64="$7"
  local dir="$WORK/$tool" sums="${tool}_${version}_checksums.txt"
  mkdir -p "$dir"
  fetch_assets "$repo" "v$version" "$dir" "$sums" "$sums.sigstore.json" "$amd64" "$arm64"
  cosign verify-blob "$dir/$sums" \
    --bundle "$dir/$sums.sigstore.json" \
    --certificate-identity-regexp "^https://github\.com/${repo//./\\.}/\.github/workflows/" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com >&2

  local digest
  digest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' | jq -r .digest)"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "ERROR: no index digest for $image" >&2; exit 1; }

  local arch tarball expected cid
  for arch in amd64 arm64; do
    if [ "$arch" = amd64 ]; then tarball="$amd64"; else tarball="$arm64"; fi
    expected="$(awk -v a="$tarball" '$2 == a {print $1}' "$dir/$sums")"
    [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo "ERROR: $sums has no sha256 for $tarball" >&2; exit 1; }
    [ "$(sha256 "$dir/$tarball")" = "$expected" ] || { echo "ERROR: checksum mismatch for $tarball" >&2; exit 1; }
    mkdir -p "$dir/$arch"
    tar -xzf "$dir/$tarball" -C "$dir/$arch" "$tool"
    cid="$(docker create --platform "linux/$arch" "${image%%:*}@$digest" 2>/dev/null)"
    docker cp "$cid:$inner" "$dir/$arch/from-image" >/dev/null
    docker rm "$cid" >/dev/null
    if [ "$(sha256 "$dir/$arch/$tool")" != "$(sha256 "$dir/$arch/from-image")" ]; then
      echo "ERROR: $inner in $image (linux/$arch) differs from the signed release binary" >&2
      exit 1
    fi
    echo "$tool $version linux/$arch: image binary matches the signed release" >&2
  done
  echo "$digest"
}

trivy_old="$(pinned trivy)"; grype_old="$(pinned grype)"
[ -n "$trivy_old" ] && [ -n "$grype_old" ] || { echo "ERROR: cannot read pins from $PINS" >&2; exit 1; }
trivy_new="$(newer "$trivy_old" "$(newest_settled aquasecurity/trivy)")"
grype_new="$(newer "$grype_old" "$(newest_settled anchore/grype)")"

parts=()
if [ -n "$trivy_new" ]; then
  d="$(verified_digest aquasecurity/trivy trivy "$trivy_new" "aquasec/trivy:$trivy_new" /usr/local/bin/trivy \
        "trivy_${trivy_new}_Linux-64bit.tar.gz" "trivy_${trivy_new}_Linux-ARM64.tar.gz")"
  sed -i.bak -E "s|^FROM aquasec/trivy:[^ ]+ AS trivy\$|FROM aquasec/trivy:${trivy_new}@${d} AS trivy|" "$DOCKERFILE"
  sed -i.bak -E "s|^( *trivy: )'[^']*',\$|\\1'${trivy_new}',|" "$PINS"
  parts+=("Trivy $trivy_old → $trivy_new")
fi
if [ -n "$grype_new" ]; then
  d="$(verified_digest anchore/grype grype "$grype_new" "anchore/grype:v$grype_new" /grype \
        "grype_${grype_new}_linux_amd64.tar.gz" "grype_${grype_new}_linux_arm64.tar.gz")"
  sed -i.bak -E "s|^FROM anchore/grype:[^ ]+ AS grype\$|FROM anchore/grype:v${grype_new}@${d} AS grype|" "$DOCKERFILE"
  sed -i.bak -E "s|^( *grype: )'[^']*',\$|\\1'${grype_new}',|" "$PINS"
  parts+=("Grype $grype_old → $grype_new")
fi
rm -f "$DOCKERFILE.bak" "$PINS.bak"

# Keep the versions named in the docs in step with the pins.
if [ ${#parts[@]} -gt 0 ]; then
  t="$(pinned trivy)"; g="$(pinned grype)"
  sed -i.bak -E "s/Trivy [0-9]+\.[0-9]+\.[0-9]+ and Grype [0-9]+\.[0-9]+\.[0-9]+/Trivy $t and Grype $g/" "$ROOT/packages/depinder-server/docs/configuration.md"
  sed -i.bak -E "s/\"scanners\": \{\"trivy\": \"[0-9.]+\", \"grype\": \"[0-9.]+\"\}/\"scanners\": {\"trivy\": \"$t\", \"grype\": \"$g\"}/" "$ROOT/packages/depinder-server/docs/vuln-server.md"
  rm -f "$ROOT"/packages/depinder-server/docs/*.bak
fi

if [ ${#parts[@]} -eq 0 ]; then
  echo "Scanners already current (Trivy $trivy_old, Grype $grype_old; cooldown: ${MIN_AGE_DAYS} days before today's 05:00 UTC)"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "changed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# The pins must still agree with each other (the server test checks the same).
grep -q "^FROM aquasec/trivy:$(pinned trivy)@sha256:" "$DOCKERFILE" \
  && grep -q "^FROM anchore/grype:v$(pinned grype)@sha256:" "$DOCKERFILE" \
  || { echo "ERROR: Dockerfile and PINNED_SCANNER_VERSIONS disagree after the bump" >&2; exit 1; }

summary="$(printf '%s, ' "${parts[@]}")"; summary="${summary%, }"
echo "Bumped: $summary"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "changed=true"; echo "summary=$summary"; } >> "$GITHUB_OUTPUT"
fi
