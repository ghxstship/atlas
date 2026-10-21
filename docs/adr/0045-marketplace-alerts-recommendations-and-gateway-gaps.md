# ADR 0045: Marketplace Alerts, Recommendations, Expiry Reminders and Gateway Gaps

- Status: Accepted
- Date: 2026-10-21
- Decider: Built and recorded by A89 (RRR-134), work package WP8
- Findings: A65-008 and A65-031
- Migrations: 1460 to 1464, and the notification kind seed in 1469

## Context

The A65 requirements trace found the marketplace promised things nothing delivered:

- **A65-008:** saved searches never alerted, Explore ranked by deadline only, three discovery filters were missing, and no expiry reminder was ever sent.
- **A65-031:** no supplier diversity certifications, no swipe gestures in Gateway, and a profile strength meter that named only the next step.

This record lists the choices made while closing them.

## Decisions

### 1. One filter rule, and the listing's own visibility

- `private.listing_matches` (1460) is the one discovery filter rule. Explore's search and the saved-search matcher both call it, so an alert matches exactly what Explore would show for the same search.
- Who sees a listing is never decided here. Both callers check `private.opportunity_open_to_person`, which carries A76's `gateway.marketplace_visibility` cap (1327), Do Not Engage and moderation. Nothing in this work widens visibility.

### 2. Distance uses PostGIS

- Venues already store a PostGIS `geography(point, 4326)` with a GiST index (0420). Distance filters use `st_dwithin` and report `st_distance`.
- `earthdistance` is not installed and would restate the point as a cube. A venue without a location never matches a radius search, and is never placed at a guessed position.
- People choose a place from the localities of located venues among the listings open to them (`app.marketplace_places`). The page never asks for coordinates, and only a locality name and a point leave the database.

### 3. The recommendation score

`app.search_marketplace` scores each listing from 0 to 100 using only the caller's own profile (`private.recommendation_points`):

| Factor         | Points | Rule                                                                                                                                                                                                                                                                                     |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills         | 40     | The listing's category is a profile skill. 25 for the same discipline, 10 for the same department (a role-coded listing reads the department from its canon role code).                                                                                                                  |
| Certifications | 30     | The share of the listing's certification requirements the person meets. A requirement counts as met by a current org holder record (on that org's calendar) or by a current profile certification of the same name (on the person's calendar). A listing with no requirements scores 30. |
| Location       | 20     | Near a searched place: 20 within 50 km, 10 within 150 km. Otherwise 20 when the venue's locality is the profile city, 5 when the jurisdiction is in the profile country.                                                                                                                 |
| Availability   | 10     | No Unavailable block overlaps the listing's dates on the venue's or the project's calendar. 5 when the listing has no dates.                                                                                                                                                             |

- Equal scores fall back to the deadline, then the start date. Soonest order keeps the old rule: deadline, then start date.
- Nothing an org pays for enters the score, and only the two published orders exist. Gateway's public How ranking works page lists these rules, with the weights read from `RECOMMENDATION_WEIGHTS` in `@xos/data`.
- Ranking credits self-reported profile certifications. The requirements check on a listing still reads only verified org records, and the org verifies every requirement during onboarding.

### 4. Passing on a listing

- A pass is `app.passed_opportunities`. It hides the listing from Explore and from alerts until undone.
- The org never sees who passed. Gateway offers Undo in place instead of a confirmation (Section 11.10).

### 5. The matcher and its notifications

- pg_cron runs `private.match_saved_searches` every 15 minutes. It looks at listings published since the search was saved, at most 14 days back, and skips any the person passed on or applied to.
- An alert is written once per search and listing (the 0720 unique key), at most 25 per search a run.
- The person gets one `opportunity.matched` notification per search and posting org, by email and push. It carries the count and links to the listing (one match) or to Explore Alerts (several).
- The notification queue is per org and reached only members and parties of the org (invariant 3). A match now reaches a person whenever the listing it names is open to them (1461).
  - The rule is the listing's own visibility, checked when the notification is created, claimed and read.
  - When the listing closes, the delivery is suppressed with a reason and the notification leaves the inbox.
- `delivered_at` on the alert records when the notification was queued. The queue's deliveries record what each channel did.

### 6. Quiet hours for people without a membership

- Decision 35 of ADR 0033 holds texts and pushes during the recipient's quiet hours. Quiet hours were a membership setting, so external parties and marketplace users had none.
- `app.person_notification_settings` holds a person's own quiet hours and the zone they are read in. The zone is required and never assumed to be UTC. People set it in Gateway Settings, Notifications.
- A push from an org the person is not a member of waits them out at queue and claim time, unless its kind is on the bypass list. External parties receive no SMS, and email is never held.
- `private.notify` and `app.claim_notification_deliveries` were redefined from their 1367 definitions with every later behavior kept. Any branch that redefines them again must start from 1461.

### 7. Expiry reminders

An hourly job, `private.send_expiry_reminders`, reminds before these items expire:

| Kind                       | Items                                                                                                 | Calendar     |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `onboarding.item_expiring` | A passed onboarding item on an open engagement                                                        | The org's    |
| `certification.expiring`   | An org holder record                                                                                  | The org's    |
| `certification.expiring`   | A self-entered profile certification (one carried from an org record is reminded through that record) | The person's |
| `document.expiring`        | A signed or executed engagement document, or a vendor's certificate of insurance                      | The org's    |
| `document.expiring`        | The passport in Work Details                                                                          | The person's |

- The standard thresholds are 30, 7 and 1 days. An onboarding requirement's `remind_days_before` replaces the thresholds at or above it.
- A run sends only the smallest threshold reached. An item first seen 5 days out reminds once at 7 and again at 1, never at 30.
- `private.expiry_reminders_sent` records each threshold per item, recipient and expiry date before the notification is queued, so the job is idempotent. A renewed item, with a new expiry date, is reminded again.
- Recipients:
  - the engaged person, or the Owner and Admin members of the external account an engagement or vendor names
  - for a personal item, the person, reminded through the org they work with most directly (newest active membership, then newest open engagement, then any party org)
- A person who works with no org gets no outside reminder for a personal item. Gateway's Profile and Documents still call out what expires.
- People with a membership keep their per-org preferences, digests and quiet hours. Everyone else uses their own Email and Push choice for the new Expiry reminders category.

### 8. Supplier diversity certifications

- `app.supplier_diversity_certifications` is owned by a person or by an external account, and only the owner reads and writes it (the account's Owner and Admin members). Each certification is self-declared.
- The certificate number is Restricted under `data.restricted.read.government_id`, because the agencies that certify (the SBA, state DBE programs) issue government identifiers.
  - Nobody signed in selects the column, and the owner sees its last four characters.
  - An org reader sees it whole only with the capability. Everyone else sees it marked masked.
- The kind reveals ownership by a protected group, special category data under GDPR Article 9. It is Confidential, and the table is on the AI exclusion list.
- Consent is separate. Sharing records a `supplier_diversity` consent for that org, never the profile sharing consent.
- An org takes certifications only while it runs a program. `gateway.supplier_diversity_program` (A89 settings file) is off by default; turning it off hides what was shared without revoking it.
- Revoking a share withdraws the consent with the org's last live share.
- Org members with `vendors.vendor.read` read shares through `app.shared_supplier_diversity`, shown under Vendors, Directory.
- Every change, share, revocation and org read lands in `app.supplier_diversity_events`, the owner's access log, with no values. Shares, revocations and org reads also land in the org's audit ledger.

### 9. Gestures with fallbacks

- `SwipeActions` in Gateway handles the swipes on Explore cards and list rows, Saved and Alerts:
  - right is the primary action (save, turn alerts on or off)
  - left is the secondary one (pass, remove)
- It listens to touch pointers only, so a mouse still selects text and follows links.
- Every gesture has a visible button under the row on every screen, and a single-key shortcut while focus is inside the row, announced through `aria-keyshortcuts`: S save, P pass, A alerts, R remove.

### 10. Profile strength

- The meter lists every missing step, in the order that helps an application most.
- Each step links to the field or section that fixes it: anchors on Settings, Profile, or the availability calendar.

## Not in scope

- **Spend authority before publishing** waits on ADR 0019's open owner item.
- **The Checkr connector** waits on A83's integration framework.
- **Ratings stay prompt-only** (ADR 0038). Nothing here gates rating on anything new.

## Consequences

- Push for people with no membership in the sending org is recorded, then suppressed as "No registered device", because push devices register per membership (1131's existing behavior). Their email goes out, and the push reaches them once device registration exists for external parties.
- The API v1 `marketplace.search` operation keeps its frozen shape and its deadline order. The recommendation score is in the database RPC that Gateway calls. Exposing it in the API would be an addition for a later contract version.
- The notification kind seed moved to 1469. A branch that adds kinds moves it to its own range and regenerates.
