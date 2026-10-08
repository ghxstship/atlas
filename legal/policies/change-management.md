---
title: Change Management Policy
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review by counsel before launch
audience: Internal
---

# Change Management Policy

> **Draft for review by counsel before launch.** This internal policy is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval.

## 1. Purpose and Scope

This policy makes sure changes to XOS 4.0 are authorized, tested, reviewed, recorded and reversible. It covers application code, database migrations, infrastructure and configuration, feature flags, subprocessor changes, canon data, and changes to legal documents and policies.

## 2. Change Types

| Type      | Definition                                                                                                                | Path                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Standard  | Any code, migration, configuration or documentation change in the repository                                              | Pull request, CI, maintainer review, merge, progressive rollout                                    |
| Emergency | A change needed immediately to fix a SEV1 or SEV2 incident or a Critical vulnerability                                    | Expedited review by one maintainer, full CI, retrospective review within 2 business days           |
| Contract  | A change to a frozen contract: schema conventions, the Playbook column map, a sitemap, OpenAPI v1, capabilities or tokens | Architecture Decision Record in `docs/adr/` approved by the orchestrator, then a standard change   |
| Canon     | A change to canon data                                                                                                    | Data migration from the canon importer with updated source hashes; ratification recorded as data   |
| Legal     | A change to a published legal document                                                                                    | Pull request in `legal/`, counsel review, Owner approval, new version and notice as Section 6 sets |

## 3. Requirements for Every Standard Change

- A pull request that references its issue or ADR and follows Conventional Commits.
- Signed commits with a Developer Certificate of Origin sign-off.
- All Section 18 quality gates passing in CI.
- Approval from a maintainer of the changed paths who is not the author.
- Database changes follow expand and contract: add, backfill, switch, then remove in a later release. No release breaks the version before it.
- The public API changes additively within `/v1`; a breaking change ships as `/v2` with at least 12 months of overlap and deprecation headers.

## 4. Release

- Releases roll out progressively to 5, 25 and then 100 percent, with automatic rollback on error-rate regression.
- Risky features ship behind a database-backed flag with a kill switch.
- Mobile releases go through TestFlight and Play internal testing before production. Over-the-air updates apply only to JavaScript changes, follow staged rollout, and are scoped to their native build.
- Releases are tagged, with release notes and a CycloneDX SBOM.

## 5. Stop Conditions

These changes always require the Owner's explicit approval before they happen: spending beyond agreed budgets, purchasing or transferring domains, submitting to a public app store production track, sending email or SMS to real recipients outside the test allow-list, deleting non-ephemeral cloud resources, publishing packages under a new organization name, and changing a license.

## 6. Legal and Policy Changes

- A legal document change creates a new version in `legal/index.yaml` and in `/legal` version history.
- A material change to the Terms of Service or Data Processing Agreement triggers in-app re-acceptance with 30 days' notice.
- A subprocessor addition requires 30 days' notice before it processes Customer Personal Data.
- Internal policies are approved by the Owner and take effect on approval.

## 7. Records

The repository history, pull request reviews, CI results, deployment logs and feature flag audit trail are the change record. They are retained for at least 7 years.

## 8. Review

This policy is reviewed at least once a year.
