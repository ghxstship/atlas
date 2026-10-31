# ADR 0138: Approval Rules, Signed-Out Decisions by Emailed Code, and Approval Reminders

- Status: Proposed
- Date: 2026-10-31
- Decider: P9 (RRR-223) took the decisions below for the owner-approved parity gaps G-31 and G-261 (competitor
  parity audit, 2026-10-28), for trace rows S11.10-06, S7.3-08, S4.5.6-21 and S4.4-44. The owner confirms this record;
  until then it stays Proposed.

## Context

The only approval engine was 1030's, keyed to spend documents: `app.approval_instances` needs an amount and a
currency, every step approver must be a member, and `app.decide_approval` needs the document's spend capability.
Nothing gated a pass (`app.credentials`), a dock booking (`app.dock_slots`) or an equipment request, and the people a
production most often needs a yes from (a venue's security lead, a client's producer, a vendor's account manager) are
engaged on the project, not members of the org.

ADR 0106 (One-Tap Actions from Email and Push, and Gateway's For Your Information, A127) put approve and reject links
in the approval email, but every link asks for a sign-in, and it rejected "Let the link alone authorize, without a
sign-in" because a forwarded email would act as its recipient and step-up could not apply. Section 7.5 invariant 8, as
ADR 0033 decision 56 rewords it, says token RPCs need a token and an access code, expire, rate-limit failed attempts,
return only the fields the page renders, and keep access codes hashed and shown once. docs/adr/README.md says a
decision changes only through a new record, so this record narrows ADR 0106 rather than editing it.

Nothing reminded an approver who let a request wait (G-261), and a requester's only recourse was to ask outside XOS.

## Decision

1. **A second, smaller engine for subjects, on the same vocabulary.** `app.approval_rules` (migration 2860) belong to
   one project and gate one subject: Pass, Delivery or Equipment, with one optional filter of that subject (a
   credential category of the project, any zone of the org, an asset class). The most specific Active rule matches: a
   filter beats no filter, and one Active rule per project, subject and filter. A rule has 1 to 5 ordered steps
   (`app.approval_rule_steps`), each naming a role, one member or a live engagement of the project, and steps change
   only while the rule is a Draft, so an approval in flight keeps the steps it started with. Rules are written with
   `projects.settings.write` on the project or `org.approval_policies.write`, in Project Settings.
2. **State is computed (ADR 0103).** `app.subject_approvals` holds one row per pass or dock slot a rule matched, opened
   by an after-insert trigger, with the requester (`requested_by`, NULL when the service, an import or a trusted
   operation created the subject: no separation-of-duties check then, and only rule writers cancel or remind) and a
   cancel stamp. `app.subject_approval_status` computes In Review at the lowest undecided step, Approved, Rejected or
   Canceled from the append-only `app.subject_approval_decisions`. Revoking or deleting a pass, or deleting a dock slot,
   cancels its approval.
3. **One decision path.** `private.decide_subject_approval_as` decides for the signed-in approver
   (`app.decide_subject_approval`), the Inbox and push (`app.act_on_notification`) and the emailed link
   (`api_public.use_approval_link`). Never the requester (`sod_approval_requester`), never the pass holder
   (`approval_subject_beneficiary`), one step per person, and a rejection needs its reason. When those exclusions
   leave a step with nobody, the approval stays In Review, Approvals says no one can decide the step, and the requester
   or a rule writer withdraws it. **Step-up never applies to a subject approval**: the signed-out path cannot answer
   it, and the decision is gated by the rule's own steps instead.
4. **Passes are gated; deliveries are not.** `private.decide_access_scan` records Denied while a pass has an approval
   that is not Approved; a withdrawn approval does not gate. A dock booking's approval shows on the dock schedule and
   in Gateway's deliveries tab, and the booking stands.
5. **Signed-out decisions, for outside approvers only.** An engagement step may let its approver decide from the email
   without signing in (`signed_out_links`). `app.mint_notification_action_tokens` marks a link `sign_in_required =
false` only when the recipient answers through such a step and has no active membership in the rule's org.
   **Members always sign in**, so their org's security settings apply and their email digests never hold an approval.
   The approver still needs an XOS account (any Gateway account): `private.recipient_address` reads email only from
   `auth.users`, so activating a rule refuses `approval_step_no_approver` while a step reaches nobody with one.
6. **The link plus an emailed code (invariant 8).** The signed-out page reads `api_public.read_approval_link(token)`,
   which returns only the link's state, its action, the org, a masked email and the expiry: no title, which would
   carry the pass holder's name. "Email me a code" calls `api_public.request_approval_link_code`, which queues
   `approval.link_code` (Email only, transactional template `approval_link_code`, archived as soon as it is queued so
   it never shows in an inbox) and refuses `approval_link_email_off` when the recipient turned approval emails off.
   The dispatcher mints the 6-digit code while it renders that email (`app.mint_approval_link_code`, service role
   only), so the code exists in clear only in the email. Only `code_hash = sha256(token_hash || ':' || code)` is stored
   in `private.notification_action_codes`: the code is salted by the token's stored hash, because the raw token is
   never stored (ADR 0106). A code lives 10 minutes. `api_public.preview_approval_link(token, code)` shows the title
   and step once the code is right, and `api_public.use_approval_link(token, code, comment)` decides with the link's
   own action (an Approve link approves; a Reject link rejects with a reason), then uses every link of the
   notification. Wrong codes, expired or used links come back as refusal rows rather than exceptions, as 0430's
   `private.resolve_advance_token` does, so a failed attempt's count is kept.
7. **Limits are per notification.** A127 binds each token to one action, so the email carries an Approve link and a
   Reject link. Failed attempts, the lock at 5, code requests (one a minute, five an hour) and live codes count across
   every link of the same notification: a forwarded email gets no second budget, and a lock locks both links. Someone
   holding a forwarded link cannot get a code without reading the approver's mailbox, which answers ADR 0106's
   objection for these links.
8. **Reminders, rate-limited (G-261).** Three organization settings (`approvals.reminders_enabled`, default on;
   `approvals.reminder_interval_hours`, 24 within 4 to 168; `approvals.reminder_limit`, 3 within 1 to 10) drive
   `private.send_approval_reminders`, which pg_cron runs hourly at minute 53 (minute 23 already runs the org lifecycle
   and advance reminders). A spend approval in review, a submitted timesheet and a subject approval in review remind
   the approvers of their current step when the interval has passed since they were last notified and the limit is
   not reached; the ledger row (`app.approval_reminders`) is written before anything is queued, so a second run sends
   nothing. `approval.reminder` goes through `private.notify`, so preferences and quiet hours apply, its push offers
   Approve and Reject (`approval_request`), and each email mints fresh one-tap links, so an outside approver whose
   link expired gets a working one. The requester's Remind approvers (`app.remind_approvers`) is allowed once every
   4 hours from the last notice, counts toward the limit and names the next allowed time when it refuses.
   `app.approval_reminder_status` shows, per pending approval and step, when it began to wait, when its approvers
   were last notified, the reminders of the limit and the next automatic one.
9. **Equipment waits for R7 and R9.** An Equipment rule can be written but stays a Draft
   (`approval_rule_equipment_pending`) until R7's allocations and R9's answer review merge. That follow-up (planned as
   2863, or the next free number above every applied migration then) gates `app.decide_allocation` with
   `approval_rule_pending`, makes R9's answer-review trigger treat that refusal as it treats R7's own, and does not
   approve an allocation when its subject approval is approved: a reviewer still does. There is no second
   allocation-approval screen.

## Consequences

- Rules, steps and subject approvals stay out of Trash (ADR 0110): removing a rule or a step is a settings change, and
  an approval is withdrawn by Cancel, never restored.
- The approval email to an outside approver carries two links that work signed out; everything they reveal before the
  code is the org's name and a masked address.
- Reminders add at most `reminder_limit` notices per approval step, and none while reminders are off.
- `org-lifecycle` and `sms-webhook` boot ceilings rose (219 and 149 KB) for the access-code email and the reminder
  copy (recorded in `packages/platform/test/edge-bundle.test.ts`).
- No API change: `notifications.act` already takes approve and reject, and the v1 OpenAPI contract is unchanged.

## Alternatives considered

- **Extend 1030's spend engine.** Rejected: its instances need an amount and a currency, and its approvers must be
  members with the document's spend capability.
- **Let the link alone authorize.** Rejected again, as in ADR 0106: invariant 8 needs an access code.
- **Mail the code inside the approval email.** Rejected: a forwarded email would carry both factors.
- **Signed-out links for members too.** Rejected: members would skip their org's IP allow-list, MFA and session rules.
- **Count attempts per link.** Rejected: the Approve and Reject links would give a forwarded email two budgets.
