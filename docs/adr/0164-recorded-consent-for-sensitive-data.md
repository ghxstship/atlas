# ADR 0164: Recorded Consent Before Sensitive Data Is Saved

- Status: Accepted
- Date: 2026-11-06
- Decider: Owner instruction of 2026-11-06 to take the most future-proof, legally defensible option. These calls were made by AI; no attorney has reviewed them.
- Extends: ADR 0105 (restricted allergies), ADR 0102 (profile facts and project facts)
- Supersedes: the part of owner decision 4 (ADR 0100) that let a company read a rostered person's dietary and accessibility needs
- Migrations: `6160_sensitive_data_consent.sql`, `6161_sensitive_data_restricted_reads.sql`, `6162_guest_needs_and_attestation.sql`, `6163_sensitive_data_backlog_and_report.sql`, `6164_notification_kind_seed.sql`

## Context

Allergies, dietary needs, accessibility needs and supplier diversity status could be typed in with no consent wording. Typing a
value is not consent. These values can reveal health, disability, religion, race, sex, sexual orientation or veteran status, and
the Washington and Nevada consumer health laws, GDPR Article 9 and the ICO's own events practice all point the same way: say what
is collected, why, who sees it and how to withdraw, and record the answer. The counsel packet leaves open whether each category
is health data in each place, so this design takes the protective reading for all of them.

## Decisions

### 1. One rule in the database

`app.sensitive_data_consents` holds one row per grant: category, basis, wording version, language, surface, who, when, IP address
and withdrawal. It changes only by a one-time withdrawal, and by naming the person on a guest's attestation once a verified sign-in
matches its email. The web apps reach the database through their own server, so they pass the address they saw, as
`app.record_legal_acceptances` does; the API forwards it and Compass calls directly, so there the request carries it. It is evidence,
not an access control. The triggers on `app.person_work_details` and
`app.supplier_diversity_certifications` and the RPC of the roster travel request refuse a new value with no standing grant
(`sensitive_consent_required`). So Atlas, Gateway, Compass, API v1 and direct PostgREST writes meet one rule. Clearing a value
never needs a grant, nothing else on the row or the form needs one, and no field became required. A migration, a seed or a
scheduled job (`postgres`, no signed-in person) writes without one; a service role request does not count as that.

### 2. Consent is specific and versioned

Three categories, each with its own grant: Dietary and Allergies, Accessibility, Supplier Diversity. The wording is in
`workDetails.consent.notices` in en-US and es-US, and it holds all of it: what a person consents to, and what someone attesting
reads and states. `private.sensitive_notice_versions` holds each version with a hash of the exact text in both languages, and
`packages/data/test/sensitive-consent.test.ts` fails when the wording changes without a new version. A guest's two categories each
send their own version. A retired version is refused, and a grant under an earlier version still stands.

### 3. The apps show the step before the fields

The fields stay off the page until the person has read what is collected, why, who sees it and how to withdraw, and agreed. The
step loads behind the button, and no form gained a field. A meal preference on a project shows the same step in place of its one
field; the rest of the travel form still saves.

### 4. Withdrawal stops use and clears the values

`app.withdraw_sensitive_consent` is one call from the same place as the agreement, one button and one confirmation. It clears the
values, takes the category off every share, and clears what was attested about the person. A supplier diversity certification is
de-identified (kind Other, body Removed, number, dates and evidence path cleared) and soft deleted, so the owner's access log still
points at a row. Under a legal hold the same rule as account deletion applies: the values stay, hidden from everyone, and the daily
job clears them when the hold ends.

### 5. Someone entering it for someone else attests

A guest's needs have their own table, `app.guest_care_needs`, beside the entry. Whoever keeps the entry confirms two statements:
they have the person's authority, and the person has had notice. The dialog shows what those statements are about: what is entered,
why and who reads it. The attestation records who gave it. An email matching a verified sign-in names the person, who is told
(`account.sensitive_data_attested`), sees it under Work Details and removes it in one step. The company that rosters a person attests
the same way before it enters their meal preference. A company's supplier diversity status is declared under the attestation of the
Owner or Admin who declares it.

The record says who attested, about whom. Another keeper entering values, or another person matched by a changed email, closes the
attestation and opens a new one, and the person newly matched is told. An account opened or an address confirmed later is linked by
the daily job, or sooner when the person acts, and they are told.

A person who withdrew a category cannot be attested back into it. Refusing the email would answer whether an address has an account,
and that its owner withdrew, which is itself sensitive. So that category is simply not saved, and the answer, the attestation and the
audit entry are the same as for any address. Only the person's access log shows it. The keeper sees that they attested, which is true,
not that needs are on file, so nothing they are told is false.
The company that
rosters a person knows them, so it is refused (`sensitive_person_only`) in words that do not say they withdrew.

### 6. Only the roles that need it read it

Dietary needs and notes and accessibility needs and notes join allergies as Restricted under `data.restricted.read.medical`, on
ADR 0105's terms: never directly selectable, read through a function by the Owner and, on their project, the catering lead and
on-site medical roles, every read logged. A hospitality reader sees them locked. A company never reads them. Catering planners keep
counts of five or more. A meal preference is dietary data and takes the same terms everywhere it is read (`app.roster_project_facts`,
`app.roster_travel_party` and API v1 roster facts). It is on the project already, so it needs no separate share: holders on that
project read it, logged as `meal_preference.viewed`. It reads as absent while neither the person's consent nor the attestation of the
company that rosters them stands, and locked to everyone else who should know one exists. The company cannot read back even what it
entered, and its form sends nothing to leave a value as it is, so it cannot test a guess either. `app.request_export` refuses any column under this capability, so a standard export carries none for
anyone; a holder downloads guests' needs through a logged read, and a project's rostered people have no such export. A supplier
diversity kind is Restricted under `data.restricted.read.government_id`, and an org reader needs that as well as
`vendors.vendor.read`. We added no capability: `capabilities.yaml` generates the applied 0203 seed, which cannot be rewritten, and a
code outside the registry fails its check. These two already fit, but the second also unlocks the reveal of other government
identifiers (under step-up, a reason and a live share), so an organization should grant it narrowly.

### 7. No consent is invented for what is already held

A value from before this has a field record with no consent. It reads as absent to everyone but the person from now on, and the
person keeps seeing it. The daily job tells the person once (`account.sensitive_consent_needed`). Agreeing keeps it; otherwise it is
cleared 30 days after that notice. Only a notice that went out starts the clock, and a failed one is tried again the next day. Someone
with no sign-in cannot be told, so their 30 days run from when the wait began. Saving the rest of a form ends no wait: only a grant
does, or clearing the value. A meal preference a company later attests to stands on that attestation; one on another entry goes on
waiting. Marking existing data as consented would have been a false record.

### 8. A field-level record

`app.sensitive_field_records` holds, per subject and field, the grant the value stands on, who entered it, when, and when it was
cleared, never a value. A person's meal preference is one record across their roster entries, kept by a trigger so that every path
that removes one is covered. `app.sensitive_consent_report` gives data.request.manage holders the consent state per subject and field,
listing every field a subject's category covers for that org, so it does not even show whether a value is held. Whoever an org rosters
is listed for their meal preference. A company's attestation is shown against the meal preference and nothing else.

### 9. Free text is a backstop, not a classifier

`private.looks_sensitive` refuses the common words, in English and Spanish, where no consent step exists: a guest's door note
(`guest_note_sensitive`), a roster entry's travel notes (`travel_note_sensitive`), a mapped import column (`import_sensitive_column`)
and a custom field label (`custom_field_sensitive`). An import cannot record one person's consent for many rows, so it refuses the
column and the rest of the sheet imports. `private.question_looks_sensitive` does the same for a question to fill in
(`question_sensitive`): application questions and their templates, surveys and no-code forms. It is narrower, so a venue checklist's
"Accessible routes clear?" and a certificate's "Allergen awareness" still pass.

### 10. Deletion and legal holds

A guest's needs are deleted when the entry is removed or declined, and 90 days after the project ends: its last day, or when it was
archived or deleted. A project with no end date never ends, so they go a year after they last changed. Account deletion closes what a
guest list holds about the person, under their person or only their verified email. A legal hold over the org's guest needs, or over
the person they name, defers every deletion. Use still stops: the attestation closes, nothing reads the values, and the daily job
deletes them when the hold ends. A hold over a company's certifications defers their de-identifying the same way.

## Alternatives

- **A checkbox on each form.** Adds a field to forms at the seven-field limit, and a bundled tick is weak evidence of specific consent.
- **Mark existing values as consented.** Quicker and false.
- **Keep Confidential and read by hospitality capability.** Reaches every hospitality reader, which is not need to know.
- **A new capability for accessibility readers.** Needs a rewrite of an applied seed. Custom roles can already hold the medical one.
- **Attested imports, one tick for the whole file.** Cannot show that each person had notice.

## Consequences

- A person with no consent sees a short step where the forms were; everything else works as before.
- A hospitality reader who planned from dietary lists now sees counts, or needs the catering lead role on the project.
- Org readers with only `vendors.vendor.read` no longer see shared certifications.
- `private.looks_sensitive` will sometimes refuse an innocent door note; the message says what to do.
- A question's wording is only a backstop: "Anything we should know?" passes, and its answers can hold this data. So can other free
  text (BEO notes, advance answers). Nothing here reads answers; the Acceptable Use Policy says not to. Onboarding requirement names
  are not checked: they name documents, and "Allergen awareness" and the like are legitimate.
- An import's uploaded file and its parsed rows can hold a column nobody mapped until the import's retention ends.
- An evidence file already uploaded stays in storage until the row purge runs, the known gap in the Retention Policy.
