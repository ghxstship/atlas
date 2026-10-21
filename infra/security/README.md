# Supply chain and security checks

Section 9 (supply chain and testing) and gate 11, as CI jobs. Finding A65-017 recorded that these checks were
written but not run; A94 wired them into the workflows. Every script here runs locally with the same command
CI uses.

| Check                        | Where it runs                                                 | Command                                                                    | Fails on                                                                                   |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Semgrep                      | `ci.yml` `semgrep`                                            | `sh infra/security/semgrep.sh`                                             | Any finding (A54)                                                                          |
| Dependency audit             | `ci.yml` `dependency-audit`                                   | `node --experimental-strip-types infra/security/src/cli.ts audit`          | Any production advisory; a critical one anywhere in the tree; an allowlist entry past date |
| License check                | `ci.yml` `supply-chain`                                       | `pnpm --filter @xos/config licenses:check`                                 | A production license outside the allowlist with no recorded exception                      |
| SBOM                         | `ci.yml` `supply-chain` (artifact), `release.yml` (release)   | `sh infra/security/sbom.sh <version> <folder>`                             | A document that is not CycloneDX 1.4 or later, or that missed node_modules                 |
| Actions pinned by SHA        | `ci.yml` `supply-chain`, and a unit test on every `pnpm test` | `node --experimental-strip-types infra/security/src/cli.ts pins --remote`  | A tag or branch reference, a missing version comment, or a SHA that is not the tag's       |
| Supabase advisors, local     | `ci.yml` `database`                                           | `sh infra/security/supabase-advisors.sh`                                   | Any WARN or ERROR                                                                          |
| Supabase advisors, staging   | `ci.yml` `supabase-advisors-staging` (pushes to main)         | `node --experimental-strip-types infra/security/src/cli.ts advisors <ref>` | Any WARN or ERROR not in `advisors-accepted.json`                                          |
| ZAP baseline against staging | `nightly.yml` `zap-baseline`                                  | `sh infra/security/zap-baseline.sh https://atlas-staging.ghxstship.tech`   | An alert of a FAIL rule, or any High alert not ignored                                     |
| Secret scan                  | `ci.yml` `secrets`                                            | gitleaks in `ghcr.io/gitleaks/gitleaks:v8.30.1`                            | Any secret in history                                                                      |

CodeQL is a repository setting the owner turns on (ADR 0033, decision 15); it is not a workflow here.

## Accepted findings

Each accepted item names the thing accepted, why, and when it is looked at again. An accepted item never
silences anything else.

- **Advisories**: `audit-allowlist.json`, keyed by GHSA id and package, with `review_by`. Past that date the
  audit fails until someone reviews the entry. The audit lists entries that no report mentions any more.
  Overrides that fix advisories live in `pnpm-workspace.yaml`; keep the root `package.json` free of a `pnpm`
  field, because pnpm then ignores the workspace overrides (that is how the `unzipper` override of ADR 0034
  stopped applying until A94 moved every override into one place).
- **Licenses**: `packages/config/license-exceptions.json`, one package name (a trailing `*` matches platform
  builds) under one exact license, `Pending counsel` or `Approved by counsel`. The two pending entries are the
  owner decision "Counsel review of FSL-1.1-Apache-2.0 and LGPL-3.0-or-later" in `legal/qa/gate-status.md`.
- **Staging advisors**: `advisors-accepted.json`, by lint name and optionally by text in the lint's cache key.
- **ZAP alerts**: `zap/baseline-rules.tsv`, ZAP's own `-c` format. `IGNORE` lines say why; `FAIL` lines name
  the protections every page must keep (anti-clickjacking, CSP, no `X-Powered-By`). The file was written
  before the first staging run; record a decision for each warning of that run.

## The dependency audit policy

Production dependencies ship, so any advisory in them fails, whatever its severity. Development dependencies
(Expo's tooling, Lighthouse, test runners) run only in CI and on laptops, but they run with the repository's
secrets, so a critical advisory in them fails too; GitHub files malware as critical. Lower severities in
development dependencies are listed in the job summary. `pnpm audit` alone does not read the allowlist; use
the command above.

## The SBOM

syft (`anchore/syft:v1.54.1`, pinned by digest) scans the installed packages of a `pnpm install --prod`
checkout, so the document lists what ships: every npm package with its version, purl and declared license.
`src/sbom.ts` checks the document and writes `xos-<version>-third-party-notices.md`, the list behind the Open
Source Licenses page, grouped by license. On a version tag, `release.yml` attaches both files to the tag's
GitHub release, creating a draft when none exists; publishing a release attaches them again.

## Owner steps

Repository secrets, by name only. Values come from the owner's secret store and are never written anywhere in
this repository. Each job passes with a notice until its secret exists.

| Secret                            | Used by                              | Where to get it                                                                                                                                                                               |
| --------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | `nightly.yml` `zap-baseline`         | Vercel, each of the `atlas` and `gateway` projects, Settings, Deployment Protection, Protection Bypass for Automation. One secret works for both when the same value is set on both projects. |
| `SUPABASE_ACCESS_TOKEN`           | `ci.yml` `supabase-advisors-staging` | Supabase dashboard, Account, Access Tokens. A token used only for this job; it reads advisors and changes nothing.                                                                            |

The staging project ref defaults to the persistent `staging` branch (`rmrzfolncwhnhygmfxnw`); the repository
variable `SUPABASE_STAGING_PROJECT_REF` overrides it if staging moves.
