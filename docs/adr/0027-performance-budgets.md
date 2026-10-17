# ADR 0027: Performance Budgets and Delivery

- Status: Accepted
- Date: 2026-10-17
- Decider: Orchestrator

## Context

A24 measured every key page at 466 to 717 KB of route JavaScript against the 200 KB budget (gate 10), and API reads at 268 to 513 ms p95. A37 cut both:

- **Route JavaScript:** Atlas sign-in is now 183 KB, the docs site 169 KB, Gateway 202 to 213 KB, and Atlas signed-in pages 256 to 331 KB.
- **API reads:** tenant reads now run at 18 ms p95.

This ADR records how those numbers are kept.

## Decision

1. **Route JavaScript is measured from build manifests on every push.** The `route-js-budget` CI job fails when a key page passes 200 KB gzip. Pages still over budget have a recorded ceiling (measured size plus 3 KB) in `packages/testing/bundle-ceilings.json`. A ceiling only ever moves down. Lighthouse stays the nightly real-browser check.
2. **The Atlas shell is accepted above budget for 4.0.** The ceilings above apply. The Next.js and React runtime alone is 128 KB of every page. The next reductions are serving the icon registry as an SVG sprite (about 15 KB) and precompiling next-intl messages (about 7 KB). Both are queued design-system work, not release blockers.
3. **Client code imports `@xos/i18n/locales`, never the catalog entry.** `@xos/ui` bundles only the source locale, and servers pass other locales through the provider with only the namespaces a page uses.
4. **Heavy components get their own client boundary file.** A `"use client"` barrel ships every export to every importer.
5. **API sessions are verified locally against the JWKS.** The caller's identity is reused for 30 seconds, and RLS still checks membership on every query. Every response carries `Server-Timing`.
6. **Interactive states use the scrim at the opacity tokens, not brightness filters.** The contrast gate checks hover and pressed states for every fill.

## Consequences

- **Gateway is 2 to 13 KB over budget**, held at its ceilings until the icon sprite lands.
- **`record_display_key` costs about 1.8 ms per row.** The API now composes the key itself; a cheaper database form is a follow-up for the schema owner.

## Amendment (2026-10-17): icon sprite (A41)

Web icons draw from one SVG sprite generated from the `@xos/icons` registry (`@xos/icons/sprite.svg`, 207 icons, 10 KB gzip). `@xos/ui` `<Icon>` renders `<svg><use href="{sprite}#{Name}"/></svg>` with stroke and size on the outer element. The bundler emits the sprite as a content-hashed, immutable static asset. Web bundles import `@xos/icons/glyphs` and `@xos/icons/names`, never the component registry, which stays for server and native use. No icon data ships in page JavaScript.

Every key page dropped 15 to 19 KB. Gateway is now 184 to 195 KB, inside the 200 KB budget, and its ceilings are removed. The Atlas ceilings were lowered to the new measurements plus 3 KB.
