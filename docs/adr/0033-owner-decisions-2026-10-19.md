# ADR 0033: Owner Decisions of 2026-10-19

- Status: Accepted
- Date: 2026-10-19
- Decider: Owner (Julian Clarkson), on the orchestrator's recommendations

## Context

The owner was given every open decision blocking the release, each with its options and a recommendation. On 2026-10-19 the owner approved every recommendation except decision 1. For decision 1 the owner chose to promote the existing Supabase project to production.

## Decision

### Infrastructure and accounts

1. **Production database:** the existing Supabase project `xos-atlas-staging` (ref fquuqnzlpobaawucczgq) is promoted to production on Supabase Pro.
   - Before it serves real users, the demo seed data (the demo tenant with its shared password) is removed. Its auth URLs, keys and secrets move to production values.
   - Staging moves to Supabase branching, available on Pro.
   - Removing the demo data is irreversible, so it runs only after the owner confirms the exact step.
   - _Amended 2026-10-19:_ the plan is prepared and proven locally (A64, RRR-109). Nothing has run against the hosted project. The steps, checks and rollbacks are in `infra/runbooks/promote-to-production.md`. In summary:
     - **Removal.** `infra/production/remove-demo-data.sh` runs `infra/production/remove-demo-data.sql` in one transaction, with dry-run, rehearse and execute modes. Execute needs `--confirm fquuqnzlpobaawucczgq`.
     - **What counts as demo data.** Nothing is listed by hand. The script starts from markers generated out of `supabase/seeds` and the load-test fixtures: the seed-namespace ids and the reserved email domains. It removes everything that hangs off those markers: rows of the marked orgs, rows that reference marked rows through a blocking or cascading foreign key, and orgs made up only of demo people. The demo orgs' storage objects go through the Storage API, and their integration credentials leave Vault.
     - **What stays.** Canon, the registries, reference data, buckets, cron jobs, the migration-created Vault keys and migration history.
     - **Safety checks.** The script refuses to run when the closure reaches canon or a row of an org that stays. It commits only when every table lost exactly its marked rows and a fresh closure finds nothing.
     - **Guards.** Migration 1270 adds the tenant purge, `private.begin_tenant_purge(org ids)`. It is a per-transaction mark, scoped to named orgs. Under it, the append-only, audit, sole-Owner and retained-record guards let deletes of those orgs' rows through; updates stay refused, and every other org keeps every rule. No trigger or foreign key is disabled. No append-only history of a removed org is kept, because it references the org. The same seam serves the Section 14.7 day-90 deletion.
     - **Local proof** (all migrations and seeds, plus load-test tenants, storage objects and a Vault credential):
       - 19 orgs, 30 sign-ins and 2,655 rows in 347 tables were removed.
       - Canon was unchanged: 41,749 rows in 94 tables.
       - Every data table matched a no-seed build.
       - `supabase test db` on the cleaned database passed except 3 assertions that need demo data.
     - **Settings.** Production settings follow the removal: Site URL and redirects (the domain is still to come), Resend SMTP, leaked-password protection, MFA as in `config.toml`, function and Vault secrets, optional network restrictions, then a JWT secret rotation that renews the anon and service keys, with the Vercel and Vault updates it forces.
     - **Staging.** Staging becomes a persistent Supabase branch, seeded from `supabase/seeds` on the branch only. Production gets `[remotes.production.db.seed] enabled = false`. Vercel previews and `STAGING_DB_URL` point at the branch.
2. **Backups:** Pro daily backups plus the PITR add-on. The release restore drill (`infra/drills/release-drill.sh`) runs quarterly as the verified drill.
3. **Leaked-password protection:** turn on Supabase's built-in check against Have I Been Pwned once on Pro.
4. **App hosting:** Vercel for Atlas, Gateway and docs.
5. **Domains:** one main domain with subdomains (app., gateway., docs., api.). The passkey relying party is the main domain, so one passkey works in Atlas and Gateway, and Compass gets a single universal-links file. The domain name itself is still to be supplied by the owner.
6. **Email:** Resend, sending from a subdomain (for example mail.), with SPF, DKIM and DMARC.
7. **Staging Site URL:** the current Vercel URL until the domain exists, then a staging subdomain. It moves to the staging branch once decision 1 is carried out.
8. **Offline sync:** PowerSync Cloud.
9. **Monitoring:** Sentry, a log drain (Axiom or Better Stack) and regional uptime checks (Checkly or Better Stack).
10. **Upload scanning:** self-hosted ClamAV (`clamav/clamav:1.5.4`).
11. **Store accounts:** Apple Developer and Google Play organization accounts for GHXSTSHIP. The Apple account needs a D-U-N-S number.
12. **Compass builds:** EAS Build and EAS Submit.

### CI and security

13. **Firefox and WebKit journeys:** nightly and on release branches; on every push if the repository is public.
14. **Compass Maestro:** nightly on GitHub macOS runners, plus an Android emulator on Linux. This Mac becomes a self-hosted runner if macOS minutes become a cost.
15. **CodeQL:** default setup turned on.
16. **Turbopack chunk merging** (`minChunkSize` 200,000, A48): kept.
17. **Dependency licenses:** counsel signs off on sharp's LGPL-3.0 libvips (dynamically linked) and Sentry's FSL-1.1 (not redistributed). Engineering replaces `buffers`, which declares no license.

### Money and plans

18. **Plan prices:** all four plans (Core, Pro, Team, Enterprise) and the annual discount are set before the Stripe products are created. The owner supplies the figures.
    - _Amended 2026-10-19:_ the owner supplied the figures, carried out in ADR 0035 (pricing v4, RRR-103). In summary:
      - Core, Pro and Team cost USD 149, 399 and 899 a month with 5, 15 and 40 seats, and extra seats cost 19, 19 and 15 a month.
      - Annual billing gives two months free.
      - Enterprise is quoted from USD 2,500 a month on an annual contract.
      - Local prices in EUR, GBP, CAD and AUD.
      - A 1,000-request Aurora pack for USD 49.
      - 30 percent off the first year for the first 50 paying organizations.
      - 30 percent partner wholesale.
19. **Stripe test-mode keys** (RRR-61): the sandbox secret is added now.
20. **Payouts:** manual recording at launch (XOS records payments and moves no money), then Stripe Connect Express.
21. **Partner wholesale billing:** Stripe Billing invoices to each partner.
22. **AI evals:** nightly, with a monthly spending cap.

### Content, legal and canon

23. **Legal pages:** the owner supplies `legal/OWNER_INPUTS.md` Part A, then counsel reviews.
24. **Pay-transparency list:** counsel confirms the seeded list.
25. **Canon rulings** (RRR-64):
    - The Bible wins on structure (codes, states, labels).
    - Values the Bible lacks, such as prices, are imported and marked as coming from the Playbook.
    - Status labels that aren't lifecycle states map to existing states.
26. **Canon content:**
    - Em-dash substitutions are accepted (RRR-65).
    - The CSMIA26 template rows stay private (RRR-67).
    - Bible inconsistencies (RRR-66) remain owner rulings, one by one.
27. **Spanish:** a native reviewer is hired (RRR-68). A project gate is "compuerta" ("puerta" stays for physical doors).
28. **Legacy .xls import:** dropped. .xlsx and .csv remain.

### Human testing and launch

29. **Screen-reader passes:** a hired accessibility tester. The camera scan pace (journey 53) is done in-house.
30. **Store submission:** TestFlight and Play internal testing first, for two to four weeks, then public submission.

### Decisions raised by A52

31. **Project shares:** every partner member acts as the share's one project role. Per-role mapping comes later if partners ask.
32. **Project role capabilities:** widened deliberately, role by role, in the Section 4.8 review; never permissive by default.
33. **IP allow-list reach:** accepted for launch and documented. Direct Supabase REST calls with a valid session are not filtered per org; routing data access through the API closes this later.
34. **Break-glass:** grants the Owner role's capabilities and passes the IP allow-list, and lifts nothing else. It already requires a second factor.

## Consequences

- **Engineering:**
  - A56 (RRR-101) applies decision 25.
  - A57 (RRR-102) applies decisions 10, 17, 27, 28 and 33.
  - The orchestrator applies decisions 13, 14 and 22 in CI.
- **Owner actions:**
  - Supabase Pro and PITR.
  - The domain name.
  - Store accounts and `npx eas login`.
  - The Stripe sandbox secret, `ANTHROPIC_API_KEY` and the other named secrets (`docs/release-checklist.md`).
  - Plan prices.
  - Legal Part A, and counsel review of decisions 17, 23 and 24.
  - Hiring the Spanish reviewer and the accessibility tester.
  - Turning on CodeQL.
- **Decision 1 changes the staging plan:**
  - Staging data must not carry over into production.
  - The orchestrator prepares the cleanup of the demo tenant and the production settings.
  - The orchestrator asks the owner to confirm before running anything irreversible on the hosted project.
  - _Amended 2026-10-19:_ A64 (RRR-109) prepared the cleanup and the settings checklist (`infra/runbooks/promote-to-production.md`). The owner confirms each step it marks OWNER CONFIRMS (1 and 4 to 14) before the orchestrator runs it; step 4, the removal, and step 12, the key rotation, cannot be undone.
