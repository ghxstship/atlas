# ADR 0015: Linear Tracking and Commit Sync

- Status: Accepted
- Date: 2026-10-10
- Decider: Owner, with the orchestrator

## Context

The owner tracks the build in Linear and asked for the project to sync at each commit. The project is "Project Atlas: XOS 4.0 Build" in the GHXSTSHIP team (issue key `RRR`). Its milestones are the eight waves of Section 19.2, and its issues are agent tasks, quality gate groups (Section 18), acceptance groups (Section 20) and owner decisions. Every issue is assigned to the owner.

## Decision

1. **Every commit that lands on `main` names its Linear issue** with a trailer line before the attribution lines:
   - `Part of RRR-n` while the work continues.
   - `Fixes RRR-n` on the commit that completes the issue.

   A commit that touches several issues names each one. A merge commit names the issue of the branch it merges.

2. **Agents put the trailer on their own commits**, using the issue key in their brief.
3. **The orchestrator updates Linear at each merge to `main`**:
   - moves the issue (In Progress, In Review, Done);
   - comments with the commit, test results and follow-ups;
   - files new issues for carry-overs;
   - posts a project status update at each wave exit.
4. **Linear's GitHub integration links commits to issues automatically** once the owner connects it to `ghxstship/atlas` in Linear settings. `Fixes` closes the issue when the commit reaches `main`.

## Issue map

| Work                                           | Issue            |
| ---------------------------------------------- | ---------------- |
| Wave 0 foundation                              | RRR-5            |
| A01 canon                                      | RRR-6            |
| A02 identity core                              | RRR-7            |
| A04 API contract                               | RRR-8            |
| A05 design system foundations                  | RRR-9            |
| A21 legal                                      | RRR-10           |
| Sitemaps                                       | RRR-11           |
| Wave 1 freeze                                  | RRR-12           |
| A03 domain schema                              | RRR-13           |
| A05 packages/ui                                | RRR-14           |
| A06 Atlas shell                                | RRR-15           |
| A18 platform services                          | RRR-16           |
| A28 engagement schema                          | RRR-17           |
| Orchestrator carry-overs (plan seed, CI gates) | RRR-18           |
| A07 to A16 modules                             | RRR-19 to RRR-28 |
| A27 Gateway                                    | RRR-29           |
| A28 marketplace                                | RRR-30           |
| A29 workforce suite                            | RRR-31           |
| A30 identity, profiles, settings               | RRR-32           |
| A31 views, help, support                       | RRR-33           |
| A05 Storybook                                  | RRR-34           |
| A17 Compass                                    | RRR-35           |
| A05 packages/ui-native                         | RRR-36           |
| A19 integrations                               | RRR-37           |
| A20 SDKs and docs                              | RRR-38           |
| A25 AI features                                | RRR-39           |
| A26 reliability                                | RRR-40           |
| A22 security review                            | RRR-41           |
| A23 accessibility review                       | RRR-42           |
| A24 QA and performance                         | RRR-43           |
| Release and BUILD_REPORT                       | RRR-44           |
| Quality gate groups                            | RRR-45 to RRR-52 |
| Acceptance criteria and journeys               | RRR-53 to RRR-60 |
| Owner decisions                                | RRR-61 to RRR-68 |
| Linear tracking and commit sync                | RRR-69           |

New issues are added to Linear first, then to this table in the same commit that references them.

## Consequences

The Linear project is a view of the repository, never a second source: when they disagree, `main` and its ADRs win, and the orchestrator corrects Linear.
