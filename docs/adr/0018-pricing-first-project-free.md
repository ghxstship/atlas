# ADR 0018: Pricing: Paid Plans, First Project Free, Plan Seed Numbering

- Status: Accepted (amends Section 16 for the Access plan)
- Date: 2026-10-14
- Decider: Owner

## Context

The owner's ATLVS catalogue v3 in Stripe sells each paid tier in two purchase modes: unlimited, and per project. Section 16 knows only unlimited plans, and gives the free Access plan 2 active projects. The plan seed migration 0207 was already applied locally and to staging, and ADR 0004 forbids editing applied migrations.

## Decision

1. **Per-project pricing is dropped.** XOS sells Core, Pro, Team and Enterprise at the catalogue's unlimited prices only: USD 49, 79, 349 and 899 per month, annual at ten times monthly. Each plan references its Stripe product and prices by lookup key in `packages/schemas/plans.yaml`. The per-project prices stay untouched in the live Stripe account and are not copied to the sandbox.
2. **The first project is free.** The Access plan allows 1 active project (Section 16 said 2). Its other limits are unchanged: 1 seat, Compass for 10 crew, 25 active external engagements per month.
3. **Plan seed numbering.** The plan seed generator writes the current registry as one complete, idempotent upsert. Once a seed has shipped, it is never regenerated in place. The next change to `plans.yaml` moves the seed to the next free number in the orchestrator range (0900 to 0999), and earlier seeds stay as history. `0900_plan_seed.sql` is the current seed; `0207_plan_seed.sql` is frozen.

## Consequences

- The database refuses a second active project on Access with refusal SQLSTATE XR001 (pgTAP 0301), and `private.plan_limits` holds 1 (pgTAP 0201).
- The Terms of Service plan table and the Atlas plan page show one active project.
- The hand-written plan rows in 0201 remain as history; 0900 overrides them.
