# A59 visual review: what each user type sees

A read-only review of Atlas, Gateway and Compass as every seeded demo user type sees them, run on
2026-10-19 against main `69e8472e` (Linear RRR-104). No application code, test, migration or CI file
was changed. This folder holds the method, the scripts, compressed contact sheets and the evidence
images behind each finding. The findings are `legal/qa/findings/A59-001.md` to `A59-033.md`.

## Method

**Environment.** Production builds (`next build`, then `next start`) of Atlas on port 3059 and
Gateway on port 3159, both pointed at a private Supabase stack (`xos4-a59`, ports 583xx, full stack
with every seed in `supabase/seeds`). Compass was built in the Release configuration, with the
JavaScript bundle embedded and `EXPO_PUBLIC_*` aimed at the same stack, and run on the iPhone 17 Pro
simulator (iOS 26.5).

**Routes.** `scripts/plan.mjs` takes each shell's sitemap, applies `flattenRoutes` and
`isNodeVisible` for the person's role (as the a11y sweeps do) and fills the parameters with seeded
rows (project NWS, record NWS-1). For Gateway it adds the engagement tabs, the first opportunity and
the first thread that the person can reach from their own Work, Explore and Messages pages, so the
tabs are the role type's real set.

**Screenshots.** `scripts/capture-web.mjs` signs in through the UI as each person and captures every
visible route at desktop 1280 x 800 and at phone 375 x 812 (touch emulation), each in light and dark
(`data-theme` switched in place, as the a11y sweeps do, plus `prefers-color-scheme`). The shells
scroll an inner region, so the viewport is grown to the full content height before each capture,
capped at 9,000 px. Each visit also records the HTTP status, the final URL, console errors and
heuristic checks (horizontal overflow, clipped text, missing h1, raw keys, unfilled ICU arguments,
error boundaries); `scripts/summarize.mjs` tallies them.

**Key states and settings flows.** `scripts/capture-states.mjs`: the command menu (with results and
with no match), the shortcut sheet, focus mode, the account menu, the global peek and its missing
state, the full record page, Aurora (opened and asked; production has no model configured, so it
answers with its refusal), New project with More fields expanded and an empty submit, create forms
through `?create=1`, Viewer refusals and 404, the phone shell, Continue on another device, billing and
plan, usage, the IP allow-list (empty, invalid, valid, removed), emergency access (short reason,
missing second factor), an access review (open, confirm, remove, cancel), an invoice PDF download
(rendered to an image), and the anonymous auth and public pages of both shells.

**Workflows.** `scripts/run-workflows.sh` runs the existing Playwright journey specs unchanged
against these servers with `--trace=on`; `scripts/extract-traces.mjs` turns every trace into one
screenshot per user action (navigation, click, fill, press, assertion). All 19 runs passed.

**Compass.** `scripts/compass-review.sh` runs two Maestro flows written for this review
(`scripts/maestro/field-review.yaml`, `crew-review.yaml`) that reuse the app's sign-in subflow and
capture every tab, the clock punch with a break, the three scan modes with a refused badge, the
incident report, an inspection walk with a failed item, the offline queue, run of show and show mode,
logistics, workforce (announcements and forms), reference, Aurora, profile, settings and the account
deletion screen (looked at, not used), first in Light, then in Dark and Sunlight.

**Review.** Every screen was read through `scripts/contact.mjs review` sheets (nine desktop or
twelve phone tiles each) and full-size images where a sheet suggested a problem; DOM probes
(`scripts/probe.mjs`) confirmed the tab overflow, the phone breadcrumb and the phone Menu handler.

**Limits.** The demo data is fixed in 2027, so calendars that open on today are empty. The Viewer
has no project shared, so its 32 project routes answered 404 by design (not a finding by itself; see
A59-014). Owner's partner-console routes answered 404 because the demo Owner does not belong to the
partner org; the partner Owner's run covers them. The workflow specs change data, and they ran while
the sweeps were capturing, so a few counts differ between sheets. Heuristic checks found only what
they look for (one dotted key, for example, slipped past the raw-key pattern); the findings come from
looking at the screens.

## Coverage

### Route sweeps (each route at desktop and phone, light and dark)

| App     | User type (account)                   | Role or standing          | Routes | Screenshots |
| ------- | ------------------------------------- | ------------------------- | -----: | ----------: |
| Atlas   | Owner (owner@example.com)             | owner                     |    248 |         992 |
| Atlas   | Producer (producer@example.com)       | manager                   |    200 |         800 |
| Atlas   | Finance Lead (finance@example.com)    | manager, Commercial scope |     49 |         196 |
| Atlas   | Field Lead (field@example.com)        | field                     |    134 |         536 |
| Atlas   | Viewer (viewer@example.com)           | viewer                    |    148 |         592 |
| Atlas   | Partner Owner (partner@example.com)   | owner of demo-partner     |     34 |         136 |
| Gateway | Crew (crew@example.com)               | individual, crew          |     45 |         180 |
| Gateway | Vendor (vendor@example.com)           | account owner, vendor     |     54 |         216 |
| Gateway | Artist (artist@example.com)           | individual, artist        |     43 |         172 |
| Gateway | Client (client@example.com)           | account owner, client     |     42 |         168 |
| Gateway | Sponsor (sponsor@example.com)         | account owner, sponsor    |     41 |         164 |
| Gateway | Staff (staff.one@example.com)         | account member, staff     |     62 |         248 |
| Both    | Anonymous, token pages and key states | (see Method)              |     69 |         244 |
|         | **Total**                             |                           |  1,169 |       4,644 |

Atlas: 3,252 screenshots. Gateway: 1,148. States: 244 plus the rendered PDF. Workflow steps: 519.
Compass: 132 simulator screenshots (53 internal Field Tech, 26 external crew, and a first field pass
of 53 kept for comparison). All told, 5,749 full-resolution images.

### Workflows walked end to end

| Workflow (requested)                            | Walked by                                                                                                                                                                         | Steps |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| Project from template                           | `atlas-template` (a33-workflow: templates)                                                                                                                                        |    10 |
| Gate pass and refusal                           | `atlas-gate` (journey 2), `atlas-credential-scan` (journey 18, allowed and denied), Compass Main Gate refusal                                                                     |    58 |
| Budget with an unpriced line                    | `atlas-budget` (journeys 3, 33, 34, 37)                                                                                                                                           |    45 |
| RFQ to PO                                       | `atlas-rfq-po` (journeys 4, 30, 5)                                                                                                                                                |    47 |
| Crew offer to timesheet to payment, Atlas       | `atlas-crew-atlas` (journeys 10, 11, 12, 31)                                                                                                                                      |   119 |
| Crew offer to timesheet to payment, Gateway     | `gateway-crew-gateway` (journey 41)                                                                                                                                               |    23 |
| Vendor invoice from Submitted to Paid           | `gateway-vendor-invoice` (journeys 43, 56)                                                                                                                                        |    38 |
| Incident filed to closed                        | `atlas-incident` (journey 16, Atlas), Compass incident report                                                                                                                     |    23 |
| An import                                       | `atlas-import` (journey 27, with the refused upload)                                                                                                                              |    34 |
| A report to a dashboard                         | `atlas-report-builder`, `atlas-report-dashboard` (journey 29)                                                                                                                     |    32 |
| Downloading a generated PDF                     | states `atlas-documents-pdf` (invoice CFL-20481, US Letter)                                                                                                                       |     5 |
| Settings: billing and plan                      | states `atlas-settings-billing`                                                                                                                                                   |     3 |
| Settings: security (IP allow-list, break-glass) | states `atlas-settings-security`                                                                                                                                                  |     7 |
| Settings: access reviews                        | states `atlas-settings-access-review`                                                                                                                                             |     5 |
| Continue on another device                      | `atlas-handoff` (journey 58, Atlas half) and states `atlas-handoff`                                                                                                               |     8 |
| Also walked                                     | `gateway-tokens` (signing and advance links), `gateway-artist`, `gateway-client`, `gateway-sponsor`, `gateway-staff` (journeys 45, 46, 47, 42), `atlas-finance-lead` (journey 51) |    84 |

The Compass half of Continue on another device (opening the decoded link in the simulator) was not
repeated; A45's flow covers it.

## Top issues by severity

| #   | Severity | Finding                                                                                    | Where                     |
| --- | -------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| 1   | High     | [A59-001](../findings/A59-001.md) Phone bottom bar Menu does nothing                       | Atlas, every role, phone  |
| 2   | High     | [A59-002](../findings/A59-002.md) Tips and the tour cover drawers and their primary action | Atlas, first visits       |
| 3   | High     | [A59-003](../findings/A59-003.md) Five project tabs hidden at 1280 px, no overflow cue     | Atlas, project pages      |
| 4   | High     | [A59-004](../findings/A59-004.md) Phone breadcrumb clipped at the top, overlaps titles     | Atlas, every phone page   |
| 5   | Medium   | [A59-005](../findings/A59-005.md) Phone settings: 40-item list above every form            | Atlas settings, phone     |
| 6   | Medium   | [A59-006](../findings/A59-006.md) Inbox items read "Update / announcement.posted"          | Atlas Inbox               |
| 7   | Medium   | [A59-007](../findings/A59-007.md) "Use undefined and undefined" on Numbering               | Atlas settings            |
| 8   | Medium   | [A59-008](../findings/A59-008.md) Owner avatar drawn over the date in record rows          | Atlas record lists        |
| 9   | Medium   | [A59-010](../findings/A59-010.md) Report incident link shows Credentials copy, no form     | Atlas Safety              |
| 10  | Medium   | [A59-011](../findings/A59-011.md) External people shown as "Unnamed person"                | Atlas People, Credentials |

All 33 findings:

| Severity | Count | Findings                           |
| -------- | ----: | ---------------------------------- |
| High     |     4 | A59-001, A59-002, A59-003, A59-004 |
| Medium   |    23 | A59-005 to A59-026, A59-033        |
| Low      |     6 | A59-027 to A59-032                 |

Medium, beyond the top ten: raw UUIDs as row keys (009), clipped wide tables and boards (012),
phone tables not becoming cards (013), setup checklist and plan card for Field and Viewer, and the
Viewer's empty-state loop (014), a command menu without records, people or actions (015), a stub
global peek (016), codes without plain names (017), a Save per settings field (018), emergency access
with no way to verify (019), no entry to the Partner Console for a new partner (020), Gateway
lifecycle copy wrong on a Complete engagement (021), an empty "Current shift" card in Compass (022),
the clipped gate button on phones (023), an invalid invite checked only after sign-up (024),
auth forms with two Email fields and draft legal pages (025), Compass bounce pages and Refresh-only
empty states (026), and pay-rate framing shown to clients and sponsors (033).

Low: feed post controls (027), an hours-only countdown in Compass (028), inconsistent controls
across pages and shells (029), activity lines without record names (030), Compass header spacing
(031), and Usage and Templates empty states that contradict other pages (032).

**What held up well.** No route at 375 px scrolls horizontally; every route has a visible h1; no
error boundary, filler text or `[object Object]` appeared anywhere; dark and light read equally well
(no dark-only problem was found); validation messages on the IP allow-list, emergency access,
inspection failures and project creation name the field and the fix; the budget keeps an unpriced
line out of totals and says so in every place it is summed; the generated invoice PDF is clean.

## Files

- `scripts/`: the capture, workflow, Compass, contact-sheet, evidence and probe scripts (plain ESM,
  run with `node` from this folder). Start with `capture-web.mjs`, `capture-states.mjs`,
  `run-workflows.sh` and `compass-review.sh`.
- `sheets/`: 47 compressed contact sheets (4.6 MB). Atlas sweeps in dark at desktop and light on the
  phone, Gateway sweeps and the states in light at desktop and dark on the phone, one sheet per
  workflow and per Compass flow. `index.json` lists them.
- `evidence/`: 53 compressed images, named after the finding they support (`A59-NNN-n.jpg`).
- `shots/` (gitignored): every full-resolution screenshot (JPEG 80 for the web, PNG from the
  simulator), the per-person JSON results with checks, workflow traces and step images, and logs.
  On the review machine: `legal/qa/visual-review/shots/` in the A59 worktree, 536 MB.
