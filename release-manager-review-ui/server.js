'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3000;
const LISTEN_HOST = process.env.LISTEN_HOST === undefined ? HOST : process.env.LISTEN_HOST;
const LISTEN_PORT = process.env.PORT === undefined ? PORT : process.env.PORT;
const CLI_EXECUTABLE = 'node';
const CLI_CWD = path.resolve(__dirname, '../release-manager-v2');
const EVIDENCE_DIRECTORY = path.resolve(__dirname, '../evidence');
const EVIDENCE_ROUTES = Object.freeze({
  '/evidence/trace': '3db140f839a8-trace.html',
  '/evidence/session': '3db140f839a8.json',
  '/evidence/events': '3db140f839a8.events.jsonl'
});
const EVIDENCE_CONTENT_TYPES = Object.freeze({
  '/evidence/trace': 'text/html',
  '/evidence/session': 'application/json',
  '/evidence/events': 'application/x-ndjson'
});
const AUDIT_PATH = path.join(__dirname, 'audit-log.jsonl');
const COLLAPSIBLE_OUTPUT_THRESHOLD = 2000;
const AUTHENTICATION_REALM = 'Basic realm="Release Manager"';

const missingConfigurationVariables = [
  'GITHUB_TOKEN',
  'REVIEW_UI_USERNAME',
  'REVIEW_UI_PASSWORD',
  'PUBLIC_ORIGIN'
].filter(name => process.env[name] === undefined);

if (missingConfigurationVariables.length > 0) {
  throw new Error(`Missing required environment variable${missingConfigurationVariables.length === 1 ? '' : 's'}: ${missingConfigurationVariables.join(', ')}`);
}

const EXPECTED_USERNAME = Buffer.from(process.env.REVIEW_UI_USERNAME, 'utf8');
const EXPECTED_PASSWORD = Buffer.from(process.env.REVIEW_UI_PASSWORD, 'utf8');
const EXPECTED_PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN;

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
  return result + escapeHtml(text.slice(position));
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
    return `<dl>${entries.map(([key, item]) => `<dt>${escapeHtml(humanizeKey(key))}</dt><dd>${renderValue(item)}</dd>`).join('')}</dl>`;
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

function readRecentActivity() {
  let contents;
  try {
    contents = fs.readFileSync(AUDIT_PATH, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { unavailable: true };
  }
  const lines = contents.split(/\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].length === 0) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); } catch (_error) { continue; }
    const args = entry && entry.command && entry.command.arguments;
    const result = entry && entry.result;
    if (!Array.isArray(args) || typeof args[1] !== 'string' || typeof entry.timestamp !== 'string' || !result || !Object.prototype.hasOwnProperty.call(result, 'exitCode')) continue;
    return { action: humanizeKey(args[1]), exitCode: result.exitCode, timestamp: entry.timestamp };
  }
  return null;
}

function renderRecentActivity() {
  const activity = readRecentActivity();
  if (activity === null) return '<div class="activity activity-empty" role="status"><span class="activity-label">Recent activity</span><span>No actions recorded yet</span></div>';
  if (activity.unavailable === true) return '<div class="activity activity-unavailable" role="status"><span class="activity-label">Recent activity</span><span>Recent activity unavailable</span></div>';
  const outcomeClass = activity.exitCode === 0 ? 'activity-success' : 'activity-failure';
  return `<div class="activity ${outcomeClass}" role="status"><span class="activity-label">Recent activity</span><span class="activity-item"><strong>Action:</strong> ${escapeHtml(activity.action)}</span><span class="activity-item"><strong>Exit code:</strong> ${activity.exitCode === null ? 'null' : escapeHtml(activity.exitCode)}</span><span class="activity-item"><strong>Timestamp:</strong> <time datetime="${escapeHtml(activity.timestamp)}">${escapeHtml(activity.timestamp)}</time></span></div>`;
}

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--page:#f4f7fb;--surface:#fff;--text:#172033;--muted:#5b6577;--border:#ccd5e1;--link:#1559b7;--danger:#b42332;--success:#18794e}*{box-sizing:border-box}body{max-width:1120px;margin:auto;padding:0 1.25rem 3rem;font:16px/1.55 system-ui,sans-serif;color:var(--text);background:var(--page)}a{color:var(--link)}.site-header{margin:0 -1.25rem 2rem;padding:1rem 1.25rem;background:var(--surface);border-bottom:1px solid var(--border)}nav,.activity{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;align-items:center}.brand{margin-right:auto;font-weight:700}.activity{margin-top:.85rem;padding:.7rem;border:1px solid var(--border);border-left:.3rem solid var(--muted)}.activity-label{font-weight:800}.activity-success{border-left-color:var(--success)}.activity-failure,.error{color:var(--danger)}section{border:1px solid var(--border);border-radius:.65rem;padding:1rem;margin:1rem 0;background:var(--surface)}dl{margin:.4rem 0}dt{font-weight:750;margin-top:.65rem}dd{margin-left:1.25rem;overflow-wrap:anywhere}pre{padding:.9rem;border:1px solid var(--border);white-space:pre-wrap;overflow-wrap:anywhere}form,label{display:grid;gap:.6rem}input,select,button{min-height:2.55rem;padding:.45rem .65rem;font:inherit}.actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem}.actions section{margin:0}.stream-stdout{border-left:.35rem solid #176b45}.stream-stderr{border-left:.35rem solid #a2303d}details.stream>summary{cursor:pointer;padding:.85rem;font-weight:800}.site-footer{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;margin-top:2rem;padding-top:1rem;border-top:1px solid var(--border)}
</style>
</head>
<body>
<header class="site-header"><nav aria-label="Primary navigation"><a class="brand" href="/">Release Manager Review</a><a href="/">Release status</a><a href="/audit">Audit history</a></nav>${renderRecentActivity()}</header>
<main>${body}</main>
<footer class="site-footer"><a href="https://github.com/TalhaUsman5/Shipyard/blob/main/shipyard_dossier.html">Shipyard dossier</a><a href="https://github.com/TalhaUsman5/Shipyard/tree/main/evidence">GitHub evidence folder</a><a href="/evidence/trace">Self-hosted Shipyard execution trace</a></footer>
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
      child = spawn(CLI_EXECUTABLE, args, { cwd: CLI_CWD, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ exitCode: null, stdout, stderr, error: error && error.message ? error.message : String(error) });
      return;
    }
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => finish({ exitCode: null, stdout, stderr, error: error && error.message ? error.message : String(error) }));
    child.once('close', code => finish({ exitCode: typeof code === 'number' ? code : null, stdout, stderr, error: null }));
  });
}

function renderProcessStream(name, value) {
  const stream = String(value);
  const escaped = escapeHtml(stream);
  const streamClass = name === 'stdout' ? 'stream-stdout' : 'stream-stderr';
  if (stream.length > COLLAPSIBLE_OUTPUT_THRESHOLD) return `<details class="stream ${streamClass}"><summary>${name}<span class="stream-size">${stream.length} characters — expand output</span></summary><pre>${escaped}</pre></details>`;
  return `<section class="stream ${streamClass}"><h3>${name}</h3><pre>${escaped}</pre></section>`;
}

function renderProcessResult(result) {
  return `<dl><dt>Exit code</dt><dd>${result.exitCode === null ? 'null' : escapeHtml(result.exitCode)}</dd><dt>Start error</dt><dd>${result.error === null ? 'null' : escapeHtml(result.error)}</dd></dl>${renderProcessStream('stdout', result.stdout)}${renderProcessStream('stderr', result.stderr)}`;
}

function appendAudit(args, result) {
  const entry = {
    timestamp: new Date().toISOString(),
    command: { executable: CLI_EXECUTABLE, arguments: args.slice(), cwd: CLI_CWD },
    result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: result.error }
  };
  return new Promise((resolve, reject) => {
    let line;
    try { line = `${JSON.stringify(entry)}\n`; } catch (error) { reject(error); return; }
    fs.appendFile(AUDIT_PATH, line, { encoding: 'utf8' }, error => error ? reject(error) : resolve(entry));
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
    request.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
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
  const sections = categories.map(([heading, keys]) => `<section><h2>${escapeHtml(heading)}</h2>${renderValue(findStatusValue(status, keys))}</section>`).join('');
  const actions = [
    ['configure', 'Configure', '<label>Repository <input type="text" name="repo" placeholder="owner/name" required></label>'],
    ['scan', 'Scan', ''],
    ['prepare', 'Prepare', '<label>Bump <select name="bump"><option value="patch">patch</option><option value="minor">minor</option><option value="major">major</option></select></label>'],
    ['recover', 'Recover', ''],
    ['approve', 'Approve', '<label>Approver <input type="text" name="approver" required></label>'],
    ['reject', 'Reject', ''],
    ['publish', 'Publish', '']
  ].map(([routeName, label, fields]) => `<section class="action-${routeName}"><h3>${label}</h3><form method="post" action="/${routeName}" enctype="application/x-www-form-urlencoded">${fields}<button type="submit">${label}</button></form></section>`).join('');
  return `<h1>Release Manager Review</h1><p class="meta">Workflow state below was obtained from the Release Manager CLI status command.</p>${sections}<section><h2>Complete Status Output</h2>${renderValue(status)}</section><h2>Actions</h2><div class="actions">${actions}</div>`;
}

async function handleStatus(response) {
  const result = await runCli(['release-manager.js', 'status']);
  if (result.error !== null || result.exitCode !== 0) {
    sendHtml(response, 500, 'Status command failed', `<h1 class="error">Status command failed</h1><p>The Release Manager status subprocess did not complete successfully.</p>${renderProcessResult(result)}`);
    return;
  }
  let status;
  try { status = JSON.parse(result.stdout); } catch (error) {
    sendHtml(response, 500, 'Invalid status JSON', `<h1 class="error">Invalid status JSON</h1><p>${escapeHtml(error && error.message ? error.message : String(error))}</p>${renderProcessResult(result)}`);
    return;
  }
  sendHtml(response, 200, 'Release Manager Review', renderMainPage(status));
}

async function handleAction(response, action, args) {
  const result = await runCli(args);
  let auditError = null;
  try { await appendAudit(args, result); } catch (error) { auditError = error; }
  const subprocessFailed = result.error !== null || result.exitCode !== 0;
  const failed = subprocessFailed || auditError !== null;
  const auditMessage = auditError ? `<section><h2 class="error">Audit write failed</h2><pre>${escapeHtml(auditError.message || String(auditError))}</pre></section>` : '<p>One result entry was appended to the audit log.</p>';
  sendHtml(response, failed ? 500 : 200, `${action} result`, `<h1>${escapeHtml(action)} Result</h1>${subprocessFailed ? '<p class="error">The subprocess did not complete successfully.</p>' : '<p>The subprocess completed successfully.</p>'}<section>${renderProcessResult(result)}</section>${auditMessage}<p><a href="/">Return to release status</a> | <a href="/audit">View audit history</a></p>`);
}

async function handleAudit(response) {
  let contents;
  try { contents = await fs.promises.readFile(AUDIT_PATH, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') contents = '';
    else {
      sendHtml(response, 500, 'Audit read failed', `<h1 class="error">Audit read failed</h1><pre>${escapeHtml(error.message || String(error))}</pre>`);
      return;
    }
  }
  const validEntries = [];
  for (const line of contents.split(/\n/)) {
    if (line.length === 0) continue;
    try { validEntries.push(JSON.parse(line)); } catch (_error) {}
  }
  validEntries.reverse();
  const entries = validEntries.map((entry, index) => `<section><h2>Entry ${index + 1}</h2>${renderValue(entry)}</section>`).join('');
  sendHtml(response, 200, 'Audit History', `<h1>Audit History</h1><p class="meta">Most recently appended entries are shown first.</p>${entries || '<p>No action entries have been recorded.</p>'}`);
}

async function handleEvidence(response, routePath) {
  const filename = EVIDENCE_ROUTES[routePath];
  let contents;
  try {
    contents = await fs.promises.readFile(path.resolve(EVIDENCE_DIRECTORY, filename));
  } catch (_error) {
    sendHtml(response, 500, 'Request processing failed', '<h1 class="error">Request processing failed</h1><p>The requested evidence is currently unavailable.</p>');
    return;
  }
  response.writeHead(200, {
    'Content-Type': EVIDENCE_CONTENT_TYPES[routePath],
    'Content-Length': contents.length
  });
  response.end(contents);
}

function exactRequestPath(request) {
  if (typeof request.url !== 'string' || request.url.length === 0 || request.url[0] !== '/') return null;
  const queryIndex = request.url.indexOf('?');
  return queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
}

function publicEvidencePathForRequest(request) {
  if (request.method !== 'GET') return null;
  const pathname = exactRequestPath(request);
  if (pathname === null || !Object.prototype.hasOwnProperty.call(EVIDENCE_ROUTES, pathname)) return null;
  return pathname;
}

async function route(request, response) {
  const evidencePath = publicEvidencePathForRequest(request);
  if (evidencePath !== null) return handleEvidence(response, evidencePath);

  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/') return handleStatus(response);
  if (request.method === 'GET' && url.pathname === '/audit') return handleAudit(response);

  const actions = {
    '/scan': ['Scan', 'scan'],
    '/recover': ['Recover', 'recover'],
    '/reject': ['Reject', 'reject'],
    '/publish': ['Publish', 'publish']
  };
  if (request.method === 'POST' && actions[url.pathname]) {
    await readRequestBody(request);
    const [label, command] = actions[url.pathname];
    await handleAction(response, label, ['release-manager.js', command]);
    return;
  }
  if (request.method === 'POST' && ['/configure', '/prepare', '/approve'].includes(url.pathname)) {
    const form = new URLSearchParams(await readRequestBody(request));
    if (url.pathname === '/configure') await handleAction(response, 'Configure', ['release-manager.js', 'configure', '--repo', form.get('repo') === null ? '' : form.get('repo')]);
    if (url.pathname === '/prepare') await handleAction(response, 'Prepare', ['release-manager.js', 'prepare', '--bump', form.get('bump') === null ? '' : form.get('bump')]);
    if (url.pathname === '/approve') await handleAction(response, 'Approve', ['release-manager.js', 'approve', '--approver', form.get('approver') === null ? '' : form.get('approver')]);
    return;
  }
  sendHtml(response, 404, 'Not Found', '<h1>Not Found</h1><p>The requested route does not exist.</p>');
}

function decodeBasicCredentials(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^Basic[ \t]+([^ \t]+)[ \t]*$/i.exec(authorization);
  if (!match) return null;
  const encoded = match[1];
  if (encoded.length === 0 || encoded.length % 4 === 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/.test(encoded)) return null;
  let decoded;
  try { decoded = Buffer.from(encoded, 'base64'); } catch (_error) { return null; }
  if (encoded.replace(/=+$/, '') !== decoded.toString('base64').replace(/=+$/, '')) return null;
  const separator = decoded.indexOf(0x3a);
  if (separator === -1) return null;
  return { username: decoded.subarray(0, separator), password: decoded.subarray(separator + 1) };
}

function secureComponentMatch(submitted, expected) {
  const comparison = Buffer.alloc(expected.length);
  submitted.copy(comparison, 0, 0, expected.length);
  const equalContent = crypto.timingSafeEqual(comparison, expected);
  return equalContent && submitted.length === expected.length;
}

function isAuthenticated(request) {
  const credentials = decodeBasicCredentials(request.headers.authorization);
  if (credentials === null) return false;
  const usernameMatches = secureComponentMatch(credentials.username, EXPECTED_USERNAME);
  const passwordMatches = secureComponentMatch(credentials.password, EXPECTED_PASSWORD);
  return usernameMatches && passwordMatches;
}

function sendAuthenticationFailure(response) {
  const body = 'Authentication required.\n';
  response.writeHead(401, {
    'WWW-Authenticate': AUTHENTICATION_REALM,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function validatedRequestOrigin(request) {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const scheme = forwardedProto === undefined
    ? (request.socket && request.socket.encrypted ? 'https' : 'http')
    : forwardedProto;
  const host = request.headers.host;
  if (typeof host !== 'string') return null;
  const requestOrigin = `${scheme}://${host}`;
  if (requestOrigin === EXPECTED_PUBLIC_ORIGIN || /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(requestOrigin)) return requestOrigin;
  return null;
}

function crossOriginActionReason(request) {
  const requestOrigin = validatedRequestOrigin(request);
  if (requestOrigin === null) return 'request origin is not allowed';
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== requestOrigin) return 'Origin header does not match request origin';
  const referer = request.headers.referer;
  if (typeof referer === 'string') {
    let refererOrigin;
    try { refererOrigin = new URL(referer).origin; } catch (_error) { return 'Referer header is invalid'; }
    if (refererOrigin !== requestOrigin) return 'Referer header does not match request origin';
  }
  return null;
}

function sendCrossOriginFailure(response, reason) {
  const body = `Cross-origin action rejected: ${reason}.\n`;
  response.writeHead(403, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const publicEvidencePath = publicEvidencePathForRequest(request);
  if (publicEvidencePath === null && !isAuthenticated(request)) {
    sendAuthenticationFailure(response);
    return;
  }

  const crossOriginReason = crossOriginActionReason(request);
  if (crossOriginReason !== null) {
    sendCrossOriginFailure(response, crossOriginReason);
    return;
  }

  route(request, response).catch(error => {
    if (response.headersSent) {
      response.end();
      return;
    }
    sendHtml(response, 500, 'Request processing failed', `<h1 class="error">Request processing failed</h1><pre>${escapeHtml(error && error.stack ? error.stack : String(error))}</pre>`);
  });
});

server.on('error', error => {
  console.error(`Server error: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const address = server.address();
  console.log(`Release Manager Review UI listening on http://${LISTEN_HOST}:${address.port}`);
});
