# ADR 0072: Compass Settings: Payout and Tax, Calendar Feeds, Connected Apps and Developer

- Status: Accepted
- Date: 2026-10-24
- Decider: A112 (RRR-157), trace row S4.5.6-44
- Migrations: none

## Context

ADR 0006 item 11 has Compass show the person's own settings natively. A110 (ADR 0070) built the section list in `apps/compass/src/settings/sections.ts`, the identity group and the offline rules: lists read online with the person's session are kept in device-local tables (`_me_*`) and shown offline, a change queues in the outbox where the call gives the same result however often it runs, and a change that needs the server's answer at once is disabled offline. A111 (ADR 0071) built the preferences group and Work Details. Four sections of the work group still opened Gateway: Payout and Tax, Calendar Feeds, Connected Apps and Developer.

Each of them holds something that must not reach the phone in full: a bank account, a taxpayer identification number, a feed token, an OAuth refresh token or an API secret. The backends already return only what may be shown: the last four characters of an account or identifier through `api_external` (0730, 0750, 1124), a four-character hint of a feed token (1410), and a token's prefix (1432).

## Decisions

### 1. The four sections are Compass screens over Gateway's own functions

Each screen reads and writes through the `@xos/data` functions Gateway's section uses, with the person's session, so row level security and the RPCs decide exactly as they do in Gateway:

| Section        | Reads                                                                                                    | Writes                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Payout and Tax | `listPayoutAccounts`, `listTaxForms`, `listW9Addresses` (the person's own rows, not a company account's) | `app.set_tax_form_address`                                                         |
| Calendar Feeds | `listMyPersonCalendarFeeds`                                                                              | `createPersonCalendarFeed`, `rotatePersonCalendarFeed`, `revokePersonCalendarFeed` |
| Connected Apps | `listConnectedApps` (`app.my_oauth_apps`, 1563, with when the app last used its access)                  | `revokeConnectedApp`                                                               |
| Developer      | `listPersonalTokens` for the person, `listOrgsAllowingPersonalTokens`                                    | `revokePersonalToken`                                                              |

Calendar Feeds manages the person's own feed across every org they work with, as Gateway does. An org's member and project feeds stay in Atlas, Me, Calendar Feeds.

### 2. Offline: lists show, and only the W-9 address queues

- Each list is kept in its own device-local table (`_me_payout_accounts`, `_me_tax_forms`, `_me_calendar_feeds`, `_me_connected_apps`, `_me_personal_tokens`), refreshed whenever the section opens online and wiped on sign-out. A list never opened online on the phone says so.
- The W-9 name and mailing address queue as a `set_tax_form_address` call. It sets the same values however often it runs, so a replay after a lost answer changes nothing. The checks before it are Gateway's (`setTaxFormAddressAction`): a name up to 200 characters, a street, a city, a two-letter state and a five-digit ZIP or ZIP+4.
- Adding a feed, a new link, revoking a feed, disconnecting an app and revoking a token need the server's answer: a new link exists only in that answer, and the rest end access somewhere else at once. Their buttons are disabled offline with the section's offline notice.

### 3. A feed link is shown once and copied through the share sheet

A new feed or a new link comes back once, in the answer. The screen keeps it in memory until the person leaves; it is never written to the device database. The link is on Gateway's origin, as Gateway issues it. Copy or Share Link opens the system share sheet, whose first action is Copy on iOS and Android, and Open in my calendar app opens the webcal link.

Alternative: a Copy button through a clipboard module. Rejected, because it would add a native dependency, with its own privacy manifest entry and a new build, for what the share sheet already does.

### 4. Creating a personal API token stays in Gateway

Developer lists the person's tokens in every org with their standing (active, expired, revoked) and revokes them. Create a Token in Gateway opens Gateway's Developer section and says why:

- the secret is shown once and is meant for a script on a computer, so it is made on that computer instead of copied off a phone;
- issuing it needs a second factor passed in the last 15 minutes (A77, 1333), and the form offers the capability groups the person holds in that org.

Where no org the person belongs to allows tokens, the screen says so instead.

### 5. The steps Payout and Tax leaves to others are named

- Payout details are entered through each org's payment provider; XOS never holds them, so there is no entry step to draw. The screen says so, as Gateway does.
- Giving a tax form belongs to the onboarding of the engagement that asks for it. Compass has no engagement screen, so Give a Tax Form opens Gateway's engagements and says why.
- No step of the section needs step-up.

### 6. Every section is accounted for

`apps/compass/test/settings-parity.test.ts` lists the 14 sections with the route each opens:

- A section with a Compass screen must open it. With A110, A111 (ADR 0071) and this ADR, all 14 do.
- A section without one must state, in the test, why it opens Gateway instead. None does now; the rule stays for a section the sitemap adds.
- Each step a screen leaves to Gateway on purpose is listed with the message key of the reason the screen shows: adding a security key, stepping up with only a security key, creating a company account, the passport and what Work Details shares, giving a tax form and creating a personal API token.

## Consequences

- A person checks where they are paid, completes a W-9 address, manages calendar feeds, disconnects an app or revokes a token from the phone, under the same rules as Gateway.
- Creating a personal API token needs a computer, by design.
- A member's own org schedule feed is still managed in Atlas.
