'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'server.js');
const auditFile = path.join(root, 'audit-log.jsonl');
const managerDir = path.resolve(root, '../release-manager-v2');
const cliFile = path.join(managerDir, 'release-manager.js');
const invocationFile = path.join(managerDir, '.origin-gate-test-invocations.jsonl');
const preloadFile = path.join(root, `.origin-gate-test-preload-${process.pid}.js`);

const PUBLIC_ORIGIN = 'https://release-manager.example.com';
const USERNAME = 'origin-test-user';
const PASSWORD = 'origin-test-password';

let port;
let running;
let managerCreated = false;
let originalAudit;
let originalAuditExists = false;
const backups = [];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function canConnect(targetPort) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: targetPort });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function moveAside(file) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  const backup = `${file}.verifier-backup-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.rename(file, backup);
  backups.push({ file, backup });
}

function childEnvironment(overrides = {}) {
  const env = { ...process.env };
  delete env.PUBLIC_ORIGIN;
  delete env.GITHUB_TOKEN;
  delete env.REVIEW_UI_USERNAME;
  delete env.REVIEW_UI_PASSWORD;

  const inheritedOptions = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : '';
  env.NODE_OPTIONS = `${inheritedOptions}--require=${preloadFile}`;
  env.REVIEW_UI_TEST_PORT = String(overrides.REVIEW_UI_TEST_PORT || port);

  return Object.assign(env, {
    GITHUB_TOKEN: 'github-token-for-origin-tests',
    REVIEW_UI_USERNAME: USERNAME,
    REVIEW_UI_PASSWORD: PASSWORD
  }, overrides);
}

function spawnServer(targetPort, overrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnvironment({ REVIEW_UI_TEST_PORT: String(targetPort), ...overrides }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function waitForListening(serverProcess, targetPort) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (serverProcess.child.exitCode !== null) {
      throw new Error(`server exited before listening: ${serverProcess.output()}`);
    }
    if (await canConnect(targetPort)) return;
    await delay(25);
  }
  throw new Error(`server did not begin listening: ${serverProcess.output()}`);
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.child.exitCode !== null) return;
  const exited = new Promise(resolve => serverProcess.child.once('exit', resolve));
  serverProcess.child.kill('SIGTERM');
  const timer = setTimeout(() => serverProcess.child.kill('SIGKILL'), 1000);
  await exited;
  clearTimeout(timer);
}

function authorization() {
  return `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf8').toString('base64')}`;
}

async function request({
  method = 'GET',
  requestPath = '/',
  host = 'release-manager.example.com',
  origin = PUBLIC_ORIGIN,
  secure = true,
  authenticated = true
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      host,
      origin,
      'sec-fetch-site': 'same-origin'
    };

    if (authenticated) headers.authorization = authorization();
    if (secure) headers['x-origin-gate-test-secure'] = 'yes';
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = '0';
    }

    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers,
      agent: false
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
    req.end();
  });
}

async function invocationCount() {
  try {
    const text = await fs.readFile(invocationFile, 'utf8');
    return text.split('\n').filter(Boolean).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

function invalidOriginOptions(overrides = {}) {
  return {
    secure: true,
    host: 'attacker.example.test',
    origin: 'https://attacker.example.test',
    ...overrides
  };
}

test.before(async () => {
  await fs.access(serverFile);
  port = await allocatePort();

  await fs.writeFile(preloadFile, `
'use strict';
const http = require('node:http');
const originalCreateServer = http.createServer;
const originalListen = http.Server.prototype.listen;

http.createServer = function (...args) {
  const listenerIndex = args.findIndex(value => typeof value === 'function');
  if (listenerIndex !== -1) {
    const listener = args[listenerIndex];
    args[listenerIndex] = function (request, response) {
      if (request.headers['x-origin-gate-test-secure'] === 'yes') {
        Object.defineProperty(request.socket, 'encrypted', {
          configurable: true,
          value: true
        });
      }
      return listener.call(this, request, response);
    };
  }
  return Reflect.apply(originalCreateServer, this, args);
};

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
    await fs.access(managerDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(managerDir, { recursive: true });
    managerCreated = true;
  }

  for (const file of [cliFile, invocationFile]) await moveAside(file);

  await fs.writeFile(cliFile, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(
  path.join(__dirname, '.origin-gate-test-invocations.jsonl'),
  JSON.stringify(args) + '\\n'
);

if (args[0] === 'status') {
  process.stdout.write(JSON.stringify({
    repository: { name: 'origin/test', url: 'https://example.test/origin/test' },
    scanEvidence: { commit: null, pullRequests: [] },
    preparedReleasePack: null,
    approval: { state: 'pending', approver: null },
    rejection: { state: 'not-rejected', reason: null },
    publicationResult: { state: 'not-published', url: null }
  }));
} else {
  process.stdout.write('ORIGIN-GATE-ACTION-MARKER');
}
`, 'utf8');
  await fs.writeFile(invocationFile, '', 'utf8');

  try {
    originalAudit = await fs.readFile(auditFile);
    originalAuditExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(auditFile, '', 'utf8');

  running = spawnServer(port, { PUBLIC_ORIGIN });
  await waitForListening(running, port);
});

test.after(async () => {
  await stopServer(running);
  await fs.rm(preloadFile, { force: true });
  await fs.rm(invocationFile, { force: true });
  await fs.rm(cliFile, { force: true });

  await fs.rm(auditFile, { force: true });
  if (originalAuditExists) await fs.writeFile(auditFile, originalAudit);

  for (const item of backups.reverse()) {
    await fs.rename(item.backup, item.file);
  }
  if (managerCreated) await fs.rm(managerDir, { recursive: true, force: true });
});

test('Basic Auth is the first gate for GET, POST, and other methods', async t => {
  const cases = [
    { method: 'GET', requestPath: '/' },
    { method: 'POST', requestPath: '/scan' },
    { method: 'PUT', requestPath: '/scan' },
    { method: 'DELETE', requestPath: '/missing-route' }
  ];

  for (const item of cases) {
    await t.test(item.method, async () => {
      const before = await invocationCount();
      const response = await request(invalidOriginOptions({
        ...item,
        authenticated: false
      }));

      assert.equal(
        response.statusCode,
        401,
        `${item.method} was processed by origin validation or routing before Basic Auth`
      );
      assert.match(
        String(response.headers['www-authenticate'] || ''),
        /^Basic\b/i,
        'the existing Basic Auth challenge was not returned'
      );
      assert.equal(await invocationCount(), before, 'an unauthenticated request reached a route');
    });
  }
});

test('origin rejection is identical and occurs before routing for GET, POST, and non-POST methods', async () => {
  const before = await invocationCount();
  const postResponse = await request(invalidOriginOptions({
    method: 'POST',
    requestPath: '/scan'
  }));

  assert.equal(postResponse.statusCode, 403, 'POST no longer uses the existing origin rejection');
  assert.equal(await invocationCount(), before, 'rejected POST reached its action route');

  const cases = [
    { method: 'GET', requestPath: '/' },
    { method: 'PUT', requestPath: '/scan' },
    { method: 'PATCH', requestPath: '/scan' },
    { method: 'DELETE', requestPath: '/' },
    { method: 'OPTIONS', requestPath: '/' }
  ];

  for (const item of cases) {
    const response = await request(invalidOriginOptions(item));
    assert.equal(response.statusCode, 403, `${item.method} escaped origin validation`);
    assert.equal(
      response.body,
      postResponse.body,
      `${item.method} did not use the existing origin-rejection response`
    );
    assert.equal(
      await invocationCount(),
      before,
      `${item.method} reached routing despite its rejected origin`
    );
  }
});

test('an invalid origin takes precedence over the unknown-route response', async () => {
  const requestPath = '/definitely-not-an-existing-route';
  const before = await invocationCount();

  const acceptedOriginResponse = await request({ method: 'GET', requestPath });
  assert.equal(
    acceptedOriginResponse.statusCode,
    404,
    'the valid-origin control request did not reach the existing unknown-route behavior'
  );

  const rejectedOriginResponse = await request(invalidOriginOptions({
    method: 'GET',
    requestPath
  }));
  assert.equal(
    rejectedOriginResponse.statusCode,
    403,
    'an unknown route was selected before origin validation'
  );
  assert.equal(await invocationCount(), before, 'an unknown request invoked the release manager');
});

test('authenticated GET and POST requests accepted by PUBLIC_ORIGIN retain their routes', async () => {
  let before = await invocationCount();
  const getResponse = await request({ method: 'GET', requestPath: '/' });
  assert.equal(getResponse.statusCode, 200, `accepted GET failed: ${getResponse.body}`);
  assert.equal(await invocationCount(), before + 1, 'accepted GET did not reach its route');

  before = await invocationCount();
  const postResponse = await request({ method: 'POST', requestPath: '/scan' });
  assert.equal(postResponse.statusCode, 200, `accepted POST failed: ${postResponse.body}`);
  assert.equal(await invocationCount(), before + 1, 'accepted POST did not reach its route');
});

test('the existing explicit-port 127.0.0.1 exception also works for GET requests', async () => {
  const before = await invocationCount();
  const response = await request({
    method: 'GET',
    requestPath: '/',
    secure: false,
    host: '127.0.0.1:49152',
    origin: 'http://127.0.0.1:49152'
  });

  assert.equal(response.statusCode, 200, `loopback exception was rejected: ${response.body}`);
  assert.equal(await invocationCount(), before + 1, 'accepted loopback GET did not reach its route');
});

test('GET validation retains exact PUBLIC_ORIGIN comparison rules', async t => {
  const cases = [
    {
      name: 'different scheme',
      options: {
        secure: false,
        host: 'release-manager.example.com',
        origin: 'http://release-manager.example.com'
      }
    },
    {
      name: 'configured host used as an attacker-controlled prefix',
      options: {
        secure: true,
        host: 'release-manager.example.com.attacker.test',
        origin: 'https://release-manager.example.com.attacker.test'
      }
    },
    {
      name: 'extra explicit port',
      options: {
        secure: true,
        host: 'release-manager.example.com:443',
        origin: 'https://release-manager.example.com:443'
      }
    },
    {
      name: 'localhost is not the literal loopback exception',
      options: {
        secure: false,
        host: 'localhost:3000',
        origin: 'http://localhost:3000'
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const before = await invocationCount();
      const response = await request({
        method: 'GET',
        requestPath: '/',
        ...item.options
      });
      assert.equal(response.statusCode, 403, `${item.name} was incorrectly accepted`);
      assert.equal(await invocationCount(), before, `${item.name} reached the GET route`);
    });
  }
});
