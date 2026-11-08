#!/bin/bash
set -uo pipefail
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "${repo}" || exit 1
out="${repo}/proof/release/local-proof.txt"
scratch="$(cd "$(mktemp -d)" && pwd -P)"
sanitize() {
  sed -e "s#${repo}#<repo>#g" -e "s#${scratch}#<scratch>#g" -e "s#${scratch#/private}#<scratch>#g" \
    -e "s#${HOME}#~#g" -e "s#$(id -un)#<user>#g"
}
step() {
  echo "\$ $*" | sanitize
  "$@" 2>&1 | sanitize
  echo "exit=${PIPESTATUS[0]}"
  echo
}
{
  echo "head $(git rev-parse HEAD), node $(node --version), pnpm $(pnpm --version), $(sw_vers -productName) $(sw_vers -productVersion) $(uname -m)"
  echo
  step pnpm test:release
  step node scripts/release-package.mjs
  step node scripts/release-package.mjs --dry-run --tag v0.0.0
  step node scripts/release-package.mjs --tag v9.9.9
  step pnpm release:dry-run
  step ls -l release-artifacts
  step cat release-artifacts/release-plan.json
  step bash -c 'cd release-artifacts && shasum -a 256 -c SHA256SUMS-dry-run.txt'
  step zipinfo -1 release-artifacts/figma-drop-figma-plugin-0.0.0-dry-run.zip
  step bash -c 'zipinfo -1 release-artifacts/figma-drop-0.0.0-mac-arm64-unsigned-dry-run.zip | grep -v "^__MACOSX/" | cut -d/ -f1-3 | sort -u'
  step ditto -x -k release-artifacts/figma-drop-figma-plugin-0.0.0-dry-run.zip "${scratch}/plugin"
  step cmp "${scratch}/plugin/figma-drop-figma-plugin/manifest.json" apps/figma-plugin/manifest.json
  step ditto -x -k release-artifacts/figma-drop-0.0.0-mac-arm64-unsigned-dry-run.zip "${scratch}/desktop"
  step plutil -p "${scratch}/desktop/figma-drop.app/Contents/Info.plist"
  step codesign -dv "${scratch}/desktop/figma-drop.app"
  step codesign --verify --deep --strict --verbose=2 "${scratch}/desktop/figma-drop.app"
  step xattr -w com.apple.quarantine '0081;00000000;Safari;' "${scratch}/desktop/figma-drop.app"
  step spctl --assess --type execute -vv "${scratch}/desktop/figma-drop.app"
} > "${out}"
rm -rf "${scratch:?}"
echo "Wrote ${out}"
