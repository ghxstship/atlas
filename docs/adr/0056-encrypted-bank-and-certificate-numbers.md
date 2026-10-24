# ADR 0056: Encrypted Bank and Certificate Numbers

- Status: Accepted
- Date: 2026-10-23
- Decider: A100 (RRR-145), applying Section 9 and the owner's decisions 38 and 49 (ADR 0033)

## Context

Section 9 asks for field-level pgcrypto encryption of tax identifiers, bank details, government identifiers and medical notes (trace row S9-12). Tax identifiers (0730, 1200), medical notes (0363) and passport numbers (1340) were encrypted. Three Restricted columns were not:

- `app.vendor_bank_accounts.account_number` and `routing_number` (0330), classified under `data.restricted.read.banking`. They were masked in `app.vendor_bank_accounts_masked` and not selectable, but stored in plain text.
- `app.supplier_diversity_certifications.certificate_number` (1464), classified as a government identifier under `data.restricted.read.government_id`. It was stored in plain text, and `app.shared_supplier_diversity` handed it whole to every org reader holding that capability, with no reason and no step-up.

Decision 38 sets the rule for a government identifier: encrypted under its own Vault key, masked, and revealed only through an audited step that needs a second factor and a reason. Decision 49 keeps the Vault keys that migrations created in the project.

## Decision

1. **The org tax identifier pattern of 1200, for both tables.** Each value is encrypted with `pgp_sym_encrypt` under its own Vault key, created by its migration the way decision 49 describes: `xos_vendor_bank_account_key` (1660) and `xos_supplier_certificate_number_key` (1661). The key functions are never granted to signed-in callers. The ciphertext is never selectable or writable by them, and a guard trigger refuses any write of it, or of its last four, outside the encrypting RPC.
2. **Column names stay.** The bytea columns keep their names, so the classification rows, the AI never-send list, the export classification checks and the audit trail's exclusions apply unchanged, and `app.vendor_bank_accounts_masked` keeps its shape. The v1 API reads only `account_last4` through that view, so the frozen contract does not change.
3. **Writers.**
   - `app.set_vendor_bank_account` adds a vendor's bank account, or replaces one's details, with `vendors.bank_details.write`. It derives `account_last4` from the account number: the check 0330's constraint used to make, which a constraint cannot make on ciphertext. The last four keeps its format check.
   - `app.set_supplier_diversity_certificate_number` lets the owner set or clear a certificate number, which stays write-only to them as 1464 had it. The new `certificate_number_last4` column (Confidential) holds the last four, as `passport_number_last4` does.
   - Both keep only letters and digits, upper-cased, like the tax identifier and passport writers: an account number has 4 to 34 (34 is the longest IBAN), a routing number up to 34, a certificate number 1 to 100.
4. **Readers.**
   - Bank numbers decrypt only inside the masked view, for holders of `data.restricted.read.banking`. Everyone else who reads vendors sees NULL with `is_masked` and the last four, as before.
   - A certificate number is a government identifier, so it follows decision 38 rather than the view pattern. `app.shared_supplier_diversity` now shows every reader its last four. The whole number leaves only through `app.reveal_shared_supplier_diversity_number`, which needs:
     - a live share with an org that runs a supplier diversity program
     - `vendors.vendor.read` and `data.restricted.read.government_id` in that org
     - an aal2 session through `private.require_second_factor` (no recency, as for passports and Restricted exports)
     - a reason of at least 10 characters
   - The reveal is logged with the reason in the owner's access log (`app.supplier_diversity_events` gains `reason` and the `revealed` action) and in the org's audit ledger, never with the value. Atlas offers it under Vendors, Directory, through the step-up dialog.
5. **Existing rows are encrypted in place, as stored.** `private.encrypt_column_in_place` replaces a text column with its ciphertext under the same name and keeps NULL and NOT NULL. It runs with the table's user triggers off, so the rewrite logs no bank detail change, writes no audit event, keeps `updated_at` and adds nothing to the owner's access log. It refuses a column that a constraint, index, default, view, policy or trigger depends on, so nothing is dropped silently. Migrated values keep their punctuation; new writes keep letters and digits. A certificate number with no letter or digit (only punctuation) identifies nothing and is cleared.

## Consequences

- No Restricted banking or government identifier column stores plain text. The pgTAP suite of 1661 checks this across the column registry, so a new plain-text column under either capability fails the build.
- An org member with government identifier access no longer sees certificate numbers in the shared list. They reveal one at a time, with a reason and their second factor, and the owner sees each reveal.
- A routing number given only as punctuation is stored as none, and a bank number longer than 34 letters and digits is refused.
- Production gets the two keys when 1660 and 1661 are pushed. `promote-to-production.md`, step 10, lists them with the keys decision 49 keeps. Rotating them, like the other field keys, is the annual re-encryption `legal/policies/encryption.md` describes; no tooling for it exists yet.
