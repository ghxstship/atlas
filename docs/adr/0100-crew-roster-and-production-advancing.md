# ADR 0100: Crew Roster and Production Advancing

- Status: Accepted
- Date: 2026-10-28
- Decider: Owner decisions on advancing, 2026-10-28 (decisions 0/1, 7 and 9); R0 (RRR-176)
- Amends: Section 4.5.8 (original prompt lines 917-926 and 944) and Section 4.5.6 (line 764 onward)
- Migrations: none

## Context

Section 4.5.8 gives each external role type one ordered list of engagement tabs (lines 917-926) and says an Account
Member sees only the engagements assigned to them (line 944). It has no crew roster. A staffing agency assigns its
own staff to the engagements it wins (line 454), an artist's credential covers "own and party badges" (line 883), and
the Crew onboarding packet asks for uniform sizes (line 558), but a company engagement is one row and nothing lets the
company name the people who work it.

What Gateway does today, from the advancing audit:

- `engagement.roster` (`apps/gateway/components/engagement/tabs-artist.tsx:336`) is the representative's list of
  represented artists, not a crew list.
- Contractor and Sponsor have no Advance tab, and Vendor and Artist have no Credentials tab
  (`apps/gateway/ia/sitemap.yaml:34-128`).
- `app.vendor_class_entitlements` (`1612_org_standard_library.sql:81-101`) is never read, so nothing says whether an
  org offers travel, parking or uniforms to a party.

The owner approved the design on 2026-10-28 (`orch-tools/advancing-decisions.md`). Where that file and the design
report differ, the decisions file wins. This ADR records the shape of the whole advancing build. ADR 0101 records
roster access, ADR 0102 the profile and project facts, ADR 0103 computed statuses and ADR 0104 the advanceable item
lifecycle. ADR 0105 is reserved for R6a (allergies and workforce role capabilities), and 0106 to 0109 stay free for
advancing.

## Decisions

### 1. Scope, and the approved requirement-4 deviation (decision 0/1)

The advancing role never requests information. The person does four things, each once and each their own act:

1. accepts account membership,
2. accepts each roster entry,
3. grants the profile share, and
4. enters their own project facts: uniform sizes, inbound and outbound airports and dates, travel preferences and
   vehicle.

Basis: lines 454, 558, 589, 883, 944 and 1084. The roster extends Section 4.5.8 and the Section 7.4 advancing tables
(line 1562); it replaces neither.

### 2. Gateway tab sets

The source is `apps/gateway/ia/sitemap.yaml:34-128`. Later packages edit it into exactly these orders. Every set
opens on `engagement.overview` and carries `engagement.documents` and `engagement.messages`, as
`packages/ia/src/validate.ts:393-399` requires. Tab ids below drop the `engagement.` prefix.

| Set                                  | Tabs, in order                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| vendor                               | overview, bid, purchase-orders, deliveries, submittals, advance, crew, credentials, invoices, compliance, documents, messages              |
| contractor                           | overview, scope, deliverables, advance, crew, time, invoices, documents, messages                                                          |
| crew                                 | overview, offer, onboarding, project-details, shifts, timesheets, invoices, travel-and-lodging, per-diem, credentials, documents, messages |
| staff                                | overview, offer, onboarding, project-details, crew, training, positions, shifts, timesheets, invoices, credentials, documents, messages    |
| artist                               | overview, offer, advance, crew, project-details, rider, set-times, hospitality, guest-list, credentials, settlement, documents, messages   |
| artist-representative, Advance scope | advance, crew, project-details, rider, set-times, hospitality, guest-list, credentials                                                     |
| sponsor                              | overview, entitlements, asset-approvals, activation-schedule, advance, crew, proof-of-performance, invoices, documents, messages           |
| roster-member (new)                  | overview, project-details, credentials, travel-and-lodging, per-diem, documents, messages                                                  |
| roster-staff (new)                   | overview, project-details, training, shifts, timesheets, credentials, travel-and-lodging, per-diem, documents, messages                    |

- Client is unchanged.
- **The representative's Advance scope carries project-details as well.** The validator requires a delegating set to
  cover exactly the artist's tabs (`validate.ts:380-391`), so R5 inserts project-details into the Advance scope after
  crew in the same change that adds it to the artist set. A representative with the Advance scope is an engagement
  principal (ADR 0101), so this grants nothing the roster rules do not already allow.
- **roster-member** renders when a person reaches an engagement only through an Accepted roster entry (R8).
- **roster-staff** renders for a person who reaches a Staff company engagement only through a roster entry (R12).
- **The new tab is `engagement.crew`**, routed `/work/engagements/{engagementKey}/crew`. `engagement.roster` stays
  the representative's list of represented artists. In the staff set, crew shows only to a roster manager
  (`private.can_manage_roster`, ADR 0101), so individually engaged staff never see it.
- **`engagement.project-details`** is R5's node and the one id everywhere; there is no `engagement.my-project-details`.
  It shows only when the resolver (section 4 below) offers travel, lodging, uniforms or parking in any mode other
  than Not Offered.
- **The Advance tab for contractor and sponsor** shows only the typed sections a packet addresses to them (R9).

Each package inserts at a fixed anchor. The anchors give the lists above whatever order R2 and R4, which do not
depend on each other, merge in; R5 depends on R4 and R9 on R4, so their anchors may name R4's tab.

| Package | Inserts                                                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2      | credentials before invoices (vendor), and after guest-list (artist, representative Advance scope)                                                           |
| R4      | crew after advance (vendor, artist, representative Advance scope), before time (contractor), before training (staff), before proof-of-performance (sponsor) |
| R5      | project-details after onboarding (crew, staff), and after crew (artist, representative Advance scope)                                                       |
| R8      | the roster-member set                                                                                                                                       |
| R9      | advance after deliverables (contractor), and after activation-schedule (sponsor)                                                                            |
| R12     | the roster-staff set                                                                                                                                        |

### 3. Atlas sitemap additions

| Node                    | Where                                                                                               | Package |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| `crew.per-diems`        | org page `/{org}/crew/per-diems`                                                                    | R1      |
| `advancing.crew`        | org page `/{org}/advancing/crew`, and the section `crew` of the project Advancing tab               | R4      |
| `advancing.allocations` | org page `/{org}/advancing/allocations`, and the section `allocations` of the project Advancing tab | R7      |
| project section only    | the section `progress` of the project Advancing tab                                                 | R11     |

Section labels read `nav.atlas.pages.advancing.<section>`, as
`apps/atlas/app/[org]/p/[projectKey]/advancing/page.tsx:31-32` already does for packets, submissions, riders and
reconciliation.

### 4. Offerings, amending Section 4.5.6 (decision 7)

- **Keys.** Nine settings-registry keys at organization and project scope, lockable, each naming its consumers or a
  deferral: `offerings.travel`, `offerings.lodging`, `offerings.catering`, `offerings.parking`,
  `offerings.uniforms`, `offerings.per_diem`, `offerings.radios`, `offerings.carts` and `offerings.guest_list`.
- **Modes.** Not Offered, Provided, Reimbursed or Buyout (registry choices `not-offered`, `provided`, `reimbursed`,
  `buyout`). The default is Not Offered.
- **Vocabulary.** `app.offering_kind` is the one list of offering kinds. Every package (R5, R7, R8, R9) uses it and
  never a text code.
- **Rules.** One rules table, `app.offering_rules`, holds mode, audience and caps. Org rows have `project_id` NULL.
- **Resolver.** `private.effective_offerings`, with the `app.effective_offerings` wrapper, decides which fields,
  share categories and Gateway tabs appear. It reads `app.vendor_class_entitlements` live; nothing is seeded from it
  or copied out of it.
- **What each mode allows.** Items are issued only when the mode is Provided; R7 refuses anything else with
  `offering_not_provided`. Facts and tabs show for any mode other than Not Offered.
- **Backfill.** Live projects that already hold the matching rows (travel segments, room assignments, per diems,
  parking credentials and so on) get Provided, so their tabs stay where they are (silence rule, lines 193-199).

R3 builds all of this.

### 5. Package map (decision 9)

Every package has a Linear issue under P-RRR-1. Blocks are recorded in ADR 0022.

| Package | Linear  | Title                                                       | Depends on                   | Gates                        | Block     | ADR        |
| ------- | ------- | ----------------------------------------------------------- | ---------------------------- | ---------------------------- | --------- | ---------- |
| R0      | RRR-176 | Advancing ADRs                                              | none                         | none                         | none      | 0100-0104  |
| R1      | RRR-179 | Wiring fixes                                                | R0                           | A121                         | 2600-2609 | 0100       |
| R2      | RRR-180 | Read gaps                                                   | R0, R1                       | none                         | 2610-2619 | 0100       |
| R3      | RRR-181 | Offerings                                                   | R0, R1                       | none                         | 2620-2629 | 0100       |
| R4      | RRR-182 | Roster core                                                 | R0, R1, R3                   | A108, A121                   | 2630-2649 | 0101, 0102 |
| R5      | RRR-184 | Project facts                                               | R0, R3, R4                   | none                         | 2650-2659 | 0102       |
| R6a     | RRR-185 | Profile deprecation, Restricted allergies, Contact          | R0, R4, R5                   | none                         | 2660-2669 | 0102, 0105 |
| R6b     | RRR-186 | Profile contract, one release after R6a                     | R6a                          | none                         | 2760-2769 | 0102       |
| R7a     | RRR-183 | Supply bridge                                               | R0, R1                       | A120                         | 2680-2689 | 0104       |
| R7      | RRR-187 | Allocations, Atlas side                                     | R0, R1, R3, R4, R5, R6a, R7a | A120, A121                   | 2690-2699 | 0103, 0104 |
| R8      | RRR-188 | Gateway assignment, the roster-member set and Compass Today | R0, R1, R2, R3, R4, R5, R7   | A122                         | 2700-2709 | 0100, 0103 |
| R9      | RRR-189 | Typed sections, uploads, contractor and sponsor Advance     | R0, R3, R4, R7, R8           | A106, A107, A108, A121, A140 | 2710-2729 | 0100       |
| R10     | RRR-191 | Token parity                                                | R4, R7, R9                   | none                         | 2730-2739 | 0100       |
| R11     | RRR-192 | Heatmap, reminders and notices                              | R3, R4, R5, R6a, R7, R9      | A123, A127, A131, A146       | 2740-2749 | 0100, 0103 |
| R12     | RRR-190 | Agency staff on shifts                                      | R0, R4, R7, R8               | A107, A108, A130, A132       | 2750-2759 | 0100, 0101 |

R7a merges before R7. The open-work packages advancing waits on have issues too: A123 (RRR-168), A127 (RRR-172),
A131 (RRR-177) and A146 (RRR-178).

### 6. Notifications: one owner per kind

Each kind is seeded by exactly one package, and no two packages send the same fact.

| Package | Kinds                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R4      | `roster_entry.invited`, `roster_entry.returned`, `roster_entry.declined`                                                                                                                   |
| R5      | `roster_entry.project_facts_entered`                                                                                                                                                       |
| R6a     | `account.work_details_moved`                                                                                                                                                               |
| R7      | `allocation.decided`, `allocation.assigned`, `allocation.issued`, `allocation.withdrawn`                                                                                                   |
| R11     | `advance_packet.reminder`, `advance_submission.returned`, `submittal.returned`, `roster_entry.removed`, `roster_entry.facts_requested`, `roster_entry.share_revoked`, `credential.revoked` |

- `allocation.withdrawn` covers the cascades as well: an entry removed, and an engagement reaching Complete or
  Canceled, after which credentials and Compass access end (line 1758).
- `roster_entry.share_revoked` tells the producing org, and the entry's readiness turns into a gap.
- A127's one-tap action links attach to `roster_entry.invited`, and A146's funnel registry counts the roster flow.

### 7. Compass Project Details is online only

Project facts save online only and are never kept on the phone, as Work Details are (ADR 0071, decision 5).

### 8. Typed advance sections, party uploads and the summary body (R9, migrations 2710 to 2716)

An advance section has a `section_kind`: Text, File, Schedule Window, Item Request, Crew Roster, Guest List or
Credential Request, with its window kind, line limit and per-person flag held to the kind by
`advance_sections_kind_fields` and fixed once the packet is sent. Item Request offers asset classes and Credential
Request offers credential categories (`app.advance_section_choices`); the offering is the class's own and is checked
on each line, so there is no offering column. Typed answers are written only by `private.record_advance_answer`, and
their item and credential lines become Requested allocations through R7's internals; the answer's review approves or
declines them, leaving any that need a reviewer's decision Requested. Files a party gives a File section, and the
brand assets a sponsor supplies, go to the private `party-uploads` bucket, which the scan read gate covers like
field-media and onboarding-uploads, and become documents of the project. API v1 documents an answer's `body` as
required, so a typed answer stores a locale-neutral summary there (kind codes, catalog codes or category names,
quantities, ISO 8601 windows with their zone, file titles; `GUEST_LIST_CONFIRMED`), written once with its immutable
lines and files and registered in the denormalization register. Contractors and sponsors answer the same Advance tab
without a guest list. A recipient's `names_due_at` (G-141) closes naming on the credential pools it requested; only
the producing org renames them afterwards, and cascades are never blocked.

## Alternatives

- **D1, one roster key and a generic ledger.** The most complete on privacy, but 17 packages are too many to deliver.
- **D2, allotment then assignment.** Stores `project_id` on roster entries although the engagement already holds it.
- **One engagement per rostered person.** It would count every crew member toward the plan limit on active external
  engagements (lines 2648-2649) and duplicate the company's terms on each row.
- **Two offering values, Offered and Not Offered.** It cannot say whether an org books travel or reimburses it, and R7
  must refuse to issue what the org only reimburses.
- **A separate `engagement.my-project-details` tab for rostered people.** Two nodes for one form; R5's node serves
  every set.

## Consequences

- The Section 4.5.8 tab table is amended by section 2 above. A tab added later inserts at a named anchor so that
  merge order cannot reorder the lists.
- Offerings default to Not Offered, so a new org shows no travel, parking or uniform fields until it turns them on;
  live projects keep their tabs through the backfill.
- Every advancing package cites this ADR for its tabs, its Atlas nodes and its notification kinds, and adds no kind
  another package owns.
- Gateway forms keep the limits of lines 2186-2190: at most seven fields before More fields and one primary action. The
  roster and project facts forms are Wizards, one step per offering that is on.
