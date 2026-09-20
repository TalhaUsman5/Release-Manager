'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3000;
const CLI_EXECUTABLE = 'node';
const CLI_CWD = path.resolve(__dirname, '../release-manager-v2');
const AUDIT_PATH = path.join(__dirname, 'audit-log.jsonl');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTextWithLinks(value) {
  const text = String(value);
  const urlPattern = /https?:\/\/[^\s<>]+/g;
  let result = '';
  let position = 0;
  let match;

  while ((match = urlPattern.exec(text)) !== null) {
    result += escapeHtml(text.slice(position, match.index));
    const url = match[0];
    result += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    position = match.index + url.length;
  }

  result += escapeHtml(text.slice(position));
  return result;
}

function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, character => character.toUpperCase());
}

function renderValue(value) {
  if (value === null) return '<span class="null">null</span>';
  if (value === undefined) return '<em>Not provided by status output</em>';

  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="empty">[]</span>';
    return `<ol>${value.map(item => `<li>${renderValue(item)}</li>`).join('')}</ol>`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '<span class="empty">{}</span>';
    return `<dl>${entries.map(([key, item]) =>
      `<dt>${escapeHtml(humanizeKey(key))}</dt><dd>${renderValue(item)}</dd>`
    ).join('')}</dl>`;
  }

  if (typeof value === 'string') return renderTextWithLinks(value);
  return escapeHtml(String(value));
}

function normalizeKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function findStatusValue(root, candidateKeys) {
  const wanted = new Set(candidateKeys.map(normalizeKey));
  const visited = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return undefined;
    visited.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(normalizeKey(key))) return child;
    }
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  return visit(root);
}

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { max-width: 1050px; margin: 2rem auto; padding: 0 1rem; font: 16px/1.45 system-ui, sans-serif; color: #202124; }
  nav { margin-bottom: 1.5rem; }
  nav a { margin-right: 1rem; }
  section { border: 1px solid #d7d7d7; border-radius: .35rem; padding: 1rem; margin: 1rem 0; }
  h1, h2, h3 { line-height: 1.2; }
  dl { margin: .4rem 0; }
  dt { font-weight: 700; margin-top: .65rem; }
  dd { margin-left: 1.25rem; overflow-wrap: anywhere; }
  pre { padding: .8rem; background: #f5f5f5; border: 1px solid #ddd; white-space: pre-wrap; overflow-wrap: anywhere; }
  form { margin: .8rem 0; }
  input, select, button { font: inherit; padding: .35rem .55rem; }
  .error { color: #8b0000; font-weight: 700; }
  .meta { color: #555; }
  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 1rem; }
  .actions section { margin: 0; }
</style>
</head>
<body>
<nav><a href="/">Release status</a><a href="/audit">Audit history</a></nav>
${body}
</body>
</html>`;
}

function sendHtml(response, statusCode, title, body) {
  const document = layout(title, body);
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(document),
    'Cache-Control': 'no-store'
  });
  response.end(document);
}

function validatedRequestOrigin(request) {
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return null;

  let authority;
  try {
    authority = new URL(`http://${hostHeader}`);
  } catch (_error) {
    return null;
  }

  if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) {
    return null;
  }
  if (authority.hostname !== HOST) return null;

  const address = server.address();
  const listeningPort = address && typeof address === 'object' ? address.port : PORT;
  if (authority.port && Number(authority.port) !== listeningPort) return null;
  if (!authority.port && listeningPort !== 80) return null;

  return authority.origin;
}

function crossOriginActionReason(request, expectedOrigin) {
  const originHeader = request.headers.origin;
  if (originHeader !== undefined) {
    if (typeof originHeader !== 'string') return 'The Origin header is invalid.';
    let origin;
    try {
      origin = new URL(originHeader).origin;
    } catch (_error) {
      return 'The Origin header is invalid.';
    }
    if (origin !== expectedOrigin) return 'Cross-origin action requests are not allowed.';
  }

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return 'Fetch Metadata identifies this as a cross-origin action request.';
  }

  return null;
}

function runCli(args) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = spawn(CLI_EXECUTABLE, args, {
        cwd: CLI_CWD,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish({
        exitCode: null,
        stdout,
        stderr,
        error: error && error.message ? error.message : String(error)
      });
      return;
    }

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.once('error', error => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        error: error && error.message ? error.message : String(error)
      });
    });

    child.once('close', code => {
      finish({
        exitCode: typeof code === 'number' ? code : null,
        stdout,
        stderr,
        error: null
      });
    });
  });
}

function renderProcessResult(result) {
  return `<dl>
    <dt>Exit code</dt><dd>${result.exitCode === null ? 'null' : escapeHtml(result.exitCode)}</dd>
    <dt>Start error</dt><dd>${result.error === null ? 'null' : escapeHtml(result.error)}</dd>
  </dl>
  <h3>stdout</h3><pre>${escapeHtml(result.stdout)}</pre>
  <h3>stderr</h3><pre>${escapeHtml(result.stderr)}</pre>`;
}

function appendAudit(args, result) {
  const entry = {
    timestamp: new Date().toISOString(),
    command: {
      executable: CLI_EXECUTABLE,
      arguments: args.slice(),
      cwd: CLI_CWD
    },
    result: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error
    }
  };

  return new Promise((resolve, reject) => {
    let line;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch (error) {
      reject(error);
      return;
    }
    fs.appendFile(AUDIT_PATH, line, { encoding: 'utf8' }, error => {
      if (error) reject(error);
      else resolve(entry);
    });
  });
}

function readRequestBody(request, maximumBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;

    request.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > maximumBytes) {
        failed = true;
        reject(new Error('Request body exceeds the maximum allowed size'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', error => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });
  });
}

function renderMainPage(status) {
  const categories = [
    ['Repository', ['repository', 'repo']],
    ['Scan evidence', ['scanEvidence', 'scanResult', 'scan-evidence', 'scan_evidence']],
    ['Prepared pack', ['preparedPack', 'preparedReleasePack', 'releasePack', 'prepared-pack', 'prepared_pack']],
    ['Changelog', ['changelog', 'changeLog']],
    ['Release Notes', ['releaseNotes', 'notes']],
    ['Announcement', ['announcement']],
    ['Evidence Links', ['evidenceLinks', 'evidenceUrls']],
    ['Approval or Rejection State', ['approvalState', 'rejectionState', 'approval', 'rejection', 'decision', 'reviewState', 'approved', 'rejected']],
    ['Publication Result', ['publicationResult', 'publication', 'publishResult', 'published']]
  ];

  const sections = categories.map(([heading, keys]) =>
    `<section><h2>${escapeHtml(heading)}</h2>${renderValue(findStatusValue(status, keys))}</section>`
  ).join('');

  return `<h1>Release Manager Review</h1>
  <p class="meta">Workflow state below was obtained from the Release Manager CLI status command.</p>
  ${sections}
  <section><h2>Complete Status Output</h2>${renderValue(status)}</section>
  <h2>Actions</h2>
  <div class="actions">
    <section>
      <h3>Configure</h3>
      <form method="post" action="/configure" enctype="application/x-www-form-urlencoded">
        <label>Repository <input type="text" name="repo" placeholder="owner/name" required></label>
        <button type="submit">Configure</button>
      </form>
    </section>
    <section>
      <h3>Scan</h3>
      <form method="post" action="/scan" enctype="application/x-www-form-urlencoded">
        <button type="submit">Scan</button>
      </form>
    </section>
    <section>
      <h3>Prepare</h3>
      <form method="post" action="/prepare" enctype="application/x-www-form-urlencoded">
        <label>Bump
          <select name="bump">
            <option value="patch">patch</option>
            <option value="minor">minor</option>
            <option value="major">major</option>
          </select>
        </label>
        <button type="submit">Prepare</button>
      </form>
    </section>
    <section>
      <h3>Recover</h3>
      <form method="post" action="/recover" enctype="application/x-www-form-urlencoded">
        <button type="submit">Recover</button>
      </form>
    </section>
    <section>
      <h3>Approve</h3>
      <form method="post" action="/approve" enctype="application/x-www-form-urlencoded">
        <label>Approver <input type="text" name="approver" required></label>
        <button type="submit">Approve</button>
      </form>
    </section>
    <section>
      <h3>Reject</h3>
      <form method="post" action="/reject" enctype="application/x-www-form-urlencoded">
        <button type="submit">Reject</button>
      </form>
    </section>
    <section>
      <h3>Publish</h3>
      <form method="post" action="/publish" enctype="application/x-www-form-urlencoded">
        <button type="submit">Publish</button>
      </form>
    </section>
  </div>`;
}

async function handleStatus(response) {
  const args = ['release-manager.js', 'status'];
  const result = await runCli(args);

  if (result.error !== null || result.exitCode !== 0) {
    sendHtml(response, 500, 'Status command failed',
      `<h1 class="error">Status command failed</h1>
       <p>The Release Manager status subprocess did not complete successfully.</p>
       ${renderProcessResult(result)}`);
    return;
  }

  let status;
  try {
    status = JSON.parse(result.stdout);
  } catch (error) {
    sendHtml(response, 500, 'Invalid status JSON',
      `<h1 class="error">Invalid status JSON</h1>
       <p>${escapeHtml(error && error.message ? error.message : String(error))}</p>
       ${renderProcessResult(result)}`);
    return;
  }

  sendHtml(response, 200, 'Release Manager Review', renderMainPage(status));
}

async function handleAction(response, action, args) {
  const result = await runCli(args);
  let auditError = null;

  try {
    await appendAudit(args, result);
  } catch (error) {
    auditError = error;
  }

  const subprocessFailed = result.error !== null || result.exitCode !== 0;
  const failed = subprocessFailed || auditError !== null;
  const auditMessage = auditError
    ? `<section><h2 class="error">Audit write failed</h2><pre>${escapeHtml(auditError.message || String(auditError))}</pre></section>`
    : '<p>One result entry was appended to the audit log.</p>';

  sendHtml(response, failed ? 500 : 200, `${action} result`,
    `<h1>${escapeHtml(action)} Result</h1>
     ${subprocessFailed ? '<p class="error">The subprocess did not complete successfully.</p>' : '<p>The subprocess completed successfully.</p>'}
     <section>${renderProcessResult(result)}</section>
     ${auditMessage}
     <p><a href="/">Return to release status</a> | <a href="/audit">View audit history</a></p>`);
}

async function handleAudit(response) {
  let contents;
  try {
    contents = await fs.promises.readFile(AUDIT_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      contents = '';
    } else {
      sendHtml(response, 500, 'Audit read failed',
        `<h1 class="error">Audit read failed</h1><pre>${escapeHtml(error.message || String(error))}</pre>`);
      return;
    }
  }

  const validEntries = [];
  for (const line of contents.split(/\n/)) {
    if (line.length === 0) continue;
    try {
      validEntries.push(JSON.parse(line));
    } catch (_error) {
      // Malformed lines are not audit entries and are omitted from the display.
    }
  }
  validEntries.reverse();

  const entries = validEntries.map((entry, index) =>
    `<section><h2>Entry ${index + 1}</h2>${renderValue(entry)}</section>`
  ).join('');

  sendHtml(response, 200, 'Audit History',
    `<h1>Audit History</h1>
     <p class="meta">Most recently appended entries are shown first.</p>
     ${entries || '<p>No action entries have been recorded.</p>'}`);
}

async function route(request, response) {
  const expectedOrigin = validatedRequestOrigin(request);
  if (expectedOrigin === null) {
    sendHtml(response, 403, 'Forbidden',
      '<h1 class="error">Forbidden</h1><p>The request Host is not the loopback address used by this console.</p>');
    return;
  }

  const url = new URL(request.url, expectedOrigin);
  const actionPaths = new Set([
    '/configure', '/scan', '/prepare', '/recover',
    '/approve', '/reject', '/publish'
  ]);
  const isAction = request.method === 'POST' && actionPaths.has(url.pathname);

  if (isAction) {
    const reason = crossOriginActionReason(request, expectedOrigin);
    if (reason !== null) {
      sendHtml(response, 403, 'Cross-origin action rejected',
        `<h1 class="error">Cross-origin action rejected</h1><p>${escapeHtml(reason)}</p>`);
      return;
    }
  }

  if (request.method === 'GET' && url.pathname === '/') {
    await handleStatus(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/audit') {
    await handleAudit(response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/configure') {
    const body = await readRequestBody(request);
    const form = new URLSearchParams(body);
    const repo = form.get('repo') === null ? '' : form.get('repo');
    await handleAction(response, 'Configure', ['release-manager.js', 'configure', '--repo', repo]);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/scan') {
    await readRequestBody(request);
    await handleAction(response, 'Scan', ['release-manager.js', 'scan']);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/prepare') {
    const body = await readRequestBody(request);
    const form = new URLSearchParams(body);
    const bump = form.get('bump') === null ? '' : form.get('bump');
    await handleAction(response, 'Prepare', ['release-manager.js', 'prepare', '--bump', bump]);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/recover') {
    await readRequestBody(request);
    await handleAction(response, 'Recover', ['release-manager.js', 'recover']);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/approve') {
    const body = await readRequestBody(request);
    const form = new URLSearchParams(body);
    const approver = form.get('approver') === null ? '' : form.get('approver');
    await handleAction(response, 'Approve', ['release-manager.js', 'approve', '--approver', approver]);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/reject') {
    await readRequestBody(request);
    await handleAction(response, 'Reject', ['release-manager.js', 'reject']);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/publish') {
    await readRequestBody(request);
    await handleAction(response, 'Publish', ['release-manager.js', 'publish']);
    return;
  }

  sendHtml(response, 404, 'Not Found', '<h1>Not Found</h1><p>The requested route does not exist.</p>');
}

const server = http.createServer((request, response) => {
  route(request, response).catch(error => {
    if (response.headersSent) {
      response.end();
      return;
    }
    sendHtml(response, 500, 'Request processing failed',
      `<h1 class="error">Request processing failed</h1><pre>${escapeHtml(error && error.stack ? error.stack : String(error))}</pre>`);
  });
});

server.on('error', error => {
  console.error(`Server error: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  const address = server.address();
  console.log(`Release Manager Review UI listening on http://${HOST}:${address.port}`);
});
