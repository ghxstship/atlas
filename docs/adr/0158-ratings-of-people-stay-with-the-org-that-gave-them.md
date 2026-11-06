# ADR 0158: Ratings of People Stay with the Org That Gave Them

- Status: Accepted
- Date: 2026-11-06
- Decider: Owner (Julian Clarkson), who directed that each open legal decision take the most future-proof, legally defensible option. The analysis below was prepared by AI. No attorney has reviewed it.
- Amends: ADR 0038 where it describes what a marketplace viewer sees and where it lists the moderation grounds, and Section 4.4.3 where it treats an org's rating of a person as public
- Tracks: RRR-248

## Context

`api_external.ratings` returned every released rating, with `rated_person_id`, to anyone signed in. It runs with its owner's rights, so row level security did not stop it. The Gateway profile page loaded ratings only for their owner, but the rows were one PostgREST call away.

XOS is used for hiring. Under the Fair Credit Reporting Act a consumer report is a communication bearing on a person's character, general reputation or personal characteristics, used or expected to be used for employment, and a consumer reporting agency is whoever regularly assembles or evaluates such information to furnish it to third parties (15 U.S.C. 1681a). An organization's report of its own transactions and experiences is excluded. That exclusion fits an org reading its own record. It does not obviously fit a platform relaying one org's rating of a person to another org. A disclaimer does not cure the fact pattern, and CFPB Circular 2024-06 having been withdrawn in 2025 does not clear it: the statute is unchanged. Whether the risk is real on these facts is an open question.

## Decision

### 1. Who reads a rating

| Rating                                 | Who reads it                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| An org's rating of an individual       | Members of the org that gave it, and that person                                   |
| An org's rating of a company or vendor | As before: anyone signed in. The row no longer names the company's contact to them |
| A party's rating of an org             | As before: anyone signed in                                                        |

- A rating is of an individual when the engagement names a person and either has no engaged account or is for crew, staff, a contractor or an artist that the account supplied (`private.rating_is_of_individual`). An engagement can name a contact as well as the account, so naming a person cannot be the test alone: a vendor, client, sponsor or agency engaged through an account is a company, whoever its named contact is, and so is a company whose own bid won Contractor, Staff, Crew or Artist work (the application has `applicant_organization_id`). `app.create_engagement_from_application` names only the account for such a bid; an engagement made directly from it may also name a contact.
- Crew, staff, a contractor or an artist supplied through an account are individuals. That account does not read their rating or answer it.
- A partner on a shared project, or the holder of a record grant from another org, may read the engagement but not the rating of an individual.
- The rule is in row level security on `app.ratings` and `app.rating_replies`, and in the row filter of `api_external.ratings`. API v1 reads `app.ratings` under that security, so no v1 field, filter or list reaches another org's rating of an individual. No v1 operation changed.
- A one-person vendor is treated as a company: the database has no marker for a sole proprietor, and a vendor's rating comment can name a person. The Consequences list both as residual risks.

### 2. The opt-in

- `app.rating_sharing_consents` records the person's own opt-in: off until a row stands, with the notice version, source, time and IP address, one row per grant. Withdrawal closes the row and takes effect at once, since every read checks it. Deleting the account withdraws it. A closed row is purged 7 years after it closed, and the deletion preview says so.
- Only the person's own session chooses. An OAuth app's or MCP connector's token is an ordinary signed-in JWT and the `app` schema is exposed, so `app.set_rating_sharing` refuses any session with `private.api_key_scopes()`, in both directions. Filing a dispute and answering one refuse the same sessions, since each is a once-only act. The notice version comes from the page the person saw; a stale page records the older notice, which is what they saw.
- It covers every rating or none. A person cannot show only the favorable ones.
- It opens one path: `api_public.person_profile_shared_ratings(handle)`, on that person's profile page. One person at a time, in date order, with no average and no rater named. It does not open the table or the view, and no sort, filter, search or score across people can be built on it.

### 3. Hiring surfaces: not shown, even with opt-in

The question was whether a hiring, recruitment, crew assignment or eligibility surface may show a person's cross-org rating with their opt-in. We cannot show such a use would not bear on eligibility, so it does not show. The database enforces this in addition to the screens simply not reading it:

- `private.viewer_decides_hiring()` is true for anyone who holds a capability that decides who is hired, booked, selected, approved as a supplier, put on a shift or roster, or let into the org or a project, or that gives out such access (`private.hiring_capability_codes()`), at any reach or scope, in any org or on any project, by role, grant, delegation or record grant. Such a viewer gets nothing, even from the opted-in person's own profile page.
- On the external side it is true for the people who manage a crew roster or book for someone else, none of whom hold a capability: anyone who runs an external account, a live Advancing Lead on an engagement, an artist's representative in any scope, and anyone engaged as an Artist, who manages their own roster. The last three count whatever state the engagement is in, so someone between jobs stays out: that fails closed, and it only costs them reading a peer's list. A Member duty, Account Finance and a freelancer with no roster to manage do not count.
- A session scoped to an API key or an app reaches less than the person holds, so it cannot show they decide no hiring. It counts as deciding and reads nothing.
- No application, pipeline, shortlist, pool, roster, shift, availability ranking, marketplace search or recommendation reads ratings of people. Marketplace discovery and its `recommendation_score` read no ratings. The unused `averageScore` helper in `packages/data` is gone.
- Who can read a shared rating: someone signed in, in their own session, to whom the profile is visible, who holds no hiring, booking or staffing access in XOS. XOS only knows what it grants: someone who hires outside XOS, with a free account, could read it. The notice says so, and the person chooses knowing that.

### 4. Seeing and disputing

- The rated person reads every released rating of them, with which org gave it, on Gateway's profile page.
- `app.file_rating_dispute` is the route: one dispute per rating, once released, by the rated individual only. The org that gave the rating may answer once (`app.respond_to_rating_dispute`). A platform operator with `moderation.decide` decides with a statement of reasons in the console (`/rating-disputes`); the person and the org are told, naming the platform and not the operator. The `rating_dispute` lifecycle is Open to Upheld or Not Upheld.
- Upheld takes the rating out of every product read: Gateway, Atlas, the API, a shared list and the org's own view. It stays as evidence in three places, none of which crosses to another org: the rating row is not edited, the insert stays in the rating org's audit ledger for holders of `audit.log.read` (the score and comment are not Restricted columns), and the console keeps showing the comment to the operators who hold `moderation.decide`. `app.rating_dispute_subjects` still tells both sides which rating it was (the org, the person, the project and the date), without the score or comment, so the org can answer knowing what it is answering and the person keeps the decision on Gateway.
- Separation of duties: the rated person never answers for the org (`sod_rating_dispute_answer`), and an operator who belongs to the rating org never decides (`sod_rating_dispute_decide`). No screen or notice outside the console names the deciding operator, and the dispute's ledger hides who acted. The rating org's audit ledger still records the acting person id, as it does for every operator change to a tenant row (A90).
- An operator may uphold only for a named ground: the wrong person, a false statement, abusive content or personal data. The person may file with Other, but a dispute is not upheld on it. The queue and the detail never show the score.
- Filing does not hide the rating. A shared rating shows a Disputed tag while the dispute is open.
- An org's soft delete of the engagement hides nothing. The rated person keeps reading, answering and disputing the rating, it stays on a shared list, and the party can still rate the org, because `private.my_rated_engagement_ids`, `private.my_party_engagement_ids` and the shared path do not look at the engagement's `deleted_at`. The rule stays on the rating's own terms: only an operator's decision removes one.

## Why this is not review suppression (16 CFR Part 465)

ADR 0038 stands: ratings are always on, `gateway.ratings_enabled` controls prompts only, and nothing lets an org hide, remove or filter a rating. No view, policy or function reads that setting. This ADR does not change any of that.

The FTC rule (16 CFR 465.7) reaches a business that controls a review website and suppresses reviews based on their rating or negative sentiment while representing that what is shown is all or most of the reviews. Limiting who reads a rating by relationship is a different thing:

- **The rule is content-neutral.** It looks at who is asking and which engagement the rating came from. No path reads the score or the comment. A five-star rating of a person and a one-star rating of a person are restricted in exactly the same way, and so are a person's and a company's whatever they say. pgTAP proves a low score reads for the same people as a high one.
- **Nothing is represented as complete that is not.** There is no public list of a person's ratings that omits the negative ones. A shared list is every released rating, except one an operator removed on a named ground; it says exactly that, and the person cannot pick.
- **Nobody can suppress a negative rating.** The org cannot, not even by soft-deleting the engagement it hangs from, the rated person cannot pick (all or none), and filing a dispute hides nothing. Removal follows an operator's decision on grounds the rule itself recognizes, applied whatever the score, and the operator does not see the score.
- **Company ratings keep their reach,** so a negative rating of a company still reads for everyone it did before.

Whether Part 465 applies to ratings between organizations and workers at all is unclear (FTC guidance does not address B2B). This ADR treats the rule as the standard anyway.

## Other personal review data checked

| Data                                            | Finding                                                                                                                                                                              | Action                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `app.person_references`                         | The person lists them and controls the section's visibility. They are not assembled by the platform from another org. A statement can be read by a hirer, if the person publishes it | None. Listed for legal review |
| `app.person_certifications` verified by an org  | A fact and who verified it, in a section the person controls                                                                                                                         | None. Listed for legal review |
| `api_public.person_profile_organizations`       | Names orgs a person worked with, in a section the person controls. No opinion                                                                                                        | None                          |
| Pool standing, Do Not Engage, `rehire_eligible` | Internal to the org by policy, and never in `api_external`                                                                                                                           | None                          |
| `app.vendor_scorecards`                         | Org-scoped through `vendors.vendor.read`, about vendors                                                                                                                              | None                          |
| Application review and interview notes          | Org-scoped                                                                                                                                                                           | None                          |
| Training and form scores                        | Org-scoped                                                                                                                                                                           | None                          |

## Consequences

- `rated_person_id` stays on the view, additively, and `rater_organization_name` joins it; the rows changed, not the shape. On a company's rating, `rated_person_id` now reads only for the named contact and the org.
- A new capability that decides hiring must join `private.hiring_capability_codes()`. pgTAP suite 6145 fails when any capability, in any group, is neither on that list, nor named as not deciding hiring, nor in a group named as not deciding it. It also fails when `private.engagement_party_areas` gains a way into a roster, or the account roles or duties change, until the change is read against `private.viewer_decides_hiring()`.
- pgTAP suite 6145 also fails when an owner-rights view reads `app.ratings` without `private.internal_rating_engagement_ids()` and `private.removed_rating_ids()`, or a new function reads `app.ratings` without being classified, so a later package cannot undo this unnoticed.
- `app.crew_ratings` (B9, on `orch-train-10` as migration 6517) is such a view, and that gate will fail when it merges. The merge must add a follow-up migration above its block, named `<next>_crew_ratings_person_rule.sql`, that recreates the view with `g.id not in (select private.removed_rating_ids())` and `g.engagement_id in (select private.internal_rating_engagement_ids())` in place of `private.internal_engagement_ids('opportunities.engagement.read')`. Migration 6525 on that branch also redefines `private.account_deletion_tables()` without `app.rating_sharing_consents`; the same follow-up restores it.
- A one-person vendor engaged through an account is still a company here. If a marker for a sole proprietor is added later, those ratings should follow Section 1.
- A company's rating is free text and can name a person. The contact it names may not dispute it through this route; the Acceptable Use Policy's report routes remain, and a later change could extend the route.
- A hirer who holds no hiring capability in XOS, or who reads a screenshot a person's friend took, is out of reach. The notice says so, and the Acceptable Use Policy's bar on screening with ratings is the remaining control, and it is not a cure.
- An engagement a member entered by hand, naming a person and an account for Contractor, Staff, Crew or Artist work with no application behind it, counts as an individual. That is the stricter reading: the account's owner loses sight of it until the data says otherwise.
- A rating dispute has no appeal to a second operator. With one operator, that review could not be kept. For the same reason, with one operator a dispute of a rating by an org that operator belongs to cannot be decided until a second operator exists.

## Alternatives considered

- **Treating any engagement that names a person as an individual.** Simpler, and stricter, but vendor engagements commonly name a contact, so it would have made those vendor ratings private, which the owner ruled out.
- **FCRA-compliant handling** (permissible purpose certification, adverse action notices, accuracy procedures). This accepts CRA status for a feature nothing depends on. Rejected.
- **A disclaimer or terms-only restriction.** Research says it does not cure the fact pattern, and it could mislead. Rejected, though the use restriction stays as a second line.
- **Opt-in shown on hiring surfaces.** A consumer's instruction may supply a permissible purpose, but it does not remove the report from the statute. Rejected.
- **Removing cross-org display entirely.** Defensible, and simpler, but the person loses a way to show their own record to peers. Kept as the fallback if review concludes the profile path is still too close.
