# ADR 0006: Sitemap Interpretation Decisions

- Status: Accepted
- Date: 2026-10-08
- Decider: Orchestrator, on the Wave 1 information architecture agent's proposal

## Context

Section 4.5 is binding but leaves gaps: it groups project tabs by act without a mapping, gives no visibility for project tabs or utility routes, sets only two Gateway account-role rules, and asks for six Compass tabs for supervisors while Section 11.10 caps phone destinations at five. The sitemaps in `apps/*/ia/sitemap.yaml` encode the choices below, and `packages/ia` validates them.

## Decision

1. **Depth.** Navigation depth counts routed nodes only, with Home at 0; groups, menus and actions add nothing. Gateway engagement pages hang off Work in the tree, while their route stays `/work/engagements/{engagementKey}/{tab}`.
2. **Project tab acts.** Plan: Overview through Advancing. Build: Logistics through Procurement. Show: Documents through Settings. The Section 4.5.4 order is unchanged.
3. **Project tab visibility.** A tab that shares a page with a "Both" module takes that module's row in Section 4.5.9 (Engagements follows Opportunities, Budget follows Finance). Documents follows Knowledge, Activity follows Activity. Project Settings is Full for Owner, Admin and Manager, Read for Member, Hidden otherwise.
4. **Admin settings exclusion.** "Full except Billing and Legal" hides org settings 36 (Billing and Plan) and 41 (Legal) only.
5. **Utility routes.** Record, saved view and custom object routes follow the Production row. Import is Full for Owner, Admin, Manager and Member. The partner console is Owner and Admin; wholesale billing is Owner only. Legal pages are public. Advance, sign and calendar feed routes are token-gated, and advance and sign are served by Gateway.
6. **Gateway account roles.** Account Owner and Admin are Full, with the company Danger Zone Owner only. Account Finance: Explore Read, Work Read, Money Full, Messages Assigned, company settings Read with Payout and Tax Full. Account Member: Explore Read, Work Assigned, Money Hidden, Messages Assigned, company settings Read with Payout and Tax Hidden.
7. **Artist Representative.** Roster, plus Overview and Messages always. Representation scopes open tabs: offers opens Offer; advance opens Advance, Rider, Set Times, Hospitality and Guest List; settlement opens Settlement; documents opens Documents.
8. **Compass More menu for external users.** Their role items, then Offline Queue, Profile and Settings. They do not receive the internal base items.
9. **Supervisor Crew tab.** Section 4.5.7 is the more specific rule and wins over the five-destination limit in Section 11.10: Field Supervisors and above get a sixth tab, Crew, placed after More. The cognitive load lint (Section 18, gate 27) exempts this one case by name.
10. **Scan tab for Client and Sponsor.** The tab stays, because the tab set is the same for everyone; its content explains that no scan mode applies.
11. **Compass personal settings.** Keyboard Shortcuts is desktop only, so Compass shows 14 of the 15 sections.
12. **Labels.** Explanatory parentheses are dropped from labels ("Directory (parties)" becomes "Directory"). Spanish labels use Spanish sentence case.
13. **Keys.** Opportunity, engagement and thread keys use an uppercase display-key type so they never collide with fixed path words. Org slugs reserve `advance`, `sign`, `legal`, `partner`, `ical` and `api`.

## Consequences

- The es-US navigation labels need native review before general availability, recorded in `packages/i18n/REVIEW.md` (Section 15).
- View types per list route are provisional until A31 publishes `packages/schemas/views.yaml`.
- A source lint that flags route paths outside the sitemaps (Section 3.15) is added to CI in Wave 2.
