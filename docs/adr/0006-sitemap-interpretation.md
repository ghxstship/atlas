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

## Amendment (2026-10-21): workspace and team settings pages (A86)

Section 4.5.6 asks for workspace, team and project settings as "short pages holding only the settings their scope can override". Project settings already had their tab; workspaces and teams had none (finding A65-004, trace row S4.5.6-43).

1. **Placement.** Each is a `record` node under its org settings section, not a new section: `settings.workspaces.workspace` at `/{org}/settings/workspaces/{workspaceSlug}` and `settings.teams.team` at `/{org}/settings/teams/{teamId}`. The org settings list keeps exactly its 42 sections in the spec's order, and the settings navigation does not list single workspaces or teams.
2. **Parameters.** `workspaceSlug` is a `slug` (workspaces carry one); `teamId` is a `uuid` (teams have no slug). Both are data parameters: a workspace or team that is not the org's answers 404. The page looks the row up itself, so the route guard leaves these two parameters to the page (`PAGE_RESOLVED_PARAMS` in `apps/atlas/ia/routes.config.ts`).
3. **Visibility.** Both inherit the Settings visibility: Owner and Admin, hidden for everyone else.
4. **Content.** A workspace page shows the settings a workspace may override, with the value's source and the org lock, and the workspace's members. A team page shows its members and says that no setting is set per team yet: no registered setting allows the team scope. Settings, Workspaces and Settings, Teams link to each page.
