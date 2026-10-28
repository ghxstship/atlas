# ADR 0115: Addresses and Work Phones Checked by Country

- Status: Accepted
- Date: 2026-10-28
- Decider: A139 (RRR-202), trace rows S15-13 and S15-14
- Migrations: `2320_postal_codes_by_country.sql`, `2321_work_phone_e164.sql`

## Context

Section 15 asks for addresses with per-country formats and validation from Google's address metadata, and for phone
numbers stored in E.164 and shown in national format. `packages/i18n/src/formats` already had both (A78): address
layouts, required fields and postal code patterns, and `toE164` and `formatPhone` through libphonenumber-js. Only
the Work Details emergency contacts and the Gateway W-9 address used them. Venue addresses were three free-text
fields, vendors and org legal entities had no address at all, and the work phone (`workforce.work_phone`, 1010) was
any text up to 32 characters. Production has held these columns since 4.0, so stored values may not fit.

## Decisions

### 1. The forms decide by country; the database checks the postal code again

Every address form in Atlas lays out its fields in the country's order and marks the fields that country requires,
from a layout the server computes (`apps/atlas/lib/address.ts`), so no address metadata reaches the browser. The
server action reads the address back against the same country: what the country requires, a postal code that fits,
written the way the country's post writes it (`normalizePostalCode`). An address left wholly blank is not recorded.

The database checks only the postal code, with the same patterns (`private.postal_code_pattern`, kept equal to
`address.ts` by a test that reads the migration). Required fields stay a form rule: an API caller may record a
partial address, and a postal code alone is what a later process (tax filing, shipping) cannot repair.

| Record           | Country from                          | Form                                                   |
| ---------------- | ------------------------------------- | ------------------------------------------------------ |
| Venue            | First two letters of its jurisdiction | Venue form; the state is the jurisdiction's, not asked |
| Org legal entity | `country_code` (1200)                 | Legal Entities and Fiscal, per entity                  |
| Vendor           | New `country_code` beside the address | Vendor record, Mailing address                         |
| W-9 (tax form)   | Always US                             | Gateway Tax Documents                                  |

Vendors and legal entities gain address columns (2320); the legal entity address reads through
`app.org_legal_entities_masked`, appended so existing columns keep their places. A vendor's address fields need its
country (`vendors_address_country`). The W-9 keeps the ZIP constraint of 1124.

### 2. New and changed rows are checked; stored rows are listed, not broken

`private.enforce_postal_code` and `private.enforce_work_phone_e164` are triggers, not `CHECK ... NOT VALID`
constraints. A `NOT VALID` check still runs on every update of the row, so renaming a venue whose stored postal code
does not fit would fail. The triggers check a row when it is inserted or when its country, postal code or phone
changes, and never otherwise.

Stored values that the checks would refuse are listed in `private.contact_format_exceptions` (service role only, no
backup login), and the migration prints their count per table. The org or person fixes each from the record or Work
Details; nothing is rewritten without them, except as decision 3 allows.

### 3. Stored work phones are rewritten only where the form is unambiguous

SQL cannot run libphonenumber, so `private.e164_from_text` reads only numbers whose meaning does not depend on a
numbering plan: `+` or `00` and 8 to 15 digits with any spacing, and ten digits in the North American shape (or
eleven with the leading 1), read as a US number because XOS ships in en-US and es-US. Anything else, such as a
national number of another country or a number without its area code, stays as typed and is listed. The rewrite runs
once (`private.normalize_work_phones`); it skips per-org values of people who have left that org, which the 0850
guard refuses to write.

The database check is the E.164 shape: `+`, a first digit other than 0, and 8 to 15 digits. Whether the number exists
in its country's plan is `toE164`'s question, asked by Atlas, Gateway and Compass on save, each reading what the
person typed in the region of their language. The setting registry marks the work phone `input: phone`, so every
settings form uses a telephone keyboard and shows the stored number with `formatPhone`, national for the viewer's own
country and international otherwise.

## Consequences

- An API write of a work phone that is not E.164, or of a postal code that does not fit its country, is refused with
  `work_phone_e164` or `postal_code_invalid` (XR001). The v1 contract is unchanged.
- A country added to `address.ts` needs the same line in a new migration's `private.postal_code_pattern`; the i18n
  parity test fails until it has one.
- OSHA establishment and case addresses (1385) keep their own ZIP checks; decision 54 defers the OSHA forms.
