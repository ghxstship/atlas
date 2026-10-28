# ADR 0066: White Label on Notification Email and the Docs Site

- Status: Proposed
- Date: 2026-10-28
- Decider: A138 (RRR-201), trace row S12-01
- Migrations: `2310_email_and_docs_branding.sql`

## Context

Section 12 applies an org's brand "on Atlas, Gateway, emails, PDFs, the docs site (Enterprise) and Compass". Atlas,
Gateway, generated PDFs (ADR 0031) and Compass (ADR 0049) wore it by 4.0. Notification email still showed the
platform frame and sent from the org's name, without its logo, accent, sender name or support address, although
`app.org_brands` holds all four (`0850_settings_persistence.sql`). The docs site had no per-org form at all: every page
is prerendered, and it never talks to the database.

## Decisions

1. **Email wears the brand while white label is in force.** `app.email_brand_for_org(org_id)` (service role only)
   answers while `private.white_label_in_force(org, 'white_label')` holds, so a downgrade grace keeps the brand to the
   end of the paid period exactly as it keeps "Powered by XOS" hidden (1355). It returns the brand name, the From name
   (`email_sender_name`, else the brand name), `support_email`, the light logo's path and the accent after partner
   inheritance, all read through `private.public_brand`, which it does not redefine. Without white label in force it
   returns nothing and the email is the platform's, as before.
2. **What the brand changes on an email.** `senderFor` (`packages/platform/src/stores.ts`) sends from the From name and
   names the brand in the footer; the layout (`packages/email/src/templates/layout.tsx`) puts the logo, named by the
   brand, above the heading and paints the call to action in the accent. The footer's sender, postal address, reasons
   and unsubscribe link stay (CAN-SPAM, CASL). One-tap action buttons are A127's and keep their own style.
3. **The email contrast check.** Email renders in the Light theme only, so the accent is checked there against the two
   pairs the email draws with it, at the token gate's thresholds: the button label (`accent-text-on`) on the accent at
   4.5:1, and the accent against `bg-surface` and `bg-raised` at 3:1. An accent that fails keeps the platform accent;
   the logo still shows.
4. **Reply-to.** The signed reply address of reply by email (Section 4.6.5) wins, because it threads the reply onto the
   record. An email without one replies to the org's support address; without that, it has no reply-to.
5. **Platform email stays platform-branded.** Sign-in and verification email is Supabase Auth's and never passes through
   this worker. Of the worker's kinds, the org's XOS billing, trial and plan notices (`billing.*` and
   `organization.white_label_*`, `isPlatformEmailKind`) are sent as the platform and never ask for the brand.
6. **The docs brand is Enterprise.** `api_public.docs_brand_for_slug(slug)` is public (anon may call it) and returns
   only `name`, `logo_light_path`, `logo_dark_path` and `accent_hex`, and only for an org whose plan in force is
   Enterprise with white label in force (`private.docs_brand_in_force`). Any other slug, including one that does not
   exist, returns nothing, so the lookup says nothing about orgs without a branded docs site. A downgrade below
   Enterprise reverts the docs site at once; email keeps its brand while white label stays in force.
7. **Where an org's docs live.** Under `/o/<org-slug>/…` on the docs host, and on any host the deployment maps to the
   org in `XOS_DOCS_TENANT_HOSTS` (`host=org-slug`, comma-separated). The proxy (`apps/docs/proxy.ts`) looks the brand
   up with the anon key, rewrites `/o/<slug>/<page>` to the prerendered page, and hands the brand over in the
   `xos-docs-brand` cookie, scoped to `/o/<slug>` (or the mapped host). A head script applies the accent before first
   paint and hides the platform name; the brand mark then shows the logo (light or dark by theme) and the name, and
   links to other docs pages stay inside the org's docs. Pages stay prerendered. The accent must pass the same gate as
   Atlas and Gateway, in every theme. An org without a docs brand under `/o/` is redirected to the platform docs; a
   mapped host without one serves the platform docs. A failed or unconfigured lookup (no `SUPABASE_URL` or
   `SUPABASE_ANON_KEY`) serves the platform docs: they are public, and the platform brand is never another org's
   identity.
8. **No DNS is configured by the build.** A custom docs host needs the owner's DNS work, below. Docs hosts are a
   deployment setting rather than an `app.org_domains` purpose: adding one would change a v1 API enum and the
   provisioning worker for what, today, is one Enterprise setup step done by hand.

## Owner steps

- **Docs brand lookup.** Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` on the docs project (the public anon key, as Gateway
  has). Without them the docs site serves only the platform brand.
- **Custom docs domain for an Enterprise org.** For each org that wants its docs on its own host:
  1. Add the host (for example `docs.northwind-live.com`) to the docs project in Vercel (Project, Settings, Domains).
  2. Have the org publish the DNS record Vercel shows (a CNAME to `cname.vercel-dns.com` for a subdomain) and wait for
     Vercel to verify it and issue the certificate.
  3. Add `host=org-slug` to `XOS_DOCS_TENANT_HOSTS` on the docs project and redeploy.
     Until the org is on Enterprise with white label in force, the host serves the platform docs.

## Consequences

- A white-label org's notification email and an Enterprise org's docs show its brand (S12-01).
- The notification worker makes one more RPC per email; the docs proxy makes one per page view of an org's docs, and
  none for the platform docs.
- The brand cookie is readable by page script by design; the page validates it before use (http(s) logo URLs, a
  six-digit hex accent, a base of `/o/<slug>`) and renders the name as text.
