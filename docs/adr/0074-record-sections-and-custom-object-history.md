# ADR 0074: Record Sections in Every Peek, and Custom Object Record History

- Status: Accepted
- Date: 2026-10-24
- Decider: A114 (RRR-159), trace rows S11.2-08 and S4.6.3-02
- Migration: 2100

## Context

Section 11.2 item 4 asks for one record anatomy in the side peek and the full page: title, kind and state, a property column, an activity and comment thread, and related records. The full page and the work peeks rendered `RecordBody` (record-detail.tsx), with comments and a dependency editor; the shell's peek (`?peek={recordKey}` on Home, Activity, Inbox and every other route that peeks no rows of its own) showed properties and recent state changes only. No surface showed a record's parent or sub-records (`parent_record_id`, 1180) or the custom object records linked to it (`custom_object_relations`, 0540).

Section 4.6.3 asks the same of custom object records: a side peek with comments, attachments and activity, and webhooks. Custom object records were a comment and attachment subject (0580), but the peek offered neither, and nothing recorded what happened to a record: no audit trail, no field history and no domain event.

## Decisions

### 1. One set of loaders for every record surface

`apps/atlas/components/work/record-sections.ts` reads a record's comments and files with their authors' names (`loadConversation`) and its related records (`loadRelations`). The full page and the work peeks (`loadRecordDetail`), the shell's peek (`loadShellPeekAction`) and the custom object peek call them, and render the same client panels: `CollabPanels` for comments and files, `RelatedRecords` for related records. Nothing is copied per surface.

- The shell's peek is a client component that loads its record through a server action, so an action's `revalidatePath` does not reach it. `CollabPanels` takes `onChange`, and the shell's peek reads the record again after a comment or file changes.
- The sections load on demand with the peek (`shell-peek-sections.tsx`), never with the page, as the peek did before (A24-009).
- Where the viewer may change dependencies, the dependency editor takes the place of the read-only dependency lists inside the related records section.

### 2. What related records are, and where they lead

Related records are the parent record, the sub-records, the dependencies both ways (waits on, holds up) and the custom object records whose relations point at the record. A record the viewer cannot read shows as "A record outside your view".

Each record links to its full page (`/{org}/r/{key}`), not to its peek. A full-page link works the same on every route, whether or not the page owns `?peek` (lib/shell/peek.ts): a peek link would be the collection's own key on one page and the shell's on the next. A custom object record has no full page, so it links to its collection's peek (`/{org}/objects/{objectKey}?peek={id}`).

### 3. A custom object record's values are its fields

A value lives in its own `custom_object_values` row, but it is a field of the record. 2100:

- installs the audit trail on `app.custom_object_records` (t85);
- writes each change of a record's values to that same trail, as `custom_object_records.update` with each field keyed `values.{field_key}` (a choice or person as its id, money as its minor units and currency). A statement trigger groups the change: one entry per write and record, so values set together are one entry. Values get no trail of their own;
- lists the table in `private.field_history_subjects`, so `app.field_history` (1452, unchanged) answers for it and the peek shows the history with each field named by its label.

Alternative: an audit trail on `custom_object_values`. Rejected, because `app.field_history` reads one row's trail, and a value row's trail is not the record's history.

### 4. Record events

`custom_object_record.created`, `.updated` and `.deleted` join the event catalog. Their payload names the object key (the record's API route `/api/v1/objects/{objectKey}`), the object type and the title; an update names what changed (`title`, or `values.{field_key}`). A value change emits one update per write and record, and a record in Trash emits none. Atlas and the API create a record and then its values in separate requests, so a new record with values emits created and then one update.

### 5. A peek with no full page offers none

Saved reports open in their peek only. The finance kit's table and peek take `fullPage={false}`: no Open full page in the row menu or the peek.

### 6. The peek guard reads hrefs

`test/peek-handoff.test.ts` reads hrefs written as template literals, strings and concatenations. An href that sets `?peek` on a path it does not spell out writes its own page's `?peek`; one on a path it spells out, a `const` included, links to that page, which must own its `?peek` or take record keys only. The guard also fails when a row component that takes `activatable` renders a table, list or board without passing it on.

## Consequences

- The shell's peek reads four things where it read two: the record, its state changes, its comments and files, its related records.
- Offers linked an application to Pipeline's `?peek`, where the shell opened it and found no record; it now uses Pipeline's `?id`.
- A custom object record's relations to other things (projects, parties, people) are not shown in its peek yet.
