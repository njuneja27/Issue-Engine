# 7d Capacity Guard

This project can stop claiming or starting new real work when your Codex 7-day capacity drops below a threshold.

The guard is intentionally local-only:

- Public default config lives in `config/capacity.json` and ships disabled.
- Private override lives in `config/capacity.local.json` and is ignored by Git.

## What The Guard Expects

The guard runs a local command and parses its text output.

It looks for the `7d limit:` section first when `windowLabel` is set to `7d`, then extracts the percent from lines like:

```text
7d limit:
████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░
51% left
(resets Mar 18)
```

It also supports generic fallback patterns like:

- `51% left`
- `51% remaining`
- `49% used`

## Local Setup

Create `config/capacity.local.json`:

```json
{
  "enabled": true,
  "command": "/absolute/path/to/your/status-wrapper.sh",
  "minRemainingPercent": 5,
  "blockNewWork": true,
  "failOpen": true,
  "windowLabel": "7d"
}
```

Recommended meanings:

- `enabled`: turns the guard on
- `command`: local command that prints the status text
- `minRemainingPercent`: stop new work if remaining capacity is below this number
- `blockNewWork`: if `true`, blocks `claim-next` and non-dry-run `run-once`
- `failOpen`: if parsing fails, do not block work
- `windowLabel`: scope parsing to the `7d limit:` block

## Wrapper Command

The orchestrator does not assume a built-in Codex CLI command exists for `/status`.
Use any local wrapper that prints the status text in the same format you see in the app.

Minimal wrapper contract:

- exit code `0`
- write the status text to stdout
- include the `7d limit:` block if possible

Example shape:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Replace this with however you obtain the slash-command status output locally.
cat <<'EOF'
Session:
019cf77d-4e8c-7ec1-8d29-1b119d86a91e
Context:
52% left (124,478 used / 258K)
5h limit:
██████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░
45% left
(resets 2:13 PM)
7d limit:
████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░
51% left
(resets Mar 18)
EOF
```

## Verifying The Guard

Check the parsed result directly:

```bash
npx tsx src/cli.ts check-capacity
```

Expected output shape:

```json
{
  "enabled": true,
  "available": true,
  "remainingPercent": 51,
  "thresholdPercent": 5,
  "shouldBlockNewWork": false,
  "windowLabel": "7d"
}
```

## When The Guard Applies

The capacity gate affects:

- `claim-next`
- non-dry-run `run-once`

It does not affect:

- `sync-issues`
- `build-graph`
- `list-ready`
- `show-issue`
- `run-once --dry-run`
