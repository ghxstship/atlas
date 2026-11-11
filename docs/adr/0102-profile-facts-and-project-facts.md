# ADR 0102: Profile Facts and Project Facts

- Status: Accepted
- Date: 2026-10-28
- Decider: Owner decisions on advancing, 2026-10-28 (decisions 0/1, 2, 3, 4 and 5); R0 (RRR-176)
- Amends: Section 4.5.6 item 10 as A78 built it (`1340_work_details.sql`) and ADR 0071, decision 5
- Migrations: none

## Context

A78's Work Details (`1340_work_details.sql`) are person-owned. `app.person_work_details` holds uniform sizes, dietary
needs, allergies, accessibility needs, seat and meal preferences and one `home_airport` (`1340:125-131`), with
loyalty programs and the passport beside them. Only the person an engagement names can share them (`1340:648-651`),
once per engagement (`1340:557`), and the share restates `person_id` (`1340:530-551`). There are no vehicle fields.

The owner's clarification splits these facts in two. Standing facts about the person stay on the profile. Facts that
change with each project (sizes for this show's uniform, the flights for this show, the car parked at this venue)
belong to the project, entered by the person for each roster entry (ADR 0101). Uniform sizes on the per-engagement
Crew packet (line 558) already point that way; lines 412 and 835 and ADR 0071 put them on the profile, so this ADR
amends them.

## Decisions

### 1. The line between profile and project (decisions 0/1, 2 and 5)

**On the profile:**

- name and **Contact**: the auth-verified email and phone, read as `private.recipient_address` reads them
  (`1361_push_and_sms_senders.sql:22-33`). Contact is a new work detail category, built in R6a. Once A139 lands,
  `workforce.work_phone` replaces the auth phone.
- emergency contacts
- dietary needs, Confidential
- allergies, Restricted, read capability `data.restricted.read.medical` (section 4 below)
- accessibility needs and loyalty programs, which stay on the profile (decision 5)
- certifications and documents
- the passport, Restricted under `data.restricted.read.government_id` (`1340:171`)

**Project facts**, keyed on `roster_entry_id` alone and built in R5:

| Table                    | Columns                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roster_uniform_sizes`   | shirt, jacket and glove in `app.garment_letter_size` (`1340:43-44`); pants, shoe and hat as the short bounded values 1340 allows (`1340:117-120`, `1340:135-137`); no notes field |
| `roster_travel_requests` | inbound and outbound airport (two references to a new `app.airports`), inbound and outbound dates, seat, meal, ground transport needed, lodging needed                            |
| `roster_vehicles`        | make, model, color, plate, plate region                                                                                                                                           |

A known-traveler number is not collected. If it is ever added, it is Restricted and encrypted.

### 2. Existing profile values are deleted with notice (decision 2)

- **R6a** stops the UI writes in `apps/compass/src/settings/workDetails.ts`,
  `apps/gateway/components/settings/work-details.tsx` and `apps/atlas/components/work-details/panels.tsx` (rendered by
  `apps/atlas/components/settings/contributions/a78.tsx`). It deletes the existing uniform size, seat, meal and home
  airport values in its own migration and notifies each person who held one (`account.work_details_moved`). The
  values are never offered back as suggestions.
- **R6b**, one release later, only drops the columns, while API v1 keeps its fields (expand and contract).
- `'Uniform Sizes'` stays as a retired value of `app.work_detail_category`, because `app.work_detail_events` keeps rows
  that name it for seven years (`1340:382-383`). No new share may choose it.

### 3. The read rule (decision 4)

**The company** (the external account) reads every profile category and every project fact of the people on its
roster, under RLS, by account role and assignment duty, not by a completeness-only rule:

| Reader                             | Reads                                           |
| ---------------------------------- | ----------------------------------------------- |
| Account Owner and Account Admin    | every entry of the account's engagements        |
| Advancing Lead                     | the entries of the engagements assigned to them |
| Account Member and Account Finance | their own entries only                          |

- The consent basis is purpose `account_roster_sharing`, recorded for the company account when the person accepts the
  roster entry (R4). Declining the entry, or withdrawing consent, ends the read.
- Restricted values (the passport number, allergies) are masked for every external reader.

**Producing-org readers** read profile facts through the person's share, keyed on `roster_entry_id` (R4), and project
facts by capability:

| Project fact | Capability                                                             |
| ------------ | ---------------------------------------------------------------------- |
| travel       | `hospitality.fulfillment.read`                                         |
| uniform      | `opportunities.engagement.read` or `crew.shift.write` (`1340:563-567`) |
| vehicle      | `credentials.credential.read`                                          |

Every read of a Confidential or Restricted value, by any reader, is written to the access log, as
`app.work_detail_events` does today (`1340:788-868`).

### 4. Medical: one mechanism (decision 5)

- Unmasked allergy reads need `data.restricted.read.medical` (`packages/schemas/capabilities.yaml:1247-1250`). R6a
  reclassifies `app.person_work_details.allergies` as Restricted in `private.column_classifications`.
- **Default holders.** A platform table, `private.workforce_role_capabilities`, maps two canon roles to the
  capability (`0150_xpms_canon_seed.sql:8032-8034`):
  - `8000.51.01` Executive Catering Captain (rate card line "Artist & Crew Catering Lead")
  - `7000.51.01` Lead Event Paramedic / EMT (rate card line "On-Site Medical & Triage Lead")
- **Reach.** `private.project_ids_with` (latest definition `1205_project_shares.sql:256-298`) grants the capability on
  a project to a person with an Active `app.role_assignments` row (`0361_people.sql:201-223`) in one of those roles
  there. The reach is computed at read time and never stored.
- Activating one's own such assignment is refused with `sod_self_grant`.
- Role assignments are the only path: no org setting lists reader roles, and no helper besides
  `private.project_ids_with` answers the reach.
- A project-scoped holder never unmasks incident treatment notes: `app.medical_encounters_masked` checks the org-wide
  capability (`0353_safety_knowledge.sql:440`).
- ADR 0105 (R6a) records the table and its grants in full.

### 5. Retention (decision 3)

- Org setting `advancing.project_facts.keep_days`: Integer, default 90, min 30, max 365. It is a setting because
  `private.retention_policies` holds one row per table (`0500_platform_services_machinery.sql:41-42`).
- R5's daily job deletes the project fact rows of entries whose engagement reached Complete or Canceled more than
  `keep_days` ago. Rows the person clears are soft-deleted and purged after 30 days. A legal hold suspends both.
- DSAR access, erasure and portability cover all three tables (lines 2499 and 2915). The tables are excluded from AI
  as `1340:314-334` excludes Work Details.
- Classification is per column, with the plate and the airports registered individually.
- `credential_vehicles` uses ON DELETE SET NULL and redacts the plate, so a parking credential kept for its own
  retention outlives the vehicle row.

### 6. Provenance

- The person enters their own facts in Gateway or Compass. The company's Owner, Admin or Advancing Lead may enter
  them on the person's behalf when the org setting `advancing.company_may_submit_project_facts` allows it.
- A company write never overwrites a value the person entered (lines 204-205). The person is notified of every
  on-behalf write and can correct it.
- The write functions refuse with `offering_not_offered` unless the resolver (ADR 0100, section 4) offers travel,
  lodging, uniforms or parking in a mode other than Not Offered.

### 7. Suggestions

`my_previous_roster_facts` returns the person's own earlier values, to the person only, as an unsaved pre-fill. It
returns nothing once those facts are purged, and nothing is written back to the profile.

## Alternatives

- **Keep sizes and travel preferences on the profile and copy them into each engagement.** Two places for one fact,
  and the copy goes stale between shows.
- **Offer the deleted profile values once as suggestions.** Rejected by decision 2.
- **Completeness only for the company.** The design report proposed it; decision 4 replaced it with a read by role
  and duty.
- **An org setting listing medical reader roles, checked by a new helper.** A second mechanism beside role
  assignments, and a setting an admin could widen to every role. One platform table and the existing
  `private.project_ids_with` path keep a single answer.
- **Soft-delete expired project facts.** The facts have no value after the engagement closes, and a soft-deleted row
  still holds the plate and the airports.

## Consequences

- People re-enter uniform sizes and travel preferences per project; the pre-fill from their own earlier entries
  keeps that to a confirmation.
- The company sees more than the design report proposed, so the access log and masking carry the privacy load. Every
  external read of a Restricted value shows the mask.
- ADR 0071, decision 5 applies to project facts as well (ADR 0100, section 7).
