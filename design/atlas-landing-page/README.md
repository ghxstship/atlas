# Atlas Landing Page

The Claude Design export for the public Atlas landing page, with the brief for building it. The page is built from the Marketing group of the XOS Design System (decision D20 in `../xos-design-system/README.md`; port map in `../xos-design-system/HANDOFF.md`, section 10).

| File | Contents |
| --- | --- |
| `Main.dc.html` | The en-US page: every section, its copy and its data, mounted on the design system components. |
| `Consent.dc.html` | The cookie banner on a first visit and with Global Privacy Control. |
| `canvas.json` | The canvas index. |

The boards load the design system from `ds/xos/`. That folder is `../xos-design-system/` and is not copied here.

## Status of this export

- The 20 Marketing components were rendered in Chromium at 320, 390, 768, 1024 and 1440 px in Dark, Light and Sunlight, with zero script errors, zero page overflow and zero axe-core 4.10.2 findings.
- The assembled page board was not rendered before export. Its height of 9,400 px is an estimate.
- `../xos-design-system/tokens.css` predates the Marketing tokens. `bundle.css` reads `space-80`, `space-96` and `space-128` with pixel fallbacks until the token build regenerates it.
- The es-US strings under `mk.*` are a draft. The translation pipeline of ADR 0037 reviews them.
- The commit that added this export carries no Developer Certificate of Origin sign-off. The owner adds it.

## Build order

1. **Verify claims.** Build a claims register: one row per factual statement on the page, with the file that proves it. Confirm each integration connector and each API area the page names is shipped. Remove any claim without proof.
2. **Port the design system layer.** Follow HANDOFF section 10: tokens into `packages/tokens`, components into `packages/ui` with stories, messages into `packages/i18n`. Reuse `apps/atlas/components/privacy/cookie-banner.tsx`; `ConsentBanner` in the design system is a reference only.
3. **Decide where the page lives and record it in an ADR.** The repository has no marketing app. The page is server-rendered, and its routes are `/atlas` and `/es/atlas`.
4. **Build the sections** in the order of `Main.dc.html`: navigation, hero, roles, lifecycle, surfaces, workspace, comparison, developers, Aurora AI, trust, pricing, questions, closing call to action, footer.
5. **Add structured data and metadata**: Organization, SoftwareApplication, Product with Offer at 0, 149, 399 and 899 USD and `eligibleRegion` US, FAQPage matching the visible text word for word, and hreflang for en-US, es-US and x-default.
6. **Pass the gates** below, then release en-US and es-US with USD pricing.

## Rules the page holds to

**Source of truth**

- Prices, limits and plan features come from `packages/schemas/plans.yaml` at build time. The numbers in `Main.dc.html` are a snapshot of 2026-11-14.
- Gate criteria are quoted as the canon writes them in `xpms.dim_gate_criterion`.
- Pictures use the fictional tenant Northwind Live. The page names no customer and no past project.
- Atlas and Gateway are shown as available. Compass is labeled In Progress until it is in the App Store and Google Play. Legend does not appear.
- The page claims no certification. SOC 2 Type II and ISO/IEC 27001 are stated as programs in readiness.

**Territory (ADR 0160)**

- Only open territories appear: en-US and es-US, USD, United States. No closed currency, language or country is shown or implied.
- Languages, currencies and hreflang entries for a closed territory are generated only when `private.territories` opens it.

**Comparison**

- The comparison cells in `Main.dc.html` are drafts taken from a research report. No cell ships until the claims register holds a dated primary source for it.
- A row appears only where Atlas is shipped and every other cell is sourced. Each cell is like for like, dated within 90 days and stated without disparagement.
- Other products are named in plain text. No logo or mark of another company appears.
- Unpublished means the product does not state the feature on its public pages. The footnote says so.

**Pricing and consent**

- Trial length, renewal and cancellation terms appear with the plans, before any button that starts a purchase.
- Nothing is pre-checked or preselected. There is no countdown and no scarcity copy; the founding offer states its cap of 50 redemptions.
- No non-essential request fires before consent. Accept and Reject carry equal weight. Global Privacy Control is a refusal and is confirmed on the page.
- Forms collect only what their purpose needs. Marketing email uses double opt-in.

**AI disclosure**

- Every mention of Aurora carries the AI Disclosure Badge, names the model provider and links the AI Features Notice.
- Any image or text an AI system generated is labeled as such.

**Testimonials and marks**

- `Testimonial` and `LogoSlotWall` stay off the page until a real customer consents in writing. A testimonial states the speaker's connection to GHXSTSHIP.

## Gates before release

| Gate | Pass criterion |
| --- | --- |
| Accessibility | Zero WCAG 2.2 Level AA violations in axe across Chromium, Firefox and WebKit, plus a manual keyboard and screen reader pass. |
| Internationalization | The pseudo-locales `en-XA` and `ar-XB` render with no truncation and no page overflow, and right to left mirrors. |
| Performance | On mobile, LCP is at or under 1.8 seconds, INP is at or under 150 milliseconds and CLS is at or under 0.05, and route JavaScript is at or under 200 KB. |
| Consent | A clean-profile network trace shows no non-essential request before consent, and a request with `Sec-GPC: 1` records an opt-out. |
| Security headers | HSTS, `nosniff`, a strict referrer policy, a Permissions-Policy, COOP and a nonce-based Content Security Policy with no `unsafe-inline` are set. |
| Structured data | Every schema block validates, and FAQPage text equals the visible text. |
| Claims | Every statement on the page has a row in the claims register, and every comparison cell was verified within 90 days. |
