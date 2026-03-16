# Issue Engine

Issue Engine is a standalone orchestration controller for GitHub issue backlogs. It syncs issues from any configured repository, infers dependency edges, selects ready work, creates isolated git worktrees, and runs separate Codex planning, review, implementation, and optional repair flows.

The controller is generic by design:

- No repo owner, name, path, branch, labels, or validation commands are hard-coded in the core.
- State lives in this orchestrator project, not inside target repositories.
- Target repo interaction uses documented/scriptable surfaces only: `gh`, `git worktree`, and `codex exec`.

## Features

- SQLite-backed issue, dependency, run, lock, worktree, PR, and review-comment state
- Per-repo profiles in `config/repos/*.json`
- Deterministic dependency parsing with optional LLM normalization
- Ready-queue scheduling with concurrency, lock leases, and blocker checks
- Dedicated per-issue worktrees and configurable branch naming
- Separate planner, reviewer, reconciler, and implementer phases
- Repo-driven validation command selection, including path-based rules
- Draft PR creation and optional PR watching for conflicts/comments
- Dry-run mode that avoids target-repo mutation

## Project Layout

```text
.
├── config/
│   ├── capacity.json
│   └── repos/
│       └── sample.json
├── prompts/
│   ├── implementer.md
│   ├── planner.md
│   └── reviewer.md
├── schemas/
│   ├── dependency-normalization.schema.json
│   ├── implementer-output.schema.json
│   ├── planner-output.schema.json
│   └── reviewer-output.schema.json
├── src/
│   ├── cli.ts
│   ├── codex.ts
│   ├── config.ts
│   ├── db.ts
│   ├── github.ts
│   ├── issue-graph.ts
│   ├── locks.ts
│   ├── logging.ts
│   ├── pipeline.ts
│   ├── prompting.ts
│   ├── prs.ts
│   ├── repo-profile.ts
│   ├── scheduler.ts
│   ├── shell.ts
│   ├── types.ts
│   ├── validation.ts
│   ├── watchers.ts
│   └── worktrees.ts
├── tests/
└── state/
```

## Requirements

- Node 20+
- `gh` CLI installed and authenticated
- `git` with `worktree` support
- `codex` CLI installed and available on `PATH`

## Setup

```bash
npm install
npm run build
npm test
npm run doctor
npm run init
```

Optional environment variables are documented in `.env.example`.

## Repo Profiles

Each target repository gets its own JSON profile under `config/repos/<profile>.json`.

For private local profiles that should not be committed, use `config/repos/<profile>.local.json`.
`*.local.json` repo profiles are loaded automatically and are ignored by Git.

Required profile fields:

- GitHub owner and repo
- Local repo path
- Worktree root path
- Default branch
- Concurrency
- Model policy per phase
- Reasoning effort per phase
- Validation rules
- Label-to-priority mappings
- Epic labels, skip labels, and optional meta labels
- Branch naming template
- PR title/body templates
- Optional manual dependency overrides

The included `config/repos/sample.json` is a template only. Copy it and replace the placeholders with real values.

## Capacity Gate

Issue Engine can optionally stop claiming or starting new real work when your remaining capacity drops below a threshold.

- Tracked default config: `config/capacity.json`
- Private override: `config/capacity.local.json`
- Default intent: run a status command, parse remaining or used percent from its text output, and block new work when remaining capacity is below `minRemainingPercent`

This is generic on purpose. The current public Codex CLI surface in this environment does not expose a dedicated structured “7d remaining capacity” endpoint, so the gate is implemented as a configurable command plus regex-based parsing.

The shipped `config/capacity.json` is disabled by default. To enable it privately, create `config/capacity.local.json` and adjust the command and patterns to match the actual output you see on your machine.

### Command security migration

- Validation and capacity commands now support a safe structured form:
  ```json
  { "command": "npm", "args": ["test", "--", "--runInBand"] }
  ```
- Legacy string commands are still accepted for backward compatibility, but they are parsed and validated to reject shell metacharacters and injection-like syntax before execution.
- `codex` invocations no longer receive `--dangerously-bypass-approvals-and-sandbox` by default. Set profile-level `codex.allowBypassApprovalsAndSandbox: true` to opt in.
- Audit metadata records whether opt-in bypass is enabled on a run.

Detailed setup instructions are in [docs/7d-capacity-guard.md](/Users/nishant/Documents/GitHub/Issue-Engine/docs/7d-capacity-guard.md).

## Commands

```bash
npx tsx src/cli.ts doctor
npx tsx src/cli.ts check-capacity
npx tsx src/cli.ts init
npx tsx src/cli.ts sync-issues --profile <name>
npx tsx src/cli.ts build-graph --profile <name>
npx tsx src/cli.ts list-ready --profile <name>
npx tsx src/cli.ts claim-next --profile <name>
npx tsx src/cli.ts run-once --profile <name> [--issue 123] [--dry-run]
npx tsx src/cli.ts run-worker --profile <name> [--issue 123] [--interval-ms 30000] [--parallel 1] [--max-runs N] [--dry-run]
npx tsx src/cli.ts watch-prs --profile <name>
npx tsx src/cli.ts release-lock --profile <name> --issue 123
npx tsx src/cli.ts show-issue --profile <name> --issue 123
```

`run-worker` runs continuously in a poll loop and supports multiple in-process workers:

- Claims queued runs first, with `repair` phase runs prioritized first.
- Falls back to ready-issue scheduling once the queue is empty.
- Honors profile-level concurrency and lock semantics before claiming each work item.
- Respects `--issue` for single-issue mode.
- Stops on `SIGINT`/`SIGTERM` or when `--max-runs` is reached.
- Multiple workers for the same profile are allowed, but all workers share the same DB-backed lock and capacity checks, so only valid unique issue work can proceed.

Defaults:

- `--interval-ms`: `30000`
- `--parallel`: `1`
- `--max-runs`: unlimited when omitted

Notes:

- `watch-prs` continues to enqueue `repair` runs; `run-worker` is now the execution side for queued runs.
- `run-once` remains manual/single-shot and still starts at most one run per invocation.

Package scripts:

```bash
npm run doctor
npm run init
npm run build
npm test
```

## Safety Model

- The orchestrator stores DB state, logs, locks, run transcripts, and prompt artifacts in this project directory.
- Dry-run mode does not create worktrees, commit, push, or open real PRs.
- Capacity gating only blocks new real work. Dry-run execution remains available.
- Validation commands are profile-driven, not controller-driven.
- Uncertain LLM-inferred dependency edges do not block scheduling unless their confidence clears the configured threshold.
- The implementer prompt instructs Codex to honor any target-repo `AGENTS.md` file if present.
- No destructive git commands are used.

## Dry-Run Flow

`run-once --dry-run` still performs:

- issue sync
- dependency graph rebuild
- ready issue selection
- lock acquisition
- prompt rendering
- planner/reviewer/implementer dry-run output generation
- validation command selection
- PR metadata generation

It does not mutate a target repository.

## PR Watching

`watch-prs` polls orchestrator-created PRs recorded in the local SQLite state. It updates merge-state/comment state and queues `repair` runs when it sees:

- merge conflicts
- unresolved review threads
- reviews requesting changes

## Limitations

- Issue sync currently pulls up to 500 open issues per invocation.
- The default implementation uses polling, not webhooks.
- Reconciliation is deterministic in the MVP instead of using a fourth model pass.
- Dry-run mode exercises the pipeline without validating against a live target repo checkout.
- Capacity parsing depends on the configured command output; if the output format changes, update the regex patterns in the capacity config.
