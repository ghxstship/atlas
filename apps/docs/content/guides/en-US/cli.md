---
title: The xos CLI
summary: Sign in, switch organizations, call any operation, import and export rows, validate canon codes and test webhooks from a terminal.
section: tools
order: 9
---

`xos` is the command line for the public API. Every operation in the reference is a command, and its output is JSON in scripts and a table in a terminal.

## Sign in

```bash
export XOS_API_KEY="xos_live_..."
xos auth login --base-url https://atlas.example.com/api/v1 --profile northwind
xos auth status
```

The key is read from `XOS_API_KEY` or piped in with `--key-stdin`, never typed as a flag, so it stays out of shell history. `xos` checks the key, then saves it as a profile in `~/.config/xos/config.json`, readable only by you.

## Choose an organization

An API key belongs to one organization, so each organization is one profile.

```bash
xos org list              # saved profiles; the current one is marked
xos org use client-b      # make another profile the default
xos org list --remote     # organizations visible to the current key
xos projects list --profile client-b   # one command against another profile
```

In CI, set `XOS_API_KEY` and `XOS_BASE_URL` and skip `auth login`.

## Call operations

```bash
xos resources --tag Finance                     # resources and their operations
xos ops purchase-orders                         # one resource's operations
xos projects list --filter project_state.eq=Active --sort -created_at --limit 20
xos projects list --all --fields id,name --output json
xos projects get 0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f
xos projects update 0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f --data '{"name":"Fall Series"}' --if-match auto
xos call purchaseOrders.approve 0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f --data @approval.json
```

`--data` takes inline JSON, `@file` or `-` for standard input. `--if-match auto` reads the current ETag first; pass a real ETag to guard against concurrent edits.

## Import and export

```bash
xos import projects --file projects.csv --dry-run
xos import projects --file projects.csv
xos export projects --format csv --out projects.csv --filter project_state.eq=Active
```

Row imports send each row to the resource's create operation with an Idempotency-Key derived from the file and the row, so rerunning after a failure skips rows already imported. Empty CSV cells are sent as null. Use NDJSON when columns need numbers or booleans.

Server-side imports from an uploaded spreadsheet use import jobs: `xos import job create --data @job.json`, then `xos import job dry-run <id>`, `xos import job commit <id>`, and `xos import undo <batch-id>` to reverse a batch.

## Validate canon codes

```bash
xos canon validate --file budget-lines.csv
```

Every column named after a canon identifier, such as `dept_code`, `phase_code` or `cat_urid`, is checked against the live canon. Map other columns with `--column dept=canonDepartments`.

## Test webhooks

See [Webhooks](guide:webhooks) for `xos webhooks send`, `verify`, `events` and `replay`.

## Exit codes

| Code | Meaning                                |
| ---- | -------------------------------------- |
| 0    | Success                                |
| 1    | The request failed                     |
| 2    | The command was used incorrectly       |
| 3    | Not signed in, or the key was rejected |
| 4    | Not found                              |
| 5    | Refused; the reason is printed         |
