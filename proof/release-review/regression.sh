#!/bin/bash
# Seeds the A5, A6, and A9 defects into copies of the built app and shows that
# scripts/release-package.mjs rejects each one. Run it from the repository root on an Apple
# silicon Mac after `pnpm app:local`. It replaces the local release-artifacts/ folder.
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
cd "${repo}"
app="${repo}/apps/desktop/release/figma-drop.app"
version="$(node -p 'require("./package.json").version')"
[ -d "${app}" ] || { echo "Missing ${app}. Run pnpm app:local first." >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf -- "${work:?}"' EXIT
missed=0

verify() {
  # shellcheck disable=SC2016
  node --input-type=module -e '
    const [kind, zip, version, buildDir] = process.argv.slice(1);
    const pkg = await import(`${process.cwd()}/scripts/release-package.mjs`);
    try {
      if (kind === "desktop") pkg.verifyDesktop(zip, version, buildDir);
      else pkg.verifyPlugin(zip);
      console.log("PASS");
    } catch (error) {
      console.log(`FAIL ${error.message.split("\n")[0]}`);
    }' "$@"
}

report() {
  local label="$1" expected="$2" actual="$3"
  local verdict=caught
  actual="${actual:0:240}"
  if [[ "${actual}" != *"${expected}"* ]]; then
    verdict='NOT CAUGHT'
    missed=$((missed + 1))
  fi
  printf '%s\n  expected: %s\n  actual:   %s\n  %s\n' "${label}" "${expected}" "${actual}" "${verdict}"
}

release_zip() {
  ditto -c -k --norsrc --noextattr --noacl --keepParent "$1" "$2"
}

copy_app() {
  mkdir -p "$1"
  ditto "${app}" "$1/figma-drop.app"
  echo "$1/figma-drop.app"
}

copy_builds() {
  mkdir -p "$1"
  cp -R apps/desktop/dist apps/desktop/dist-electron "$1/"
}

control="$(copy_app "${work}/control")"
release_zip "${control}" "${work}/control.zip"
copy_builds "${work}/control-builds"
report 'control: an unmodified copy' 'PASS' \
  "$(verify desktop "${work}/control.zip" "${version}" "${work}/control-builds")"

for file in dist-electron/main.cjs dist/renderer/index.html; do
  name="$(basename "${file}")"
  copied="$(copy_app "${work}/no-${name}")"
  rm -- "${copied:?}/Contents/Resources/app/${file}"
  # Re-signed like scripts/package-local.mjs, so only the new checks can catch it.
  codesign --force --deep --sign - "${copied}" 2>/dev/null
  copy_builds "${work}/no-${name}-builds"
  rm -- "${work:?}/no-${name}-builds/${file}"
  release_zip "${copied}" "${work}/no-${name}.zip"
  case "${file}" in
    dist-electron/main.cjs) expected='Contents/Resources/app/package.json main exists failed' ;;
    *) expected='Contents/Resources/app/dist/renderer/index.html exists failed' ;;
  esac
  report "A5: app zip without ${file}" "${expected}" \
    "$(verify desktop "${work}/no-${name}.zip" "${version}" "${work}/no-${name}-builds")"
done

stale_builds="${work}/stale-builds"
copy_builds "${stale_builds}"
echo '// newer build' >> "${stale_builds}/dist-electron/main.cjs"
report 'A5: app zip older than apps/desktop/dist-electron' \
  'Contents/Resources/app/dist-electron is byte-identical to apps/desktop/dist-electron failed' \
  "$(verify desktop "${work}/control.zip" "${version}" "${stale_builds}")"

for variant in sequestered inline; do
  zip="${work}/appledouble-${variant}.zip"
  if [ "${variant}" = sequestered ]; then
    ditto -c -k --sequesterRsrc --keepParent "${control}" "${zip}"
  else
    ditto -c -k --keepParent "${control}" "${zip}"
  fi
  report "A6: app zip with $(zipinfo -1 "${zip}" | grep -cE '(^|/)\._') ${variant} ._ entries" \
    'zip holds no AppleDouble or Finder metadata entries failed' \
    "$(verify desktop "${zip}" "${version}" "${work}/control-builds")"
done

plugin="${work}/plugin/figma-drop-figma-plugin"
mkdir -p "${plugin}/dist"
cp apps/figma-plugin/manifest.json "${plugin}/"
cp apps/figma-plugin/dist/code.js apps/figma-plugin/dist/ui.html "${plugin}/dist/"
xattr -w com.figma-drop.regression 1 "${plugin}/manifest.json"
ditto -c -k --sequesterRsrc --keepParent "${plugin}" "${work}/appledouble-plugin.zip"
report 'A6: plugin zip with ._ entries' 'zip holds no AppleDouble or Finder metadata entries failed' \
  "$(verify plugin "${work}/appledouble-plugin.zip")"

rm -rf -- "${repo:?}/release-artifacts" "${repo:?}/release-artifacts.staging"
set -m
node scripts/release-package.mjs --dry-run > "${work}/interrupted.log" 2>&1 &
pid=$!
set +m
for _ in $(seq 1200); do
  if compgen -G 'release-artifacts/*.zip' > /dev/null || compgen -G 'release-artifacts.staging/*.zip' > /dev/null; then
    break
  fi
  sleep 0.1
done
kill -INT -- "-${pid}"
status=0
wait "${pid}" || status=$?
left="$(compgen -G 'release-artifacts/*.zip' || true)"
staged="$(compgen -G 'release-artifacts.staging/*.zip' || echo none)"
report "A9: SIGINT while the zip is written (exit ${status}, partial zip: $(basename "${staged}"))" 'no zip in release-artifacts/' \
  "${left:-no zip in release-artifacts/}"

if [ "${missed}" -ne 0 ]; then
  echo "${missed} case(s) not caught."
  exit 1
fi
echo 'Every seeded defect was caught.'
