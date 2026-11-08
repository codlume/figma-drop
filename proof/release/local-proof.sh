#!/bin/bash
set -uo pipefail
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "${repo}" || exit 1
out="${repo}/proof/release/local-proof.txt"
version="$(node -p 'require("./package.json").version')"
scratch="$(cd "$(mktemp -d)" && pwd -P)"
partial="$(mktemp)"
trap 'rm -rf -- "${scratch:?}" "${partial:?}"' EXIT
dry="release-artifacts/figma-drop-${version}-mac-arm64-unsigned-dry-run.zip"
dry_plugin="release-artifacts/figma-drop-figma-plugin-${version}-dry-run.zip"
sanitize() {
  REPO="${repo}" SCRATCH="${scratch}" SCRATCH_LINK="${scratch#/private}" USER_NAME="$(id -un)" \
    perl -pe 's/\Q$ENV{REPO}\E/<repo>/g; s/\Q$ENV{SCRATCH}\E/<scratch>/g;
      s/\Q$ENV{SCRATCH_LINK}\E/<scratch>/g; s/\Q$ENV{HOME}\E/~/g; s/\b\Q$ENV{USER_NAME}\E\b/<user>/g'
}
step() {
  { printf '$ '; printf '%q ' "$@"; echo; } | sanitize
  "$@" 2>&1 | sanitize
  echo "exit=${PIPESTATUS[0]}"
  echo
}
{
  echo "head $(git rev-parse HEAD), node $(node --version), pnpm $(pnpm --version), $(sw_vers -productName) $(sw_vers -productVersion) $(uname -m)"
  echo
  step pnpm test:release
  step node scripts/release-package.mjs
  step node scripts/release-package.mjs --dry-run --tag "v${version}"
  step node scripts/release-package.mjs --tag v9.9.9
  step pnpm release:dry-run
  step ls -l release-artifacts
  step cat release-artifacts/release-plan.json
  step bash -c 'cd release-artifacts && shasum -a 256 -c SHA256SUMS-dry-run.txt'
  step zipinfo -1 "${dry_plugin}"
  step bash -c "zipinfo -1 ${dry} | cut -d/ -f1-3 | sort -u"
  step ditto -x -k "${dry_plugin}" "${scratch}/plugin"
  step cmp "${scratch}/plugin/figma-drop-figma-plugin/manifest.json" apps/figma-plugin/manifest.json
  step ditto -x -k "${dry}" "${scratch}/desktop"
  step plutil -p "${scratch}/desktop/figma-drop.app/Contents/Info.plist"
  step codesign -dv "${scratch}/desktop/figma-drop.app"
  step codesign --verify --deep --strict --verbose=2 "${scratch}/desktop/figma-drop.app"
  step xattr -w com.apple.quarantine '0081;00000000;Safari;' "${scratch}/desktop/figma-drop.app"
  step spctl --assess --type execute -vv "${scratch}/desktop/figma-drop.app"
  step node scripts/release-package.mjs --tag "v${version}"
  step ls -l release-artifacts
  step bash -c 'cd release-artifacts && shasum -a 256 -c SHA256SUMS.txt'
} > "${partial}"
chmod 644 "${partial}"
mv -- "${partial}" "${out}"
echo "Wrote ${out}"
