# ADR 0017: Atlas Shell Decisions

- Status: Accepted (amends ADR 0006 for one reserved slug)
- Date: 2026-10-14
- Decider: Orchestrator, on A06's completion report

## Context

A06 built the Atlas shell on the frozen sitemap (ADR 0014). A few choices touch frozen contracts or leave temporary storage that must be replaced.

## Decision

1. **`auth` is a reserved org slug.** `apps/atlas/ia/sitemap.yaml` reserves `auth` alongside `advance`, `sign`, `legal`, `partner`, `ical` and `api`, matching `private.reserved_org_slugs`. This amends ADR 0006 item 13.
2. **Auth pages live under `/auth` as declared shell routes**, not sitemap nodes. Sitemap nodes carry `nav` labels, and sign-in pages are not navigation. The route test covers them.
3. **Guards answer 404, never 403**, for hidden routes and for orgs the person does not belong to, in the proxy and again in each page.
4. **Pages awaiting a module agent** render the System template empty state with page-specific copy. The next action links to a named page or to the page with `?create=1`, which the module agent must handle.
5. **Temporary: legal acceptances in auth user metadata.** User metadata is writable by the user, so it is not valid evidence of acceptance (Section 14.4). Moving acceptances to an append-only table with an RPC that records document, version, time, IP and org blocks the Wave 2 exit (RRR-73).
6. **Temporary: persona from platform role.** Role-default sidebar groups use the platform role until A30 stores persona.

## Consequences

- RRR-73 tracks the settings persistence the shell needs: legal acceptances, brand, module switches, general settings, favorites and persona.
- RRR-74 tracks the CI jobs: Playwright end to end against Supabase, and the generated database types drift check, once the CLI versions match.
