# CI jobs for the reliability stack

`.github/workflows` belongs to the orchestrator. The jobs below call the reusable scripts in this directory, and each snippet is ready to paste. Actions are pinned by the SHAs ADR 0001 already lists; no new action is needed.

| Script               | Runs                                                                                                                                                                   | Blocking                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `restore-drill.sh`   | Backup and restore drill (`infra/drills/release-drill.sh`: row counts, key-table checksums, pgTAP smoke) on the stack `supabase db start` built, in the `database` job | Yes                                                              |
| `powersync-check.sh` | Sync rules against the migrated catalog; writes the publication SQL                                                                                                    | `continue-on-error` until the A17 rule fixes land, then blocking |
| `synthetics.sh`      | Synthetic checks against staging, the status history and the status page                                                                                               | Its own scheduled workflow; a failed run notifies on-call        |
| `backup-weekly.sh`   | Encrypted weekly logical backup of staging                                                                                                                             | Its own scheduled workflow; needs the owner's public key first   |
| `oasdiff.sh`         | Gate 20: breaking changes in the OpenAPI document since the latest `v*` tag                                                                                            | Yes; passes with a notice until the first tag                    |

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

## 4. `ci.yml`, new job `api-breaking-changes` (gate 20)

The job needs the tags, so it checks out the full history. Docker is preinstalled on `ubuntu-24.04`; the image is pinned by digest inside the script.

```yaml
api-breaking-changes:
  name: API breaking changes (gate 20, oasdiff)
  runs-on: ubuntu-24.04
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        fetch-depth: 0
        fetch-tags: true
    - name: oasdiff against the latest v* tag
      run: infra/ci/oasdiff.sh --format githubactions
```

`--format githubactions` turns each breaking change into an error annotation on the pull request. Before the first `v*` tag the step prints that there is no released baseline and passes.

## 5. New workflow `.github/workflows/publish-packages.yml`

Publishes `@xos/sdk` and `@xos/cli` to npm and `xos-sdk` to PyPI when a release tag `vX.Y.Z` is pushed. Nothing publishes from a branch or a pull request. The `verify` job checks that the tag equals the version in all three packages (`packages/sdk-ts/test/release.test.ts` keeps them equal on every push), runs their tests, builds them once and hands the exact archives to the publish jobs.

- **npm:** trusted publishing over OIDC, with provenance. `npm` 11.5 or later exchanges the job's OIDC token for a one-time publish token once the owner adds this repository and workflow as a trusted publisher of both packages on npmjs.com. Until then, the `NPM_TOKEN` secret (an automation token scoped to the `@xos` packages) is the fallback. Provenance is signed either way.
- **PyPI:** trusted publishing through `pypa/gh-action-pypi-publish`, so no PyPI secret exists. The owner registers a pending publisher for `xos-sdk` on pypi.org (owner `ghxstship`, repository `atlas`, workflow `publish-packages.yml`, environment `pypi`). The action also uploads PEP 740 attestations.
- **Environments:** `npm` and `pypi` are GitHub environments with the owner as required reviewer, so a pushed tag waits for one approval before anything leaves the repository.

```yaml
name: Publish packages

on:
  push:
    tags: ["v[0-9]+.[0-9]+.[0-9]+"]

permissions:
  contents: read

concurrency:
  group: publish-${{ github.ref_name }}
  cancel-in-progress: false

jobs:
  verify:
    name: Version, tests, build and pack
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: "3.12"
      - run: pnpm install --frozen-lockfile
      - name: Tag equals every package version
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          for manifest in packages/sdk-ts/package.json packages/cli/package.json; do
            ACTUAL="$(node -p "require('./${manifest}').version")"
            [ "$ACTUAL" = "$VERSION" ] || { echo "::error::${manifest} is ${ACTUAL}, tag is ${GITHUB_REF_NAME}"; exit 1; }
          done
          grep -qx "version = \"${VERSION}\"" packages/sdk-python/pyproject.toml || { echo "::error::pyproject.toml does not say ${VERSION}"; exit 1; }
      - run: pnpm turbo run test --filter=@xos/sdk --filter=@xos/cli --filter=@xos/sdk-python
      - name: Build and pack npm packages
        run: |
          pnpm --filter @xos/sdk build
          pnpm --filter @xos/cli build
          mkdir -p "$RUNNER_TEMP/npm"
          (cd packages/sdk-ts && pnpm pack --pack-destination "$RUNNER_TEMP/npm")
          (cd packages/cli && pnpm pack --pack-destination "$RUNNER_TEMP/npm")
          tar -tzf "$RUNNER_TEMP/npm/xos-cli-${GITHUB_REF_NAME#v}.tgz" | grep -q package/dist/main.js
      - name: Build Python distributions
        run: |
          python -m pip install build==1.3.0 twine==6.2.0
          python -m build packages/sdk-python --outdir "$RUNNER_TEMP/pypi"
          python -m twine check --strict "$RUNNER_TEMP/pypi"/*
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: npm-packages
          path: ${{ runner.temp }}/npm/*.tgz
          if-no-files-found: error
          retention-days: 30
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: python-distributions
          path: ${{ runner.temp }}/pypi/*
          if-no-files-found: error
          retention-days: 30

  npm:
    name: Publish to npm
    needs: verify
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    environment:
      name: npm
      url: https://www.npmjs.com/package/@xos/sdk
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "22.14.0"
          registry-url: https://registry.npmjs.org
      - run: npm install --global npm@11.21.0
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: npm-packages
          path: npm
      # The SDK first: the CLI depends on the exact SDK version.
      - name: Publish @xos/sdk and @xos/cli
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          publish() {
            if npm view "$1@${VERSION}" version >/dev/null 2>&1; then
              echo "$1@${VERSION} is already published; skipping."
            else
              npm publish "$2" --access public --provenance
            fi
          }
          publish @xos/sdk "npm/xos-sdk-${VERSION}.tgz"
          publish @xos/cli "npm/xos-cli-${VERSION}.tgz"

  pypi:
    name: Publish to PyPI
    needs: verify
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    environment:
      name: pypi
      url: https://pypi.org/project/xos-sdk/
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: python-distributions
          path: dist
      - uses: pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2
        with:
          packages-dir: dist
          skip-existing: true
```

A failed publish is safe to rerun with "Re-run failed jobs" on the same tag: both publish steps skip a version that already exists, so a rerun publishes only what is missing. A wrong release is never unpublished: release the next patch version instead (npm `deprecate` and PyPI "yank" mark the bad one).

Before the first tag, the owner confirms the names are theirs. Publishing under a new organization name is a Section 19.8 stop condition. The `@xos` scope on npm and the `xos-sdk` project on PyPI must belong to the owner's accounts.

## 6. Repository settings (orchestrator)

| Setting                                   | Value                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings, Pages, Source                   | Deploy from a branch: `gh-pages`, root                                                                                                                                         |
| Settings, Pages, Custom domain (optional) | `status.<domain>` with a CNAME record; no purchase needed for a subdomain of an owned domain                                                                                   |
| Settings, Variables (Actions)             | `XOS_STAGING_ATLAS_URL`, `XOS_STAGING_GATEWAY_URL`, `XOS_STAGING_SUPABASE_URL`, `XOS_STAGING_SUPABASE_ANON_KEY` (public by design), `XOS_STAGING_POWERSYNC_URL` once it exists |
| Settings, Secrets (Actions)               | `XOS_SYNTHETIC_EMAIL`, `XOS_SYNTHETIC_PASSWORD`, `XOS_ALERT_WEBHOOK_URL`, `STAGING_DB_URL`                                                                                     |
| Branch protection                         | Leave `status-data` and `gh-pages` unprotected so the workflow can force-push them; `main` is untouched                                                                        |

## Frequency and regions

Section 5.1 asks for checks every minute from five regions. GitHub Actions on the free tier gives every 5 minutes from one region (`us-east`, the primary region). A 1-minute, five-region check needs a paid monitoring service, so it is a blocked item for the owner. The checks are plain Node scripts with no dependencies, so any scheduler that runs Node 22 can run them per region with `XOS_SYNTHETICS_REGION` set.
