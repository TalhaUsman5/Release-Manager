'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const cli = path.resolve(__dirname, '..', 'release-manager.js');
const TOKEN = 'contract-test-token';

let server;
let apiUrl;
let mock;

function resetMock() {
  mock = {
    requests: [],
    creates: [],
    failCreate: null,
    tagRelease: null,
    createdRelease: null,
    headCommit: {
      sha: 'head123',
      html_url: 'https://github.com/acme/widget/commit/head123',
      commit: { message: 'Default branch head' }
    },
    repositories: {
      'acme/widget': { id: 10, full_name: 'acme/widget', default_branch: 'main' },
      'acme/other': { id: 11, full_name: 'acme/other', default_branch: 'develop' }
    },
    releases: [
      {
        id: 99,
        tag_name: 'v9.9.9-draft',
        name: 'draft',
        body: '',
        draft: true,
        prerelease: false,
        published_at: '2024-04-01T00:00:00Z',
        html_url: 'https://github.com/acme/widget/releases/tag/v9.9.9-draft'
      },
      {
        id: 20,
        tag_name: 'v1.2.3',
        name: 'v1.2.3',
        body: 'baseline',
        draft: false,
        prerelease: true,
        published_at: '2024-03-01T00:00:00Z',
        html_url: 'https://github.com/acme/widget/releases/tag/v1.2.3'
      },
      {
        id: 19,
        tag_name: 'v1.2.2',
        name: 'v1.2.2',
        body: 'older',
        draft: false,
        prerelease: false,
        published_at: '2024-02-01T00:00:00Z',
        html_url: 'https://github.com/acme/widget/releases/tag/v1.2.2'
      }
    ],
    commits: [
      {
        sha: 'abc123',
        commit: { message: 'Fix important bug\n\nDetails' },
        html_url: 'https://github.com/acme/widget/commit/abc123'
      }
    ],
    pulls: [
      {
        number: 42,
        title: 'Add useful feature',
        merged_at: '2024-03-10T12:00:00Z',
        html_url: 'https://github.com/acme/widget/pull/42',
        base: { ref: 'main' }
      }
    ]
  };
}

function send(res, status, value, headers = {}) {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

function releaseForTag(tag) {
  if (mock.tagRelease && mock.tagRelease.tag_name === tag) return mock.tagRelease;
  if (mock.createdRelease && mock.createdRelease.tag_name === tag) return mock.createdRelease;
  return mock.releases.find(r => !r.draft && r.tag_name === tag) || null;
}

async function handle(req, res) {
  const url = new URL(req.url, apiUrl || 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname).replace(/\/$/, '');
  const authorization = req.headers.authorization || '';
  mock.requests.push({ method: req.method, pathname, search: url.search, authorization });

  if (!authorization.includes(TOKEN)) {
    return send(res, 401, { message: 'Bad credentials' });
  }

  const repoMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && repoMatch) {
    const key = `${repoMatch[1]}/${repoMatch[2]}`;
    const repository = mock.repositories[key];
    return repository ? send(res, 200, repository) : send(res, 404, { message: 'Not Found' });
  }

  if (req.method === 'GET' && /\/releases\/latest$/.test(pathname)) {
    const release = mock.releases
      .filter(r => !r.draft)
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    return release ? send(res, 200, release) : send(res, 404, { message: 'Not Found' });
  }

  if (req.method === 'GET' && /\/releases\/tags\//.test(pathname)) {
    const tag = pathname.slice(pathname.indexOf('/releases/tags/') + '/releases/tags/'.length);
    const release = releaseForTag(tag);
    return release ? send(res, 200, release) : send(res, 404, { message: 'Not Found' });
  }

  if (req.method === 'GET' && /\/releases$/.test(pathname)) {
    return send(res, 200, mock.releases);
  }

  const commitRefMatch = pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/);
  if (req.method === 'GET' && commitRefMatch) {
    return send(res, 200, mock.headCommit);
  }

  if (req.method === 'GET' && /\/compare\//.test(pathname)) {
    const comparison = pathname.slice(pathname.indexOf('/compare/') + '/compare/'.length);
    const encodedHead = comparison.split('...').at(-1);
    assert.equal(encodedHead, mock.headCommit.sha, 'compare request must end at the resolved default-branch head SHA');
    return send(res, 200, {
      status: 'ahead',
      ahead_by: mock.commits.length,
      total_commits: mock.commits.length,
      head_commit: mock.headCommit,
      commits: mock.commits
    });
  }

  if (req.method === 'GET' && /\/commits$/.test(pathname)) {
    return send(res, 200, mock.commits);
  }

  if (req.method === 'GET' && /\/pulls$/.test(pathname)) {
    return send(res, 200, mock.pulls);
  }

  if (req.method === 'POST' && /\/releases$/.test(pathname)) {
    const payload = await readJson(req);
    mock.creates.push(payload);
    if (mock.failCreate) {
      return send(res, mock.failCreate.status || 500, { message: mock.failCreate.message });
    }
    mock.createdRelease = {
      id: 700 + mock.creates.length,
      tag_name: payload.tag_name,
      name: payload.name,
      body: payload.body,
      draft: payload.draft,
      prerelease: payload.prerelease,
      target_commitish: payload.target_commitish,
      published_at: '2024-05-01T10:00:00Z',
      html_url: `https://github.com/acme/widget/releases/tag/${payload.tag_name}`
    };
    return send(res, 201, mock.createdRelease);
  }

  return send(res, 404, { message: `Unhandled mock route: ${req.method} ${pathname}` });
}

function invoke(cwd, args, options = {}) {
  const env = {
    ...process.env,
    GITHUB_API_URL: apiUrl,
    GITHUB_TOKEN: TOKEN,
    ...options.env
  };
  for (const key of options.unset || []) delete env[key];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

function parseSingleJson(text, streamName) {
  const trimmed = text.trim();
  assert.notEqual(trimmed, '', `${streamName} must contain a JSON object`);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(trimmed); }, `${streamName} must contain only one valid JSON value`);
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed;
}

async function ok(cwd, ...args) {
  const result = await invoke(cwd, args);
  assert.equal(result.code, 0, `command ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  assert.equal(result.signal, null);
  assert.equal(result.stderr.trim(), '', 'successful commands must not write errors to stderr');
  return parseSingleJson(result.stdout, 'stdout');
}

async function fail(cwd, args, options) {
  const result = await invoke(cwd, args, options);
  assert.notEqual(result.code, 0, `command ${args.join(' ')} unexpectedly succeeded`);
  assert.equal(result.stdout.trim(), '', 'failed commands must report through stderr, not stdout');
  const value = parseSingleJson(result.stderr, 'stderr');
  assert.deepEqual(Object.keys(value), ['error']);
  assert.equal(typeof value.error, 'object');
  assert.equal(typeof value.error.code, 'string');
  assert.notEqual(value.error.code, '');
  assert.equal(typeof value.error.message, 'string');
  assert.notEqual(value.error.message, '');
  return value;
}

async function workspace(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'release-manager-contract-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function configureAndScan(cwd) {
  await ok(cwd, 'configure', '--repo', 'acme/widget');
  return ok(cwd, 'scan');
}

function scanArtifact(value) {
  return value.scan && typeof value.scan === 'object' ? value.scan : value;
}

function packArtifact(value) {
  return value.pack && typeof value.pack === 'object' ? value.pack : value;
}

function assertTimestamp(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string timestamp`);
  assert.equal(Number.isNaN(Date.parse(value)), false, `${label} must be a valid timestamp`);
}

function assertContainsIdentity(object, identity) {
  assert.ok(JSON.stringify(object).includes(JSON.stringify(identity)), `record must contain exact identity ${identity}`);
}

test.before(async () => {
  resetMock();
  server = http.createServer((req, res) => {
    handle(req, res).catch(error => send(res, 500, { message: error.message }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('GitHub Release Manager contract', { concurrency: false }, async t => {
  await t.test('status shape, explicit errors, credentials, and replacement configuration', async t => {
    resetMock();
    const cwd = await workspace(t);

    const initial = await ok(cwd, 'status');
    assert.deepEqual(Object.keys(initial).sort(), [
      'approval', 'pack', 'publication', 'rejection', 'repository', 'scan', 'status'
    ]);
    assert.equal(initial.repository, null);
    assert.equal(initial.scan, null);
    assert.equal(initial.pack, null);
    assert.equal(initial.approval, null);
    assert.equal(initial.rejection, null);
    assert.equal(initial.publication, null);

    await fail(cwd, ['scan']);
    await fail(cwd, ['not-a-command']);
    const requestCount = mock.requests.length;
    await fail(cwd, ['configure', '--repo', 'acme/widget'], { unset: ['GITHUB_TOKEN'] });
    assert.equal(mock.requests.length, requestCount, 'missing credentials must be rejected before GitHub is contacted');

    const configured = await ok(cwd, 'configure', '--repo', 'acme/widget');
    assert.equal(configured.status, 'configured');
    assert.ok(JSON.stringify(configured).includes('acme/widget'));
    assert.ok(JSON.stringify(configured).includes('main'));

    await ok(cwd, 'configure', '--repo', 'acme/other');
    const status = await ok(cwd, 'status');
    assert.equal(status.repository.fullName || status.repository.name || status.repository.repo, 'acme/other');
    assert.equal(status.repository.defaultBranch || status.repository.default_branch, 'develop');
    assert.equal(JSON.stringify(status).includes('acme/widget'), false, 'new configuration must replace the old workflow');
    assert.ok(mock.requests.every(r => r.authorization.includes(TOKEN)), 'all GitHub requests must use GITHUB_TOKEN');
  });

  await t.test('scan selects newest published non-draft release and produces exact assessment evidence', async t => {
    resetMock();
    mock.pulls.push(
      { number: 7, title: 'Too old', merged_at: '2024-02-20T00:00:00Z', html_url: 'https://github.com/acme/widget/pull/7', base: { ref: 'main' } },
      { number: 8, title: 'Not merged', merged_at: null, html_url: 'https://github.com/acme/widget/pull/8', base: { ref: 'main' } },
      { number: 9, title: 'Future merge', merged_at: '2999-01-01T00:00:00Z', html_url: 'https://github.com/acme/widget/pull/9', base: { ref: 'main' } }
    );
    const cwd = await workspace(t);
    const result = await configureAndScan(cwd);
    assert.equal(result.status, 'scanned');
    const scan = scanArtifact(result);
    const text = JSON.stringify(scan);
    assert.ok(text.includes('v1.2.3'), 'newest non-draft release, including prereleases, must be the baseline');
    assert.ok(text.includes('2024-03-01T00:00:00Z'));
    assert.ok(text.includes('/releases/tag/v1.2.3'));
    assert.equal(text.includes('v9.9.9-draft'), false);

    assert.ok(mock.requests.some(r => r.method === 'GET' && r.pathname.endsWith('/commits/main')), 'scan must resolve the current default-branch head');
    assert.ok(mock.requests.some(r => r.method === 'GET' && r.pathname.includes(`/compare/v1.2.3...${mock.headCommit.sha}`)), 'scan comparison must end at the resolved head SHA');
    assert.deepEqual(Object.keys(scan.assessment).sort(), ['evidenceLinks', 'rationale', 'releaseWorthy']);
    assert.equal(scan.assessment.releaseWorthy, true);
    assert.match(scan.assessment.rationale, /1\s+commit/i);
    assert.match(scan.assessment.rationale, /1\s+merged[ -]pull request/i);
    assert.deepEqual(new Set(scan.assessment.evidenceLinks), new Set([
      'https://github.com/acme/widget/commit/abc123',
      'https://github.com/acme/widget/pull/42'
    ]));
    assert.ok(text.includes('abc123'));
    assert.ok(text.includes('Fix important bug'));
    assert.ok(text.includes('https://github.com/acme/widget/commit/abc123'));
    assert.ok(text.includes('42'));
    assert.ok(text.includes('2024-03-10T12:00:00Z'));
    assert.equal(text.includes('/pull/7'), false, 'PRs before the baseline must be excluded');
    assert.equal(text.includes('/pull/8'), false, 'unmerged PRs must be excluded');
    assert.equal(text.includes('/pull/9'), false, 'PRs after scan time must be excluded');
  });

  await t.test('empty activity is not release-worthy and no published baseline is an explicit error', async t => {
    resetMock();
    mock.commits = [];
    mock.pulls = [];
    const cwd = await workspace(t);
    const result = await configureAndScan(cwd);
    const assessment = scanArtifact(result).assessment;
    assert.deepEqual(Object.keys(assessment).sort(), ['evidenceLinks', 'rationale', 'releaseWorthy']);
    assert.equal(assessment.releaseWorthy, false);
    assert.deepEqual(assessment.evidenceLinks, []);
    assert.match(assessment.rationale, /0\s+commits?/i);
    assert.match(assessment.rationale, /0\s+merged[ -]pull requests?/i);
    await fail(cwd, ['prepare', '--bump', 'patch']);

    resetMock();
    mock.releases = [{ tag_name: 'v5.0.0', draft: true, published_at: '2024-04-01T00:00:00Z' }];
    const cwd2 = await workspace(t);
    await ok(cwd2, 'configure', '--repo', 'acme/widget');
    const error = await fail(cwd2, ['scan']);
    assert.equal(error.error.code, 'BASELINE_RELEASE_NOT_FOUND');
  });

  await t.test('preparation applies all semver bumps and creates exactly the required evidence-backed pack', async t => {
    for (const [bump, version] of [['patch', '1.2.4'], ['minor', '1.3.0'], ['major', '2.0.0']]) {
      resetMock();
      const cwd = await workspace(t);
      await configureAndScan(cwd);
      const prepared = await ok(cwd, 'prepare', '--bump', bump);
      assert.equal(prepared.status, 'prepared');
      const pack = packArtifact(prepared);
      assert.deepEqual(Object.keys(pack).sort(), ['announcement', 'changelog', 'evidenceLinks', 'githubReleaseNotes', 'version']);
      assert.equal(pack.version, version);
      assert.match(pack.changelog, new RegExp(version.replace(/\./g, '\\.')));
      assert.match(pack.githubReleaseNotes, new RegExp(version.replace(/\./g, '\\.')));
      assert.ok(pack.changelog.includes('https://github.com/acme/widget/'));
      assert.ok(pack.githubReleaseNotes.includes('https://github.com/acme/widget/'));
      assert.ok(pack.changelog.includes('Fix important bug') || pack.changelog.includes('Add useful feature'));
      assert.ok(pack.githubReleaseNotes.includes('Fix important bug') || pack.githubReleaseNotes.includes('Add useful feature'));
      assert.equal(pack.announcement.trim(), pack.announcement);
      assert.equal(pack.announcement.includes('\n'), false);
      assert.ok(pack.announcement.includes('acme/widget'));
      assert.ok(pack.announcement.includes(version));
      assert.deepEqual(new Set(pack.evidenceLinks), new Set(scanArtifact(await ok(cwd, 'status')).assessment.evidenceLinks));
    }

    resetMock();
    const invalidBumpCwd = await workspace(t);
    await configureAndScan(invalidBumpCwd);
    await fail(invalidBumpCwd, ['prepare', '--bump', 'banana']);

    resetMock();
    mock.releases[1].tag_name = 'release-one';
    const invalidTagCwd = await workspace(t);
    await configureAndScan(invalidTagCwd);
    await fail(invalidTagCwd, ['prepare', '--bump', 'patch']);
  });

  await t.test('approval is required, preserves exact identity, and successful publication is exact and idempotent', async t => {
    resetMock();
    const cwd = await workspace(t);
    await configureAndScan(cwd);
    const prepared = await ok(cwd, 'prepare', '--bump', 'patch');
    const pack = packArtifact(prepared);

    await fail(cwd, ['publish']);
    assert.equal(mock.creates.length, 0);
    await fail(cwd, ['approve', '--approver', '']);

    const approved = await ok(cwd, 'approve', '--approver', 'Test Approver');
    assertContainsIdentity(approved, 'Test Approver');
    await ok(cwd, 'publish');
    assert.equal(mock.creates.length, 1);
    assert.deepEqual(mock.creates[0], {
      tag_name: 'v1.2.4',
      name: 'v1.2.4',
      body: pack.githubReleaseNotes,
      target_commitish: 'main',
      draft: false,
      prerelease: true
    });

    const status = await ok(cwd, 'status');
    assert.deepEqual(Object.keys(status).sort(), ['approval', 'pack', 'publication', 'rejection', 'repository', 'scan', 'status']);
    assertContainsIdentity(status.approval, 'Test Approver');
    assert.equal(status.publication.status, 'succeeded');
    assert.equal(status.publication.version, '1.2.4');
    assert.equal(status.publication.tag, 'v1.2.4');
    assert.ok(status.publication.releaseId || status.publication.githubReleaseId || status.publication.id);
    assert.ok((status.publication.releaseUrl || status.publication.url).includes('/releases/tag/v1.2.4'));
    assert.equal(status.publication.name, 'v1.2.4');
    assert.equal(status.publication.body, pack.githubReleaseNotes);
    assert.equal(status.publication.prerelease, true);
    assertContainsIdentity(status.publication, 'Test Approver');
    assertTimestamp(status.publication.completedAt || status.publication.publicationCompletedAt || status.publication.publishedAt, 'publication completion timestamp');

    await ok(cwd, 'publish');
    assert.equal(mock.creates.length, 1, 're-publishing a succeeded pack must not create a duplicate');
  });

  await t.test('rejection is identity-free, terminal, and prevents GitHub publication', async t => {
    resetMock();
    const cwd = await workspace(t);
    await configureAndScan(cwd);
    await ok(cwd, 'prepare', '--bump', 'patch');
    const rejected = await ok(cwd, 'reject');
    assert.equal(rejected.status, 'rejected');
    const status = await ok(cwd, 'status');
    assert.notEqual(status.rejection, null);
    const rejectionText = JSON.stringify(status.rejection).toLowerCase();
    assert.equal(rejectionText.includes('approver'), false);
    assert.equal(rejectionText.includes('reviewer'), false);
    assert.equal(rejectionText.includes('identity'), false);
    await fail(cwd, ['publish']);
    await fail(cwd, ['approve', '--approver', 'Too Late']);
    assert.equal(mock.creates.length, 0);
  });

  await t.test('failed publication persists attempted payload and recovery retries it unchanged', async t => {
    resetMock();
    const cwd = await workspace(t);
    await configureAndScan(cwd);
    const prepared = await ok(cwd, 'prepare', '--bump', 'minor');
    const pack = packArtifact(prepared);
    await ok(cwd, 'approve', '--approver', 'Recovery Approver');
    mock.failCreate = { status: 503, message: 'upstream unavailable' };
    await fail(cwd, ['publish']);
    assert.equal(mock.creates.length, 1);
    const attempted = structuredClone(mock.creates[0]);

    let status = await ok(cwd, 'status');
    assert.equal(status.publication.status, 'failed');
    assert.ok(JSON.stringify(status.publication).includes('upstream unavailable'));
    assert.ok(JSON.stringify(status.publication).includes(JSON.stringify(attempted.tag_name)));
    assert.ok(JSON.stringify(status.publication).includes(JSON.stringify(attempted.body)));
    assertContainsIdentity(status.publication, 'Recovery Approver');
    assertTimestamp(status.publication.attemptedAt || status.publication.attemptTimestamp || status.publication.startedAt, 'publication attempt timestamp');

    mock.failCreate = null;
    await ok(cwd, 'recover');
    assert.equal(mock.creates.length, 2);
    assert.deepEqual(mock.creates[1], attempted, 'recovery must retry the persisted payload without modification');
    assert.equal(mock.creates[1].body, pack.githubReleaseNotes);
    status = await ok(cwd, 'status');
    assert.equal(status.publication.status, 'succeeded');
  });

  await t.test('recovery adopts an exact existing release but fails safely on a conflicting tag', async t => {
    resetMock();
    const exactCwd = await workspace(t);
    await configureAndScan(exactCwd);
    await ok(exactCwd, 'prepare', '--bump', 'patch');
    await ok(exactCwd, 'approve', '--approver', 'Interrupted Approver');
    mock.failCreate = { status: 500, message: 'connection lost after request' };
    await fail(exactCwd, ['publish']);
    const attempted = mock.creates[0];
    mock.failCreate = null;
    mock.tagRelease = {
      id: 812,
      tag_name: attempted.tag_name,
      name: attempted.name,
      body: attempted.body,
      prerelease: attempted.prerelease,
      draft: false,
      html_url: `https://github.com/acme/widget/releases/tag/${attempted.tag_name}`,
      published_at: '2024-05-02T00:00:00Z'
    };
    await ok(exactCwd, 'recover');
    assert.equal(mock.creates.length, 1, 'matching existing release must be adopted without duplication');
    assert.equal((await ok(exactCwd, 'status')).publication.status, 'succeeded');

    resetMock();
    const conflictCwd = await workspace(t);
    await configureAndScan(conflictCwd);
    await ok(conflictCwd, 'prepare', '--bump', 'patch');
    await ok(conflictCwd, 'approve', '--approver', 'Conflict Approver');
    mock.failCreate = { status: 500, message: 'ambiguous failure' };
    await fail(conflictCwd, ['publish']);
    const conflictAttempt = mock.creates[0];
    mock.failCreate = null;
    mock.tagRelease = {
      id: 900,
      tag_name: conflictAttempt.tag_name,
      name: conflictAttempt.name,
      body: 'DIFFERENT BODY',
      prerelease: conflictAttempt.prerelease,
      draft: false,
      html_url: `https://github.com/acme/widget/releases/tag/${conflictAttempt.tag_name}`
    };
    const error = await fail(conflictCwd, ['recover']);
    assert.match(`${error.error.code} ${error.error.message}`, /conflict/i);
    assert.equal(mock.creates.length, 1, 'conflicting release must neither be overwritten nor duplicated');
    const conflictStatus = await ok(conflictCwd, 'status');
    assert.equal(conflictStatus.publication.status, 'failed');
    assert.match(JSON.stringify(conflictStatus.publication), /conflict/i);
  });
});
