# ADR 0090: Field History for Kind Attributes and Every Record Page

- Status: Accepted
- Date: 2026-10-28
- Decider: A131 (RRR-177), trace row S4.10-04
- Migrations: 2240, 2241

## Context

Section 4.10 asks for "a history tab on every record, built on the DiffViewer". 1452 (ADR 0044) built `app.field_history` on the audit ledger and offered it for eight tables, and 2100 (ADR 0074) added custom object records. Two gaps remained:

- A record's kind attributes live in its 1:1 extension row (`app.record_<kind>`, 0311). Those tables had no audit trail, so editing a Task's progress or a Contract's value left no trace in the record's history.
- Every other entity with a record page or peek in Atlas (expenses, change orders, budgets, engagements, agreements, shipments, inspections and about sixty more) had no field history, and only the record page, the SOP page and the custom object peek rendered one.

## Decisions

### 1. Extension rows are audited under their record's id

`private.audit_row_change` keys an audit event by the row's `id`, and an extension row has none: its key is `record_id`. 2240 adds `private.audit_keyed_row_change`, the same trigger with the key column named by its argument, and attaches it as `t85_audit_trail` to every table that `private.install_record_extension` tied to `app.records`. It leaves out what `audit_row_change` leaves out (`private.audit_excluded_columns`: audit columns, binary columns and Restricted columns) and skips the same rows. `audit_row_change` itself is not redefined: A130 owns it.

Alternative: write the extension's changes into the record's own trail, as 2100 does for custom object values. Rejected, because an extension row is a row of its own table, with its own Restricted classifications; keeping its subject table in the ledger lets `app.field_history` mask by the extension's columns.

### 2. A record's history merges its extension

`private.field_history_extensions` lists each extension table with the subject whose history merges it, the key column and a field prefix. `app.field_history` (redefined from 1452, its latest definition; its signature stays, so `app.field_history_events` of 2061, which groups its rows into one row per event, merges the extensions too) reads the subject's events and its extensions' events together and names each extension column `<prefix>.<column>`: a record's attributes read `attributes.progress_pct`. Saving the attributes the first time reads as each attribute going from nothing to its value; the extension's key, kind and bookkeeping columns are left out. The read check (the record's own read policies) and the Restricted masking are unchanged, the masking by the extension table's own classification.

The history now also leaves out a column that signed-in people cannot select at all (a withheld column grant, such as `app.agreements.access_code_hash`): the ledger keeps such a column's changes, but a history readable by everyone who reads the row must not return what the row itself hides.

### 3. Every entity with a record page is a subject

2241 lists sixty-seven more tables in `private.field_history_subjects` and gives the thirty-two of them that had none an audit trail (`private.install_audit_trail`). They include `app.per_diems`, whose Crew page R1 added (the table dates from 0341 and already had a trail); the crew record takes a `historySubject` for such a ledger row, which has no comment thread. Left out: `app.time_entries`, which A130 partitions; `app.form_submissions`, whose answers may hold what a form asks about a person and stay out of the ledger; and `app.projects`, whose page is the project overview. `FIELD_HISTORY_SUBJECTS` in `@xos/data/field-history` mirrors the list, and its unit test reads the migrations so the two never drift.

### 4. The shared record sections carry the history

`RecordHistory` (`apps/atlas/components/history/record-history.tsx`) reads a row's history and renders the DiffViewer list, or nothing for a table that has no history. Each shared lower half of a record (the collection kit's `CollabPanels`, the finance, operations, advancing, logistics and asset collab sections, the Places and Safety `Collaboration`, the crew record's conversation, and the show, schedule and work order sections) renders it before the comments, so every peek and full page that has comments has a history. The engagement, application and posting records render it at their end. Pages with labels of their own keep them: the record page labels attributes by `work.extension.<column>` and words them by their field type; the SOP page passes `history={false}` to `CollabPanels`.

The list loads on demand (`lazy-field-history-list.tsx`, `next/dynamic`), so list pages that can open a peek do not carry its code.

### 5. One column dictionary

A record page without labels of its own names each field by its export header, `views.export.columns.<column>` (A102), which already held most columns. A131 adds the columns the subjects' histories can show that no export used, in en-US and es-US, and a unit test holds every such column labeled in both. Keys, references to other rows and people (`*_id`, `*_by`), display keys and hashes are left out, since their before and after would be ids. Values are worded by the column's shape: yes or no, a day or an instant, a number, an amount in its currency, and text shortened past 160 characters.

### 6. Amounts read in their currency

The export headers of money columns say "(minor units)", because an export carries the stored integer. A history shows an amount as a person reads it, so it labels each money column on its own (`collab.history.money.<column>`, "Amount" rather than "Amount (minor units)") and formats the value in the row's currency by that currency's exponent from `app.currencies`: 80000 in USD reads $800.00, 500 in JPY reads ¥500, 12345 in KWD reads KWD 12.345. `MONEY_SUBJECTS` in `@xos/data/field-history` lists the subjects with `<name>_minor` columns, all of which hold `currency_code`, and a unit test keeps it complete from the generated row types. Each event's amounts are in the currency the row held at that event: walking back from the row's currency now, an event that changed `currency_code` hands its before value to the events before it. An amount whose currency cannot be told reads as so many minor units ("80,000 minor units"), never as a guessed major amount.

Alternative: show the raw minor value under the export header. Rejected: it is accurate, but no one reads 80000 as eight hundred dollars at a glance.

## Consequences

- Thirty-two more tables write to the audit ledger on every change.
- A record's history shows two entries when a save changes both the record and its attributes, since they are two rows.
- A history that shows an amount reads the row's currency and the currency reference once, besides the history itself.
- `private.audit_keyed_row_change` does not resolve a partition to its parent as A130's `audit_row_change` does; no extension table is partitioned.
