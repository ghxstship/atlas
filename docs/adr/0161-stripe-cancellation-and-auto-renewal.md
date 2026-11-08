# ADR 0161: Stopping Stripe and the Auto-Renewal Terms

- Status: Proposed
- Date: 2026-11-06
- Decider: The owner told the build to take the most future-proof, legally defensible option. These calls were made by AI, and no attorney has reviewed them.
- Addresses: audit finding M1 (canceling or deleting an org never stopped Stripe), legal issue 1 (RRR-248)
- Migrations: 6810, 6811, 6813 and the notification seed 6999 (range 6810 to 6999)
- Amends: ADR 0033 decision 59 (Checkout), ADR 0155 D4 (a canceled org ends its pause)

## Context

`app.cancel_organization` and `app.request_org_deletion` changed only the database. Their comments named a billing seam that did not exist, so a paying Owner who canceled kept being charged. The next `customer.subscription.updated` then created a new active subscription on a read-only org, and after the purge the webhook refused `billing_org_unknown` while Stripe kept charging. Billing is still closed (ADR 0033 decision 59), so this has not reached a customer.

Automatic renewal is a negative option. ROSCA (15 U.S.C. 8403) asks for clear disclosure before billing information is taken, express informed consent, and a simple way to stop. Whether it reaches business buyers is disputed, and small producers and sole proprietors buy XOS, so this build treats it as applying. California's Automatic Renewal Law is consumer-only but is the strictest design standard found. Wisconsin 134.49 reaches annual business contracts and asks for a signature or initials. The FTC's click-to-cancel rule is not in force and nothing here claims to meet it.

## Decisions

### D1. The database queues every stop, and only the service role records the answer

1. Triggers on `app.org_cancellations` and `app.org_deletion_requests` queue the immediate cancel of every Stripe subscription of the org, in the same transaction. Every path that ends an org stops Stripe, the REST API included, and no path can forget.
2. `private.stripe_cancellations` has no `org_id`, so the record outlives the tenant purge, as `app.deletion_certificates` does. Its lifecycle is Queued, Accepted, Withdrawn, with `stripe_cancellation_transition_not_allowed` for any other move.
3. Only the service role moves a cancel: the org-lifecycle worker, or a signed webhook. Atlas calls Stripe at once for the person waiting, because it holds the key as it does for Checkout, but it cannot record the outcome. An Owner calling PostgREST directly therefore cannot mark a cancel accepted and let a deletion past the gate.
4. Pages say only what Stripe has said: Accepted, or what Stripe answers when asked at render. Anything else reads as not confirmed.

### D2. The call

1. An immediate cancel is `subscriptions.cancel` with `prorate: false` and `invoice_now: false`. Terms 5.10 refunds no unused time unless the law requires it, and the page says so at the moment of cancelling.
2. Ending a plan is `cancel_at_period_end: true`. It needs no second factor and asks no reason, because stopping a charge must be no harder than starting one. Checkout's own step-up stays, since it starts a charge.
3. Each try has its own idempotency key (`xos-stripe-cancel:<id>:<attempt>`). Stripe replays a stored failure for 24 hours under one key, so a per-row key would turn one 500 into a day of failures. Repeating is safe regardless: a second cancel answers `resource_missing`, which counts as accepted, since a subscription Stripe does not have cannot charge.
4. A failure retries after 5 minutes, doubling to 6 hours, and never gives up. A worker that dies mid-call only delays the row: its claim can be taken again after 10 minutes.
5. A Stripe that hangs cannot stop the rest of the worker. Each call has 8 seconds and no retries inside the SDK, the Stripe step has a budget of 45 seconds per run, and cancels are claimed one at a time, so what a run cannot reach stays due and unclaimed. Alerts go out before Stripe is called and again afterward.

### D3. The truth when Stripe does not answer

The first failed attempt, or 15 minutes in the queue if the worker never ran (`private.run_stripe_cancellation_watch`, on pg_cron), does two things once: `billing.cancellation_delayed` tells the billing owners it is not confirmed, and a `cancel_delayed` alert goes to the platform owner. The alert is durable (`private.billing_alerts`, listed in the console) and emailed by the worker to `XOS_BILLING_ALERT_EMAIL`. If that variable is not set the alert waits, the console shows it and the worker logs an error for Sentry. An accepted cancel clears it and sends the confirmation.

The customer copy says what is known. Atlas's own call can fail or time out without leaving a trace, so until Stripe accepts, the pages and the email say the request is with us and on its way to Stripe, never that it reached Stripe.

### D4. Reconciliation

`app.reconcile_stripe_subscription` runs before the sync, for a subscription of any price:

- ended: settles the cancels and marks the link ended. When nothing asked XOS, such as after Stripe gave up retrying, it is recorded as `Ended In Stripe` with no cancellation notice, since the customer did not cancel
- live on a purged org: queues the cancel and raises `active_on_deleted_org`
- live on an org being canceled or deleted, or more than 10 minutes after its cancel was accepted: queues the cancel and raises `active_after_cancel`, and never creates a subscription again
- an event older than the acceptance: stale, since Stripe does not order its events

`app.record_stripe_event` now stores an event naming a purged org with no org, rather than failing a foreign key for days. A paid invoice on a subscription XOS was asked to stop raises `charged_after_cancel`, for the owner to refund by hand. A subscription that ended in Stripe on its own was not asked to stop, so an overdue invoice paid on it later raises nothing.

The three alerts that ask a person to look for or refund a charge (`active_on_deleted_org`, `active_after_cancel`, `charged_after_cancel`) stay open until an operator closes them with what was done, however quickly Stripe accepts the cancel. Stripe accepting ends the risk of the next charge, not of one already made. Only `cancel_delayed` and `deletion_blocked` clear themselves. A live cancel settled because Stripe answered `resource_missing` raises `cancel_missing`, since Stripe answers the same for a live subscription reached with another account's key; it stays open until someone checks the Dashboard.

### D5. The deletion gate

`private.write_deletion_certificate`, the one place an org starts to be deleted, writes nothing and raises `deletion_blocked` while the org has a subscription Stripe has not reported ended and no immediate cancel of it has been accepted. A guard on `purged_at` stops a purge if a cancel appears after the certificate. A test subscription under a live key is closed as `test_mode`, since it never charges and that key cannot reach it.

The gate can delay a deletion for as long as Stripe will not accept. That tension with erasure is accepted, and the alert makes it visible: the choice between deleting and charging someone for a deleted org favors not charging.

### D6. Disclosure and consent

1. Choosing a plan shows a review step on Billing and Plan: price, renewal term, first charge date and how to cancel, with an unticked box. It comes before Stripe sees anything, so the terms precede billing information. Stripe's page repeats the same text above its pay button (`custom_text.submit`).
2. The statement is worded from the catalog in the Owner's language. The form carries its hash and the action recomputes it, so what is recorded is what was on the screen, or the action refuses `renewal_terms_changed`.
3. An annual plan also asks for initials, for Wisconsin 134.49. A checkbox would probably be enough under E-SIGN, but initials cost one field and remove the question.
4. `private.billing_renewal_consents` keeps the statement word for word, its text version (`RENEWAL_TERMS_VERSION`; a test pins the wording to it), language, price, term, date, person, email and session. It cannot be changed. It outlives the org and the person's account deletion, and is kept 7 years and also while the plan runs and for a year after it ends, since California asks for 3 years or 1 year after the contract ends, whichever is longer, and a plan can renew past 7 years. Account deletion lists it among what is kept (6813).
5. A live Checkout cannot be recorded without a consent (`renewal_consent_required`). Test mode is exempt, because that backstop needs no fixture and Atlas itself refuses without one.

6. Checkout is told the currency (`currency`, with adaptive pricing off), so Stripe cannot show one the statement did not quote. The statement, the consent, the database's price check and the session all carry that one currency, today USD through `CHECKOUT_CURRENCY`.

### D7. Notices

`billing.purchase_confirmed` repeats the terms when Checkout completes, with the next charge date: what Stripe has said if the subscription has synced, else the end of a carried trial, else one term after the charge just made. Renewal notices quote what Stripe charges in the subscription's own currency: a multi-currency price states only its default currency on a subscription, so the amount comes from the price's currency option when the event expanded it, else the price book that built the price. `billing.renewal_reminder` goes 30 days before an annual renewal, inside California's 15 to 45 days, New York's 15 to 30 and Wisconsin's 15 to 60. A first term under 30 days old is skipped, since its confirmation just gave the same terms. `billing.cancellation_confirmed` and `billing.plan_ending` confirm a cancel, a portal cancel included. All are in the `account` category. The law and the agreed terms promise them, so `private.notify_billing_contacts` queues the email whatever the person's or the org's settings say, and their `billing_notice` template is transactional, so an unsubscribe link does not stop them either. A hard bounce, a complaint, a manual block or a missing address still does. The reminder's proof row records how many were emailed, and none raises `notice_undelivered`.

## Consequences

- Terms 11.1, 11.2, 11.4 and 5.10 and the guides that warn that canceling does not stop Stripe must change to say it does.
- A charge after a cancel is refunded by hand. Automating a refund moves money without the owner, so it waits for an owner decision.
- The portal's own cancel keeps working and is recorded from the webhook. Its cancellation reason stays optional in Stripe.
- The Stripe portal cannot change the renewal term. `stripe:setup` makes one configuration per term, each listing only that term's prices, and Atlas opens the one that matches the plan. Moving between monthly and annual means ending the plan and buying the new term through the review step, so the Owner sees and agrees to the new terms, initials an annual plan, and XOS keeps the record. It costs the customer a same-day switch, and it closes the only way onto an annual plan with no consent on record. A plan change at the same term stays in the portal: it is confirmed on Stripe's own page, XOS keeps no consent for it, and the next notice quotes what Stripe then charges. Before `stripe:setup` has run, Atlas falls back to the account's default portal, so the live configurations must exist before billing opens.
- A plan that is ending does not pause, and a pause that has started on one does not resume, because resuming starts a new period and charges at once, after the Owner was told the plan will not charge again. The database refuses as soon as the end is asked for, and Stripe's read catches one set in the portal whose event has not arrived. A pause that has not started can still come off, which charges nothing.
- A renewal paid after End plan was asked for raises `charged_after_cancel` whether or not Stripe had accepted the cancel. If Stripe was unreachable through the renewal date, the customer has already been told they will not be charged again, and that is the charge the refund promise covers.
- Stripe does not order its events, and it retries a failed delivery for days. A live event not newer than the end Stripe reported returns `stale`. One newer than that contradicts Stripe's own terminal status, so it queues a cancel and raises an alert instead of reaching the sync.
- Reconciliation and the sync are separate transactions. The sync checks again after it has locked the org's subscription, the row canceling or deleting an org also takes, so a cancel between the two cannot bring a subscription back.
- Billing stays closed by decision 59 until the owner opens it.

## Owner steps before live billing

Set `XOS_BILLING_ALERT_EMAIL` and `STRIPE_SECRET_KEY` as Edge Function secrets, schedule `org-lifecycle` (it already runs every 5 minutes where scheduled), add `invoice.paid` to the webhook endpoint's events, and create a Sentry alert rule on `billing_attention_needed`. See `infra/runbooks/production.md`.
