# ADR 0122: Pseudo-Locale Checks on Every Route

- Status: Accepted
- Date: 2026-10-28
- Decider: A149 (RRR-212), under Section 15 and gate 16
- Migrations: none

## Context

Section 15 asks CI to render every screen in en-XA and ar-XB and to fail on hard-coded or truncated strings (trace row
S15-09). A53 built the two checks and ran them on the core screens of Atlas and Gateway only. The operator console
and the docs site had no pseudo-locales at all, and the checks were copied into each app.

## Decisions

### 1. Every web shell offers the pseudo-locales outside production

The transform lives in `@xos/i18n/pseudo`, and Atlas, Gateway, the console and the docs site read it. The console
negotiates en-XA and ar-XB from the `xos-locale` cookie as Atlas and Gateway do. The docs site, whose URLs carry the
locale, serves `/en-XA` and `/ar-XB` prefixes: `LOCALES` holds them outside production and `PUBLISHED_LOCALES` is
what the site publishes, prerenders and offers in its language links. A pseudo-locale page reads the en-US Markdown
(`contentLocale`). A production build serves neither, so the pseudo-locales never reach a customer or an operator.

### 2. The suites cover what the accessibility sweep covers

The Atlas and Gateway suites visit every route the A23 sweep visits for each role it signs in as, from one list
(`e2e/a11y/routes.ts` in each app), plus the public pages, the network-restricted page and both token flows. The
console suite visits every sitemap node as an Administrator, who sees them all, with the sign-in and second factor
pages. The docs site has some 3,000 pages from a dozen templates, so its suite visits every template with instances
that differ in shape, and every developer guide. Each page is checked in both pseudo-locales at 1280 px and, when a
phone gets it, 375 px. The A53 core-screen suites stay as they are.

### 3. One set of checks, and what counts as data

`@xos/testing/pseudo` holds the checks every suite uses, the A53 suites included. Text outside an en-XA wrap is data
when the page's source holds it: the database for the apps, and for the docs site the Markdown, the OpenAPI document
and the data dictionary. Values code composes with spaces and punctuation, Intl output and host names are data too.
A snake_case or dotted name is a raw key shown instead of its label, except on the docs site, whose reference names
tables, columns and operations as content. Everything else is a finding, fixed in the product: copy goes to a catalog
in en-US and es-US, and text that may truncate carries its whole text as a title.

### 4. CI runs them in the pseudo-locale job

`e2e-pseudo-locales` runs the new suites after the A53 ones, on next dev, with two workers for the Atlas and Gateway
routes. Its time limit rises from 45 to 150 minutes, since next dev compiles each of Atlas's routes on first visit.

## Consequences

- A new route is checked as soon as the sweep visits it; no list to keep in step.
- A new docs template needs a line in `apps/docs/e2e/pseudo-locales.spec.ts`.
- The checks run only against development builds; a production run skips them by design.
