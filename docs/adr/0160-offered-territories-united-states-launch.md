# ADR 0160: One Source of Truth for Offered Territories, With a United States Launch

- Status: Proposed
- Date: 2026-11-06
- Decider: Legal review issue 3 (RRR-248), on the owner's instruction to take the most future-proof, defensible option. Made by AI; no attorney has reviewed it.
- Migration: `6150_offered_territories.sql`
- Amends: ADR 0053 (Beta locales are choices only while a territory holding them is open); ADR 0037 (a run with no locale named skips a closed territory's locale)

## Context

The legal review found signs that XOS is offered in the EU and UK with no representative appointed: EUR and GBP prices, Beta locales in French, German and Italian, and EU contract terms. GDPR Recital 23 names a currency and a language with the ability to order in it as signs of an intent to offer, and the OAIC and OPC read similar signs. Stripe Checkout also presented a local currency by itself, because every price carries a currency option and no session named one.

The decision is to launch in the United States only and keep everything needed to open other territories with no code change.

## Decisions

### 1. `private.territories` is the one source of truth

Each row holds a territory's countries, the price book currencies and languages that open with it, and whether it is offered. Only `US` is open at launch; `EEA`, `GB`, `CH`, `CA`, `AU`, `BR` and `JP` are seeded closed. The `US` territory is the United States and its inhabited territories (PR, VI, GU, AS, MP). An Administrator (`territories.write`) opens, closes, adds or edits a territory on the console's Territories page, with a reason; each change lands in `app.platform_operator_actions`. The last open territory cannot close.

Every shell reads `api_public.offered_territories` through `@xos/i18n/offering`, kept for a minute in production. **A failed read gives the launch state**, so an outage can only close a territory, never open one. `DEFAULT_OFFERING` and the migration's seed are held equal by `packages/i18n/test/offering.test.ts`.

### 2. While a territory is closed

| Surface        | What happens                                                                                                                                                                                    | Where                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Pricing copy   | Only open currencies are mentioned; "EU data residency" leaves the plan list                                                                                                                    | Billing and Plan, `planFeatureOffered`               |
| Checkout       | Every session names its currency and turns adaptive pricing off, so Stripe never picks one from where the buyer seems to be. A closed territory's organization, under an exception, pays in USD | `app.org_checkout_currency`, `createCheckoutSession` |
| Partner prices | A closed currency is not a price a partner can set                                                                                                                                              | Partner console                                      |
| Languages      | Only open languages are choices: the shell menus, the Language setting, the server actions. A saved choice of a closed language reads as no choice, in Atlas, Gateway, Console and Compass      | `selectableLocales`, `negotiateLocale`, `languageOf` |
| Translation    | `translate` with no `--locale` skips a closed target, so no catalog is written or paid for. Naming the locale still works. Today every Beta catalog is empty                                    | `translation/config.json` `closed`                   |
| Signup         | Asks the country, with no answer chosen; refuses a closed one in a plain sentence and creates nothing                                                                                           | `app.create_organization`                            |

en-US and es-US are always offered. Nothing is deleted: the price book, the Stripe currency options, the Beta locales and the EU contract terms all stay.

The Stripe catalog keeps its currency options on purpose. A price's options are not visible to a buyer once the session names its currency, and removing them would need new prices on the day a territory opens.

### 3. The gate is at the organization, never at the person

Being a worker is not being offered XOS. A crew member touring abroad, invited by a US organization, signs up, accepts and works as anyone does. **Nothing reads an IP address or geolocates anyone**, and nothing checks a person's country: the only question is the country the creator of an organization states.

`app.organizations.country_code` records it. Three paths start an organization using Atlas, and all three check: `app.create_organization`, `app.create_client_organization` and `app.subscribe_external_account`.

Gateway company accounts (`app.create_external_account`) carry no plan and no billing, and a foreign vendor on a US production needs one, so they are not gated. One that starts Atlas is. Counterparties and sandboxes are not customers and record no country.

### 4. API v1 stays additive

`country_code` is an optional field on `POST /organizations` and `POST /organizations/clients`. Omitted, the caller states the United States, as the API description says. A refusal is a 422 with the rule `territory_not_offered`. Refusing a request that omits the field would break a caller of the frozen v1, and the statement is no weaker than choosing United States on the form: both are the creator's word, which the Terms make them answer for.

### 5. An exception allows one organization for a signed contract

An Administrator records an owner email, a country, the contract and its signing date, and a reason. The person who holds that confirmed email can start one organization in that country; it is used once and can be withdrawn before use. It opens no currency and no language: that organization pays in USD and reads en-US or es-US.

**An exception appoints no representative.** The console says so. Signing a customer in the EU is itself offering to that customer, so whoever records one confirms first what that country's law requires.

### 6. Existing organizations are untouched

An organization from before the question has no recorded country and keeps working. Closing a territory touches no organization. The console lists organizations using Atlas outside the offered territories, or with no recorded country, for a person to review.

## Before opening a territory

The reason the console asks for is where this is recorded. From the legal research, and for counsel to confirm when it happens:

| Territory  | Before opening                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EEA        | GDPR Art. 27 representative; DSA Art. 13 legal representative, with its languages on the Contact Page; SCCs and the DPA's EU terms checked; localized terms and consumer rules |
| GB         | UK GDPR Art. 27 representative; UK Addendum current                                                                                                                            |
| CH         | Swiss Art. 14 representative where its four conditions are met                                                                                                                 |
| CA         | PIPEDA and Quebec Law 25, including French where required                                                                                                                      |
| AU, BR, JP | Their privacy regimes; for Brazil an encarregado                                                                                                                               |

Opening also means running `translate --locale <code>` if the language should read translated, and confirming that app store availability matches.

## Consequences

- Signup has one more question. Journeys that create an organization through the form choose a country in `e2e/support.ts`.
- `selectableLocales`, `negotiateLocale` and `languageOf` default to the launch locales, so a caller that forgets the offering is closed, not open.
- A production server shows an operator's change within a minute.
- Self-declaration is a control, not proof: someone can state the wrong country. The Terms carry the matching statement.
