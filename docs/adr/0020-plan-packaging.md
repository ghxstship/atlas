# ADR 0020: Plan Packaging: Atlas in Every Plan, Aurora AI and Legend by Tier

- Status: Accepted (amends Section 16; builds on ADR 0018)
- Date: 2026-10-14
- Decider: Owner

## Context

The owner considered packaging plans by product: Compass only on Access, Atlas from Team. In this build, Atlas holds the records that Compass and Gateway work on. Projects, shifts, engagements and opportunities are all authored in Atlas. Without it, Compass and Gateway would have nothing to show. Gating Atlas at Team would also put the product that keeps customers behind a 4.4 times price jump from Pro. The owner approved packaging by reach and allowance instead.

## Decision

1. **Every plan includes Atlas, Compass, and Gateway for engaged parties.** Access is Atlas Lite: 1 seat and 1 active project (ADR 0018). Workers and other external users are free on every plan (Section 16).
2. **Gateway reach grows by tier.** Every plan has Gateway for the parties an org engages: documents, onboarding, threads and payments. The public marketplace and white label start at Pro, as Section 16 already set out.
3. **Aurora AI** is the name of the AI features of Section 4.7. It is in every paid plan through the feature `aurora_ai`, with a monthly per-org allowance in the limit `aurora_requests_per_month`:
   - Access: 0
   - Core: 500
   - Pro: 2,000
   - Team: 10,000
   - Enterprise: unlimited in the registry, with the limit set by contract
     The allowance is shared by the whole org. Requests above it are refused with XR001 `plan_limit_exceeded` until metered overage is priced. Org Admins still turn each feature on in Settings (Section 4.7).
4. **Legend** is not in this build. Enterprise carries the feature `legend_early_access`, so customers can be offered Legend as early access before it ships. No Legend surface is shipped or advertised as available.
5. **Prices and Stripe products are unchanged** (ADR 0018).

## Consequences

- Migration 0901 adds the enum values. The plan seed moves to `0902_plan_seed.sql` under the numbering rule of ADR 0018, and 0900 is frozen.
- **Enforcement by A25 (AI features):** before each Aurora request, check `private.org_has_feature(org, 'aurora_ai')`, then call `private.assert_within_plan_limit(org, 'aurora_requests_per_month', count + 1)`, counting this month's rows in `ai_usage`.
- The Terms of Service plan table, the Atlas plan page and the price book read the new entitlements. The allowance numbers are owner-tunable in `plans.yaml` without a schema change.
