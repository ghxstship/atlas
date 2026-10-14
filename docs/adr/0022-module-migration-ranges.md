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
- `api_external` projections still belong to A28. Views over late-slot columns are placed after the late slots on request.
