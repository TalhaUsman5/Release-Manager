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
const projectEvidenceDir = path.join(root, 'evidence');
const contractEvidenceDir = path.resolve(root, '../evidence');
const runtimePreload = path.join(root, `.evidence-runtime-${process.pid}.js`);
const capturePreload = path.join(root, `.evidence-capture-${process.pid}.js`);

const PUBLIC_ORIGIN = 'https://release-manager.example.com';
const USERNAME = 'evidence-test-user';
const PASSWORD = 'evidence-test-password';

const evidenceCases = [
  {
    route: '/evidence/trace',
    filename: '3db140f839a8-trace.html',
    contentType: 'text/html'
  },
  {
    route: '/evidence/session',
    filename: '3db140f839a8.json',
    contentType: 'application/json'
  },
  {
    route: '/evidence/events',
    filename: '3db140f839a8.events.jsonl',
    contentType: 'application/x-ndjson'
  }
];

let runtimePort;
let runtimeServer;
let madeContractDirectory = false;
const contractBackups = [];
const projectBackups = [];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function readIfPresent(filename) {
  try {
    return { exists: true, data: await fs.readFile(filename) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, data: null };
    throw error;
  }
}

async function installEvidenceFixtures() {
  try {
    const stat = await fs.stat(contractEvidenceDir);
    assert.ok(stat.isDirectory(), `${contractEvidenceDir} is not a directory`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(contractEvidenceDir, { recursive: true });
    madeContractDirectory = true;
  }

  for (const entry of evidenceCases) {
    const projectFile = path.join(projectEvidenceDir, entry.filename);
    const contractFile = path.join(contractEvidenceDir, entry.filename);
    const supplied = await fs.readFile(projectFile);

    contractBackups.push({ filename: contractFile, ...(await readIfPresent(contractFile)) });
    projectBackups.push({ filename: projectFile, data: supplied });

    await fs.writeFile(contractFile, supplied);
    await fs.writeFile(
      projectFile,
      `WRONG_PROJECT_LOCAL_EVIDENCE_DIRECTORY:${entry.filename}:${process.pid}`,
      'utf8'
    );
  }
}

async function restoreEvidenceFixtures() {
  for (const backup of projectBackups.reverse()) {
    await fs.writeFile(backup.filename, backup.data);
  }

  for (const backup of contractBackups.reverse()) {
    if (backup.exists) await fs.writeFile(backup.filename, backup.data);
    else await fs.rm(backup.filename, { force: true });
  }

  if (madeContractDirectory) {
    try {
      await fs.rmdir(contractEvidenceDir);
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
    }
  }
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const name of [
    'GITHUB_TOKEN',
    'REVIEW_UI_USERNAME',
    'REVIEW_UI_PASSWORD',
    'PUBLIC_ORIGIN',
    'LISTEN_HOST',
    'PORT',
    'HOST',
    'EVIDENCE_TEST_PORT',
    'EVIDENCE_CAPTURE_FILE',
    'NODE_OPTIONS'
  ]) delete env[name];
  return env;
}

function serverEnvironment(overrides = {}) {
  return Object.assign(cleanEnvironment(), {
    GITHUB_TOKEN: 'github-token-for-evidence-tests',
    REVIEW_UI_USERNAME: USERNAME,
    REVIEW_UI_PASSWORD: PASSWORD,
    PUBLIC_ORIGIN
  }, overrides);
}

function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function waitForExit(processInfo, timeout = 5000) {
  if (processInfo.child.exitCode !== null) return processInfo.child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      processInfo.child.kill('SIGKILL');
      reject(new Error(`server did not exit: ${processInfo.output()}`));
    }, timeout);
    processInfo.child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForListening(processInfo, port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null) {
      throw new Error(`server exited before listening: ${processInfo.output()}`);
    }
    if (await canConnect(port)) return;
    await delay(25);
  }
  throw new Error(`server did not listen: ${processInfo.output()}`);
}

async function stopServer(processInfo) {
  if (!processInfo || processInfo.child.exitCode !== null) return;
  const exited = new Promise(resolve => processInfo.child.once('exit', resolve));
  processInfo.child.kill('SIGTERM');
  const killTimer = setTimeout(() => processInfo.child.kill('SIGKILL'), 1000);
  await exited;
  clearTimeout(killTimer);
}

function authHeader(username = USERNAME, password = PASSWORD) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function request({
  requestPath = '/',
  method = 'GET',
  authenticated = true,
  origin = PUBLIC_ORIGIN,
  host = 'release-manager.example.com',
  secure = true,
  headers: extraHeaders = {}
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      host,
      origin,
      'sec-fetch-site': 'same-origin',
      ...extraHeaders
    };
    if (authenticated) headers.authorization = authHeader();
    if (secure) headers['x-evidence-test-secure'] = 'yes';

    const req = http.request({
      host: '127.0.0.1',
      port: runtimePort,
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

function assertAuthRejected(response, description) {
  assert.equal(response.statusCode, 401, `${description}: ${response.body}`);
  assert.match(
    String(response.headers['www-authenticate'] || ''),
    /^Basic\b/i,
    `${description}: missing the existing Basic Auth challenge`
  );
}

async function captureListen(overrides = {}) {
  const captureFile = path.join(
    root,
    `.evidence-listen-${process.pid}-${Math.random().toString(16).slice(2)}.json`
  );
  const env = serverEnvironment(overrides);
  env.NODE_OPTIONS = `--require=${capturePreload}`;
  env.EVIDENCE_CAPTURE_FILE = captureFile;
  const processInfo = startServer(env);
  const exitCode = await waitForExit(processInfo);
  let capture;
  try {
    capture = JSON.parse(await fs.readFile(captureFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    capture = null;
  } finally {
    await fs.rm(captureFile, { force: true });
  }
  return { exitCode, capture, output: processInfo.output() };
}

test.before(async () => {
  await fs.access(serverFile);
  await installEvidenceFixtures();

  await fs.writeFile(runtimePreload, `
'use strict';
const http = require('node:http');
const originalCreateServer = http.createServer;
const originalListen = http.Server.prototype.listen;
http.createServer = function (...args) {
  const index = args.findIndex(value => typeof value === 'function');
  if (index !== -1) {
    const listener = args[index];
    args[index] = function (req, res) {
      if (req.headers['x-evidence-test-secure'] === 'yes') {
        Object.defineProperty(req.socket, 'encrypted', { configurable: true, value: true });
      }
      return listener.call(this, req, res);
    };
  }
  return Reflect.apply(originalCreateServer, this, args);
};
http.Server.prototype.listen = function (...args) {
  const callback = [...args].reverse().find(value => typeof value === 'function');
  return originalListen.call(this, Number(process.env.EVIDENCE_TEST_PORT), '127.0.0.1', callback);
};
`, 'utf8');

  await fs.writeFile(capturePreload, `
'use strict';
const fs = require('node:fs');
const http = require('node:http');
http.Server.prototype.listen = function (...args) {
  let port;
  let host;
  if (args[0] && typeof args[0] === 'object') {
    port = args[0].port;
    host = args[0].host;
  } else {
    port = args[0];
    host = typeof args[1] === 'string' ? args[1] : undefined;
  }
  fs.writeFileSync(process.env.EVIDENCE_CAPTURE_FILE, JSON.stringify({ port, host }));
  setImmediate(() => process.exit(0));
  return this;
};
`, 'utf8');

  runtimePort = await unusedPort();
  const env = serverEnvironment({
    LISTEN_HOST: '0.0.0.0',
    PORT: '45678',
    EVIDENCE_TEST_PORT: String(runtimePort)
  });
  env.NODE_OPTIONS = `--require=${runtimePreload}`;
  runtimeServer = startServer(env);
  await waitForListening(runtimeServer, runtimePort);
});

test.after(async () => {
  try {
    await stopServer(runtimeServer);
  } finally {
    await fs.rm(runtimePreload, { force: true });
    await fs.rm(capturePreload, { force: true });
    await restoreEvidenceFixtures();
  }
});

test('source declares the required sibling evidence directory and all fixed mappings', async () => {
  const source = await fs.readFile(serverFile, 'utf8');
  assert.match(
    source,
    /path\.resolve\(\s*__dirname\s*,\s*['"]\.\.\/evidence['"]\s*\)/,
    "missing path.resolve(__dirname, '../evidence')"
  );

  for (const entry of evidenceCases) {
    assert.match(source, new RegExp(entry.route.replaceAll('/', '\\/')), `missing ${entry.route}`);
    assert.match(
      source,
      new RegExp(entry.filename.replaceAll('.', '\\.')),
      `missing fixed filename ${entry.filename}`
    );
  }
});

test('the three exact GET routes are public and serve only their fixed sibling-directory files', async t => {
  for (const entry of evidenceCases) {
    await t.test(entry.route, async () => {
      const expected = await fs.readFile(path.join(contractEvidenceDir, entry.filename), 'utf8');
      const response = await request({ requestPath: entry.route, authenticated: false });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['content-type'], entry.contentType);
      assert.equal(response.body, expected);
      assert.doesNotMatch(response.body, /WRONG_PROJECT_LOCAL_EVIDENCE_DIRECTORY/);
    });
  }
});

test('query and header input cannot choose a different evidence file', async () => {
  const expected = await fs.readFile(path.join(contractEvidenceDir, '3db140f839a8.json'), 'utf8');
  const response = await request({
    requestPath: '/evidence/session?file=3db140f839a8-trace.html&path=../server.js',
    authenticated: false,
    headers: {
      'x-evidence-file': '3db140f839a8.events.jsonl',
      'x-file-name': '../server.js'
    }
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['content-type'], 'application/json');
  assert.equal(response.body, expected);
});

test('similar, encoded, nested, and filename paths are not authentication exemptions', async t => {
  const paths = [
    '/evidence',
    '/evidence/',
    '/evidence/unknown',
    '/evidence/trace/',
    '/evidence/trace/anything',
    '/evidence/session/anything',
    '/evidence/events/anything',
    '/evidence/3db140f839a8-trace.html',
    '/evidence/3db140f839a8.json',
    '/evidence/3db140f839a8.events.jsonl',
    '/evidence/%74race',
    '/evidence/%73ession',
    '/evidence/%65vents',
    '/evidence%2ftrace',
    '/evidence//trace',
    '/evidence/./trace',
    '/evidence/../server.js',
    '/evidence/%2e%2e/server.js',
    '/evidence/%2E%2E%2Fserver.js',
    '/evidence/trace%2f..%2fsession',
    '/definitely-not-an-existing-route'
  ];

  for (const requestPath of paths) {
    await t.test(requestPath, async () => {
      assertAuthRejected(
        await request({ requestPath, authenticated: false }),
        requestPath
      );
    });
  }
});

test('no non-GET method is exempt on any evidence route', async t => {
  for (const entry of evidenceCases) {
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      await t.test(`${method} ${entry.route}`, async () => {
        const response = await request({
          requestPath: entry.route,
          method,
          authenticated: false
        });
        assertAuthRejected(response, `${method} ${entry.route}`);
      });
    }
  }
});

test('all public evidence routes retain existing origin and PUBLIC_ORIGIN validation', async t => {
  for (const entry of evidenceCases) {
    await t.test(entry.route, async () => {
      const badOrigin = await request({
        requestPath: entry.route,
        authenticated: false,
        origin: 'https://attacker.example.test'
      });
      assert.equal(badOrigin.statusCode, 403, badOrigin.body);

      const badHost = await request({
        requestPath: entry.route,
        authenticated: false,
        host: 'attacker.example.test',
        origin: 'https://attacker.example.test'
      });
      assert.equal(badHost.statusCode, 403, badHost.body);
    });
  }
});

test('ordinary routes retain Basic Auth behavior and routing behavior', async () => {
  const unauthenticated = await request({
    requestPath: '/definitely-not-an-existing-route',
    authenticated: false
  });
  assertAuthRejected(unauthenticated, 'ordinary unauthenticated route');

  const invalidCredentials = await request({
    requestPath: '/definitely-not-an-existing-route',
    authenticated: false,
    headers: { authorization: authHeader('wrong', 'credentials') }
  });
  assertAuthRejected(invalidCredentials, 'ordinary route with invalid credentials');

  const authenticated = await request({ requestPath: '/definitely-not-an-existing-route' });
  assert.equal(authenticated.statusCode, 404, authenticated.body);
});

test('ordinary unauthenticated requests still reach Basic Auth before origin rejection', async () => {
  const response = await request({
    requestPath: '/definitely-not-an-existing-route',
    authenticated: false,
    host: 'attacker.example.test',
    origin: 'https://attacker.example.test'
  });
  assertAuthRejected(response, 'ordinary route with bad origin');
});

test('ordinary authenticated routes retain origin validation', async () => {
  const accepted = await request({ requestPath: '/definitely-not-an-existing-route' });
  assert.equal(accepted.statusCode, 404, accepted.body);

  const rejected = await request({
    requestPath: '/definitely-not-an-existing-route',
    origin: 'https://attacker.example.test'
  });
  assert.equal(rejected.statusCode, 403, rejected.body);
});

test('the shared footer retains its two evidence links and adds the exact self-hosted trace link', async () => {
  const response = await request({ requestPath: '/' });
  assert.equal(response.statusCode, 200, response.body);

  const footerMatch = response.body.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/i);
  assert.ok(footerMatch, 'page has no shared footer');

  const anchors = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(footerMatch[1])) !== null) {
    anchors.push({
      href: match[2],
      text: match[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    });
  }

  assert.ok(anchors.length >= 3, `expected at least three footer links, found ${anchors.length}`);
  assert.equal(
    anchors.filter(link => link.href === '/evidence/trace').length,
    1,
    'footer must contain one link whose href is exactly /evidence/trace'
  );

  assert.ok(
    anchors.some(link => /shipyard/i.test(`${link.href} ${link.text}`) && /dossier/i.test(`${link.href} ${link.text}`)),
    'existing Shipyard dossier footer link was removed'
  );
  assert.ok(
    anchors.some(link => /^https:\/\/github\.com\//i.test(link.href) && /evidence/i.test(`${link.href} ${link.text}`)),
    'existing GitHub evidence-folder footer link was removed'
  );
});

test('CLI listen defaults and configured LISTEN_HOST/PORT behavior remain intact', async () => {
  const defaults = await captureListen();
  assert.equal(defaults.exitCode, 0, defaults.output);
  assert.ok(defaults.capture, `listen was not called: ${defaults.output}`);
  assert.equal(defaults.capture.host, '127.0.0.1');
  assert.equal(Number(defaults.capture.port), 3000);

  const configuredPort = await unusedPort();
  const configured = await captureListen({
    LISTEN_HOST: '0.0.0.0',
    PORT: String(configuredPort)
  });
  assert.equal(configured.exitCode, 0, configured.output);
  assert.ok(configured.capture, `listen was not called: ${configured.output}`);
  assert.equal(configured.capture.host, '0.0.0.0');
  assert.equal(Number(configured.capture.port), configuredPort);
});
