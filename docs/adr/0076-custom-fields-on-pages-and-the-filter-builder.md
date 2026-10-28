# ADR 0076: Custom Fields on Pages, and the Add Filter Control

- Status: Accepted
- Date: 2026-10-24
- Decider: A117 (RRR-162), trace rows S4.5.6-16 and S11.4-02 (the FilterBuilder part)
- Migrations: 2110

## Context

Orgs could define custom fields on nine built-in tables in Settings (A86, `app.custom_field_definitions`, 0540), and the API read and wrote their values, but no Atlas page showed or saved a value. `packages/ui` held a FilterBuilder that no page rendered, and collection filters were each page's own parameters, saved by views as `field eq value` only. `required` on a definition was enforced nowhere.

## Decisions

### 1. One data module, the typed columns, the existing write path

- `@xos/data/custom-fields` reads a table's definitions, reads values for many rows (in chunks of 150 ids, so no request outgrows a URL), and writes one row's values: insert a new one, update a changed one in place with only its type's column filled, soft delete a cleared one. These are table writes under the same policies as the API's customFieldValues operations; there is no new RPC.
- A form sends each value as the text its input holds (`CustomFieldInput`). `checkCustomFieldInputs` turns text into typed values and names missing or malformed fields. The browser and the server run the same function before anything is written.
- Money takes the currency's minor units from `private.currencies`. A Timestamp is typed and shown in the org's time zone (`locale.time_zone`).

### 2. Required is a form rule that the write path also holds

- The definition's own comment says required means "forms require a value". A create form that shows custom fields refuses to create the row while a required field is blank, in the browser and again in the server action before the row exists. A create path that shows no custom fields, such as a quick-add row or an import, is not held to it. Those paths never offered the field.
- 2110 adds the write-path check to `private.guard_custom_field_value`: a value row of a required field cannot have an empty typed column, and it cannot be soft deleted (`custom_value_required`). This holds for anything that writes values directly, the API included. A field made required later does not change rows that have no value yet. The next write to them has to give one.
- Alternative: a deferred constraint trigger on each target table that demands every required value at commit. Rejected. A row and its values are written in separate requests, and the API creates rows with no custom fields at all.

### 3. A create action checks first and saves after

- A create form's inputs are named `cf.<key>` (and `cf.<key>.currency`). The action calls `customFieldsOf(ctx, table, form)`, which checks the inputs (a dry run) and refuses with field errors before the row is created. After the create it saves them on the new row. Records, whose create action takes typed input, pass the same inputs as `customFields`.
- Every create action that takes FormData is posted only by a form that shows the custom fields, so `customFieldsOf` holds every FormData post to required fields, whatever it carries. There is no marker for the browser to leave out, and a post without the inputs is refused like a blank field. A venue edit passes no inputs, since an edit saves custom fields from the record's own section. A typed action passes `undefined` when its caller shows no custom fields.
- The browser runs the same checks on submit and names each field with a problem. A submit made before the form's custom fields have loaded goes to the action, which checks the inputs on its own.
- The checks passed before the row existed, so a later save can fail only on something unexpected. That failure is logged and the create stands: the form opens the new row, whose custom fields section shows the field unset. Answering with an error would invite a second submit and a duplicate row.

### 4. Record pages and peeks show and edit the values in their own section

- `CustomFieldsPanel` (server) and `CustomFieldsSection` (client, for peeks drawn in the browser) show a row's fields with their values. For a Collaborator or higher (the band `private.custom_writer_orgs` allows), Edit turns them into inputs with Save, which checks and writes through `saveCustomFieldsAction`. The action refuses a member below that band itself (`denied`): row level security would drop their writes without an error, and the action would answer success for nothing written.
- That section is the edit form for custom fields on every target. Pages that also have an edit form for their built-in fields (venues, vendor terms, project settings, invoices) keep that form as it was. The section sits beside it, so each surface gains one line.
- A vendor is the vendor facet of a counterparty. Counterparties have no Atlas collection of their own, so their fields show as Company fields on the vendor's page and peek.

### 5. Filter conditions are query parameters in two namespaces

- The Add filter control (`components/views/filter-bar.tsx`, in the view switcher every collection renders) writes conditions into the query string. `cf.<key>` is an org custom field. `f.<key>` is a field the page declares, which only pages built on the shared collection kit (`components/collection-kit/collection-view.tsx`) offer: their columns. Neither namespace collides with a page's own filter parameters.
- An operator other than eq follows the field after a dot: `cf.seats.gte=100`. Operators are the API's (`app.filter_operator`). A saved view therefore stores field `cf.seats`, operator `gte`, value `100`, and reopening it writes the same parameter back. "Is empty" and "has a value" are `is_null` with `true` and `false`. A filter the control did not write, such as an `in` saved through the API, reopens as eq, as before.
- Each page's loader applies custom field conditions on `custom_field_values` through the field's typed column (the field's partial index, 0540). It reads matching ids a page of 1,000 at a time, so no condition is cut short by `max_rows`. "Is not" and "is empty" drop the matches of the opposite test, so rows with no value pass them. A condition on an unknown or unfilterable field is ignored. A value that cannot match, such as an unknown choice, leaves no row.
- Declared-field conditions match on the text the page shows, in the browser. The collection kit applies them to its rows. The pages with their own collection components (records, projects, assets, the finance, places and operations kits, logistics, crew, show, punch, schedule baselines, scope, gates, advancing, recurring and work orders, home, my work and activity) offer custom fields only: their own filter controls already cover their built-in fields, and declaring fields there means applying `f.` conditions in each component's own rows, in files A119, A120 and A121 own. On such a page in an org with no filterable custom field for its table, the control does not appear.
- Money filters compare an amount in major units of each value's own currency, scaled by that currency's exponent from `private.currencies` (100 is 100 yen, 100.00 dollars, 100.000 dinars). One `or` filter groups the currencies by exponent. Amounts in different currencies are not converted, so 100 matches 100 yen and 100 dollars alike. A Timestamp filter names a day on the org's calendar.

### 6. Filterable fields are table columns

- A loader hands the collection its filterable fields and their values on the rows shown (`customFieldList(...).view(ids)`). The server formats each value as display text in the viewer's locale, so a table carries no formatting code. Tables append them as columns through `useCustomFieldColumns`, or `customFieldColumns` in a server-rendered table (incidents). A page wraps its collection in `CustomFieldList`, or passes the view to a collection component that takes it.
- The Add filter control appears only when a page declares fields or its table has filterable custom fields. An org without custom fields sees the pages it saw before.

### 7. What custom fields add loads on demand

- List pages sit close to the 200 KB route budget (`/projects` was 32 bytes under), so nothing custom fields add rides on a list's first load when it can wait. The Add filter control loads on a page that has something to filter by (`next/dynamic`), and its condition editor when first opened. The custom fields section of a peek loads with the peek. New project's custom field inputs load with the drawer's fields.
- To make room without raising a budget, the saved view switcher's writes (save, update, share, set default, delete) load with its dialogs, and the Projects peek's custom fields load with the peek and the other views (`project-other-views.tsx`). The round trip of a saved view, which every collection loads, reads only the operator spelling in `lib/views/query.ts`; the rest of the condition grammar (`conditions.ts`) loads with the filter control and the loaders.

## Consequences

- Saved views keep operators. `ViewDraft` accepts every operator the control writes, and older views reopen unchanged.
- A list that a condition empties shows its no-matches state, not its empty state with Create, and where that state or the filter bar has Clear, Clear removes the conditions too (`isConditionParam`): the collection kit, projects, records, assets and the finance kit, including invoices.
- An import or the API can still create a row without its required custom fields. Only forms that show the fields require them, and the database refuses emptying a required value afterwards.
- An export of a list (ADR 0060) applies the page's own filters, but the export worker cannot apply `cf.` and `f.` conditions. So while a list carries one, the export menu's formats are off and the menu says to remove the conditions, and `requestCollectionExportAction` refuses such an export (`conditions`) before it reads anything. An export never holds rows the list hides. Exporting with conditions needs `app.request_export` and `app.export_job_rows` to take a custom field condition, a follow-up.
