# ADR 0121: Onboarding Progress and Changelog Entries Without Their Own Tables

- Status: Accepted
- Date: 2026-10-28
- Decider: A150 (RRR-213)
- Migrations: none

## Context

Section 7.3 lists five product tables added in 1.3: `onboarding_progress`, `sandbox_orgs`, `changelog_entries`,
`feedback_submissions` and `shortcut_bindings`. Three exist: `app.sandbox_orgs` (1530), `app.feedback_submissions`
(1531) and `app.shortcut_bindings` (1370). The requirements trace keeps S7.3-09 Partial because the other two do not,
and finding A65-022 points to where their data lives instead.

Section 11.7 says what they are for:

- "A new org gets an eight-step onboarding checklist: brand, members, first project, jurisdiction, budget, schedule,
  Compass invite, integration."
- "A guided tour is offered, never forced."
- "The What's New panel reads from the published changelog."

Both needs are already met without the two tables, and this record says so, table by table, so the trace can map
them.

## Decisions

### 1. `onboarding_progress` is `app.tour_progress` plus the derived setup checklist

Onboarding progress has two parts, and each is kept where it can be trusted.

- **Guided tours: `app.tour_progress` (0642).** One row per member and tour key, written the first time a tour is
  offered, with `tour_state` (Offered, Started, Completed or Dismissed) and the last `step` reached.
  `private.guard_tour_progress` keeps the key fixed, offers a tour only once and lets only a replay move a completed
  tour back. Row level security limits each row to its member. `app.tip_dismissals` (0642) sits beside it for the
  contextual tips. Atlas reads and writes both through `packages/data/src/help.ts`, and the v1 contract serves the
  caller's rows at `/tour-progress`.
- **The setup checklist: derived, never stored.** Home (`apps/atlas/app/[org]/home/page.tsx`) lists the eight
  steps to an Owner or Admin, leaves out a step whose page the viewer cannot open, and marks a step Done only when the
  organization's data proves it: members when someone other than the Owner has joined or been invited, the first
  project when a project exists.

Why not a table:

- Whether a step is done is a fact about the org's data. A stored flag could say a project exists after it was
  deleted, or miss members who joined through a domain or partner bootstrap. Reading the data is always right, and
  Home already reads it for its tiles.
- What is not derivable, whether a person has seen, finished or dismissed a tour, is a person's choice, and
  `app.tour_progress` stores exactly that, per member, as Section 11.16 needs for "offered once, replayable from Help".
- Renaming `app.tour_progress` to `onboarding_progress` would change a released table, its policies, its catalog
  entries and a frozen v1 resource, for no change in behavior.

### 2. `changelog_entries` is the versioned What's New files

- **Entries: `apps/atlas/help/whats-new.yaml` and `apps/gateway/help/whats-new.yaml`.** Each entry has a key, a
  date and the help article that explains the change, newest first. `packages/help/src/load.ts` parses them with a
  strict schema, and `helpProblems` refuses an entry whose article does not exist.
- **Copy: the i18n catalogs.** The title and body of each entry live in `help.whatsNew.<key>` (Gateway:
  `help.gateway.whatsNew.<key>`) in every locale, so the entries are translated, checked and shipped with the rest of
  the app's copy. The docs test fails when an entry has no title in a locale.
- **Publishing: the help panels and the help center.** The Atlas and Gateway help panels show What's New from the
  generated help content, and the docs help center (`apps/docs/lib/content.ts`, `whatsNew()`) publishes the Atlas
  file. That page is the published changelog Section 11.7 names.

Why not a table:

- An entry describes what a release ships, so it belongs in the same commit and review as the change it announces,
  and goes out with that release. A row in a database would be written separately and could announce a feature
  before it is deployed, or after it is removed.
- Entries are the same for every organization. A table would carry no `org_id` and no tenant policy, and would need
  seeding in every environment, an editor for platform staff and a translation flow of its own, which the catalogs
  already give.
- A self-hosted deployment shows the changelog of the version it runs, from its own files, with nothing to sync.

### 3. The mapping

| Section 7.3 table     | Kept in                                                                                                                                            | Written by                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `onboarding_progress` | `app.tour_progress` and `app.tip_dismissals` (0642) for each member's tours and tips; the eight-step checklist derived on Home from the org's data | The help panel and tour runner (`packages/data/src/help.ts`, `/tour-progress`) |
| `changelog_entries`   | `apps/atlas/help/whats-new.yaml` and `apps/gateway/help/whats-new.yaml`, with copy in `help.whatsNew.<key>` and `help.gateway.whatsNew.<key>`      | Each release, in the commit that ships the change                              |

## Alternatives considered

- **An `onboarding_progress` table of checklist steps marked done.** Rejected for the reasons in decision 1: it
  duplicates the data it summarizes and can disagree with it.
- **A `changelog_entries` table with translated rows.** Rejected for the reasons in decision 2.
- **Views named `onboarding_progress` and `changelog_entries`.** Rejected: a view over `tour_progress` would only
  rename it, and the changelog is not in the database.

## Consequences

- The data dictionary has no `onboarding_progress` or `changelog_entries`; S7.3-09 points to this record for both.
- Today Home derives Done for two of the eight steps, members and the first project. The other six (brand,
  jurisdiction, budget, schedule, Compass invite and integration) link to their pages and never show Done. Each is
  to be derived from its own data when it is built (the org brand, a jurisdiction on a project, a budget, a
  milestone, a Compass device, an integration connection), never from a stored flag.
- `app.tour_progress` rows are readable only by their member, so the Owner's full export carries the Owner's own tour
  progress and not other members' (see the docs site's Full export guide).
- A changelog that differs by organization, such as an org's own announcements, would be a new decision and a new
  table with an `org_id`.
