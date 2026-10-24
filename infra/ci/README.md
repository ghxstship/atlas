# CI jobs for the reliability stack

`.github/workflows` belongs to the orchestrator. The jobs below call the reusable scripts in this directory, and each snippet is ready to paste. Actions are pinned by the SHAs ADR 0001 already lists; no new action is needed.

| Script               | Runs                                                                                                                                                                   | Blocking                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `restore-drill.sh`   | Backup and restore drill (`infra/drills/release-drill.sh`: row counts, key-table checksums, pgTAP smoke) on the stack `supabase db start` built, in the `database` job | Yes                                                              |
| `powersync-check.sh` | Sync rules against the migrated catalog; writes the publication SQL                                                                                                    | `continue-on-error` until the A17 rule fixes land, then blocking |
| `synthetics.sh`      | Synthetic checks against staging, the status history and the status page                                                                                               | Its own scheduled workflow; a failed run notifies on-call        |
| `backup-weekly.sh`   | Encrypted weekly logical backup of staging, and of production with its own read-only login (`--reader`, ADR 0033 decision 47)                                          | Its own scheduled workflow; needs the owner's public key first   |
| `oasdiff.sh`         | Gate 20: breaking changes in the OpenAPI document since the latest `v*` tag                                                                                            | Yes; passes with a notice until the first tag                    |
| `supabase-images.sh` | Pulls the Supabase CLI's images from GHCR before every `supabase start` and `supabase db start` in `ci.yml` and `nightly.yml` (section 7)                              | No; warns and leaves the pull to the CLI                         |

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

## 3. Workflow `.github/workflows/backup-weekly.yml`

The workflow is in the repository since 2026-10-23 (RRR-139), so this section no longer copies it. It runs every Monday at 06:23 UTC and on demand, with two jobs that use only the actions ADR 0001 already pins:

- **`staging`**, as this section first wrote it: `supabase db dump` with `STAGING_DB_URL`, a repository secret.
- **`production`** (ADR 0033, decision 47): `infra/ci/backup-weekly.sh production <dir> --reader` with `PRODUCTION_BACKUP_DB_URL`, a secret of the `production-backup` environment, which only `main` may use. It logs in as `xos_backup`, the read-only login of migration 1650. The CLI cannot dump as that login, because it always switches to the `postgres` role, so the script runs pg_dumpall, pg_dump and psql from the `supabase/postgres` image the pinned CLI names (`supabase services`), with the CLI's own flags and filters, two of them corrected, and adds the accounts, `platform.sql`, `cron.sql` and `migrations.txt` (`infra/runbooks/backup-and-restore.md`, What the production login reads).

Both encrypt to `infra/backup/backup-public-key.asc` and upload `xos-<environment>-backup` kept 35 days. Each fails on purpose until the owner commits that key and sets its secret (`infra/runbooks/backup-and-restore.md`, Set up the production backup login). At 35 days' retention the account's artifact storage holds five archives of each project.

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

| Setting                        | Value                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings, Pages, Source        | Deploy from a branch: `gh-pages`, root                                                                                                                                         |
| Settings, Pages, Custom domain | `status.ghxstship.tech` with a CNAME record (ADR 0033, decision 72); no purchase needed for a subdomain of an owned domain                                                     |
| Settings, Variables (Actions)  | `XOS_STAGING_ATLAS_URL`, `XOS_STAGING_GATEWAY_URL`, `XOS_STAGING_SUPABASE_URL`, `XOS_STAGING_SUPABASE_ANON_KEY` (public by design), `XOS_STAGING_POWERSYNC_URL` once it exists |
| Settings, Secrets (Actions)    | `XOS_SYNTHETIC_EMAIL`, `XOS_SYNTHETIC_PASSWORD`, `XOS_ALERT_WEBHOOK_URL`, `STAGING_DB_URL`                                                                                     |
| Settings, Environments         | `production-backup`, deployment branches `main` only, with the secret `PRODUCTION_BACKUP_DB_URL` (the owner sets it; `infra/runbooks/backup-and-restore.md`)                   |
| Branch protection              | Leave `status-data` and `gh-pages` unprotected so the workflow can force-push them; `main` is untouched                                                                        |

## 7. Supabase stack images: GHCR first

Every job that runs `supabase start` or `supabase db start` first runs `infra/ci/supabase-images.sh start` (or `db`). Both workflows already do; new jobs copy the pair:

```yaml
# Services no test uses stay off; the images come from GHCR first (infra/ci/README.md).
- run: infra/ci/supabase-images.sh start
- run: supabase start -x studio,imgproxy,logflare,vector,postgres-meta,supavisor
```

**The problem.** The pinned CLI (2.120.0) pulls from `public.ecr.aws/supabase` first. Anonymous ECR Public pulls from GitHub's shared runner addresses answer `toomanyrequests: Rate exceeded` or `Data limit exceeded` when a dozen jobs start at once (the first nightly, run 39353210193, and `ci.yml` on `main`). The CLI retries each image after 4 and 8 seconds, then falls back to `ghcr.io/supabase` and then Docker Hub (`apps/cli/src/command-internal/docker-registry.ts` and `docker-image-resolve.ts` in the CLI source at `v2.120.0`). In those runs every image eventually came from GHCR, so the rate limit cost time on each job but failed none; the failures were elsewhere (below). A bad hour can still exhaust all three registries.

**The fix.** The script pulls the images the job needs straight from GHCR, in parallel, retrying after 5, 15 and 30 seconds, then tries ECR. Before pulling anything, the CLI looks for a local copy under each registry name it would try, so it starts the stack from the `ghcr.io/supabase/<name>:<tag>` copies without a pull. Versions come from `supabase services`, so they follow the CLI pin; Kong, Mailpit and pg_prove are not listed there, and their tags in the script match the CLI's service Dockerfile at 2.120.0 (the script warns when the CLI version changes). A failed pull warns and leaves the image to the CLI's own fallback, so the step never fails a job.

| Profile | Images (CLI 2.120.0)                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` | postgres 17.11.0.004, gotrue v2.197.0, postgrest v16.4, realtime v2.140.10, storage-api v1.79.36, edge-runtime v1.77.4, kong 2.8.1, mailpit v1.31.3 |
| `db`    | postgres, gotrue, realtime, storage-api (what `supabase db start` migrates with), pg_prove 3.36 (`supabase test db`)                                |

**Options not taken.**

- `SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io` makes the CLI use GHCR only, but it also turns off the CLI's fallback, so one GHCR hiccup would fail the job. The pre-pull gets GHCR first and keeps the fallback.
- `SUPABASE_USE_SLIM_IMAGES` switches to the CLI's slim images on GHCR, but they are different builds from the ones development and staging run.
- Caching `docker save` tarballs with `actions/cache` would add about 1.5 GB per key to the repository's 10 GB cache, shared with the pnpm stores, and evict them. Restoring and `docker load` take about as long as a GHCR pull inside GitHub's network, and parallel jobs on a new key all miss the cache at once anyway.
- Fewer services per job: `-x` already leaves out Studio, imgproxy, Logflare, Vector, postgres-meta and Supavisor. What remains is what the tests use.

Verified locally (A67): all nine images pull from GHCR at these tags, and with every `public.ecr.aws` image hidden from the CLI and ECR pulls refused, `supabase start -x ...` started the whole stack from the GHCR copies without a single pull.

## 8. Compass Maestro jobs (nightly, gate 7)

**iOS on `macos-15-intel` with Colima.** GitHub's Apple Silicon macOS runners (`macos-15`, `macos-latest`) have no Docker and cannot run it, because they do not support nested virtualization, so `supabase start` failed there. The Intel image can: Colima's own integration tests start a Docker VM on `macos-15-intel` on every push. The job installs `docker` and `colima` with Homebrew, starts a 2 CPU, 6 GB VM, and runs the same stack as the Linux jobs; Colima forwards the stack's ports to the Mac, so the simulator reaches it at `127.0.0.1:55421`. It then builds Compass for the simulator with Xcode 26.3 for x86_64 only. GitHub supports `macos-15-intel` until August 2027, as its last Intel image. Before then, the job moves to the hosted staging branch (ADR 0033 decision 1, `infra/runbooks/promote-to-production.md`) on an Apple Silicon runner. That needs the owner's staging URL, anon key and a seeded demo tenant as secrets, so it is not used today.

Approaches considered: running the stack in a Linux job and tunnelling to it from the macOS job needs a public tunnel and two jobs alive at once, which GitHub does not coordinate. Pointing at hosted staging is the fallback above. The Intel runner works today with no new secrets.

**Android on `ubuntu-24.04`.** The first run never reached Maestro. The runner user could not open `/dev/kvm`, so the emulator ran with `-accel off`. It took 13 minutes to boot, and then `adb` lost it (`Broken pipe`) while the action turned animations off. The job now adds the udev rule GitHub documents for hardware acceleration. The release APK is built for x86_64 only, since the emulator is x86_64; the four-ABI build took 23 minutes. The CI build also allows cleartext HTTP, because release builds refuse `http://10.0.2.2:55421`; store builds keep Android's default.

**Both.** `apps/compass/scripts/maestro-ci-env.sh` gives the flows what they read: `SUPABASE_URL` and `SUPABASE_ANON_KEY` for their helper scripts, and a kiosk registered as the Demo Admin with the Demo Field Tech's kiosk PIN, for `supervisor-kiosk`. `apps/compass/scripts/maestro-ci.sh` installs Maestro at `MAESTRO_VERSION` and runs the flows with a JUnit report, uploaded as the job's artifact. iOS skips `field-clock-offline` (tag `airplane-mode`), because Maestro sets airplane mode only on Android.

## 9. Workflow `.github/workflows/translate.yml` (manual, ADR 0037)

This workflow runs the machine translation pipeline with Google Cloud Translation when the owner starts it. It uploads the changed files as a patch to apply and review locally.

- **No stored key.** It authenticates through Workload Identity Federation. First set up the provider, the service account and the four repository variables (`infra/runbooks/production.md`, Machine translation, step 6).
- **One new action.** It needs `google-github-actions/auth` v3.0.0, pinned by SHA. That is an ADR 0001 amendment, recorded in ADR 0037. The workflow is in the repository since 2026-10-20 (the orchestrator checked that the SHA is the v3.0.0 tag).
- **The offline check needs nothing here.** It already runs in the `checks` job through `pnpm verify`.

The workflow file itself is the source; this section no longer copies it. What it does:

- **Inputs.** `command` is `translate` (missing and stale strings in es-US and in the five Beta locales), `review` (es-US) or `all` (glossary, translate, review). `locale` limits `translate` or `review` to one target, for example `fr-FR`.
- **No credentials, no run.** The first step checks the repository variables `GOOGLE_CLOUD_PROJECT`, `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` and `GOOGLE_TRANSLATE_SERVICE_ACCOUNT`. Until the owner sets them, the run ends there with a notice ("Translation skipped") and touches nothing: no install, no Google call, no patch. The Beta catalogs stay as they are and every missing key reads en-US (ADR 0053).
- **With credentials,** it installs, authenticates through Workload Identity Federation, runs the command, runs the offline check (`pnpm --filter @xos/i18n test`) and uploads the changes as `translation.patch`.
- **Beta locales** (fr-FR, de-DE, it-IT, pt-BR, ja-JP) are targets in `packages/i18n/translation/config.json` with `partial: true` and the `catalogs` and `canon` surfaces, so the first `translate` writes their catalogs and canon labels and nothing under the help articles or guides.

To apply the result:

1. Download the artifact.
2. Run `git apply translation.patch` on a branch.
3. Read `docs/i18n/review/es-US/README.md`.
4. Follow step 5 of the runbook section.

## Frequency and regions

Section 5.1 asks for checks every minute from five regions. GitHub Actions on the free tier gives every 5 minutes from one region (`us-east`, the primary region). A 1-minute, five-region check needs a paid monitoring service: the owner chose Better Stack (ADR 0033, decision 45), and its monitors run once the owner's account exists. The checks are plain Node scripts with no dependencies, so any scheduler that runs Node 22 can run them per region with `XOS_SYNTHETICS_REGION` set.
