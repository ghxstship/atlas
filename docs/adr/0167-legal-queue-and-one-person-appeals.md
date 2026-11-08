# ADR 0167: The Legal Queue, and an Appeal Rule One Person Can Keep

- Status: Proposed
- Date: 2026-11-06
- Decider: RRR-248, on the owner's instruction to choose the most future-proof, legally defensible option. These calls were made by AI. No attorney has reviewed them.
- Addresses: the owner's legal decisions of 2026-11-06 (decisions 38 to 41), audit finding A11Y-06
- Migrations: 6860 to 6863, and the notification seed 6999 (train 11, ADR 0022)
- Amends: ADR 0046 (moderation: another operator decides each appeal)

## Context

Every mailbox, DMCA action, appeal, security report and manual promise routes to one person, and nothing tracked their clocks. Two things follow.

First, a clock can be missed because an inbox is full. No tooling existed for DMCA takedown, counter-notice timing or repeat-infringer counts, or for the accessibility report log. The DMCA safe harbor turns on actually doing these things (17 U.S.C. 512(c), (g), (i)).

Second, one promise could not be kept at all. Acceptable Use Policy 7 promises review by "a person who was not involved in the original decision", and migration 1473 enforced "another operator, never the one who decided". With one operator, an appeal of that operator's decision could never be decided. A promise that cannot be kept is worse than a narrower promise, because it misleads the person relying on it (FTC Act Section 5 and its state counterparts).

The law does not require a second person. Digital Services Act Article 20 asks for appropriately qualified staff and not solely automated means. Article 19 excuses micro and small enterprises from Article 20 altogether, so the appeal promise is voluntary for GHXSTSHIP today (research item DSA-08; staff count still open as O4). California's ADMT rules and state privacy laws ask for an appeal process, not a second employee.

## Decisions

### D1. One queue, in the console

`/legal-queue` is one list of legal and security work, soonest clock first, in the operator console. The new `legal.queue` permission is held only by the Administrator role, because a queue can hold a government request the law forbids telling anyone about. The table has no grant to `authenticated`: the RPCs are the only way in, because they also check the second factor.

What was done and why lands in the item's append-only log (`private.legal_queue_events`). `app.platform_operator_actions` is read by every operator role, on the Activity page and by direct select (1470). So a queue action's row there says only that it happened and on which item: no rule, no reason, no date, no target org (`private.log_legal_queue_action`). Otherwise a Support operator could read "complied with the subpoena" from the ledger, which would defeat the permission. Each view of an item is logged the same way.

### D2. Clocks are data, and computed

`private.legal_queue_rules` holds each clock as numbers, with what it rests on: a statute, a published promise, an internal target (where the law says only "expeditiously" or "timely"), or a Customer's own clock. The console shows that basis, so a target is never mistaken for a legal deadline. A due date is never typed, except where the document itself sets it (a subpoena's return date, or another written promise).

Clocks count in America/New_York, the time zone of the Miami address. Business days skip weekends and US federal holidays as observed. Holidays are computed, so the calendar never runs out. A day-counted clock ends at the last second of the local day.

Four things are deliberate. A GHXSTSHIP data subject request runs for the shorter of a calendar month and 30 days, as Privacy Policy 7 says: a request received on 1 February is due on 1 March, not 3 March, and the extension is refused from then on. It extends by 59 days, not 60, so the whole never passes the three months GDPR Article 12(3) allows; a test walks every day across a leap year. A DMCA counter-notice's earliest day is the end of the 10th business day, so a restoration always falls after it, and the database refuses a restoration before then unless a court action is recorded (512(g)(2)(C)). An intimate image report runs the Take It Down Act's 48 hours, kept as if XOS were a covered platform, which is the safer reading. Its basis says target and not statute, because nobody has found XOS to be covered, and no public document promises it.

Times on the form are typed in the zone the queue counts in, which the form names, and the database reads each in that zone with the offset of its own day (`private.legal_local_instant`). A browser offset was rejected: read once, it moved a subpoena's return date across daylight saving by an hour, and before hydration it read New York time as UTC. An owner away from New York has to convert. The hour the autumn change repeats reads as the earlier one, so no clock ends late because of it.

### D3. Feeds only from what the system already creates

Hand entry is the main path, because most of this arrives by email. The sync (`private.sync_legal_queue_feeds`) feeds open moderation appeals, open listing reports, open requests in a Customer's data subject register, and moderation results that could not be delivered. A fed item's state follows its source, and no operator moves it, except an undelivered result, which only an operator can finish.

The sync never raises. Each feed runs in its own block, so one that fails leaves the others and every alert running, and a failure opens a `queue_feed_failure` item that alerts by the same paths and closes when the feed works again. A console read racing the sweep to the same record finds it done (`on conflict do nothing`).

A Customer's register holds that Customer's clock (DPA 8.1), and DPA 5 limits what GHXSTSHIP personnel may see. So the feed copies the org, the kind of request and the dates, and never the person or their words. It alerts once, when overdue, by email only, and it sits in its own list, so clocks that stay open until a Customer closes them can never push GHXSTSHIP's own work off the page. Requests an account deletion writes as already Completed never open an item.

An item is the platform's record, so it outlives the tenant. Its link is `tenant_org_id`, not `org_id`, because the org purge (1351) takes every row with an `org_id` and refuses any row it cannot tie to the org. Deleting the org clears the link, and a listing's title is read live from its source, so nothing of the tenant's stays in the item. For the same reason, queue entries in the console ledger name no target org. A moderation notice in the platform email outbox carries the listing's title and reasons until it is sent, so its row has an `org_id` and the purge takes it, and an open item about a failed notice closes at the next sync, because there is nobody left to tell.

### D4. Alerts that fail apart from each other

The hourly sweep (`private.sweep_legal_queue`, `xos_sweep_legal_queue`) alerts at each lead the rule sets, then daily while overdue, until the item closes. It uses paths that already exist:

- **Email:** `private.platform_emails`, the outbox the platform sends in its own name, worked every minute by the `subprocessor-notices` function. One digest per sweep per recipient, so a bad day is one email and not forty. This outbox was chosen over `private.notify` because `private.notify` needs an org, and an operator is not an org member. An operator's digest names the matter, except on a government request's line, which gives only the reference and date: D1 keeps that request from everyone but the Administrator, and a mailbox and the email provider's logs are not the console.
- **On-call channel:** the webhook synthetics already posts to, read from Vault as `xos_alert_webhook_url`. It names references only. It is an owner step, and the sweep skips it when absent.
- **Console:** a banner on every page for operators holding `legal.queue`, and a delivery check on the queue that says when alert email is stuck, has failed, or when an overdue clock has had no alert in 26 hours, which means the sweep itself is down.

A backup contact receives overdue alerts only, with references and dates and never the matter, because a government request can come with an order forbidding disclosure.

Each path runs on its own (`private.raise_legal_queue_alert_path`) and keeps its own record of which stages it took. A stage is marked, and the item's log says Alert Sent, only after a recipient took it: the log entry follows the operator's digest, which is the path that can act. A path that fails, or has nobody to reach, marks nothing, so it tries again next hour and does not repeat itself once it works. Each recipient is on their own too, so one bad address leaves the others. The 26-hour check reads those log entries, so it fires when the email path is down as well as when the sweep is.

All of this runs inside the database, so it cannot report that its own sweep stopped, and a banner reaches only someone who opens the page. An outside check does: `api_public.legal_queue_heartbeat` answers five booleans about the machinery (sweep, feeds, the last sweep's paths, email, someone to alert) and nothing about any matter, and the `legal_queue.heartbeat` synthetic check, signed in as the synthetic user, pages on-call. Anon cannot call it, so the public surface does not grow. It stays off the public status page, because it says nothing about the service Customers use. It works only once the synthetics workflow is installed, an owner step.

### D4a. Retention

An item and its log go together, 5 years after the item closes, and an open item never expires. The log has no age of its own: it lives in `private`, outside the app table retention schedule, and goes by cascade. A separate period would either delete a closed item's log with it before reaching that period, or age entries out of an item still open. A removed backup contact is kept a year, and an ended outside appointment 7 years and for as long as a decision names it; `private.retention_policies` covers app tables only, so the sweep deletes these (`private.purge_legal_queue_people`). The item's 5 years wait on the nightly purge working on batch-c, which is a separate finding. The sweep's own deletions do not.

The platform email outbox also holds an address for every email, and a failed one keeps its words, so it has periods of its own. A legal clock alert goes 90 days after it ended: its row only proves it left. A moderation notice goes 7 months after it was sent, because it proves the person was told, through the six months they may appeal and a month more. A failed notice goes once its `undelivered_notice` item closes, and a row still waiting is never deleted by age. Deleting a sign-in deletes both kinds to that address at once, by a trigger on `auth.users` so any path of deletion is covered, and first records `told_at` if the provider had taken the email. The purge of an org takes its notices. Other templates (subprocessor notices, party invitations) stay as they were; they have no period today, which is a separate finding.

### D4b. A return of omitted data holds the deletion

Terms 11.2 and 11.4 and DPA 10.2 say a request for what the export omits, made before deletion, holds the deletion until the return is done. The `omitted_data_return` rule sets `holds_org_data`, so adding one by hand names the org by slug and places an `app.legal_holds` row over every table of it, which `private.schedule_deletions`, the storage worker, the purge and the retention purge already honour. The item keeps the hold's id and releases it when it closes, Completed, Refused or Withdrawn, with a log entry each way. The request usually comes while the org waits to be deleted and is read-only, so `private.guard_queue_legal_hold` takes the read-only guard's place on `app.legal_holds`: a member's hold write is still refused while the org is read-only, and only the queue's own RPC gets through. A hold an open item placed is released only by closing that item, so a member cannot let the purge take data GHXSTSHIP is still returning; the Customer withdraws the request by writing to legal@, and the operator withdraws the item. A request that arrives after the purge has nothing to hold, and is added as another written promise.

The outbox rows also name the sign-in they went to (`to_user_id`), so deleting the sign-in takes them even after the person changed their address. The item log's `Alert Sent` entry is shown as "Alert queued for email", because it is written when the email enters the outbox, not when the provider takes it.

### D5. Repeat infringer counts follow the published rule

`Copyright and DMCA Policy 5` counts more than two valid, uncontested notices in any 12-month period. The count takes each person's busiest 12 months, not only the latest. A notice that was withdrawn or refused does not count, and neither does one a valid counter-notice answered with no court action following. A counter-notice still open counts as an answer, so nobody passes the threshold while one waits. Passing it opens a review item for a person to decide. Nothing ends an account by itself.

### D6. An appeal is a fresh, documented re-review

The rule in `app.console_decide_appeal` is now:

1. **Fresh and documented.** Every outcome needs a record of what was looked at again and how the grounds were weighed, as well as the reasons sent to the person. Neither may be empty. The record is `private.moderation_appeal_reviews`, apart from `app.moderation_appeals`, because the appellant and the org read that table and the notes may name a reporter.
2. **The first decider may do it.** The record says so, and so does the notice to the person: "The person who made the first decision did this review." Nothing implies a second employee. When a second operator holding `moderation.decide` exists, either may decide, and the record says which. Refusing the first decider when someone else exists was rejected, because a colleague on leave would then cause a missed clock.
3. **An outside reviewer, if one is ever appointed.** `private.legal_outside_reviewers` starts empty, and an empty table claims nothing. While one is appointed, every appeal goes to them: the alerts reach them, the form can only record their decision and its button says so, and the notice names them. Ending the appointment returns appeals to an operator's re-review. A reviewer who receives personal data needs a contract and a subprocessor decision first, which is an owner step.
4. **The person is told, and the record does not claim it early.** `private.notify` answers null for a reporter with no tie to the org, and a member with every channel of the category off gets an archived notification with no delivery. Both reached nobody. `private.tell_moderation_party` now falls back to a platform email in the notice's own words (`moderation_notice`), for appeal outcomes, for the outcome of a report, and for the statement of reasons on a removal or restriction. Other decisions to the affected party are a courtesy no document promises, so their settings stand. `told_at` is set only when it has happened: at once for a notification, and for an email when the provider takes it. An email that fails for good, a person with no email left, or a removal when no one in the org can be reached, opens an `undelivered_notice` item with its own 2 business day clock, so a person never goes untold in silence, and the operator closes it by saying how they told them, or withdraws it with a reason when nobody can be found. The provider taking an email does not prove it arrived: a later bounce is not seen here.
5. **An appeal that arrives by email keeps the same promise.** Acceptable Use Policy 7 gives an appeal against any restriction, and Section 6 routes everything but listings to the abuse mailbox, so `app.moderation_appeals` cannot hold them all. `abuse_appeal` is a hand-entered rule with a computed clock. It, `dsar_appeal` and `accessibility_review` set `re_review_required`, so the database refuses to complete or refuse one without what was looked at again and how the person was told, and records whether the first decider did it. While an outside reviewer is appointed, a moderation appeal by email goes to them too.

The console's appeal target is 30 days. It is an internal target and no public document states it.

## Consequences

- Promises narrow in the legal documents, listed in the RRR-248 hand-off. Until those documents change, AUP 7 still says what the code no longer enforces. Neither is published or in effect.
- The queue is only as good as its input: mail still has to be entered by hand. Inbound parsing of the mailboxes is not built.
- The alert path depends on the `subprocessor-notices` worker's schedule, a working email provider, and `XOS_EMAIL_ALLOWLIST` or `XOS_EMAIL_DELIVER_TO_ANY` allowing the operator's address. The delivery check and the outside heartbeat make a failure visible rather than preventing it.
- A Customer's own register keeps its flat 30 and 90 day clock (`app.dsar_request_clock`, 0501), and the queue only watches it. That clock is the Customer's tool and is not changed here.
- One person is still one person. A backup contact raises the alarm and cannot do the work. A long absence needs a person with console access or a named outside firm.
- Copyright designation, DSA representation and the mailboxes themselves stay owner steps.
