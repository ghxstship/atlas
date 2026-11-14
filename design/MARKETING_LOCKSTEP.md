# Lockstep with Atlas Marketing

The public Atlas landing page is built in `ghxstship/atlas-marketing`, a private repository. This repository stays the source of truth for the product, its prices, its legal documents and the XOS Design System. This file is the Atlas side of the contract; the marketing side is `LOCKSTEP.md` in that repository.

## What the marketing site reads from here

It pins a release tag and reads these at that tag. A change to any of them is a lockstep change.

| Subject | Path |
| --- | --- |
| Plan prices, limits, features, add-ons and offers | `packages/schemas/plans.yaml` |
| Legal documents and their versions | `legal/index.yaml` and `legal/` |
| Design tokens | `design/xos-design-system/tokens.json`, then `packages/tokens` |
| Marketing components and their styles | `design/xos-design-system/components/`, then `packages/ui` |
| Shared marketing strings under `mk.*` | `design/xos-design-system/export/i18n/`, then `packages/i18n` |
| Offered territories, languages and currencies | `private.territories`, ADR 0160 |
| Feature status the page states | The files its claims register cites |

## What this repository does on a lockstep change

When a pull request here changes a subject above, or changes a fact the page states, its author opens an issue in `ghxstship/atlas-marketing` labeled `lockstep`, titled `Lockstep: <what changed> in <tag>`, before the release train that carries it is tagged. The issue names the files and says what the page must change.

Facts the page states today, each of which is a lockstep change when it moves:

- Compass is not in the App Store or Google Play.
- Legend is not shipped.
- No security certification is held.
- Launch is the United States only, in en-US and es-US, with USD pricing.
- The platform brand marks are not set; the page shows the BrandMark monogram.
- The integration connectors, API areas and Aurora features the page names.

## What this repository receives

The marketing session opens issues here labeled `lockstep`, titled `Marketing request: <need>`. The owning agent under ADR 0004 answers each one. The marketing repository never edits a design system file; a need for a new token or component arrives as a request and is made in Claude Design first, exported to `design/`, then ported to `packages/`.

## Standing requests

1. Port the Marketing group into `packages/tokens`, `packages/ui` and `packages/i18n`, following `xos-design-system/HANDOFF.md`, section 10.
2. Publish `@xos/tokens`, `@xos/ui`, `@xos/i18n` and `@xos/schemas` to npm. The owner approved publication on 2026-11-14. This extends `publish-packages.yml`, which covers the SDKs and the CLI today.
3. Move the cookie banner from `apps/atlas/components/privacy/` into `@xos/ui`, so both sites share one banner.
