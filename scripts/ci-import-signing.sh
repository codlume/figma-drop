#!/usr/bin/env bash
# CI only. Imports the Developer ID certificate and the notary credentials from the `release`
# environment secrets into a throwaway keychain in $RUNNER_TEMP, then hands the packaging scripts
# FIGMA_DROP_SIGN_IDENTITY, FIGMA_DROP_NOTARY_PROFILE, and FIGMA_DROP_NOTARY_KEYCHAIN through
# $GITHUB_ENV. The scripts never see an Apple password.
#
#   bash scripts/ci-import-signing.sh            import
#   bash scripts/ci-import-signing.sh --cleanup  delete the keychain, which takes it off the search list
#
# Messages name secrets and never print their values. Keep it that way.
set -euo pipefail
set +x
umask 077

readonly SECRETS=(
  MACOS_CERTIFICATE_P12_BASE64
  MACOS_CERTIFICATE_PASSWORD
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
)
readonly PROFILE=figma-drop-notary

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[ -n "${RUNNER_TEMP:-}" ] || fail "RUNNER_TEMP is not set. This script runs only in GitHub Actions."
readonly keychain="${RUNNER_TEMP}/figma-drop-signing.keychain-db"
readonly certificate="${RUNNER_TEMP}/figma-drop-signing.p12"

# `delete-keychain` also removes the keychain from the search list, so cleanup is one call.
# Idempotent, and safe when nothing was created.
cleanup() {
  rm -f "${certificate}"
  if [ -e "${keychain}" ]; then
    security delete-keychain "${keychain}"
  fi
}

if [ "${1:-}" = "--cleanup" ]; then
  cleanup
  echo "Removed the signing keychain, if any."
  exit 0
fi
[ $# -eq 0 ] || fail "Usage: ci-import-signing.sh [--cleanup]"

[ -n "${GITHUB_ENV:-}" ] || fail "GITHUB_ENV is not set. This script runs only in GitHub Actions."
missing=()
for name in "${SECRETS[@]}"; do
  [ -n "${!name:-}" ] || missing+=("${name}")
done
if [ ${#missing[@]} -gt 0 ]; then
  fail "These secrets of the release environment are missing or empty: ${missing[*]}."
fi
[[ "${APPLE_TEAM_ID}" =~ ^[A-Z0-9]{10}$ ]] ||
  fail "APPLE_TEAM_ID must be the 10-character team ID, uppercase letters and digits."
p12_base64="$(printf '%s' "${MACOS_CERTIFICATE_P12_BASE64}" | tr -d ' \t\r\n')"
# macOS `base64 --decode` exits 0 on malformed input, so the shape is checked first.
[[ "${p12_base64}" =~ ^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$ ]] ||
  fail "MACOS_CERTIFICATE_P12_BASE64 is not valid base64."

cleanup
on_exit() {
  local status=$?
  rm -f "${certificate}"
  if [ "${status}" -ne 0 ]; then cleanup; fi
}
trap on_exit EXIT

printf '%s' "${p12_base64}" | base64 --decode > "${certificate}" ||
  fail "MACOS_CERTIFICATE_P12_BASE64 does not decode."
[ -s "${certificate}" ] || fail "MACOS_CERTIFICATE_P12_BASE64 decodes to nothing."

keychain_password="$(openssl rand -base64 32)"
security create-keychain -p "${keychain_password}" "${keychain}"
# Two notarizations can take a while, so the keychain stays unlocked for the whole job.
security set-keychain-settings -lut 21600 "${keychain}"
security unlock-keychain -p "${keychain_password}" "${keychain}"

security import "${certificate}" -k "${keychain}" -f pkcs12 \
  -P "${MACOS_CERTIFICATE_PASSWORD}" -T /usr/bin/codesign > /dev/null ||
  fail "The certificate did not import. Check MACOS_CERTIFICATE_P12_BASE64 and MACOS_CERTIFICATE_PASSWORD."
rm -f "${certificate}"
security set-key-partition-list -S apple-tool:,apple: -s -k "${keychain_password}" "${keychain}" > /dev/null
# Trust evaluation and codesign resolve the certificate chain through the search list, so the
# keychain joins it before the identity check, as in the v0.1.1 release run. On any failure the
# EXIT trap deletes the keychain, which takes it off the list again.
search_list=("${keychain}")
while IFS= read -r line; do
  [ -n "${line}" ] && search_list+=("${line}")
done <<SEARCH_LIST
$(security list-keychains -d user | sed -E 's/^[[:space:]]*"(.*)"[[:space:]]*$/\1/')
SEARCH_LIST
security list-keychains -d user -s "${search_list[@]}"

identities=()
while IFS= read -r hash; do
  [ -n "${hash}" ] && identities+=("${hash}")
done <<IDENTITIES
$(security find-identity -v -p codesigning "${keychain}" |
  sed -nE "s/^ *[0-9]+\) ([0-9A-F]{40}) \"Developer ID Application: .* \(${APPLE_TEAM_ID}\)\"$/\1/p")
IDENTITIES
case ${#identities[@]} in
  0) fail "The keychain holds no valid Developer ID Application identity for APPLE_TEAM_ID. Check MACOS_CERTIFICATE_P12_BASE64 and APPLE_TEAM_ID." ;;
  1) ;;
  *) fail "MACOS_CERTIFICATE_P12_BASE64 holds ${#identities[@]} valid Developer ID Application identities for APPLE_TEAM_ID. Export a .p12 that holds exactly one." ;;
esac

# notarytool validates the credentials with Apple before it stores them. Its output is dropped
# because it could repeat the Apple ID.
xcrun notarytool store-credentials "${PROFILE}" \
  --apple-id "${APPLE_ID}" \
  --team-id "${APPLE_TEAM_ID}" \
  --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
  --keychain "${keychain}" \
  --validate < /dev/null > /dev/null 2>&1 ||
  fail "Apple did not accept the notary credentials. Check APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID."

{
  printf 'FIGMA_DROP_SIGN_IDENTITY=%s\n' "${identities[0]}"
  printf 'FIGMA_DROP_NOTARY_PROFILE=%s\n' "${PROFILE}"
  printf 'FIGMA_DROP_NOTARY_KEYCHAIN=%s\n' "${keychain}"
} >> "${GITHUB_ENV}"
echo "Imported one Developer ID Application identity and stored the notary profile ${PROFILE}."
