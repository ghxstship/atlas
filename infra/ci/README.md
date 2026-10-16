# CI jobs for the reliability stack

`.github/workflows` belongs to the orchestrator. The jobs below call the reusable scripts in this directory, and each snippet is ready to paste. Actions are pinned by the SHAs ADR 0001 already lists; no new action is needed.

| Script               | Runs                                                                                   | Blocking                                                         |
| -------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `restore-drill.sh`   | Backup and restore drill on the stack `supabase db start` built, in the `database` job | Yes                                                              |
| `powersync-check.sh` | Sync rules against the migrated catalog; writes the publication SQL                    | `continue-on-error` until the A17 rule fixes land, then blocking |
| `synthetics.sh`      | Synthetic checks against staging, the status history and the status page               | Its own scheduled workflow; a failed run notifies on-call        |
| `backup-weekly.sh`   | Encrypted weekly logical backup of staging                                             | Its own scheduled workflow; needs the owner's public key first   |

`@xos/infra`'s lint, typecheck and tests already run in the `checks` job through `pnpm verify`, since `infra` is in the workspace.

## 1. `ci.yml`, `database` job: append these steps after "Run pgTAP suites"

```yaml
- uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
  with:
    node-version-file: .nvmrc
- name: Backup and restore drill (Section 9)
  run: infra/ci/restore-drill.sh
- name: PowerSync readiness (sync rules against the schema)
  continue-on-error: true
  run: infra/ci/powersync-check.sh
```

Also raise `timeout-minutes` of the `database` job from 20 to 30. The drill adds about a minute, plus the image start.

## 2. New workflow `.github/workflows/synthetics.yml`

On a public repository, GitHub Actions minutes are free. Scheduled runs fire at most every 5 minutes, and GitHub may delay them under load. The page is served from the `gh-pages` branch, and the history lives on the `status-data` branch, so neither touches `main`.

```yaml
name: Synthetics

on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: synthetics
  cancel-in-progress: false

jobs:
  check:
    name: Synthetic checks and status page
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @xos/tokens build
      - name: Fetch status history
        run: |
          git fetch --depth 1 origin status-data || true
          mkdir -p "$RUNNER_TEMP/status-data"
          if git rev-parse --verify -q origin/status-data >/dev/null; then
            git show origin/status-data:history.json > "$RUNNER_TEMP/status-data/history.json"
          fi
      - name: Run checks and build the page
        id: run
        env:
          XOS_SYNTHETICS_REGION: us-east
          XOS_ATLAS_URL: ${{ vars.XOS_STAGING_ATLAS_URL }}
          XOS_GATEWAY_URL: ${{ vars.XOS_STAGING_GATEWAY_URL }}
          SUPABASE_URL: ${{ vars.XOS_STAGING_SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ vars.XOS_STAGING_SUPABASE_ANON_KEY }}
          XOS_POWERSYNC_URL: ${{ vars.XOS_STAGING_POWERSYNC_URL }}
          XOS_SYNTHETIC_EMAIL: ${{ secrets.XOS_SYNTHETIC_EMAIL }}
          XOS_SYNTHETIC_PASSWORD: ${{ secrets.XOS_SYNTHETIC_PASSWORD }}
          XOS_ALERT_WEBHOOK_URL: ${{ secrets.XOS_ALERT_WEBHOOK_URL }}
        run: infra/ci/synthetics.sh "$RUNNER_TEMP/status-data/history.json" "$RUNNER_TEMP/status-site"
      - name: Publish history and page
        if: always() && steps.run.outcome != 'skipped'
        run: |
          git config user.name "xos-synthetics"
          git config user.email "xos-synthetics@users.noreply.github.com"
          publish() {
            local branch="$1" dir="$2"
            local work="$RUNNER_TEMP/publish-$branch"
            rm -rf "$work" && mkdir -p "$work" && cp -R "$dir"/. "$work"/
            touch "$work/.nojekyll"
            git -C "$work" init -q -b "$branch"
            git -C "$work" add -A
            git -C "$work" -c user.name=xos-synthetics -c user.email=xos-synthetics@users.noreply.github.com commit -q -m "status: $(date -u +%Y-%m-%dT%H:%MZ)"
            git -C "$work" push -q --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$branch"
          }
          publish status-data "$RUNNER_TEMP/status-data"
          publish gh-pages "$RUNNER_TEMP/status-site"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The branches are force-pushed as single commits, so the repository does not grow with every run. The history file is the only state, and it keeps 90 days.

## 3. New workflow `.github/workflows/backup-weekly.yml`

```yaml
name: Weekly backup

on:
  schedule:
    - cron: "23 6 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  staging:
    name: Encrypted logical backup of staging
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: supabase/setup-cli@45a513f8c64c0bc8e0e3dfe572b5c95be85f6359 # v3.0.1
        with:
          version: 2.120.0
      - name: Dump and encrypt
        env:
          XOS_BACKUP_DB_URL: ${{ secrets.STAGING_DB_URL }}
        run: infra/ci/backup-weekly.sh staging "$RUNNER_TEMP/backup"
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: xos-staging-backup
          path: ${{ runner.temp }}/backup/*.gpg
          retention-days: 35
          if-no-files-found: error
```

This job fails on purpose until the owner commits `infra/backup/backup-public-key.asc` and the orchestrator adds the `STAGING_DB_URL` secret. Artifacts count against the free 500 MB artifact storage of the account; a staging dump is well under it at 35 days' retention.

## 4. Repository settings (orchestrator)

| Setting                                   | Value                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings, Pages, Source                   | Deploy from a branch: `gh-pages`, root                                                                                                                                         |
| Settings, Pages, Custom domain (optional) | `status.<domain>` with a CNAME record; no purchase needed for a subdomain of an owned domain                                                                                   |
| Settings, Variables (Actions)             | `XOS_STAGING_ATLAS_URL`, `XOS_STAGING_GATEWAY_URL`, `XOS_STAGING_SUPABASE_URL`, `XOS_STAGING_SUPABASE_ANON_KEY` (public by design), `XOS_STAGING_POWERSYNC_URL` once it exists |
| Settings, Secrets (Actions)               | `XOS_SYNTHETIC_EMAIL`, `XOS_SYNTHETIC_PASSWORD`, `XOS_ALERT_WEBHOOK_URL`, `STAGING_DB_URL`                                                                                     |
| Branch protection                         | Leave `status-data` and `gh-pages` unprotected so the workflow can force-push them; `main` is untouched                                                                        |

## Frequency and regions

Section 5.1 asks for checks every minute from five regions. GitHub Actions on the free tier gives every 5 minutes from one region (`us-east`, the primary region). A 1-minute, five-region check needs a paid monitoring service, so it is a blocked item for the owner. The checks are plain Node scripts with no dependencies, so any scheduler that runs Node 22 can run them per region with `XOS_SYNTHETICS_REGION` set.
