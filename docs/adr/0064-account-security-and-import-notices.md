# ADR 0064: Account Security and Import Notices, and Only the Channels a Category Reaches

- Status: Proposed
- Date: 2026-10-23
- Decider: A104 (RRR-149) took the decisions below as the follow-up to A77, A83 and A99 (RRR-122, RRR-128, RRR-144)

## Context

The notification registry (`packages/schemas/notification-kinds.yaml`) declared two kinds that nothing sent:

- **`account.security_changed`** had copy, an Inbox description and, from 1620 (ADR 0033 decision 62), a place on the quiet-hours bypass list, but password, email and phone changes happen inside Supabase Auth, second factors and passkeys are enrolled and removed through it, and A99's recovery codes sent only `account.recovery_code_used`.
- **`import.finished`** had its own email template (`import_finished`: the import's name, written, refused and skipped counts and a review link), but the import pipeline (0530, 1061) notified nobody, and only the import worker knows Atlas's address.

Separately, the preference grids offered a switch for every channel on every category. Opportunities showed SMS although its only kind (`opportunity.matched`) is never texted; once 1620 narrows `report.delivered` to In App and Push (ADR 0033 decision 77), Reports would show Email and SMS switches that could deliver nothing.

## Decision

1. **Security notices come from the database, at the source.** Triggers on Supabase Auth's own tables call `private.notify_account` (1560), whatever path made the change (Atlas, Gateway, Compass, the Auth API, an admin or a reset email):
   - `auth.users` (after update of `encrypted_password`, `email`, `phone`): `password`, `password_set` (a sign-in without a password gets one), `email`, `phone`;
   - `auth.mfa_factors`: `factor_added` when a factor becomes verified (an unfinished enrollment sends nothing), `factor_removed` when a verified one is deleted, each with `factorType`;
   - `auth.webauthn_credentials` (Supabase Auth's passkeys, created by its own migrations before ours run): `passkey_added`, `passkey_removed`;
   - `app.generate_recovery_codes` (redefined from 1560): `recovery_codes`.

   One notification per change; a factor or passkey deleted with its sign-in sends nothing. The `change` argument selects the sentence of `email.kinds.account.security_changed.body` (an ICU select, en-US and es-US), so every channel reads in the recipient's language rather than printing a code. A notice that fails is logged as a warning and never blocks the change: the triggers run inside Supabase Auth's transaction, and a password reset must not fail because a notification did.

2. **The import worker announces, the database counts.** When validation or a commit finishes, the worker builds the absolute review link (`XOS_APP_URL`/`{org}/import?import={id}`, the wizard at the step the import reached) and calls `app.notify_import_finished` (1701, service role). The function counts the rows from `app.import_row_results`, picks the person (who started the import, or who committed the batch) and sends `import.finished` about the import (`app.import_jobs`), with the arguments the `import_finished` template reads. A notice that cannot be sent never fails or repeats the step; the worker reports it with the step's result (`noticeError`). Without `XOS_APP_URL` nobody is told.

3. **A validated import says it waits for review.** The template and the kind's copy take a `stage` argument (`validated` or `committed`, committed by default): after validation, written counts the rows ready to write and refused the rows to fix, and the copy asks the person to review and commit; after a commit it says what was written. The template's other props are unchanged.

4. **Grids offer only the channels a category's kinds reach.** `categoryChannels` (with `notificationCategoryChannels` over the generated registry) in `@xos/schemas` joins the channels of a category's kinds. Atlas's member and org grids keep one column per channel but leave an unreached cell empty, with a sentence for screen readers; Gateway's personal and company preferences list only the party channels a category reaches (`partyChannels`). No save writes a choice for an unreached channel. While there, a Gateway company default form saves only its own category: each category has its own form, and saving one used to turn the others off.

## Consequences

- `account.security_changed` and `import.finished` move from deferred to emitted in the registry; `export.ready` and `report.delivered` (until 1620 merges) remain deferred.
- A test fixture that sets a phone or a password on a member now creates a security notice; suites that count deliveries clear it (1361).
- The hosted project needs nothing new: `XOS_APP_URL` is already set for the notification dispatcher, and the triggers use the privileges the `postgres` role already holds on `auth` tables.
- When 1620 lands, its `decidedAhead` exception in `emitters.test.ts` (security changes on the bypass list before anything sent them) is no longer needed, since the kind is emitted.
