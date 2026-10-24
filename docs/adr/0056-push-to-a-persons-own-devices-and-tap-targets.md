# ADR 0056: Push to a Person's Own Devices, and Tap Targets

- Status: Accepted
- Date: 2026-10-23
- Decider: A101 (RRR-147), trace rows S4.3-15 (parts 1 and 2) and S4.4-20
- Migrations: 1670 and 1671

## Context

Push devices registered only per membership (`app.push_subscriptions`, 0520 and 1533), so leaving an org stopped its pushes (invariant 3). Two groups of people had no membership in the org that notified them:

- **External parties** (1131): freelance crew, vendors and artists an org engages. `private.notify` queued their push, and the claim suppressed it as "No registered device".
- **Marketplace users** (1461): a saved-search match reaches a person while the listing is open to them. Their push was suppressed the same way. Worse, the claim's membership test ran before the device test, so a match to a person who works with no org lost its email too.

ADR 0045 recorded the first gap as a consequence, and ADR 0052 named a person-level browser subscription as a follow-up.

Taps had a gap of their own. Compass opened the Inbox for a tap on an approval request and did nothing for any other tap, including the one that launched it. Record notifications carry the record's key since 1600, but nothing in Compass read it.

## Decisions

### 1. A person's own devices are a person-owned table

- `app.person_push_devices` (1670) holds a person's Compass devices (an Expo push token) and Gateway browsers (a Web Push endpoint and its keys). It is a person-owned table (`install_person_table`, decision 69 of ADR 0033): only the owner reads and writes it.
- A row belongs to no org. `app.push_subscriptions` keeps its per-membership rows and its tenant guards unchanged.
- `app.push_tickets` names either device: `push_subscription_id` or `person_push_device_id`, exactly one. A ticket now takes its org from its delivery, which for a membership device is the same org.
- Alternative: a `person_id` path on `push_subscriptions`. Rejected, because it would give a tenant table rows with no org, a second org-derivation rule and policies outside `install_policies`.

### 2. When a person's own devices take an org's push

`private.person_push_fallback` (1671) is the one rule. The claim (`app.claim_notification_deliveries`) and the Web Push sender (`app.web_push_devices`) both call it. A delivery goes to the recipient's own devices only when both of these hold:

- the recipient has no device registered with the notification's org (no live `push_subscriptions` row of theirs there);
- they work with the org as an external party (`private.party_org_ids`: an engagement, or a company account the org holds as a counterparty), or the push is a marketplace match about a listing open to them (`private.marketplace_notice_open`).

Consequences of the rule:

- A member's push goes to the devices registered with their org, exactly as before. A member with no device there gets no push on their own devices from that org, unless they also work with it as a party.
- Anyone else's own devices never carry an org's push (invariant 3).
- The person's own quiet hours apply, as for every push to someone without a membership (1461).

### 3. Who registers what

- **Compass** registers the device for the signed-in person (`app.register_push_device`), and also with the member's org when there is a membership, as before. Registering for every signed-in person, not only for parties without a membership, lets a member of one org receive the pushes of another org that engages them.
- **Gateway** browsers register for the person as well as for each org the person belongs to (`app.register_web_push`, `app.sync_web_push`, `app.revoke_web_push`). A person with no membership keeps their browser subscription instead of being told to drop it.
- **Atlas** browsers stay per membership. Atlas pages open only for members, so a party's push would open a page they cannot read.
- A device belongs to one person at a time. Registering a token or an endpoint revokes any other person's row for it, as 1533 does for browsers.

### 4. A marketplace match goes out though its recipient works with no org

The claim suppressed every delivery whose recipient had no membership and was not a party of the org. A marketplace match about a listing open to the recipient is no longer suppressed for that reason (1671). The listing's own visibility still decides, at notify, claim and read time (ADR 0045 decision 5).

### 5. Account deletion

`app.delete_my_account` (1670) removes the person's own devices and the tickets of every device it removes, membership devices included. Deleting membership devices alone had failed on the `push_tickets` foreign key once any of them had been pushed.

### 6. Every tap opens its target

- The push data carries `recordKey`, the display key of the record a notification is about (`message_args.recordKey`, 1600). The Compass and Atlas deep links read that key first, and fall back to the record and its project only when none is carried.
- In Compass a tap on the notification itself opens:
  1. the record whose key it carries (`/r/{key}`, in the org its link names);
  2. else its deep link through `compassPathForIncoming`;
  3. else the route of a Compass link (`compass://inbox` is the Inbox).

  A tap that launched Compass is routed the same way once the navigator is ready, and the last response is then cleared. A tap on an approval request still opens the Inbox; Approve and Reject are unchanged.

- The Compass Inbox lists the person's notifications from `app.inbox_items`: approvals, mentions and assignments under Needs You, the rest under For Your Information. Each row opens its record by the same rule, reading the key from the record and its project when the notification carries none. A notification Compass has no screen for, such as a marketplace match, opens the Gateway page it names (`gatewayPath`) in the browser.
- A Gateway browser push opens the page its notification names (`gatewayPath`): a match's listing (one match) or Explore Alerts (several). A match that names no page opens Explore Alerts, and anything else opens Home.

## Consequences

- An external party's Compass device and a marketplace user's Gateway browser receive their pushes, under their own preferences and quiet hours.
- The pgTAP suites 1670 and 1671 cover registration, the fallback, the member path and deletion. The unit suites in `@xos/platform` (`push-links`) and Compass (`notifications`) cover the links and taps. The Gateway journey `push-reach` checks the push tickets with the fake transports. The Maestro journey `push-tap-opens-record` (`scripts/push-tap.sh`) taps a push with Compass closed and open.
- Any branch that redefines `app.claim_notification_deliveries`, `app.web_push_devices`, `app.record_push_tickets`, `app.record_push_receipts` or `app.record_web_push_tickets` starts from 1671. One that redefines the 1533 registration functions or `app.delete_my_account` starts from 1670.
- Compass notification preferences (part 3 of S4.3-15) are A111's.
