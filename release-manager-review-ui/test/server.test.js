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
const runtimePreload = path.join(root, `.review-runtime-preload-${process.pid}.js`);
const capturePreload = path.join(root, `.review-listen-capture-preload-${process.pid}.js`);

const PUBLIC_ORIGIN = 'https://release-manager.example.com';
const USERNAME = 'listen-test-user';
const PASSWORD = 'listen-test-password';

let runtimePort;
let runtimeServer;

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
    'REVIEW_UI_TEST_PORT',
    'REVIEW_UI_CAPTURE_FILE'
  ]) {
    delete env[name];
  }
  delete env.NODE_OPTIONS;
  return env;
}

function requiredEnvironment(overrides = {}) {
  return Object.assign(cleanEnvironment(), {
    GITHUB_TOKEN: 'github-token-for-listen-tests',
    REVIEW_UI_USERNAME: USERNAME,
    REVIEW_UI_PASSWORD: PASSWORD,
    PUBLIC_ORIGIN
  }, overrides);
}

function spawnServer(env) {
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

async function waitForExit(serverProcess, timeout = 5000) {
  if (serverProcess.child.exitCode !== null) return serverProcess.child.exitCode;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serverProcess.child.kill('SIGKILL');
      reject(new Error(`server did not exit in time: ${serverProcess.output()}`));
    }, timeout);

    serverProcess.child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
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

async function waitForListening(serverProcess, port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (serverProcess.child.exitCode !== null) {
      throw new Error(`server exited before listening: ${serverProcess.output()}`);
    }
    if (await canConnect(port)) return;
    await delay(25);
  }
  throw new Error(`server did not listen on test port: ${serverProcess.output()}`);
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.child.exitCode !== null) return;

  const exited = new Promise(resolve => serverProcess.child.once('exit', resolve));
  serverProcess.child.kill('SIGTERM');
  const timer = setTimeout(() => serverProcess.child.kill('SIGKILL'), 1000);
  await exited;
  clearTimeout(timer);
}

async function captureListen(overrides = {}) {
  const captureFile = path.join(
    root,
    `.review-listen-capture-${process.pid}-${Math.random().toString(16).slice(2)}.json`
  );
  const env = requiredEnvironment(overrides);
  env.NODE_OPTIONS = `--require=${capturePreload}`;
  env.REVIEW_UI_CAPTURE_FILE = captureFile;

  const serverProcess = spawnServer(env);
  const exitCode = await waitForExit(serverProcess);

  let capture = null;
  try {
    capture = JSON.parse(await fs.readFile(captureFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await fs.rm(captureFile, { force: true });
  }

  return { exitCode, capture, output: serverProcess.output() };
}

function assertEndpoint(result, expectedHost, expectedPort) {
  assert.equal(result.exitCode, 0, `startup failed: ${result.output}`);
  assert.ok(result.capture, `HTTP listen was never called: ${result.output}`);
  assert.equal(result.capture.host, expectedHost, 'unexpected HTTP listen host');
  assert.equal(Number(result.capture.port), expectedPort, 'unexpected HTTP listen port');
}

function authorization() {
  return `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf8').toString('base64')}`;
}

async function request({
  requestPath = '/definitely-not-an-existing-route',
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
    if (secure) headers['x-review-test-secure'] = 'yes';

    const req = http.request({
      host: '127.0.0.1',
      port: runtimePort,
      method: 'GET',
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

test.before(async () => {
  await fs.access(serverFile);
  runtimePort = await allocatePort();

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

  fs.writeFileSync(
    process.env.REVIEW_UI_CAPTURE_FILE,
    JSON.stringify({ port: port === undefined ? null : port, host: host === undefined ? null : host })
  );
  setImmediate(() => process.exit(0));
  return this;
};
`, 'utf8');

  await fs.writeFile(runtimePreload, `
'use strict';
const http = require('node:http');
const originalCreateServer = http.createServer;
const originalListen = http.Server.prototype.listen;

http.createServer = function (...args) {
  const listenerIndex = args.findIndex(value => typeof value === 'function');
  if (listenerIndex !== -1) {
    const listener = args[listenerIndex];
    args[listenerIndex] = function (request, response) {
      if (request.headers['x-review-test-secure'] === 'yes') {
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

  const env = requiredEnvironment({
    LISTEN_HOST: '0.0.0.0',
    PORT: '45678',
    REVIEW_UI_TEST_PORT: String(runtimePort)
  });
  env.NODE_OPTIONS = `--require=${runtimePreload}`;
  runtimeServer = spawnServer(env);
  await waitForListening(runtimeServer, runtimePort);
});

test.after(async () => {
  await stopServer(runtimeServer);
  await fs.rm(runtimePreload, { force: true });
  await fs.rm(capturePreload, { force: true });
});

test('unset LISTEN_HOST and PORT use the exact local-development defaults', async () => {
  const result = await captureListen();
  assertEndpoint(result, '127.0.0.1', 3000);
});

test('LISTEN_HOST alone replaces only the default listen address', async () => {
  const result = await captureListen({ LISTEN_HOST: '0.0.0.0' });
  assertEndpoint(result, '0.0.0.0', 3000);
});

test('PORT alone replaces only the default listen port', async () => {
  const selectedPort = await allocatePort();
  const result = await captureListen({ PORT: String(selectedPort) });
  assertEndpoint(result, '127.0.0.1', selectedPort);
});

test('LISTEN_HOST and PORT are both passed to HTTP listen when configured together', async () => {
  const selectedPort = await allocatePort();
  const result = await captureListen({
    LISTEN_HOST: '127.0.0.2',
    PORT: String(selectedPort)
  });
  assertEndpoint(result, '127.0.0.2', selectedPort);
});

test('legacy HOST does not replace the LISTEN_HOST interface', async () => {
  const result = await captureListen({ HOST: '0.0.0.0' });
  assertEndpoint(result, '127.0.0.1', 3000);
});

test('LISTEN_HOST and PORT remain optional startup variables', async () => {
  const result = await captureListen();
  assert.equal(result.exitCode, 0, result.output);
  assert.ok(result.capture, 'startup treated an optional listen variable as missing');
});

test('each established required environment variable still fails fast when missing', async t => {
  const requiredNames = [
    'GITHUB_TOKEN',
    'REVIEW_UI_USERNAME',
    'REVIEW_UI_PASSWORD',
    'PUBLIC_ORIGIN'
  ];

  for (const missingName of requiredNames) {
    await t.test(missingName, async () => {
      const captureFile = path.join(
        root,
        `.review-required-capture-${process.pid}-${Math.random().toString(16).slice(2)}.json`
      );
      const env = requiredEnvironment();
      delete env[missingName];
      env.NODE_OPTIONS = `--require=${capturePreload}`;
      env.REVIEW_UI_CAPTURE_FILE = captureFile;

      const serverProcess = spawnServer(env);
      const exitCode = await waitForExit(serverProcess);
      const output = serverProcess.output();

      assert.notEqual(exitCode, 0, `${missingName} was no longer required`);
      assert.match(output, new RegExp(missingName), `failure did not identify ${missingName}`);
      await assert.rejects(
        fs.access(captureFile),
        error => error && error.code === 'ENOENT',
        'HTTP listen was reached before required-variable validation'
      );
      await fs.rm(captureFile, { force: true });
    });
  }
});

test('configured listen values do not replace PUBLIC_ORIGIN or Host-header checking', async t => {
  await t.test('the exact configured public origin and Host are accepted', async () => {
    const response = await request();
    assert.equal(
      response.statusCode,
      404,
      `valid origin did not pass through to normal unknown-route handling: ${response.body}`
    );
  });

  await t.test('an attacker Host and matching attacker Origin are rejected', async () => {
    const response = await request({
      host: 'attacker.example.test',
      origin: 'https://attacker.example.test'
    });
    assert.equal(response.statusCode, 403);
  });

  await t.test('a valid Host with a mismatched Origin is rejected', async () => {
    const response = await request({ origin: 'https://attacker.example.test' });
    assert.equal(response.statusCode, 403);
  });

  await t.test('a configured Origin with an attacker Host is rejected', async () => {
    const response = await request({ host: 'attacker.example.test' });
    assert.equal(response.statusCode, 403);
  });
});

test('the existing literal 127.0.0.1 origin exception remains unchanged', async t => {
  await t.test('literal loopback with an explicit matching port is accepted', async () => {
    const response = await request({
      secure: false,
      host: '127.0.0.1:49152',
      origin: 'http://127.0.0.1:49152'
    });
    assert.equal(
      response.statusCode,
      404,
      `loopback origin did not reach ordinary routing: ${response.body}`
    );
  });

  await t.test('localhost is not substituted for the literal loopback exception', async () => {
    const response = await request({
      secure: false,
      host: 'localhost:49152',
      origin: 'http://localhost:49152'
    });
    assert.equal(response.statusCode, 403);
  });
});

test('Basic Auth remains ahead of origin and route handling', async () => {
  const response = await request({
    authenticated: false,
    host: 'attacker.example.test',
    origin: 'https://attacker.example.test'
  });
  assert.equal(response.statusCode, 401);
  assert.match(String(response.headers['www-authenticate'] || ''), /^Basic\b/i);
});
