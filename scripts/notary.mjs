import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const describeIssue = (issue) =>
  `${issue.severity}: ${issue.path ?? '(no path)'}: ${issue.message}${issue.docUrl ? ` ${issue.docUrl}` : ''}`;

// Apple: "Always check the log file, even if notarization succeeds, because it might contain
// warnings." An issue of any severity other than "warning" fails, so an unknown severity fails
// closed. `issues` is null on a clean log.
export function evaluateNotaryLog(log) {
  const issues = log?.issues ?? [];
  if (!Array.isArray(issues)) throw new Error('The notary log has an unreadable issues list.');
  const errors = issues.filter((issue) => issue.severity !== 'warning').map(describeIssue);
  const warnings = issues.filter((issue) => issue.severity === 'warning').map(describeIssue);
  if (log?.status !== 'Accepted' || errors.length > 0) {
    throw new Error(
      [
        `Apple's notary log for ${log?.archiveFilename} (${log?.jobId}) has status ${log?.status} and ${errors.length} error issue(s).`,
        ...errors,
        ...warnings,
      ].join('\n'),
    );
  }
  return { id: log.jobId, status: log.status, warnings };
}

export function readNotaryLog(path) {
  const result = evaluateNotaryLog(JSON.parse(readFileSync(path, 'utf8')));
  for (const warning of result.warnings) console.warn(`Notary warning: ${warning}`);
  return result;
}

const credentials = ({ profile, keychain }) => [
  '--keychain-profile',
  profile,
  ...(keychain ? ['--keychain', keychain] : []),
];

function parseJsonObject(text) {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

function notarytool(subcommand, ...args) {
  const result = spawnSync('xcrun', ['notarytool', subcommand, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) {
    throw new Error(`xcrun notarytool ${subcommand} did not run: ${result.error.code}`);
  }
  return result;
}

// Submits `submission` (a zip of the app, or the DMG itself), always fetches and saves the
// notary log to `logPath`, fails unless the log is Accepted with no error issue, then staples
// `stapleTarget` and validates the ticket. Nothing may sign or change `stapleTarget` afterwards.
export function notarize({ submission, stapleTarget, notary, logPath }) {
  const submit = notarytool(
    'submit',
    submission,
    ...credentials(notary),
    '--wait',
    '--timeout',
    '30m',
    '--output-format',
    'json',
  );
  // A failure before Apple assigns a submission id prints no JSON, only its stderr above.
  const result = parseJsonObject(submit.stdout);
  if (!result.id) {
    throw new Error(
      `notarytool submit exited ${submit.status} with no submission id for ${submission}.`,
    );
  }
  console.log(`Notarization ${result.id}: ${result.status}. ${result.message ?? ''}`.trim());
  mkdirSync(dirname(logPath), { recursive: true });
  const log = notarytool('log', result.id, logPath, ...credentials(notary));
  if (log.status !== 0) {
    throw new Error(
      `notarytool log exited ${log.status} for submission ${result.id} (status ${result.status}), so the log could not be checked.`,
    );
  }
  console.log(`Saved the notary log to ${logPath}`);
  const checked = readNotaryLog(logPath);
  if (result.status !== 'Accepted') {
    throw new Error(`notarytool submit reported ${result.status} for ${result.id}.`);
  }
  staple(stapleTarget);
  const validate = spawnSync('xcrun', ['stapler', 'validate', stapleTarget], { stdio: 'inherit' });
  if (validate.status !== 0) {
    throw new Error(`xcrun stapler validate exited ${validate.status} for ${stapleTarget}.`);
  }
  return { id: checked.id, status: checked.status };
}

// Right after Apple accepts a submission, fetching its ticket can fail: the ticket may not be
// published yet, or the connection to Apple's ticket service drops (a release run once failed on
// NSURLErrorDomain -1005). Both clear on a later attempt.
function staple(path, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    const { status } = spawnSync('xcrun', ['stapler', 'staple', path], { stdio: 'inherit' });
    if (status === 0) return;
    if (attempt === attempts) {
      throw new Error(`xcrun stapler staple exited ${status} on all ${attempts} attempts.`);
    }
    const seconds = 15 * attempt;
    console.error(`Stapling failed with exit ${status}. Attempt ${attempt + 1} in ${seconds}s.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
  }
}
