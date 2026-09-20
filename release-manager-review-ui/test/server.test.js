'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'server.js');
const auditFile = path.join(root, 'audit-log.jsonl');
const managerDir = path.resolve(root, '../release-manager-v2');
const cliFile = path.join(managerDir, 'release-manager.js');
const configFile = path.join(managerDir, '.review-ui-contract-config.json');
const invocationFile = path.join(managerDir, '.review-ui-contract-invocations.jsonl');
const preloadFile = path.join(root, `.review-ui-contract-preload-${process.pid}.js`);

const statusObject = {
  repository: {
    name: 'octo/status-repository',
    url: 'https://example.test/octo/status-repository'
  },
  scanEvidence: {
    commit: {
      sha: 'status-commit-deadbeef',
      url: 'https://example.test/commit/deadbeef'
    },
    pullRequests: [{
      number: 417,
      title: 'status-visible-pull-request',
      url: 'https://example.test/pull/417'
    }]
  },
  preparedReleasePack: {
    version: 'v9.8.7-contract',
    changelog: 'status-visible-changelog',
    releaseNotes: 'status-visible-release-notes',
    announcement: 'status-visible-announcement',
    evidenceLinks: ['https://example.test/evidence/green']
  },
  approval: { state: 'pending', approver: null },
  rejection: { state: 'not-rejected', reason: null },
  publicationResult: { state: 'not-published', url: null }
};

const initialAuditEntry = {
  timestamp: '2025-01-01T00:00:00.000Z',
  command: {
    executable: 'node',
    arguments: ['release-manager.js', 'publish'],
    cwd: managerDir
  },
  result: {
    exitCode: 0,
    stdout: 'PREEXISTING-AUDIT-MARKER',
    stderr: '',
    error: null
  }
};

const backups = [];
let managerDirCreated = false;
let originalAuditExists = false;
let originalAuditContent;
let server;
let port;

async function moveAside(file) {
  try {
    await fsp.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const backup = `${file}.contract-backup-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fsp.rename(file, backup);
  backups.push({ file, backup });
}

async function writeConfig(overrides = {}) {
  const defaults = {
    status: { stdout: JSON.stringify(statusObject), stderr: '', exitCode: 0 },
    configure: { stdout: 'configure-default', stderr: '', exitCode: 0 },
    scan: { stdout: 'scan-default', stderr: '', exitCode: 0 },
    prepare: { stdout: 'prepare-default', stderr: '', exitCode: 0 },
    recover: { stdout: 'recover-default', stderr: '', exitCode: 0 },
    approve: { stdout: 'approve-default', stderr: '', exitCode: 0 },
    reject: { stdout: 'reject-default', stderr: '', exitCode: 0 },
    publish: { stdout: 'publish-default', stderr: '', exitCode: 0 }
  };
  await fsp.writeFile(configFile, JSON.stringify({ ...defaults, ...overrides }), 'utf8');
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const selected = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(selected));
    });
  });
}

async function canConnect(timeout = 200) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function startServer(envOverrides = {}) {
  const existingOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: `${existingOptions}--require=${preloadFile}`,
      REVIEW_UI_TEST_PORT: String(port),
      REVIEW_UI_INHERITED_SENTINEL: 'sentinel-from-server-environment',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before listening (${child.exitCode}): ${output}`);
    }
    if (await canConnect()) return { child, output: () => output };
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not listen: ${output}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = new Promise(resolve => instance.child.once('exit', resolve));
  instance.child.kill('SIGTERM');
  const timer = setTimeout(() => instance.child.kill('SIGKILL'), 1000);
  await exited;
  clearTimeout(timer);
}

async function request(method, pathname, body, headers = {}) {
  const payload = body === undefined ? null : Buffer.from(body, 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(payload ? { 'content-length': payload.length } : {}),
        ...headers
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function post(pathname, fields = {}) {
  return request(
    'POST',
    pathname,
    new URLSearchParams(fields).toString(),
    { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }
  );
}

async function invocations() {
  try {
    const text = await fsp.readFile(invocationFile, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function attribute(tag, name) {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(?:(["'])(.*?)\\1|([^\\s>]+))`, 'i');
  const match = tag.match(expression);
  return match ? (match[2] === undefined ? match[3] : match[2]) : null;
}

function forms(html) {
  return [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi)].map(match => match[0]);
}

function formFor(html, action) {
  const found = forms(html).find(form => {
    const opening = form.match(/^<form\b[^>]*>/i)[0];
    return attribute(opening, 'action') === action;
  });
  assert.ok(found, `missing form for ${action}`);
  const opening = found.match(/^<form\b[^>]*>/i)[0];
  assert.equal((attribute(opening, 'method') || 'get').toLowerCase(), 'post', `${action} must POST`);
  const encoding = attribute(opening, 'enctype');
  if (encoding !== null) assert.equal(encoding.toLowerCase(), 'application/x-www-form-urlencoded');
  return found;
}

function textContent(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ');
}

function assertButtonLabel(form, label) {
  const visible = textContent(form);
  const inputValues = [...form.matchAll(/<input\b[^>]*>/gi)]
    .map(match => attribute(match[0], 'value'))
    .filter(Boolean);
  assert.ok(
    new RegExp(`\\b${label}\\b`, 'i').test(visible) ||
      inputValues.some(value => value.toLowerCase() === label.toLowerCase()),
    `${label} submit control is not visible`
  );
}

function assertInvocation(actual, expectedArgs) {
  assert.deepEqual(actual.args, expectedArgs);
  assert.equal(actual.cwd, managerDir);
  assert.equal(actual.inheritedSentinel, 'sentinel-from-server-environment');
}

function assertAudit(entry, expectedArguments, expectedResult) {
  assert.deepEqual(Object.keys(entry).sort(), ['command', 'result', 'timestamp']);
  assert.equal(typeof entry.timestamp, 'string');
  assert.equal(new Date(entry.timestamp).toISOString(), entry.timestamp);
  assert.deepEqual(entry.command, {
    executable: 'node',
    arguments: expectedArguments,
    cwd: managerDir
  });
  assert.deepEqual(entry.result, expectedResult);
}

async function oneAppendedAudit(beforeText) {
  const afterText = await fsp.readFile(auditFile, 'utf8');
  assert.ok(afterText.startsWith(beforeText), 'an invocation altered existing audit bytes');
  assert.ok(afterText.endsWith('\n'), 'audit JSONL record must end with a newline');
  const appended = afterText.slice(beforeText.length).split('\n').filter(Boolean);
  assert.equal(appended.length, 1, 'an invocation must append exactly one audit record');
  return JSON.parse(appended[0]);
}

function assertResultVisible(response, expected) {
  assert.ok(response.body.includes(expected.stdout), `response omitted stdout ${expected.stdout}`);
  if (expected.stderr) {
    assert.ok(response.body.includes(expected.stderr), `response omitted stderr ${expected.stderr}`);
  }
  assert.match(response.body, new RegExp(`exit\\s*code[^0-9-]*${expected.exitCode}`, 'i'));
}

test.before(async () => {
  assert.equal(fs.existsSync(serverFile), true, 'server.js must exist');
  port = await allocatePort();

  await fsp.writeFile(preloadFile, `
'use strict';
const http = require('node:http');
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  const callback = [...args].reverse().find(value => typeof value === 'function');
  return originalListen.call(
    this,
    Number(process.env.REVIEW_UI_TEST_PORT),
    '127.0.0.1',
    callback
  );
};
`, 'utf8');

  try {
    await fsp.access(managerDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fsp.mkdir(managerDir, { recursive: true });
    managerDirCreated = true;
  }

  for (const file of [cliFile, configFile, invocationFile]) await moveAside(file);

  await fsp.writeFile(cliFile, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, '.review-ui-contract-invocations.jsonl'), JSON.stringify({
  args,
  cwd: process.cwd(),
  inheritedSentinel: process.env.REVIEW_UI_INHERITED_SENTINEL || null
}) + '\\n');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '.review-ui-contract-config.json'), 'utf8'));
const result = config[args[0]] || {
  stdout: '',
  stderr: 'unknown contract-test command: ' + String(args[0]),
  exitCode: 64
};
if (result.stdout) process.stdout.write(String(result.stdout));
if (result.stderr) process.stderr.write(String(result.stderr));
process.exit(Number(result.exitCode));
`, 'utf8');

  await writeConfig();

  try {
    originalAuditContent = await fsp.readFile(auditFile);
    originalAuditExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fsp.writeFile(auditFile, `${JSON.stringify(initialAuditEntry)}\n`, 'utf8');
  server = await startServer();
});

test.after(async () => {
  await stopServer(server);

  await fsp.rm(auditFile, { recursive: true, force: true });
  if (originalAuditExists) await fsp.writeFile(auditFile, originalAuditContent);

  for (const file of [cliFile, configFile, invocationFile]) {
    await fsp.rm(file, { recursive: true, force: true });
  }
  for (const { file, backup } of backups.reverse()) await fsp.rename(backup, file);
  if (managerDirCreated) await fsp.rm(managerDir, { recursive: true, force: true });
  await fsp.rm(preloadFile, { force: true });
});

test('main UI exposes all new controls and retains existing lifecycle actions', async () => {
  await writeConfig();
  const response = await request('GET', '/');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] || '', /text\/html/i);

  const configureForm = formFor(response.body, '/configure');
  const repoInputs = [...configureForm.matchAll(/<input\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => attribute(tag, 'name') === 'repo');
  assert.equal(repoInputs.length, 1, 'Configure must have exactly one repo input');
  assert.equal((attribute(repoInputs[0], 'type') || 'text').toLowerCase(), 'text');
  assert.match(textContent(configureForm), /configure/i);
  assertButtonLabel(configureForm, 'Configure');

  const scanForm = formFor(response.body, '/scan');
  assertButtonLabel(scanForm, 'Scan');
  assert.equal([...scanForm.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)]
    .filter(match => {
      const tag = match[0];
      return attribute(tag, 'name') && (attribute(tag, 'type') || '').toLowerCase() !== 'submit';
    }).length, 0, 'Scan must not solicit user input');

  const prepareForm = formFor(response.body, '/prepare');
  const selects = [...prepareForm.matchAll(/<select\b[^>]*>[\s\S]*?<\/select\s*>/gi)]
    .map(match => match[0])
    .filter(select => attribute(select.match(/^<select\b[^>]*>/i)[0], 'name') === 'bump');
  assert.equal(selects.length, 1, 'Prepare must have exactly one select named bump');
  const optionValues = [...selects[0].matchAll(/<option\b[^>]*>/gi)]
    .map(match => attribute(match[0], 'value'));
  assert.deepEqual(optionValues, ['patch', 'minor', 'major']);
  assertButtonLabel(prepareForm, 'Prepare');

  const recoverForm = formFor(response.body, '/recover');
  assertButtonLabel(recoverForm, 'Recover');
  assert.equal([...recoverForm.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)]
    .filter(match => {
      const tag = match[0];
      return attribute(tag, 'name') && (attribute(tag, 'type') || '').toLowerCase() !== 'submit';
    }).length, 0, 'Recover must not solicit user input');

  for (const action of ['/approve', '/reject', '/publish']) formFor(response.body, action);
  assert.match(textContent(response.body), /status/i);
});

test('status is obtained from the CLI and visibly labels repository, scan evidence, and prepared pack', async () => {
  await writeConfig();
  const beforeAudit = await fsp.readFile(auditFile, 'utf8');
  const beforeCalls = (await invocations()).length;
  const response = await request('GET', '/');
  const visible = textContent(response.body);

  assert.match(visible, /Repository/i);
  assert.match(visible, /Scan evidence/i);
  assert.match(visible, /Prepared pack/i);
  for (const value of [
    'octo/status-repository',
    'status-commit-deadbeef',
    'status-visible-pull-request',
    'v9.8.7-contract',
    'status-visible-changelog',
    'status-visible-release-notes',
    'status-visible-announcement'
  ]) {
    assert.ok(response.body.includes(value), `status page omitted ${value}`);
  }

  const calls = await invocations();
  assert.equal(calls.length, beforeCalls + 1);
  assertInvocation(calls.at(-1), ['status']);
  assert.equal(await fsp.readFile(auditFile, 'utf8'), beforeAudit, 'status must not create an action audit');
});

test('Configure, Scan, Recover, and every Prepare bump invoke one exact command and audit the actual success', async () => {
  const cases = [
    {
      command: 'configure',
      route: '/configure',
      fields: { repo: 'owner/repo + space; $(not-a-shell)' },
      args: ['configure', '--repo', 'owner/repo + space; $(not-a-shell)']
    },
    { command: 'scan', route: '/scan', fields: {}, args: ['scan'] },
    { command: 'prepare', route: '/prepare', fields: { bump: 'patch' }, args: ['prepare', '--bump', 'patch'] },
    { command: 'prepare', route: '/prepare', fields: { bump: 'minor' }, args: ['prepare', '--bump', 'minor'] },
    { command: 'prepare', route: '/prepare', fields: { bump: 'major' }, args: ['prepare', '--bump', 'major'] },
    { command: 'recover', route: '/recover', fields: {}, args: ['recover'] }
  ];

  for (const [index, item] of cases.entries()) {
    const result = {
      stdout: `SUCCESS-STDOUT-${index}-${item.command}`,
      stderr: `SUCCESS-STDERR-${index}-${item.command}`,
      exitCode: 0
    };
    await writeConfig({ [item.command]: result });
    const beforeCalls = (await invocations()).length;
    const beforeAudit = await fsp.readFile(auditFile, 'utf8');

    const response = await post(item.route, item.fields);
    assertResultVisible(response, result);

    const calls = await invocations();
    assert.equal(calls.length, beforeCalls + 1, `${item.route} made more than one CLI invocation`);
    assertInvocation(calls.at(-1), item.args);

    const entry = await oneAppendedAudit(beforeAudit);
    assertAudit(entry, ['release-manager.js', ...item.args], {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      error: null
    });
  }
});

test('all four new actions expose and audit real nonzero CLI failures without fabricated success', async () => {
  const cases = [
    { command: 'configure', route: '/configure', fields: { repo: 'failure/repo' }, args: ['configure', '--repo', 'failure/repo'] },
    { command: 'scan', route: '/scan', fields: {}, args: ['scan'] },
    { command: 'prepare', route: '/prepare', fields: { bump: 'minor' }, args: ['prepare', '--bump', 'minor'] },
    { command: 'recover', route: '/recover', fields: {}, args: ['recover'] }
  ];

  for (const [index, item] of cases.entries()) {
    const result = {
      stdout: `FAILURE-PARTIAL-STDOUT-${item.command}`,
      stderr: `FAILURE-STDERR-${item.command}`,
      exitCode: 20 + index
    };
    await writeConfig({ [item.command]: result });
    const beforeCalls = (await invocations()).length;
    const beforeAudit = await fsp.readFile(auditFile, 'utf8');

    const response = await post(item.route, item.fields);
    assertResultVisible(response, result);
    assert.doesNotMatch(
      response.body,
      new RegExp(`${item.command}[^<]{0,40}(?:was )?successful|successfully[^<]{0,40}${item.command}`, 'i'),
      'a nonzero subprocess result was presented as success'
    );

    const calls = await invocations();
    assert.equal(calls.length, beforeCalls + 1);
    assertInvocation(calls.at(-1), item.args);

    const entry = await oneAppendedAudit(beforeAudit);
    assertAudit(entry, ['release-manager.js', ...item.args], {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: null
    });
  }
});

test('a new-action subprocess launch error is displayed and audited as an error result', async () => {
  await writeConfig();
  await stopServer(server);
  server = null;
  const missingPath = path.join(root, '.path-that-does-not-exist-for-contract-test');

  try {
    server = await startServer({ PATH: missingPath, Path: missingPath });
    const beforeAudit = await fsp.readFile(auditFile, 'utf8');
    const response = await post('/recover');

    assert.match(response.body, /ENOENT|not found|spawn|subprocess|start|error/i);
    assert.doesNotMatch(response.body, /recover[^<]{0,40}(?:was )?successful|successfully[^<]{0,40}recover/i);

    const entry = await oneAppendedAudit(beforeAudit);
    assert.deepEqual(entry.command, {
      executable: 'node',
      arguments: ['release-manager.js', 'recover'],
      cwd: managerDir
    });
    assert.equal(entry.result.exitCode, null);
    assert.equal(entry.result.stdout, '');
    assert.equal(entry.result.stderr, '');
    assert.equal(typeof entry.result.error, 'string');
    assert.match(entry.result.error, /ENOENT|not found|spawn|node/i);
  } finally {
    await stopServer(server);
    server = await startServer();
  }
});

test('audit history remains reachable and displays records created by the new actions', async () => {
  const response = await request('GET', '/audit');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] || '', /text\/html/i);
  for (const marker of [
    'SUCCESS-STDOUT-0-configure',
    'SUCCESS-STDOUT-1-scan',
    'SUCCESS-STDOUT-2-prepare',
    'SUCCESS-STDOUT-5-recover',
    'FAILURE-STDERR-configure',
    'FAILURE-STDERR-scan',
    'FAILURE-STDERR-prepare',
    'FAILURE-STDERR-recover',
    'PREEXISTING-AUDIT-MARKER'
  ]) {
    assert.ok(response.body.includes(marker), `audit page omitted ${marker}`);
  }
});
