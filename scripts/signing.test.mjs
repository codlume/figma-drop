import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APP_ENTITLEMENTS,
  entitlementProblems,
  readEntitlements,
  signInsideOut,
} from './signing.mjs';

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const appEntitlements = join(repoDir, 'apps/desktop/entitlements.mac.plist');
const hasCompiler = () => spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0;
const skip =
  process.platform !== 'darwin'
    ? 'codesign runs on macOS only.'
    : hasCompiler()
      ? false
      : 'cc is missing, so no fixture app.';

function writePlist(path, object) {
  writeFileSync(path, JSON.stringify(object));
  execFileSync('plutil', ['-convert', 'xml1', path]);
}

function compile(dir, output, ...flags) {
  execFileSync('cc', ['-arch', 'arm64', ...flags, '-o', output, join(dir, 'main.c')]);
}

function makeBundle(dir, bundle, name) {
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
  compile(dir, join(bundle, 'Contents/MacOS', name));
  writePlist(join(bundle, 'Contents/Info.plist'), {
    CFBundleExecutable: name,
    CFBundleIdentifier: `com.codlume.test.${name}`,
    CFBundleName: name,
    CFBundlePackageType: 'APPL',
  });
}

// figma-drop.app with a nested helper app, a versioned framework, and a plain executable inside
// the framework, the shapes Electron ships.
function makeApp(dir) {
  writeFileSync(join(dir, 'main.c'), 'int main(void) { return 0; }\n');
  const app = join(dir, 'figma-drop.app');
  makeBundle(dir, app, 'figma-drop');
  makeBundle(dir, join(app, 'Contents/Frameworks/Helper.app'), 'Helper');
  const framework = join(app, 'Contents/Frameworks/Lib.framework');
  const version = join(framework, 'Versions/A');
  mkdirSync(join(version, 'Helpers'), { recursive: true });
  mkdirSync(join(version, 'Resources'));
  compile(dir, join(version, 'Lib'), '-dynamiclib', '-install_name', '@rpath/Lib.framework/Lib');
  compile(dir, join(version, 'Helpers/tool'));
  writePlist(join(version, 'Resources/Info.plist'), {
    CFBundleExecutable: 'Lib',
    CFBundleIdentifier: 'com.codlume.test.Lib',
    CFBundlePackageType: 'FMWK',
  });
  symlinkSync('A', join(framework, 'Versions/Current'));
  symlinkSync('Versions/Current/Lib', join(framework, 'Lib'));
  symlinkSync('Versions/Current/Resources', join(framework, 'Resources'));
  return app;
}

// readdir follows the Versions/Current symlink, so signInsideOut lists each file in a framework
// twice. Each code object counts once here.
const distinct = (code) => [
  ...new Map(
    code.map(({ path, app }) => [realpathSync(path), { path: realpathSync(path), app }]),
  ).values(),
];

const problemsOf = (code) =>
  entitlementProblems(
    code.map(({ path, app }) => ({ path, app, entitlements: readEntitlements(path) })),
  );

// A skip in CI hides a regression, so CI must have cc on its macOS runner.
if (skip && process.env.CI && process.platform === 'darwin') {
  test('CI runs the signing integration tests', () => assert.fail(skip));
}

describe('signInsideOut on a synthetic app', { skip }, () => {
  let dir;
  let app;
  let code;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'figma-drop-signing-')));
    app = makeApp(dir);
    code = distinct(signInsideOut(app, '-', appEntitlements));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  // The code list of a copy of the signed app, so each test can re-sign its own copy.
  function signedCopy(name) {
    const copy = join(dir, name, 'figma-drop.app');
    mkdirSync(join(dir, name));
    execFileSync('ditto', [app, copy]);
    return {
      copy,
      code: code.map(({ path, app: isApp }) => ({
        path: join(copy, relative(app, path)),
        app: isApp,
      })),
    };
  }

  test('signs every code object, and none has the wrong entitlements', () => {
    assert.deepEqual(code.map(({ path, app: isApp }) => [relative(dir, path), isApp]).toSorted(), [
      ['figma-drop.app', true],
      ['figma-drop.app/Contents/Frameworks/Helper.app', true],
      ['figma-drop.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper', false],
      ['figma-drop.app/Contents/Frameworks/Lib.framework', false],
      ['figma-drop.app/Contents/Frameworks/Lib.framework/Versions/A/Helpers/tool', false],
      ['figma-drop.app/Contents/Frameworks/Lib.framework/Versions/A/Lib', false],
      ['figma-drop.app/Contents/MacOS/figma-drop', false],
    ]);
    assert.deepEqual(problemsOf(code), []);
  });

  test('a bundle and its main executable report one signature with allow-jit', () => {
    for (const [bundle, executable] of [
      [app, join(app, 'Contents/MacOS/figma-drop')],
      [
        join(app, 'Contents/Frameworks/Helper.app'),
        join(app, 'Contents/Frameworks/Helper.app/Contents/MacOS/Helper'),
      ],
    ]) {
      assert.deepEqual(readEntitlements(executable), readEntitlements(bundle), executable);
      assert.deepEqual(readEntitlements(bundle), APP_ENTITLEMENTS, bundle);
    }
  });

  test('every code object has the hardened runtime', () => {
    for (const { path } of code) {
      const details = spawnSync('codesign', ['-dv', path], { encoding: 'utf8' }).stderr;
      assert.match(details, /flags=\S*\(.*\bruntime\b.*\)/, path);
    }
  });

  test('allow-jit on a plain executable is one problem, naming it', () => {
    const { copy, code: copied } = signedCopy('jit-tool');
    const tool = join(copy, 'Contents/Frameworks/Lib.framework/Versions/A/Helpers/tool');
    execFileSync('codesign', [
      '--force',
      '--options',
      'runtime',
      '--entitlements',
      appEntitlements,
      '--sign',
      '-',
      tool,
    ]);
    const problems = problemsOf(copied);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /Helpers\/tool has .*allow-jit.*expected none/);
  });

  test('get-task-allow on a helper app is a problem for the bundle and its main executable', () => {
    const { copy, code: copied } = signedCopy('debuggable-helper');
    const entitlements = join(dir, 'debuggable.plist');
    writePlist(entitlements, {
      ...APP_ENTITLEMENTS,
      'com.apple.security.get-task-allow': true,
    });
    const helper = join(copy, 'Contents/Frameworks/Helper.app');
    execFileSync('codesign', [
      '--force',
      '--options',
      'runtime',
      '--entitlements',
      entitlements,
      '--sign',
      '-',
      helper,
    ]);
    const problems = problemsOf(copied);
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0], /Helper\.app\/Contents\/MacOS\/Helper has .*get-task-allow/);
    assert.match(problems[1], /Helper\.app has .*get-task-allow/);
  });
});
