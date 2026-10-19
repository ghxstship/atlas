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

## Amendment (2026-10-18): conditional components load on demand (A46)

Six of the seven Atlas signed-in key pages are now under 200 KB:

| Page             | Size                     |
| ---------------- | ------------------------ |
| home             | 180 KB                   |
| inbox            | 195 KB                   |
| crew shifts      | 197 KB                   |
| finance budgets  | 195 KB                   |
| project overview | 200 KB (174 bytes under) |
| projects         | 219 KB                   |

Projects keeps a ceiling. The rules that keep the pages here:

1. **A page imports directly only what it renders in its default state.** Views a person switches to, and overlays, sheets, forms and peeks that open on an action, go through `next/dynamic`. Shared wrappers live in `apps/atlas/components/lazy-ui` and per-module `lazy.tsx` files. Deferring a component a page shows by default only hides it from the budget, so it is not allowed.
2. **Shell overlays load on first use.** These are the command menu, the help and Aurora panels, the session dialog, the record peek, and the account and org menus (a Radix-free closed trigger). The breadcrumbs read a routed-only client sitemap.
3. **One component per client module, no re-export files in app code.** A `"use client"` module ships whole, and a static re-export pulls in its target even when the consumer loads it dynamically.
4. **Messages reach next-intl precompiled.** The ICU parser stays on the server.

The next reduction for Projects is a DataTable that registers only the TanStack features each table uses.

## Amendment (2026-10-19): Projects under budget, and no ceilings (A48)

Every key page is under 200 KB. Projects is 196 KB (201,135 bytes, from 224,466) and project
overview 192 KB (196,361 bytes, from 204,656). `packages/testing/bundle-ceilings.json` holds no
ceiling; a page that passes the budget again fails CI.

Registering fewer TanStack features was not the fix. The source maps showed tree shaking already
worked: unregistered features left about 1.5 KB. The chunk was TanStack Table itself (about 11 KB
with its store and React bindings), TanStack Virtual (6.6 KB) and DataTable. The rules that keep
the pages here:

1. **DataTable lays out a table without TanStack Table.** It computes widths (the resized or
   default width, clamped to 64 to 640 px) and pinned offsets (in pinning order) as TanStack's
   sizing and pinning features do, and keyboard resize and reset change that state directly. A
   pointer drag on a resize handle runs on TanStack Table, controlled, from `DataTableResizer.tsx`.
   It loads when a pointer enters a handle or a handle takes focus, and a press that arrives first
   starts its drag once the engine is ready. This defers an interaction, not a view: everything a
   table renders by default stays in the route budget, TanStack Virtual included. ADR 0001's stack
   is unchanged.
2. **Boundaries that load on every visit import only what they render.** Loading, error and
   not-found boundaries are part of every route under them. The page skeleton is its own client
   module, `@xos/ui` Skeleton has its own module, and the org error boundary navigates home the way
   the shell sidebar does, an anchor whose plain click goes through the router, instead of
   next/link.
3. **The client sitemap ships packed.** Node ids, label keys and routes that follow the sitemap's
   naming rules are rebuilt at load (`apps/atlas/ia/client-sitemap-codec.ts`); the generator writes
   only what departs from a rule.
4. **Atlas merges Turbopack chunks below 200,000 raw bytes** (`experimental.turbopackChunking.minChunkSize`,
   default 50,000). A signed-in page loads 13 chunks instead of 19 and 3 KB less gzip. The cost is
   shared code merged into page chunks, which a navigation can fetch again; revisit if Lighthouse
   navigation timings regress.

The next reductions, if a page needs them: the root error and not-found boundaries each carry their
own copy of Button, Icon and Kbd (about 5 KB on every page), because Turbopack does not share
modules between boundaries above the org layout; and the collection view switcher's Radix toggle
group (6 KB).
