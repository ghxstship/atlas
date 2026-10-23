# ADR 0033: Owner Decisions of 2026-10-19

- Status: Accepted
- Date: 2026-10-19
- Decider: Owner (Julian Clarkson), on the orchestrator's recommendations

## Context

The owner was given every open decision blocking the release, each with its options and a recommendation. On 2026-10-19 the owner approved every recommendation except decision 1. For decision 1 the owner chose to promote the existing Supabase project to production.

On 2026-10-23 the owner was given a second list of 42 open decisions, again each with its options and a recommendation, and approved every recommendation. They are decisions 39 to 80, in the order of that list.

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
     - **Settings.** Production settings follow the removal: Site URL and redirects (`atlas.ghxstship.tech` and `gateway.ghxstship.tech` since 2026-10-20, decision 5), Resend SMTP, leaked-password protection, MFA as in `config.toml`, function and Vault secrets, optional network restrictions, then a JWT secret rotation that renews the anon and service keys, with the Vercel and Vault updates it forces.
     - **Staging.** Staging becomes a persistent Supabase branch, seeded from `supabase/seeds` on the branch only. Production gets `[remotes.production.db.seed] enabled = false`. Vercel previews and `STAGING_DB_URL` point at the branch.
2. **Backups:** Pro daily backups plus the PITR add-on. The release restore drill (`infra/drills/release-drill.sh`) runs quarterly as the verified drill.
3. **Leaked-password protection:** turn on Supabase's built-in check against Have I Been Pwned once on Pro.
4. **App hosting:** Vercel for Atlas, Gateway and docs.
5. **Domains:** one main domain with subdomains (app., gateway., docs., api.). The passkey relying party is the main domain, so one passkey works in Atlas and Gateway, and Compass gets a single universal-links file. The domain name itself is still to be supplied by the owner.
   - _Amended 2026-10-20:_ the owner confirmed **ghxstship.tech**, one subdomain per app (A74, RRR-119):
     - `atlas.ghxstship.tech` for Atlas, `gateway.ghxstship.tech` for Gateway, `docs.ghxstship.tech` for the docs site and `api.ghxstship.tech` for the public API.
     - **Why `atlas.` and not `app.`:** the owner chose to keep `atlas.`, the host Vercel and Supabase Auth were already set up with. It is the product's own name, as are the Vercel project `atlas` and the variable `ATLAS_SITE_URL`, and every app now sits on a subdomain named after it.
     - **The API host** is served by the Atlas deployment. With `XOS_API_HOST=api.ghxstship.tech`, `https://api.ghxstship.tech/v1/...` is the API at `/api/v1/...`, with the same credentials, rate limits and IP allow-list. No Atlas page or cookie is served there. `https://atlas.ghxstship.tech/api/v1` keeps working. The OpenAPI document lists `https://api.ghxstship.tech/v1` as a server.
     - **Passkeys:** the relying party id is `ghxstship.tech`, with the origins `https://atlas.ghxstship.tech` and `https://gateway.ghxstship.tech` (`infra/runbooks/hosted-security-settings.md`).
     - **Compass** claims `atlas.ghxstship.tech` and `gateway.ghxstship.tech` as universal links (ADR 0030).
     - **Email** sends from `mail.ghxstship.tech` (decision 6). The settings, DNS records and environment values are in `infra/runbooks/production.md`, "Domains".
6. **Email:** Resend, sending from a subdomain (for example mail.), with SPF, DKIM and DMARC.
7. **Staging Site URL:** the current Vercel URL until the domain exists, then a staging subdomain. It moves to the staging branch once decision 1 is carried out. The staging subdomain under `ghxstship.tech` is not named yet.
   - _Amended 2026-10-23:_ `atlas-staging.ghxstship.tech` and `gateway-staging.ghxstship.tech` are kept (decision 63).
8. **Offline sync:** PowerSync Cloud.
   - _Amended 2026-10-23:_ Compass launches on REST sync and PowerSync is deferred (decision 51).
9. **Monitoring:** Sentry, a log drain (Axiom or Better Stack) and regional uptime checks (Checkly or Better Stack).
   - _Amended 2026-10-23:_ Better Stack for both (decision 45).
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
    - _Amended 2026-10-23:_ the owner ruled on all seven (decision 39).
27. **Spanish:** a native reviewer is hired (RRR-68). A project gate is "compuerta" ("puerta" stays for physical doors).
    - _Amended 2026-10-20:_ no reviewer is hired. Google Cloud Translation reviews es-US and produces every other translation, and a project gate stays "compuerta" (ADR 0037, RRR-118).
28. **Legacy .xls import:** dropped. .xlsx and .csv remain.

### Human testing and launch

29. **Screen-reader passes:** a hired accessibility tester. The camera scan pace (journey 53) is done in-house.
30. **Store submission:** TestFlight and Play internal testing first, for two to four weeks, then public submission.

### Decisions raised by A52

31. **Project shares:** every partner member acts as the share's one project role. Per-role mapping comes later if partners ask.
32. **Project role capabilities:** widened deliberately, role by role, in the Section 4.8 review; never permissive by default.
33. **IP allow-list reach:** accepted for launch and documented. Direct Supabase REST calls with a valid session are not filtered per org; routing data access through the API closes this later.
    - _Amended 2026-10-23:_ the same acceptance covers the org MFA policy and session rules on direct calls, and finding A69-010's residual (decision 55).
34. **Break-glass:** grants the Owner role's capabilities and passes the IP allow-list, and lifts nothing else. It already requires a second factor.

### Decisions of 2026-10-20

35. **SMS quiet hours:** a recipient with no quiet hours of their own gets 21:00 to 08:00 in their time zone (A80, RRR-125).
    - **Urgent kinds bypass quiet hours,** both the default and personal ones: safety alerts, sign-in and verification codes, and changes to a shift starting within 12 hours. The list is a flag on those kinds in `packages/schemas/notification-kinds.yaml`, so it stays short and reviewable.
    - **The recipient's zone falls back** to the engagement's project zone, then the org's. It is never UTC.
    - **Held texts go out at 08:00** local as one summary per recipient and org, not a burst.
    - **Why:** carrier and state rules, and crew who opt out after a 2 a.m. text, lose the channel for the alerts that matter. Overnight productions still need urgent texts delivered.
    - _Amended 2026-10-23:_ the urgent list adds new shifts, security changes and emergency-access alerts, and billing alerts wait until morning (decision 62).
36. **Gateway ratings stay on.** No org can hide ratings, because selective suppression is what the FTC rule on reviews (16 CFR Part 465) forbids.
    - **The setting becomes prompt-only:** `gateway.ratings_enabled` only controls whether the org's own members are prompted to rate the people it engages. Turning prompts off never hides or removes a rating already given.
    - **Moderation removes only policy violations** (abuse, personal data), whatever the rating.
    - **Counsel confirms** this before launch.
37. **Record keys are fixed.** `numbering.record_key_format` leaves the settings screens and refuses writes. URLs, printed QR codes, offline Compass data and API v1 depend on record keys.
    - **The customizable numbers** are the invoice prefix and document number padding (`org.invoice_number_prefix`, `numbering.document_number_padding`).
    - **If keys ever become configurable,** a new format applies only to new records, old keys keep resolving permanently, and no key is reused.
38. **Passport expiry stays unencrypted** (A78, migration 1340). The passport number is the identifier: it is encrypted under its own Vault key, masked, and revealed only through an audited step that needs a second factor and a reason.
    - **The expiry date is Confidential,** owner-only, shared per engagement by consent, and on the AI never-send list.
    - **Encrypting it would break expiry reminders,** or make those jobs decrypt routinely.

### Decisions of 2026-10-23

39. **Canon rulings (RRR-66):** the seven rulings finding A56-001 asked for are given as proposed. They unblock WP18, which applies them to the canon data and the importer in migrations 1610 to 1619, as 1230 did for decision 25.
    - **Show and Procurement.** "Show" means Operate (OPR) and "Procurement" means Procure (PRC), so the touchpoints and items waiting in `xpms.intake` get their phase.
    - **Department 4000.** Bible tab 27 is relabeled: department 4000 is Environment there too, as tab 01 says, on the five roles it called "Build".
    - **The 33 items labeled 4000 with 6000 codes** keep their codes and take the label their code gives. The Bible wins on codes (decision 25).
    - **Empty statements.** The empty or headless statement columns on tabs 23, 24, 25 and 34 are removed.
    - **Role codes.** Tab 27's role codes are retired in favor of the Roles Library (ruling D12), which settles the three codes tab 27 lacks (2000.50.02, 5000.50.03 and 6000.50.03).
    - **GL defaults.** Ruling D13 (GL accounts derived by class) allows explicit GL defaults on an item and on a counterparty. A balance-sheet item needs one, because its account cannot be derived by class.
    - **Time units.** A time unit dimension is ratified, so the Standard Library units Hour and Week resolve to canon units.
    - **Declared gaps.** Scope (SCP), Engage (ENG), Amplify (AMP) and Close (CLS) have no Active element. They are recorded as declared gaps under doctrine 3.4 (finding A65-019), and their catalog items keep the Proposed state the Item Catalog gives them.
40. **Legal drafting choices:** the twelve choices in `legal/OWNER_INPUTS.md` Part B are confirmed as drafted. Counsel may still change any of them in review (decision 23).
41. **Email to real recipients:** on at cutover, with `XOS_EMAIL_DELIVER_TO_ANY=true` in production only. It waits until `mail.ghxstship.tech` passes Resend's SPF, DKIM and DMARC checks and `XOS_POSTAL_ADDRESS` holds the postal address (OWNER_INPUTS item 2), which every email footer needs under CAN-SPAM. Until then product email reaches only `XOS_EMAIL_ALLOWLIST`. The staging branch keeps the allowlist.
42. **Email confirmation at sign-up:** on in the hosted Supabase Auth. A new email sign-up confirms its address before it can sign in. The local stack keeps it off so tests sign in at once.
43. **Auth email rate limit:** about 100 emails an hour through Resend (Authentication, Rate Limits), raised once the Auth logs show the real sign-up, magic link and reset volume.
44. **Key rotation at cutover:** approved (`promote-to-production.md`, step 12). Rotating the JWT secret issues new anon and service keys and signs everyone out, and it cannot be undone. It is needed because the staging keys and the demo password were exposed during the build.
45. **Monitoring:** Better Stack for the log drain and the regional uptime checks, which settles decision 9's alternatives.
    - Log drains carry the platform's own logs from Vercel and Supabase, with IP addresses and user ids, beside XOS's redacted log lines. So Better Stack, Inc. joins the Subprocessor List before it receives them.
    - The uptime checks sign in as the synthetic accounts and carry no customer data. One-minute checks from five regions meet Section 5.1, which the free GitHub Actions schedule (every 5 minutes from `us-east`) does not.
46. **DMARC:** `_dmarc.mail.ghxstship.tech` starts monitoring-only, `p=none`, with aggregate reports to a mailbox the owner reads. It moves to `p=quarantine` after two to four weeks of clean reports, that is, once the reports show only Resend sending for the domain.
47. **Weekly production backup:** a CI job backs up production every week with its own read-only database login, built in migrations 1650 to 1659, beside the staging job. Database network restrictions (`promote-to-production.md`, step 11) stay off for now, because GitHub runners connect from changing addresses.
48. **Supabase GitHub integration:** not connected. Migrations are pushed by hand for each release with `supabase db push` from the tagged commit, staging first (`production.md`, Deploy order). A push to `main` never migrates production.
49. **Encryption keys created by migrations:** kept. `xos_medical_notes_key`, `xos_tax_form_key`, `xos_org_tax_identifier_key` and `xos_inbound_reply_secret` were generated in the project and never left Vault, so the build exposed none of them.
50. **Vercel staged rollouts:** used, because the plan includes Rolling Releases for one project. `atlas` takes the slot: stages of 5, 25 and 100 percent, each advanced by manual approval when the release gate says promote (`progressive-delivery.md`). `gateway` and `docs` promote directly and roll back with Instant Rollback.
51. **PowerSync:** Compass launches on REST sync. Its downloader reads through row-level security and the `api_external` views, and queued writes replay through `app.apply_sync_mutation`. PowerSync is deferred until the readiness check in `infra/powersync` passes, so decision 8 is not needed for launch. The Subprocessor List now says PowerSync is not in use.
52. **Chat translation:** Google Cloud Translation, off by default for each org (Settings, Communication, "Translate chat messages"; migration 1363). Google Cloud Translation is listed as a subprocessor for chat text before the list is first published, so turning it on needs no 30-day notice. ADR 0037 covers only the product's own strings, which carry no customer data.
53. **EU data residency:** deferred until the first EU Enterprise contract. The Security Overview no longer says Enterprise customers can choose the EU today. The EU region, the storage for its backups and its Subprocessor List entry are set up for that contract (OWNER_INPUTS item 12).
54. **Compliance flows (finding A65-014):** the four flows the public drafts promise ship. A82 built them (RRR-127, migrations 1381 to 1383): the age check at sign-up, the cookie banner with Global Privacy Control, re-acceptance after a material change to the terms, and Subprocessor List change notices.
    - **Deferred:** certified payroll (WH-347), the OSHA Forms 300, 300A and 301, and the HR items: voluntary EEO answers kept apart, the worker classification questionnaire, the I-9 completion state and the FCRA workflow through a background-check provider. None is a launch commitment.
    - **Legal texts narrowed.** No public text promises a deferred item: the Terms of Service (4.3, 4.4), the Worker Terms (6, 7), the Acceptable Use Policy (3) and the DPA (Annex I) are narrowed, and the Subprocessor List marks Checkr as not in use at launch.
    - **A82's WH-347 and OSHA forms** (ADR 0041, migrations 1385 and 1386) stay in the code. Offering them waits on counsel's answers to ADR 0041's open questions.
55. **Direct database endpoint gap:** accepted for launch, extending decision 33. The org IP allow-list, MFA policy, session length and idle timeout are enforced where Atlas, the API and Compass check a session, not on direct calls to the Supabase endpoint with a session token. Finding A69-010's residual has the same cause. The plan is to route all data access through the API. The Security Overview already says so.
56. **Recovery codes:** built by A99 (RRR-144, migration 1560, ADR 0055). Section 7.5 invariant 8 is reworded, because a TOTP secret cannot be hashed: the server computes codes from it (finding A54-001). It now reads: "Token RPCs require a token and an access code, expire, rate-limit failed attempts, and return only the fields the page renders. Access codes, recovery codes and kiosk PINs are stored hashed and shown once. Second-factor secrets are held encrypted by the auth service and are never selectable by tenants."
57. **Report and block in Compass:** a minimal report and block for chat and the feed is built before the App Store submission (App Review guideline 1.2), in migrations 1630 to 1639. TestFlight and Play internal testing do not wait for it.
58. **Sign in with Apple:** added before the App Store submission (Section 14.6, the ADR 0036 follow-up), in migrations 1630 to 1639. Until then iOS builds ship without the Google button: `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` stays unset (ADR 0036, decision 8).
59. **Live billing:** XOS launches on the 14-day trial (A79, migration 1350) and the Access plan. The Stripe sandbox catalogue is set up now (decision 19; `production.md`, Stripe catalogue). Checkout in Atlas is built next, in migrations 1640 to 1649, and billing opens after it with the live catalogue and live keys.
60. **Inbound email:** project inboxes and reply by email receive on `inbound.ghxstship.tech`, through a provider already on the Subprocessor List: Resend's inbound mail, if it meets ADR 0040's requirements (it parses mail, checks DKIM, keeps the raw message and posts JSON with a bearer secret). Choosing early avoids the 30-day notice a new subprocessor needs. The operations work is in migrations 1650 to 1659.
61. **Spend authority when publishing an opportunity:** applies at publish only to orgs that have spend limits set, until Atlas has a screen to set them (the ADR 0019 open item, finding A65-031). Without that condition ADR 0016's rule, no applicable limit means refusal, would refuse every publish. Built in migrations 1620 to 1629.
62. **Quiet hours:** decision 35's urgent list grows. A new shift assigned to start within 12 hours bypasses quiet hours, as a change to such a shift already does, and so do security changes and emergency-access (break-glass) alerts. Billing alerts wait until the morning. Built in migrations 1620 to 1629.
63. **Staging names:** `atlas-staging.ghxstship.tech` and `gateway-staging.ghxstship.tech` are kept, which names decision 7's staging subdomains. Vercel previews stay on the persistent staging branch, with no branch per pull request.
64. **Usability testing:** a small remote round on staging during TestFlight (Section 11.14, validation with people). This is the Section 19.8 approval that recruiting participants needs.
65. **Texts to real recipients:** on once Twilio approves the 10DLC campaign, with `XOS_SMS_DELIVER_TO_ANY=true` in production only. Until then texts reach only `XOS_SMS_ALLOWLIST`.
66. **Stripe Connect for partners:** not in 4.0 (finding A65-026). Partners invoice their clients themselves, XOS records the partner's prices (`app.partner_client_prices`), and XOS takes no application fee. Payouts to external parties stay under decision 20.
67. **Product analytics:** the in-house, consented event table A96 built (RRR-141, migration 1532, ADR 0052) is ratified. It adds no subprocessor.
68. **Semantic search:** Supabase's built-in gte-small model, which A87 runs in the Edge Runtime (RRR-132, migration 1440, ADR 0043), is ratified. It adds no subprocessor.
69. **ADR 0019 leftovers (RRR-17):**
    - **Client and Sponsor engagements** drop the workforce-only fields: role code and worker classification stay required for workforce role types only. Built in migrations 1620 to 1629.
    - **Distance search,** built by A89 on PostGIS (RRR-134, migration 1460, ADR 0045), is ratified.
    - **Person-owned tables** (ADR 0019 item 10) are accepted as a stated exception to the rule that every tenant table carries `org_id`.
70. **Zapier and Make:** the apps (A83, ADR 0039 item 10) open as an invite-only beta, then go to public listing, which each provider reviews.
71. **SAML add-on and paid Expo build plan:** each is approved when it is first needed: the Supabase SAML SSO add-on when the first Enterprise org wants single sign-on, and a paid EAS plan when Compass builds outgrow the free tier.
72. **Status page:** `status.ghxstship.tech` points at the GitHub Pages status page (ADR 0025 item 7) through a CNAME record.
73. **Remaining vendors:** voice-note transcription, a community forum with in-app support chat, and a SOC 2 evidence store are deferred past 4.0 (OWNER_INPUTS Part C). A vendor chosen later goes on the Subprocessor List with 30 days' notice if it receives Customer Personal Data.
74. **Storybook 10.6.2:** taken now as a security exception to the two-week rule (GHSA-f2ph-cmg5-wxc8). Done on batch-c in 73c9c1f1 (ADR 0001, amendment of 2026-10-23).
75. **Release:** batch-c goes to production once its gate and the pull request's CI pass. `main` fast-forwards to it, and its migrations are pushed to staging and then production, with the owner typing the database password.
76. **Expenses for the Field role:** the Field role gets `finance.expense.write`, so crews can file expenses in Compass (ADR 0048). Approval still goes through the budget owner. Built in migrations 1620 to 1629.
77. **Delivered reports:** a scheduled report delivery also gets an Inbox and push entry that links to the report, and no second email. Built in migrations 1620 to 1629.
78. **External workers in Compass:** for 4.0 they see only org-level settings. The server still enforces every project rule. The owner revisits this after launch.
79. **Operator console hosting:** the Vercel project `console` and the domain `console.ghxstship.tech` are created (ADR 0046; A90, RRR-135). The owner still sets the console's `SUPABASE_ANON_KEY` for Production and Preview and its Auth redirect URL.
80. **Edge boot budgets** (for information): `notification-dispatch` may parse 180 KB at boot and `sms-webhook` 145 KB, about 10 percent above their builds. Both carry every notification kind's copy in both launch locales (`packages/platform/test/edge-bundle.test.ts`).

## Consequences

- **Engineering:**
  - A56 (RRR-101) applies decision 25.
  - A57 (RRR-102) applies decisions 10, 17, 27, 28 and 33.
  - The orchestrator applies decisions 13, 14 and 22 in CI.
- **Owner actions:**
  - Supabase Pro and PITR.
  - The domain name. Done on 2026-10-20: `ghxstship.tech` (decision 5).
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
- **Decisions of 2026-10-23:**
  - Engineering takes the blocks of ADR 0022's amendment of 2026-10-23: 1610 to 1619 for decision 39 (WP18), 1620 to 1629 for decisions 61, 62, 69, 76 and 77, 1630 to 1639 for decisions 57 and 58, 1640 to 1649 for decision 59, and 1650 to 1659 for decisions 47 and 60.
  - The Subprocessor List adds Better Stack (decision 45) and Google Cloud Translation (decision 52), and marks PowerSync (decision 51) and Checkr (decision 54) as not in use at launch.
  - The Security Overview, the Terms of Service, the Worker Terms, the Acceptable Use Policy and the DPA are narrowed to match decisions 50, 53 and 54. The spec's invariant 8 takes the wording of decision 56.
  - The runbooks carry the cutover steps of decisions 41 to 46, 50, 63, 65, 72 and 79, and `legal/qa/requirements-trace.md` records each deferral as "Deferred by decision".
  - The owner steps these decisions add are in `docs/release-checklist.md`, Owner actions.
