#!/usr/bin/env bash
# Bumps the Trivy/Grype pins, Dockerfile digests and docs to the newest signed, settled releases;
# earlier when a release fixes a vulnerability of the pinned one. Needs trivy to compare them.
set -euo pipefail

MIN_AGE_DAYS="${MIN_AGE_DAYS:-7}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PINS="$ROOT/packages/depinder-core/src/vuln/scanner-versions.ts"
DOCKERFILE="$ROOT/packages/depinder-server/Dockerfile"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for cmd in gh cosign jq docker trivy; do
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

# Newest non-draft, non-prerelease tag of <owner/repo> published at or before <epoch>, without the "v".
newest_before() {
  public_api "repos/$1/releases?per_page=30" | jq -r "
    [ .[] | select(.draft == false and .prerelease == false)
          | select((.published_at | fromdateiso8601) <= $2) ][0].tag_name // empty" \
    | sed 's/^v//'
}

# Cooldown cutoff: MIN_AGE_DAYS before the last daily 05:00 UTC (same as the depinder server).
NOW=$(date -u +%s)
CUTOFF=$(( NOW - (NOW - 18000) % 86400 - MIN_AGE_DAYS * 86400 ))

# Downloads <tool> <version>'s checksums file into <dir> and verifies its Sigstore bundle.
verify_sums() {
  local repo="$1" tool="$2" version="$3" dir="$4" sums="${2}_${3}_checksums.txt"
  mkdir -p "$dir"
  fetch_assets "$repo" "v$version" "$dir" "$sums" "$sums.sigstore.json"
  cosign verify-blob "$dir/$sums" \
    --bundle "$dir/$sums.sigstore.json" \
    --certificate-identity-regexp "^https://github\.com/${repo//./\\.}/\.github/workflows/" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com >&2
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
  verify_sums "$repo" "$tool" "$version" "$dir"
  fetch_assets "$repo" "v$version" "$dir" "$amd64" "$arm64"

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

# Trivy findings ("<id> <package> <severity>", sorted) of <tool>'s linux/amd64 binary of <version>:
# the pinned one from the image digest in the Dockerfile, a newer one from its signed release.
#   <asset> release asset holding the binary at its root, "@" standing for the version
#   <inner> where the binary sits in the publisher's image
findings() {
  local repo="$1" tool="$2" version="$3" asset="${4//@/$3}" inner="$5" kind="$6"
  local out="$WORK/scan/$tool-$version"
  if [ ! -f "$out" ]; then
    local dir="$WORK/scan/$tool-$version.d" expected ref cid
    mkdir -p "$dir/bin"
    if [ "$kind" = pinned ]; then
      ref="$(sed -n "s/^FROM \([^ ]*\) AS $tool\$/\1/p" "$DOCKERFILE")"
      [[ "$ref" == *"@sha256:"* ]] || { echo "ERROR: no pinned $tool image in $DOCKERFILE" >&2; exit 1; }
      docker pull -q --platform linux/amd64 "$ref" >/dev/null
      cid="$(docker create --platform linux/amd64 "$ref")"
      docker cp "$cid:$inner" "$dir/bin/$tool" >/dev/null
      docker rm "$cid" >/dev/null
    else
      verify_sums "$repo" "$tool" "$version" "$dir"
      fetch_assets "$repo" "v$version" "$dir" "$asset"
      expected="$(awk -v a="$asset" '$2 == a {print $1}' "$dir/${tool}_${version}_checksums.txt")"
      [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo "ERROR: no sha256 for $asset" >&2; exit 1; }
      [ "$(sha256 "$dir/$asset")" = "$expected" ] || { echo "ERROR: checksum mismatch for $asset" >&2; exit 1; }
      tar -xzf "$dir/$asset" -C "$dir/bin" "$tool"
    fi
    trivy rootfs --quiet --scanners vuln --format json "$dir/bin" > "$dir/scan.json"
    jq -r '.Results[]?.Vulnerabilities[]? | "\(.VulnerabilityID) \(.PkgName) \(.Severity)"' "$dir/scan.json" \
      | LC_ALL=C sort -u > "$out"
  fi
  cat "$out"
}

ids() { awk '{print $1" "$2}' | LC_ALL=C sort -u; }

# HIGH/CRITICAL findings in scan/new that scan/old does not have.
new_high() {
  LC_ALL=C comm -13 <(ids < "$WORK/scan/old") \
    <(awk '$3 == "HIGH" || $3 == "CRITICAL"' "$WORK/scan/new" | ids)
}

# Picks <tool>'s next version into PICK, with PICK_NOTE (why) and PICK_BLOCK (new HIGH/CRITICAL).
# The newest release is taken before the cooldown when it fixes a finding of the pinned one and
# adds no HIGH/CRITICAL; otherwise the newest settled one, blocked if it adds a HIGH/CRITICAL.
pick() {
  local repo="$1" tool="$2" pinned="$3" asset="$4" inner="$5" fresh settled fixed
  PICK=""; PICK_NOTE=""; PICK_BLOCK=""
  fresh="$(newer "$pinned" "$(newest_before "$repo" "$NOW")")"
  settled="$(newer "$pinned" "$(newest_before "$repo" "$CUTOFF")")"
  [ -n "$fresh" ] || return 0
  findings "$repo" "$tool" "$pinned" "$asset" "$inner" pinned > "$WORK/scan/old"
  if [ "$fresh" != "$settled" ]; then
    findings "$repo" "$tool" "$fresh" "$asset" "$inner" candidate > "$WORK/scan/new"
    fixed="$(LC_ALL=C comm -23 <(ids < "$WORK/scan/old") <(ids < "$WORK/scan/new") | awk '{print $1}' | LC_ALL=C sort -u \
      | awk 'NR <= 8 {l = l (NR > 1 ? ", " : "") $0} END {if (NR > 8) l = l " and " NR - 8 " more"; print l}')"
    if [ -n "$fixed" ] && [ -z "$(new_high)" ]; then
      PICK="$fresh"; PICK_NOTE="$tool $fresh taken before the ${MIN_AGE_DAYS}-day cooldown: it fixes $fixed."
      return 0
    fi
  fi
  [ -n "$settled" ] || return 0
  findings "$repo" "$tool" "$settled" "$asset" "$inner" candidate > "$WORK/scan/new"
  PICK="$settled"
  PICK_BLOCK="$(new_high | sed "s/^/$tool $settled: /")"
}

mkdir -p "$WORK/scan"
trivy_old="$(pinned trivy)"; grype_old="$(pinned grype)"
[ -n "$trivy_old" ] && [ -n "$grype_old" ] || { echo "ERROR: cannot read pins from $PINS" >&2; exit 1; }
notes=(); blocks=()
pick aquasecurity/trivy trivy "$trivy_old" "trivy_@_Linux-64bit.tar.gz" /usr/local/bin/trivy
trivy_new="$PICK"; [ -n "$PICK_NOTE" ] && notes+=("$PICK_NOTE"); [ -n "$PICK_BLOCK" ] && blocks+=("$PICK_BLOCK")
pick anchore/grype grype "$grype_old" "grype_@_linux_amd64.tar.gz" /grype
grype_new="$PICK"; [ -n "$PICK_NOTE" ] && notes+=("$PICK_NOTE"); [ -n "$PICK_BLOCK" ] && blocks+=("$PICK_BLOCK")

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
[ ${#notes[@]} -eq 0 ] || printf '%s\n' "${notes[@]}"
[ ${#blocks[@]} -eq 0 ] || { echo "Blocked, new HIGH/CRITICAL:"; printf '%s\n' "${blocks[@]}"; }
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "changed=true"; echo "summary=$summary"
    if [ ${#blocks[@]} -gt 0 ]; then echo "blocked=true"; else echo "blocked=false"; fi
    echo "notes<<NOTES_EOF"
    [ ${#notes[@]} -eq 0 ] || printf -- '- %s\n' "${notes[@]}"
    [ ${#blocks[@]} -eq 0 ] || { echo "- **Not merged automatically:** new HIGH/CRITICAL findings the pinned version does not have:"; printf '%s\n' "${blocks[@]}" | sed 's/^/  - /'; }
    echo "NOTES_EOF"
  } >> "$GITHUB_OUTPUT"
fi
