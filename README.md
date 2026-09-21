# Release Manager

Two projects, one workflow:

- **`release-manager-v2/`** — the CLI engine. Turns GitHub activity into a
  controlled, evidence-backed release workflow: `configure`, `scan`,
  `prepare`, `approve`, `reject`, `publish`, `recover`, `status`. Persists
  its own state to `.release-manager.json` (gitignored — runtime state,
  not source).
- **`release-manager-review-ui/`** — a thin local web console that wraps
  the CLI above. It never reimplements any release-workflow logic; every
  action (`configure`/`scan`/`prepare`/`recover`/`approve`/`reject`/
  `publish`) invokes the real CLI as a subprocess (`../release-manager-v2`,
  a relative path — keep the two directories as siblings) and surfaces the
  actual result, success or failure. Every action is appended to a local
  append-only audit log (`audit-log.jsonl`, gitignored — also runtime
  state).

Both were built through [Shipyard](https://github.com/TalhaUsman5/Shipyard)
— a phase-graph LLM orchestration harness — not written by hand. See that
repo's `ROADMAP.md` for the build history and the sessions that produced
these two projects.

## Setup

Each project is independent (`npm install` in each), Node's built-in
`node --test` runner, no external dependencies in either.

```bash
cd release-manager-v2 && npm install
cd ../release-manager-review-ui && npm install
```

`release-manager-v2` needs `GITHUB_TOKEN` in the environment for any
command that talks to GitHub (everything except `status`). A fine-grained
GitHub PAT scoped to just the target repository, with **Contents:
Read and write** (this also covers releases) and **Pull requests:
Read-only**, is enough.

## Running the CLI directly

```bash
cd release-manager-v2
node release-manager.js configure --repo <owner>/<repo>
node release-manager.js scan
node release-manager.js prepare --bump patch   # or minor / major
node release-manager.js approve --approver "Your Name"
node release-manager.js publish
node release-manager.js status
```

`reject` and `recover` are also available — see `node release-manager.js
status` for the current workflow state at any point, and each command's
own error output for exactly why a step can't proceed (an unreviewed pack
can't publish, a rejected pack is terminal, etc.).

## Running the review console

```bash
cd release-manager-review-ui
GITHUB_TOKEN=... REVIEW_UI_USERNAME=... REVIEW_UI_PASSWORD=... PUBLIC_ORIGIN=http://127.0.0.1:3000 node server.js
```

`GITHUB_TOKEN`, `REVIEW_UI_USERNAME`, `REVIEW_UI_PASSWORD`, and
`PUBLIC_ORIGIN` are all required — the server fails fast at startup if
any is missing. Every route requires HTTP Basic Auth
(`REVIEW_UI_USERNAME`/`REVIEW_UI_PASSWORD`), and every request's `Host`
header must match either `PUBLIC_ORIGIN` or `http://127.0.0.1:<port>`
(the loopback exception always applies, for local development).

Serves on `http://127.0.0.1:3000` by default — a status page, one
form/button per CLI action, and `/audit` for the run history.
`LISTEN_HOST` and `PORT` are optional overrides for hosting behind a
platform that requires binding to `0.0.0.0` (see "Hosting" below).

### Hosting

Two deploy targets are provided; both are optional and the app doesn't
care which one runs it.

**Render (`render.yaml`) — deployed here, no payment method required.**
A [Render](https://render.com) Blueprint connects directly to this
GitHub repo (Render dashboard → New → Blueprint), auto-detects
`render.yaml`, and deploys on the free tier. Render injects `PORT`
itself; `LISTEN_HOST=0.0.0.0` in the blueprint is what makes the app
actually bind to it. `GITHUB_TOKEN`, `REVIEW_UI_USERNAME`,
`REVIEW_UI_PASSWORD`, and `PUBLIC_ORIGIN` are marked `sync: false` in
the blueprint — set their real values in the Render dashboard's
Environment tab, never in the repo. `PUBLIC_ORIGIN` can only be set
correctly *after* the first deploy, once Render assigns the
`*.onrender.com` URL.

**Known limitations on Render's free tier:**
- No persistent disk on the free plan — both `.release-manager.json`
  (workflow state) and `audit-log.jsonl` (audit trail) live in the
  container's own filesystem and are expected to reset on every
  redeploy. Whether they also reset on the free tier's idle
  spin-down/spin-up cycle (distinct from a redeploy) is unverified —
  confirm this live once deployed rather than assuming either way.
- Free-tier services spin down after a period of inactivity and take a
  few seconds to spin back up on the next request (a visible delay on
  the first hit after idling, not a failure).

**Fly.io (`Dockerfile`, `.dockerignore`, `fly.toml`) — the alternative,
if a payment method is acceptable.** Fly requires a card on file even
for free-tier-eligible usage. `fly.toml` sets `LISTEN_HOST=0.0.0.0` and
points the CLI's state file (`RELEASE_MANAGER_STATE_FILE`) at a mounted
persistent volume, so workflow state (though still not the audit log —
same limitation as above, no path override exists yet) survives
redeploys, unlike Render's free tier. Secrets are set with `fly secrets
set` against the deployed app, never committed.

A future Shipyard feature request could add an `AUDIT_LOG_PATH`
override, following the same pattern as `RELEASE_MANAGER_STATE_FILE`,
to close this gap on both platforms.

## Tests

```bash
cd release-manager-v2 && npm test
cd ../release-manager-review-ui && npm test
```

Both suites run entirely against mocked GitHub/subprocess boundaries — no
real network access or GitHub credentials required to run them.
To learn more about shipyard, go to: https://github.com/TalhaUsman5/Shipyard/blob/main/shipyard_dossier.html
