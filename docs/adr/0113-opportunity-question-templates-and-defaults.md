# ADR 0113: Opportunity Question Templates and Defaults

- Status: Accepted
- Date: 2026-10-28
- Decider: A136 (RRR-199), under ADR 0022's post-4.0 migration blocks
- Migrations: `2290_opportunity_templates_and_defaults.sql`

## Context

Section 4.5.6 item 27 puts the Gateway and marketplace settings in one place, and Section 4.4.3 describes an
opportunity's visibility, compensation, deadline and application questions. Before A136 every posting started blank:
the create form always offered Invited, Rate on Request and no deadline, and application questions were typed one at a
time on each posting. An org that asks the same questions on every crew call, or always posts to its pools at a day
rate, retyped them each time. A136 was scoped to record its modeling decisions in ADR 0065, which by then held the
carrier client credentials decision, so they are recorded here.

## Decisions

### 1. Templates are copied, never linked

`app.application_question_templates` holds an org's named question sets and `app.application_template_questions`
their questions (prompt, order, required). `app.apply_question_template` copies a template's questions into
`app.opportunity_questions` (0720) of a Draft opportunity, after the questions it already has. The opportunity keeps
no reference to the template.

Applicants answer an opportunity's questions (`app.application_answers` points at `app.opportunity_questions`), so a
posting's questions must not change under applicants when someone edits a template, and an answer must keep pointing
at the question that was asked. Copies give both, keep the existing question editing on the posting, and leave
0720's tables, policies and `private.guard_opportunity` (1623) untouched.

The copy is limited to Draft opportunities: once a posting is submitted for approval its questions are reviewed as
they stand, and questions added later are added one at a time as before.

### 2. Defaults are prefill, not a database default

`app.opportunity_defaults` is one row per org: visibility, rate type (the pay basis), currency, an application
window in days and a default question template. Atlas reads it to prefill the create form, and the person creating
the posting can change every value before saving. Nothing in the database applies it to an insert.

A column default or an insert trigger would apply the org's choices to every path that creates an opportunity,
including the API and imports, where the caller states what they want and does not see the defaults. Prefill keeps
the form honest: what is saved is what the person saw. The application window becomes a deadline of that many days
after the form opens; the defaults store the window rather than a date because a date goes stale.

The defaults do not loosen any publishing rule. `gateway.marketplace_visibility` still caps the visibility (1327), and
the form offers only the visibilities it allows, so a default above the cap starts the form at the cap
(`defaultVisibility`, matching `private.marketplace_visibility_cap`). Public still needs the plan, and pay transparency
still runs at publishing.

### 3. Who reads and who writes

Reading templates and defaults takes `opportunities.posting.read` org-wide, or `opportunities.posting.write` on any
project of the org (`private.opportunity_template_reader_org_ids`): a coordinator who creates postings on their own
project starts from the same defaults as everyone else. Writing them takes `opportunities.marketplace.manage`, the
capability for the rest of the marketplace settings. `app.apply_question_template` is a security definer RPC that
takes `opportunities.posting.write` on the opportunity's project, the same rule as the questions' own write policy,
and a template the caller reads.

### 4. Creating a posting from a template is two calls

The create action inserts the opportunity, then applies the chosen template. When the copy is refused (the template
was deleted while the form was open), the draft is already saved and the form says so, naming the fix, instead of
offering to save it a second time.

One RPC that inserts the opportunity and copies the questions would be atomic, but it would restate every column of
`app.opportunities` and its write path, which the repository already owns. The failure is rare, visible and fixed on
the draft.

### 5. Trash

A deleted template is in Trash and restored by a marketplace manager through its own update policy (ADR 0110). Its
questions are not soft-deleted with it, so a restore brings them back as they were. Template questions are removed
and added again in the template, and the defaults row is edited in place, so both tables are listed in
`private.trash_excluded_tables`.

## Alternatives

- Store defaults as registered settings (`packages/schemas/settings`). Rejected: a template reference and a set of
  questions are records with their own policies, and the settings registry holds scalar values.
- Link a posting to its template and read questions through it. Rejected for the reasons in decision 1.
- Apply defaults in the database. Rejected for the reasons in decision 2.

## Consequences

- Settings, Gateway and Marketplace gains a panel for the defaults and templates, with links to Pools and Onboarding.
- New postings start from the org's defaults and its default template; the trace row S4.5.6-27 records it.
- The API and imports create opportunities as before, from what the caller sends.
- The defaults gain `hide_client_until_booked` (P10, migration 2870): new postings can start with the client and event hidden from crew until they are booked, editable on each posting before it is published.
