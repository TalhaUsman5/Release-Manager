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
GITHUB_TOKEN=... node server.js
```

Serves on `http://127.0.0.1:3000` — a status page, one form/button per
CLI action, and `/audit` for the run history. Loopback-only by design (no
external network exposure), with an origin check on every action route to
reject cross-origin requests from another page.

## Tests

```bash
cd release-manager-v2 && npm test
cd ../release-manager-review-ui && npm test
```

Both suites run entirely against mocked GitHub/subprocess boundaries — no
real network access or GitHub credentials required to run them.
