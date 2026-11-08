# ADR 0160: One Source of Truth for Offered Territories, With a United States Launch

- Status: Proposed
- Date: 2026-11-06
- Decider: Issue 3 of the AI legal audit (RRR-248), on the owner's instruction to take the most future-proof, defensible option. Made by AI; no attorney has reviewed it.
- Migration: `6830_offered_territories.sql`
- Amends: ADR 0053 (Beta locales are choices only while a territory holding them is open); ADR 0037 (a run with no locale named skips a closed territory's locale)

## Context

The AI legal audit found signs that XOS is offered in the EU and UK with no representative appointed: EUR and GBP prices, Beta locales in French, German and Italian, and EU contract terms. GDPR Recital 23 names a currency and a language with the ability to order in it as signs of an intent to offer, and the OAIC and OPC read similar signs. Stripe Checkout also presented a local currency by itself, because every price carries a currency option and no session named one.

The decision is to launch in the United States only and keep everything needed to open other territories with no code change.

## Decisions

### 1. `private.territories` is the one source of truth

Each row holds a territory's countries, the price book currencies and languages that open with it, and whether it is offered. Only `US` is open at launch; `EEA`, `GB`, `CH`, `CA`, `AU`, `BR` and `JP` are seeded closed. The `US` territory is the United States and its inhabited territories (PR, VI, GU, AS, MP). An Administrator (`territories.write`) opens, closes, adds or edits a territory on the console's Territories page, with a reason; each change lands in `app.platform_operator_actions`. The last open territory cannot close. An edit starts from what the territory holds, because saving replaces its lists, and adding cannot land on an existing code. Its currency choices come from the price book, so a currency a territory gave up can be chosen again.

Every shell reads `api_public.offered_territories` through `@xos/i18n/offering`, kept for a minute in production. **A failed read gives the launch state**, so an outage can only close a territory, never open one. Every page in every shell reads the offering, so no page waits on it: a read gives up after 1.5 seconds, and once a minute's keeping has passed, the last good read answers at once while one request refreshes behind it, for up to ten minutes before the launch state answers instead. `DEFAULT_OFFERING` and the migration's seed are held equal by `packages/i18n/test/offering.test.ts`.

### 2. While a territory is closed

| Surface        | What happens                                                                                                                                                                                                                                                 | Where                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Pricing copy   | Only open currencies are mentioned; "EU data residency" leaves the plan list                                                                                                                                                                                 | Billing and Plan, `planFeatureOffered`                   |
| Checkout       | Every session names its currency and turns adaptive pricing off, so Stripe never picks one from where the buyer seems to be. A closed territory's organization, under an exception, pays in USD                                                              | `app.org_checkout_currency`, `createCheckoutSession`     |
| Partner prices | A closed currency is not a price a partner can set, in the console or directly through the database. A price already in one keeps working, and can change its amount, until the partner moves it                                                             | `private.guard_partner_price_currency`                   |
| Languages      | Only open languages are choices: the shell menus, the Language setting, the server actions. A saved choice of a closed language reads as no choice, in Atlas, Gateway, Console and Compass. Email and the API settings do not check: see Consequences        | `selectableLocales`, `negotiateLocale`, `languageOf`     |
| Translation    | `translate` with no `--locale` skips a closed target, so no catalog is written or paid for. Naming the locale still works. Today every Beta catalog is empty. The file's `closed` flag only guards that spend: `private.territories` decides what is offered | `translation/config.json` `closed`                       |
| Signup         | Asks the country, with no answer chosen; refuses a closed one in a plain sentence and creates nothing, in Atlas and for a Gateway company account                                                                                                            | `app.create_organization`, `app.create_external_account` |

en-US and es-US are always offered. Nothing is deleted: the price book, the Stripe currency options, the Beta locales and the EU contract terms all stay.

The Stripe catalog keeps its currency options on purpose. A price's options are not visible to a buyer once the session names its currency, and removing them would need new prices on the day a territory opens.

### 3. The gate is at the organization, never at the person

Being a worker is not being offered XOS. A crew member touring abroad, invited by a US organization, signs up, accepts and works as anyone does. **Nothing reads an IP address or geolocates anyone**, and nothing checks a person's country: the only question is the country the creator of an organization states.

`app.organizations.country_code` records it. Four paths start a customer's organization, and all four check: `app.create_organization`, `app.create_client_organization`, `app.subscribe_external_account` and `app.create_external_account`.

**A Gateway company account is an organization, so it has the same gate.** It carries no plan or billing, but anyone who signs in can start one with a public page, and Art. 3(2)(a) of the GDPR covers free services too. Its form says where XOS is offered, asks the country and refuses a closed one. This is stricter than a carve-out for foreign vendors, on purpose: "XOS is offered to organizations in the United States" is then true everywhere it is said.

What this costs, and what covers it: a vendor company abroad cannot start a company account by itself. Its people still accept invitations and work with their own accounts, and the US customer still records it as a counterparty. If the company must act as itself on a US production, an operator can record an exception naming the signed contract that engages it. A company account and its later start in Atlas each use an exception of their own, because the second is the larger step.

Counterparties and sandboxes are not customers and record no country. A counterparty row is a customer's record of another company, with nobody in it. A sandbox is sample data that is never billed, invites nobody and expires. Nothing in the database requires membership of an org to open one: someone refused at signup could open a sandbox through the RPC, and we accept that because nothing there is offered or sold.

### 4. API v1 stays additive

`country_code` is an optional field on `POST /organizations` and `POST /organizations/clients`. A refusal is a 422 with the rule `territory_not_offered`. Refusing a request that omits the field would break a caller of the frozen v1, so it still works.

**The record says only what someone stated.** A caller who omits the country stated nothing, so `country_code` stays null and the organization appears on the console's review list. The same holds for the database functions behind the forms, which anyone with a session can call directly. So the forms always ask, and the omission is visible rather than recorded as an answer. The Terms make whoever creates an organization answer for it being established where XOS is offered, whether or not they named a country.

### 5. An exception allows one organization for a signed contract

An Administrator records an owner email, a country, the contract and its signing date, and a reason. The person who holds that confirmed email, signed in, can start one organization in that country; it is used once, even when two calls race, and can be withdrawn before use. A partner cannot use one for a client, because a partner naming someone's email proves nothing about that person. It opens no currency and no language: that organization pays in USD and reads en-US or es-US.

**An exception appoints no representative.** The console says so. Signing a customer in the EU is itself offering to that customer, so whoever records one confirms first what that country's law requires.

### 6. Existing organizations are untouched

An organization from before the question has no recorded country and keeps working. Closing a territory touches no organization. The console lists organizations using Atlas and Gateway company accounts outside the offered territories, or with no recorded country, for a person to review. A country on record is not rewritten when a company account starts Atlas: stating a different one is refused `organization_country_recorded`, so it stays on that list.

## Before opening a territory

The reason the console asks for is where this is recorded. From the legal research, and for counsel to confirm when it happens:

| Territory  | Before opening                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EEA        | GDPR Art. 27 representative; DSA Art. 13 legal representative, with its languages on the Contact Page; SCCs and the DPA's EU terms checked; localized terms and consumer rules; say in Terms 11.3 and the switching guide that the commitments there meet the EU Data Act |
| GB         | UK GDPR Art. 27 representative; UK Addendum current                                                                                                                                                                                                                       |
| CH         | Swiss Art. 14 representative where its four conditions are met                                                                                                                                                                                                            |
| CA         | PIPEDA and Quebec Law 25, including French where required                                                                                                                                                                                                                 |
| AU, BR, JP | Their privacy regimes; for Brazil an encarregado                                                                                                                                                                                                                          |

Opening also means running `translate --locale <code>` if the language should read translated, and confirming that app store availability matches.

## Consequences

- Signup has one more question. Journeys that create an organization through the form choose a country in `e2e/support.ts`.
- `selectableLocales`, `negotiateLocale` and `languageOf` default to the launch locales, so a caller that forgets the offering is closed, not open.
- An operator's change reaches signup at once, since the database's gate is live. A busy production server shows it in prices and languages within about a minute. The bound is about 11 minutes: the first request after a long quiet spell, or while reads fail, can still be answered from the last good read.
- CI's production builds set `E2E_OFFERING_FRESH=1`, so they read the offering on every request. That way the journeys that open a territory prove that a production build reads it, since a failed read looks the same as the launch state. Nothing sets it in production; if something did, the only effect would be one more read per request.
- Self-declaration is a control, not proof: someone can state the wrong country. The Terms carry the matching statement.
- Stripe Checkout keeps tax ID collection on, because a US company can give its EIN there. The Legal Entities setting still says "EIN, VAT or GST number", because a US customer can run a subsidiary abroad. Both are a choice, not an oversight; review them when a territory opens.
- A saved choice of a closed language is ignored by the four shells, but email and the API settings still accept it. Today nothing shows, because Beta catalogs are empty. So translate a closed language only as part of opening its territory: with a catalog in place, a person who saved it would get that language in email first.
