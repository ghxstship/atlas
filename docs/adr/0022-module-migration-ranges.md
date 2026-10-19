# ADR 0022: Module Migration Ranges and Late Slots

- Status: Accepted (amends ADR 0004)
- Date: 2026-10-14
- Decider: Orchestrator

## Context

ADR 0004 gave all domain schema to A03 (0300 to 0499). In Wave 3 every module agent needs its own tables, lifecycles, RPCs and events. Routing all of them through one agent made it a bottleneck for the whole wave. Module migrations also run before A28's engagements (0700), so a module column that references `app.engagements` fails on a fresh reset.

## Decision

1. **Module ranges.** Each module agent owns ten migration numbers:

   | Agent | Range        |
   | ----- | ------------ |
   | A07   | 0400 to 0409 |
   | A08   | 0410 to 0419 |
   | A09   | 0420 to 0429 |
   | A10   | 0430 to 0439 |
   | A11   | 0440 to 0449 |
   | A12   | 0450 to 0459 |
   | A13   | 0460 to 0469 |
   | A14   | 0470 to 0479 |
   | A15   | 0480 to 0489 |
   | A16   | 0490 to 0499 |

   A03 keeps 0300 to 0399. In its range, a module agent may add tables, columns, lifecycles, RPCs, domain event types and triggers, realtime publication entries, and storage buckets for its module. It may `create or replace` an A03 function its module depends on, if pgTAP shows A03's tests still pass.

2. **Late slots.** References to tables created in a later range go in a late slot that runs after every range:

   | Agent | Late slot    |
   | ----- | ------------ |
   | A03   | 0940 to 0949 |
   | A07   | 0950 to 0954 |
   | A08   | 0955 to 0959 |
   | A09   | 0960 to 0964 |
   | A10   | 0965 to 0969 |
   | A11   | 0970 to 0974 |
   | A12   | 0975 to 0979 |
   | A13   | 0980 to 0984 |
   | A14   | 0985 to 0989 |
   | A15   | 0990 to 0994 |
   | A16   | 0995 to 0999 |

   The orchestrator keeps 0900 to 0939 for contract corrections and generated plan seeds (ADR 0018).

3. **Shared-stack testing.** An agent without its own stack tests migrations against the shared stack inside one transaction that rolls back. The orchestrator runs a full reset before each merge.

## Consequences

- Schema requests no longer queue behind one agent.
- A31 (views, help and support) owns 0640 to 0649, the end of A19's original 0600 to 0649 integration range; A19 keeps 0600 to 0639.
- `api_external` projections still belong to A28. Views over late-slot columns go in A28's post-late range, 1000 to 1009, which sorts after 0999 as text and as a number.

## Amendment (2026-10-16): post-late ranges

Follow-up agents that need tables from every module range take blocks after A28's 1000 to 1009:

| Agent | Range        | Scope                                                         |
| ----- | ------------ | ------------------------------------------------------------- |
| A29   | 1010 to 1014 | Workforce late slot                                           |
| A32   | 1020 to 1029 | Gateway and Compass follow-up, including `api_external` views |
| A33   | 1030 to 1039 | Platform workflow: approvals, trash, templates, state labels  |

A32 adds `api_external` views in its own range because A28 is complete; the projection rules in ADR 0019 still apply.

## Amendment (2026-10-17): orchestrator integration range

Fixes that join two agents' work after both have merged (for example A43's individual payees and A44's invoice notifications) take numbers 1190 to 1199, so they sort after every agent range in use.

## Amendment (2026-10-18): A45 and A47

A45 (Continue on another device and push approval) takes 1140 to 1144. A47 (gate audit fixes) takes 1150 to 1154.

## Amendment (2026-10-19): A49, A50 and A51

A49 (generated document templates, gate 19) takes 1160 to 1164. A50 (API contract handlers, gate 5) takes 1170 to 1179. A51 (Playbook field targets and cognitive load) takes 1180 to 1184. A48 (route JavaScript) has no range.

## Amendment (2026-10-19): A52 to A55

A52 (unbuilt spec features: legal entities, IP allow-list, access reviews, break-glass, project shares, blocks, multiple project roles) takes 1200 to 1219. A54 (invariant traceability and security fixes) takes 1220 to 1229. A53 (core-screen visual baselines) and A55 (release tooling) have no range.

## Amendment (2026-10-19): A56 to A58

A56 (canon rulings, decision 25) takes 1230 to 1239. A57 (platform decisions: ClamAV, licenses, Spanish, .xls) takes 1240 to 1249. A58 (plan pricing, decision 18) takes 1250 to 1259.
