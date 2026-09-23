'use strict';

// Consolidated test suite for release-manager-review-ui/server.js.
//
// Hand-written to restore coverage that five consecutive Shipyard feature
// sessions each silently dropped in turn (every session fully replaced this
// file with only its own new-feature tests): CLI action routes/audit
// (original), Basic Auth, origin validation (PUBLIC_ORIGIN + loopback +
// X-Forwarded-Proto), evidence routes, the footer, and LISTEN_HOST/PORT.
// Every assertion below is against a real spawned `node server.js` process
// over a real HTTP connection — no mocking of the HTTP layer itself.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const managerDir = path.resolve(root, '../release-manager-v2');
const cliFile = path.join(managerDir, 'release-manager.js');
const cliBackupFile = path.join(managerDir, `.release-manager.contract-backup-${process.pid}.js`);
const invocationLog = path.join(managerDir, `.contract-invocations-${process.pid}.jsonl`);
const auditFile = path.join(root, 'audit-log.jsonl');
const auditBackupFile = path.join(root, `.audit-log.contract-backup-${process.pid}.jsonl`);

const projectEvidenceDir = path.join(root, 'evidence');
const contractEvidenceDir = path.resolve(root, '../evidence');

const PUBLIC_ORIGIN = 'https://release-manager.example.com';
const USERNAME = 'contract-test-user';
const PASSWORD = 'contract-test-password';
const GITHUB_TOKEN = 'contract-test-github-token';

const STATUS_OBJECT = { repository: { name: 'octo/contract-repo' }, approval: { state: 'pending' } };

const EVIDENCE_CASES = [
  { route: '/evidence/trace', filename: '3db140f839a8-trace.html', contentType: 'text/html' },
  { route: '/evidence/session', filename: '3db140f839a8.json', contentType: 'application/json' },
  { route: '/evidence/events', filename: '3db140f839a8.events.jsonl', contentType: 'application/x-ndjson' }
];

let auditExistedBefore = false;
let auditOriginalContent = null;
let evidenceDirCreated = false;
const evidenceBackups = [];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// --- Global fixture setup / teardown --------------------------------------

before(async () => {
  // Swap in a fake CLI in place of the real release-manager.js: `status`
  // prints a fixed status object; every other subcommand records its exact
  // argv/cwd/relevant-env to invocationLog and then either succeeds (exit 0,
  // stdout `<subcommand>-ok`) or, when FIXTURE_EXIT_CODE is set in its own
  // environment, fails with that exit code and FIXTURE_STDERR on stderr —
  // lets tests drive both the success and failure paths against a real
  // subprocess boundary, per this project's own established testing
  // convention (a temporary executable fixture, not a mocked spawn).
  const originalCli = await readIfExists(cliFile);
  if (originalCli !== null) await fs.rename(cliFile, cliBackupFile);

  const fixtureCliSource = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const subcommand = args[0];
if (subcommand === 'status') {
  process.stdout.write(${JSON.stringify(JSON.stringify(STATUS_OBJECT))});
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  githubToken: process.env.GITHUB_TOKEN || null
}) + '\\n');
if (process.env.FIXTURE_EXIT_CODE) {
  process.stderr.write(process.env.FIXTURE_STDERR || 'fixture-forced-failure');
  process.exit(Number(process.env.FIXTURE_EXIT_CODE));
}
process.stdout.write(subcommand + '-ok');
process.exit(0);
`;
  await fs.writeFile(cliFile, fixtureCliSource, 'utf8');

  auditOriginalContent = await readIfExists(auditFile);
  auditExistedBefore = auditOriginalContent !== null;
  if (auditExistedBefore) await fs.rename(auditFile, auditBackupFile);

  // Evidence fixtures: real files at the true sibling directory the server
  // reads from, plus poisoned decoys inside the project itself (proves the
  // server never falls back to reading evidence from its own directory).
  try {
    await fs.stat(contractEvidenceDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(contractEvidenceDir, { recursive: true });
    evidenceDirCreated = true;
  }
  for (const { filename } of EVIDENCE_CASES) {
    const contractFile = path.join(contractEvidenceDir, filename);
    evidenceBackups.push({ file: contractFile, data: await readIfExists(contractFile) });
    const projectFile = path.join(projectEvidenceDir, filename);
    const sourceContent = await readIfExists(projectFile);
    await fs.writeFile(
      contractFile,
      sourceContent !== null ? sourceContent : `fixture-content-for-${filename}`
    );
  }
});

after(async () => {
  const backedUpCli = await readIfExists(cliBackupFile);
  if (backedUpCli !== null) {
    await fs.rm(cliFile, { force: true });
    await fs.rename(cliBackupFile, cliFile);
  }
  await fs.rm(invocationLog, { force: true });

  await fs.rm(auditFile, { force: true });
  if (auditExistedBefore) await fs.rename(auditBackupFile, auditFile);

  for (const backup of evidenceBackups) {
    if (backup.data === null) await fs.rm(backup.file, { force: true });
    else await fs.writeFile(backup.file, backup.data);
  }
  if (evidenceDirCreated) {
    try {
      await fs.rmdir(contractEvidenceDir);
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
    }
  }
});

async function readInvocations() {
  const contents = await readIfExists(invocationLog);
  if (contents === null) return [];
  return contents
    .toString('utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line));
}

async function clearInvocations() {
  await fs.rm(invocationLog, { force: true });
}

async function clearAudit() {
  await fs.rm(auditFile, { force: true });
}

// --- Server process helpers -------------------------------------------------

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

async function startServer(envOverrides = {}, { waitOnPort } = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    output += chunk.toString();
  });

  const port = waitOnPort !== undefined ? waitOnPort : Number(envOverrides.PORT);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before listening (code ${child.exitCode}): ${output}`);
    }
    if (await canConnect(port)) return { child, port, output: () => output };
    await delay(30);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start listening on ${port}: ${output}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = new Promise(resolve => instance.child.once('exit', resolve));
  instance.child.kill('SIGTERM');
  const timer = setTimeout(() => instance.child.kill('SIGKILL'), 1000);
  await exited;
  clearTimeout(timer);
}

function basicAuthHeader(username = USERNAME, password = PASSWORD) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function request(instance, options = {}) {
  const {
    method = 'GET',
    requestPath = '/',
    host = `127.0.0.1:${instance.port}`,
    authorization = basicAuthHeader(),
    origin,
    referer,
    forwardedProto,
    headers: extraHeaders = {},
    body
  } = options;

  return new Promise((resolve, reject) => {
    const headers = { host, ...extraHeaders };
    if (authorization !== null && authorization !== undefined) headers.authorization = authorization;
    if (origin !== undefined) headers.origin = origin;
    if (referer !== undefined) headers.referer = referer;
    if (forwardedProto !== undefined) headers['x-forwarded-proto'] = forwardedProto;
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    if (payload) headers['content-length'] = payload.length;

    const req = http.request(
      { host: '127.0.0.1', port: instance.port, method, path: requestPath, headers },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.setTimeout(4000, () => req.destroy(new Error('request timed out')));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function post(instance, requestPath, fields = {}, options = {}) {
  return request(instance, {
    method: 'POST',
    requestPath,
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', ...(options.headers || {}) },
    ...options
  });
}

async function standardServer(overrides = {}) {
  const port = await unusedPort();
  return startServer(
    {
      GITHUB_TOKEN,
      REVIEW_UI_USERNAME: USERNAME,
      REVIEW_UI_PASSWORD: PASSWORD,
      PUBLIC_ORIGIN,
      LISTEN_HOST: '127.0.0.1',
      PORT: String(port),
      ...overrides
    },
    { waitOnPort: port }
  );
}

// --- CLI action routes, subprocess boundary, and audit ----------------------

test('status page is obtained from the real CLI status subcommand', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, { requestPath: '/' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /octo\/contract-repo/);
  } finally {
    await stopServer(server);
  }
});

test('every action invokes the CLI with exact argv and the real project cwd, and audits success', async () => {
  const server = await standardServer();
  try {
    await clearInvocations();
    await clearAudit();
    const cases = [
      { path: '/configure', fields: { repo: 'octo/example' }, argv: ['configure', '--repo', 'octo/example'] },
      { path: '/scan', fields: {}, argv: ['scan'] },
      { path: '/prepare', fields: { bump: 'patch' }, argv: ['prepare', '--bump', 'patch'] },
      { path: '/prepare', fields: { bump: 'minor' }, argv: ['prepare', '--bump', 'minor'] },
      { path: '/prepare', fields: { bump: 'major' }, argv: ['prepare', '--bump', 'major'] },
      { path: '/recover', fields: {}, argv: ['recover'] },
      { path: '/approve', fields: { approver: 'Jane Reviewer' }, argv: ['approve', '--approver', 'Jane Reviewer'] },
      { path: '/reject', fields: {}, argv: ['reject'] },
      { path: '/publish', fields: {}, argv: ['publish'] }
    ];
    for (const testCase of cases) {
      const response = await post(server, testCase.path, testCase.fields);
      assert.equal(response.statusCode, 200, `${testCase.path}: ${response.body}`);
      assert.match(response.body, /completed successfully/);
    }
    const invocations = await readInvocations();
    assert.equal(invocations.length, cases.length);
    cases.forEach((testCase, index) => {
      assert.deepEqual(invocations[index].argv, testCase.argv, `argv for ${testCase.path}`);
      assert.equal(invocations[index].cwd, managerDir, `cwd for ${testCase.path}`);
      assert.equal(invocations[index].githubToken, GITHUB_TOKEN, `inherited GITHUB_TOKEN for ${testCase.path}`);
    });

    const auditContents = await fs.readFile(auditFile, 'utf8');
    const auditLines = auditContents.split('\n').filter(line => line.length > 0);
    assert.equal(auditLines.length, cases.length);
    const lastEntry = JSON.parse(auditLines[auditLines.length - 1]);
    assert.equal(lastEntry.result.exitCode, 0);
  } finally {
    await stopServer(server);
  }
});

test('a real nonzero CLI exit is surfaced as a failure and audited honestly, never as fabricated success', async () => {
  const server = await standardServer({ FIXTURE_EXIT_CODE: '17', FIXTURE_STDERR: 'contract-forced-failure' });
  try {
    await clearInvocations();
    const response = await post(server, '/scan');
    assert.equal(response.statusCode, 500);
    assert.match(response.body, /did not complete successfully/);
    assert.match(response.body, /contract-forced-failure/);

    const auditContents = await fs.readFile(auditFile, 'utf8');
    const lastLine = auditContents.split('\n').filter(Boolean).pop();
    const entry = JSON.parse(lastLine);
    assert.equal(entry.result.exitCode, 17);
    assert.match(entry.result.stderr, /contract-forced-failure/);
  } finally {
    await stopServer(server);
  }
});

test('a subprocess launch error (bad cwd) is surfaced and audited as an error result, not a crash', async () => {
  const server = await standardServer();
  try {
    await fs.rename(managerDir, `${managerDir}.contract-moved-${process.pid}`);
    try {
      const response = await post(server, '/scan');
      assert.equal(response.statusCode, 500);
      assert.match(response.body, /did not complete successfully/);
      const auditContents = await fs.readFile(auditFile, 'utf8');
      const lastLine = auditContents.split('\n').filter(Boolean).pop();
      const entry = JSON.parse(lastLine);
      assert.equal(entry.result.exitCode, null);
      assert.notEqual(entry.result.error, null);
    } finally {
      await fs.rename(`${managerDir}.contract-moved-${process.pid}`, managerDir);
    }
  } finally {
    await stopServer(server);
  }
});

test('audit history displays every recorded entry, most recent first, and an honest empty state', async () => {
  const server = await standardServer();
  try {
    await clearAudit();
    const empty = await request(server, { requestPath: '/audit' });
    assert.equal(empty.statusCode, 200);
    assert.match(empty.body, /No action entries/);

    await post(server, '/scan');
    await post(server, '/recover');
    const populated = await request(server, { requestPath: '/audit' });
    const scanIndex = populated.body.indexOf('scan');
    const recoverIndex = populated.body.indexOf('recover');
    assert.ok(recoverIndex !== -1 && scanIndex !== -1 && recoverIndex < scanIndex, 'most recent entry (recover) must render before the earlier one (scan)');
  } finally {
    await stopServer(server);
  }
});

// --- Basic Auth --------------------------------------------------------------

test('every route requires Basic Auth before anything else runs, GET and POST alike', async () => {
  const server = await standardServer();
  try {
    const noAuth = await request(server, { requestPath: '/', authorization: null });
    assert.equal(noAuth.statusCode, 401);
    assert.equal(noAuth.headers['www-authenticate'], 'Basic realm="Release Manager"');

    const wrongAuth = await request(server, { requestPath: '/', authorization: basicAuthHeader('wrong', 'creds') });
    assert.equal(wrongAuth.statusCode, 401);

    const postNoAuth = await post(server, '/scan', {}, { authorization: null });
    assert.equal(postNoAuth.statusCode, 401);

    const validAuth = await request(server, { requestPath: '/' });
    assert.equal(validAuth.statusCode, 200);
  } finally {
    await stopServer(server);
  }
});

// --- Origin validation: PUBLIC_ORIGIN, loopback, X-Forwarded-Proto ----------

test('the configured PUBLIC_ORIGIN is accepted when Host and scheme both match', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, {
      requestPath: '/',
      host: 'release-manager.example.com',
      forwardedProto: 'https',
      origin: PUBLIC_ORIGIN
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await stopServer(server);
  }
});

test('an unrecognized Host is rejected regardless of valid credentials', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, { requestPath: '/', host: 'evil.example.com' });
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /request origin is not allowed/);
  } finally {
    await stopServer(server);
  }
});

test('the literal 127.0.0.1 loopback origin is always accepted regardless of PUBLIC_ORIGIN', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, { requestPath: '/', host: `127.0.0.1:${server.port}` });
    assert.equal(response.statusCode, 200);
  } finally {
    await stopServer(server);
  }
});

test('X-Forwarded-Proto overrides the socket-derived scheme for a TLS-terminating proxy', async () => {
  const server = await standardServer();
  try {
    const withoutHeader = await request(server, {
      requestPath: '/',
      host: 'release-manager.example.com',
      origin: 'http://release-manager.example.com'
    });
    assert.equal(withoutHeader.statusCode, 403, 'a plain socket without X-Forwarded-Proto must not be treated as https');

    const withHeader = await request(server, {
      requestPath: '/',
      host: 'release-manager.example.com',
      forwardedProto: 'https',
      origin: PUBLIC_ORIGIN
    });
    assert.equal(withHeader.statusCode, 200, 'X-Forwarded-Proto: https must make the computed origin match PUBLIC_ORIGIN');
  } finally {
    await stopServer(server);
  }
});

test('an Origin header that disagrees with the computed request origin is rejected', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, {
      requestPath: '/',
      host: 'release-manager.example.com',
      forwardedProto: 'https',
      origin: 'https://attacker.example.com'
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /Origin header does not match/);
  } finally {
    await stopServer(server);
  }
});


// --- Evidence routes ---------------------------------------------------------

for (const evidenceCase of EVIDENCE_CASES) {
  test(`GET ${evidenceCase.route} is reachable with no credentials and serves the real sibling file`, async () => {
    const server = await standardServer();
    try {
      const response = await request(server, { requestPath: evidenceCase.route, authorization: null });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], evidenceCase.contentType);
      assert.doesNotMatch(response.body, /WRONG_PROJECT_LOCAL_EVIDENCE_DIRECTORY/);
      const expected = await fs.readFile(path.join(contractEvidenceDir, evidenceCase.filename), 'utf8');
      assert.equal(response.body, expected);
    } finally {
      await stopServer(server);
    }
  });
}

test('evidence routes still enforce origin validation like any other route', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, { requestPath: '/evidence/trace', authorization: null, host: 'evil.example.com' });
    assert.equal(response.statusCode, 403);
  } finally {
    await stopServer(server);
  }
});

test('no method other than GET is exempt on an evidence route', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, { requestPath: '/evidence/trace', method: 'POST', authorization: null });
    assert.equal(response.statusCode, 401, 'a non-GET evidence request must fall through to the ordinary auth gate');
  } finally {
    await stopServer(server);
  }
});

test('query strings and headers cannot select a file outside the fixed evidence mapping', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, {
      requestPath: '/evidence/trace?file=../../../etc/passwd',
      authorization: null,
      headers: { 'x-evidence-file': '../../secret.txt' }
    });
    assert.equal(response.statusCode, 200);
    const expected = await fs.readFile(path.join(contractEvidenceDir, '3db140f839a8-trace.html'), 'utf8');
    assert.equal(response.body, expected, 'the query string must be ignored entirely, not treated as a file selector');
  } finally {
    await stopServer(server);
  }
});

test('an unknown evidence-like path is a plain 404, not treated as exempt', async () => {
  const server = await standardServer();
  try {
    const response = await request(server, { requestPath: '/evidence/does-not-exist', authorization: null });
    assert.equal(response.statusCode, 401, 'an unrecognized /evidence/* path is not in the fixed allowlist, so it falls through to ordinary auth');
  } finally {
    await stopServer(server);
  }
});

// --- Footer -------------------------------------------------------------------

test('the shared footer links to all three self-hosted evidence routes', async () => {
  // Redesigned to keep every evidence link self-hosted rather than mixing
  // in external GitHub links — matches the recorded lesson against adding
  // external destinations merely to make a UI feel more client-facing.
  const server = await standardServer();
  try {
    const response = await request(server, { requestPath: '/' });
    assert.match(response.body, /href="\/evidence\/trace"/);
    assert.match(response.body, /href="\/evidence\/session"/);
    assert.match(response.body, /href="\/evidence\/events"/);
  } finally {
    await stopServer(server);
  }
});

// --- LISTEN_HOST / PORT -------------------------------------------------------

test('LISTEN_HOST and PORT default to 127.0.0.1:3000 when unset', async () => {
  const canUseDefaultPort = await canConnect(3000).then(connected => !connected);
  if (!canUseDefaultPort) {
    // Something else is already listening on 3000 in this environment;
    // skip rather than produce a false failure or false pass.
    return;
  }
  const server = await startServer(
    {
      GITHUB_TOKEN,
      REVIEW_UI_USERNAME: USERNAME,
      REVIEW_UI_PASSWORD: PASSWORD,
      PUBLIC_ORIGIN,
      LISTEN_HOST: undefined,
      PORT: undefined
    },
    { waitOnPort: 3000 }
  );
  try {
    assert.match(server.output(), /listening on http:\/\/127\.0\.0\.1:3000/);
  } finally {
    await stopServer(server);
  }
});

test('LISTEN_HOST and PORT overrides are both honored together', async () => {
  const port = await unusedPort();
  const server = await startServer(
    {
      GITHUB_TOKEN,
      REVIEW_UI_USERNAME: USERNAME,
      REVIEW_UI_PASSWORD: PASSWORD,
      PUBLIC_ORIGIN,
      LISTEN_HOST: '127.0.0.1',
      PORT: String(port)
    },
    { waitOnPort: port }
  );
  try {
    assert.match(server.output(), new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  } finally {
    await stopServer(server);
  }
});

// --- Required environment variables fail fast --------------------------------

for (const missing of ['GITHUB_TOKEN', 'REVIEW_UI_USERNAME', 'REVIEW_UI_PASSWORD', 'PUBLIC_ORIGIN']) {
  test(`missing ${missing} fails fast at startup with a clear error`, async () => {
    const env = {
      ...process.env,
      GITHUB_TOKEN,
      REVIEW_UI_USERNAME: USERNAME,
      REVIEW_UI_PASSWORD: PASSWORD,
      PUBLIC_ORIGIN,
      LISTEN_HOST: '127.0.0.1',
      PORT: String(await unusedPort())
    };
    delete env[missing];
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk.toString()));
    child.stderr.on('data', chunk => (output += chunk.toString()));
    const exitCode = await new Promise(resolve => child.once('exit', resolve));
    assert.notEqual(exitCode, 0);
    assert.match(output, new RegExp(`Missing required environment variable.*${missing}`));
  });
}
