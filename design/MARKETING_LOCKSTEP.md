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

## Where each site lives

Owner decision, 2026-11-14.

- `https://ghxstship.tech`, the apex, is the marketing landing page, deployed on Vercel from `ghxstship/atlas-marketing`. Nothing in this repository serves the apex.
- The product subdomains hold every sign-in, sign-up and onboarding sequence: `https://atlas.ghxstship.tech` for Atlas and `https://gateway.ghxstship.tech` for Gateway. The landing page links to them and never hosts an account form, a session or a password field of its own.
- The other subdomains keep their owners here: `api`, `docs`, `console`, `status`, `atlas-staging` and `gateway-staging` (`infra/runbooks/production.md`).
- The sign-in and sign-up addresses the landing page links to are product facts. A change to one is a lockstep change and gets an issue in `ghxstship/atlas-marketing` before the tag.
- If Compass ever offers native passkeys, the apex must serve the apple-app-site-association file (`infra/runbooks/hosted-security-settings.md`). That becomes a request to the marketing site through an issue there.

## What this repository receives

The marketing session opens issues here labeled `lockstep`, titled `Marketing request: <need>`. The owning agent under ADR 0004 answers each one. The marketing repository never edits a design system file; a need for a new token or component arrives as a request and is made in Claude Design first, exported to `design/`, then ported to `packages/`.

## Standing requests

1. Port the Marketing group into `packages/tokens`, `packages/ui` and `packages/i18n`, following `xos-design-system/HANDOFF.md`, section 10.
2. Publish `@xos/tokens`, `@xos/ui`, `@xos/i18n` and `@xos/schemas` to npm. The owner approved publication on 2026-11-14. `@xos` on npm belongs to someone else, so they publish as `@ghxstship/xos-tokens`, `@ghxstship/xos-ui`, `@ghxstship/xos-i18n` and `@ghxstship/xos-schemas`, together with `@ghxstship/xos-icons`, which `@xos/ui` depends on. `publish-packages.yml` publishes them with every release tag from v4.16.0, at the tag's version (ADR 0024, 2026-11-14 amendment). The site installs each under its workspace name through an npm alias, for example `"@xos/ui": "npm:@ghxstship/xos-ui@4.16.0"`, and transpiles the TypeScript source they ship.
3. Move the cookie banner from `apps/atlas/components/privacy/` into `@xos/ui`, so both sites share one banner.
