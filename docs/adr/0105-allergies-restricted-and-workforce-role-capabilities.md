# ADR 0105: Allergies Are Restricted; Catering Lead and On-Site Medical Roles Read Them

- Status: Accepted
- Date: 2026-10-30
- Decider: Owner decisions on advancing, 2026-10-28 (decisions 2, 4 and 5); R6a (RRR-185)
- Amends: ADR 0102 sections 1, 3 and 4 (records them as built); ADR 0071, decision 6
- Migrations: `2660_notification_kind_seed.sql`, `2661_work_detail_category_contact.sql`,
  `2662_workforce_role_capabilities.sql`, `2663_allergies_restricted.sql`, `2664_work_details_profile_move.sql`

## Context

A78 (`1340_work_details.sql`) classified `app.person_work_details.allergies` as Confidential and let any producing-org
member who read a shared Dietary Needs category read them. ADR 0102 decided that allergies are Restricted under
`data.restricted.read.medical` (`0203_capability_seed.sql:296`), that the people who need them on site read them by
default, and that uniform sizes and travel preferences leave the profile for project facts (R5). R4 left the roster
read keyed on the roster entry with allergies by the old category rule for org readers and masked for the company.
This ADR records how R6a builds decision 5, the expand step of decision 2, and the Contact category of decision 1.

## Decisions

### 1. The mapping table

`private.workforce_role_capabilities (role_code, capability_code)` maps a canon workforce role to a capability it adds
on the project the role is worked on. It is platform configuration, like `private.project_role_capabilities` (1110):
RLS on, every grant revoked from callers, select for `service_role` only. It holds two rows:

| Role code    | Canon role (0150)                                                | Capability                     |
| ------------ | ---------------------------------------------------------------- | ------------------------------ |
| `8000.51.01` | Catering supervision, job title Catering Captain (catering lead) | `data.restricted.read.medical` |
| `7000.51.01` | Event medical, job title Event Medic (on-site medical)           | `data.restricted.read.medical` |

No org setting lists reader roles. `packages/schemas/capabilities.yaml` notes the grant beside the capability; the
0203 seed stays the generator's output.

### 2. The `project_ids_with` branch

`private.project_ids_with` starts from its latest definition (`1205_project_shares.sql:256-298`) and gains one branch,
evaluated only for a capability the mapping names: the signed-in person has an Active `app.role_assignments` row in a
mapped role on the project, not deleted, within its `starts_on` and `ends_on`, in one of their orgs, and within the
API key's scopes when a key is used. The reach is computed at read time and never stored. Every other branch is
unchanged, so `private.can_on_project` answers it everywhere.

`app.medical_encounters_masked` keeps checking the org-wide capability (`0353_safety_knowledge.sql:440`): a project
holder never unmasks incident treatment notes.

### 3. Separation of duties

`private.guard_role_assignment` (from `0361_people.sql:243-280`) refuses `sod_self_grant` when a signed-in person
inserts their own assignment to a mapped role as Active, or moves their own to Active (Section 8.2). Someone else with
`people.role.write` on the project activates it; the person may still end their own.

### 4. Every read logged, the company always masked

- `private.column_classifications` marks `allergies` Restricted with read capability `data.restricted.read.medical`.
  Dietary needs and notes stay Confidential.
- A Restricted column is never directly selectable (`9900_security_catalog.test.sql`, test 16), so 2663 revokes
  select on `allergies` from `authenticated`. The person reads their own through `app.my_allergies()` and still
  writes them on the row.
- `private.read_allergies` is the one place a value leaves for anyone but its owner. For a holder of the capability
  on the project it returns the value and writes `allergies.viewed` to the person's access log (with the roster
  entry) and `work_details.allergies_viewed` to the producing org's audit ledger, on every read, never deduplicated;
  anyone else gets `allergies_masked`.
- `app.roster_shared_work_details` (2638) and `app.shared_work_details` through it: `dietary` gains
  `allergies_masked`; a new `medical {allergies}` is present when the share names Dietary Needs and the reader holds
  the capability, also without `hospitality.fulfillment.read`, whose readable list then stays without Dietary Needs.
  Every read with something readable logs `work_details.viewed`; 1340's ten-minute merge and its helper are gone.
- The company (an external account) never holds the capability (decision 4), so its roster reads always mask
  allergies, and it no longer reads the retired Uniform Sizes.
- `private.work_detail_share_visible` lets a medical holder on the project see that a share exists.

### 5. Contact

`app.work_detail_category` gains `Contact` (2661, alone in its migration). It maps to `opportunities.engagement.read`
and `safety.incident.read`; a share may name seven categories. Reads return `contact {email, phone}`, the verified
sign-in addresses `private.recipient_address` returns, to org readers with the capability and to the company. API v1's
`WorkDetailCategory` enum is frozen: a new value in a response enum is a breaking change under gate 20 (oasdiff), so
v1 leaves Contact out of the category lists and carries it additively as `share_contact` (write), `contact_shared`
(the share), `includes_contact` (the access log entry) and `contact` (the shared read).

### 6. The profile move (decision 2, the expand step)

- `private.move_profile_work_details()` deletes every value in the ten retired columns once, logs
  `work_details.fields_removed` with the names of the columns that held one (never the values), and sends
  `account.work_details_moved` (moved: uniform, travel or both) to each person with a sign-in; a failed notice is a
  warning only. Shares lose Uniform Sizes; one left empty is closed as a revocation, withdrawing consent with the
  last live share.
- `private.guard_person_work_details` refuses a non-null retired value (`work_detail_field_moved`), and
  `app.share_work_details` refuses Uniform Sizes (`work_detail_category_retired`); the constraint
  `work_detail_shares_no_retired_category` keeps live shares clear of it.
- The columns stay, always NULL, until R6b drops them; API v1 keeps the fields and says they are retired. Uniform
  Sizes stays an enum value for the access log rows that name it.

## Alternatives

- **An org setting listing medical reader roles.** A second mechanism beside role assignments that an admin could
  widen to every role (ADR 0102).
- **Store the reach on the assignment.** A stored grant goes stale when the assignment ends; computing it in
  `project_ids_with` keeps one answer.
- **Deduplicate allergy reads as 1340 deduplicated views.** The owner asked for every read logged.
- **Add Contact to v1's category enum.** Breaks clients written against the released contract (gate 20).

## Consequences

- A hospitality reader without a mapped role sees allergies locked ("Restricted: medical access only"); the Owner and
  the catering lead and on-site medical on the project read them, and the person's access log shows each read.
- Making someone on-site medical is a role assignment someone else activates, so it shows in the project's staffing.
- People re-enter uniform sizes and travel preferences per roster entry (R5); their profile values are gone.
