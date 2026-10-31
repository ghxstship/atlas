# ADR 0101: Roster Access and Account Engagement Assignments

- Status: Accepted
- Date: 2026-10-28
- Decider: Owner decisions on advancing, 2026-10-28 (decisions 0/1 and 6); R0 (RRR-176)
- Amends: the Section 8.7 time box in `0710_external_identity.sql:14-25` and `private.engagement_state_areas`
  (`0710:261-278`)
- Migrations: none

## Context

Section 4.5.8 says "Account Member sees only the engagements assigned to them" (line 944). The code diverges from it:
`private.engagement_party_areas` (`0710_external_identity.sql:280-330`) opens engagement and operational to every
Account Member on every engagement of the account (`0710:21-25`). Nothing records an assignment.

`app.add_account_member` (`0710:635-665`) adds a person to an account without their acceptance, and the time box
opens only engagement, documents and onboarding before Active (`0710:14-20`). A crew roster needs the person's own
consent before anything about them flows to the company or the producing org, and it needs an area that opens while
the engagement is still Onboarding, when the roster is built.

ADR 0100 records the advancing build as a whole; this ADR records who reaches a roster and how.

## Decisions

### 1. Account Member scope narrows to assigned engagements (decision 6)

- **Table.** `app.account_engagement_assignments`, built in R4:
  - `id`, `org_id` (the account), `engagement_id`, `account_membership_id`
  - `duty` of type `app.account_engagement_duty`: `'Advancing Lead'` or `'Member'`
  - `granted_by`, `created_at`, `deleted_at`. A soft delete is the revocation.
- **Who grants.** Only the account's Account Owner or Account Admin, never to themselves (`sod_self_grant`).
- **Areas.** R4 recreates `private.engagement_party_areas` from its latest definition so that the Account Member
  role opens engagement and operational only on engagements the member is assigned to. An Advancing Lead also gets
  the roster area and manages the roster without being on it.
- **No backfill.** This narrows today's access (`0710:21-25`) on purpose. An Owner or Admin assigns members after
  release; until then an Account Member reaches only their own roster entries.

### 2. Acceptance (decision 0/1)

- `app.account_memberships` gains `accepted_at`.
- `app.add_account_member` keeps creating an active membership with `accepted_at` NULL. The API contract is unchanged
  and the member keeps today's account access.
- An unconfirmed member cannot be rostered, assigned or listed in the talent pool, and nothing about them flows to
  anyone until they confirm.
- Each roster entry carries the person's own accept or decline, separate from the entry's review state. Declining
  sends `roster_entry.declined` (ADR 0100, section 6).

### 3. The roster area opens at Onboarding

A new `roster` area opens at Onboarding, Blocked, Active and Closing. This amends the time box comment at `0710:14-20`
and `private.engagement_state_areas` at `0710:261-278`; it closes at Complete with operational.

| Relationship                          | Roster area                                        |
| ------------------------------------- | -------------------------------------------------- |
| The engaged person                    | every entry of the engagement                      |
| Account Owner or Account Admin        | every entry of the account's engagements           |
| Advancing Lead (assignment duty)      | every entry of the engagements assigned to them    |
| Account Member, Account Finance       | their own entries only                             |
| Representative with the Advance scope | every entry of the represented artist's engagement |
| Anyone else                           | nothing                                            |

### 4. Helpers, each with one owner

| Helper                                         | Owner | What it answers                                                                                                                                                                                           |
| ---------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `private.engagement_principal(engagement_id)`  | R1    | True for the engaged person, an Owner or Admin of the counterparty account, or the artist's Advance representative, while the operational area is open. R4 widens it to a live Advancing Lead assignment. |
| `private.can_advance_engagement`               | R4    | Whether the caller may answer the engagement's advance                                                                                                                                                    |
| `private.can_manage_roster`                    | R4    | Whether the caller may add, submit, withdraw and replace roster entries                                                                                                                                   |
| `private.roster_people`                        | R4    | Unfiltered resolver view in schema `private`: each entry with its person                                                                                                                                  |
| `private.roster_entry_person(roster_entry_id)` | R4    | One entry's person                                                                                                                                                                                        |
| `app.roster_entry_people`                      | R4    | The producing org's read view of entries and people                                                                                                                                                       |
| `private.my_roster_entry_ids(area)`            | R4    | The caller's entries for `'roster'`, `'onboarding'` or `'operational'`                                                                                                                                    |

R5 and R8 use these helpers and define no equivalent. `private.my_engagement_ids('operational')` (used at
`0975_assets_engagement_custody_scans.sql:29`) never matches a rostered person, so roster-aware reads call
`private.my_roster_entry_ids` instead.

Every new external read gets a pgTAP matrix: the person's own entry, Owner, Admin, Finance, assigned Member, unassigned
Member, Advancing Lead, representative, and an unrelated person, who is denied.

### 5. Plan limits and project membership

Roster entries are not engagements. They never count toward the plan limit on active external engagements (lines
2648-2649), never create project membership (line 1689), and survive A107's over-limit guard (ADR 0081), which
counts engagements and never roster entries.

### 6. The talent pool

`my_account_talent` lists only current accepted account members and artists the caller represents with the Advance
scope. Former members and people the company rostered before are not in it.

### 7. Entry lifecycle and self entries

- States: Draft, Submitted, Accepted, Returned (with a reason) and Withdrawn. The party submits the roster, and
  reviewers accept or return each entry.
- A swap after acceptance withdraws the entry and adds a replacement that records `replaces_entry_id`.
- A self entry has `person_id` NULL exactly when the engagement names a person. `private.roster_people` resolves the
  person, so nothing restates `app.engagements.person_id`.
- People not yet on the platform join by invitation link (line 1084). The entry stays Draft until they claim the
  account by verified email (line 589) and accept.
- Amendment (R5, G-142, 2656): the producing org may set a names lock per engagement (`roster_locks_at`). After it
  the company side adds, invites, edits Draft entries and submits new names no more; Returned entries stay editable
  and resubmittable, and self entries, claims, responses, reviews and withdrawals go on.

### 8. Which engagements are rosterable

Vendor, Contractor, Staff, Artist and Sponsor company engagements are rosterable; a Sponsor rosters its activation
staff. Client engagements never are. An individually engaged Crew member, Staff member or Artist has only the self
entry, except that the artist, or a representative with the Advance scope, may roster a band or touring crew (line
883).

## Alternatives

- **Keep Account Member access as it is and hide engagements in the UI.** It leaves line 944 unmet in the data and
  the API.
- **An assignment column on the membership.** A member works several engagements with different duties; one row per
  assignment keeps each fact once.
- **Require acceptance by changing `app.add_account_member` to create inactive memberships.** It would break API v1
  callers and cut existing members off without warning.
- **Reuse `app.engagement_duty`.** Engagement duties belong to the producing org's people; the account's duties are a
  separate vocabulary with separate grantors.

## Consequences

- Account Members lose the operational area of engagements they are not assigned to when R4 merges. The release notes
  tell account Owners and Admins to assign them.
- The time box gains a fifth area. Policies that list areas by name keep working; a new area opens nothing until a
  read names it.
- Each helper has a single owner. A package that needs another shape widens the helper in its own migration, starting
  from the latest definition.
