import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.argv[2];
const setupNode =
  '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n';
const dmgSetup = '      - run: node scripts/dmg.mjs --setup\n';
const credentialStep = '      - name: Import the signing and notary credentials\n';
const secretsMap =
  '    secrets:\n      MACOS_CERTIFICATE_P12_BASE64: ${{ secrets.MACOS_CERTIFICATE_P12_BASE64 }}\n';
const mutations = {
  'build gets write': [
    'release.yml',
    'build calls it with contents: read',
    (t) =>
      t.replace(
        '    permissions:\n      contents: read\n    uses: ./.github',
        '    permissions:\n      contents: write\n    uses: ./.github',
      ),
  ],
  'build inherits every secret': [
    'release.yml',
    'only build reads secrets',
    (t) =>
      t.replace(/    secrets:\n(      \S+: \$\{\{ secrets\.\S+ \}\}\n)+/, '    secrets: inherit\n'),
  ],
  'build drops a secret': [
    'release.yml',
    'build passes exactly the five secrets by name',
    (t) => t.replace('      APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}\n\n', '\n'),
  ],
  'build passes a secret under another name': [
    'release.yml',
    'build passes exactly the five secrets by name',
    (t) =>
      t.replace(
        secretsMap,
        secretsMap.replace('${{ secrets.MACOS_CERTIFICATE_P12_BASE64', '${{ secrets.OTHER_P12'),
      ),
  ],
  'build packages the branch head': [
    'release.yml',
    'build passes the tag and the tagged commit',
    (t) => t.replace('      sha: ${{ needs.release-please.outputs.sha }}\n', ''),
  ],
  'build packages inline again': [
    'release.yml',
    'build calls package-macos.yml',
    (t) =>
      t.replace(
        '    uses: ./.github/workflows/package-macos.yml\n',
        '    uses: ./.github/workflows/other.yml\n',
      ),
  ],
  'upload reads secrets': [
    'release.yml',
    'only build reads secrets',
    (t) =>
      t.replace(
        '      GH_TOKEN: ${{ github.token }}\n',
        '      GH_TOKEN: ${{ secrets.APPLE_ID }}\n',
      ),
  ],
  'release-please loses issues write': [
    'release.yml',
    'release-please can label the release PR with issues: write',
    (t) => t.replace('      issues: write\n', ''),
  ],
  'release-pr loses issues write': [
    'release.yml',
    'release-pr can label the release PR with issues: write',
    (t) => t.replace(/(release-pr:[\s\S]*?)      issues: write\n/, '$1'),
  ],
  'release-please also opens the PR': [
    'release.yml',
    'release-please sets skip-github-pull-request: true',
    (t) => t.replace('          skip-github-pull-request: true\n', ''),
  ],
  'release-pr also creates releases': [
    'release.yml',
    'release-pr sets skip-github-release: true',
    (t) => t.replace('          skip-github-release: true\n', ''),
  ],
  'build waits for release-pr': [
    'release.yml',
    'build does not depend on release-pr',
    (t) =>
      t.replace(
        '  build:\n    needs: release-please',
        '  build:\n    needs: [release-please, release-pr]',
      ),
  ],
  'setup-vp returns': [
    'release-dry-run.yml',
    'no workflow uses setup-vp',
    (t) =>
      t.replace(
        setupNode,
        '      - uses: voidzero-dev/setup-vp@cab1ab9eaff52d4857875f4f2c016e36af8f2c76 # v1.22.0\n',
      ),
  ],
  'install not frozen': [
    'package-macos.yml',
    'keeps the lockfile frozen',
    (t) => t.replace('pnpm install --frozen-lockfile', 'pnpm install'),
  ],
  'action pinned to a tag': [
    'package-macos.yml',
    'is pinned to a SHA',
    (t) => t.replace(setupNode, '      - uses: actions/setup-node@v7\n'),
  ],
  'expression interpolated into run': [
    'package-macos.yml',
    'interpolates no expression into run',
    (t) => t.replace('--tag "${TAG}"', '--tag "${{ inputs.tag }}"'),
  ],
  'marker check removed': [
    'release.yml',
    'second run leaves the body unchanged',
    (t) => t.replace("if tr -d '\\r'", "if false && tr -d '\\r'"),
  ],
  'CRLF marker missed': [
    'release.yml',
    'a CRLF body that already carries the marker stays unchanged',
    (t) =>
      t.replace(
        `tr -d '\\r' < notes.md | grep -qxF -- "\${marker}"`,
        `grep -qxF -- "\${marker}" notes.md`,
      ),
  ],
  'marker matched anywhere': [
    'release.yml',
    'a marker inside a line keeps the notice',
    (t) => t.replace('grep -qxF', 'grep -qF'),
  ],
  'notice still names the zip': [
    'release.yml',
    'notice names the DMG',
    (t) => t.replace('mac-arm64.dmg\\` is signed', 'mac-arm64.zip\\` is signed'),
  ],
  'notice keeps the unzip steps': [
    'release.yml',
    'notice says to open the DMG, drag figma-drop to Applications, and eject',
    (t) =>
      t.replace(
        'Open it, drag \\`figma-drop\\` to Applications, and eject the disk image.',
        'Unzip it, move \\`figma-drop.app\\` to your Applications folder.',
      ),
  ],
  'checksums not rechecked': [
    'release.yml',
    'verify rejects a changed DMG',
    (t) => t.replace('          sha256sum -c SHA256SUMS.txt\n', ''),
  ],
  'extra files uploaded': [
    'release.yml',
    'verify rejects a file SHA256SUMS.txt does not list',
    (t) => t.replace('if [ "${present}" != "${listed}" ]', 'if false'),
  ],
  'dry run uploads': [
    'release-dry-run.yml',
    'dry run uploads no artifacts',
    (t) => t + '      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9\n',
  ],
  'dry run calls the signed workflow': [
    'release-dry-run.yml',
    'dry run never calls the signed package workflow',
    (t) => t + '  signed:\n    uses: ./.github/workflows/package-macos.yml\n',
  ],
  'dry run skips dmgbuild setup': [
    'release-dry-run.yml',
    'package installs dmgbuild before the dry run',
    (t) => t.replace(dmgSetup, ''),
  ],
  'dry run drops the refusal check': [
    'release-dry-run.yml',
    'dry run checks that release mode refuses the ad-hoc build',
    (t) =>
      t.replace('      - name: Release mode refuses the ad-hoc build\n', '      - name: Refusal\n'),
  ],
  'package loses the environment': [
    'package-macos.yml',
    'package reads secrets from the release environment',
    (t) => t.replace('    environment: release\n', ''),
  ],
  'package gets write': [
    'package-macos.yml',
    'package-macos grants no write',
    (t) =>
      t.replace(
        '    permissions:\n      contents: read\n    env:',
        '    permissions:\n      contents: write\n    env:',
      ),
  ],
  'dispatch publishes': [
    'package-macos.yml',
    'package-macos calls no gh release',
    (t) => t + '      - run: gh release upload "${TAG}" release-artifacts/*\n',
  ],
  'dispatch takes a tag input': [
    'package-macos.yml',
    'dispatch takes no inputs',
    (t) =>
      t.replace(
        '  workflow_dispatch:\n',
        '  workflow_dispatch:\n    inputs:\n      tag:\n        type: string\n',
      ),
  ],
  'package-macos runs on push': [
    'package-macos.yml',
    'package-macos runs only when called or dispatched',
    (t) => t.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n'),
  ],
  'callee secret optional': [
    'package-macos.yml',
    'package-macos requires the caller to pass each secret',
    (t) =>
      t.replace(
        '      APPLE_TEAM_ID:\n        required: true\n',
        '      APPLE_TEAM_ID:\n        required: false\n',
      ),
  ],
  'secrets for the whole job': [
    'package-macos.yml',
    'package hands no secret to the whole job',
    (t) =>
      t.replace(
        '      TAG: ${{ inputs.tag }}\n',
        '      TAG: ${{ inputs.tag }}\n      APPLE_ID: ${{ secrets.APPLE_ID }}\n',
      ),
  ],
  'packaging step sees a secret': [
    'package-macos.yml',
    'secrets only in the credential step env',
    (t) =>
      t.replace(
        '        run: node scripts/package-local.mjs\n',
        '        env:\n          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}\n        run: node scripts/package-local.mjs\n',
      ),
  ],
  'credential step drops a secret': [
    'package-macos.yml',
    'the credential step env holds exactly the five secrets',
    (t) =>
      t.replace(
        '          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}\n        run: bash',
        '        run: bash',
      ),
  ],
  'dmgbuild setup after the secrets': [
    'package-macos.yml',
    'dmgbuild setup precedes the credential step',
    (t) =>
      t
        .replace(dmgSetup, '')
        .replace('      - name: Sign, notarize', `${dmgSetup}      - name: Sign, notarize`),
  ],
  'tests run after the secrets': [
    'package-macos.yml',
    'pnpm test:release runs before the secrets',
    (t) =>
      t
        .replace('      - run: pnpm test:release\n', '')
        .replace(
          '      - name: Sign, notarize',
          '      - run: pnpm test:release\n      - name: Sign, notarize',
        ),
  ],
  'build runs after the secrets': [
    'package-macos.yml',
    'the build runs before the secrets',
    (t) =>
      t
        .replace('      - run: pnpm build\n', '')
        .replace(
          '      - name: Sign, notarize',
          '      - run: pnpm build\n      - name: Sign, notarize',
        ),
  ],
  'cleanup only on success': [
    'package-macos.yml',
    'package deletes the keychain after a failure too',
    (t) =>
      t.replace(
        '        if: always()\n        run: bash scripts/ci-import-signing.sh --cleanup',
        '        run: bash scripts/ci-import-signing.sh --cleanup',
      ),
  ],
  'cleanup before packaging': [
    'package-macos.yml',
    'cleanup runs after packaging',
    (t) =>
      t
        .replace(
          credentialStep,
          '      - name: Early cleanup\n        if: always()\n        run: bash scripts/ci-import-signing.sh --cleanup\n' +
            credentialStep,
        )
        .replace(
          '      - name: Delete the signing keychain\n        if: always()\n        run: bash scripts/ci-import-signing.sh --cleanup\n',
          '',
        ),
  ],
  'checkout ignores the tagged commit': [
    'package-macos.yml',
    'package checks out the given commit',
    (t) => t.replace('          ref: ${{ inputs.sha }}\n', ''),
  ],
  'tag packaged as a dry run': [
    'package-macos.yml',
    'a tag runs release mode',
    (t) => t.replace('if [ -n "${TAG}" ]; then', 'if false; then'),
  ],
  'release artifact carries notary logs': [
    'package-macos.yml',
    'release artifact holds exactly the DMG, plugin zip, and SHA256SUMS.txt',
    (t) =>
      t.replace(
        '            release-artifacts/SHA256SUMS.txt\n',
        '            release-artifacts/SHA256SUMS.txt\n            release-artifacts/notary/\n',
      ),
  ],
  'release artifact takes every file': [
    'package-macos.yml',
    'release artifact holds exactly the DMG, plugin zip, and SHA256SUMS.txt',
    (t) =>
      t.replace(
        '            release-artifacts/figma-drop-${{ steps.version.outputs.version }}-mac-arm64.dmg\n',
        '            release-artifacts/*\n',
      ),
  ],
  'package test artifact kept long': [
    'package-macos.yml',
    'the package test artifact expires within 3 days',
    (t) => t.replace('          retention-days: 3\n', '          retention-days: 30\n'),
  ],
  'package test artifact on a tag': [
    'package-macos.yml',
    'the package test artifact is for dispatch only',
    (t) => t.replace("      - if: inputs.tag == ''\n", '      - if: always()\n'),
  ],
};
let missed = 0;
for (const [label, [file, expected, mutate]] of Object.entries(mutations)) {
  const dir = mkdtempSync(join(tmpdir(), 'mut-'));
  cpSync(join(repo, '.github'), join(dir, '.github'), { recursive: true });
  const path = join(dir, '.github/workflows', file);
  const before = readFileSync(path, 'utf8');
  const after = mutate(before);
  if (after === before) throw new Error(`${label} did not apply`);
  writeFileSync(path, after);
  const r = spawnSync('node', [new URL('check-workflows.mjs', import.meta.url).pathname, dir], {
    encoding: 'utf8',
  });
  const caught = r.status !== 0 && r.stderr.includes(expected);
  if (!caught) missed += 1;
  console.log(
    `${label}: exit ${r.status} ${caught ? 'caught by' : 'NOT CAUGHT, expected'} "${expected}"`,
  );
}
process.exit(missed === 0 ? 0 : 1);
