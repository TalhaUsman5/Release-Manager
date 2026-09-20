#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = process.env.RELEASE_MANAGER_STATE_FILE
  ? path.resolve(process.env.RELEASE_MANAGER_STATE_FILE)
  : path.resolve(process.cwd(), '.release-manager.json');
const PUBLICATION_LOCK_FILE = `${STATE_FILE}.publication.lock`;
const API_BASE = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function emptyState() {
  return {
    status: 'unconfigured',
    repository: null,
    scan: null,
    pack: null,
    approval: null,
    rejection: null,
    publication: null
  };
}

function publicState(state) {
  return {
    status: typeof state.status === 'string' ? state.status : 'unconfigured',
    repository: state.repository || null,
    scan: state.scan || null,
    pack: state.pack || null,
    approval: state.approval || null,
    rejection: state.rejection || null,
    publication: state.publication || null
  };
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The state file does not contain an object.');
    }
    return { ...emptyState(), ...parsed };
  } catch (error) {
    throw new CliError('STATE_READ_FAILED', `Unable to read workflow state: ${error.message}`);
  }
}

function writeState(state) {
  const directory = path.dirname(STATE_FILE);
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(publicState(state), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, STATE_FILE);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw new CliError('STATE_WRITE_FAILED', `Unable to persist workflow state: ${error.message}`);
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function lockOwnerIsAlive(contents) {
  const match = /^(\d+):/.exec(contents);
  if (!match) return true;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function acquirePublicationLock() {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 120000;

  try {
    fs.mkdirSync(path.dirname(PUBLICATION_LOCK_FILE), { recursive: true });
  } catch (error) {
    throw new CliError('PUBLICATION_LOCK_FAILED', `Unable to prepare the workflow lock: ${error.message}`);
  }

  while (true) {
    let descriptor;
    try {
      descriptor = fs.openSync(PUBLICATION_LOCK_FILE, 'wx', 0o600);
      fs.writeFileSync(descriptor, token);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return () => {
        try {
          if (fs.readFileSync(PUBLICATION_LOCK_FILE, 'utf8') === token) {
            fs.unlinkSync(PUBLICATION_LOCK_FILE);
          }
        } catch (_) {}
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) {}
        try { fs.unlinkSync(PUBLICATION_LOCK_FILE); } catch (_) {}
      }
      if (error.code !== 'EEXIST') {
        throw new CliError('PUBLICATION_LOCK_FAILED', `Unable to acquire the workflow lock: ${error.message}`);
      }
    }

    try {
      const contents = fs.readFileSync(PUBLICATION_LOCK_FILE, 'utf8');
      if (!lockOwnerIsAlive(contents)) {
        try { fs.unlinkSync(PUBLICATION_LOCK_FILE); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        continue;
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new CliError('PUBLICATION_LOCK_FAILED', `Unable to inspect the workflow lock: ${error.message}`);
    }

    if (Date.now() >= deadline) {
      throw new CliError('PUBLICATION_LOCK_TIMEOUT', 'Timed out waiting for another workflow operation to finish.');
    }
    await sleep(50);
  }
}

async function withPublicationLock(action) {
  const release = await acquirePublicationLock();
  try {
    return await action();
  } finally {
    release();
  }
}

function requireToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !token.trim()) {
    throw new CliError('GITHUB_TOKEN_REQUIRED', 'GITHUB_TOKEN must be set for this GitHub operation.');
  }
  return token;
}

async function githubRequest(method, endpoint, options = {}) {
  const token = requireToken();
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'github-release-manager',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, { method, headers, body });
  } catch (error) {
    throw new CliError('GITHUB_REQUEST_FAILED', `GitHub request failed: ${error.message}`);
  }

  let data = null;
  const text = await response.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }

  if (!response.ok) {
    if (options.allow404 && response.status === 404) return null;
    const detail = data && typeof data === 'object' && data.message ? data.message : (text || response.statusText);
    throw new CliError('GITHUB_ERROR', `GitHub request failed (${response.status}): ${detail}`);
  }
  return data;
}

function repoPath(repository) {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      throw new CliError('INVALID_ARGUMENT', `Unexpected argument: ${argument}`);
    }
    const equals = argument.indexOf('=');
    if (equals >= 0) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1);
      continue;
    }
    const key = argument.slice(2);
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
      throw new CliError('MISSING_ARGUMENT_VALUE', `Missing value for --${key}.`);
    }
    options[key] = args[index + 1];
    index += 1;
  }
  return options;
}

function requireOnlyOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new CliError('INVALID_ARGUMENT', `Unsupported option: --${key}`);
  }
}

function requireRepository(state) {
  if (!state.repository) throw new CliError('NOT_CONFIGURED', 'No GitHub repository is configured.');
  return state.repository;
}

function formatGitHubRepository(data) {
  const fullName = data.full_name;
  const parts = String(fullName || '').split('/');
  return {
    name: fullName,
    fullName,
    owner: parts[0],
    repo: parts.slice(1).join('/'),
    defaultBranch: data.default_branch,
    url: data.html_url || `https://github.com/${fullName}`
  };
}

async function configure(args) {
  const options = parseOptions(args);
  requireOnlyOptions(options, ['repo']);
  const requested = options.repo;
  if (!requested || !/^[^/\s]+\/[^/\s]+$/.test(requested)) {
    throw new CliError('INVALID_REPOSITORY', 'The --repo value must be in owner/name form.');
  }
  const [owner, repo] = requested.split('/');
  const data = await githubRequest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (!data || !data.full_name || !data.default_branch) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub did not return a repository name and default branch.');
  }
  const repository = formatGitHubRepository(data);
  const state = {
    ...emptyState(),
    status: 'configured',
    repository
  };
  writeState(state);
  return { status: 'configured', repository };
}

async function listAll(endpoint) {
  const output = [];
  for (let page = 1; ; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const data = await githubRequest('GET', `${endpoint}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned an invalid paginated response.');
    output.push(...data);
    if (data.length < 100) break;
  }
  return output;
}

async function resolveDefaultBranchHead(repository) {
  const data = await githubRequest(
    'GET',
    `${repoPath(repository)}/commits/${encodeURIComponent(repository.defaultBranch)}`
  );
  if (!data || typeof data.sha !== 'string' || !data.sha) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub did not return the default-branch head SHA.');
  }
  return { sha: data.sha, url: data.html_url || null };
}

function invalidCommitEvidence() {
  throw new CliError(
    'INVALID_GITHUB_RESPONSE',
    'GitHub returned comparison commit data without a valid SHA, title, or URL.'
  );
}

async function compareCommits(repository, tag, headSha) {
  const endpoint = `${repoPath(repository)}/compare/${encodeURIComponent(tag)}...${encodeURIComponent(headSha)}`;
  const commits = [];
  const seen = new Set();

  for (let page = 1; ; page += 1) {
    const data = await githubRequest('GET', `${endpoint}?per_page=100&page=${page}`);
    if (!data || !Array.isArray(data.commits)) {
      throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned invalid comparison data.');
    }
    for (const commit of data.commits) {
      if (!commit || typeof commit !== 'object' || Array.isArray(commit)) invalidCommitEvidence();
      if (typeof commit.sha !== 'string' || !commit.sha.trim()) invalidCommitEvidence();
      if (!commit.commit || typeof commit.commit !== 'object' || Array.isArray(commit.commit)) invalidCommitEvidence();
      if (typeof commit.commit.message !== 'string') invalidCommitEvidence();
      const title = commit.commit.message.split(/\r?\n/, 1)[0].trim();
      if (!title) invalidCommitEvidence();
      if (typeof commit.html_url !== 'string' || !commit.html_url.trim()) invalidCommitEvidence();

      if (!seen.has(commit.sha)) {
        seen.add(commit.sha);
        commits.push({
          sha: commit.sha,
          title,
          url: commit.html_url
        });
      }
    }
    if (data.commits.length < 100) break;
  }
  return commits;
}

function validateSelectedPullRequest(pull) {
  if (!pull || typeof pull !== 'object' || Array.isArray(pull)) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned invalid pull-request evidence.');
  }
  if (!Number.isSafeInteger(pull.number) || pull.number <= 0) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned pull-request evidence without a valid number.');
  }
  if (typeof pull.title !== 'string' || !pull.title.trim()) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned pull-request evidence without a valid title.');
  }
  if (typeof pull.html_url !== 'string' || !pull.html_url.trim()) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned pull-request evidence without a valid URL.');
  }
}

async function scan() {
  const state = readState();
  const repository = requireRepository(state);
  const releases = await listAll(`${repoPath(repository)}/releases`);
  const candidates = releases
    .filter(release => !release.draft && release.published_at)
    .sort((left, right) => new Date(right.published_at).getTime() - new Date(left.published_at).getTime());
  if (candidates.length === 0) {
    throw new CliError('BASELINE_RELEASE_NOT_FOUND', 'No published, non-draft baseline release was found.');
  }

  const release = candidates[0];
  const baselineTime = new Date(release.published_at);
  if (!release.tag_name || Number.isNaN(baselineTime.getTime())) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'The baseline release has invalid tag or publication data.');
  }

  const head = await resolveDefaultBranchHead(repository);
  const scannedAt = new Date().toISOString();
  const scanLimit = new Date(scannedAt).getTime();
  const commits = await compareCommits(repository, release.tag_name, head.sha);
  const pulls = await listAll(`${repoPath(repository)}/pulls?state=closed&base=${encodeURIComponent(repository.defaultBranch)}&sort=updated&direction=desc`);
  const pullRequests = [];

  for (const pull of pulls) {
    if (!pull || typeof pull !== 'object' || Array.isArray(pull)) {
      throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned invalid pull-request data.');
    }
    if (pull.merged_at == null) continue;
    if (typeof pull.merged_at !== 'string' || Number.isNaN(new Date(pull.merged_at).getTime())) {
      throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned a pull request with an invalid merge timestamp.');
    }
    const merged = new Date(pull.merged_at).getTime();
    if (merged <= baselineTime.getTime() || merged > scanLimit) continue;

    validateSelectedPullRequest(pull);
    pullRequests.push({
      number: pull.number,
      title: pull.title,
      mergedAt: pull.merged_at,
      url: pull.html_url
    });
  }

  const evidenceLinks = [];
  for (const item of [...commits, ...pullRequests]) {
    if (!evidenceLinks.includes(item.url)) evidenceLinks.push(item.url);
  }
  const assessment = {
    releaseWorthy: commits.length > 0 || pullRequests.length > 0,
    rationale: `Found ${commits.length} commit${commits.length === 1 ? '' : 's'} and ${pullRequests.length} merged pull request${pullRequests.length === 1 ? '' : 's'} since the baseline release.`,
    evidenceLinks
  };
  const scanRecord = {
    baseline: {
      tag: release.tag_name,
      publishedAt: release.published_at,
      url: release.html_url
    },
    headSha: head.sha,
    headUrl: head.url,
    scannedAt,
    commits,
    pullRequests,
    assessment
  };
  state.status = 'scanned';
  state.scan = scanRecord;
  state.pack = null;
  state.approval = null;
  state.rejection = null;
  state.publication = null;
  writeState(state);
  return { status: 'scanned', repository, scan: scanRecord };
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function bumpedVersion(tag, bump) {
  const raw = tag.startsWith('v') ? tag.slice(1) : tag;
  const match = SEMVER.exec(raw);
  if (!match) throw new CliError('INVALID_BASELINE_VERSION', `Baseline tag "${tag}" is not a valid semantic version.`);
  let major = BigInt(match[1]);
  let minor = BigInt(match[2]);
  let patch = BigInt(match[3]);
  if (bump === 'major') {
    major += 1n;
    minor = 0n;
    patch = 0n;
  } else if (bump === 'minor') {
    minor += 1n;
    patch = 0n;
  } else if (!match[4]) {
    patch += 1n;
  }
  return `${major.toString()}.${minor.toString()}.${patch.toString()}`;
}

function activityMarkdown(version, scanRecord) {
  const lines = [`## ${version}`, '', `Changes since ${scanRecord.baseline.tag}:`];
  if (scanRecord.commits.length) {
    lines.push('', '### Commits');
    for (const commit of scanRecord.commits) lines.push(`- [${commit.sha.slice(0, 7)}](${commit.url}) ${commit.title}`);
  }
  if (scanRecord.pullRequests.length) {
    lines.push('', '### Merged pull requests');
    for (const pull of scanRecord.pullRequests) lines.push(`- [#${pull.number}](${pull.url}) ${pull.title}`);
  }
  return lines.join('\n');
}

async function prepare(args) {
  const options = parseOptions(args);
  requireOnlyOptions(options, ['bump']);
  if (!['patch', 'minor', 'major'].includes(options.bump)) {
    throw new CliError('INVALID_BUMP', 'The --bump value must be patch, minor, or major.');
  }
  const state = readState();
  const repository = requireRepository(state);
  if (!state.scan) throw new CliError('SCAN_REQUIRED', 'A scan is required before preparing a release.');
  if (!state.scan.assessment || state.scan.assessment.releaseWorthy !== true) {
    throw new CliError('RELEASE_NOT_WORTHY', 'The current scan is not release-worthy.');
  }
  const version = bumpedVersion(state.scan.baseline.tag, options.bump);
  const notes = activityMarkdown(version, state.scan);
  const pack = {
    version,
    changelog: notes,
    githubReleaseNotes: notes,
    announcement: `${repository.name} version ${version} is ready for release.`,
    evidenceLinks: [...state.scan.assessment.evidenceLinks]
  };
  state.status = 'prepared';
  state.pack = pack;
  state.approval = null;
  state.rejection = null;
  state.publication = null;
  writeState(state);
  return { status: 'prepared', pack };
}

async function approve(args) {
  const options = parseOptions(args);
  requireOnlyOptions(options, ['approver']);
  if (typeof options.approver !== 'string' || !options.approver.trim()) {
    throw new CliError('INVALID_APPROVER', 'A non-empty --approver identity is required.');
  }
  const state = readState();
  if (!state.pack) throw new CliError('PACK_REQUIRED', 'A prepared release pack is required before approval.');
  if (state.rejection) throw new CliError('PACK_REJECTED', 'The prepared pack has already been rejected.');
  if (state.approval) throw new CliError('ALREADY_APPROVED', 'The prepared pack has already been approved.');
  const approval = { identity: options.approver, approvedAt: new Date().toISOString() };
  state.status = 'approved';
  state.approval = approval;
  writeState(state);
  return { status: 'approved', approval, pack: state.pack };
}

async function reject(args) {
  const options = parseOptions(args);
  requireOnlyOptions(options, []);
  const state = readState();
  if (!state.pack) throw new CliError('PACK_REQUIRED', 'A prepared release pack is required before rejection.');
  if (state.approval) throw new CliError('PACK_APPROVED', 'The prepared pack has already been approved.');
  if (state.rejection) throw new CliError('ALREADY_REJECTED', 'The prepared pack has already been rejected.');
  const rejection = { rejectedAt: new Date().toISOString() };
  state.status = 'rejected';
  state.rejection = rejection;
  writeState(state);
  return { status: 'rejected', rejection, pack: state.pack };
}

function intendedPayload(state) {
  return {
    tag_name: `v${state.pack.version}`,
    name: `v${state.pack.version}`,
    target_commitish: state.repository.defaultBranch,
    body: state.pack.githubReleaseNotes,
    draft: false,
    prerelease: true
  };
}

function publishingRecord(state, payload, attemptedAt) {
  return {
    status: 'publishing',
    version: state.pack.version,
    tag: payload.tag_name,
    attemptedPayload: payload,
    attemptTimestamp: attemptedAt,
    approvingIdentity: state.approval.identity
  };
}

function validatePublishedRelease(release, payload) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub did not return a release object.');
  }
  if (release.id === undefined || release.id === null || release.id === '') {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub did not return a release ID.');
  }
  if (typeof release.html_url !== 'string' || !release.html_url) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub did not return a release URL.');
  }
  if (release.tag_name !== payload.tag_name) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned a release with an unexpected tag.');
  }
  if (release.name !== payload.name) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned a release with an unexpected name.');
  }
  if ((release.body == null ? '' : release.body) !== payload.body) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned a release with an unexpected body.');
  }
  if (Boolean(release.prerelease) !== Boolean(payload.prerelease)) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned a release with an unexpected prerelease setting.');
  }
  if (Boolean(release.draft) !== Boolean(payload.draft)) {
    throw new CliError('INVALID_GITHUB_RESPONSE', 'GitHub returned a release with an unexpected draft setting.');
  }
}

function successfulPublication(record, release) {
  validatePublishedRelease(release, record.attemptedPayload);
  return {
    ...record,
    status: 'succeeded',
    releaseId: release.id,
    releaseUrl: release.html_url,
    releaseName: release.name,
    name: release.name,
    body: release.body == null ? '' : release.body,
    prerelease: Boolean(release.prerelease),
    completedAt: new Date().toISOString()
  };
}

function failedPublication(record, message) {
  return {
    ...record,
    status: 'failed',
    failureMessage: message
  };
}

async function createPersistedRelease(state) {
  const publication = state.publication;
  try {
    const release = await githubRequest('POST', `${repoPath(state.repository)}/releases`, {
      body: publication.attemptedPayload
    });
    state.publication = successfulPublication(publication, release);
    state.status = 'succeeded';
    writeState(state);
    return { status: 'succeeded', publication: state.publication };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.publication = failedPublication(publication, message);
    state.status = 'failed';
    writeState(state);
    throw new CliError('PUBLICATION_FAILED', message);
  }
}

async function publish(args) {
  const options = parseOptions(args);
  requireOnlyOptions(options, []);
  return withPublicationLock(async () => {
    const state = readState();
    requireRepository(state);
    if (state.publication && state.publication.status === 'succeeded') {
      return { status: 'succeeded', publication: state.publication };
    }
    if (!state.pack) throw new CliError('PACK_REQUIRED', 'A prepared release pack is required before publication.');
    if (state.rejection) throw new CliError('PACK_REJECTED', 'A rejected release pack cannot be published.');
    if (!state.approval) throw new CliError('APPROVAL_REQUIRED', 'The prepared release pack must be approved before publication.');
    if (state.publication && ['publishing', 'failed'].includes(state.publication.status)) {
      throw new CliError('RECOVERY_REQUIRED', 'A previous publication attempt exists; run recover instead.');
    }
    requireToken();
    const payload = intendedPayload(state);
    state.publication = publishingRecord(state, payload, new Date().toISOString());
    state.status = 'publishing';
    writeState(state);
    return createPersistedRelease(state);
  });
}

function releaseMatches(release, payload) {
  return release.tag_name === payload.tag_name &&
    release.name === payload.name &&
    (release.body == null ? '' : release.body) === payload.body &&
    Boolean(release.prerelease) === Boolean(payload.prerelease);
}

async function recover(args) {
  const options = parseOptions(args);
  requireOnlyOptions(options, []);
  return withPublicationLock(async () => {
    const state = readState();
    requireRepository(state);
    if (!state.publication || !['publishing', 'failed'].includes(state.publication.status)) {
      throw new CliError('NOT_RECOVERABLE', 'There is no publishing or failed publication to recover.');
    }
    const payload = state.publication.attemptedPayload;
    if (!payload || !payload.tag_name) {
      throw new CliError('INVALID_PUBLICATION_RECORD', 'The persisted publication payload is missing.');
    }

    let existing;
    try {
      existing = await githubRequest(
        'GET',
        `${repoPath(state.repository)}/releases/tags/${encodeURIComponent(payload.tag_name)}`,
        { allow404: true }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.publication = failedPublication(state.publication, message);
      state.status = 'failed';
      writeState(state);
      throw new CliError('RECOVERY_FAILED', message);
    }

    if (existing) {
      if (!releaseMatches(existing, payload)) {
        const message = `A conflicting GitHub release already uses tag ${payload.tag_name}.`;
        state.publication = failedPublication(state.publication, message);
        state.publication.conflict = true;
        state.status = 'failed';
        writeState(state);
        throw new CliError('RELEASE_CONFLICT', message);
      }
      try {
        state.publication = successfulPublication(state.publication, existing);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.publication = failedPublication(state.publication, message);
        state.status = 'failed';
        writeState(state);
        throw new CliError('RECOVERY_FAILED', message);
      }
      state.status = 'succeeded';
      writeState(state);
      return { status: 'succeeded', publication: state.publication };
    }

    state.publication = {
      ...state.publication,
      status: 'publishing',
      attemptTimestamp: new Date().toISOString()
    };
    delete state.publication.failureMessage;
    delete state.publication.conflict;
    state.status = 'publishing';
    writeState(state);
    return createPersistedRelease(state);
  });
}

async function status(args) {
  const options = parseOptions(args);
  requireOnlyOptions(options, []);
  return publicState(readState());
}

async function main() {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case 'configure': return withPublicationLock(() => configure(args));
    case 'scan': return withPublicationLock(() => scan(args));
    case 'prepare': return withPublicationLock(() => prepare(args));
    case 'approve': return withPublicationLock(() => approve(args));
    case 'reject': return withPublicationLock(() => reject(args));
    case 'publish': return publish(args);
    case 'recover': return recover(args);
    case 'status': return status(args);
    default: throw new CliError('INVALID_COMMAND', command ? `Unknown command: ${command}` : 'A command is required.');
  }
}

main().then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(error => {
  const code = error instanceof CliError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
});
