'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const reviewUiServer = path.resolve(__dirname, '..', '..', 'release-manager-review-ui', 'server.js');
const reviewUiCwd = path.dirname(reviewUiServer);

const cli = path.resolve(__dirname, '..', 'release-manager.js');
const STATE_FILE = '.release-manager.json';
const TOKEN = 'contract-test-token';

let githubServer;
let githubApiUrl;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function githubHandler(req, res) {
  const url = new URL(req.url, githubApiUrl || 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname).replace(/\/$/, '');

  if (req.headers.authorization !== `Bearer ${TOKEN}` &&
      req.headers.authorization !== `token ${TOKEN}`) {
    return sendJson(res, 401, { message: 'Bad credentials' });
  }

  if (req.method === 'GET' && pathname === '/repos/acme/widget') {
    return sendJson(res, 200, {
      id: 10,
      full_name: 'acme/widget',
      default_branch: 'main'
    });
  }

  if (req.method === 'GET' && pathname === '/repos/acme/widget/releases/latest') {
    return sendJson(res, 200, {
      id: 20,
      tag_name: 'v1.2.3',
      name: 'v1.2.3',
      body: 'baseline',
      draft: false,
      prerelease: false,
      published_at: '2024-03-01T00:00:00Z',
      html_url: 'https://github.example/acme/widget/releases/tag/v1.2.3'
    });
  }

  if (req.method === 'GET' && pathname === '/repos/acme/widget/releases') {
    return sendJson(res, 200, [
      {
        id: 21,
        tag_name: 'v9.9.9-draft',
        draft: true,
        prerelease: false,
        published_at: '2024-04-01T00:00:00Z',
        html_url: 'https://github.example/acme/widget/releases/tag/v9.9.9-draft'
      },
      {
        id: 20,
        tag_name: 'v1.2.3',
        name: 'v1.2.3',
        body: 'baseline',
        draft: false,
        prerelease: false,
        published_at: '2024-03-01T00:00:00Z',
        html_url: 'https://github.example/acme/widget/releases/tag/v1.2.3'
      }
    ]);
  }

  if (req.method === 'GET' && pathname === '/repos/acme/widget/commits/main') {
    return sendJson(res, 200, {
      sha: 'head123',
      html_url: 'https://github.example/acme/widget/commit/head123',
      commit: { message: 'Current main head' }
    });
  }

  if (req.method === 'GET' && pathname.startsWith('/repos/acme/widget/compare/')) {
    return sendJson(res, 200, {
      status: 'ahead',
      ahead_by: 1,
      total_commits: 1,
      head_commit: {
        sha: 'head123',
        html_url: 'https://github.example/acme/widget/commit/head123',
        commit: { message: 'Current main head' }
      },
      commits: [
        {
          sha: 'abc123',
          html_url: 'https://github.example/acme/widget/commit/abc123',
          commit: { message: 'Fix release issue' }
        }
      ]
    });
  }

  if (req.method === 'GET' && pathname === '/repos/acme/widget/commits') {
    return sendJson(res, 200, [
      {
        sha: 'abc123',
        html_url: 'https://github.example/acme/widget/commit/abc123',
        commit: { message: 'Fix release issue' }
      }
    ]);
  }

  if (req.method === 'GET' && pathname === '/repos/acme/widget/pulls') {
    return sendJson(res, 200, [
      {
        number: 42,
        title: 'Release feature',
        merged_at: '2024-03-10T12:00:00Z',
        html_url: 'https://github.example/acme/widget/pull/42',
        base: { ref: 'main' }
      }
    ]);
  }

  return sendJson(res, 404, {
    message: `Unhandled mock route: ${req.method} ${pathname}`
  });
}

function invoke(cwd, args, options = {}) {
  const env = {
    ...process.env,
    GITHUB_API_URL: githubApiUrl,
    GITHUB_TOKEN: TOKEN,
    ...options.env
  };
  for (const name of options.unset || []) delete env[name];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
  });
}

function parseJson(text, label) {
  assert.notEqual(text.trim(), '', `${label} must contain JSON`);
  let value;
  assert.doesNotThrow(() => {
    value = JSON.parse(text.trim());
  }, `${label} must be valid JSON`);
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value;
}

async function expectOk(cwd, args, options = {}) {
  const result = await invoke(cwd, args, options);
  assert.equal(result.code, 0, `${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  assert.equal(result.signal, null);
  assert.equal(result.stderr.trim(), '', 'successful CLI command wrote to stderr');
  return parseJson(result.stdout, 'stdout');
}

async function expectFailure(cwd, args, options = {}) {
  const result = await invoke(cwd, args, options);
  assert.notEqual(result.code, 0, `${args.join(' ')} unexpectedly succeeded`);
  assert.equal(result.stdout.trim(), '', 'CliError failure must not report success on stdout');
  const value = parseJson(result.stderr, 'stderr');
  assert.equal(typeof value.error, 'object', 'failure must use existing CliError envelope');
  assert.equal(typeof value.error.code, 'string');
  assert.notEqual(value.error.code, '');
  assert.equal(typeof value.error.message, 'string');
  assert.notEqual(value.error.message, '');
  return value.error;
}

async function workspace(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'release-approvers-contract-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function prepareWorkflow(cwd) {
  await expectOk(cwd, ['configure', '--repo', 'acme/widget'], {
    unset: ['RELEASE_APPROVERS']
  });
  await expectOk(cwd, ['scan'], { unset: ['RELEASE_APPROVERS'] });
  return expectOk(cwd, ['prepare', '--bump', 'patch'], {
    unset: ['RELEASE_APPROVERS']
  });
}

async function stateSnapshot(cwd) {
  const filename = path.join(cwd, STATE_FILE);
  const [bytes, details] = await Promise.all([
    readFile(filename),
    stat(filename, { bigint: true })
  ]);
  return {
    bytes,
    mtimeNs: details.mtimeNs,
    size: details.size
  };
}

async function assertStateUnchanged(cwd, before, explanation) {
  const after = await stateSnapshot(cwd);
  assert.deepEqual(after.bytes, before.bytes, `${explanation}: state contents changed`);
  assert.equal(after.size, before.size, `${explanation}: state file size changed`);
  assert.equal(after.mtimeNs, before.mtimeNs, `${explanation}: state file was rewritten`);
}

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(150, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function startReviewUi(env) {
  const port = env.PORT;
  const child = spawn(process.execPath, [reviewUiServer], { cwd: reviewUiCwd, env });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`review UI exited before listening (code ${child.exitCode}): ${output}`);
    }
    if (await canConnect(Number(port))) return { child, port: Number(port) };
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  child.kill('SIGKILL');
  throw new Error(`review UI did not start listening on ${port}: ${output}`);
}

async function stopReviewUi(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = new Promise(resolve => instance.child.once('exit', resolve));
  instance.child.kill('SIGTERM');
  const timer = setTimeout(() => instance.child.kill('SIGKILL'), 1000);
  await exited;
  clearTimeout(timer);
}

function postToReviewUi(port, requestPath, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: requestPath,
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Basic ${Buffer.from('ui-test-user:ui-test-password', 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'content-length': Buffer.byteLength(body)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    req.write(body);
    req.end();
  });
}

test.before(async () => {
  githubServer = http.createServer(githubHandler);
  await new Promise((resolve, reject) => {
    githubServer.once('error', reject);
    githubServer.listen(0, '127.0.0.1', resolve);
  });
  githubApiUrl = `http://127.0.0.1:${githubServer.address().port}`;
});

test.after(async () => {
  if (githubServer) {
    await new Promise(resolve => githubServer.close(resolve));
  }
});

test('RELEASE_APPROVERS approval contract', { concurrency: false }, async t => {
  await t.test('non-approve commands do not require RELEASE_APPROVERS', async t => {
    const cwd = await workspace(t);

    const initial = await expectOk(cwd, ['status'], {
      unset: ['RELEASE_APPROVERS']
    });
    assert.equal(initial.status, 'unconfigured');

    await prepareWorkflow(cwd);
    const prepared = await expectOk(cwd, ['status'], {
      unset: ['RELEASE_APPROVERS']
    });
    assert.equal(prepared.status, 'prepared');
    assert.notEqual(prepared.pack, null);
  });

  await t.test('missing configuration is an immediate CliError and creates no state file', async t => {
    const cwd = await workspace(t);
    const error = await expectFailure(cwd, ['approve', '--approver', 'alice'], {
      unset: ['RELEASE_APPROVERS']
    });

    assert.match(`${error.code} ${error.message}`, /RELEASE_APPROVERS/i);
    await assert.rejects(
      readFile(path.join(cwd, STATE_FILE)),
      reason => reason && reason.code === 'ENOENT',
      'missing allowlist rejection must not create a state file'
    );
  });

  await t.test('unset and empty allowlists reject without mutating or writing prepared state', async t => {
    const cwd = await workspace(t);
    await prepareWorkflow(cwd);
    const before = await stateSnapshot(cwd);

    const cases = [
      { label: 'unset', unset: ['RELEASE_APPROVERS'] },
      { label: 'empty string', env: { RELEASE_APPROVERS: '' } },
      { label: 'whitespace', env: { RELEASE_APPROVERS: '   ' } },
      { label: 'commas', env: { RELEASE_APPROVERS: ',,,' } },
      { label: 'trimmed empty entries', env: { RELEASE_APPROVERS: ' , \t,  ,' } }
    ];

    for (const item of cases) {
      const error = await expectFailure(cwd, ['approve', '--approver', 'alice'], item);
      assert.match(
        `${error.code} ${error.message}`,
        /RELEASE_APPROVERS/i,
        `${item.label} configuration error must identify RELEASE_APPROVERS`
      );
      await assertStateUnchanged(cwd, before, item.label);
    }
  });

  await t.test('existing non-empty approver validation runs before allowlist validation', async t => {
    const cwd = await workspace(t);
    await prepareWorkflow(cwd);
    const before = await stateSnapshot(cwd);

    for (const approver of ['', '   ', '\t\n']) {
      const error = await expectFailure(cwd, ['approve', '--approver', approver], {
        unset: ['RELEASE_APPROVERS']
      });
      const text = `${error.code} ${error.message}`;
      assert.match(text, /approver/i);
      assert.doesNotMatch(
        text,
        /RELEASE_APPROVERS/i,
        'empty --approver must retain its existing validation error'
      );
      await assertStateUnchanged(cwd, before, `invalid approver ${JSON.stringify(approver)}`);
    }
  });

  await t.test('non-members and case-only mismatches are rejected without state writes', async t => {
    const cwd = await workspace(t);
    await prepareWorkflow(cwd);
    const before = await stateSnapshot(cwd);

    for (const item of [
      { approver: 'mallory', allowlist: 'alice,bob', label: 'non-member' },
      { approver: 'alice', allowlist: 'Alice,bob', label: 'case-only mismatch' }
    ]) {
      const error = await expectFailure(cwd, ['approve', '--approver', item.approver], {
        env: { RELEASE_APPROVERS: item.allowlist }
      });
      const text = `${error.code} ${error.message}`;
      assert.match(text, /RELEASE_APPROVERS/i);
      assert.match(text, /allow|reject|authori[sz]/i);
      await assertStateUnchanged(cwd, before, item.label);
    }
  });

  await t.test('comparison trims entries and the submitted approver', async t => {
    const cwd = await workspace(t);
    await prepareWorkflow(cwd);
    const beforeStatus = await expectOk(cwd, ['status'], {
      unset: ['RELEASE_APPROVERS']
    });
    const submitted = '  alice  ';

    const approved = await expectOk(cwd, ['approve', '--approver', submitted], {
      env: { RELEASE_APPROVERS: ' ,  alice  , bob, ' }
    });
    assert.equal(approved.status, 'approved');

    const status = await expectOk(cwd, ['status'], {
      unset: ['RELEASE_APPROVERS']
    });
    assert.equal(status.status, 'approved');
    assert.deepEqual(status.pack, beforeStatus.pack, 'approval must not alter the prepared pack');
    assert.notEqual(status.approval, null);
  });

  await t.test('an ordinary allowed approver follows the existing successful state transition', async t => {
    const cwd = await workspace(t);
    await prepareWorkflow(cwd);

    const approved = await expectOk(cwd, ['approve', '--approver', 'bob'], {
      env: { RELEASE_APPROVERS: 'alice,bob' }
    });
    assert.equal(approved.status, 'approved');
    assert.ok(JSON.stringify(approved).includes('bob'));

    const status = await expectOk(cwd, ['status'], {
      unset: ['RELEASE_APPROVERS']
    });
    assert.equal(status.status, 'approved');
    assert.notEqual(status.approval, null);
    assert.equal(status.rejection, null);
    assert.equal(status.publication, null);
    assert.ok(JSON.stringify(status.approval).includes('bob'));
  });

  await t.test('the real review UI surfaces a rejected approver as the CLI\'s real failure, never a fabricated success', async t => {
    // The review UI never reimplements release-workflow logic — it only
    // shells out to this real CLI (server.js's runCli) and displays
    // whatever the subprocess actually reports. This starts the real
    // review UI server and hits its real /approve route, to confirm the
    // allowlist rejection this file tests at the CLI level above
    // genuinely reaches an operator through the UI too, not just through
    // a direct CLI invocation. RELEASE_MANAGER_CLI_CWD/RELEASE_MANAGER_STATE_FILE
    // point the UI's spawned CLI at THIS checkout of release-manager.js
    // (this project's own worktree) and an isolated temp state file —
    // the real sibling directory only ever holds the last-MERGED code,
    // which can't yet include a change this same test suite is verifying.
    const cwd = await workspace(t);
    const port = await unusedPort();
    const server = await startReviewUi({
      ...process.env,
      GITHUB_API_URL: githubApiUrl,
      GITHUB_TOKEN: TOKEN,
      REVIEW_UI_USERNAME: 'ui-test-user',
      REVIEW_UI_PASSWORD: 'ui-test-password',
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      LISTEN_HOST: '127.0.0.1',
      PORT: String(port),
      RELEASE_APPROVERS: 'alice,bob',
      RELEASE_MANAGER_CLI_CWD: path.resolve(__dirname, '..'),
      RELEASE_MANAGER_STATE_FILE: path.join(cwd, '.release-manager.json')
    });
    t.after(() => stopReviewUi(server));

    const response = await postToReviewUi(port, '/approve', { approver: 'mallory' });

    assert.equal(response.statusCode, 500, 'a rejected approval must not be reported as a UI success');
    assert.match(response.body, /did not complete successfully/, 'the UI must show the real subprocess outcome');
    assert.match(
      response.body,
      /RELEASE_APPROVERS/,
      'the UI must surface the CLI\'s real allowlist-rejection text, not a generic or fabricated message'
    );
    assert.doesNotMatch(response.body, />approved</i, 'no part of the page may claim the approval succeeded');
  });
});
