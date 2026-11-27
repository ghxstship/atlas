# Lockstep with Atlas Marketing

The public Atlas landing page is built in `ghxstship/atlas-marketing`, a private repository. This repository stays the source of truth for the product, its prices, its legal documents and the XOS Design System. This file is the Atlas side of the contract; the marketing side is `LOCKSTEP.md` in that repository.

## What the marketing site reads from here

It pins a release tag and reads these at that tag. A change to any of them is a lockstep change.

| Subject | Path |
| --- | --- |
| Plan prices, limits, features, add-ons and offers | `packages/schemas/plans.yaml` |
| The offering as JSON, for a script with no TypeScript loader | `packages/schemas/src/plans/offering.generated.json`, published as `@xos/schemas/plans/offering.json` |
| Legal documents and their versions | `legal/index.yaml` and `legal/` |
| Design tokens | `design/xos-design-system/tokens.json`, then `packages/tokens` |
| Marketing components and their styles | `design/xos-design-system/components/`, then `packages/ui` |
| Shared marketing strings under `mk.*` | `design/xos-design-system/export/i18n/`, then `packages/i18n` |
| Offered territories, languages and currencies | `private.territories`, ADR 0160; the open territory codes at the tag are `offering.open_territories` in `plans.yaml` |
| Sign-up and sign-in addresses and their parameters | `docs/sign-up-links.md` |
| Support channels, with the hours and plan of each | `docs/support-channels.md` |
| Integration connectors and the status of each | `docs/integration-connectors.md` |
| Icons a page draws by name | `packages/icons/registry/`, published as `@xos/icons` |
| Feature status the page states | The files its claims register cites |

The `offering` section of `plans.yaml` is part of the first subject: it states for every plan feature whether it is offered, and for extra seats and each add-on whether it is on sale, and the page shows a feature, an extra-seat price or an add-on only where that section says so (`@xos/schemas/plans/offering` reads it). It also lists the open territories, `open_territories`, so the page shows a feature offered by territory only while its territory is in that list. An operator can open or close a territory in the console between releases; that is a lockstep change, and the list follows in the next release.

## What this repository does on a lockstep change

When a pull request here changes a subject above, or changes a fact the page states, its author opens an issue in `ghxstship/atlas-marketing` labeled `lockstep`, titled `Lockstep: <what changed> in <tag>`, before the release train that carries it is tagged. The issue names the files and says what the page must change.

Facts the page states today, each of which is a lockstep change when it moves:

- Compass is not in the App Store or Google Play.
- Legend is not shipped.
- No security certification is held.
- Launch is the United States only, in en-US and es-US, with USD pricing.
- The platform brand marks are not set; the page shows the BrandMark monogram.
- The integration connectors the page names, each with the status `docs/integration-connectors.md` gives it. A connector stated Not offered is not named as available, and no page says XOS is listed on Zapier or Make.
- The support channels, hours and first response targets the page or a directory listing names, as `docs/support-channels.md` states them.
- Support session controls are on every plan.
- The API areas and Aurora features the page names.

## Where each site lives

Owner decision, 2026-11-14.

- `https://ghxstship.tech`, the apex, is the marketing landing page, deployed on Vercel from `ghxstship/atlas-marketing`. Nothing in this repository serves the apex.
- The product subdomains hold every sign-in, sign-up and onboarding sequence: `https://atlas.ghxstship.tech` for Atlas and `https://gateway.ghxstship.tech` for Gateway. The landing page links to them and never hosts an account form, a session or a password field of its own.
- The other subdomains keep their owners here: `api`, `docs`, `console`, `status`, `atlas-staging` and `gateway-staging` (`infra/runbooks/production.md`).
- The sign-in and sign-up addresses the landing page links to are product facts. A change to one is a lockstep change and gets an issue in `ghxstship/atlas-marketing` before the tag.
- The `plan` parameter those addresses read, the plan codes it accepts and what the new Owner sees are product facts the marketing site reads from `docs/sign-up-links.md`; its plan buttons link to `/auth/sign-up?plan=<code>` with a self-serve plan code from `packages/schemas/plans.yaml`.
- If Compass ever offers native passkeys, the apex must serve the apple-app-site-association file (`infra/runbooks/hosted-security-settings.md`). That becomes a request to the marketing site through an issue there.

## What this repository receives

The marketing session opens issues here labeled `lockstep`, titled `Marketing request: <need>`. The owning agent under ADR 0004 answers each one. The marketing repository never edits a design system file; a need for a new token or component arrives as a request and is made in Claude Design first, exported to `design/`, then ported to `packages/`.

## Standing requests

1. Port the Marketing group into `packages/tokens`, `packages/ui` and `packages/i18n`, following `xos-design-system/HANDOFF.md`, section 10.
2. Publish `@xos/tokens`, `@xos/ui`, `@xos/i18n` and `@xos/schemas` to npm. The owner approved publication on 2026-11-14. `@xos` on npm belongs to someone else, so they publish as `@ghxstship/xos-tokens`, `@ghxstship/xos-ui`, `@ghxstship/xos-i18n` and `@ghxstship/xos-schemas`, together with `@ghxstship/xos-icons`, which `@xos/ui` depends on. `publish-packages.yml` publishes them with every release tag from v4.16.0, at the tag's version (ADR 0024, 2026-11-14 amendment). The site installs each under its workspace name through an npm alias, for example `"@xos/ui": "npm:@ghxstship/xos-ui@4.16.0"`, and transpiles the TypeScript source they ship (`infra/ci/README.md`, section 5, has the build settings).
3. Move the cookie banner from `apps/atlas/components/privacy/` into `@xos/ui`, so both sites share one banner.

## Answered requests

Requests the marketing site made after the standing ones, and where each answer lives.

- Issue 121, icons. `Accessibility`, `Bot`, `Braces`, `Terminal` and `ToggleLeft` are in the Marketing list of the icon registry (`packages/icons/registry/marketing.txt`), so `isRegisteredIcon` accepts each and the sprite holds a symbol for each. `packages/icons/test/sprite.test.ts` holds the five.
- Issue 122, server-renderable entries. `@xos/ui/marketing` exports `BrandMark`, `Card`, `DepartmentChip`, `Icon`, `Link`, `GateReadinessPanel`, `MarketingPoints` (a points list with an `icon` prop) and `PlanLimits` (label and value rows). Each renders on the server with no client module. `Link` and `GateReadinessPanel` take `locale` and `messages`; the other six print no shared string and take neither. `packages/ui/test/marketing-boundaries.test.ts` holds the module graph.
- Issue 123, the stylesheet and the shared strings. `@xos/ui/marketing/styles.css` is a Tailwind entry that compiles only the styles the Marketing layer uses, and `@xos/i18n` publishes the cut of the `ui` namespace that layer reads. `packages/ui/MARKETING.md` documents both.
- Issue 124, item 1, the es-US gate term. A lifecycle gate is "compuerta" and a door is "puerta" (owner decision 27, ADR 0034 item 3). `packages/i18n/REVIEW.md`, section Settled terms, states it.
- Issue 124, item 2, the phone menu. The actions repeated in the open `MarketingNav` panel take the panel's row size, a 44 px target in 16 px type (`packages/ui/src/styles/marketing.css`, `packages/ui/src/MarketingNav/README.md`).
- Issue 124, item 3, the radio groups. In the billing period group of `PricingTable` and the theme group of `MarketingFooter` an arrow key turns on the segment it moves to. `SegmentedControl` in the product keeps moving focus only, and `packages/ui/src/SegmentedControl/README.md` records that as intended.
- Issue 125, the offering.
  - The open territory codes are `offering.open_territories` in `plans.yaml`, which reads `[US]`, and `openTerritoryCodes()` in `@xos/schemas/plans/offering`.
  - The offering ships as JSON beside the generated module: `@xos/schemas/plans/offering.json`, with the keys `openTerritories`, `features`, `extraSeats` and `addons`.
  - `support_session_controls` is on the free plan, the plan that first includes it, so every plan has it and no price list shows it as something Enterprise adds (ADR 0035, 2026-11-27 amendment).
- Issue 126, support channels and connector status. `docs/support-channels.md` names each support channel with its hours and plan, from the Service Level Agreement, section 6. `docs/integration-connectors.md` states a status for each connector of the catalog. Each file quotes its sources, lists what the repository does not record and is held to those sources by a test.

Each of these is in release 4.19.0. The changes to `plans.yaml`, `packages/ui/src/marketing.ts` and `packages/ui/src/styles/marketing.css` are lockstep changes, so the release opens `Lockstep: requests 121 to 126 answered in v4.19.0` in `ghxstship/atlas-marketing` before the tag. What the page changes: delete the icon map in `lib/icons.ts`, read `open_territories` in place of its own empty list, show support session controls on every plan, read the offering JSON in its comparison script, and fill the support and integrations fields of the directory listings from the two files.
