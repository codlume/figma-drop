import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateNotaryLog } from './notary.mjs';

// The shape `xcrun notarytool log` writes, per Apple's "Customizing the notarization workflow".
const log = (status, issues) => ({
  logFormatVersion: 1,
  jobId: '2efe2717-52ef-43a5-96dc-0797e4ca1041',
  status,
  statusSummary:
    status === 'Accepted'
      ? 'Ready for distribution'
      : 'Archive contains critical validation errors',
  archiveFilename: 'figma-drop-1.2.3-mac-arm64.dmg',
  uploadDate: '2026-11-08T18:00:00Z',
  sha256: 'c'.repeat(64),
  ticketContents: null,
  issues,
});
const issue = (severity, message) => ({
  severity,
  code: null,
  path: 'figma-drop-1.2.3-mac-arm64.dmg/figma-drop.app/Contents/MacOS/figma-drop',
  message,
  docUrl: 'https://developer.apple.com/documentation/security/resolving-common-notarization-issues',
  architecture: 'arm64',
});

test('an Accepted log with no issues passes and reports its submission', () => {
  for (const issues of [null, [], undefined]) {
    assert.deepEqual(evaluateNotaryLog(log('Accepted', issues)), {
      id: '2efe2717-52ef-43a5-96dc-0797e4ca1041',
      status: 'Accepted',
      warnings: [],
    });
  }
});

test('an Accepted log with an error issue fails and quotes the issue', () => {
  assert.throws(
    () => evaluateNotaryLog(log('Accepted', [issue('error', 'The binary is not signed.')])),
    /status Accepted and 1 error issue\(s\)\.\nerror: .*figma-drop: The binary is not signed\./,
  );
});

test('an Invalid log fails, with or without issues', () => {
  assert.throws(() => evaluateNotaryLog(log('Invalid', null)), /has status Invalid/);
  assert.throws(
    () => evaluateNotaryLog(log('Invalid', [issue('error', 'The signature is invalid.')])),
    /has status Invalid and 1 error issue\(s\)\.\nerror: .*The signature is invalid\./,
  );
});

test('warnings pass but are reported', () => {
  const result = evaluateNotaryLog(
    log('Accepted', [issue('warning', 'The executable requests the JIT entitlement.')]),
  );
  assert.equal(result.status, 'Accepted');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^warning: .*figma-drop: The executable requests the JIT/);
});

test('an issue of unknown severity fails closed', () => {
  assert.throws(
    () => evaluateNotaryLog(log('Accepted', [issue('critical', 'Something new.')])),
    /1 error issue\(s\)\.\ncritical: .*Something new\./,
  );
});

test('a log that is not a notary log fails', () => {
  for (const bad of [null, {}, { status: 'Accepted', issues: 'none' }, log('In Progress', null)]) {
    assert.throws(() => evaluateNotaryLog(bad), Error, JSON.stringify(bad));
  }
});
