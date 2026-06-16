const { test } = require('node:test');
const assert = require('node:assert');
const { matchesPattern, filterFiles, buildPrompt, mapGitlabDiff } = require('../src/index.js');

test('matchesPattern: exact and basename', () => {
  assert.equal(matchesPattern('yarn.lock', 'yarn.lock'), true);
  assert.equal(matchesPattern('sub/dir/yarn.lock', 'yarn.lock'), true, 'matches basename');
  assert.equal(matchesPattern('src/app.js', 'yarn.lock'), false);
});

test('matchesPattern: single star stays within path segment', () => {
  assert.equal(matchesPattern('app.min.js', '*.min.js'), true);
  assert.equal(matchesPattern('app.js', '*.js'), true);
  // A dir-anchored pattern: * must not cross '/' in the full-path match, and the
  // basename match can't rescue it either.
  assert.equal(matchesPattern('src/app.js', 'src/*.js'), true);
  assert.equal(matchesPattern('src/sub/app.js', 'src/*.js'), false, '* must not cross /');
});

test('matchesPattern: double star crosses path segments', () => {
  assert.equal(matchesPattern('dist/a/b/bundle.js', 'dist/**'), true);
  assert.equal(matchesPattern('src/a/b/bundle.js', 'dist/**'), false);
});

test('filterFiles: empty patterns is passthrough', () => {
  const files = [{ filename: 'a.js' }, { filename: 'b.lock' }];
  assert.deepEqual(filterFiles(files, []), files);
  assert.deepEqual(filterFiles(files, undefined), files);
});

test('filterFiles: removes matches', () => {
  const files = [
    { filename: 'src/a.js' },
    { filename: 'yarn.lock' },
    { filename: 'dist/bundle.js' },
  ];
  const out = filterFiles(files, ['*.lock', 'dist/**']);
  assert.deepEqual(out.map(f => f.filename), ['src/a.js']);
});

test('mapGitlabDiff: status mapping', () => {
  assert.deepEqual(
    mapGitlabDiff({ new_path: 'a.js', old_path: 'a.js', diff: 'D', new_file: true }),
    { filename: 'a.js', patch: 'D', status: 'added' },
  );
  assert.equal(mapGitlabDiff({ new_path: 'a', diff: '', deleted_file: true }).status, 'removed');
  assert.equal(mapGitlabDiff({ new_path: 'a', diff: '', renamed_file: true }).status, 'renamed');
  assert.equal(mapGitlabDiff({ new_path: 'a', diff: '' }).status, 'modified');
});

test('mapGitlabDiff: falls back to old_path when new_path absent', () => {
  assert.equal(mapGitlabDiff({ old_path: 'gone.js', diff: '', deleted_file: true }).filename, 'gone.js');
});

test('buildPrompt: includes patch fenced as diff', () => {
  const out = buildPrompt([{ filename: 'a.js', status: 'modified', patch: '@@ -1 +1 @@' }], 0);
  assert.match(out, /### a\.js \(modified\)/);
  assert.match(out, /```diff\n@@ -1 \+1 @@\n```/);
});

test('buildPrompt: skips files over MAX_DIFF_CHARS and notes them', () => {
  const big = 'x'.repeat(500);
  const files = [
    { filename: 'small.js', status: 'modified', patch: 'a' },
    { filename: 'big.js', status: 'modified', patch: big },
  ];
  const out = buildPrompt(files, 100);
  assert.match(out, /small\.js/);
  assert.match(out, /excluded because the diff exceeded/);
  assert.match(out, /> - big\.js/);
});

test('buildPrompt: ignores files without patch', () => {
  const out = buildPrompt([{ filename: 'bin.png', status: 'added' }], 0);
  assert.doesNotMatch(out, /bin\.png/);
});
