# ADR 0149: Account-Free Crew Access, Registration and Generated Agreements

- Status: Proposed
- Date: 2026-11-06
- Decider: B10 (RRR-234), gaps G-125, G-129, G-130 and G-132; the owner decides on review
- Migrations: `6520_crew_access_links.sql` to `6526_pool_invitation_import_target.sql`, with its kinds in the train's seed `6799_notification_kind_seed.sql`

## Context

Large crews reach first value slowly. Competitors offer field crew a login with no account, a public recruitment page, an agreement generated per person from one template, and an import of a freelancer list. XOS identity has firm rules: a person exists only through their own sign-in (ADR 0008), person-owned rows stay person-owned (ADR 0019 item 10), and the person accepts each relationship (advancing decisions 0 and 1). This ADR records how those four gaps close inside those rules.

## Decisions

### 1. No seatless identity

A person exists only through their own sign-in. Imports, registrations and links invite or ask the person, and never create people or profile rows. The consequence, stated plainly: a link frees a worker from signing in on site, but someone who has never accepted anything cannot be on a shift, so they accept an invitation once. Every shift worker is already a person who accepted something while signed in (`shifts_one_worker`, `private.shift_worker_person_id`). An agency slot, a company engagement with no person, resolves to nobody and gets no link.

Event Lab's seatless logins go further. Going further would need a change to ADR 0008 and to advancing decisions 0 and 1, which the owner has not made.

### 2. Crew access links

`app.crew_access_links` is another token flow beside advance forms, signing links, approval links, live links and showcaller links (Section 4.4.6, Section 7.5 invariant 8):

- One live link per worker and project, for 1 hour to 30 days, 7 by default. A token `xcrw_` plus 64 hex and a 6-digit code, stored only as SHA-256 hashes and shown once. A wrong code is counted and the fifth locks the link.
- The link closes as soon as the worker stops working (a membership ended, an engagement outside Active or Closing, a roster entry not accepted by both sides), the project or org is removed, or the person deletes their account.
- The read returns rendered fields only: the worker's Published, Accepted and Canceled shifts on the one project, from 12 hours ago to 14 days ahead, with job title and venue as text (S5-29 keeps maps deferred). Never a rate, a note, a Draft or another worker.
- One write: the worker accepts their own Published shift. No session is created. No punching (kiosk PINs, Compass and R12's supervisor punches cover time) and no decline (declining stays signed-in, with a reason).
- Gateway keeps a right code in an httpOnly, Secure cookie with `Path=/shifts/{token}`, for the shorter of 12 hours and the link's life. It is `SameSite=Lax`, not Strict, so opening the link from a text message or a QR scan does not ask again in that window; the token is still required, every request rechecks through the RPC, and accepting runs only as a same-origin server action.
- A printed card never carries the code. By the owner's ruling of 2026-11-06 on Section 7.5 invariant 8, a QR code or link alone opens nothing, because a guest or patron could scan one left in place; a code printed beside it would be a link alone.
- A read-only org keeps reads working, which matters to a worker on site, and refuses the write for anyone (`crew_access_read_only`). Links are exempt from the read-only guard so that a wrong code is always counted.

### 3. Registration pages

`app.registration_pages` is an org's public page that fills one of its Talent pools.

- A registration is not an opportunity. Opportunities are project-scoped postings with a deadline, positions and an application board, and pools are org objects with no project.
- It is not an invite link or a join request either (0861): those lead to org membership and a role, while a registration fills a pool and gives no role. This is the distinction the G-129 evidence turns on.
- A link alone shows the page's public copy only: the questions, like everything else, wait for sign-in (owner ruling on invariant 8). The page holds nothing sensitive and takes no token, the same standing as a public listing; the person is onboarded before they answer anything. The pool is never external (S4.4-27): no page, email or notification names it.
- Registering needs an account, and the person confirms the page's minimum age, 18 to 99 by self-confirmation. The owner's decision of 2026-11-06 makes 18 the account minimum, so nothing here goes below it. The minimum age is recorded on the registration and is fixed once the page leaves Draft.
- A Do Not Engage person, a closed or missing page, a deleted pool and a read-only org all get the same refusal, so neither the flag nor the org's billing state ever shows.
- A registration, the profile sections it shares and the work phone it saves are written in one transaction, so a refused registration shares nothing with the org.
- Every plan has registration pages, including plans without public marketplace listings (Pro, 0720). This gives lower plans a public recruitment page; the owner confirms that choice.

### 4. Generated engagement documents

An org writes its own wording once, with merge fields from a closed list, and generates one engagement document per person. XOS supplies no wording.

- The text lives with the engagement document and not in `app.agreements`: onboarding items, the Gateway Documents tab and the engagement lifecycle read the document, and an agreement carries no engagement.
- The data layer merges as the caller, so the batch trusts a caller who already holds engagement write; a rate or a shift the caller cannot read is missing, never merged as empty, and a person with a missing field is left out. The database refuses text still holding a merge field.
- The hash is computed, never stored while unsigned. The text freezes from its first send and after signature.
- A rate is Restricted. A body that uses `engagement.rate` is masked, with neither the body nor its hash, for an org reader without `data.restricted.read.payroll` and for a representative without Settlement scope, because a SHA-256 of a text that differs from known wording only by a number can be guessed offline. The title never uses the rate, because every engagement reader reads it and it travels in the notification. A template's wording is fixed once a batch references it, because the mask follows the template's text; a call whose every entry is refused leaves no batch, so it fixes nothing. The engaged person always reads their own text, since Onboarding and Blocked do not open the money area and that is when they sign.
- Decline is Sent to Canceled, with no new enum value in the frozen API.
- Executed verifies an Automatic Electronic Signature item, with no reviewer, under a trusted operation. The engaged person cannot countersign their own (`sod_onboarding_self_verify`). A Reviewer item is verified by a reviewer as today.
- One button never signs a generated document: every other signing path refuses it, and a signing link for one is refused when it is issued. Gateway's Home, engagement Overview and Documents offer Read and sign through the Documents tab instead (`signsInOneClick`).

### 5. Pool invitations and the import target

- An org invites an address into a Talent pool, one at a time or from a spreadsheet. The invitee claims it by signing in with that confirmed address; no token travels. The org's label and phone and the invitation's copy of the rate are cleared at the claim, so the person's own name and shared fields take over.
- Email plus pool is the strong key, on pending rows, expired included. A pending match updates with no new email and an expired one is reissued.
- In merge review, Merged means the row is skipped, because the person is already invited or in a pool. It never updates a pool member. Kept Separate sends a new invitation.
- Rates are Restricted and informational (S14.9-10): XOS pays no one. An import writes a rate only for a creator with payroll org-wide, and an update never places a rate that is already there into the before image, which every pool writer reads.
- Contact details of people who never joined are for pool managers only (`opportunities.pool.write`), not the wider application read.
- Someone who declined is not invited into that pool again for 12 months, and an org queues at most 2,000 invitation emails in 24 hours. The platform party_invitation queue has no suppression list, and an import turns one typed address into a whole file.
- The number format is per import and sets separators only (1,234.56, 1.234,56, 1 234,56 or 1'234.56). Phone parsing loads lazily, only when a phone column is mapped, so the import-run boot ceiling of 120 KB does not move. The default phone region comes from the org's language setting.

### 6. No API v1 change

The new RPCs are reached through `@xos/data` only. oasdiff shows no difference.

## Consequences

- Account deletion's reach grows: registrations and claimed invitations give an Erasure row, a legal hold on the new tables blocks the deletion, and the person's answers, invitations and standing rates are hard deleted while the pool membership stays with a blank name.
- The Better Stack log drains must mask `/shifts/` and `xcrw_` (`infra/runbooks/production.md`).
- Maps and payments stay out of scope. A counsel-reviewed agreement template is a later decision.

## Amendment 2026-11-07: the link rulings of ADR 0142

A crew access link belongs to a project and stops opening when that project is Complete or Canceled, or is archived or in
Trash (`crew_access_link_ended`, owner ruling of 2026-11-06 in ADR 0142), checked in `private.resolve_crew_access_link`
before the lockout and the code. A registration page belongs to a pool, not a project, and shows only public copy without
an account, so the ruling does not reach it. A generated agreement is signed through the document token resolver, which
6280 already ends with its project.
