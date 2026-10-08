# XOS 4.0 Build Prompt: Atlas 4.0, Gateway 4.0 and Compass 4.0

Experiential Operating System 4.0 · Master build prompt for a coordinated agent build across Claude Design and Claude Code
Owner: Julian Clarkson, GHXSTSHIP Industries LLC · Prompt version 1.6 · 2026-10-08

---

## 0. How to Use This Prompt

This document is the single instruction set for building Atlas 4.0 (internal web app), Gateway 4.0 (external web app) and Compass 4.0 (field mobile app for both) from an empty repository. It is written for an orchestrator agent that spawns and coordinates specialist agents. Read the whole document before starting. Every section is binding unless it says otherwise.

Precedence when two instructions conflict:

1. Section 3 (XOS 4.0 Doctrine) and the canon input files in Section 2
2. Section 14 (Compliance) and Section 9 (Security)
3. Section 19 (Agent Protocol)
4. Every other section

If something is still ambiguous after applying this order, the orchestrator records an Architecture Decision Record (ADR) in `docs/adr/` with the decision, the alternatives and the reason, then proceeds. Agents never stop to wait for a human on a reversible decision. They stop only for the irreversible actions listed in Section 19.8.

---

## 1. Mission and Outcome

Build a production-grade, multi-tenant, white-label, open-source SaaS platform that turns the XOS 4.0 Production Playbook into software. The platform has three surfaces:

- **Atlas 4.0**: the internal web application. Members of an organization use it to plan, budget, procure, staff, advance and close experiential productions. Only internal org members can sign in to Atlas.
- **Gateway 4.0**: the external web application. Vendors, contractors, clients, crew, staff, artists, artist representatives and sponsors use it to find opportunities, apply, get onboarded, deliver their engagements and get paid. It is the only web surface external users ever see.
- **Compass 4.0**: the field-optimized iOS and Android app for on-site operations. It serves internal and external users alike, and shows each person only what their role and engagements allow. It works offline, uses large touch targets and handles scanning and capture.

All three run on one backend, one database, one API and one design system.

The build is complete when every item in Section 20 (Acceptance Criteria) passes in CI and in a deployed staging environment. "Complete" means no placeholder copy, no stubbed endpoints, no TODO comments, no mock data in production code paths and no unimplemented screens.

---

## 2. Canon Inputs

These files are the source of truth for taxonomy, vocabulary, lifecycle and finance structure. They live in the owner's Google Drive, in the Poseidon_XOS-4.0 folder. No attachments are needed: the canon agent fetches each file from its link below into `canon/source/` as the first step of Wave 1. Agents must parse the files programmatically and never retype values from them by hand.

| File | Role | Link | Fetch as |
| --- | --- | --- | --- |
| XOS 4.0 Bible | Single source of truth: 37 tabs covering departments, disciplines, categories, acts, phases, gate criteria, tiers, teams, tags, touchpoints, jurisdictions, regions, escalation, staleness, permit rules, metrics, identifier grammar, grain, provenance, facets, identity doctrine, assertion ranks, silence rule, record kinds, record subtypes, record states, roles, counterparty types, GL accounts, cost centers, category to GL, item catalog, coordinate matrix, budget template spec, change record, Universal Posting Line and states | [XOS_4.0_Bible.xlsx](https://drive.google.com/file/d/13nY5TNM71uXAcWbfiJaf5QpQPdCUFvQQ/view) (Google Sheets copy: [XOS_4.0_Bible](https://docs.google.com/spreadsheets/d/19-WclVSA_VCNJ9n5vBeH_DrWxu_aeeVicPXCGV1Hho4/edit)) | `canon/source/XOS_4.0_Bible.xlsx` |
| XOS 4.0 Production Playbook | The operating template: 45 working sheets that define the modules, records and columns users work in | [XOS-4.0_Production-Playbook_2026](https://docs.google.com/spreadsheets/d/1p5Yxgyp5G09WR9X6sj8Btim2IM5vr-Zhe5eEvokn15w/edit) | `canon/source/XOS-4.0_Production-Playbook_2026.xlsx` (Google Sheets export to .xlsx) |
| XOS 4.0 Item Catalog | 1,211 catalog items with pricing evidence and three grades | [XOS_4.0_Item_Catalog.csv](https://drive.google.com/file/d/1rum0_qhVdu4Dty608yNq8mqQ-fKR1GOQ/view) | `canon/source/XOS_4.0_Item_Catalog.csv` |
| XOS 4.0 GL Chart of Accounts | The fixed 23-account chart | [XOS_4.0_GL_Chart_of_Accounts.csv](https://drive.google.com/file/d/1WQR9rV5Guyx3J-qfxj8eThQKG-0m4xP_/view) | `canon/source/XOS_4.0_GL_Chart_of_Accounts.csv` |
| XOS 4.0 Kit (supplementary) | The packaged kit the Bible ships in; reference only | [XOS_4.0_Kit.zip](https://drive.google.com/file/d/1xmq0KYsh9DhneaFrE_pmXd9ZLSeSTiKi/view) | `canon/source/XOS_4.0_Kit.zip` |
| XOS 4.0 Templates (supplementary) | Document templates for generated outputs; reference only | [XOS_4.0_Templates.zip](https://drive.google.com/file/d/1HTk7-scm8V7Yq8Azb6fsh-iP6R7Ed77q/view) | `canon/source/XOS_4.0_Templates.zip` |
| Canon folder | All of the above | [Poseidon_XOS-4.0](https://drive.google.com/drive/folders/1ANXAKA2VC_PmiqLl3bcrtiyHDSu6bFN4) | Not applicable |

How to fetch:

1. **Google Drive connector (preferred).** Download each file by its ID, authenticated as the owner. Export the Playbook from Google Sheets as .xlsx; the Bible is downloaded as the stored .xlsx.
2. **Shared link.** If the owner has set the files to "Anyone with the link can view", use these direct forms:
   - Stored files: `https://drive.google.com/uc?export=download&id=<file id>`
   - Google Sheets: `https://docs.google.com/spreadsheets/d/<file id>/export?format=xlsx`
3. **If neither path is available,** stop and report to the orchestrator. Never substitute values from memory or from this prompt.

After fetching, the importer records the SHA-256 hash and Drive modified time of each file in `canon/source/MANIFEST.json`. CI re-checks the hashes, so a canon change is always a deliberate, reviewed commit.

The canon agent writes a deterministic importer (`canon/import/`) that does three things:

- It reads these files.
- It validates every count stated in the Bible against the parsed rows: 10 departments, 114 disciplines, 291 categories, 3 acts, 9 phases, 35 gate criteria, 6 tiers, 42 tags, 90 touchpoints, 7 jurisdictions, 5 regions, 22 permit rules, 39 metrics, 26 record kinds, 124 record subtypes, 9 record states, 61 roles, 22 counterparty types, 23 GL accounts and 1,211 items.
- It emits SQL seed migrations.

A count mismatch fails the build. The importer is idempotent and re-runnable when the Bible changes. Canon changes ship as data migrations, never as code edits.

### 2.1 Playbook Import: No Data Loss

The Playbook holds data the Bible does not. The importer loads every row and every column of all 45 working sheets and the Cover Page. Nothing is rebuilt by hand, sampled or summarized.

**Source manifest.** Before any mapping, the importer reads the Playbook and writes `canon/source/PLAYBOOK_MANIFEST.json`. For each sheet it records:
- the sheet name and used range
- the header row and every column header
- the data row count
- a SHA-256 checksum of the normalized cell values

The counts and checksums come from the file, never from this prompt. Every later check runs against this manifest.

**Destination by sheet.** Every sheet lands in exactly one of three destinations:

| Destination | Sheets | Rule |
| --- | --- | --- |
| Bible-mirrored canon | Categories & URID Master, Cost Centers, Counterparty Types, Departments, Disciplines, GL Accounts, Procurement Catalog, Teams | The Bible is loaded into `xpms`. The Playbook rows are cross-checked against it value by value (the Procurement Catalog against the Item Catalog CSV). Any difference fails the build and is written to `canon/reports/playbook-bible-diff.md` for the owner to decide. Neither file silently wins. |
| XOS Standard Library | Document & Asset Library, Emergency Codes, Enumerations, Labor Rate Cards, Radio Channels, Roles Library, SOP Library, Vendor Classes, Vendor Entitlements, Verbiage Library | Loaded into `xpms.std_*` tables with provenance `imported`. Each new org receives an editable copy at creation. Role codes in the Roles Library are cross-checked against Bible tab 27; Enumerations are cross-checked against the Bible's states and enums. Conflicts fail the build and are reported. |
| XOS 4.0 Production Template | Access Grid, Activity Log, Advance Requests, Asset Assignments, Asset Inventory, Budget Expenses, Change Orders, Credential Issuance, Crew Shifts, Crew Timesheets, Hospitality Fulfillment, Incident CAD Log, Inspection Compliance, Locations, Marshalling Yard Log, Personnel Roster, PO Line Items, Production Schedule, Production Tasks, Projects, Purchase Orders, Run of Show, Shipping Manifest, Staffing Requisition, Universal Posting Line, Vendor Directory, Work Orders | Every column becomes a field of its target entity. Every row is preserved as content of the XOS 4.0 Production Template. Applying the template creates a project with those records. The Cover Page becomes the template's metadata. |

**Column map.** The importer generates `canon/map/playbook-columns.yaml`, and A01 completes it. Every column of every sheet carries exactly one of three dispositions:

- `field`: the target `schema.table.column`, data type and transform.
- `computed`: a generated column or view that reproduces a formula column. The importer verifies that the computed value equals the source value on every row.
- `presentation`: layout only, such as a spacer or heading cell. A one-line reason is required.

CI fails if any column is unmapped, if a `field` target is missing from the schema, or if a `field` is missing from the matching OpenAPI schema.

**Real-world data.** Template rows may name real people, companies, venues or prices. The import report lists every such row. The template stays private to the owner's org until the owner approves publishing it to other tenants, which is a stop condition under Section 19.8. The Northwind Live demo tenant never uses these rows.

**Round-trip proof.** A CI test exports every imported sheet back to .xlsx from the database and compares it with the source cell by cell, after normalizing whitespace, number format and date format. Any lost row, lost column or changed value fails the build.

---

## 3. XOS 4.0 Doctrine (Non-Negotiable)

These rules are product law. They apply to schema, API, UI copy, seed data and tests.

### 3.1 One System, One Canon Schema

- XOS 4.0 is XPMS 3.0 canon with the 4.0 grammar applied, as one system.
- All canon lives in the Postgres schema `xpms`. The URN namespace is `urn:xpms`. There is no separate `xos` schema.
- Tenant operational data lives in the schema `app`.
- Public read projections live in the schema `api_public`. Internal helpers live in `private`.

### 3.2 Department Classes (Locked)

Ten classes, always listed in numeric order:

| Code | Department |
| --- | --- |
| 0000 | Executive |
| 1000 | Creative |
| 2000 | Talent |
| 3000 | Marketing |
| 4000 | Environment |
| 5000 | Production |
| 6000 | Operations |
| 7000 | Experience |
| 8000 | Hospitality |
| 9000 | Technology |

Department 4000 is Environment. The word Build is reserved for gate 5 and the Build record kind.

### 3.3 URID Grammar

- The format is `DDDD.DD.DD`: department, then discipline, then category. There is no fourth segment.
- Canon disciplines and categories hold `.01` to `.49`. Adopter (tenant) extensions hold `.50` to `.99` and are scoped to their org.
- The URID is the universal semantic key across taxonomy, GL dimension 2, the catalog, schedule records, roles and spaces.

### 3.4 Phases, Gates and Acts

Nine gated phases with fixed ordinals (append-only):

| Gate | Code | Phase | Act |
| --- | --- | --- | --- |
| 1 | SCP | Scope | PLAN |
| 2 | ENG | Engage | PLAN |
| 3 | ADV | Advance | PLAN |
| 4 | PRC | Procure | BUILD |
| 5 | BLD | Build | BUILD |
| 6 | INS | Install | BUILD |
| 7 | OPR | Operate | SHOW |
| 8 | AMP | Amplify | SHOW |
| 9 | CLS | Close | SHOW |

- Acts are presentation groupings only. Gates are the only control points.
- The 35 gate criteria come from Bible tab 06. A blocking criterion stops the gate transition, and the database enforces it, not only the application layer.
- Every gated phase must carry at least one Active element or a declared gap.
- Gate evidence uses one evidence spine, so adding a criterion requires no migration.
- Phase participation of an element is multi-valued through `xpms.bridge_element_phase`.

### 3.5 Tiers of Experience

Six tiers: 01 Social, 02 Digital, 03 Virtual, 04 Physical, 05 Experiential, 06 Theatrical.

International is never a tier. Geography is carried by Jurisdiction, a first-class dimension resolved per project at gate 1.

### 3.6 Vocabulary and Naming

- **Element**: the unit of the catalog. Never "atom".
- **phase**: time-bounded macro arcs.
- **state**: repeatable operational states. Lifecycle state machines name their column `*_state`, and their ledger `*_state_transitions`.
- **status** is a permitted identifier in XOS 4.0. Use it where it reads naturally, for example for integration sync status, delivery status or a derived health indicator.
  - This prompt supersedes the line in Bible tab 17 that bans `status`. The importer must not carry that ban into lint rules, constraints or checks.
- **Identifier grammar** (Bible tab 17):
  - An *identifier* is issued by an external authority (GTIN, MPN, UNSPSC, GPC brick, serial). It is recorded and validated, never minted.
  - A *code* is ours (URID, element_id, asset_tag, phase_code).
  - A *token* is path-local and never used as a join key.
- **Item IDs**: `{URID}-{ORG}-{SEQ}`.
- **XYZ** is a schema-family tag, not cost behavior:
  - X = Resource (people, teams and companies, locations, inventory)
  - Y = Process (scope, workflows, services, subscriptions)
  - Z = Timeline (events, activations, logistics)
  - Every item, record and budget line carries an XYZ tag with its basis stored beside it.
- **Naming standard**:
  - Proper names, taxonomy labels, item names and enum display values are Title Case. Descriptions and definitions are sentence case and period-terminated.
  - The ampersand is kept in Title Case labels and written as "and" in sentence-case prose.
  - No em dashes anywhere in UI copy, seed data or documents. Dimensions are written as 3 ft x 3 ft 2 in.
- **Locale**: American English by default. Canceled, never Cancelled.
- **Ordering**: every coded list (GL accounts, disciplines, categories, criteria, cost centers, items, emergency codes) is sorted in numeric order in the database default sort, API responses and UI.

### 3.7 Silence Rule and Refusal Semantics

- An absent claim is rank 0 and resolves as a refusal, never as a permissive default.
- A blank price is unpriced; a zero is a claim. NULL price is a UI contract:
  - It is never coerced to 0 or an empty string.
  - It renders as "Unpriced".
  - Aggregates of blanks are blank.
- Refusal outcomes are first-class values: `NO_ANSWER`, `UNRATIFIED`, `REFUSE`. Functions that resolve claims return them instead of guessing.
- An UNKNOWN against a critical requirement is a gap at gate 3.
- An unpopulated jurisdiction returns no answer for permit and code questions. It never passes.

### 3.8 Provenance, Assertion and Staleness

- **Provenance ranks** (Bible tab 19): human 100, operator 80, imported 60, agent 40, provider 20.
  - A lower rank never overwrites a populated field written by a higher rank.
  - Every canon field write records its provenance.
- **Assertion ranks** (Bible tab 22) run from 4 to 0:
  - Economics: QUOTED, PUBLISHED, BENCHMARKED, MODELED, EXPIRED
  - Compliance: CODE, STANDARD, MODELED
  - Capability: CERTIFIED, DOCUMENTED, CLAIMED, INFERRED, UNKNOWN
- **Staleness policy** (Bible tab 14):
  - At 12 months, a price band degrades one step.
  - At 24 months, it degrades to MODELED.
  - At 36 months, it expires.
  - Effective confidence is computed at read time.

### 3.9 Identity Doctrine

- The crosswalk runs GTIN to GPC brick to UNSPSC to URID. It is proposed and human-confirmed, never automatic.
- Many GTINs map to one element. One GTIN maps to at most one element. Never "fix" this into one-to-one.
- **Grain**:
  - *class*: what a catalog row is
  - *unit*: an individual physical thing, tracked by serial or asset tag
  - *lot*: a quantity of a class at a place

### 3.10 Record Model

- **26 record kinds in five classes** (Bible tab 24):
  - Work: Build, Rehearsal, Shift, Strike, Task, Training
  - Artifact: Document, Supply
  - Commitment: Booking, Contract, Payment, Recruitment
  - Control: Approval, Compliance, Deadline, Decision, Inspection, Permit
  - Time: Distribution, Event, Goal, Meeting, Milestone, Report, Risk, Timeline
- **Subtypes**: 124 kind-scoped subtypes (Bible tab 25). A subtype for one kind cannot be stored on another; a composite foreign key enforces this.
- **Titles**: each kind has a title grammar (imperative verb first, noun phrase, or completed-state phrase), validated on write with a clear correction message.
- **Record states** (nine): Proposed, Ready, Scheduled, Active, Blocked, In Review, Complete, Deferred, Canceled. A Blocked record must name its blocker. A Deferred record must carry a replan reason. Canceled records are retained, never deleted.
- **Replan logging**:
  - While a record is Proposed, edits overwrite with no log entry.
  - From Scheduled onward, every date or state change is a logged replan.
- **Shared finance and commercial state vocabulary**: Proposed, Active, Blocked, Complete, Canceled, plus declared domain extensions.

### 3.11 Finance Standard

The account answers what. The dimensions answer where and why.

- **GL chart**: 23 fixed accounts, coded with one ledger-type digit, one class digit and 00.
  - Expense accounts run 5000 to 5900, one per department class.
  - Revenue accounts are grouped by earning class, plus a small balance sheet set.
  - Seed the chart from the GL chart CSV. Tenants cannot add accounts. They map their own chart through the accounting integration.
- **Dimensions**:
  - Dimension 1 is the cost center: CC-VENUE, CC-CORP, and one per event scope.
  - Dimension 2 is the URID at discipline or category grain.
  - Every category maps to a GL account (Bible tab 31).
- **Universal Posting Line (UPL)**: one export row shape (Bible tab 36), projected to Xero, QuickBooks Online, NetSuite and Ramp through field mappings. There is no other export format.
- **Fee and Contingency** are line types, not accounts.

### 3.12 Lifecycles

Each of these is a separate database state machine with a transition ledger:

1. Project
2. Production
3. Asset
4. Deliverable
5. Engagement
6. Engagement-Document
7. Financial Period
8. Subscription

### 3.13 Ratification

- 4.0 grammar is proposed until a named ratifier is recorded. Supersession is data, so reverting is a data change.
- The platform stores the ratification record and the supersession graph, which must stay acyclic (enforced by trigger).
- DIS and DSN are superseded by SCP. Store them as superseded codes so historical references resolve.

### 3.14 Exclusions

- Retired brand terms are never referenced.
- Past third-party brand activations are never used as seed, demo or example data.
- The demo tenant is a fictional production company named Northwind Live, with fictional projects.

### 3.15 Single Source of Truth and Third Normal Form

Every fact in XOS has exactly one home, and everything else reads from it. This rule covers data, configuration, copy, design, permissions, navigation and documentation, in all three shells.

**Data**
1. The database schema is in Third Normal Form:
   - Every non-key column depends on the key, the whole key and nothing but the key.
   - There are no repeating groups and no arrays of foreign keys; relationships use junction tables.
   - No column restates a fact stored elsewhere.
2. Derived values are never stored by hand. They are views, generated columns or materialized views.
   - Totals, counts, readiness, balances, coverage and rollups are all derived.
   - A materialized view exists only for measured performance, is refreshed by the system, and is never written by application code. Each one is listed in `docs/adr/denormalization-register.md` with its source, refresh rule and reason.
3. Every closed list of values (states, kinds, types, categories, units, currencies, countries, time zones) lives in a reference table or a Postgres enum. Display labels come from the i18n catalogs keyed by the stored value. No list is redefined in application code.
4. The canonical identity model (Section 4.8) is the only place people, organizations and their relationships are stored. Earlier mentions of per-org party records mean the org-side relationship row, which holds only org-owned facts.
5. The Compass device database and every browser cache are synchronized copies, never sources. The server copy wins every conflict except the user-resolved field conflicts described in Section 11.7.

**Generated, never hand-written**

| Artifact | Single source | Generated outputs |
| --- | --- | --- |
| Data shapes | Postgres migrations | TypeScript database types, PowerSync schema, data dictionary |
| API contract | Zod route definitions, checked against the database types | OpenAPI document, TypeScript and Python SDKs, API reference, MCP tool list |
| Canon | The XOS 4.0 Bible and Playbook (Section 2) | `xpms` seed migrations, Standard Library, Production Template |
| Navigation | `apps/atlas/ia/sitemap.yaml`, `apps/gateway/ia/sitemap.yaml`, `apps/compass/ia/sitemap.yaml` | Sidebars, tab bars, routes, breadcrumbs, route guards, command menu index |
| Permissions | `packages/schemas/capabilities.yaml` | Capability seed rows, RLS helper constants, UI permission checks, API scopes, docs |
| Design | `packages/tokens` | CSS variables, React Native theme, Storybook docs, Claude Design token export |
| Copy | `packages/i18n` message catalogs | Every label, message, email and notification in every locale |
| Notifications | `packages/schemas/notification-kinds.yaml` | Notification kind rows, preference matrix, templates index |
| Plans and limits | `packages/schemas/plans.yaml` | Plan rows, `private.org_plan_limits`, pricing page, Stripe products |
| Shortcuts | `packages/schemas/shortcuts.yaml` | Key bindings, shortcut sheet, command menu hints, docs |
| View types | `packages/schemas/views.yaml` (Section 11.15) | View switchers, default views, saved view validation |
| Help content | `apps/docs/content` | Help center, contextual help panel, tooltips with "Learn more" links |
| Settings | `packages/schemas/settings.yaml` (Section 4.5.6) | Settings pages, defaults, API, audit labels |
| Legal documents | `legal/` with versions | `/legal` pages, acceptance records |

**Enforcement in CI** (Section 18):
- Generated files are regenerated and diffed. Any hand edit fails the build.
- A schema lint fails on:
  - arrays of identifiers
  - JSON columns holding relational data outside the documented exceptions (rich text documents, audit diffs, provider payloads)
  - columns that duplicate a column in a referenced table
  - stored totals without a register entry
- Source lints fail on:
  - raw color values outside tokens
  - user-facing string literals outside catalogs
  - capability strings outside the registry
  - route paths outside the sitemaps
  - state or kind values defined in code instead of generated types

---

## 4. Product Scope

### 4.1 Personas

| Persona | Surface | Primary jobs |
| --- | --- | --- |
| Org Owner | Atlas | Billing, white label, security policy, data rights |
| Org Admin | Atlas | Members, roles, integrations, canon extensions |
| Producer | Atlas | Projects, gates, scope, budget, schedule, approvals |
| Department Head | Atlas, Compass | Discipline scope, requisitions, vendors, run of show |
| Finance Lead | Atlas | Budget, POs, change orders, ledger, periods, UPL export |
| Production Coordinator | Atlas | Advancing, logistics, hospitality, documents |
| Field Supervisor | Compass, Atlas | Shifts, timesheet approval, inspections, incidents |
| Field Employee | Compass | The org's own field staff: my shifts, clock in, tasks, day sheet, incident report |
| Client | Gateway, Compass | Review, approve, comment, view reports and the show-day schedule |
| Vendor | Gateway, Compass | Bid on RFQs, onboard, acknowledge POs, deliver, invoice |
| Contractor | Gateway, Compass | Apply for scoped work, onboard, deliver milestones, invoice |
| Crew | Gateway, Compass | Apply for crew calls, onboard, work shifts, submit time, get paid |
| Staff | Gateway, Compass | Event staff, individually or through an agency: apply, train, work positions |
| Artist | Gateway, Compass | Receive offers, advance, perform, settle |
| Artist Representative | Gateway | Act for the artists they represent under delegated permissions |
| Sponsor | Gateway, Compass | Buy sponsorship, approve assets, track entitlement fulfillment |
| Platform Operator | Internal console | Tenant support with consented, logged access only |

Internal personas (above Client) are org members and use Atlas. External personas are never org members. They hold engagements with the org, use Gateway, and use Compass on site.

### 4.2 Atlas Modules

Every playbook sheet is implemented. The table maps each one to its module and to the record kind or entity it becomes.

| Atlas module | Playbook sheets | Core entities |
| --- | --- | --- |
| Home | Cover Page | Org dashboard, my work, gate readiness, alerts |
| Projects | Projects | Project, scope tree (engagement, standing venue, show), jurisdiction, gate evidence |
| Activity | Activity Log | Activity feed (separate from the compliance audit ledger) |
| Schedule | Production Schedule | Timeline records, baselines, dependencies, calendars, actuals |
| Work | Production Tasks, Work Orders | Task, Build, Strike, Rehearsal and Training records; work orders with bids |
| Show | Run of Show | Run of show, cues, day sheets, call sheets |
| Knowledge | SOP Library, Document & Asset Library, Verbiage Library | SOPs with acknowledgment, documents with versions, controlled vocabulary |
| Places | Locations | Venues, spaces, zones, capability documents, site plans |
| Logistics | Shipping Manifest, Marshalling Yard Log | Shipments, dock slots, gate queue, staging and release |
| Advancing | Advance Requests | Advance packets, sections, recipients, submissions, riders, reconciliation |
| Hospitality | Hospitality Fulfillment | Lodging, catering, travel and amenity fulfillment, BEOs |
| Assets | Asset Inventory, Asset Assignments | Assets at class, unit and lot grain; custody; maintenance; damage |
| Opportunities | None (extends Staffing Requisition, Purchase Orders, Vendor Entitlements) | Requisitions turned into opportunities, applications, selection, offers, onboarding, external engagements, ratings, talent and vendor pools |
| People | Personnel Roster, Staffing Requisition, Roles Library | Parties, roles (61 workforce roles with staffing ratios), requisitions, offers, agreements |
| Crew | Crew Shifts, Crew Timesheets, Labor Rate Cards | Shifts, swaps, time entries, timesheets, rate cards, pay rate ledger, payroll export |
| Credentials | Credential Issuance, Access Grid | Credential categories, issuance, zone by category access matrix, scans |
| Finance | Budget Expenses, Change Orders, Universal Posting Line, GL Accounts, Cost Centers | Budget lines, expenses, change orders, ledger, periods, UPL export |
| Procurement | Purchase Orders, PO Line Items, Procurement Catalog | RFQs, POs, receipts, three-way match, catalog (1,211 items) |
| Vendors | Vendor Directory, Vendor Classes, Vendor Entitlements | Vendors, classes, prequalification, COIs, scorecards, sponsor entitlements |
| Safety | Inspection Compliance, Incident CAD Log, Emergency Codes, Radio Channels | Inspections, permit engine, incidents with dispatch, emergency codes, radio plan |
| Canon | Departments, Disciplines, Categories & URID Master, Teams, Counterparty Types, Enumerations | Read-only canon browser; tenant extensions in `.50` to `.99` |
| Reports | All | Gate readiness, coordinate matrix (90 coordinates), budget versus actual, labor, POs, incidents, final cost report |
| Settings | None | Org, members, roles, security, white label, integrations, billing, data and privacy |

### 4.3 Compass Scope

Compass is purpose-built for field use, not a shrunken Atlas. It serves internal members and external users with one app and one sign-in. What a person sees depends on their internal role or external role type and on the engagements and assignments they hold (Sections 4.5.7 and 8.7). Required features:

1. **Today**: the user's shifts, tasks, day sheet and run of show for the current scope.
2. **Clock**:
   - Geofenced clock in and out, with break punches.
   - Kiosk mode for shared devices with worker PINs.
   - Protection against double clock-in across devices.
   - Forgotten clock-outs close automatically at 16 hours, flagged for supervisor review.
3. **Shifts**: view, accept, request swap, withdraw a swap. No self-approval.
4. **Tasks and checklists**: complete with photo evidence. Checklist items are rows, never array positions.
5. **Incidents**: CAD-style quick report with severity, location pin, photos, parties and offline queueing. Dispatch view for supervisors.
6. **Inspections**: template-driven walks with pass and fail per item, photos and sign-off.
7. **Scan**: barcode (GTIN, Code 128, QR) and NFC for:
   - Asset custody
   - Receiving against POs
   - Credential validation at access points against the Access Grid
8. **Logistics**: dock slot check-in, marshalling yard log, delivery receipt.
9. **Show**: live run of show with cue progression and time-to-next-cue.
10. **Reference**: emergency codes, radio channel plan, venue maps and SOPs, all available offline.
11. **Expenses**: receipt capture with OCR prefill, posting to a budget line.
12. **Notifications**: push with deep links, quiet hours and per-category preferences.
13. **Profile**: certifications with expiry reminders, documents, emergency contact, uniform sizes.

Field ergonomics:

- One-handed reach zones and a 48 pt minimum touch target.
- Glove-friendly controls and high-contrast sunlight mode.
- Haptic confirmation.
- Low-bandwidth image compression and battery-aware location sampling.

### 4.4 Gateway 4.0

Gateway is the external face of every org on the platform. Atlas is for the people who run an organization; Gateway is for everyone the organization works with. Both read and write the same records through the same API and RLS. Gateway only ever sees what an org has chosen to share with a specific external party.

| Surface | Who signs in | Job |
| --- | --- | --- |
| Atlas | Internal org members (Owner, Admin, Manager, Member, Collaborator, Field, Viewer) | Run the organization |
| Gateway | External users of the eight external role types | Find opportunities, apply, onboard, deliver engagements, get paid |
| Compass | Both | On-site operations, scoped by role and engagement |

#### 4.4.1 External Identity and Accounts

- **One account per person.** A Gateway account is global across tenants and uses the same authentication as Atlas. One person can be an internal member of one org and an external party to many others. The app they open decides the context: Atlas for internal work, Gateway for external work, and Compass for either.
- **The person owns their profile.** Profile fields:
  - name and preferred name
  - headline, and location to city level
  - skills tagged by URID discipline and category
  - certifications with evidence and expiry
  - portfolio and media, and an electronic press kit (EPK) for artists
  - rates and an availability calendar
  - languages, references and links

  The person sets each field's visibility: Private, Shared on application, or Public in the marketplace.
- **External accounts for companies.** Vendors, staffing agencies, contractor firms, artist agencies and management companies, sponsors and client companies hold an external account. An external account is an organization in the canonical identity model (Section 4.8): the same table as a tenant org, without a subscription. A vendor can later subscribe and use Atlas itself without creating a second record.
  - Members have account roles: Account Owner, Account Admin, Account Finance (submits invoices, sees payments) and Account Member.
  - The company profile carries:
    - legal name and trade name
    - tax classification and addresses
    - service regions and capabilities tagged by URID
    - insurance certificates
    - optional self-declared supplier diversity certifications, used only where an org runs a supplier diversity program, with separate consent
- **Representation.**
  - An Artist Representative manages artists through a representation record that the artist accepts. It carries scopes (offers, advance, settlement, documents) and an expiry date.
  - A staffing agency assigns its own staff to the engagements it wins.
- **Consent to share.**
  - When applying, the person or company picks which profile fields go to that org.
  - The org receives a snapshot, plus live updates while the engagement is active.
  - Revoking after close stops future updates. The org keeps the engagement records it must retain by law.
- **Org-side data stays internal.** Internal notes, internal ratings, pay rate history, margins and the org's budget are never visible in Gateway. External users see only what the org publishes to them, such as their own approved timesheets, payments and shared documents.

#### 4.4.2 External Role Types

| Role type | Who | Typical opportunity | Selection instrument |
| --- | --- | --- | --- |
| Client | Brands, agencies and venue owners commissioning work | None in the marketplace; invited from a proposal | Signed proposal and client contract |
| Vendor | Companies supplying goods, rentals or services | RFQ, RFP or invitation to bid | Award, then purchase order or supply agreement |
| Contractor | Independent professionals or firms delivering a defined scope | Scoped work with deliverables or milestones | Offer, contractor agreement and statement of work |
| Crew | Freelance technicians engaged by the day or hour | Crew call by canon role code, dates, location and rate | Offer and crew agreement, then shift assignments |
| Staff | Event staff supplied individually or through a staffing agency | Staffing call sized with canon staffing ratios | Offer to an individual or award to an agency, then position assignments |
| Artist | Performers, DJs, speakers and hosts | Booking invitation or open call | Talent offer and talent agreement |
| Artist Representative | Agents and managers | Acts on the represented artist's opportunities | Delegated through representation |
| Sponsor | Brands buying sponsorship | Sponsorship package built from sponsor entitlements | Sponsorship contract |

#### 4.4.3 Opportunity Marketplace

**Opportunities**
- Every opportunity is published from an approved Atlas requisition: a staffing requisition, a purchase requisition or RFQ, a talent booking, a contractor scope or a sponsorship package. Spend authority (Section 8.1) applies before publishing.
- Fields:
  - title (Title Case), org, project and scope node
  - role type, and canon role code or URID
  - description, location and venue, dates and call times, number of positions
  - compensation: rate type (hourly, day, flat, milestone or bid), amount or range, currency
  - requirements: certifications through canon compliance tags, insurance minimums, equipment
  - application questions and a deadline
- An opportunity with no posted compensation shows Rate on Request, never zero.

**Visibility**

| Level | Who can see it |
| --- | --- |
| Invited | Named people or external accounts only |
| Pool | Members of the org's talent and vendor pools |
| Network | Anyone who has completed an engagement with the org |
| Public | Everyone in the Gateway marketplace (Pro plan and above) |

**Pay transparency.** A rule table by jurisdiction marks where a pay range is legally required in a posting. In those jurisdictions an opportunity cannot be published without one. Examples: Colorado, California, New York and Washington, and EU member states as they transpose the EU Pay Transparency Directive.

**Discovery**
- Search and filter by:
  - role type, discipline and category
  - distance from a location, dates and rate
  - required certifications
- Saved searches send alerts by email and push.
- Recommended opportunities match profile skills, certifications, location and availability. A public "How ranking works" page lists the ranking factors. No placement can be bought.

**Applying**
- **People:** apply in one step with a profile snapshot, answers to the questions and availability confirmation.
- **Vendors:** submit sealed line-item bids. Bids stay sealed until the deadline, and a bidder never sees another bidder.
- **Artists:** submit an EPK and media, and either accept the posted fee or propose one.
- **Agencies:** submit a slate of named staff.

**Pools**
- Orgs keep talent and vendor pools: Preferred, Approved, and an internal Do Not Engage flag.
- A Do Not Engage flag needs a reason and a review date. It is never visible externally.
- Pool members can receive early or exclusive access to opportunities.

**Ratings**
- Ratings come only from completed engagements, and both sides rate each other.
- Both ratings are released together, once both are in or after 14 days.
- The person rated can reply publicly.
- Internal org notes are never shown externally.

**Abuse**
- Anyone can report a listing or profile.
- Removals follow a notice-and-action workflow, with a statement of reasons sent to the affected party.

#### 4.4.4 Engagement Lifecycle

Every external relationship moves through the same nine stages. The canon Engagement and Engagement-Document lifecycles (Section 3.12) govern the states, and every transition is written to a ledger.

| Stage | What happens | Owner |
| --- | --- | --- |
| 1. Requisition | Demand raised and approved in Atlas | Org |
| 2. Opportunity | Published or sent as an invitation | Org |
| 3. Application | Application, bid, EPK or agency slate submitted | External party |
| 4. Selection | Screening, shortlist, interview or audition, bid leveling, decision | Org |
| 5. Offer | Terms issued; accepted, countered or declined | Both |
| 6. Onboarding | Every blocking requirement in the onboarding packet completed and verified | External party, then org verification |
| 7. Engaged | The work: shifts, deliveries, deliverables, advance, approvals, invoices | Both |
| 8. Close-out | Acceptance, final payment, ratings, credentials and access revoked | Both |
| 9. Re-engagement | Pool membership and rehire eligibility recorded | Org |

States, each a database state machine with its own transition ledger:

| Machine | States |
| --- | --- |
| `opportunity_state` | Draft, Pending Approval, Published, Paused, Filled, Closed, Canceled |
| `application_state` | Submitted, In Review, Shortlisted, Offered, Accepted, Declined, Withdrawn, Not Selected |
| `engagement_state` | Onboarding, Blocked, Active, Closing, Complete, Canceled |

**By role type**

| Role type | Onboarding packet | Engaged | Close-out |
| --- | --- | --- | --- |
| Client | MSA or SOW, billing contacts, tax exemption certificate where it applies, approval delegates | Approvals, reviews, change orders, shared schedule and run of show, reports, invoices and payments | Final cost report, satisfaction survey, case study consent |
| Vendor | W-9 or W-8BEN-E, insurance certificate naming the required additional insureds, prequalification, payout details on the org's payment rails, safety documents | PO acknowledgment, submittals, dock slots and deliveries, advance, invoices with three-way match | Final invoice, lien waiver, returns, scorecard |
| Contractor | W-9 or W-8BEN, NDA, insurance where required, certifications, worker classification questionnaire | Deliverables or milestones, time entries where hourly, invoices | Acceptance, final payment, 1099-NEC data, ratings |
| Crew | Crew agreement or payroll-provider onboarding, certifications, background check where required, emergency contact, uniform sizes, safety briefing | Shifts, Compass clock, timesheets, per diem, travel and lodging | Timesheet approval, payment or payroll export, ratings, credential revocation |
| Staff | Role certifications (for example TIPS, ServSafe), uniform, training and briefing acknowledgments | Position assignments, shifts, briefings, Compass clock | Timesheets or agency invoice, ratings |
| Artist | Rider, advance packet, W-9 or W-8BEN with a foreign performer withholding flag, travel and hospitality details, appearance and content consent | Advance, set times, day sheet, hospitality, guest list, Compass day-of-show view | Settlement, payment, content rights confirmation, ratings |
| Artist Representative | Representation accepted by the artist | Everything in the artist's engagement within the delegated scopes | Settlement review |
| Sponsor | Brand assets, approval contacts, insurance where the activation is physical | Entitlement fulfillment, asset approvals, activation schedule | Proof-of-performance report at gate 8, renewal offer |

**Onboarding packets**
- An org defines requirements per role type, per jurisdiction and per org. Item types:
  - document upload, electronic signature and form
  - certification, training and acknowledgment
  - background check and tax form
  - payout details
- Each item has a verification method (automatic or reviewer), an expiry, and reminders before expiry.
- An engagement cannot become Active until every blocking item passes. The database enforces this.
- Verified, unexpired items carry over to later engagements with the same org. Across orgs, only person-owned items such as certifications carry over, and only with the person's consent.
- **Tax identifiers and bank details:**
  - Entered through secure forms and stored encrypted as Restricted (Section 8.3), or handed to the payment provider.
  - After entry, only the last four digits are ever displayed.
- **Background checks** run through a provider integration (Checkr). It handles FCRA disclosure, authorization and the adverse action process. XOS stores only the provider's result and reference, never the report.

#### 4.4.5 Payments to External Parties

- **Gateway shows** invoices, timesheets, settlements and payments.
- **Invoices:**
  - External parties submit invoices against their PO or engagement.
  - Where the org enables it and the party agrees, invoices are generated from approved timesheets (self-billing).
- **Money moves** through the org's own rails: the Universal Posting Line to its accounting system for accounts payable, or optional Stripe Connect payouts on the Pro plan and above. XOS never holds funds.
- **Year-end:** 1099-NEC data export for US payees, and withholding flags for foreign payees.

#### 4.4.6 Token Flows Without an Account

Advance forms and signing links still work with a token and access code for people who have no account. After finishing, the person is offered a Gateway account. Claiming it links their records by verified email.

#### 4.4.7 Gateway White Label

- On an org's custom Gateway domain (for example `gateway.northwindlive.com`), Gateway shows only that org, in its brand.
- On the platform domain, a person sees all their orgs and the public marketplace.
- Partner orgs (Section 4.6.1) can brand Gateway for their client orgs.

### 4.5 Information Architecture

The information architecture below is binding. A06 owns the navigation shell. Module agents implement the pages this section names, at the routes it names.

**Single source.** Atlas navigation is generated from `apps/atlas/ia/sitemap.yaml`, which A06 writes from this section. Gateway navigation is generated the same way from `apps/gateway/ia/sitemap.yaml`, which A27 writes from Section 4.5.8. The same file drives:
- the sidebar and breadcrumbs
- the command menu index
- route guards
- the role visibility tests

No navigation item is hard-coded in a component.

#### 4.5.1 Hierarchy

| Level | Meaning | Appears as |
| --- | --- | --- |
| Org | The tenant: one billing account, one brand, one legal entity set | Org switcher at the top of the sidebar; first URL segment |
| Workspace | A division of the org (for example a city office or a venue group) that scopes projects and members | Workspace switcher under the org; sidebar filter |
| Project | One engagement, with jurisdiction, phase and gates | Project header and tabs; `p/{projectKey}` in the URL |
| Scope node | A node in the scope tree: engagement root, standing venue, show | Scope picker in the project header; filter on every project tab |
| Record | One of the 26 record kinds, or a domain entity (PO, asset, shift, incident) | Side peek panel or full page; record key in the URL |

**Keys**
- Projects carry a 2 to 5 letter project key, unique per org (for example NWL).
- Records carry a display key of `{projectKey}-{sequence}` (for example NWL-142), issued by `next_sequence`.
- Catalog items keep their `{URID}-{ORG}-{SEQ}` item ID.

**Breadcrumbs** follow Org, Workspace, Project, Scope node, Module, Record. Levels that do not apply are omitted.

#### 4.5.2 Atlas Sidebar

Groups and items appear in this order. Items marked "both" open at org level (across projects, with a project filter) and inside a project as a tab, using the same page component.

| Group | Item | Level |
| --- | --- | --- |
| Workspace | Home | Org |
| Workspace | Inbox (notifications, approvals waiting on me, mentions) | Org |
| Workspace | My Work (records I own or am accountable for) | Org |
| Production | Projects | Org |
| Production | Schedule | Both |
| Production | Work | Both |
| Production | Show | Both |
| Production | Advancing | Both |
| Operations | Places | Org |
| Operations | Logistics | Both |
| Operations | Hospitality | Both |
| Operations | Assets | Both |
| Operations | Credentials | Both |
| Operations | Safety | Both |
| People | People | Org |
| People | Opportunities | Both |
| People | Crew | Both |
| Commercial | Finance | Both |
| Commercial | Procurement | Both |
| Commercial | Vendors | Org |
| Knowledge | Knowledge | Org |
| Knowledge | Reports | Both |
| Knowledge | Canon | Org |
| Footer | Activity | Org |
| Footer | Settings | Org |

**Favorites** sit above the groups: pinned projects, saved views and records, per user, reorderable by drag and keyboard.

**Default state and personalization.** The table is the full sidebar; nobody sees all of it at once by default.
- **Always visible at the top:** Search (opens the command menu), Home, Inbox and My Work.
- **Then, in order:** Favorites, and Projects (the five most recent plus All projects).
- **Module groups below are collapsed by default,** except the groups the person's role uses most:
  - Producer: Production
  - Finance Lead: Commercial
  - Production Coordinator: Operations
  - Department Head: Production and Operations
  - Field Supervisor: Operations and People
- **Org Admins can turn whole modules off** in Settings. A module that is off disappears from navigation, search and the command menu for everyone.
- **Each person can hide, reorder or pin items.** "Reset to role default" restores the starting layout.
- **Focus mode** (Cmd or Ctrl+.) hides the sidebar and page chrome, leaving only the current page.
- **Below the `md` breakpoint,** Atlas shows a bottom bar with Home, Inbox, Search, My Work and Menu. Menu opens the full sidebar as a sheet.

#### 4.5.3 Routes

All Atlas routes live on the tenant's domain. The org slug is the first segment.

| Pattern | Page |
| --- | --- |
| `/{org}/home` | Home |
| `/{org}/inbox` | Inbox |
| `/{org}/my-work` | My Work |
| `/{org}/projects` | Projects list |
| `/{org}/p/{projectKey}/{tab}` | Project tab (tabs in 4.5.4) |
| `/{org}/{module}/{page}` | Org-level module page (pages in 4.5.5) |
| `/{org}/r/{recordKey}` | Record full page; the side peek uses `?peek={recordKey}` on any route |
| `/{org}/views/{viewId}` | Saved view |
| `/{org}/settings/{section}` | Org settings |
| `/{org}/me/{section}` | Personal settings |
| `/advance/{token}` | Advance form without an account (served by Gateway) |
| `/sign/{token}` | Agreement signing without an account (served by Gateway) |
| `/legal/{document}` | Published legal documents |
| `/partner/{partnerSlug}/{page}` | Partner console for reseller orgs (Section 4.6.1) |
| `/{org}/objects/{objectKey}` | Custom object list (Section 4.6.3) |
| `/{org}/import` | Spreadsheet import wizard (Section 4.6.2) |
| `/{org}/reports/builder` | Report and dashboard builder (Section 4.6.4) |
| `/ical/{feedToken}.ics` | Calendar subscription feed (Section 4.6.5) |
| `/api/v1/...` | Public API |

**Route conventions**
- Slugs are lowercase and hyphenated.
- Every list route accepts the view state in its query string:
  - `view=list|board|timeline|calendar|table`
  - `group`, `sort`, `filter`
  - `scope` (scope node)
- Every route has a test that it renders for a role that may see it and returns 404, not 403, for a role that may not.

#### 4.5.4 Project Tabs

Tabs appear in this order, grouped by act. The default landing tab is Overview.

| Tab | Content |
| --- | --- |
| Overview | Phase, gate readiness, key dates, budget summary, open blockers, recent activity |
| Scope | Scope tree, requirements and capability reconciliation, element selection, coordinate matrix for the project |
| Gates | Nine gates with criteria, evidence, blocking flags, transition history |
| Schedule | Timeline, calendar, baselines, milestones |
| Work | Records by kind, work orders, punch lists |
| Show | Run of show, cues, day sheets, call sheets |
| Advancing | Packets, recipients, submissions, riders, reconciliation |
| Logistics | Shipments, dock slots, marshalling yard log |
| Hospitality | Lodging, catering, travel, amenities, BEOs |
| Assets | Assets assigned to the project, custody, damage |
| Crew | Requisitions, roster, shifts, timesheets |
| Engagements | External engagements on the project by role type, onboarding progress, client and sponsor access |
| Credentials | Credential categories, issued credentials, Access Grid, scan log |
| Safety | Permits from the permit engine, inspections, incidents, emergency codes, radio plan |
| Budget | Budget grid, expenses, change orders, contingency, cost forecast |
| Procurement | RFQs, purchase orders, receipts, invoice matching |
| Documents | Files, contracts, transmittals, submittals, RFIs |
| Reports | Project reports including the final cost report |
| Activity | Project activity feed |
| Settings | Project key, jurisdiction, region, tier, members, Gateway access for clients and sponsors, integrations |

#### 4.5.5 Module Pages

Pages appear in this order within each module.

| Module | Pages |
| --- | --- |
| Home | Today, Gate readiness across projects, Alerts, Recent |
| Projects | All projects, By phase (board by gate), Portfolio timeline, Templates |
| Schedule | Timeline, Calendar, Milestones, Baselines |
| Work | All records, By kind, Work orders, Punch lists, Recurring |
| Show | Run of show, Day sheets, Call sheets |
| Advancing | Packets, Submissions, Riders, Reconciliation |
| Places | Venues, Spaces and zones, Capability documents, Site plans |
| Logistics | Shipments, Dock schedule, Marshalling yard log |
| Hospitality | Fulfillments, BEOs, Accommodation blocks |
| Assets | Catalog of asset classes, Units, Lots, Custody ledger, Maintenance, Damage |
| Credentials | Categories, Issued, Access Grid, Scan log |
| Safety | Permits, Inspections, Inspection templates, Incidents, Dispatch board, Emergency codes, Radio channels |
| People | Directory (parties), Roles, Requisitions, Offers, Agreements, Certifications |
| Opportunities | Requisitions, Postings, Pipeline (board by application state), Pools, Onboarding, Engagements, Ratings, Marketplace settings |
| Crew | Schedule, Shifts, Swaps, Time entries, Timesheets, Rate cards, Pay periods, Payroll exports, Time off |
| Finance | Budgets, Expenses, Change orders, Invoices, Payments, Journal, Periods, Universal Posting Line export, Chart of accounts (read-only), Cost centers |
| Procurement | RFQs, Purchase orders, Receipts, Invoice matching, Catalog |
| Vendors | Directory, Classes, Prequalification, Insurance certificates, Scorecards, Sponsor entitlements |
| Knowledge | SOPs, Documents, Verbiage library |
| Reports | Gate readiness, Coordinate matrix, Budget versus actual, Labor, Purchase order exposure, Incidents, Final cost report, Saved reports |
| Canon | Departments, Disciplines, Categories, Elements, Phases and gates, Record kinds, Roles, Jurisdictions and permit rules, Metrics, Org extensions |
| Activity | Org activity feed, Audit log (Owner and Admin only) |

#### 4.5.6 Settings Tree

Every setting is defined once in `packages/schemas/settings.yaml`. The definition gives its scope, type, default, the capability that edits it, and whether a lower scope may override it. Pages, API and audit labels are generated from that file.

**Scopes and precedence.** A setting resolves from the most specific scope that sets it:

1. Personal
2. Project
3. Team
4. Workspace
5. Organization
6. Platform default

An org can lock a setting so lower scopes cannot override it. Every settings page shows where the current value comes from.

**Organization settings** (Atlas, `/{org}/settings/...`), in this order:
1. Organization Profile: public profile page, sections, visibility, handle, verification (Section 4.8.3)
2. General: name, legal name, logo, default workspace, default landing page
3. Legal Entities and Fiscal: legal entities, tax identifiers, fiscal year start, base currency, invoice numbering
4. Members
5. Roles and Capabilities
6. Teams
7. Workspaces
8. Departments and Disciplines in Use: which canon departments and disciplines the org works in, and extensions
9. Locations and Venues defaults
10. Security: MFA policy, sessions, IP allow-list, SSO, SCIM, verified domains and automatic join, break-glass
11. Access Reviews
12. White Label: brand, domains, email, mobile app
13. Modules: turn modules on or off (Section 4.5.2)
14. Canon Extensions
15. Templates
16. Custom Fields
17. Custom Objects
18. Views and Defaults: default view per collection, shared saved views
19. Numbering: record key and document number formats per sequence
20. Automations
21. Approval Policies
22. Spend Authority
23. Separation of Duties
24. Time and Attendance: clock rules, geofences, kiosk, photo on punch, rounding, break rules per jurisdiction, overtime rules
25. Scheduling: shift templates, open-shift claiming rules, swap rules, availability windows
26. Payroll and Time Off: pay periods, earning codes, time-off policies, holiday calendars
27. Gateway and Marketplace: marketplace visibility, opportunity defaults, application question templates, onboarding packets, pools, rating settings
28. Communication: feed and announcement rules, groups, required acknowledgments, message retention, translation
29. Notifications Defaults: org-wide defaults and mandatory categories
30. AI Features
31. Help and Support: internal support contacts, custom help links, support hours
32. Integrations
33. API Keys and Service Accounts
34. Webhooks
35. Localization: default language, formats, units, time zone
36. Billing and Plan
37. Partner (partner orgs only): client orgs, wholesale billing, default brand
38. Usage
39. Data and Privacy: classification, exports, data requests, retention, legal holds
40. Audit Log
41. Legal: accepted terms and versions
42. Danger Zone: transfer ownership, archive, delete

**Workspace, team and project settings** are short pages holding only the settings their scope can override: members, defaults, notifications, views, and, for projects, the project-specific settings in Section 4.5.4.

**Personal settings** (Atlas `/{org}/me/...`, Gateway `/settings/...` and Compass Settings; one set of settings, shown in all three):
1. Profile: photo, name, preferred name, pronouns (optional), headline, bio, location, links, skills, certifications, portfolio, rates, availability (Section 4.8.3)
2. Profile Privacy: profile visibility (Public, Network, Private), per-field visibility, marketplace discoverability, search engine indexing, sharing consents per org, blocked people and organizations
3. Account: email, phone, linked sign-ins, data export, delete account
4. Security: passkeys, MFA, sessions and devices
5. Organizations: every membership and engagement, default org, leave an org
6. Preferences: theme, density, language, formats, units, time zone, start page
7. Accessibility: text size, high contrast, reduced motion, haptics, sounds, captions
8. Notifications: a matrix of categories by channel (in-app, push, email, SMS), quiet hours, digest frequency
9. Out of Office: dates, delegate for approvals, auto-reply in messages
10. Work Details: emergency contacts, uniform sizes, dietary and accessibility needs for hospitality (sensitive; shared per engagement only with consent), travel profile (loyalty programs, seating; passport details stored as Restricted)
11. Payout and Tax: payout details and tax forms (Gateway; Restricted)
12. Calendar Feeds
13. Connected Apps
14. Keyboard Shortcuts (desktop)
15. Developer: personal API tokens, where the org allows them

**External company account settings** (Gateway, `/settings/company/...`), in this order:
1. Company Profile and Privacy
2. Team and Account Roles
3. Service Regions and Capabilities
4. Insurance and Compliance Documents
5. Payout and Tax
6. Representation (artist agencies and management)
7. Notifications Defaults
8. Danger Zone

#### 4.5.7 Compass Navigation

**Bottom tab bar**, five tabs in this order:

| Tab | Content |
| --- | --- |
| Today | Current shift, clock state, tasks due, day sheet, next cue, alerts |
| Schedule | My shifts by day, open shifts, swap requests |
| Scan | Camera and NFC scanner with mode picker: Asset, Receiving, Credential, Lookup |
| Inbox | Notifications, approvals waiting on me (supervisors), messages |
| More | Everything below |

**More menu**, in this order:
1. Incidents
2. Inspections
3. Logistics
4. Show
5. Expenses
6. Reference: Emergency codes, Radio channels, Venue maps, SOPs
7. Offline queue
8. Profile and certifications
9. Settings

**Role-aware content.** The tabs stay the same for everyone; their content follows the person's role:

| User | Today and Schedule show | Scan modes | More menu adds |
| --- | --- | --- | --- |
| Internal Field and Field Supervisor | Shifts, tasks, day sheet, run of show | Asset, Receiving, Credential, Lookup | Everything in the list above |
| External Crew and Staff | Engaged shifts and positions, briefings, call times | Credential (own badge), Asset (custody of assigned gear) | Timesheets, per diem, travel and lodging, onboarding items |
| External Vendor | Dock slot, load-in and load-out windows, delivery instructions | Receiving acknowledgment, Credential (own badges) | Purchase orders, deliveries, submittals |
| External Contractor | Tasks and deliverables due, site access times | Credential (own badge) | Time entries, deliverables |
| External Artist and Artist Representative | Day sheet, set time, call times, hospitality, guest list | Credential (own and party badges) | Advance summary, rider, settlement |
| External Client | Show-day schedule, approvals waiting | None | Run of show (read), reports |
| External Sponsor | Activation schedule, entitlement checklist | None | Proof-of-performance capture with photos |

**Org switching.** A person engaged by several orgs sees a combined Today across all of them, and an org switcher in the header. Each item keeps its org's brand chip.

**Supervisor mode.** Field Supervisors and above get a sixth tab, Crew. It holds the crew board, timesheet approvals, the dispatch board and shift coverage. The tab shows only when the signed-in role allows it.

**Project and scope context.** The current project and scope node show in a header picker on every tab. Compass remembers the last context per device.

**Deep links.** `compass://r/{recordKey}` and universal links on the tenant domain open the matching screen. Push notifications always carry a deep link.

#### 4.5.8 Gateway Navigation

**Primary navigation**, five destinations in this order. On desktop they sit in the top bar. Below the `md` breakpoint they become a bottom tab bar.

| Destination | Content |
| --- | --- |
| Home | An Up Next card for the person's next shift, set time, delivery or deadline, with countdown, address, call time and directions. Below it, a feed of things that need the person (offers to answer, onboarding items, documents to sign, invoices to submit), each with its action inline. Then a strip of recommended opportunities |
| Explore | The opportunity marketplace: For You feed, filter chips, list and map views, Saved, Alerts |
| Work | Three tabs: Upcoming (list and calendar across orgs, with a calendar feed), Engagements (active and past, grouped by org and project), Applications (submitted applications and bids, offers, history) |
| Money | Overview (earned, pending, next payment), Invoices, Timesheets, Payments, Tax documents |
| Messages | Conversations per engagement and per org |

**Avatar menu:**
- Profile: personal or company profile, portfolio or EPK, rates, availability, certifications, team (company accounts), representation
- Documents: a vault of contracts, onboarding documents and compliance documents with expiry, across orgs
- Settings: account, security, notifications, payout details, privacy and sharing consents, connected orgs
- Switch org (on the platform domain), Help, Sign out

Documents to sign and items due also appear in Home, so nobody has to go looking for them.

**Engagement tabs** by role type. Every engagement opens to Overview, and every engagement carries Messages and Documents.

| Role type | Engagement tabs, in order |
| --- | --- |
| Client | Overview, Approvals, Schedule, Run of Show, Change Orders, Reports, Invoices, Documents, Messages |
| Vendor | Overview, Bid, Purchase Orders, Deliveries, Submittals, Advance, Invoices, Compliance, Documents, Messages |
| Contractor | Overview, Scope, Deliverables, Time, Invoices, Documents, Messages |
| Crew | Overview, Offer, Onboarding, Shifts, Timesheets, Travel and Lodging, Per Diem, Credentials, Documents, Messages |
| Staff | Overview, Offer, Onboarding, Training, Positions, Shifts, Timesheets, Credentials, Documents, Messages |
| Artist | Overview, Offer, Advance, Rider, Set Times, Hospitality, Guest List, Settlement, Documents, Messages |
| Artist Representative | Roster of represented artists; each artist's engagement tabs within the delegated scopes |
| Sponsor | Overview, Entitlements, Asset Approvals, Activation Schedule, Proof of Performance, Invoices, Documents, Messages |

**Routes**

| Pattern | Page |
| --- | --- |
| `/home` | Home |
| `/explore` and `/explore/{opportunityKey}` | Marketplace and opportunity detail |
| `/work/upcoming`, `/work/engagements`, `/work/applications` | Work tabs |
| `/work/engagements/{engagementKey}/{tab}` | Engagement tabs |
| `/money/{page}` | Money pages |
| `/messages` and `/messages/{threadKey}` | Messages |
| `/profile`, `/documents`, `/settings/{section}` | Avatar menu pages |
| `/u/{handle}`, `/c/{companyHandle}` | Public person and company profiles |
| `/advance/{token}`, `/sign/{token}` | Token flows without an account |

On an org's custom Gateway domain the same routes apply, scoped to that org.

**Visibility.** Only the engagement tabs of the person's own role type render, and only for engagements they hold or represent. An external account's members see the account's engagements according to their account role. Account Finance sees Money. Account Member sees only the engagements assigned to them.

#### 4.5.9 Role Visibility

The table shows who can see each navigation group in Atlas. The capability checks in Section 8 still decide every action inside a page, and RLS still decides every row. External users have no Atlas access: every Atlas route returns 404 for them. Gateway visibility follows Section 4.5.8.

| Group or page | Owner | Admin | Manager | Member | Collaborator | Field | Viewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Workspace (Home, Inbox, My Work) | Full | Full | Full | Full | Full | Full | Read |
| Production | Full | Full | Full | Full | Assigned | Assigned | Read |
| Operations | Full | Full | Full | Full | Assigned | Assigned | Read |
| People | Full | Full | Full | Read | Hidden | Own profile | Hidden |
| Opportunities | Full | Full | Full | Read | Hidden | Hidden | Read |
| Crew | Full | Full | Full | Read | Hidden | Own records | Hidden |
| Commercial | Full | Full | Full | Read | Hidden | Hidden | Hidden |
| Knowledge | Full | Full | Full | Full | Read | Read | Read |
| Reports | Full | Full | Full | Read | Hidden | Hidden | Read |
| Canon | Read and extend | Read and extend | Read | Read | Read | Hidden | Read |
| Activity feed | Full | Full | Full | Full | Assigned | Hidden | Read |
| Audit log | Full | Full | Hidden | Hidden | Hidden | Hidden | Hidden |
| Org settings | Full | Full except Billing and Legal | Hidden | Hidden | Hidden | Hidden | Hidden |
| Personal settings | Full | Full | Full | Full | Full | Full | Full |

Key:
- **Full**: all pages in the group.
- **Read**: pages show, with no create or edit controls.
- **Assigned**: pages show, limited to projects and records the person is a member of or assigned to.
- **Own profile** and **Own records**: only the person's own data.
- **Hidden**: the item does not render, and its route returns 404.

A test for each cell signs in as that role and checks the sidebar, the command menu and direct route access.

### 4.6 Platform Capabilities

#### 4.6.1 Reseller Hierarchy

White-label resale is a first-class model, not a configuration trick.

- **Three levels, never more:** Platform, Partner org, Client org. `orgs.parent_org_id` points a client org to its partner. A partner cannot have a parent partner.
- **Partner console** (`/partner/{partnerSlug}`):
  - Create client orgs and set their plan.
  - Set a default brand that client orgs inherit, which each client may override if the partner allows.
  - See usage rollups and run wholesale billing.
- **Billing:** the platform bills the partner at wholesale. The partner bills its clients through Stripe Connect (Standard accounts) at prices the partner sets.
- **Data access:**
  - Partner staff have no access to client org data by default.
  - Access requires either a support session granted by the client Owner (Section 8), or a standing grant written into the partner and client agreement, recorded as a `record_grants` row with scope and expiry.
  - Every partner action inside a client org is written to that client's audit ledger.
- **Exit:** a client org can leave its partner and become a direct customer. Its data, members and brand stay intact.

#### 4.6.2 Spreadsheet Import Wizard

Tenants bring their own spreadsheets, including older playbooks, and map them onto XOS.

1. **Upload:** .xlsx, .xls, .csv or a Google Sheets link through the Google Drive integration.
2. **Detect:** find sheets, header rows and data ranges, and propose a target entity per sheet.
3. **Map:** suggest a column-to-field map. Suggestions use the Playbook column map, header similarity and, when the org has AI features on, the assistant. The user confirms every mapping.
4. **Validate:** every row is checked against the target schema. Results use the import row states (Valid, Invalid, Written, Refused, Skipped) with the reason shown per cell.
5. **Deduplicate:** match on strong keys first (email, GTIN, item ID, record key), then on fuzzy similarity of name plus address (pg_trgm, threshold 0.85). Fuzzy matches go to a merge review; they never merge automatically.
6. **Dry run:** show counts of creates, updates, merges and refusals.
7. **Commit:** write in one import batch with an `import_batch_id` on every row.
8. **Undo:** the whole batch can be rolled back within 7 days, unless a later edit depends on a row. Those rows are listed instead of deleted.

Saved mapping profiles make repeat imports one click.

#### 4.6.3 Custom Objects

Orgs define their own entity types beyond custom fields.

- **Definition:** name, key, icon, Title Case label, fields (typed, with validation), relations to records, projects, parties or other custom objects, and a default view.
- **Behavior:** every custom object gets list, board, table and calendar views, the record side peek, comments, attachments, activity, permissions through capabilities, webhooks and API routes at `/api/v1/objects/{objectKey}`.
- **Storage:** normalized, with no JSON documents. Field definitions live in `custom_object_fields`. Values live in `custom_object_values`, one row per record and field, with one typed value column per data type and a foreign key to the field. Relations live in `custom_object_relations`. Fields marked filterable get partial indexes.
- **Limits:** set per plan in `private.org_plan_limits`.

#### 4.6.4 Reports, Dashboards and Data Delivery

- **Report builder:** pick a source (records, finance, crew, procurement, assets, incidents or a custom object), then fields, filters, grouping, NULL-aware aggregates and a chart type. Reports respect RLS and field-level masking.
- **Dashboards:** a grid of report tiles with shared filters, saved per user or per team.
- **Scheduled delivery:** email a report as PDF, CSV or .xlsx on a schedule, to org members only.
- **Exports everywhere:** every list and report exports to CSV, .xlsx and PDF, subject to the data loss rules in Section 8.6.
- **Warehouse delivery (Enterprise):** nightly Parquet files to the customer's own S3, Google Cloud Storage or Azure Blob bucket, with a published schema. No customer receives direct database credentials.

#### 4.6.5 Calendar Feeds and Email In

- **Calendar feeds:** each user and each project can subscribe to an iCalendar feed of shifts, meetings, milestones and deadlines. Feed URLs carry a secret token, can be revoked, and contain only what the token owner may see.
- **Reply by email:** a notification email's reply address is signed per user and thread. A reply posts as a comment after DKIM verification, with quoted text stripped.
- **Project inbox:** each project has an inbound address. Forwarded mail lands as a Document record with its attachments, for a coordinator to file.

### 4.7 AI Features

AI features use Anthropic's Claude models through the Anthropic API. The model is set in configuration, never hard-coded. Every feature is off until an org Admin turns it on in Settings, AI Features.

| Feature | Behavior |
| --- | --- |
| Assistant (Cmd or Ctrl+J; Compass More menu) | Answers questions about the org's data with links to the records it used. It acts through the public API with the user's own token, so it can never see or do more than the user. |
| Ask in plain language | Turns a sentence into a saved view or filter ("blocked permits for Miami shows this month") and shows the filter it built. |
| Document extraction | Reads riders, insurance certificates, invoices, receipts and quotes into structured fields, with a confidence score per field and provenance `agent`. A person confirms before anything is written. |
| Drafting | Drafts SOPs, advance packets, emails, day sheets and change order descriptions in the org's verbiage library. |
| Summaries | Summarizes a record's activity, a project's week and gate readiness. |
| Mapping help | Suggests column mappings in the import wizard and catalog bindings for unknown scanned codes. |

**Guardrails**
- The assistant never writes, sends or approves without an explicit confirmation step that shows exactly what will change.
- The silence rule applies: when the data does not support an answer, the assistant returns NO ANSWER with what is missing. It never guesses a price, date or quantity.
- Medical records and fields classified Restricted are never sent to a model.
- Customer data is never used for model training. Prompts and outputs are logged with personal data redacted, under the audit retention rules.
- AI-generated content carries a visible label, meeting EU AI Act transparency duties.
- Usage is metered per org and limited per plan.
- An evaluation suite holds a fixed test set per feature. CI fails if a feature drops below its accuracy threshold, which is set in `packages/ai/evals/thresholds.json` from the first passing baseline.

### 4.8 Identity, Membership and Profiles

#### 4.8.1 Canonical Identity Model

| Entity | Holds | Key facts |
| --- | --- | --- |
| Person | One human, linked to one sign-in | Personal profile facts, owned by the person |
| Organization | Every company on the platform: tenant, external account, or both | Organization profile facts, owned by the organization |
| Subscription | Present only when an organization uses Atlas | Plan, billing, tenant settings |
| Membership | Person in an organization as an internal member | Membership dates, roles (many) |
| Engagement | Person or organization working for an organization externally (Section 4.4.4) | Role type, state, project, onboarding |
| Project Assignment | Person on a project | Project roles (many), scope nodes, dates |
| Account Membership | Person in an external organization's account | Account roles (many) |
| Organization Relationship | One organization's relationship to another | Kind (vendor of, client of, partner of, represents), with the org-owned facts |
| Representation | One party acting for another | Scopes, expiry, acceptance |

**Rules**
- **No limits on combinations.** A person can hold any number of memberships, engagements, project assignments and account memberships, across any number of organizations, internal and external, at the same time.
- **Several roles in one place.**
  - A person can hold several internal roles in one org and several project roles on one project.
  - Capabilities are the union of every role the person holds in that scope.
  - Separation of duties (Section 8.2) is checked against the person, never the role, so holding two roles never lets anyone approve their own work.
- **Internal and external in the same org.** A person can be an internal member of an org and also hold an external engagement with it, for example an employee also booked as an artist.
  - Atlas shows the internal context. Gateway shows the engagement.
  - Each item records which capacity the person acted in.
- **Context switcher in every shell.** Organization, then project, then role lens:
  - "All roles" shows the union of everything the person holds.
  - A single role narrows the view to what that role sees. This is useful for checking work as a Finance Lead or as Crew.
  - Compass and Gateway also offer a combined view across orgs.
- **Ways to join:**
  - invitation links with role and expiry
  - requests to join, approved by an Admin
  - automatic join for verified email domains, with a default role
  - SSO just-in-time provisioning
  - SCIM provisioning
  - acceptance of an opportunity or an engagement
- **Leaving and offboarding.**
  - Leaving an org ends access at once.
  - The org reassigns the person's open records in an offboarding checklist.
  - The person keeps their personal profile and their own documents.

#### 4.8.2 Profile Pages

- **Every person and every organization has one profile page,** shown in Gateway. Atlas links to it from people and organization records. Compass shows a compact version.
- **Person profile:**
  - photo, name, preferred name, pronouns (optional), headline, bio, location to city level
  - skills by URID, certifications with verification badges, portfolio or EPK
  - rates (optional), availability, languages, links
  - ratings from completed engagements
  - organizations worked with (each one shown only if both sides allow it)
- **Organization profile:**
  - logo, cover, name, about, locations and service regions, capabilities by URID
  - verified status, open opportunities, case studies (with client consent), ratings
  - team members who opt in to appear, and contact options

#### 4.8.3 Profile Visibility

| Level | Who sees the profile |
| --- | --- |
| Public | Everyone in the Gateway marketplace, and search engines only if indexing is also turned on |
| Network | People and organizations who share an engagement or membership with the profile owner |
| Private | Only the owner, and organizations the owner has shared it with through an application or engagement |

- **Two levels of control:** the whole profile has a visibility level, and each section and field can be set lower, never higher.
- **Defaults:** new profiles start Private. New organizations start Network.
- **Search engines:** public profiles carry noindex unless the owner turns on indexing.
- **Handles:** each profile gets a unique handle (`/u/{handle}`, `/c/{handle}`), changeable once every 30 days, with redirects from the old handle for 90 days.
- **Organization profiles** are edited by members with the `org.profile.write` capability.
- **Verification badges** appear only after the platform or a provider checks the claim:
  - verified business identity, through Stripe Identity or a business registry check
  - verified certification, checked against its issuer or its evidence
  - verified domain

### 4.9 Compass Workforce Suite

Compass matches the best frontline workforce apps feature for feature, then adds what production work needs. The reference set:

- **Connecteam:** time clock, scheduling, digital forms, training, chat, updates and recognition.
- **Pebb:** shift scheduling and open shifts, clock-in with location checks and breaks, work chat with read receipts and voice notes, a news feed with pinned posts and acknowledgment tracking, offline digital forms with e-signatures, shift-based tasks, a knowledge base with mandatory reads, polls, recognition, a directory and group spaces.
- **All Gravy:** a team feed for multi-site hospitality teams, role-based onboarding sequences, training with completion records, a searchable digital handbook, and an AI assistant that answers only from the operator's own content.

| Capability | Compass behavior | Managed in |
| --- | --- | --- |
| Time clock | Already specified in Sections 4.3 and 11.13 | Atlas Crew |
| Scheduling | Open shifts that people claim (first come, or approval), shift templates, availability, swaps, auto-fill suggestions that respect availability, certifications, overtime and rest rules | Atlas Crew |
| Time off | Request, balance view, approval, calendar of who is off | Atlas Crew |
| Feed | Announcements and updates by org, project, department, team or role. Pinned posts. Required acknowledgments tracked per person. Reactions and comments, which an org can turn off per post. Scheduled posts. | Atlas Knowledge, Feed |
| Groups | Spaces by department, project, crew or custom audience, with chat and files | Atlas Settings, Communication |
| Chat | One-to-one and group chat, read receipts (optional per org), photo, file and voice notes, message translation, offline queueing | All shells |
| Directory | Searchable people directory scoped to what the person may see, showing who is on site now (from the geofence), with one-tap call or message | Atlas People |
| Events | Briefings, crew calls and meetings with RSVP, location, agenda and check-in | Atlas Schedule |
| Forms | A no-code form builder with conditional logic, required photos, GPS stamp, signatures, scoring and approval routing. Every submission becomes a record with its own kind and subtype. | Atlas Knowledge, Forms |
| Checklists and tasks | Shift-based and location-based checklists with timestamps and photo proof | Atlas Work |
| Onboarding | Role-based onboarding sequences that start automatically when a person joins or is engaged (Section 4.4.4) | Atlas People and Opportunities |
| Training | Short courses with lessons, video, quizzes, completion certificates and expiry, linked to role certifications and gate criteria | Atlas Knowledge, Training |
| Handbook and SOPs | Searchable library with versions, mandatory reads, acknowledgment tracking and offline access | Atlas Knowledge |
| Assistant | Answers policy, procedure and role questions from the org's own SOPs, handbook and records only, with links to sources (Section 4.7) | Atlas Settings, AI Features |
| Polls and surveys | Quick polls in the feed, pulse surveys with anonymous option and minimum response thresholds | Atlas Knowledge, Feed |
| Recognition | Shout-outs tied to a project or shift, visible in the feed, counted on profiles with the person's consent. No points currency. | Atlas People |
| Help desk | Requests to internal teams (operations, IT, HR, facilities) with categories, assignment and response times | Atlas Settings, Help and Support |
| Documents | Personal documents with expiry reminders: certifications, IDs as Restricted, signed agreements | Gateway Documents and Compass Profile |
| Earnings | Pay summaries, timesheets, per diem and payment tracker (Section 11.12) | Atlas Crew and Gateway Money |
| Kiosk | Shared-device clock with PINs and optional photo (Section 4.3) | Atlas Settings, Time and Attendance |

Production-specific additions:
- **Live occupancy counter:** door counts against the permitted occupant load from the Bible capacity metrics, with alerts at 80, 90 and 100 percent.
- **Weather monitoring:** wind, lightning and heat thresholds from the Bible weather action metrics. Monitor, restrict and evacuate alerts are sent to the roles named in the emergency plan.
- **Guest list check-in at doors:** with plus-ones and credential scans.
- **Lost and found log:** with photos and claim records.

### 4.10 Remaining Platform Features

**Records**
- Duplicate a record, with or without its children.
- Archive versus delete:
  - Archive hides an item but keeps it searchable with a filter.
  - Delete moves it to Trash, which can be restored for the retention period.
- Watch or follow any record, and receive notifications on its changes.
- A history tab on every record, built on the DiffViewer.
- A global Create menu (+ and C) offering every kind the person may create in the current context.

**Platform delivery**
- Gateway and Atlas are installable as progressive web apps, with web push and an offline read cache.
- Browser support: the latest two versions of Chrome, Edge, Safari and Firefox, and Safari on iOS and iPadOS.
- In-app system banners for maintenance windows, incidents (linked to the status page) and plan notices.

**Platform operator console** (`apps/console`, internal):
- tenant search, plan overrides and feature flags
- support sessions under the consent rules in Section 8
- the marketplace moderation queue and abuse reports
- system banners and platform metrics

**Meetings and video:** Zoom, Google Meet and Microsoft Teams links are created from Meeting records through the integrations in Section 17.

**Sustainability:** waste, energy, water and transport figures are captured per project where measured, and reported against the Bible sustainability tags. An unmeasured figure stays NULL and shows as Unmeasured, never zero.

**Gate 8 measurement:** audience, earned media and sentiment figures are entered or imported against the objectives recorded at gate 1.

---

## 5. Architecture and Stack

Pin every dependency to the latest stable release available at build start and record the versions in `docs/adr/0001-stack.md`. Renovate keeps them current after launch.

| Layer | Choice |
| --- | --- |
| Monorepo | pnpm workspaces and Turborepo |
| Language | TypeScript in strict mode everywhere; `noUncheckedIndexedAccess` on |
| Web app | Next.js App Router with React Server Components, server actions for UI mutations, route handlers for the public API |
| Mobile app | Expo (React Native) with Expo Router and EAS Build and Submit; new architecture enabled |
| Offline sync | PowerSync (open edition, self-hostable) between Supabase Postgres and on-device SQLite, with sync rules per membership scope |
| Backend | Supabase: Postgres, Auth, Storage, Realtime, Edge Functions, pg_cron, pg_net, Vault |
| Database extensions | pgcrypto, pg_trgm, vector, ltree, postgis, pg_cron, pg_net, supabase_vault, all installed in the `extensions` schema |
| Public API | Hono with `@hono/zod-openapi`, mounted at `/api/v1` in Atlas, generating an OpenAPI 3.1 document |
| Validation | Zod schemas shared across the database types, API, web forms and mobile forms |
| Data access | Generated Supabase types plus a typed repository layer in `packages/data`; no raw SQL strings in app code outside migrations and RPCs |
| Web UI | React, Radix primitives, Tailwind CSS with design tokens as CSS variables, TanStack Table, TanStack Virtual, cmdk command menu |
| Mobile UI | React Native components in `packages/ui-native` consuming the same tokens; Reanimated for motion |
| Forms | React Hook Form with Zod resolvers |
| Charts | Visx on web, Victory Native on mobile |
| Email | React Email templates sent through Resend, with per-tenant verified sending domains |
| SMS | Twilio with 10DLC registration and consent capture |
| Push | Expo Notifications via APNs and FCM |
| Payments | Stripe Billing, Stripe Tax and Stripe Customer Portal |
| Search | Postgres full text plus pg_trgm, with pgvector for semantic search over documents and SOPs |
| Files | Supabase Storage with tenant-scoped buckets, signed URLs, MIME and size allow-lists and server-side virus scanning |
| Hosting | Vercel for Atlas and the docs site; Supabase for data; EAS for mobile builds |
| Observability | OpenTelemetry traces, Sentry for errors on web and mobile, structured JSON logs, Supabase log drains |
| Feature flags | Database-backed flags with plan gating and per-org overrides |
| i18n | next-intl on web and i18next on mobile, with ICU messages |
| Docs site | Nextra or Fumadocs at `docs/`, publishing the API reference from the OpenAPI document |
| CI | GitHub Actions |
| Rich text and co-editing | Tiptap editor with Yjs; updates broadcast over Supabase Realtime and persisted as snapshots in Postgres |
| Spreadsheet grid | Glide Data Grid (canvas-based, MIT) for the budget grid and bulk editing, with clipboard paste from Excel and Google Sheets |
| Maps | MapLibre GL (web) and MapLibre React Native, with vector tiles served from Protomaps PMTiles files in Supabase Storage |
| Generated documents | HTML templates rendered to tagged PDF through headless Chromium, validated with veraPDF for PDF/UA |
| AI | Anthropic API (Claude models), wrapped in `packages/ai` with prompts, tools, redaction and evals |
| Parsing and formats | chrono-node for date phrases, libphonenumber-js for phone numbers, Google address metadata for address formats |
| Exchange rates | European Central Bank daily reference rates, stored with their rate date |
| Gateway app | Next.js App Router on the same stack as Atlas, deployed as its own Vercel project with its own domains |
| Background checks | Checkr integration, storing results and references only |
| External payouts | Stripe Connect (Express accounts), optional per org |

Architectural rules:

1. **The database is the boundary.** Authorization, tenancy, state transitions, gate criteria, money invariants and refusal semantics are enforced in Postgres (RLS, constraints, triggers, RPCs). Application code may duplicate checks for user experience, but never instead of the database.
2. **One API contract.** The OpenAPI document is generated from Zod route definitions and is the contract for Atlas, Compass, SDKs and third parties. Atlas server components may read through the repository layer directly, but every mutation path has an equivalent public API operation.
3. **Optimistic UI with server truth.** Mutations apply optimistically and reconcile against the server response. Conflicts are surfaced, never silently overwritten.
4. **Offline-first Compass.**
   - Every Compass write goes through a local queue keyed with an idempotency key.
   - The server deduplicates per tenant.
   - Two devices or two tabs draining one queue must never file a record twice.

### 5.1 Global Performance and Reliability

**Regions**
- Primary region US East. EU region on the Enterprise plan for data residency (Section 14.3).
- Atlas renders its shell at the edge on Vercel. Static assets and fonts are served from the CDN with immutable caching.
- Canon responses are cached by canon generation, with the generation in the URL, so a canon change never serves stale data.

**Service level objectives**

| Measure | Target |
| --- | --- |
| Monthly availability, Atlas and API | 99.9 percent |
| API read latency, p95 in region | under 250 ms |
| API write latency, p95 in region | under 400 ms |
| API latency, p99 in region | under 800 ms |
| Time to first byte, p75 worldwide | under 600 ms |
| Compass sync of a queued write after reconnect, p95 | under 5 s |

When a month's error budget is spent, feature releases pause until reliability work restores it.

**Database scale**
- Connection pooling through Supavisor in transaction mode.
- Read replicas serve reports and exports.
- These tables are partitioned by month, with a pg_cron job creating future partitions and detaching expired ones: `audit_events`, `activity_events`, `time_entries`, `notifications`, `notification_deliveries`, `webhook_deliveries`, `usage_events`, `access_scans`.
- RLS policy columns are indexed. A benchmark test seeds 1,000,000 rows in the largest tenant table and fails if a policy-filtered list query exceeds 50 ms at p95.

**Load targets** (k6, staging): 10,000 concurrent users platform-wide, 500 per tenant, and 1,000 Compass devices syncing during one show.

**Monitoring**
- A public status page with components per region (Atlas, API, Realtime, Sync, Notifications).
- Synthetic checks every minute from five regions for sign-in, an API read, a Realtime subscription and a Compass sync.
- Alerts route to the on-call rotation with runbooks linked in each alert.

**Change safety**
- Releases roll out progressively: 5 percent, then 25 percent, then 100 percent, with automatic rollback on error-rate regression.
- Every risky feature ships behind a flag with a kill switch.
- Database changes follow expand and contract: add, backfill, switch, then remove in a later release. No release contains a change that breaks the version before it.
- The public API changes additively within `/v1`. A breaking change ships as `/v2` with at least 12 months of overlap and `Deprecation` and `Sunset` headers on the old version.
- Compass checks a server-advertised minimum version at launch. Below it, a blocking screen sends the user to update. Over-the-air updates are scoped to their native build.

---

## 6. Repository Layout

```
xos/
  apps/
    atlas/                 Internal Next.js web app and public API at /api/v1
    gateway/               External Next.js web app: marketplace, engagements, token flows
    compass/               Expo app (iOS and Android)
    docs/                  Developer and user documentation site
    console/               Platform operator console (internal, SSO-gated)
  packages/
    tokens/                Design tokens (Style Dictionary), emits CSS variables and RN theme
    ui/                    Web component library (Radix + Tailwind), Storybook
    ui-native/             Mobile component library
    icons/                 Icon set (Lucide base plus XOS glyphs)
    schemas/               Zod schemas shared across web, mobile, API
    data/                  Typed repository layer and generated database types
    api/                   Hono route definitions, OpenAPI generation
    sdk-ts/                Generated TypeScript SDK (published to npm)
    sync/                  PowerSync schema and sync rules
    i18n/                  Message catalogs
    email/                 React Email templates
    config/                ESLint, TypeScript, Tailwind, Prettier presets
    testing/               Test factories, fixtures, pgTAP helpers
  canon/
    source/                Bible, Playbook, catalog, GL CSV (inputs)
    import/                Deterministic canon importer
  supabase/
    migrations/            Numbered SQL migrations
    seed/                  Generated canon seed plus demo tenant seed
    functions/             Edge Functions
    tests/                 pgTAP suites (RLS, invariants, state machines)
  design/                  Claude Design exports: tokens JSON, component specs, screen references
  legal/                   Policy documents, ACR, subprocessor list
  docs/adr/                Architecture Decision Records
  .github/workflows/       CI pipelines
```

---

## 7. Data Model

### 7.1 Schema Conventions

- Primary keys are UUID v7. Canon tables use their natural codes (`dept_code`, `disc_code`, `cat_urid`, `phase_code`, `criterion_id`) as primary keys.
- Every tenant table has:
  - `org_id uuid not null`
  - `created_at`, `created_by`, `updated_at`, `updated_by`
  - `deleted_at` for soft delete
- `org_id` is derived from the parent row by trigger on insert. It is never accepted from the caller. A row cannot change tenant after insert; a trigger refuses the update.
- Cross-org foreign keys are refused by trigger on every insert and update path.
- Every foreign key has a supporting index.
- Lifecycles are Postgres enums or reference tables whose display values follow the naming standard. Each lifecycle has a `*_state_transitions` ledger, written only by the transition RPC.
- Money is stored as `bigint` minor units plus an ISO 4217 currency code. The currency exponent comes from one reference table.
- NULL means unpriced and is never defaulted.
- Times are stored as `timestamptz`. Typed local times are stored together with the IANA zone they were entered in.
- Soft-deleted rows have a stated retention period per table. A pg_cron purge job enforces it.
- Normalize to Third Normal Form. Derived values are views or generated columns, never duplicated state.
- Database comments (`comment on`) document every table and column, and they feed the generated data dictionary.

### 7.2 Canon Schema (`xpms`)

Tables are populated by the importer and are read-only to tenants. Canon is readable by every authenticated user. Tenant extensions live in `app` with URIDs in `.50` to `.99`.

**Dimensions**
- `dim_department`, `dim_discipline`, `dim_category`, `dim_act`, `dim_phase`
- `dim_gate_criterion`, `dim_tier`, `dim_team`, `dim_tag`, `dim_touchpoint`
- `dim_jurisdiction`, `dim_region`, `dim_region_multiplier`, `dim_escalation_index`, `dim_staleness_policy`
- `dim_permit_rule`, `dim_metric`, `dim_identifier_class`, `dim_grain`, `dim_provenance`
- `dim_facet`, `dim_assertion_rank`, `dim_record_kind`, `dim_record_subtype`, `dim_record_state`
- `dim_role`, `dim_counterparty_type`, `dim_gl_account`, `dim_cost_center_template`, `dim_category_gl`
- `dim_unit_alias`, `dim_unit_dimension`, `dim_urn_namespace`, `dim_locale`

**Catalog**
- `elements` (1,211 items)
- `element_price_bands` (Base, Elevated and Premium grades with assertion rank, valid-from and valid-to)
- `element_gtins`, `bridge_element_phase`, `bridge_element_tag`, `bridge_element_permit`, `bridge_element_metric`, `bridge_touchpoint_discipline`, `bridge_discipline_team`

**XOS Standard Library** (from the Playbook, Section 2.1; copied into each new org as editable org data)
- `std_document_library`, `std_emergency_code`, `std_enumeration`, `std_labor_rate_card`, `std_radio_channel`, `std_role`, `std_sop`, `std_vendor_class`, `std_vendor_entitlement`, `std_verbiage`

**Templates**
- `production_template` and `production_template_rows`: the XOS 4.0 Production Template, holding every row of the 27 record-template sheets, keyed by sheet and source row number

**Governance**
- `field_provenance`, `supersession`, `ratification`, `intake` (staging for proposed canon additions), `version` (current canon version and generation)

**Functions**
- `xpms.assert_or_refuse(claim, domain, is_critical)` returns the claim or a refusal value.
- `xpms.band_effective_confidence(confidence, valid_from, valid_to, as_of)` applies the staleness policy.
- `xpms.may_write_field(element_id, field, provenance)` enforces the provenance ranks.
- `xpms.resolve_element(query)`, `xpms.resolve_gtin(code)` and `xpms.urid_segment(urid, level)` resolve catalog references.
- `xpms.is_extension_urid(urid)` reports whether a URID is a tenant extension.
- `xpms.urn(kind, key)`, `xpms.urn_parse(urn)` and `xpms.urn_resolve(urn)` handle URNs.
- `xpms.assert_supersession_acyclic()` keeps the supersession graph acyclic.

**Views**
- `v_coordinate_matrix` (90 coordinates: 10 departments by 9 phases, counting participation)
- `v_phase_coverage`, `v_element_economics`, `v_crosswalk_coverage`

### 7.3 Tenant Schema (`app`): Platform

**Tenancy**
- `orgs`, `org_settings`, `org_domains` (verified), `org_ip_allowlist`, `org_branding`, `org_legal_entities`, `workspaces`, `workspace_members`

**Identity**
- `profiles`, `user_preferences`, `user_passkeys`, `webauthn_challenges`, `mfa_recovery_codes` (hashed), `phone_verifications` (hashed codes), `api_keys` (hashed, scoped, expiring)

**Membership**
- `memberships` (org, user, role, persona, valid-from, valid-to), `invites`, `project_members`, `teams` (working groups, distinct from canon teams), `team_members`

**Access**
- `roles`, `capabilities`, `role_capabilities`, `user_capability_grants`, `record_grants`, `delegations`

**Parties**
- `parties` (people and companies), `party_aliases`, `party_identities`, `party_relationships`, `party_merge_log`
- Each party carries a `counterparty_type` from canon.

**Billing**
- `plans`, `subscriptions`, `subscription_state_transitions`, `usage_events`, `usage_rollups`, `feature_flags`, `feature_flag_overrides`, `stripe_events`

**Audit and privacy**
- `audit_events` (append-only compliance ledger, 7-year retention), `activity_events` (user-facing feed, 18-month retention)
- `consent_records`, `cookie_consent_events`, `sms_consent_events`, `dsar_requests`, `privacy_signals` (Global Privacy Control), `file_access_log`, `retention_policies`

**Messaging**
- `notifications`, `notification_deliveries`, `notification_preferences`, `notification_templates`, `suppression_list`, `push_subscriptions`, `email_templates`, `email_digest_queue`

**Platform services**
- Jobs: `job_queue`, `idempotency_keys` (scoped per tenant)
- Integrations: `integrations`, `integration_credentials` (Vault references only), `integration_external_ids`, `webhook_endpoints`, `webhook_deliveries`
- Import and export: `import_jobs`, `import_row_results` (row states: Valid, Invalid, Written, Refused, Skipped), `export_jobs`
- Identifiers: `id_sequences`, with `next_sequence(org, scope, format)` issuing `{URID}-{ORG}-{SEQ}`
- Search and views: `saved_views`, `dashboards`, `report_definitions`, `report_runs`
- Configuration: `config_values`

**Workflow engine**
- Approvals: `approval_policies`, `approval_steps`, `approval_instances`, `approval_decisions`
- Automations: `automations`, `automation_runs`
- Forms: `form_definitions`, `form_submissions`
- Custom fields: `custom_field_definitions`, `custom_field_values`
- Org state labels: `org_state_labels` (orgs may relabel the nine record states for display without minting a new lifecycle)
- Templates: `templates`, `template_versions`, `template_applications`
- One unified comment system: `comment_threads`, `comments`, `comment_mentions`, `comment_reactions`, `thread_subscriptions`
- `record_dependencies`, `record_recurrences`

**Added in 1.3**
- Reseller: `orgs.parent_org_id`, `partner_settings`, `partner_price_books`, `partner_client_billing`
- Authorization: `spend_authority`, `separation_of_duties_rules`, `column_classifications`, `access_review_campaigns`, `access_review_items`, `break_glass_sessions`, `service_accounts`, `oauth_apps`, `oauth_grants`, `project_shares`, `scim_group_mappings`
- Import: `import_batches` (with `import_batch_id` on every imported row), `import_mapping_profiles`, `merge_reviews`
- Custom objects: `custom_object_types`, `custom_object_fields`, `custom_object_records`, `custom_object_relations`
- Reporting (extending `report_definitions` and `dashboards` above): `dashboard_tiles`, `report_schedules`, `warehouse_deliveries`
- Feeds and email: `calendar_feeds` (hashed tokens), `inbound_addresses`, `inbound_messages`
- Collaboration: `doc_snapshots` and `doc_updates` (Yjs), `presence` is ephemeral in Realtime and never stored
- AI: `ai_settings`, `ai_requests` (redacted), `ai_suggestions` (pending human confirmation), `ai_usage`
- Money and formats: `fx_rates` (currency pair, rate, rate date, source), `price_books`
- Lifecycle: `org_exports`, `deletion_certificates`, `ownership_transfers`
- Product: `onboarding_progress`, `sandbox_orgs`, `changelog_entries`, `feedback_submissions`, `shortcut_bindings`

**Added in 1.4 (Gateway)**
- External identity:
  - `external_profiles` (person-owned)
  - `profile_field_visibility`
  - `external_accounts`
  - `external_account_members` (account roles)
  - `representations` (scopes, expiry, artist acceptance)
  - `profile_shares` (consent snapshots per org)
- Marketplace:
  - `opportunities`, with `opportunity_state` and transitions
  - `opportunity_positions`, `opportunity_requirements`, `opportunity_questions`
  - `pay_transparency_rules` (by jurisdiction)
  - `saved_searches`, `opportunity_alerts`
  - `listing_reports`, `moderation_actions`
- Applications:
  - `applications`, with `application_state` and transitions
  - `application_answers`
  - `bids` and `bid_lines` (sealed until deadline)
  - `agency_slates`
  - `shortlists`, `interviews`
- Engagements:
  - `engagements` (party or external account, org, project, role type), with `engagement_state` and transitions
  - `engagement_documents` (canon Engagement-Document lifecycle)
- Onboarding:
  - `onboarding_requirements` (role type, jurisdiction, org)
  - `onboarding_items`, `onboarding_verifications`
  - `tax_forms` (Restricted, encrypted)
  - `payout_accounts` (provider references only)
  - `background_checks` (provider result and reference only)
- Pools and ratings:
  - `talent_pools`, `pool_members` (Preferred, Approved, Do Not Engage with reason and review date)
  - `ratings` (two-sided, released together), `rating_replies`
- Messaging: `engagement_threads`, `engagement_messages`
- Availability: `availability_calendars`, `availability_blocks`

**Added in 1.6**
- Identity (Section 4.8.1):
  - `people`, `organizations`, `subscriptions`
  - `memberships` and `membership_roles` (many roles per membership)
  - `project_assignments` and `project_assignment_roles`
  - `account_memberships` and `account_membership_roles`
  - `organization_relationships`, `representations`
  - `join_requests`, `invitation_links`, `verified_domains`, `offboarding_checklists`
- Profiles:
  - `person_profiles`, `organization_profiles`, `profile_sections`
  - `profile_visibility` (owner, section or field, level)
  - `profile_handles` and `handle_redirects`
  - `verifications`, `blocks`
- Settings: `setting_definitions` (generated from `settings.yaml`), `setting_values` (scope type, scope id, setting, value), `setting_locks`
- Views: `view_definitions` (generated from `views.yaml`), `saved_views`, `saved_view_shares`
- Workforce suite:
  - Feed: `feed_posts`, `post_audiences`, `post_acknowledgments`, `post_reactions`, `post_comments`
  - Groups: `groups`, `group_members`
  - Events: `event_rsvps`, `event_checkins`
  - Polls: `polls`, `poll_options`, `poll_votes`
  - Surveys: `surveys`, `survey_questions`, `survey_responses`
  - Recognition: `recognitions`
  - Help desk: `helpdesk_categories`, `helpdesk_requests`
  - Training: `courses`, `lessons`, `quizzes`, `quiz_attempts`, `course_completions`
  - Forms: `form_versions` and `form_fields` (forms are normalized, one row per field and per answer)
  - On-site operations: `occupancy_counts`, `weather_alerts`, `lost_found_items`
- Help and support:
  - `help_routes` (generated from the help content)
  - `tour_progress`, `tip_dismissals`
  - `support_tickets`, `support_ticket_messages`
- Records: `record_watchers`, `trash_items` (view over soft-deleted rows, not a copy)

**Name mapping.** These names are final, and generated code uses them. Where an earlier section names an older table, it means the entity here:

| Earlier name | Final name |
| --- | --- |
| `orgs`, `external_accounts` | `organizations` (a tenant is an organization with a subscription) |
| `profiles`, `external_profiles` | `person_profiles` |
| `parties` and `party_*` tables | `people` or `organizations`, plus `organization_relationships` for org-owned facts |
| `external_account_members` | `account_memberships` |
| The single role on `memberships` | `membership_roles` |

No entity exists under two names.

### 7.4 Tenant Schema (`app`): XOS Domain

**Scope**
- `projects` carries `jurisdiction_id`, `region_code`, `tier_code`, `current_phase_code` and `project_state`.
- `scope_nodes` (an ltree scope tree: engagement root, standing venue, show) with `scope_code`.
- `project_phase_transitions` and `gate_evidence` (criterion, record reference, evidence document, attested by, attested at, assertion rank).

**Record spine**
- `records` is one table for all 26 kinds, carrying:
  - `record_kind`, `record_subtype`, `record_class`, `record_state`, `title`
  - `scope_node_id`, `phase_code`, `urid`, `xyz`, `owner_party_id`, `accountable_party_id`
  - `starts_at`, `ends_at`, `due_at`, `blocker_text`, `replan_reason`, `external_visibility` (which external role types or named parties may see the record; empty means internal only)
- Kind-specific attributes live in 1:1 extension tables keyed by `record_id`:
  - `record_task`, `record_shift`, `record_booking`, `record_contract`, `record_payment`
  - `record_permit`, `record_inspection`, `record_meeting`, `record_event`, `record_document`
  - `record_supply`, `record_risk`, `record_goal`, `record_distribution`, `record_report`
  - `record_training`, `record_recruitment`, `record_rehearsal`, `record_build`, `record_strike`
  - `record_approval`, `record_compliance`, `record_deadline`, `record_decision`, `record_milestone`, `record_timeline`
- `record_state_transitions` and `record_replans` are append-only.
- `record_checklist_items` hold one row per item, so a tick can never land on another item.

**Schedule**
- `schedule_baselines`, `schedule_actuals`, `calendars`. Timeline records are the windows other records roll up into.

**Show**
- `run_of_show`, `cues`, `day_sheets`, `call_sheets`

**Places**
- `venues`, `spaces`, `zones`, `capability_documents` (frozen flag, validity window), `site_plans`, `site_plan_pins`, `geofences` (postgis)

**Requirements and capability**
- `requirements` and `capabilities` share one shape with a `direction` facet (require or provide), so reconciliation is a join, never two forked schemas.
- `reconciliations` and `reconciliation_lines` record the result: Met, Gap, Unknown.

**Advancing**
- `advance_packets`, `advance_sections`, `advance_recipients` (party-bound), `advance_submissions`, `advance_promotions`, `riders`, `rider_lines`

**Logistics**
- `shipments`, `shipment_lines`, `dock_slots`, `gate_queue`, `marshalling_log`

**Hospitality**
- `fulfillments` (lodging, catering, travel, amenity), `fulfillment_lines`, `beos`, `beo_lines`

**Assets**
- `asset_classes` (bound to elements), `asset_units` (serial and asset tag), `asset_lots`, `asset_identifiers`
- `asset_custody` (custody ledger), `asset_maintenance`, `asset_damage`, with a nine-value asset lifecycle

**People**
- `role_assignments` (canon role code, staffing ratio basis), `requisitions`, `offers`, `agreements` (contractor MSA, offer letter; token signing with state ledger; a signed agreement cannot be revoked or unsigned)

**Crew**
- `shifts`, `shift_swaps`, `time_entries`, `time_entry_corrections`, `time_entry_audit`, `timesheets`, `timesheet_approvals`
- `kiosk_devices`, `kiosk_pins` (hashed)

**Rates and payroll**
- `rate_cards`, `rate_card_lines`, `pay_rates` (ledger), `overtime_rules`, `union_local_rates`, `wage_determinations`
- `pay_periods`, `payroll_runs`, `payroll_lines`, `payroll_exports`, `earning_codes`, `per_diems`, `time_off_policies`, `time_off_requests`

**Credentials**
- `credential_categories`, `credentials` (issued), `access_grid` (zone by credential category, with time windows), `access_scans`, `certifications`, `certification_holders`

**Finance**
- `budgets`, `budget_lines` (GL account, cost center, URID, XYZ, line type including Fee and Contingency, grade, NULL-able unit price)
- `expenses`, `contingency_draws`, `change_orders`, `change_order_lines`
- `accounting_periods` (lifecycle: Open, In Period, Closing, Closed, Audited, Archived)
- `journal_entries`, `journal_lines`, `posting_lines` (UPL), `invoices`, `invoice_lines`, `payment_applications`, `billing_draws`
- `cost_centers`, `tax_jurisdictions`, `tax_rates`

**Procurement**
- `rfqs`, `rfq_invitations`, `rfq_responses`, `rfq_response_lines`
- `purchase_orders`, `po_lines`, `po_change_orders`, `goods_receipts`, `receipt_lines`, `invoice_matches` (three-way)
- `catalog_bindings` (tenant item to element), `vendor_products`

**Vendors**
- `vendors` (a party with vendor facet), `vendor_classes`, `vendor_class_assignments`, `prequalifications`, `insurance_certificates`, `vendor_scorecards`, `sponsor_entitlements`

**Safety**
- `inspection_templates`, `inspection_items`, `inspections`, `inspection_results`
- `permit_requirements` (generated by the jurisdiction permit engine)
- `incidents`, `incident_parties`, `incident_media`, `dispatch_assignments`, `medical_encounters` (restricted), `crisis_alerts`
- `emergency_codes` (numeric order), `radio_channels`

**Knowledge**
- `sops`, `sop_acknowledgments`, `documents`, `document_versions`, `verbiage_terms` (controlled vocabulary with casing rules)

**Analytics**
- Materialized views for gate readiness, budget versus actual by account, cost center and URID, labor cost, PO exposure, incident rates and the final cost report against the gate 3 baseline

### 7.5 Database-Enforced Invariants

Each invariant below is implemented in SQL and covered by a pgTAP test.

**Tenancy**
1. Tenant column derived from parent; no tenant move; cross-org foreign keys refused.
2. A project record is readable by project members and by crew assigned to it, not by the whole org.
3. Leaving an org ends access immediately, including to notifications.
4. A sole Owner cannot remove or demote themselves.

**Policies and grants**

5. RLS policies wrap `auth.uid()` in a subselect, call helpers from `private`, and pair read and write halves that agree.
6. Every function pins `search_path`. SECURITY DEFINER functions are revoked from `anon` except named token RPCs.
7. Anonymous access goes only through column-scoped `api_public` views or token RPCs. No `select *` projection reaches `anon`.

**Tokens and secrets**

8. Token RPCs require a token and an access code, expire, rate-limit failed attempts, and return only the fields the page renders. Access codes, second factors, recovery codes and kiosk PINs are stored hashed and shown once.

**Lifecycle**

9. Gate transition uses compare-and-set on the expected current phase. It refuses when any blocking criterion lacks evidence.
10. A closed production refuses new invoices, POs, expenses, time entries and change orders.

**Money**

11. NULL price propagates. An unpriced change order cannot be stored at zero. Aggregates of NULL are NULL with an unpriced count.
12. One expense posts to exactly one budget line.
13. A closed accounting period refuses postings. An open period cannot become Audited without passing through Closed.
14. A posted pay period cannot reopen.
15. A payroll run cannot jump from Draft to Accepted.
16. Billed-to-date counts each payment once.
17. Three-way match refuses a duplicate receipt and never auto-approves a mismatched invoice.

**Approvals and time**

18. Approvals are decided by an eligible approver, never the requester. A crew member cannot approve their own swap or timesheet.
19. A timesheet approval is voided when its hours change.
20. Time entries cannot overlap for one person. A shift cannot end before it starts.
21. Certifications and credentials cannot be self-issued. A certificate verifies publicly only if the holder consented.

**Incidents**

22. A critical incident cannot be relabeled and closed in one statement. Closing requires sign-off.

**Retention and copy**

23. Audit plaintext containing personal data is redacted at 90 days at every JSON depth. The audit ledger itself is append-only for 7 years.
24. No em dash is accepted in canon or verbiage text (check constraint).

---

## 8. Authorization Model

**Platform roles per org**, in band order:

| Role | Scope |
| --- | --- |
| Owner | Everything, including billing, deletion and data rights |
| Admin | Org configuration, members, integrations, canon extensions |
| Manager | Full project and finance operations within assigned scopes |
| Member | Create and edit within projects they belong to; no finance approval |
| Collaborator | Edit assigned records only; no finance or procurement writes |
| Field | Compass field functions, own shifts, own time, assigned tasks (the org's own field employees) |
| Viewer | Read within granted scopes |

**External role types** are not org roles. They come from engagements (Section 4.4) and never grant Atlas access: Client, Vendor, Contractor, Crew, Staff, Artist, Artist Representative, Sponsor.

**Capabilities**
- Capabilities are fine-grained verbs, for example `finance.po.approve`, `crew.timesheet.approve` and `canon.extension.write`.
- Roles map to capabilities. Orgs may create custom roles from the capability set.
- Capability enforcement is checked in RLS through `private.has_capability(org_id, capability, scope)`.

**Project roles**: Producer, Department Head, Coordinator, Field Supervisor and Field. These narrow scope inside a project. Field members reach project records through assignment as well as membership. External parties reach a project only through their engagements (Section 8.7).

**Time-boxed access**: memberships and grants carry valid-from and valid-to dates, enforced in SQL.

**Platform operator access**: the internal console can open a tenant only through a support session. The tenant Owner must grant it, it expires within 24 hours, and every action is logged to the tenant's audit ledger.

### 8.1 Spend Authority

- `spend_authority` rows set limits by role or person, by document type (purchase order, change order, expense, invoice approval, contract, payroll run), by GL account or cost center scope, and by amount in the org currency.
- An amount above the approver's limit routes to the next approver in the policy. Amounts above a second threshold require two approvers.
- Limits are enforced inside the approval RPCs, not only in the interface.

### 8.2 Separation of Duties

Default rules, which an org may tighten but never remove:

| Rule | Enforced on |
| --- | --- |
| The creator of a purchase order cannot approve it | Purchase orders |
| A person who creates a vendor or edits its bank details cannot approve payment to it | Vendors, payments |
| The submitter of an expense, timesheet or time-off request cannot approve it | Expenses, timesheets, time off |
| The preparer of a journal entry cannot post it | Journal entries |
| A person cannot grant themselves a role or capability | Memberships, grants |
| The requester of a change order cannot price and approve it alone | Change orders |

Each rule is a database check that returns a refusal naming the rule.

### 8.3 Field-Level Permissions and Classification

- Every column carries a classification: Public, Internal, Confidential or Restricted, recorded in a column registry.
- Restricted columns include pay rates, bank details, tax identifiers, government identifiers and medical notes.
- Restricted values are masked in views and API responses unless the caller holds the matching capability (for example `data.restricted.read.payroll`). Masking keeps the field present and marks it masked, so the interface can say why.

### 8.4 Access Transparency

- **View as role:** an Admin can preview the interface as any role. The preview shows only data the Admin could already see, never more.
- **Why can I see this:** every record offers an explanation listing the membership, grant or policy that gives the current user access.
- **Access reviews:** each quarter, managers confirm or remove each member's role. Access left unreviewed after 14 days is flagged, and is removed automatically if the org turns that on.
- **Break-glass:** an Owner can take emergency full access for one hour. It requires MFA and a written reason, notifies every Admin, and is logged.

### 8.5 Non-Human and Cross-Org Access

- **Service accounts:** non-human members with capability-scoped API keys, owners, expiry and their own audit identity.
- **OAuth apps:** scopes map one to one to capability groups, shown on a consent screen.
- **Cross-org project sharing:** a project can be shared with a partner org (for example an agency and its client). A `project_shares` row maps the partner's roles onto project roles and lists the shared scope nodes. Each org keeps ownership of its own records, and both audit ledgers record shared access.
- **One person, many orgs, projects and roles:** a single sign-in can hold any number of internal memberships, external engagements and project roles, across any number of orgs (Section 4.8). Personal facts belong to the person record. Org-owned facts (pay rate, internal notes, internal ratings) live on the org-side relationship row and are never visible to another org.
- **SCIM groups:** a mapping table assigns roles and teams from identity-provider groups.

### 8.6 Data Loss Prevention

| Classification | Export and download | Share links | Watermark |
| --- | --- | --- | --- |
| Public | Allowed | Allowed | None |
| Internal | Allowed for members | Allowed with expiry | None |
| Confidential | Requires the export capability | Allowed with expiry and access code | Viewer email and timestamp on PDFs and images |
| Restricted | Requires the restricted export capability and step-up authentication | Not allowed | Viewer email and timestamp |

### 8.7 External Access (Gateway and Compass)

- **The engagement is the key.** An external user reads and writes a row only when one of these holds:
  - The row belongs to an engagement they hold.
  - The row belongs to an engagement their external account holds, and their account role allows it.
  - They represent the artist who holds the engagement, within the representation's scopes.
  - The row is a record whose `external_visibility` names their role type or their party.
- **Helpers in `private`:** `is_engaged_party(project_id)`, `engagement_scope(engagement_id)`, `represents(artist_party_id, scope)` and `account_role(account_id)`. Every external policy is built from these helpers.
- **Projections:** external reads go through column-allowlisted views in an `api_external` schema. Internal columns never reach an external user, even when a row is shared. These columns include internal notes, margins, budget lines, other parties' rates, internal ratings and Do Not Engage flags.
- **Sealed bids:** a bidder can read only their own bid. No bid is visible to the org until the deadline passes, except to roles holding `procurement.bid.unseal`.
- **Time-boxed by state:**
  - External access to an engagement's operational records opens when the engagement becomes Active.
  - It narrows to Money and Documents at Complete. Credentials and Compass access end at that point.
  - Everything closes 18 months after Complete, apart from the person's own tax documents and payments.
- **Compass:** sync rules apply the same engagement scope, so an external device never stores another party's data.
- **pgTAP:** every external policy is tested for:
  - access through own engagement, account engagement and representation
  - denial for another party's engagement
  - denial after close
  - denial for internal-only columns

---

## 9. Security Requirements

**Authentication**
- Methods: email with password, magic link, passkeys (WebAuthn), and Google, Apple and Microsoft OAuth. Enterprise SAML SSO and SCIM provisioning are available on the Enterprise plan.
- Passwords are checked against breached-password lists.
- MFA: TOTP and passkeys. Orgs can enforce MFA per role.
- Session lifetime is configurable per org.
- Step-up authentication is required for billing, data export, role changes and API key creation.

**Secrets and network**
- Keys live in Supabase Vault and Vercel encrypted environment variables. Secrets are never stored in the repo; CI secret scanning blocks commits that contain them.
- Org IP allow-lists cover Atlas and the API.

**Encryption**
- TLS 1.2 or higher, with HSTS preloading.
- At rest: AES-256 (platform-managed).
- Field-level pgcrypto encryption for tax identifiers, bank details, government identifiers and medical encounter notes.

**Application security**
- OWASP Application Security Verification Standard 5.0 Level 2. Map every control to a test or document in `legal/security/asvs-matrix.md`.
- OWASP Top 10 and API Security Top 10 mitigations.
- Strict Content Security Policy with nonces. Same-site cookies and CSRF protection on server actions.
- SSRF protection on webhooks and imports via an allow-list resolver.
- File uploads: MIME sniffing, size caps, virus scanning, and SVG sanitization. Active content is never served inline from public buckets.

**Rate limiting and abuse**
- Rate limits apply per IP, per user, per API key and per token RPC.
- Repeated token failures lock the token.

**Supply chain**
- Lockfile enforcement, Dependabot or Renovate, an SBOM (CycloneDX) per release, signed commits on main, and pinned GitHub Actions by SHA.

**Testing**
- SAST (CodeQL, Semgrep), dependency scanning, secret scanning, DAST (OWASP ZAP baseline against staging), and RLS penetration tests in pgTAP that attempt cross-tenant reads and writes on every table.

**Operations**
- Incident response runbook, a security.txt, and a responsible disclosure policy.
- Backups: point-in-time recovery with a 7-day minimum and weekly logical backups to separate storage.
- Recovery targets: 1 hour RPO and 4 hour RTO, verified by a restore drill script.

---

## 10. API, Open Source and Extensibility

### 10.1 Public API

- Versioned REST at `/api/v1`.
- The OpenAPI 3.1 document is served at `/api/v1/openapi.json` and rendered in the docs site.
- Authentication options:
  - OAuth 2.1 with PKCE for user-delegated apps
  - Org-scoped API keys with capability scopes and expiry, for servers
  - Short-lived JWTs for Atlas and Compass
- Resources cover every module in Section 4.2, plus canon read endpoints (`/canon/departments`, `/canon/disciplines`, `/canon/categories`, `/canon/elements`, `/canon/phases`, `/canon/gate-criteria`, `/canon/record-kinds` and the rest).
- Conventions:
  - Cursor pagination, sparse fieldsets and filter grammar documented in the spec
  - Idempotency-Key header on every POST
  - ETag and If-Match on updates
  - RFC 9457 problem details for errors
  - Refusals return 422 with `refusal: NO_ANSWER | UNRATIFIED | REFUSE` and the reason
- Every coded list returns in numeric order.
- Webhooks:
  - Event catalog: `record.created`, `record.state_changed`, `project.gate_passed`, `po.approved`, `invoice.issued`, `timesheet.approved`, `incident.reported` and the rest, generated from the domain event table.
  - Delivery is signed (HMAC-SHA256 with timestamp), retried with exponential backoff for 72 hours, and replayable from Atlas.

### 10.2 SDKs and Tooling

- A TypeScript SDK is generated from the OpenAPI document and published to npm as `@xos/sdk`.
- A Python SDK is generated with openapi-python-client and published to PyPI as `xos-sdk`.
- A CLI (`xos`) supports import, export, canon validation and webhook testing.
- An MCP server (`@xos/mcp`) exposes read and scoped write tools over the public API, so AI agents can operate a tenant with the same permissions as an API key.

### 10.3 Open Source

| Component | License |
| --- | --- |
| Platform (`apps/atlas`, `apps/gateway`, `apps/compass`, `apps/console`, `packages/api`, `packages/data`, `supabase/`) | AGPL-3.0 |
| SDKs, design tokens, UI libraries, schemas, CLI, MCP server | MIT |
| Canon data (the XOS Bible as published data) | CC BY 4.0, with the XOS name and marks reserved under a trademark policy |

Repository requirements:

- `LICENSE`, `NOTICE`, `CONTRIBUTING.md` with the Developer Certificate of Origin
- `CODE_OF_CONDUCT.md` (Contributor Covenant), `SECURITY.md`, `GOVERNANCE.md`, `TRADEMARKS.md`
- Issue and pull request templates
- A self-hosting guide using the Supabase CLI and Docker Compose
- License compliance check in CI (no GPL-incompatible dependencies in MIT packages)

---

## 11. Design System: Linear-Style Default Aesthetic

### 11.1 Direction

The default UI follows the Linear style:

- Calm, dense, keyboard-first and fast.
- Dark by default with a full light theme.
- Restrained color and crisp 1 px borders.
- Small, legible type and generous use of the command menu.

It is an original implementation. It does not copy Linear's assets, icons, logos or exact brand colors.

### 11.2 Principles

1. **Keyboard first.**
   - Cmd or Ctrl+K opens the command menu everywhere.
   - Every action has a shortcut, and `?` shows the shortcut sheet.
   - G then a letter navigates between modules.
   - C creates a record in the current context.
   - J and K move through lists; X selects.
2. **Speed is a feature.**
   - Every page reaches interactive in under 1.5 s on a mid-tier laptop.
   - Lists of 10,000 rows scroll at 60 fps through virtualization.
   - Optimistic mutations show within 100 ms.
3. **Density with clarity.**
   - Base UI text is 13 px. Table rows are 36 px (compact 32 px, comfortable 44 px).
   - Properties render as inline chips that edit in place.
4. **One record anatomy.** Every record opens in a side peek panel and in a full page, with the same layout:
   - Title, kind and state
   - A property column
   - An activity and comment thread
   - Related records
5. **Views over pages.** Every collection supports:
   - List, Board (by state or any enum), Timeline (Gantt) and Calendar views
   - Table with column picker, grouping, sub-grouping, filters, sort and display density
   - Saved views per user and per team
6. **Motion with purpose.** Transitions run 120 to 200 ms with ease-out. All motion respects `prefers-reduced-motion`.

### 11.3 Tokens

Tokens are defined in `packages/tokens` (Style Dictionary) and emitted as CSS variables and a React Native theme. Every white-label override operates on these tokens only. The default values are below; the token build must verify the contrast ratios automatically and fail if any pair falls under its WCAG 2.2 AA threshold.

| Token | Dark | Light |
| --- | --- | --- |
| `color.bg.canvas` | #0E0F11 | #FFFFFF |
| `color.bg.surface` | #16171A | #F7F7F8 |
| `color.bg.raised` | #1C1D21 | #FFFFFF |
| `color.bg.hover` | #222328 | #EFEFF1 |
| `color.border.subtle` | #26272C | #E6E6E9 |
| `color.border.strong` | #34353B | #D1D2D6 |
| `color.text.primary` | #EDEEF0 | #17181C |
| `color.text.secondary` | #A0A3AB | #5B5E66 |
| `color.text.tertiary` | #858892 | #6B6E76 |
| `color.accent.default` | #5B63E8 | #4F57D9 |
| `color.accent.text-on` | #FFFFFF | #FFFFFF |
| `color.focus.ring` | #8B92F5 | #4F57D9 |
| `color.danger` | #EF5A5A | #C93636 |
| `color.warning` | #E5A23B | #A86A06 |
| `color.success` | #3FB97A | #1F8A4F |

Record state colors are paired with icons, so state is never conveyed by color alone:

| State | Icon | Hue |
| --- | --- | --- |
| Proposed | Dashed circle | Neutral |
| Ready | Empty circle | Neutral strong |
| Scheduled | Clock circle | Blue |
| Active | Half circle | Accent |
| Blocked | Octagon | Danger |
| In Review | Eye circle | Violet |
| Complete | Check circle | Success |
| Deferred | Pause circle | Warning |
| Canceled | Slashed circle | Tertiary |

Typography, spacing and shape:

- **Fonts**: Inter (variable, SIL OFL) for UI, with tabular numerals enabled in tables and money. JetBrains Mono (SIL OFL) for URIDs, codes, item IDs and URNs.
- **Type scale (px)**: 11, 12, 13 (base), 14, 16, 20, 24, 32. Line height is 1.45 for body and 1.2 for headings.
- **Spacing**: a 4 px base with steps 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- **Radius**: 4 (chips), 6 (inputs and buttons), 8 (cards and menus), 12 (dialogs).
- **Elevation**: border-first, with shadows only for menus, popovers and dialogs.
- **Icons**: Lucide at 16 px with a 1.5 stroke, plus XOS glyphs for the 10 departments, 9 phases and 26 record kinds, drawn on the same grid.

**Motion tokens**

| Token | Value | Use |
| --- | --- | --- |
| `motion.duration.instant` | 0 ms | State changes with no movement |
| `motion.duration.fast` | 120 ms | Hover, press, chip and toggle changes |
| `motion.duration.base` | 160 ms | Menus, popovers, tooltips |
| `motion.duration.slow` | 200 ms | Side peek, drawers, toasts |
| `motion.duration.deliberate` | 280 ms | Dialogs and route transitions |
| `motion.easing.standard` | cubic-bezier(0.2, 0, 0, 1) | Moving within the screen |
| `motion.easing.enter` | cubic-bezier(0, 0, 0.2, 1) | Elements appearing |
| `motion.easing.exit` | cubic-bezier(0.4, 0, 1, 1) | Elements leaving |
| `motion.spring.default` (native) | damping 20, stiffness 220, mass 1 | Sheets and cards |
| `motion.spring.snappy` (native) | damping 26, stiffness 320, mass 1 | Buttons, toggles, scan confirmation |
| `motion.spring.gentle` (native) | damping 18, stiffness 140, mass 1 | Shared-element transitions |

**Layering, layout and shape tokens**

| Token group | Values |
| --- | --- |
| `z` | base 0, sticky 100, sidebar 200, header 300, dropdown 1000, popover 1100, peek and drawer 1200, dialog 1300, command menu 1400, toast 1500, tooltip 1600 |
| `breakpoint` (px) | sm 640, md 768, lg 1024, xl 1280, 2xl 1536, 3xl 1920 |
| `layout` (px) | sidebar 240 expanded, 56 collapsed, resizable 200 to 360; side peek 560, resizable 440 to 960; content width reading 720, form 640, wide 1200, full fluid; 12-column grid with 16 px gutters, 24 px from lg up |
| `shadow` (dark) | menu 0 8px 24px rgba(0,0,0,0.48); dialog 0 24px 48px rgba(0,0,0,0.56); both paired with a 1 px `color.border.subtle` ring |
| `shadow` (light) | menu 0 8px 24px rgba(16,24,40,0.12); dialog 0 24px 48px rgba(16,24,40,0.18); both paired with a 1 px `color.border.subtle` ring |
| `opacity` | disabled 0.48; scrim 0.64 dark, 0.40 light; hover overlay 0.06; pressed overlay 0.10 |
| `icon.size` (px) | 12, 14, 16 (default), 20, 24; Compass 20, 24 (default), 28 |
| `density` | rows 32 compact, 36 default, 44 comfortable; web control heights 24, 28 (default), 32; Compass minimum touch target 48 pt |

**Data visualization palette**
- Categorical: the Okabe-Ito colorblind-safe set (#E69F00, #56B4E9, #009E73, #F0E442, #0072B2, #D55E00, #CC79A7), with #999999 as the eighth color, used in that order.
- Sequential: a nine-step ramp of `color.accent.default` generated in OKLCH.
- Diverging: blue to orange through neutral, for variance and budget versus actual.
- Every series also differs by marker or line style, and every chart has a table view.

**Modes beyond dark and light**
- System: follows the operating system setting, and is the default for new users.
- Forced colors: under `@media (forced-colors: active)` components use system colors, keep their borders and keep visible focus.
- Sunlight (Compass): maximum contrast, no translucency, thicker borders.
- Print: a print stylesheet for records, lists and reports on US Letter and A4, with no navigation chrome.

### 11.4 Component Inventory

Web (`packages/ui`) and native (`packages/ui-native`) each implement every component. Every component has a Storybook story (web) or a component gallery entry (native), an accessibility test and visual regression snapshots in both themes.

**Primitives**
- Button, IconButton, Link, Input, Textarea, Select, Combobox, MultiSelect, Checkbox, Radio, Switch, Slider
- DatePicker, DateRangePicker, TimePicker (zone-aware), CurrencyInput (NULL-aware, renders Unpriced), NumberInput with units, FileDrop

**Feedback**
- Toast, InlineAlert, Banner, ProgressBar, Skeleton, EmptyState (with a specific next action, never generic copy), ErrorState, RefusalNotice (renders NO ANSWER, UNRATIFIED or REFUSE with its reason)

**Overlays**
- Dialog, Drawer, SidePeek, Popover, Tooltip, ContextMenu, DropdownMenu, CommandMenu, ShortcutSheet

**Navigation**
- Sidebar (collapsible, with workspace switcher), Tabs, Breadcrumbs, Pagination (cursor), SegmentedControl

**Data**
- DataTable (virtualized, column pinning, resize, group, aggregate, inline edit, keyboard grid navigation)
- Board, Timeline (Gantt with dependencies, baselines and gate markers), Calendar, TreeView (scope tree)
- PropertyChip, StateChip, PhaseChip, DepartmentChip, URIDChip, AvatarStack, Tag

**XOS-specific**
- GateReadinessPanel (35 criteria with evidence and blocking flags)
- CoordinateMatrix (10 by 9 grid with drill-down)
- BudgetGrid (GL by cost center by URID with NULL-aware totals and Base, Elevated and Premium grade toggles)
- ProvenanceBadge, AssertionRankBadge, StalenessIndicator
- ReconciliationTable (Met, Gap, Unknown)
- RunOfShowLive (cue list with countdown)
- AccessGridMatrix, EmergencyCodeCard, RadioChannelTable

**Compass-specific**
- ClockButton (large, haptic, geofence state), ScanSheet (camera and NFC), OfflineBanner with queue count, QuickIncidentSheet, ChecklistRunner, ShiftCard, DaySheetView, SignaturePad, PhotoCapture with annotation

**Added in 1.3**
- Layout: AppShell, PageHeader, SplitView, Card, Accordion, Divider, Stepper (wizard), ResizablePanel
- Identity: Avatar, Badge, Kbd (shortcut keys), PresenceIndicator (avatars of people viewing or editing)
- Editing: RichTextEditor (mentions, record links, slash commands, tables, checklists, co-editing), SpreadsheetGrid (Excel paste, fill handle, range selection, keyboard editing, NULL-aware cells), FilterBuilder, QuickAdd (natural language parser), ColorPicker (with live contrast check)
- Data: BulkActionBar, DiffViewer (record history and canon changes), ActivityFeedItem, HoverCard (record preview), FilePreviewer (PDF, image, video, Office documents through server conversion), MapView (venues, zones, geofences, incident pins)
- Feedback and help: NotificationCenter, UndoToast, OnboardingChecklist, WhatsNew, FeedbackWidget, ShortcutEditor
- Compass: LiveActivity and widget layouts, ForceUpdateScreen, SyncConflictSheet
- Gateway: OpportunityCard, OpportunityFilters, ApplicationForm, BidSheet (sealed line items), AgencySlate, ProfileEditor with per-field visibility, EPKViewer, AvailabilityCalendar, OnboardingPacket, EngagementTimeline (the nine stages), RatingDialog, PayoutDetailsForm, OrgSwitcher

### 11.5 Claude Design Deliverables

Claude Design produces, in this order:

1. **XOS Design System**: tokens, type, color in both themes, spacing, radius, iconography, and the component inventory with states (default, hover, focus, active, disabled, loading, error), as a Design System artifact. Export the tokens as JSON to `design/tokens.json` for `packages/tokens`.
2. **Atlas screens** at desktop (1440 px), laptop (1280 px) and tablet (1024 px):
   - Sign in and MFA, org onboarding, Home, Project overview with gate readiness, Scope tree
   - Schedule timeline, Records list and board, Record side peek, Budget grid, PO detail with three-way match
   - Advance packet builder, Opportunities pipeline, Crew schedule, Timesheet approval
   - Incident CAD dispatch board, Access Grid, Canon browser, Coordinate matrix report
   - Settings (members and roles, white label, security, billing, data and privacy), Command menu, Empty, error and refusal states
3. **Compass screens** at 390 by 844 pt and 430 by 932 pt, plus a 10 to 11 in tablet:
   - Today, Clock in with geofence states, Kiosk mode, Shift detail and swap
   - Task with checklist and photo, Quick incident, Inspection runner, Scan (asset, receiving, credential)
   - Run of show live, Day sheet, Emergency codes, Radio channels, Offline queue, Profile and certifications
4. **Gateway screens** at desktop and phone widths:
   - Home and Opportunities (browse, detail, saved, alerts)
   - Application, bid sheet and agency slate
   - Applications and offers, including an offer accept, counter and decline flow
   - Onboarding packet
   - Engagement Overview for each of the eight role types
   - Schedule, Documents with signing, Money with invoice submission
   - Messages
   - Profile editor with per-field visibility, public profile and EPK, company account with team
   - Settings with consents and payout details
   - Token advance and signing flows with account claim
5. **Shell experience flows**:
   - Each leadership flow in Sections 11.11 to 11.13 drawn as a step-by-step prototype, with tap or keystroke counts annotated:
     - Clock-in states
     - Continuous scan
     - Three-step incident
     - Gateway Up Next
     - Payment tracker
     - Requirements check
   - Atlas role-default sidebars for each internal persona.
   - The Atlas phone bottom bar, and the Gateway five-destination bar on desktop and phone.
6. **White-label preview**: the same three screens rendered under two sample tenant brands, proving token-only theming.

Each screen ships with:

- Annotated interaction notes and keyboard shortcuts
- Responsive behavior
- Accessibility notes: focus order, landmarks and announcements

Claude Code implements from these exports. Where a screen and this prompt disagree on behavior, this prompt wins and the orchestrator files an ADR.

### 11.6 Page Templates and Layouts

Every page is built from one of these templates. A06 implements them; module agents compose pages from them.

| Template | Layout | Used for |
| --- | --- | --- |
| Collection | Page header with title, view switcher, filter bar and primary action; virtualized body; optional side peek | Every list, board, timeline, calendar and table |
| Record | Title row with key, kind and state; two columns (content and activity on the left, properties on the right at 320 px); related records below | Every record full page and the side peek |
| Split view | Resizable list on the left, record on the right | Inbox, Dispatch board, Advancing submissions, Import review |
| Dashboard | Header with date range and scope picker; 12-column tile grid; tiles resizable in grid units | Home, Reports dashboards, Partner console |
| Settings | Left section list; centered form column at 640 px; sticky save bar when dirty | Org settings, personal settings, project settings |
| Wizard | Stepper across the top, one step per page, back and next, progress saved per step | Onboarding, import, template apply, white-label setup |
| Grid editor | Full-width spreadsheet grid with totals row and pinned columns | Budget, rate cards, access grid |
| Document | Centered reading column at 720 px with outline sidebar | SOPs, documents, legal pages |
| Auth | Centered card at 400 px on brand background | Sign in, MFA, invite acceptance, passkey setup |
| Gateway shell | Top navigation with org brand or platform brand, no sidebar; engagement pages use top tabs; comfortable density, 14 px base text and System theme by default for occasional users | Every Gateway page and the token flows |
| System | Centered message, illustration from the icon set, one primary action | 404, 403 shown as 404, 500, maintenance, offline, archived org |

**Responsive behavior.** Atlas is fully usable from 375 px up:
- Below `lg`, the sidebar becomes a drawer.
- Below `md`, the side peek opens full screen.
- Tables switch to stacked cards with the three most important fields.

### 11.7 Interaction Patterns

- **Undo and redo:**
  - Cmd or Ctrl+Z and Shift+Cmd or Ctrl+Z work over a per-session stack of 50 actions.
  - Destructive actions show an Undo toast for 8 seconds. A soft-deleted record can be restored from the record or from the Activity feed for its retention period.
- **Selection:** click, Cmd or Ctrl+click and Shift+click for ranges; X selects with the keyboard; Cmd or Ctrl+A selects all loaded rows. The bulk action bar shows the count and the actions every selected item allows.
- **Bulk edit:** change one property across a selection, with a preview of how many records each value will change, all in one transaction.
- **Drag and drop:** every drag has a keyboard path. Space picks up, the arrow keys move, Space drops and Escape cancels, with screen reader announcements at each step.
- **Quick add:** typing in any create field parses:
  - date phrases ("Friday 8am")
  - `@person`
  - `#tag`
  - `/kind`
  - `~scope`

  Parsed tokens are shown as chips before saving.
- **Search:**
  - `/` focuses search and Cmd or Ctrl+K opens the command menu.
  - Search supports quoted phrases and these operators:
    - `kind:`, `state:`, `phase:`, `dept:`, `urid:`
    - `owner:`, `project:`, `is:blocked`, `due:<7d`
  - Results group by type. The last 50 records each user viewed appear before they type.
- **Hover cards:** hovering a record key for 400 ms shows its title, state, owner and next date.
- **Context menus:** a right-click or the Shift+F10 key on any record offers the same actions as its menu button.
- **Real-time collaboration:**
  - Live presence avatars appear on records and documents.
  - Lists and records update live.
  - Rich text co-edits merge automatically.
  - When two people change the same property, the later save is checked against the version it started from. A conflict shows both values and lets the person choose; no change is silently lost.
- **Loading:**
  - Streamed server rendering with skeletons per region of the page.
  - Links prefetch on hover and when they enter the viewport.
  - Each page region has its own error boundary with a retry.
  - Route changes use the View Transitions API where the browser supports it.
- **Sessions:**
  - Tokens refresh silently.
  - If a session expires, a sign-in dialog opens over the page and keeps unsaved form input.
  - Sign-out, org switch and theme changes sync across open tabs through BroadcastChannel.
- **Shortcuts:** users can rebind shortcuts in personal settings. The editor blocks conflicts and reserved browser and screen reader keys.
- **First run:**
  - A new org gets an eight-step onboarding checklist: brand, members, first project, jurisdiction, budget, schedule, Compass invite, integration.
  - Each user can open a private Northwind Live sandbox to explore.
  - A guided tour is offered, never forced.
  - The What's New panel reads from the published changelog.
  - The feedback widget sends a message and an optional screenshot to the platform team. It never captures data the user did not approve.

### 11.8 Motion

- Motion only explains: where something came from, where it went, or that something happened. Nothing animates for decoration.
- **Web:**
  - Menus and popovers scale from 0.98 and fade in over `motion.duration.base`.
  - The side peek slides 16 px and fades in over `motion.duration.slow`.
  - Dialogs fade in with a 0.98 scale over `motion.duration.deliberate`.
  - List reordering animates position over `motion.duration.base`.
  - State chips cross-fade over `motion.duration.fast`.
- **Compass:**
  - A shared-element transition takes a card into its detail screen, using `motion.spring.gentle`.
  - Sheets use `motion.spring.default`.
  - Clock in, scan success and scan failure each have a distinct haptic and a 120 ms visual confirmation.
- **Reduced motion:** with `prefers-reduced-motion` on, movement is replaced by an 80 ms opacity fade or no animation. No information depends on motion.
- **Performance:** animate only transform and opacity, never layout properties. Run at 60 fps on the mid-tier test devices.

### 11.9 Generated Document Templates

- Generated documents:
  - purchase order
  - invoice
  - change order
  - day sheet
  - call sheet
  - run of show
  - BEO
  - credential badge
  - inspection report
  - incident report
  - final cost report
  - signed agreement certificate
- Each document has a versioned HTML template using the tenant brand and legal entity.
- Each renders to tagged PDF (PDF/UA), with a reading order, alternative text for logos and real table headers.
- veraPDF validates every template in CI.
- Each prints correctly on US Letter and A4.
- Every document shows its record key, version, generation time and a QR code that opens the record for anyone with access.

### 11.10 Experience Standards for All Three Shells

Atlas, Gateway and Compass share one aesthetic and one set of habits. Someone who learns one should already know the other two. The Linear-style restraint in Section 11.1 stays the visual rule. The interaction model draws on how people under 30 already use software: search first, thumb first, feed first, chat native, gesture fluent and instant.

**Cognitive load budget.** Every screen is checked against these limits. CI enforces the measurable ones (Section 18).

| Rule | Limit |
| --- | --- |
| Primary action per screen | Exactly one, visually distinct; everything else is secondary or in overflow |
| Visible toolbar actions | At most 5; the rest in an overflow menu |
| Primary navigation destinations on phones | At most 5 |
| Navigation depth | Any record reachable within 3 clicks or taps from Home, or 1 search |
| Form fields shown before "More fields" | At most 7; the rest behind progressive disclosure |
| Words in a button label | At most 3 |
| Confirmation dialogs | Only for irreversible actions; everything else uses Undo (Section 11.7) |
| Blocking spinners | None for actions under 1 s; optimistic UI instead |

**Shared habits**
1. **Search first.**
   - Cmd or Ctrl+K on desktop.
   - A search field at the top of every phone Home.
   - Search finds records, people, pages, settings and actions ("approve timesheets", "new incident").
2. **Plain words before codes.** Canon codes (URIDs, phase codes, role codes) always appear next to a plain name, in a monospace chip, never alone.
   - Gates read "Gate 3 · Advance", never "ADV".
   - Disciplines read "Audio · 5000.01".
3. **Context carries forward.** New items inherit the current project, scope node, date and department. A person never retypes what the screen already knows.
4. **Every list row answers "what now".** Rows show state (icon and label), owner, the next date, and the next action as a button that appears on hover or swipe.
5. **One inbox model in every shell.**
   - Items sort into Needs You and For Your Information.
   - Each item can be Done (E), Snoozed (H) or opened.
   - Notifications are actionable where they arrive: approve, accept or reply from the push notification, the email or the Inbox, without opening the record.
   - Notifications batch into digests, respect quiet hours, and are tuned per category.
6. **Gestures with fallbacks.**
   - On touch screens:
     - swipe a row right for its primary action (complete, accept)
     - swipe left for secondary actions (snooze, more)
     - long-press for the context menu
     - pull to refresh, and edge-swipe back
   - Every gesture has a visible button equivalent and a keyboard equivalent.
7. **Sheets over pages on phones.** Create, edit and quick views open as bottom sheets with detents, so the person keeps their place.
8. **Chat native.**
   - Every engagement, project and record has a conversation with attachments, mentions and reactions.
   - Reactions use a small curated set of glyphs from the XOS icon set.
   - The assistant (Section 4.7) is one keystroke or tap away in every shell, and answers inside the same panel.
9. **Instant feedback.** Every action acknowledges within 100 ms, through optimistic state, a subtle motion (Section 11.8) or a haptic on phones.
10. **Teaching empty states.** Every empty state shows one sentence and one button that fills it, for example "No shifts yet. Post a crew call."
11. **Errors say how to fix.** Inline validation runs as the person types. Error copy names the field, the problem and the fix in one sentence.
12. **Passwordless by default.** Passkeys, Sign in with Apple, Google sign-in and magic links. Passwords remain available, but are never the first choice.
13. **Continue on another device.**
    - Any Atlas or Gateway page offers a QR code that opens the same item in Compass.
    - Compass links open the matching Atlas or Gateway page.
    - Universal links work across all three.
14. **Wallet and calendar.**
    - Credentials and shift passes can be added to Apple Wallet and Google Wallet, and work offline.
    - Any dated item can be added to a calendar in one tap.
15. **Personalization within limits.** People can pin, reorder, hide and choose density and theme. They cannot change the layout grammar, so every screen stays recognizable.

### 11.11 Atlas: Leadership Targets by Workflow

| Workflow | What leading looks like | Measured target |
| --- | --- | --- |
| Projects and gates | Gate readiness is one screen. Blocking criteria are a checklist, each with the action that clears it. The next gate button activates the moment the last blocker clears. A new project starts from the Production Template in one step. | New project from template in under 60 s; gate readiness loads in under 500 ms |
| Work and records | Create with C anywhere; properties set inline from the keyboard; triage view for new records; bulk edit; sub-records | Create and fully classify a record in under 10 s, keyboard only |
| Schedule | Drag on the timeline, with a preview of how dependent records shift before release. Critical path highlighted. People booked twice flagged in place. | Reschedule with dependency preview in under 3 interactions |
| Show | Show mode: full screen, large type, dark, cues advanced with the Space bar, in sync with Compass in real time | Cue sync to every connected device in under 500 ms |
| Advancing | A recipient-by-section heatmap of packet progress, automatic reminders, and a side-by-side reconciliation diff | Every outstanding item visible on one screen |
| Crew | Drag people from an availability-ranked list onto shifts. A live fill-rate meter. Fill suggestions from pools. Overtime and double-booking warnings before assignment, not after. | Staff a 50-position call in under 10 minutes |
| Finance | Spreadsheet speed in the budget grid, variance highlighting, approvals from Inbox with A (approve) and R (reject with reason), one-click Universal Posting Line export | Approve a queue of 20 items in under 60 s |
| Procurement | Bid leveling side by side with normalized units and unpriced lines flagged; award creates the PO in one step | Award to PO in 1 action |
| Safety | Dispatch board with live map and queue, severity shown by icon and color, assign with one key | New incident visible to dispatch in under 2 s |
| Reports | Every figure drills through to the records behind it | Any number to its records in 1 click |
| Settings | Settings are searchable from the command menu; every change shows who made it and when | Any setting reached in 1 search |

### 11.12 Gateway: Leadership Targets by Workflow

Gateway is built for people who may use it once a month and decide in seconds whether to trust it. It is phone first, then desktop.

| Workflow | What leading looks like | Measured target |
| --- | --- | --- |
| Discover | Opportunity cards lead with role, pay, date and place in one line. A requirements check shows a green mark when the person qualifies, or exactly what is missing. Filter chips, map view, saved searches, alerts. On phones, swipe right to save and left to pass, with buttons for both. | First relevant opportunity in under 10 s from Home |
| Apply | One-tap apply with the saved profile. No resumes. Artists send an EPK, vendors bid in a grid, agencies pick staff from their roster. Drafts save automatically. | Apply in 3 taps or fewer with a complete profile |
| Onboard | A checklist with a progress bar and a time estimate per item. Verified documents already on file check themselves off. Camera capture with automatic cropping and edge detection for documents. | Median onboarding packet completed in under 10 minutes |
| Work | The Up Next card shows countdown, address, call time, parking, contacts and what to bring. One tap adds it to the calendar or wallet. | Every engagement detail reachable from Home in 1 tap |
| Get paid | A payment tracker in the style of package tracking: Submitted, Approved, Scheduled, Paid, with dates. Invoices generate from approved timesheets. Earnings overview. Tax documents in one place. | Submit an invoice in under 60 s |
| Reputation | A portfolio-style profile with a media grid and highlights. Verified badges for checked certifications and completed engagements. A profile strength meter that names the next improvement. A shareable public link with a social preview image. | Profile completed to 100 percent in under 15 minutes |
| Communicate | Threads per engagement, with attachments, reactions and optional read receipts | Reply from the push notification without opening the app |

**Trust signals**
- The org's verified identity and brand are always visible.
- Pay is shown before a person applies.
- The person can see exactly what they share before applying, and every sharing consent is reversible in Settings.

### 11.13 Compass: Leadership Targets by Workflow

Compass is used standing up, moving, in sun or darkness, with gloves on and one hand free. Every core flow is designed for the thumb.

| Workflow | What leading looks like | Measured target |
| --- | --- | --- |
| Clock | The Today screen leads with one button that changes with the person's state: Clock In, On Shift (with a timer), Break, Clock Out. Geofence status shows before the tap ("You're at the venue"). The Live Activity has Break and Clock Out buttons. An App Shortcut supports Siri, the iPhone Action Button and Android quick tiles. | Clock in with 1 tap in under 2 s from unlock |
| Tasks | Swipe right to complete, left to snooze or reassign. Photo proof is captured inline when the task requires it. | Complete a task with photo in under 10 s |
| Scan | Opens from the center tab, the app icon's long-press menu, a widget or an App Shortcut. Continuous mode for bulk receiving, with a running count and a haptic per scan, then a batch review. | 30 items received in under 60 s |
| Incidents | A three-step report: choose the type from a grid, confirm the location (filled automatically), add photos or a voice note (transcribed). Critical incidents use hold to confirm. | Report filed in under 30 s, including offline |
| Inspections | One item per card. Large Pass and Fail buttons. A Fail asks for a photo and a note. | Average under 5 s per item |
| Show | Show mode: large type, dark, screen kept awake, a haptic before each cue | Next cue readable from arm's length |
| Supervisor | Crew board showing who is on site through the geofence, with late arrivals flagged. One tap to call or message. Bulk timesheet approval with swipe. | Approve a crew's timesheets in under 60 s |
| Credentials | The badge as a wallet pass and an offline QR code, with brightness raised while it is shown | Badge shown in 1 tap from the lock screen |

**Field conditions**
- Low-data mode and a battery saver mode.
- Every action works offline, with the queue visible.
- Text stays legible at 200 percent font scale without breaking layouts.

### 11.14 Validation of the Experience

**Automated** (CI, Section 18):
- Navigation depth is computed from both sitemaps.
- Tap and keystroke counts are asserted in the Playwright and Maestro journeys against the targets in Sections 11.11 to 11.13.
- The cognitive load budget is linted, covering primary actions per screen, toolbar action count and visible form fields.
- Timing targets run against staging under the load targets in Section 5.1.

**With people** (release candidate, owner approval required under Section 19.8, because it involves recruiting real participants):
- Tree testing of each sitemap, with a target of at least 80 percent task success.
- First-click tests on each Home.
- Five-person moderated rounds per persona, including participants aged 18 to 27 for Gateway and Compass.
- A System Usability Scale score of at least 80 for each shell.

Findings become issues for the owning agents.

**In production:**
- Consent-gated product analytics track the funnel for each workflow in Sections 11.11 to 11.13 against its target.
- Regressions alert the owning team.

### 11.15 View System

Every collection in every shell is shown through one view system, defined in `packages/schemas/views.yaml`.

- The registry declares each view type.
- The registry also lists the conditions a data set must meet for that view.
- Each entity's fields are then checked against those conditions.
- The view switcher offers only the views that make sense for the data on screen.

| View | Offered when the data has | Atlas | Gateway | Compass |
| --- | --- | --- | --- | --- |
| List | Always | Yes | Yes | Yes (default) |
| Table | Always | Yes (default for finance, procurement, people) | Yes (Money) | No |
| Spreadsheet grid | Editable numeric or money columns | Yes (budget, rate cards, access grid) | Vendor bid sheet | No |
| Gallery (cards) | An image, media or a profile | Yes | Yes (Explore, profiles) | Yes |
| Board (kanban) | A state, stage or other single-choice field | Yes | Yes (Applications) | Compact |
| Calendar (day, week, month, agenda) | A date or date range | Yes | Yes (Work, Upcoming) | Agenda and day |
| Resource schedule | A date range and an assignee | Yes (crew, assets, spaces) | No | Supervisor only |
| Timeline (Gantt) | Start, end and dependencies | Yes | Read-only for clients | No |
| Map | A location or geometry | Yes | Yes (Explore, venues) | Yes |
| Site plan | Pins on a venue drawing | Yes | Read-only where shared | Yes |
| Tree | A parent relationship | Yes (scope tree, positions) | No | No |
| Matrix (pivot) | Two categorical dimensions | Yes (coordinate matrix, access grid, budget by account and cost center) | No | No |
| Org chart | Reporting lines | Yes (positions) | No | No |
| Chart and dashboard | Measures over dimensions | Yes | Yes (Money overview) | Yes (summary cards) |
| Feed | Time-ordered activity or posts | Yes | Yes (Home) | Yes |
| Inbox | Items that need the person | Yes | Yes (Home) | Yes |
| Split view | A list with a detail | Yes | Yes (Messages) | Tablet only |
| Document | Rich text | Yes | Yes (shared) | Read |
| Form | Create or edit | Yes | Yes | Yes |
| Side peek or drawer | A record opened from a list | Yes | Yes | Bottom sheet instead |
| Wizard | A multi-step create | Yes | Yes | Yes |

**Context awareness**
- Each entity has a default view per shell and per device class. Defaults are set in the registry, for example:
  - shifts default to resource schedule in Atlas and to agenda in Compass
  - incidents default to map and queue for dispatch and to list elsewhere
  - opportunities default to cards in Gateway
  - budget lines default to the spreadsheet grid
- Every view keeps the same filter, sort, group and search state when the person switches view type, so they never lose their place.
- Views are saved per person and shared per team or org. A shared view respects each viewer's own permissions.
- Grouping, sub-grouping, totals and NULL-aware aggregates work identically in every view that shows them.
- Every view has a keyboard path, an accessible table alternative for any visual layout (map, matrix, Gantt, chart), and an empty state.
- A view type that does not fit the data never appears. A switcher never shows a disabled option.

### 11.16 Tooltips, Help and Support

**Tooltips**
- Every icon-only control has a tooltip with its label and keyboard shortcut. It appears after a 500 ms hover or on keyboard focus, and on long-press on touch screens.
- Tooltips never hold information that exists nowhere else, and never contain interactive content. Anything longer than one sentence goes in a popover with a "Learn more" link.
- Canon terms (phase names, gates, record kinds, URIDs, assertion ranks, provenance, refusal values) show their Bible definition in a hover card, from the canon tables. This is the in-product glossary.
- Every form field can carry help text under it. Fields with legal or financial meaning always do.

**Help**
- A Help button (and the `?` key) in every shell opens a contextual help panel. It contains:
  - the articles for the current page, mapped by route in the help content
  - the shortcut sheet
  - What's New
  - the assistant, if the org has turned it on
  - Contact Support
- The help center lives in `apps/docs` and is searchable from the command menu. It has:
  - getting-started guides per persona
  - one article per page and per workflow
  - the XOS glossary
  - API docs
  - the accessibility statement and the status page
- Guided tours are available per persona and per module. They are offered once, can be replayed from Help, and are never forced.
- Contextual tips appear the first time a person meets a complex feature, such as gates, the spreadsheet grid or the Access Grid. Each is dismissible and shown once.

**Support**
- **Internal support:** people contact their own org's admins through Help, Contact Support, which creates a help desk request (Section 4.9).
- **Platform support:** org Admins contact the platform team. Channels by plan:

| Plan | Channels | First response target |
| --- | --- | --- |
| Access | Help center and community forum | Best effort |
| Core | Email | 2 business days |
| Pro | Email and in-app chat | 1 business day |
| Team | Email and in-app chat, priority queue | 8 business hours |
| Enterprise | Dedicated channel, named contact, phone for severity 1 incidents | 1 hour for severity 1 |

- Every support ticket can attach diagnostics, with consent: route, app version, device, recent errors and a screenshot.
- Support never sees tenant data without a support session (Section 8).
- External users contact the org that engaged them through Messages. They contact platform support only about their own account.

---

## 12. White Label

**Branding**
- The brand is scoped per org and applied on Atlas, Gateway, emails, PDFs, the documentation site (Enterprise) and Compass.
- Brand settings:
  - Name, logo (light and dark), favicon and app icon
  - Accent color, and optionally neutral tint, font family (from an approved list of open-licensed fonts) and corner radius scale
  - Email sender name, support email and legal entity name
- Every override is token-based. The theme editor previews live and blocks any combination that fails WCAG 2.2 AA contrast.

**Domains**
- Custom domains for Atlas and Gateway are added through the Vercel Domains API, with DNS verification and automatic TLS.
- Custom email sending domains use SPF, DKIM and DMARC verification through Resend.

**Mobile**
- Standard Compass applies the tenant brand at runtime after sign-in.
- The Enterprise plan adds a dedicated branded build through EAS build profiles generated per tenant: bundle identifier, app name, icon, splash and store listing metadata.

**Other surfaces**
- Every generated document (POs, invoices, change orders, day sheets, call sheets, final cost report) uses tenant branding and the tenant legal entity.
- The tenant may suppress "Powered by XOS" on the Pro plan and above.
- White-label settings outlive no plan: downgrading below the entitled plan reverts to default branding at the next billing cycle, with notice.

---

## 13. Compass Engineering Requirements

**Offline**
- PowerSync sync rules stream only the records the user's memberships and assignments allow. Sync rules are tested against the same scope rules as RLS.
- These are fully available offline:
  - Today, shifts, tasks, checklists, inspections, incident report, day sheet, run of show (read)
  - Emergency codes, radio channels, venue maps and SOPs
- Writes queue locally with idempotency keys, upload in order, and show a visible queue count. Conflicts surface in a resolution sheet.

**Clock**
- Location sampling follows a battery budget.
- Geofence evaluation runs on device and is re-verified on the server.
- Offline punches carry device time, monotonic clock offset and GPS fix quality. The server accepts them with a skew tolerance and flags the rest.

**Kiosk mode**
- Kiosk mode runs on supervised devices in single-app mode, with worker PIN punch and photo capture on punch when the org enables it.

**Scanning**
- Supported formats: EAN-13, UPC-A, GTIN-14 (ITF-14 and GS1-128), Code 128, QR and Data Matrix, plus NFC NDEF.
- GTIN checksum validation runs on device.
- An unknown code goes to the intake queue for human resolution. It is never auto-mapped.

**Media**
- Photos are compressed to 2048 px long edge, with EXIF location retained only if the org enables it and stripped otherwise.
- Upload is resumable.

**Device security**
- Biometric unlock, and encrypted SQLite (SQLCipher).
- Remote sign-out from Atlas wipes the local store.

**Distribution**
- iOS (latest two major versions) and Android (API level per current Play requirements).
- Phone and tablet layouts.
- Releases go through TestFlight and Play internal testing, then production through EAS Submit. Over-the-air updates via EAS Update apply only to JavaScript changes and follow staged rollout.

**Platform features**
- iOS Live Activities show the running shift timer and the next cue on the lock screen and Dynamic Island. Android shows the same as an ongoing notification.
- Home screen widgets (iOS and Android) show today's shift and the next task.
- Account deletion is available inside the app (Section 14.6).
- A forced minimum version is supported (Section 5.1).

---

## 14. Compliance

Every row below produces artifacts in `legal/` or tests in CI.

Legal documents are drafted in full, in plain American English, tailored to XOS, and marked for review by counsel before launch. They are complete drafts, not outlines.

### 14.1 Accessibility

| Standard | Requirement |
| --- | --- |
| WCAG 2.2 Level AA | All Atlas, Gateway, docs, email and Compass screens. Automated axe-core checks in unit, Storybook and Playwright tests; manual keyboard and screen reader passes (VoiceOver macOS and iOS, NVDA, TalkBack) on every screen in Section 11.5, logged in `legal/accessibility/audit-log.md` |
| Section 508 (US) | Covered by WCAG 2.2 AA conformance |
| ADA Title II and Title III (US) | WCAG 2.2 AA supports public-sector and public-accommodation customers |
| EN 301 549 and the European Accessibility Act | Conformance for EU customers |
| Accessibility for Ontarians with Disabilities Act and Accessible Canada Act | Conformance statement for Canadian customers |
| Mobile | Dynamic Type and font scaling to 200 percent, VoiceOver and TalkBack labels, 48 pt touch targets, no information by color alone, reduced motion, haptics optional |
| Deliverables | Accessibility Conformance Report (VPAT 2.5 International edition) for Atlas and for Compass; public Accessibility Statement with feedback channel and response commitment of 5 business days |

### 14.2 Security Frameworks

| Framework | Requirement |
| --- | --- |
| SOC 2 Type II readiness (Security, Availability, Confidentiality, Privacy) | Control matrix in `legal/security/soc2-controls.md`, evidence automation hooks, policies listed below |
| ISO/IEC 27001:2022 and ISO/IEC 27701 | Statement of Applicability draft |
| OWASP ASVS 5.0 Level 2 | Control matrix with test references |
| NIST SP 800-63B | Authentication strength and recovery |
| PCI DSS v4.0.1 | SAQ A scope only: card data never touches XOS; Stripe-hosted checkout and portal |

Policies to draft: Information Security, Access Control, Encryption, Vendor Management, Incident Response, Business Continuity and Disaster Recovery, Secure Development, Data Classification, Acceptable Use, Change Management.

### 14.3 Privacy and Data Protection

| Regime | Implementation |
| --- | --- |
| GDPR and UK GDPR | Lawful basis registry per processing activity; Data Processing Agreement with 2021 EU Standard Contractual Clauses and the UK Addendum; records of processing; data subject rights (access, rectification, erasure, restriction, portability, objection) through DSAR workflow with 30-day clock; Data Protection Impact Assessment template; EU-US Data Privacy Framework posture documented |
| CCPA and CPRA (California) | Notice at collection, "Do Not Sell or Share" handling, Global Privacy Control honored, sensitive personal information limits, service provider terms |
| Other US state privacy laws (Colorado, Connecticut, Virginia, Utah, Texas, Oregon, Montana, Florida Digital Bill of Rights and later enactments) | One rights workflow configured per state requirements, with universal opt-out signals honored |
| PIPEDA and Quebec Law 25 (Canada) | Consent, privacy officer designation, privacy impact assessment for cross-border transfer |
| LGPD (Brazil), Australia Privacy Act, Japan APPI | Rights workflow and transfer documentation |
| ePrivacy and cookies | Consent banner with prior blocking of non-essential cookies, granular categories, consent log; the decision is stored server-side, not only in the browser |
| Children | Accounts require age 16 or older; no services directed to children; COPPA statement |
| Employment and HR data | Worker data minimization; tax and government identifiers encrypted at field level; payroll records retained per jurisdiction (US default 7 years) |
| Health information at events | Medical encounter records restricted to a Medical capability, encrypted at field level, excluded from exports and AI features by default, with HIPAA-aligned safeguards documented |
| Data residency | US region default; EU region option on the Enterprise plan with all tenant data and backups held in the EU |
| India DPDP Act 2023 | Notice and consent in plain language, consent records, grievance officer contact, breach notification workflow |
| Switzerland nFADP | Records of processing, transfer documentation, rights workflow |
| Singapore PDPA, South Africa POPIA, South Korea PIPA | Rights workflow, consent records, transfer documentation and breach notification per regime |
| Retention | Per-table retention policies with automated purge; legal hold flag suspends purge |

### 14.4 Commercial and Legal Documents

All are drafted in `legal/` and published at `/legal` with version history and an acceptance log:

1. Terms of Service (subscription agreement for organizations)
2. Privacy Policy
3. Cookie Policy
4. Data Processing Agreement with Standard Contractual Clauses
5. Subprocessor List with change notification subscription
6. Acceptable Use Policy
7. Service Level Agreement (99.9 percent monthly uptime target, service credits)
8. Security Overview page
9. Accessibility Statement
10. Mobile End User License Agreement (with Apple and Google required terms)
11. Copyright and DMCA Policy
12. Trademark Policy
13. Open Source Licenses page (generated from the SBOM)
14. Responsible Disclosure Policy and security.txt
15. Data Retention and Deletion Policy
16. AI Features Notice: what data AI features use, opt-out, no training on customer data, and EU AI Act transparency obligations for AI-generated content
17. Worker Terms for crew accounts invited by a tenant (the tenant is the controller; XOS is the processor)

**Acceptance flow**
- Org Owners accept the Terms of Service and DPA at signup.
- A material change triggers in-app re-acceptance with a 30-day notice.
- Each acceptance stores the document version, timestamp, IP and user.

### 14.5 Transactions, Signatures and Communications

| Area | Requirement |
| --- | --- |
| Electronic signatures | ESIGN Act and UETA (US), eIDAS simple electronic signature (EU): consent to electronic records, intent capture, signer identity, tamper-evident audit certificate attached to the signed PDF |
| Email | CAN-SPAM and CASL: unsubscribe for non-transactional email, physical address, sender identification |
| SMS | TCPA and 10DLC: express consent capture, STOP and HELP handling, quiet hours by recipient time zone |
| Tax | Stripe Tax for subscription sales tax and VAT; tenant tax jurisdictions and rates for tenant invoices |
| Labor | Overtime rules configurable by jurisdiction (federal FLSA default, state overrides including California daily overtime); union local rates; prevailing wage determinations; certified payroll export (US Department of Labor WH-347 format) |
| Workplace safety | Incident data supports OSHA Forms 300, 300A and 301 export for US tenants |
| Accounting | Period close controls and an immutable ledger support audit; UPL export documents mappings |
| Export controls and sanctions | Signup screening against restricted jurisdictions; Terms of Service clause |

### 14.6 App Stores and Accessible Documents

- **Apple App Store:**
  - Account deletion inside the app, as App Store Review Guideline 5.1.1(v) requires.
  - Accurate privacy nutrition labels.
  - No tracking, so no App Tracking Transparency prompt.
  - Sign in with Apple wherever another third-party sign-in is offered.
- **Google Play:**
  - A completed Data safety form.
  - An account deletion link reachable from outside the app.
  - The current target API level.
- **Documents and email:**
  - Generated PDFs meet PDF/UA (Section 11.9).
  - Email templates use semantic HTML with alternative text, readable at 200 percent zoom, with a plain-text part.

### 14.7 Account Lifecycle

- **Trial:** 14 days with Pro features, no card required. At the end of the trial the org moves to the Access plan; no data is deleted.
- **Cancellation:**
  - The org becomes read-only for 30 days.
  - A full export is available for that period: JSON and CSV for all records, original files, and generated PDFs, in one archive with a manifest.
  - At day 90, data is deleted, backups age out on their schedule, and the Owner receives a deletion certificate.
- **Ownership transfer:** the new Owner must accept and pass MFA. The old Owner becomes an Admin unless removed.
- **Org deletion** requires the Owner, step-up authentication and typing the org name. A 7-day recovery window applies.

### 14.8 EU Data Act

- Customers can switch to another provider:
  - export all exportable data and metadata in structured, documented formats
  - receive 30 days of transition support
  - no switching charges once the Data Act's charge prohibition applies from 12 January 2027
- The export format and switching process are documented on the docs site.

### 14.9 Marketplace and Workforce

| Area | Requirement |
| --- | --- |
| Equal opportunity | Applications never ask for protected attributes. Where an org runs equal employment reporting, the questions are optional, voluntary, stored apart from the application and never shown to selectors. |
| Pay transparency | Jurisdiction rule table blocks publishing without a required pay range (Section 4.4.3). |
| Background checks | FCRA disclosure and authorization, pre-adverse and adverse action notices through the provider, and state and local fair-chance rules per jurisdiction. |
| Worker classification | A classification questionnaire per jurisdiction (including the California ABC test) records the org's own decision and its basis. XOS never makes the classification or gives legal advice. |
| Tax documents | W-9, W-8BEN and W-8BEN-E collection, TIN format validation, 1099-NEC data export, foreign performer withholding flags. |
| Employment eligibility | Right-to-work and I-9 checks stay with the org or its payroll provider. Gateway links to them and stores only completion state. |
| Marketplace transparency | Public ranking factors (EU Platform-to-Business Regulation), notice-and-action and statements of reasons for removed listings (EU Digital Services Act). |
| Reviews | Ratings only from completed engagements, no paid or incentivized ratings, and no suppression of negative ratings, in line with the FTC rule on consumer reviews. |
| Minors | Opportunities can require a minimum age. Accounts require age 16 or older (Section 14.3). |
| Payments | XOS never holds funds. Payouts run on the org's rails or through Stripe Connect, so XOS never acts as a money transmitter. |

---

## 15. Internationalization

- American English is the default and the source locale. Ship en-US and es-US at launch; the pipeline supports any locale.
- No hard-coded strings in components. A CI lint fails on string literals in JSX outside test files.
- Formatting of dates, numbers, currency and units uses Intl with the user's locale. The unit system follows the project jurisdiction (imperial for US, metric otherwise) with per-user override.
- Layout supports right-to-left through logical CSS properties. RTL visual regression runs in CI for the core screens.
- Canon labels are translatable through `xpms.dim_locale` and translation tables. Codes are never translated.

**Languages**
- Launch with en-US and es-US fully reviewed.
- Ship fr-FR, de-DE, it-IT, pt-BR and ja-JP marked Beta in the language picker. They become general once a native reviewer signs off, which is recorded in `packages/i18n/REVIEW.md`.
- CI renders every screen in two pseudo-locales:
  - en-XA: accented, 40 percent longer
  - ar-XB: right-to-left

  Any hard-coded or truncated string fails the build.

**Currencies**
- Each org has a base currency. Each project has a project currency. Each budget line, expense, PO and invoice carries its own currency.
- Conversions use European Central Bank daily reference rates stored with their date. Every converted figure shows its rate date.
- NULL amounts are never converted and stay unpriced.

**Formats**
- **Names:** one full name, optional given and family names, and a preferred name. The platform never assumes a first-last order.
- **Addresses:** use per-country formats and validation from Google address metadata.
- **Phone numbers:** stored in E.164 and displayed in national format.
- **Week start and number formats:** follow the user's locale.
- **Time zones:**
  - Schedule times display in the venue's time zone by default, always labeled with the zone abbreviation.
  - A toggle switches to the viewer's own zone.

---

## 16. Plans and Billing

| Plan | Audience | Gates |
| --- | --- | --- |
| Access | Free, single producer | 1 seat, 2 active projects, Compass for 10 crew, community support |
| Core | Small teams | Unlimited projects, approvals, advancing, procurement, UPL export |
| Pro | Production companies | White label (no XOS mark), custom domain, automations, API keys, webhooks |
| Team | Multi-department operators | Custom roles, IP allow-list, audit export, payroll export, priority support |
| Enterprise | Agencies and venue groups | SAML SSO, SCIM, EU data residency, dedicated branded Compass build, SLA credits, support session controls |

- Seats are counted per active internal membership above Field. Field members are metered separately.
- External users are free and never count as seats.
- Orgs are limited by active external engagements per month: Access 25, Core 250, Pro 2,500, Team and Enterprise unlimited.
- Public marketplace listings require the Pro plan or above.
- Usage events feed Stripe metered billing where applicable.
- Plan limits are enforced in SQL through `private.org_plan_limits`.
- Downgrades never delete data. They make over-limit objects read-only with a clear explanation.

**Billing operations**
- Monthly and annual terms, with an annual discount set in the price book.
- Price books in USD, EUR, GBP, CAD and AUD.
- Seat changes prorate to the day.
- **Dunning:**
  - Smart retries, with emails on days 0, 3, 7 and 14.
  - The org becomes read-only on day 21, with a banner to every Owner and Admin.
  - Data is never deleted for non-payment inside the cancellation timeline of Section 14.7.
- **Tax:** VAT and GST identifiers are validated through Stripe Tax, and reverse charge applies where valid.
- **Enterprise invoicing:** net-30 terms, purchase order numbers on invoices, and bank transfer payment.
- **Partner wholesale billing:** follows Section 4.6.1.

---

## 17. Integrations

Integrations are built behind one integration framework (credentials in Vault, external ID map, sync runs, retry and error states):

| Category | Integrations |
| --- | --- |
| Accounting | Xero, QuickBooks Online, NetSuite, Ramp (UPL projection and payment sync) |
| Calendar | Google Calendar, Microsoft 365 (two-way for Meeting, Event and Shift records) |
| Storage | Google Drive, Microsoft OneDrive and SharePoint, Dropbox (document links and import) |
| Communication | Slack and Microsoft Teams (notifications, record unfurls, slash commands) |
| Payroll handoff | Gusto, ADP (payroll export), Rippling |
| Identity | SAML 2.0 and OIDC SSO, SCIM 2.0 |
| Automation | Zapier and Make apps built on the public API and webhooks |
| Shipping | Carrier tracking for UPS, FedEx and DHL on shipments |
| Ticketing data | CSV and API import for attendance used by gate 8 measurement |

---

## 18. Quality Gates

Every pull request must pass these checks in CI. A failed check blocks merge.

**Static checks**
1. Typecheck, lint and format across the monorepo.
2. Placeholder guard: the build fails on `TODO`, `FIXME`, `XXX`, `lorem`, `ipsum`, `placeholder` (except as a form attribute), `mock` in production paths, and em dash characters in source, seed and copy.

**Tests**

3. Unit tests (Vitest) for every package, with 85 percent line coverage minimum on `packages/schemas`, `packages/data` and `packages/api`.
4. pgTAP suites covering:
   - RLS for every table: same-tenant allow, cross-tenant deny, anon deny, and role band boundaries
   - Every invariant in Section 7.5
   - Every state machine transition, allowed and refused
5. API contract tests: every operation in the OpenAPI document is exercised, and responses validate against the schema.
6. End-to-end tests (Playwright) for the 25 critical journeys in Section 20.2 in Chromium, Firefox and WebKit, plus mobile web viewports.
7. Compass end-to-end tests (Maestro) on iOS and Android for the field journeys, including airplane-mode offline runs and queue drain.

**Accessibility and visuals**

8. Accessibility: axe-core with zero violations at serious or critical, on Storybook and every Playwright page. Keyboard-only journey tests for the command menu, tables and dialogs.
9. Visual regression on components and core screens in dark, light and RTL.

**Performance**

10. Performance budgets enforced with Lighthouse CI and Web Vitals:

| Metric | Budget |
| --- | --- |
| Largest Contentful Paint | under 2.5 s |
| Interaction to Next Paint | under 200 ms |
| Cumulative Layout Shift | under 0.1 |
| Route JavaScript | under 200 KB gzip |

**Security and documentation**

11. Security: CodeQL, Semgrep, dependency audit, secret scan, license check, and Supabase database advisors with zero errors.
12. Migrations: apply cleanly from empty, are reversible where possible, and the generated types are up to date.
13. Documentation: the OpenAPI document builds, and every public operation has a description and example.

**Canon and information architecture**

14. Playbook integrity:
    - Every Playbook column has a disposition in the column map.
    - Every `field` target exists in the schema and the OpenAPI document.
    - The round-trip test reproduces every sheet with zero differences from the source manifest.
15. Information architecture:
    - Every node in `sitemap.yaml` has a route that renders.
    - Every route belongs to a sitemap node.
    - The role visibility tests pass for every cell in Section 4.5.9.

**Added in 1.3**

16. Pseudo-locale rendering (en-XA, ar-XB) with no hard-coded or truncated strings.
17. RLS benchmark: policy-filtered list queries under 50 ms at p95 on 1,000,000 rows.
18. pgTAP coverage for every spend authority, separation of duties and field masking rule.
19. veraPDF passes for every generated document template.
20. API breaking-change check (oasdiff) against the last released OpenAPI document.
21. AI evaluation thresholds met for every enabled AI feature.
22. Reduced-motion snapshot tests on web, and motion-free Maestro runs on Compass.
23. Gateway information architecture: every node in `apps/gateway/ia/sitemap.yaml` renders, every Gateway route belongs to a node, and the engagement tab visibility tests pass for all eight role types.
24. External access: pgTAP passes for every policy in Section 8.7, and an automated crawl as each external role type finds no internal-only column in any API response.
25. Navigation depth: no sitemap node in Atlas or Gateway is deeper than 3 from Home.
26. Interaction budgets: every journey tagged with a target in Sections 11.11 to 11.13 meets its tap, keystroke and timing target in Playwright or Maestro.
27. Cognitive load lint: no screen has more than one primary action, more than 5 visible toolbar actions, or more than 7 form fields before "More fields".
28. Single source of truth: every generated artifact in Section 3.15 regenerates with no difference, and the schema and source lints in Section 3.15 pass.
29. Normalization review: an independent agent (A22) reviews every migration for Third Normal Form and files a finding for any violation not in the denormalization register.
30. View registry: every collection renders every view its data qualifies for in each shell, no unqualified view appears in any switcher, and switching views preserves filters, sort, grouping and search.
31. Tooltips and help: every icon-only control has a tooltip with its label, every route maps to at least one help article, and every canon chip shows its definition.
32. Settings registry: every setting in `settings.yaml` has a page, an API field, a default and an audit label, and scope precedence and locks are tested.
33. Identity: pgTAP covers people holding several memberships, engagements and roles at once, the union of capabilities, separation of duties per person, and profile visibility at Public, Network and Private for every section.

---

## 19. Agent Protocol

### 19.1 Topology

The orchestrator (Claude Code, lead session) owns the plan, contracts, sequencing, merges and final verification. It spawns specialist agents. Each specialist works in its own git worktree and branch, owns a declared set of paths, and returns a completion report.

| Agent | Tool | Owns |
| --- | --- | --- |
| A01 Canon | Claude Code | `canon/`, `supabase/migrations/0100-0199`, `xpms` schema, canon seed, canon pgTAP, Playbook import (manifest, column map, Standard Library, Production Template, round-trip test) |
| A02 Platform Data | Claude Code | `supabase/migrations/0200-0299`: tenancy, identity, access, `private` helpers, platform RLS and pgTAP |
| A03 Domain Data | Claude Code | `supabase/migrations/0300-0499`: record spine and all domain tables, invariants and pgTAP |
| A04 API Contract | Claude Code | `packages/schemas`, `packages/api`, OpenAPI document, contract tests |
| A05 Design System | Claude Design, then Claude Code | `design/`, `packages/tokens`, `packages/ui`, `packages/ui-native`, `packages/icons`, Storybook |
| A06 Atlas Shell | Claude Code | `apps/atlas` layout, `apps/atlas/ia/sitemap.yaml` and everything generated from it (sidebar, breadcrumbs, routes, route guards, command menu index), auth screens, settings, white label |
| A07 to A16 Module agents | Claude Code | One per module group in `apps/atlas/app/(modules)/*` (assignments in Section 19.3) |
| A17 Compass | Claude Code | `apps/compass`, `apps/compass/ia/sitemap.yaml`, `packages/sync` |
| A18 Platform Services | Claude Code | Billing, notifications, email, SMS, push, jobs, imports and exports, import wizard, custom objects, report builder, warehouse delivery, calendar feeds, email in, search, Edge Functions, `supabase/migrations/0500-0599` |
| A19 Integrations | Claude Code | Integration framework and connectors, `supabase/migrations/0600-0649` |
| A20 SDK and Docs | Claude Code | `packages/sdk-ts`, Python SDK, CLI, MCP server, `apps/docs` |
| A21 Compliance and Legal | Claude Code | `legal/`, consent and DSAR flows (with A18), ACR drafts |
| A22 Security Review | Claude Code, independent | Read-only reviewer: threat model, RLS attack suite, ASVS matrix verification; files findings, never fixes its own findings |
| A23 Accessibility Review | Claude Code, independent | Read-only reviewer: manual and automated audit across Atlas and Compass |
| A24 QA and Performance | Claude Code | Playwright and Maestro journeys, Lighthouse CI, load tests (k6) to the targets in Section 5.1 |
| A25 AI Features | Claude Code | `packages/ai`, assistant panels in Atlas and Compass, extraction, drafting, evals, `supabase/migrations/0650-0699` |
| A27 Gateway | Claude Code | `apps/gateway`, `apps/gateway/ia/sitemap.yaml`, every Gateway page in Section 4.5.8, token flows and account claim, external Compass views (with A17) |
| A29 Workforce Suite | Claude Code | Section 4.9 in Atlas and Compass: feed, groups, chat, directory, events, forms builder, training, handbook, polls, surveys, recognition, help desk, occupancy, weather, guest check-in, lost and found, `supabase/migrations/0800-0849` |
| A30 Identity, Profiles and Settings | Claude Code | Sections 4.8 and 4.5.6: identity model, joins and offboarding, profile pages and visibility, verification, the settings registry and every settings page across the three shells, `supabase/migrations/0850-0899` |
| A31 Views, Help and Support | Claude Code | Sections 11.15 and 11.16: the view registry and all view components with A05, tooltips, contextual help panel, tours, tips, the help center with A20, support tickets and diagnostics |
| A28 Engagements and Marketplace | Claude Code | External identity, accounts, representation, opportunities, applications, bids, engagements, onboarding, pools, ratings, the Atlas Opportunities module, `api_external` views, Section 8.7 policies, `supabase/migrations/0700-0799` |
| A26 Reliability | Claude Code | `infra/`, observability, status page, synthetic checks, progressive delivery, partition jobs (with A02 and A03), backup and restore drills |

### 19.2 Waves

**Wave 0: Foundation (orchestrator, sequential)**
- Scaffold the monorepo, CI, config packages, ADR 0001 (stack versions), ADR 0002 (schema conventions), ADR 0003 (API conventions) and ADR 0004 (migration ranges and ownership).
- Exit criteria: an empty app builds, deploys to preview and passes CI.

**Wave 1: Contracts (parallel: A01, A02, A04, A05 in Claude Design, A21)**
- A01 imports canon with all counts validated, and imports the Playbook under Section 2.1 with the manifest, a complete column map and a passing round-trip test.
- A06 writes `apps/atlas/ia/sitemap.yaml` from Section 4.5, and A27 writes `apps/gateway/ia/sitemap.yaml` from Section 4.5.8. Both are part of the contract freeze.
- A02 delivers tenancy and auth with RLS helpers.
- A04 publishes OpenAPI v1 draft covering every resource in Section 4.2.
- A05 delivers the design system and token export.
- A21 delivers legal drafts and the compliance matrix.
- Exit criteria: the orchestrator freezes the contract set (schema conventions, Playbook column map, sitemap, OpenAPI v1, tokens). Changes after the freeze require an ADR.

**Wave 2: Platform (parallel: A03, A05 in Claude Code, A06, A18, A28)**
- Domain schema with invariants, component libraries, the page templates in Section 11.6, the Atlas shell, the reseller hierarchy, spend authority, separation of duties, field masking, the external identity and engagement schema with Section 8.7 policies, and the platform services.
- Exit criteria: a user can sign up, create an org, invite members, set branding, subscribe to a plan and see an empty Home.

**Wave 3: Modules (parallel: A07 to A16, A19, A27, A28, A29, A30, A31)**
- Every Atlas module is implemented end to end: list, board, timeline and calendar views as applicable, record peek and page, create and edit, state transitions, comments, attachments, API parity, tests, empty and refusal states.
- Gateway is implemented end to end for all eight external role types, together with the Atlas Opportunities module.
- The workforce suite, identity and profiles, every settings page, the view system, tooltips, help and support are implemented across all three shells.
- Exit criteria: all 45 playbook sheets have a working module surface, every engagement lifecycle runs from requisition to re-engagement, and the demo tenant seed exercises every module and role type.

**Wave 4: Field (A17, with A24)**
- Compass is complete with offline sync, clock, scan, incidents, inspections, run of show and kiosk, for internal users and for every external role type.
- Exit criteria: the Maestro suite passes on both platforms, including offline.

**Wave 5: Ecosystem (A19, A20, A25, A26)**
- Integrations, SDKs, CLI, MCP server, the docs site with the API reference and self-hosting guide, AI features with passing evals, and the reliability stack (status page, synthetic checks, progressive delivery).

**Wave 6: Independent verification (A22, A23, A24)**
- Reviews and the full test matrix run.
- Findings go to the owning agents as issues. The fix loop repeats until zero open findings rated High or Critical and zero serious or critical accessibility violations remain.

**Wave 7: Release (orchestrator)**
- The orchestrator runs the Section 20 checklist, tags v4.0.0, publishes packages, deploys production, and submits Compass to TestFlight and Play internal testing.

### 19.3 Module Agent Assignments

| Agent | Modules |
| --- | --- |
| A07 | Projects, scope tree, gates and evidence, Home, Activity |
| A08 | Schedule, Work (records and work orders), Show |
| A09 | Places, requirements and capability reconciliation, Safety (permit engine, inspections) |
| A10 | Advancing (packets, riders, reconciliation; the Gateway advance tab with A27) |
| A11 | Logistics, Hospitality |
| A12 | Assets (grain, custody, maintenance, scanning back end) |
| A13 | People, Crew (shifts, time, timesheets, rates, payroll export) |
| A14 | Credentials and Access Grid, Safety (incidents, dispatch, emergency codes, radio) |
| A15 | Finance (budget, change orders, ledger, periods, UPL), Reports |
| A16 | Procurement, Vendors, Catalog bindings, Knowledge, Canon browser |

### 19.4 Ownership and Collisions

- An agent edits only the paths it owns.
- Changes outside its paths go through a request to the owning agent via the orchestrator.
- Migration numbers come only from the agent's assigned range.
- Shared files (root config, CI) are orchestrator-owned.
- Generated files (database types, OpenAPI document, SDKs) are regenerated by CI, never hand-edited.

### 19.5 Handoff Contract

Every agent's completion report includes:

1. Paths changed and migrations added
2. Endpoints added, with their OpenAPI operation IDs
3. Tests added and their pass results
4. Invariants implemented, with references to their pgTAP tests
5. Accessibility checks run
6. Known limitations

Known limitations must be empty for completion. If an item cannot be completed, the agent reports it as blocked, with the cause and the decision needed.

### 19.6 Definition of Done (Per Feature)

- Schema, RLS, invariants and pgTAP are merged.
- The API operation is merged with contract tests.
- The UI is implemented from the design exports, in both themes, keyboard-complete, with axe clean results.
- Empty, loading, error and refusal states are implemented with specific copy.
- Copy is in message catalogs (en-US and es-US).
- Audit events and webhooks are emitted.
- Documentation pages and examples are written.
- A demo tenant seed exercises the feature.

### 19.7 Engineering Rules for Every Agent

- Read the relevant Bible tabs through the canon tables, not from memory. Never invent canon values.
- No placeholder copy. Every empty state names the next action in that context.
- No silent catches. Every error path either recovers, surfaces a typed error or returns a refusal.
- No feature ships without its RLS tests.
- Prefer the database for invariants, the API for contracts and the UI for experience.
- Write migrations as forward-only, idempotent where feasible, and commented.
- Keep functions small and named for what they guarantee.
- Commit messages follow Conventional Commits. Pull requests reference their ADR or issue.

### 19.8 Stop Conditions

Agents stop and report to the orchestrator, without proceeding, for:

- Spending money beyond the free tiers or the agreed cloud budget
- Purchasing or transferring domains
- Submitting to the public App Store or Play production track
- Sending email or SMS to real recipients outside the test allow-list
- Deleting any non-ephemeral cloud resource
- Publishing packages under a new organization name
- Changing a license

Everything else proceeds on documented judgment.

---

## 20. Acceptance Criteria

### 20.1 Platform

1. The canon importer loads the Bible with every count in Section 2 validated. The canon browser shows all ten departments in numeric order, with 4000 labeled Environment. Gates 1 to 3 read Scope, Engage and Advance. DIS and DSN resolve as superseded codes.
2. Signup through first project takes under 5 minutes in a usability script, with legal acceptance recorded.
3. Cross-tenant access attempts fail in pgTAP for every table and in API tests for every operation.
4. White label: a tenant applies a brand and a custom domain. Atlas, Gateway, emails, PDFs and Compass all reflect it, and contrast validation blocks a failing palette.
5. The public API, OpenAPI document, TypeScript SDK, Python SDK, CLI and MCP server all work against staging with an org API key.
6. The DSAR workflow completes access and erasure end to end, honoring legal holds and retention.
7. Every row and column of all 45 Playbook sheets is present in canon, the Standard Library or the Production Template. The round-trip export matches the source manifest exactly, and the Playbook to Bible diff report is empty or resolved by the owner.
8. The Atlas sidebar, project tabs, module pages, settings tree, Compass tabs and Gateway navigation match Section 4.5 in order, label and route for every role.
9. The ACR drafts, Accessibility Statement, Terms of Service, Privacy Policy, DPA, Subprocessor List, SLA, Acceptable Use Policy, Cookie Policy, EULA and Security Overview are published at `/legal` with version history.
10. Every page in Atlas uses one of the templates in Section 11.6, and every token group in Section 11.3 is defined in `packages/tokens` and consumed by both component libraries.
11. The service level objectives in Section 5.1 hold for 7 consecutive days in staging under the load targets, with the status page and synthetic checks live.

### 20.2 Critical Journeys

Each journey is covered by an automated end-to-end test.

1. Create a project with jurisdiction US-FL-MIAMI-DADE, generate permit requirements from the permit engine, and see lead times.
2. Attempt gate 1 to 2 with a missing blocking criterion: refused with the named criterion. Attach evidence, then pass.
3. Build a budget from catalog elements across Base, Elevated and Premium grades. An unpriced element shows Unpriced, and totals show the unpriced count.
4. Issue an RFQ to three vendors, receive sealed bids in Gateway, unseal at the deadline, award, and issue a PO that the vendor acknowledges in Gateway.
5. Receive goods against the PO in Compass by scan, match the invoice three ways, and approve. A duplicate receipt is refused.
6. Raise a change order without a price: stored as unpriced, not zero. Price it, approve it, and see the budget update.
7. Close an accounting period, then attempt a posting into it: refused.
8. Export UPL for a period and validate it against each of the four accounting mappings.
9. Create a staffing requisition from canon roles with staffing ratios against an occupancy figure, then send an offer and an MSA by token. The recipient signs with an access code, and the signed agreement cannot be revoked.
10. Publish shifts. A crew member accepts in Compass, clocks in inside the geofence, clocks in again on a second device (refused), and clocks out.
11. A supervisor approves a timesheet, the crew edits hours, and the approval is voided.
12. Run payroll export for a pay period, post it, and attempt to reopen the period: refused.
13. Build an advance packet, send it to a talent representative, receive the rider, and reconcile it against venue capability. An UNKNOWN on a critical requirement shows as a gate 3 gap.
14. Schedule records on the timeline with dependencies, baseline the schedule, slip a record, and see the logged replan.
15. Run a live run of show in Atlas and Compass with cue progression in real time.
16. Report an incident offline in Compass with photos, reconnect, and see it filed once in the Atlas dispatch board. Attempt to close a critical incident without sign-off: refused.
17. Run an inspection template in Compass, fail an item, and see the punch record created.
18. Issue credentials by category, configure the Access Grid, and scan a credential at a zone in Compass: allowed and denied cases.
19. Check out and return an asset unit by scan and see the custody ledger.
20. Log a shipment, check it into a dock slot, record it in the marshalling yard log, and release it.
21. Fulfill hospitality: assign lodging and catering, generate a BEO, and confirm.
22. Pass gate 8 with capture delivered, rights cleared and sponsor obligations evidenced. Uncleared rights block the gate.
23. Close the project: final cost report against the gate 3 baseline, assets returned or written off with an approver, and element usage recorded.
24. Navigate the whole of Atlas by keyboard only, using the command menu, J and K list movement, and peek open and close.
25. Use Compass with VoiceOver and with TalkBack for clock in, task completion and incident report.
26. A partner org creates a client org, sets an inherited brand and bills it at wholesale. Partner staff cannot read client data until the client Owner grants a support session.
27. Import a customer spreadsheet through the wizard, review fuzzy duplicates, commit, then undo the whole batch.
28. Define a custom object, add records, view it as a board and read it through the API.
29. Build a report with a NULL-aware total, place it on a dashboard and schedule it by email as PDF.
30. A purchase order above the creator's spend limit routes to the next approver; the creator cannot approve their own PO.
31. A Member sees pay rates masked; a payroll-capable Manager sees them; a Restricted export without step-up authentication is refused.
32. An Admin uses View as role for Crew and sees nothing beyond the Admin's own access; Why can I see this explains a record.
33. Two people edit the same SOP at once and their changes merge; two people change the same budget line property and the conflict dialog shows both values.
34. Paste 200 rows from Excel into the budget grid, then undo the paste.
35. Ask the assistant for blocked permits in a jurisdiction; it returns linked records, and for an unpriced element it returns NO ANSWER instead of a price.
36. Extract an insurance certificate with the assistant, review the field confidences and confirm before anything is saved.
37. Switch a project to EUR, see budget totals converted with the rate date shown, and see unpriced lines remain unpriced.
38. Delete a crew account from inside Compass and receive confirmation.
39. Cancel an org, download the full export, and see the read-only banner during the 30-day window.
40. A Compass build below the advertised minimum version shows the forced update screen.
41. Crew: a staffing requisition becomes a public crew call; a freelancer applies in Gateway, is shortlisted, accepts an offer, completes onboarding (the engagement stays Blocked until the background check passes), works shifts in Compass, has timesheets approved, is paid and rated, and loses credential access at close.
42. Staff: a staffing agency submits a slate, wins the award, assigns its staff, and each staff member completes training acknowledgments before positions are assigned.
43. Vendor: the vendor onboards with a W-9 and an insurance certificate whose additional insureds are verified, checks in at a dock slot in Compass, submits an invoice in Gateway, and closes with a lien waiver and scorecard.
44. Contractor: a scoped opportunity in a pay-transparency jurisdiction cannot publish without a pay range; the contractor delivers milestones, invoices against them, and appears in the 1099-NEC export.
45. Artist: an open call receives EPK submissions; an Artist Representative accepts the offer for the artist, completes the advance and rider, the artist sees set time and guest list in Compass, and settlement closes the engagement.
46. Client: a signed proposal invites the client into Gateway; the client approves a change order, sees the shared run of show, and never sees internal notes, margins or other parties' rates.
47. Sponsor: a sponsorship package is accepted, assets are approved in Gateway, entitlement fulfillment is captured with photos in Compass, and the proof-of-performance report satisfies gate 8.
48. A person who is an internal member of one org and a crew member for another switches between Atlas, Gateway and Compass with one sign-in, and each surface shows only its own context.
49. Ratings: both sides rate; neither sees the other's rating until both submit or 14 days pass; the rated party replies publicly.
50. A token advance form is completed without an account, then claimed into a new Gateway account, and the submission appears under that account.
51. A Finance Lead signs in for the first time and sees Commercial expanded and other groups collapsed; an Admin turns off the Hospitality module and it disappears from navigation, search and the command menu.
52. A crew member clocks in from the Live Activity, takes a break and clocks out without opening Compass.
53. A receiver scans 30 items in continuous mode in under 60 s and reviews the batch before saving.
54. An incident is filed offline in three steps with a voice note in under 30 s and transcribed after reconnecting.
55. On a phone, a freelancer finds a matching opportunity from Gateway Home in under 10 s, sees the requirements check, and applies in 3 taps.
56. A vendor follows an invoice from Submitted to Paid in the Money tracker and receives a push notification at each step.
57. A Producer approves a timesheet from a push notification, a Finance Lead approves 20 Inbox items with the keyboard in under 60 s, and neither opens a record.
58. A person scans the Continue on Another Device QR code in Atlas and lands on the same record in Compass.
59. One person is an Admin of one org, a Producer and Finance Lead in a second org, a crew member for a third and an artist for a fourth. They switch context in every shell, see the union of their roles in each org, and cannot approve their own expense in the second org even with both roles.
60. A vendor company with an external account subscribes and starts using Atlas. Its organization record, profile, ratings and history carry over with no duplicate.
61. A person sets their profile to Network, hides their rates, and shares the full profile with one org through an application. A stranger sees nothing; a past collaborator sees the Network fields; the applied-to org sees the shared fields.
62. An organization publishes a Public profile with case studies, open opportunities and a verified domain badge, and it appears in Explore with indexing off by default.
63. An Admin locks the time zone at org level; a workspace cannot override it, and the settings page shows where the value comes from.
64. A manager posts a required-read announcement to one department; Compass users acknowledge it, and the manager sees who has not.
65. A form built in Atlas with conditional logic, a required photo and a signature is completed offline in Compass and becomes a record of the right kind.
66. Crew claim open shifts in Compass under the org's claiming rule; an auto-fill suggestion skips a person whose certification has expired.
67. The occupancy counter alerts at 90 percent of the permitted occupant load, and a wind alert reaches the roles named in the emergency plan.
68. Shifts open as a resource schedule in Atlas and as an agenda in Compass. A filter set in table view survives a switch to board, calendar and map. A collection without dates never offers calendar.
69. Hovering a gate chip shows its Bible definition; the `?` key opens help for the current page; a support ticket with consented diagnostics reaches the right queue.
70. A record is deleted to Trash, restored within the retention period, duplicated with its children, and watched for changes.

### 20.3 Release

- All Section 18 gates pass on main.
- Independent security and accessibility reviews have zero open High or Critical findings.
- Production deploy succeeds, with monitoring, alerting, backups and a verified restore drill.
- Compass builds are in TestFlight and Play internal testing.
- Packages are published, and the docs site is live with the API reference and self-hosting guide.

---

## 21. Orchestrator Output

At the end of the build, the orchestrator produces `docs/BUILD_REPORT.md` containing:

- Final stack versions
- The ADR index
- Migration count by range
- Table, policy and function counts
- The OpenAPI operation count
- Test counts and coverage by package
- Accessibility and security review summaries with zero open High or Critical findings
- Performance results against budgets
- Deployed URLs
- Package versions

The orchestrator also verifies the canon counts one last time against the Bible, and records the canon generation and ratification state in effect.

Begin with Wave 0.
