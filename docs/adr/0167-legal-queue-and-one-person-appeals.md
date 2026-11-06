# ADR 0167: The Legal Queue, and an Appeal Rule One Person Can Keep

- Status: Proposed
- Date: 2026-11-06
- Decider: RRR-248, on the owner's instruction to choose the most future-proof, legally defensible option. These calls were made by AI. No attorney has reviewed them.
- Addresses: review packet Sections 1 item 7 and 6.4 (decisions 38 to 41), audit finding A11Y-06
- Migrations: 6165 to 6168, and the notification seed 6169 (range 6165 to 6169)
- Amends: ADR 0046 (moderation: another operator decides each appeal)

## Context

Every mailbox, DMCA action, appeal, security report and manual promise routes to one person, and nothing tracked their clocks. Two things follow.

First, a clock can be missed because an inbox is full. No tooling existed for DMCA takedown, counter-notice timing or repeat-infringer counts, or for the accessibility report log. The DMCA safe harbor turns on actually doing these things (17 U.S.C. 512(c), (g), (i)).

Second, one promise could not be kept at all. Acceptable Use Policy 7 promises review by "a person who was not involved in the original decision", and migration 1473 enforced "another operator, never the one who decided". With one operator, an appeal of that operator's decision could never be decided. A promise that cannot be kept is worse than a narrower promise, because it misleads the person relying on it (FTC Act Section 5 and its state counterparts).

The law does not require a second person. Digital Services Act Article 20 asks for appropriately qualified staff and not solely automated means. Article 19 excuses micro and small enterprises from Article 20 altogether, so the appeal promise is voluntary for GHXSTSHIP today (research item DSA-08; staff count still open as O4). California's ADMT rules and state privacy laws ask for an appeal process, not a second employee.

## Decisions

### D1. One queue, in the console

`/legal-queue` is one list of legal and security work, soonest clock first, in the operator console. The new `legal.queue` permission is held only by the Administrator role, because a queue can hold a government request the law forbids telling anyone about. The table has no grant to `authenticated`: the RPCs are the only way in, because they also check the second factor. Each write lands in `app.platform_operator_actions` and in the item's append-only log (`app.legal_queue_events`), and each view of an item is logged.

### D2. Clocks are data, and computed

`private.legal_queue_rules` holds each clock as numbers, with what it rests on: a statute, a published promise, an internal target (where the law says only "expeditiously" or "timely"), or a Customer's own clock. The console shows that basis, so a target is never mistaken for a legal deadline. A due date is never typed, except where the document itself sets it (a subpoena's return date, or another written promise).

Clocks count in America/New_York, the time zone of the Miami address. Business days skip weekends and US federal holidays as observed. Holidays are computed, so the calendar never runs out. A day-counted clock ends at the last second of the local day.

Three numbers are deliberate. A GHXSTSHIP data subject request extends by 59 days, not 60, so 89 days in all never passes the three months GDPR Article 12(3) allows. A DMCA counter-notice's earliest day is the end of the 10th business day, so a restoration always falls after it, and the database refuses a restoration before then unless a court action is recorded (512(g)(2)(C)). An intimate image report runs a 48-hour clock under the Take It Down Act until counsel decides whether XOS is a covered platform; no public document promises this.

### D3. Feeds only from what the system already creates

Hand entry is the main path, because most of this arrives by email. The sync (`private.sync_legal_queue_feeds`) feeds open moderation appeals, open listing reports and open requests in a Customer's data subject register. A fed item's state follows its source, and no operator moves it.

A Customer's register holds that Customer's clock (DPA 8.1), and DPA 5 limits what GHXSTSHIP personnel may see. So the feed copies the org, the kind of request and the dates, and never the person or their words. It alerts once, when overdue, by email only. Requests an account deletion writes as already Completed never open an item.

### D4. Alerts that fail apart from each other

The hourly sweep (`private.sweep_legal_queue`, `xos_sweep_legal_queue`) alerts at each lead the rule sets, then daily while overdue, until the item closes. It uses paths that already exist:

- **Email:** `private.platform_emails`, the outbox the platform sends in its own name, worked every minute by the `subprocessor-notices` function. One digest per sweep per recipient, so a bad day is one email and not forty. This outbox was chosen over `private.notify` because `private.notify` needs an org, and an operator is not an org member.
- **On-call channel:** the webhook synthetics already posts to, read from Vault as `xos_alert_webhook_url`. It names references only. It is an owner step, and the sweep skips it when absent.
- **Console:** a banner on every page for operators holding `legal.queue`, and a delivery check on the queue that says when alert email is stuck, has failed, or when an overdue clock has had no alert in 26 hours, which means the sweep itself is down.

A backup contact receives overdue alerts only, with references and dates and never the matter, because a government request can come with an order forbidding disclosure.

### D5. Repeat infringer counts follow the published rule

`Copyright and DMCA Policy 5` counts more than two valid, uncontested notices in any 12-month period. The count takes each person's busiest 12 months, not only the latest. A notice that was withdrawn or refused does not count, and neither does one a valid counter-notice answered with no court action following. A counter-notice still open counts as an answer, so nobody passes the threshold while one waits. Passing it opens a review item for a person to decide. Nothing ends an account by itself.

### D6. An appeal is a fresh, documented re-review

The rule in `app.console_decide_appeal` is now:

1. **Fresh and documented.** Every outcome needs a record of what was looked at again and how the grounds were weighed, as well as the reasons sent to the person. Neither may be empty. The record is `private.moderation_appeal_reviews`, apart from `app.moderation_appeals`, because the appellant and the org read that table and the notes may name a reporter.
2. **The first decider may do it.** The record says so, and so does the notice to the person: "The person who made the first decision did this review, because GHXSTSHIP is a small team." Nothing implies a second employee. When a second operator holding `moderation.decide` exists, either may decide, and the record says which. Refusing the first decider when someone else exists was rejected, because a colleague on leave would then cause a missed clock.
3. **An outside reviewer, if one is ever appointed.** `private.legal_outside_reviewers` starts empty, and an empty table claims nothing. While one is appointed, every appeal goes to them: the alerts reach them, the operator may only record their decision, and the notice names them. Ending the appointment returns appeals to an operator's re-review. A reviewer who receives personal data needs a contract and a subprocessor decision first, which is an owner step.
4. **The person is told.** `private.notify` answers null for a reporter with no tie to the org, so the outcome silently went nowhere. `private.tell_moderation_party` now falls back to a platform email in the notice's own words (`moderation_notice`), for appeal outcomes and for the outcome of a report. The record says how they were told, and the moderation page warns when they could not be reached.

The console's appeal target is 30 days. It is an internal target and no public document states it.

## Consequences

- Promises narrow in the legal documents, listed in the RRR-248 hand-off. Until those documents change, AUP 7 still says what the code no longer enforces. Neither is published or in effect.
- The queue is only as good as its input: mail still has to be entered by hand. Inbound parsing of the mailboxes is not built.
- The alert path depends on the `subprocessor-notices` worker's schedule, a working email provider, and `XOS_EMAIL_ALLOWLIST` or `XOS_EMAIL_DELIVER_TO_ANY` allowing the operator's address. The delivery check makes a failure visible rather than preventing it.
- One person is still one person. A backup contact raises the alarm and cannot do the work. A long absence needs a person with console access or a named outside firm.
- Copyright designation, DSA representation and the mailboxes themselves stay owner steps.
