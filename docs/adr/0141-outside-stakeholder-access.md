# ADR 0141: Outside Stakeholder Access

- Status: Proposed
- Date: 2026-11-06
- Decider: Owner, on the parity audit approved 2026-10-28 and the deferred theme it left (package B2, RRR-226)
- Migrations: `6500_stakeholder_packs.sql` to `6507_project_outside_access.sql`, `6799_notification_kind_seed.sql`
- Gaps: G-29 (packs), G-30 in part (outside scheduled delivery), G-81 (project access page), G-226 (reusable vendor
  intake), G-293 (public form links)

## Context

A production team reaches people outside its org in several ways: P1's live links (ADR 0130), file share links (1380),
advance and signing links, roster invitations. Each lives on its own page, one link goes to one audience with no record
of who opened what, a vendor starts only from an application or a member's own entry, and a form takes answers only from
members. Competitors bundle these. This package adds the bundle, one list of what reaches a project, reusable intake and
public forms, inside the rules XOS already holds: Section 7.5 invariant 8 as ADR 0033 decision 56 words it, Section 8.6
on exports, Section 8.7 on external views, ADR 0029 item 6 on report files.

## Decisions

### 1. Stakeholder packs

A pack bundles P1 live links and Public or Internal files of one project. Each recipient has an out-of-band 6-digit code,
returned once and stored as a salted hash, 7-day emailed links and a device grant. The grant cookie holds up to 8, so a
device that opens several packs keeps each. An emailed link on a device with a grant opens with no code and swaps the
grant for a fresh one.

Pack events hold opens, views, downloads and acknowledgements. File downloads also go to `app.file_access_log` as Share
Link Opened, the action 1380 writes for a no-account open. The theme asks for opens and signatures there too; that table
is per stored object (bucket and path), its enum has no signing value, and a pack open or an acknowledged live view has no
object. A new value in a shared enum is not worth it. **Owner step (h).**

Files are limited to Public and Internal though A103 lets a share link carry a Confidential PDF, because the theme forbids
Confidential on token surfaces. **Owner step (d).** A pack does not pin a version as 1380 does, so an item serves the highest
version that is not deleted, only if it scanned clean: a newer Pending or Infected version makes the item unavailable rather
than quietly serving an older file.

A typed-name acknowledgement is a receipt, not an e-signature of a contract. No visitor address is kept: behind the Atlas
route it would hold the server's address. One year after a pack ended, a daily job soft-deletes it, and its one-year
retention purges it, so a non-user's name and email leave two years after the pack ended. Org deletion takes every row: the
private tables carry org_id, and download tickets gained it, stamped from the attachment version.

### 2. Outside delivery sends a link, never a report file

Scheduled delivery to outsiders sends a time-limited sign-in link. ADR 0029 item 6 and Section 4.6.4 stay true for report
files: they reach members only. No CSV of a list's rows goes outside, since Section 8.6 limits export to members: a list
reaches outsiders as a live view plus logged file downloads. G-30 names shifts, run of show, rooming and pickups; P1's
registry holds project/schedule, project/show, show/run_of_show, show/day_sheets and display, so shifts, rooming and
pickups reach outsiders only as uploaded files until a later package adds registry rows and a column review (ADR 0130).
G-30 is closed in part. **Owner step (c).**

One-click unsubscribe goes through the `email-unsubscribe` Edge Function, because the Atlas proxy refuses a POST with no
Origin, which is what a mail provider's RFC 8058 POST sends. A GET to the function goes to Atlas's confirm page without
acting, because mail scanners follow links. An unsubscribe also goes on the org's `app.suppression_list`, so the org's other
packs stop mailing that address, and a Hard Bounce or Complaint row stops a send, with B8's rule (ADR 0147 decision 7).

### 3. The access page is a section on Project Settings

S4.5.4-01 fixes twenty project tabs, every project child in the Atlas sitemap is a tab, and a 21st redraws every project
baseline. So Outside access is a section, last on Project Settings at `#outside-access`, reachable from the Engagements tab.
Each row's controls follow `viewer_can_manage` on the view, the check that source's own revoke or regenerate RPC makes, so a
control never shows to someone the RPC would refuse. A one-time code is held in a list, each until dismissed, because it is
stored only as a hash and a second reveal must never lose the first.
Settings is hidden from collaborators, field and viewer roles, and each source's own policy decides the rest. A QR code
appears only at creation or regeneration, since a hashed token cannot be redrawn. **Owner step (f): say if you want a tab.**

### 4. Intake links make an Onboarding engagement on approval

Alternatives considered:

- `app.join_requests` (0861): `app.decide_join_request` creates a membership with an internal role, and external role types
  never grant Atlas access (0310). **Owner step (g).**
- `app.applications` (0775, 1624): an engagement from an application needs an opportunity and an offer.

So intake has its own request table with the join request's shape, reusing its state enum.

Sign-in is required before any Restricted value: `app.tax_forms` needs a payee, `app.submit_tax_form` needs a person, and
token surfaces never carry Restricted data. So the no-account part ends at reading the intake, unlike a competitor's fully
account-free link. **Owner step (e).**

Payout is a reference only, in provider Accounting System, since XOS never holds funds and Stripe Connect stays deferred
(ADR 0033 decisions 20 and 66). This one field is the named exception to ADR 0072 section 5, which says payout details are
entered through each org's provider, and it holds no bank data: bank-shaped values are refused, because
`provider_account_reference` is Confidential plain text and S4.4-38 requires bank details encrypted or held by the provider.
0730 still grants a direct insert and update that cannot refuse, so the reference is checked again at submit and at
approval. A numeric AP vendor number such as 100234 is refused as a false positive; the refusal says to use the reference
with its letters or prefix. G-226 names bank details. **Owner step (b).**

The intake signature applies only to the pinned version; a document with a newer version stays Sent for the party to sign
in Gateway. The first invoice waits for the money area (Section 8.7). A request declined or withdrawn takes the tax form and
payout row written for it when nothing else needs them. An intake abandoned before it was sent cannot be detected the same
way, so those rows stay until the org's own retention or the person removes them: a known limit, in the counsel owner step.

### 5. Public form responses become records only when approved

For link responses only, this departs from Section 4.9, where a member's submission makes its record at once. Spam can
then create no records. **Owner step (a).**

Owner ruling of 2026-11-06 on Section 7.5 invariant 8: a QR code or link alone opens nothing, and anyone not on the platform and on the project is onboarded first. So the link's token and code open only the sign-in step: `api_public.public_form` and `submit_public_form` refuse without a person (`form_link_sign_in`), and the respondent's name and email are their account's, never typed. Every link names a project (`form_link_project`), so Outside access can always show, revoke and regenerate it. A response gives the person nothing on the project: it waits for a member's decision. **Owner step: say if a response should also start project onboarding.**

Spam controls: a 6-digit code, a 2-hour grant, a 3-second minimum fill time, 10
submits an hour per relayed address and 500 per reaching address, a cap in any rolling 24 hours, an optional total cap, one
response per email, answers of at most 32 KB, and a hidden website field that answers ok and stores nothing. No CAPTCHA: it
would need an external service account. Photo, signature and GPS fields stay member-only. Respondents' names and emails
follow `app.form_submissions`' default retention, and they stay as answered if the account is later deleted (counsel step).

The frozen `FormSubmission` schema requires a member submitter, so `formSubmissions` never answers a link response;
an additive `formLinkResponses` resource does.

### 6. Gateway's sitemap gains two token nodes, with no Atlas mirror

`/onboard/{token}` and `/forms/{token}` amend ADR 0006 as ADR 0029 item 10 did. A mirror in Atlas's sitemap with
`servedBy: gateway`, as advance-form has, would make `/forms` and `/onboard` first segments in Atlas, which need
`private.reserved_org_slugs` rows and could collide with an existing org's slug on production. `packages/ia` requires only
that a servedBy node has a host route, not the reverse, and Atlas builds the links with `gatewayUrl`.

Every `/share/pack` page keeps the cookie banner and loads no product analytics: the root layout decides from the path
alone, and the path does not say whether an item is a display.

### 7. Locked reusable links and P1's readers

A reusable link has one code, so one stranger can lock it for every vendor with 5 wrong codes. Outside access shows Locked
with Regenerate. 6501 refactors P1's readers with no change in behavior; a later package touching
`private.live_link_reader`, `api_public.live_view` or `api_public.live_display` starts from it.

## Consequences

- Twelve new anonymous token RPCs (threat model section 1), each with a token and a code, an expiry within 90 days, a
  lockout at 5 wrong codes, per-address failure limits and page-only fields with exact key sets.
- Pack email needs `XOS_POSTAL_ADDRESS` and `XOS_APP_URL` on `report-run`; a pack delivery fails with the reason while either
  is unset, and report deliveries keep working.
- Pack live items use P1's xlink channels, so production Realtime must accept the anonymous private-channel join P1 needs.
- Until then they refresh by pull.

## Amendment 2026-11-07: the link rulings of ADR 0142

The owner's rulings of 2026-11-06 (ADR 0142) hold here as well. A stakeholder pack, a vendor intake link and a public form
link all belong to a project, and each stops opening when that project is Complete or Canceled, or is archived or in Trash:
`pack_link_ended`, `intake_link_ended` and `form_link_ended`. The refusal comes at each family's one choke point
(`private.stakeholder_pack_state_reason`, the open function and the reader), before the lockout and the code, and says only
that the link has ended. Reopening or restoring the project lets unexpired links open again. A pack's files already need the
recipient's code, which keeps the ruling that file shares always take one. The display link a pack carries is a live link,
which 6280 already ends with its project (carried into 6501's `private.live_link_reader`).
