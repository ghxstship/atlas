# ADR 0089: One-Tap Actions from Email and Push, and Gateway's For Your Information

- Status: Proposed
- Date: 2026-10-27
- Decider: A127 (RRR-172) took the decisions below for trace row S11.10-06 (Section 11.10 rule 5: one inbox model,
  act where notifications arrive)

## Context

The Inbox already acts where an item arrives: approve (A), reject with a reason (R), Done (E) and snooze (H), through
`app.act_on_notification`, and Compass answers an approval request's push with Approve and Reject (ADR 0030). Email
carried only an Open link, so every approval asked for a sign-in, a page and a search for the item. Push offered no
action on a shift to accept, an offer to answer or a message, and an offer to a marketplace applicant sent no
notification at all. Gateway Home showed what needs the person, and a short Updates list with no way to clear it.

## Decision

1. **Signed, hashed, single-use tokens, minted at dispatch.** `private.notification_action_tokens` holds one row per
   action an email offers: the notification and its delivery, the recipient, the kind, the action, the subject, the
   app that confirms it, `token_hash` (SHA-256), `expires_at`, `used_at` and `revoked_at`. The email worker calls
   `app.mint_notification_action_tokens(delivery)` (service role only) while it renders the email; the token is
   `xact_` and a random 24-byte nonce in hex, a dot, and the first 32 hex digits of HMAC-SHA256 over the nonce and
   the action under the Vault key `xos_notification_action_key`, which migration 2200 creates per environment. Only
   the hash is stored and the token is returned once. A token whose signature does not match its row's action is
   unknown, so a token is bound to its action and a forged one fails before any state is read.
2. **The actions an email offers are the Inbox's.** `private.notification_link_actions` decides, at mint time:
   approve and reject for an approval or a timesheet still awaiting a decision (Atlas), accept for a published shift
   the recipient works (Atlas for a member, Gateway for an engaged worker) and for an offer awaiting the applicant
   (Gateway). Decline stays in the Inbox and on push; an email offers only the actions this package's bar names.
3. **A link never acts on GET.** Each link opens `/auth/act/{token}` in Atlas or Gateway under the Auth template. The
   page signs the person in first if needed, then reads `app.read_notification_action`, which answers `ready`,
   `used`, `expired`, `not_yours` or `invalid`; someone else's link says nothing about what it does. The page's
   button calls `app.use_notification_action(token, comment)`, so approving from an email takes two taps: the
   email's button and the confirm page's.
4. **The in-app action decides.** `app.use_notification_action` checks the recipient is the signed-in person, the
   link is unused and unexpired, and a rejection has its reason, then runs `app.act_on_notification` as that person.
   Every approval, timesheet, shift and offer rule, and step-up (`private.require_step_up`, which the Atlas page
   answers with the step-up dialog), applies as it does in the Inbox. A refusal rolls back and leaves the link
   unused. Acting uses every link of the notification, and the notification leaves the Inbox.
5. **Expiry and retries.** A link lives 7 days. A retried delivery mints fresh links and revokes the earlier
   attempt's. Links 30 days past expiry are deleted the next time any email is minted.
6. **Push actions for offers and messages.** `packages/platform/src/notifications/push.ts` adds the server categories
   `shift_offer` (a shift notice whose `shiftState` argument, added to `private.notify_shift_change`, is Published),
   `engagement_offer` (`offer.sent`) and `message_reply` (`message.received`). Compass registers them in
   `apps/compass/src/runtime/offer-actions.ts` beside `useActionableNotifications`, with its own response listener
   that answers only its own actions. Accept and Decline on a shift work from the lock screen; an offer's terms and
   a reply ask for the device to be unlocked. Each action calls `notifications.act`, whose `action` enum gains
   `accept`, `decline` and `reply` (an additive v1 change). `app.act_on_notification` accepts a shift through
   `app.accept_shift` or `app.accept_engaged_shift`, declines it through the new `app.decline_shift` (back to Draft
   with the reason in its ledger, for the scheduler), accepts or declines an offer through `app.accept_offer` and
   `app.decline_offer`, and replies through `app.send_chat_message`. Done and these actions reach any recipient;
   approve and reject stay a member's.
7. **Offers reach the applicant.** A trigger on `app.offer_versions` sends `offer.sent` when the org's terms wait on
   the applicant (a new offer or revised terms). While an offer is Sent or Countered, `private.party_org_ids`
   counts the offering org as one the applicant works with, so `private.notify` and
   `app.claim_notification_deliveries` deliver it by email and push without being redefined.
8. **Gateway's For Your Information.** Gateway Home lists `app.inbox_items` in For Your Information across every org
   that notified the person, with Done and Snooze buttons and the keys E, H, J and K on a roving-focus list, in place
   of the Updates list. The `app.inbox_snoozes` policies now ask only that the notification is the person's own
   (`private.is_my_notification`), so an external party snoozes too.

## Consequences

- Rotating `xos_notification_action_key` invalidates every open link; the emails still carry their Open links.
- The email worker writes one token row per action per sent email. The table is private, never readable by
  signed-in callers, and keeps no token.
- A forwarded email cannot be used by anyone else: the confirm page asks for the recipient's own sign-in.
- The notification-dispatch Edge Function's boot ceiling rose from 180 to 186 KB for the link helpers, the push
  categories and the new copy (recorded in `packages/platform/test/edge-bundle.test.ts`).

## Alternatives considered

- **Act on the link's GET.** Rejected: mail scanners and link previews open links, and Section 11.10 rule 5 asks for
  a confirmation on anything irreversible.
- **A signed token with no table (stateless HMAC with an expiry).** Rejected: single use and revocation need state.
- **Let the link alone authorize, without a sign-in.** Rejected: a forwarded email would act as its recipient, and
  step-up could not apply.
