# ADR 0085: Archive and Unarchive

- Status: Accepted
- Date: 2026-10-27
- Decider: A124 (RRR-169), trace row S4.10-02
- Migrations: 2180, 2181, 2182

## Context

Section 4.10 asks that records and the other collection entities can be archived: put out of the way
without being deleted, and brought back. Projects, notifications, groups and help desk teams already
kept `archived_at`. Records, custom object records, vendors, documents and work orders had only Trash
(`deleted_at`), and Places showed a venue in Trash as "Archived" with a Restore button, so one column
meant two things there. The frozen API v1 had a `records.archive` action that ADR 0023 removed because
no column backed it.

## Decisions

### 1. Archive is its own column, apart from Trash

`archived_at` and `archived_by` on `app.records`, `app.custom_object_records`, `app.vendors`,
`app.venues`, `app.documents` and `app.work_orders`. An archived row keeps its row level security: it
stays readable, opens from a link and can still be edited. Only lists and search leave it out by
default. Trash keeps `deleted_at` and its own Restore. A punch item is a Task record (0410), so it is
archived through that record; `app.archive_row('punch_items', id)` accepts the punch item id for
callers that hold it, and a person with `work.punch_list.write` on the project may archive it; the
punch item's record page and peek show Archive to that person too.

Alternative: archive as a record state. Rejected: the nine record states are canon, and archive
applies to tables with other lifecycles or none.

### 2. One pair of RPCs, and nothing else changes the columns

`app.archive_row(entity, id)` and `app.unarchive_row(entity, id)` check the capability the table's
update policy checks, refuse a row the caller cannot see (`archive_row_not_found`), answer 42501
without the capability, leave a row already in that state unchanged, and write one
`<table>.archived` or `<table>.unarchived` event to the audit ledger with the before and after
values. `private.guard_archive_columns` refuses any other insert or update of the two columns
(`archive_rpc_only`), so every archive is checked and audited the same way. No domain event or
notification kind is added; the row's audit trail and the new ledger event are the history.

### 3. Venues move from deleted_at to archived_at

The venues Places showed as archived (`deleted_at` set) become archived rows, so they stay under
Archived and can still be restored; `deleted_at` now means deleted for venues too. `venue.archived`
and `venue.restored` (0420) follow `archived_at`, and the triggers move before the rows so the move
emits nothing. A venue's name is unique among live, unarchived venues, so an archived venue's name
can be reused; unarchiving it while a live venue holds the name is refused as `archive_name_taken`.
Spaces, zones, capability documents, site plans and pins keep archiving through `deleted_at`.
Every reader that offered venues by filtering `deleted_at` alone now also leaves archived venues out:
the Event record venue picker, the asset venue picker, a partner's view of a client's venues, the
import worker's venue lookup by id or name, and import duplicate review (`private.fuzzy_candidates`,
restated in 2182). Without that, a live and an archived venue sharing a name could bind an import row
to the archived one.

### 4. Lists and search leave archived rows out unless asked

The query parameter is `archived=include` (every row) or `archived=only` (the archived ones); any
other value is the default. `packages/data/src/archive.ts` applies it in the list loaders, the
`ArchivedFilter` select sets it, and exports keep the same default through a presence filter (2380).
Global search and recent items (2181, restating 1440) leave archived records and documents out;
`is:archived` (es: `archivado`) searches only them, so an archived row can be found and unarchived;
a document hit under `is:archived` opens with `archived=only` so its peek can show it.

The default applies to lists only. A lookup of known rows passes `archived: "include"`: a record's
parent and sub-records, the records at the other end of its dependencies, a baseline's items and the
records of recurrence rules, and the vendor names an RFQ's invitations show. Those rows are related to
something the person is looking at, and leaving them out would show a readable record as one outside
their view. Pickers that offer rows for a new link (the dependency picker, the RFQ invite picker) still
leave archived rows out.

### 5. The API list operations gain an optional parameter

The list operations of records, work orders, documents, venues, vendors and custom object records
take `archived`. A module adds a list parameter through `listQuery` in its additions;
`applyAdditions` accepts only optional parameters on the module's own list operations, and the
gate 20 test (`test/additions.test.ts`) accepts a frozen list operation that differs only by optional
query parameters appended after its frozen ones. oasdiff reports six `new-optional-request-parameter`
changes and nothing breaking. A request without the parameter lists live rows, as before (the only
archived rows that existed were the venues moved by decision 3, which the list already left out).
No archive action is added to the API in this change.

## Consequences

- An archived row is still counted by anything that reads the table directly (reports, plan limits,
  RLS-scoped views); only the loaders, the API lists, search and exports filter it.
- The punch list export reads `app.punch_items`, which has no `archived_at`, so it still lists the
  punch items whose records are archived.
- The `record-archive-removed` correction (ADR 0023) stays: v1 still has no `records.archive`.
