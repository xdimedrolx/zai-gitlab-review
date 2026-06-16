const { test } = require('node:test');
const assert = require('node:assert');
const { matchesPattern, filterFiles, buildPrompt, mapGitlabDiff, readFileContent } = require('../src/index.js');

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
  const out = buildPrompt([{ filename: 'a.js', status: 'modified', patch: '@@ -1 +1 @@' }], {});
  assert.match(out, /### a\.js \(modified\)/);
  assert.match(out, /```diff\n@@ -1 \+1 @@\n```/);
});

test('buildPrompt: skips files over MAX_DIFF_CHARS and notes them', () => {
  const big = 'x'.repeat(500);
  const files = [
    { filename: 'small.js', status: 'modified', patch: 'a' },
    { filename: 'big.js', status: 'modified', patch: big },
  ];
  const out = buildPrompt(files, { maxDiffChars: 100 });
  assert.match(out, /small\.js/);
  assert.match(out, /excluded because the diff exceeded/);
  assert.match(out, /> - big\.js/);
});

test('buildPrompt: ignores files without patch', () => {
  const out = buildPrompt([{ filename: 'bin.png', status: 'added' }], {});
  assert.doesNotMatch(out, /bin\.png/);
});

test('buildPrompt: includes full file content when present', () => {
  const out = buildPrompt(
    [{ filename: 'a.js', status: 'modified', patch: '@@ -1 +1 @@', content: 'const x = 1;\n' }],
    {},
  );
  assert.match(out, /\*\*Full file \(current\):\*\*/);
  assert.match(out, /const x = 1;/);
});

test('buildPrompt: omits content over MAX_CONTEXT_CHARS and notes it', () => {
  const files = [
    { filename: 'a.js', status: 'modified', patch: 'd', content: 'x'.repeat(50) },
    { filename: 'b.js', status: 'modified', patch: 'd', content: 'y'.repeat(500) },
  ];
  const out = buildPrompt(files, { maxContextChars: 100 });
  assert.match(out, /xxxxx/);                       // a.js content kept
  assert.doesNotMatch(out, /yyyyy/);                // b.js content dropped
  assert.match(out, /full content omitted/);
  assert.match(out, /> - b\.js/);
});

test('buildPrompt: shows contentNote when content unavailable', () => {
  const out = buildPrompt(
    [{ filename: 'a.js', status: 'modified', patch: 'd', contentNote: 'binary' }],
    {},
  );
  assert.match(out, /full file omitted: binary/);
});

test('readFileContent: reads an existing file', () => {
  const r = readFileContent('package.json', 0);
  assert.equal(typeof r.text, 'string');
  assert.match(r.text, /"name": "zai-gitlab-review"/);
});

test('readFileContent: missing file returns a note', () => {
  const r = readFileContent('does/not/exist.xyz', 0);
  assert.equal(r.text, undefined);
  assert.equal(typeof r.note, 'string');
});

test('readFileContent: rejects path traversal outside repo', () => {
  const r = readFileContent('../../../etc/passwd', 0);
  assert.equal(r.text, undefined);
  assert.equal(r.note, 'outside repo');
});

test('readFileContent: too-large file returns a note, not text', () => {
  const r = readFileContent('package.json', 5);
  assert.equal(r.text, undefined);
  assert.match(r.note, /too large/);
});
