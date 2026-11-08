#!/usr/bin/env bash
# Prints the raw signing, notarization, and integrity evidence for a figma-drop DMG and the app
# inside it. It reports and does not judge: release-package.mjs owns the pass/fail checks, and an
# ad-hoc DMG is expected to fail the Gatekeeper and stapler lines.
#
#   bash scripts/dmg-evidence.sh <path/to/figma-drop.dmg>
set -uo pipefail

dmg="${1:?Usage: dmg-evidence.sh <path/to/figma-drop.dmg>}"
[ -f "${dmg}" ] || { echo "No file at ${dmg}." >&2; exit 1; }

show() {
  printf '\n$ %s\n' "$*"
  "$@" 2>&1
  printf '[exit %s]\n' "$?"
}

show sw_vers
show shasum -a 256 "${dmg}"
show hdiutil imageinfo -format "${dmg}"
show hdiutil verify "${dmg}"
show codesign -dv --verbose=4 "${dmg}"
show codesign --verify --strict --verbose=2 "${dmg}"
show xcrun stapler validate "${dmg}"
show spctl -a -t open --context context:primary-signature -vvv "${dmg}"

dir="$(mktemp -d "${TMPDIR:-/tmp}/figma-drop-evidence.XXXXXX")"
volume="${dir}/volume"
detach() {
  if [ -d "${volume}" ] && [ "$(stat -f %d "${volume}")" != "$(stat -f %d "${dir}")" ]; then
    hdiutil detach "${volume}" > /dev/null 2>&1 || hdiutil detach -force "${volume}" > /dev/null 2>&1
  fi
  rmdir "${volume}" "${dir}" 2> /dev/null
}
trap detach EXIT
printf '\n$ hdiutil attach -readonly -nobrowse -noautoopen -mountpoint <tmp>/volume %s\n' "${dmg}"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "${volume}" "${dmg}" > /dev/null ||
  { echo "Could not attach ${dmg}." >&2; exit 1; }
echo '[exit 0]'

app="${volume}/figma-drop.app"
show ls -la "${volume}"
show readlink "${volume}/Applications"
show codesign -dv --verbose=4 "${app}"
show codesign --verify --deep --strict --verbose=2 "${app}"
show xcrun stapler validate "${app}"
show spctl -a -t exec -vvv "${app}"
for code in "${app}" "${app}"/Contents/Frameworks/*.app; do
  show codesign -d --entitlements - --xml "${code}"
  echo
done
