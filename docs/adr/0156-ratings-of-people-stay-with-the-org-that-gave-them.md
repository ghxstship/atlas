# ADR 0156: Ratings of People Stay with the Org That Gave Them

- Status: Accepted
- Date: 2026-11-06
- Decider: Owner (Julian Clarkson), who directed that each open legal decision take the most future-proof, legally defensible option. The analysis below was prepared by AI. No attorney has reviewed it.
- Amends: ADR 0038 where it describes what a marketplace viewer sees, and Section 4.4.3 where it treats an org's rating of a person as public
- Tracks: RRR-248

## Context

`api_external.ratings` returned every released rating, with `rated_person_id`, to anyone signed in. It runs with its owner's rights, so row level security did not stop it. The Gateway profile page loaded ratings only for their owner, but the rows were one PostgREST call away.

XOS is used for hiring. Under the Fair Credit Reporting Act a consumer report is a communication bearing on a person's character, general reputation or personal characteristics, used or expected to be used for employment, and a consumer reporting agency is whoever regularly assembles or evaluates such information to furnish it to third parties (15 U.S.C. 1681a). An organization's report of its own transactions and experiences is excluded. That exclusion fits an org reading its own record. It does not obviously fit a platform relaying one org's rating of a person to another org. A disclaimer does not cure the fact pattern, and CFPB Circular 2024-06 having been withdrawn in 2025 does not clear it: the statute is unchanged. Whether the risk is real on these facts is an open question.

## Decision

### 1. Who reads a rating

| Rating | Who reads it |
| --- | --- |
| An org's rating of a named person (the engagement has `person_id`) | Members of the org that gave it, and that person |
| An org's rating of a company (no `person_id`) | As before: anyone signed in |
| A party's rating of an org | As before: anyone signed in |

- A rating on a vendor engagement that names a supplied person is a rating of that person. The account that supplied them does not read it or answer it. A rating of the vendor belongs on an engagement that names no person.
- A partner on a shared project, or the holder of a record grant from another org, may read the engagement but not the rating of the person.
- The rule is in row level security on `app.ratings` and `app.rating_replies`, and in the row filter of `api_external.ratings`. API v1 reads `app.ratings` under that security, so no v1 field, filter or list reaches another org's rating of a person. No v1 operation changed.
- An account with one member and a named company is treated as a company: the database has no marker for a sole proprietor. Section 4 of this ADR lists this as a residual risk.

### 2. The opt-in

- `app.rating_sharing_consents` records the person's own opt-in: off until a row stands, with the notice version, source, time and IP address, one row per grant. Withdrawal closes the row and takes effect at once, since every read checks it. Deleting the account withdraws it.
- It covers every rating or none. A person cannot show only the favorable ones.
- It opens one path: `api_public.person_profile_shared_ratings(handle)`, on that person's profile page. One person at a time, in date order, with no average and no rater named. It does not open the table or the view, and no sort, filter, search or score across people can be built on it.

### 3. Hiring surfaces: not shown, even with opt-in

The question was whether a hiring, recruitment, crew assignment or eligibility surface may show a person's cross-org rating with their opt-in. We cannot show such a use would not bear on eligibility, so it does not show. The database enforces this in addition to the screens simply not reading it:

- `private.viewer_decides_hiring()` is true for anyone who holds a capability that decides who is hired, booked, selected or put on a shift (`private.hiring_capability_codes()`), in any org or on any project, and for anyone who runs an external account, since an agency may place its people on shifts. Such a viewer gets nothing, even from the opted-in person's own profile page.
- No application, pipeline, shortlist, pool, roster, shift, availability ranking, marketplace search or recommendation reads ratings of people. Marketplace discovery and its `recommendation_score` read no ratings. The unused `averageScore` helper in `packages/data` is gone.
- Who can read a shared rating: someone signed in, to whom the profile is visible, who decides no hiring anywhere.

### 4. Seeing and disputing

- The rated person reads every released rating of them, with which org gave it, on Gateway's profile page.
- `app.file_rating_dispute` is the route: one dispute per rating, once released, by the named person only. The org that gave the rating may answer once (`app.respond_to_rating_dispute`). A platform operator with `moderation.decide` decides with a statement of reasons in the console (`/moderation/rating-disputes`); the person and the org are told, naming the platform and not the operator. The `rating_dispute` lifecycle is Open to Upheld or Not Upheld.
- Upheld takes the rating out of every read. The rating row is not edited and stays as evidence.
- An operator may uphold only for a named ground: the wrong person, a false statement, abusive content or personal data. The person may file with Other, but a dispute is not upheld on it. The queue and the detail never show the score.
- Filing does not hide the rating. A shared rating shows a Disputed tag while the dispute is open.

## Why this is not review suppression (16 CFR Part 465)

ADR 0038 stands: ratings are always on, `gateway.ratings_enabled` controls prompts only, and nothing lets an org hide, remove or filter a rating. No view, policy or function reads that setting. This ADR does not change any of that.

The FTC rule (16 CFR 465.7) reaches a business that controls a review website and suppresses reviews based on their rating or negative sentiment while representing that what is shown is all or most of the reviews. Limiting who reads a rating by relationship is a different thing:

- **The rule is content-neutral.** It looks at who is asking and which engagement the rating came from. No path reads the score or the comment. A five-star rating of a person and a one-star rating of a person are restricted in exactly the same way. pgTAP proves a low score reads for the same people as a high one.
- **Nothing is represented as complete that is not.** There is no public list of a person's ratings that omits the negative ones. A shared list is all of them, says so, and the person cannot pick.
- **Nobody can suppress a negative rating.** The org cannot, the rated person cannot pick (all or none), and filing a dispute hides nothing. Removal follows an operator's decision on grounds the rule itself recognizes, applied whatever the score, and the operator does not see the score.
- **Company ratings keep their reach,** so a negative rating of a company still reads for everyone it did before.

Whether Part 465 applies to ratings between organizations and workers at all is unclear (FTC guidance does not address B2B). This ADR treats the rule as the standard anyway.

## Other personal review data checked

| Data | Finding | Action |
| --- | --- | --- |
| `app.person_references` | The person lists them and controls the section's visibility. They are not assembled by the platform from another org. A statement can be read by a hirer, if the person publishes it | None. Listed for legal review |
| `app.person_certifications` verified by an org | A fact and who verified it, in a section the person controls | None. Listed for legal review |
| `api_public.person_profile_organizations` | Names orgs a person worked with, in a section the person controls. No opinion | None |
| Pool standing, Do Not Engage, `rehire_eligible` | Internal to the org by policy, and never in `api_external` | None |
| `app.vendor_scorecards` | Org-scoped through `vendors.vendor.read`, about vendors | None |
| Application review and interview notes | Org-scoped | None |
| Training and form scores | Org-scoped | None |

## Consequences

- `rated_person_id` stays on the view, additively, and `rater_organization_name` joins it; the rows changed, not the shape.
- A new capability that decides hiring must join `private.hiring_capability_codes()`. Nothing adds it automatically, so its code review is the control.
- A one-person company is still a company here. If a marker for a sole proprietor is added later, those ratings should follow Section 1.
- A hirer who holds no hiring capability in XOS, or who reads a screenshot a person's friend took, is out of reach. The Acceptable Use Policy's bar on screening with ratings is the remaining control, and it is not a cure.
- A rating dispute has no appeal to a second operator. With one operator, that review could not be kept.

## Alternatives considered

- **FCRA-compliant handling** (permissible purpose certification, adverse action notices, accuracy procedures). This accepts CRA status for a feature nothing depends on. Rejected.
- **A disclaimer or terms-only restriction.** Research says it does not cure the fact pattern, and it could mislead. Rejected, though the use restriction stays as a second line.
- **Opt-in shown on hiring surfaces.** A consumer's instruction may supply a permissible purpose, but it does not remove the report from the statute. Rejected.
- **Removing cross-org display entirely.** Defensible, and simpler, but the person loses a way to show their own record to peers. Kept as the fallback if review concludes the profile path is still too close.
