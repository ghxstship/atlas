# ADR 0140: Site Plan States, Drawings, Annotations and the Signage Register

- Status: Accepted (the owner approved the competitor parity audit and its deferred themes on 2026-10-28, and the
  fast-forward on 2026-10-30; owner steps below confirm D2, D3 and D7 before release)
- Date: 2026-10-30
- Decider: Owner decisions of 2026-10-28 (parity audit, deferred theme B1); RRR-225
- Migrations: 2900 to 2905 (2906 to 2909 stay free)

## Context

The parity audit of 2026-10-28 found seven site plan and venue gaps (G-02, G-06, G-15, G-18, G-19, G-24, G-92). On
4.0, a site plan (`app.site_plans`, 0350) is a project's drawing with pins at fractions of its width and height. The
drawing is a web address the browser loads, or a stored path that shows a grid. A plan has no state, a venue has no
levels, nothing can be drawn or measured on a plan, a pin takes no comments, a plan cannot be exported, there is no
signage register, and a venue's power, dock and rigging facts exist only inside capability document files.

B1 deepens the plan without reopening S5-29: every feature works on the uploaded image or PDF drawing in plan space.
Geo-referenced maps, basemaps and drone imagery stay post-launch.

## Decisions

### D1. The plan state is a stored workflow column

`app.site_plans.plan_state` is `app.site_plan_state`: Draft, Locked, Live or Archived. Lifecycle `site_plan` allows
Draft to Locked, Locked to Draft, Locked to Live, Live to Locked, Draft, Locked or Live to Archived, and Archived to
Draft. It changes only through `app.transition_site_plan`, on the lifecycle engine (0300) with the ledger
`app.site_plan_state_transitions`, as work orders do (0411).

- Only a Draft plan takes layout writes: its pins and shapes (archiving included), its drawing, scale, venue and
  level (`site_plan_locked`). Titles change in Draft, Locked and Live; an Archived plan refuses a title change
  (`site_plan_archived`). Comments are allowed in every state, because a comment writes no pin.
- Live means "the plan crews work from". A project holds at most one Live plan per venue and level
  (`site_plans_one_live`, a unique partial index on project, venue and level with `nulls not distinct`). A project can
  hold plans of several venues, so the venue is part of the key. `app.transition_site_plan` checks first and refuses
  with `site_plan_live_exists`, so a person never sees a raw unique violation; a restore from Trash that would make a
  second Live plan is refused by the index itself.
- A plan with no drawing yet (`image_uri = 'attachments/pending'`) is never Locked or Live (`site_plan_no_drawing`).
- Deleting is still `deleted_at` and Trash. Anything derived (unplaced signs, open notes) is a view or a query.
- Access stays on the project policy and `places.site_plan.write`. Event Lab's access by department or named user is
  not built.
- v1 is frozen and has no plan state, so a v1 client could not tell a retired plan from a live one. The v1
  `sitePlans.list` handler leaves out Archived plans (`packages/api/src/handlers/places.ts`, a list-only scope); get,
  update and delete still answer for them. The OpenAPI document is unchanged.

### D2. Plans deleted before 2900 stay in Trash

On 4.0, a plan's `deleted_at` was set by the Atlas "Archive" button, by v1 `DELETE /site-plans/{id}` and by Trash.
The three cannot be told apart, and site plans were already Trash rows (title column, 7-year Soft Deleted retention
from 0501). Moving them to Archived with `deleted_at` null would bring back plans people deleted through the API or
Trash, in front of every project reader. So 2900 moves nothing:

- every plan takes Draft from the column default; a plan in Trash stays in Trash and restores as a Draft;
- every plan that exists at 2900 gets one ledger row (from null to Draft, reason "State added (2900).") so every
  plan's ledger has a start; plans created later get theirs from the creation trigger.

Before B1, "archived" meant deleted, and those plans are found in Trash.

### D3. Drawings are attachment versions, never fetched by URL

A stored drawing is a version in the attachments bucket (0590) with the plan as its subject: scanned, served by
`/files/{version}` (A142) and immutable. New columns on `app.site_plans`: `drawing_version_id` (a PNG, JPEG or PDF
version), `raster_version_id` (for a PDF, a PNG of the chosen page), `drawing_page`, `image_width_px` and
`image_height_px`.

- The PNG of a PDF page is rendered in the uploader's browser from the local file with A142's pdf.js, at most 4096 px
  on the long side, and uploaded as its own attachment on the plan, never as a new version of the PDF's attachment:
  0590's newest-Clean-version rule would make the PNG replace the PDF. The guard checks the two are different
  attachments. The raster is what the uploader's browser rendered; it is not verified against the PDF.
- `private.guard_site_plan_layout` checks a drawing or raster only when it is set or changed: on the plan, Clean, of
  the right type, and Public or Internal (`site_plan_drawing_subject`, `site_plan_drawing_scan`,
  `site_plan_drawing_type`, `site_plan_raster_required`, `site_plan_drawing_page`,
  `site_plan_drawing_classification`). A Confidential drawing stays an ordinary attachment: the canvas overlay and the
  export cannot carry the Section 8.6 watermark without misaligning.
- Raising a file's classification later is allowed, as 1380 lets any reader raise one to protect it (Section 8.6).
  Readers handle it: the canvas, the site plan loader and the build sheet treat a drawing or raster above Internal, or
  one whose version or attachment is deleted, as no stored drawing, and show and export the ruled frame with a
  sentence saying the drawing is classified or removed. `DOCUMENT_CLASSIFICATION` stays Internal because the loader
  never embeds a file above Internal.
- `image_uri` never drifts: whenever a drawing is set, on every insert and update, the guard overwrites it with
  `'attachments/' || object_name` and ignores what the caller sent, a v1 PATCH included. A plan created from the
  upload form starts with `image_uri = 'attachments/pending'`, which keeps the frozen contract's non-null column.
- The pixel size is measured by Atlas from the shown image's header bytes when the drawing is set
  (`packages/data/src/image-size.ts`: PNG IHDR, JPEG SOF). The database cannot read bytes and anyone with
  `places.site_plan.write` can write the columns, so they are registered as stored facts, and the guard refuses a size
  change without a drawing change (`site_plan_dimensions_fixed`). The canvas compares the stored size with the image
  it loads; on a mismatch it warns and disables Measure and Set scale.
- A JPEG whose EXIF orientation is not 1 is refused when it is set, with a field error asking for an upright export: a
  browser turns such an image and a PDF does not, so the overlay would be misplaced in one of them. Tested with a
  fixture in `packages/data/test/image-size.test.ts`.
- The scale is cleared whenever the drawing changes, not only when the size changes: a new drawing of the same size
  is not the same scale.
- Every canvas open loads the drawing through `/files/{version}`, so it writes an `app.file_access_log` row as a
  download (ADR 0116 decision 1). This is accepted: it is the one delivery path for files, and no bypass of `/files`
  is added.
- Legacy plans (a web image, or a stored path from before B1) keep today's 16:10 frame and pins. Their pins were placed
  as fractions of that frame, not of the image, so their export draws the pins in a 16:10 ruled frame, and the upload
  panel warns that existing pins may need moving once a drawing is set. The server never fetches a web URL.

### D4. Geometry lives in plan space

Shapes (`app.site_plan_shapes`: Route, Barrier, Area, Label) are PostGIS geometry with SRID 0 in fractions of the
drawing, the pins' convention. A label is required for every kind (1 to 200 characters): Trash lists shapes by it
and the legend names them by it; the UI defaults it to the kind's name. Lengths and areas are computed in the
drawing's pixel space and scaled by one calibration, two points and a distance in feet (the schema's unit, as
`spaces.area_sq_ft`; metric viewers convert at 0.3048), in `app.site_plan_shape_geometry`, never stored. The same
formulas are pure functions in `packages/data/src/places-geometry.ts`, which the measure tool uses live, and a test
holds them to the view's numbers. There is no WGS 84 and no basemap; S5-29 stays deferred.

### D5. Annotations reuse the one comment system

Pins and shapes are comment subjects. `private.subject_row`, redefined from its only definition (0580), gives them
the plan's project and a title (their label, else the plan's title), so mentions and notifications reach only people
who can open the project (`private.person_may_read_subject`: a project member, or an overseer of every project). A
note at a coordinate is an anchored thread on the plan. Its anchor has exactly one form,
`point:<x>,<y>` with four decimals (`site_plan_anchor`), so two clients never open two threads at one point. Since
`app.post_comment` reuses the one thread at an anchor even when it is resolved, a reply to a resolved point note
reopens it (`private.reopen_site_plan_point_thread`). Any other anchor on a plan, including one a v1 client would
send, is refused.

### D6. A sign's production state is computed

`app.signs` is its own table rather than a Supply record of subtype "Signage & Wayfinding" (0150): a sign has a place
(a pin of a plan of its project, or words), its artwork, its own production steps and a line on the build sheet, none
of which a Supply record carries. It keys to canon through an optional `urid` limited to 4000.05.01 Signage Panels,
4000.05.02 Directional Signage and 9000.09.01 Digital Signage; the UI defaults it from the type. It has no link to a
Supply record: nothing yet reads a sign through one, and a record can be linked later without a change here.

A sign stores only what signage owns (ADRs 0103 and 0104): `ordered_at` (only without a purchase order line),
`printed_at`, and `placed_at` with `placed_by`, stamped by `app.mark_sign_step`. `app.sign_production` computes the
furthest step reached:

- Placed: marked placed.
- Printed: marked printed, or the linked line received net of returns, read exactly as R7a's `app.po_line_supply`
  reads it (live receipt lines on live goods receipts, less return lines on live goods returns).
- Ordered: marked ordered, or the linked order Approved, Sent or Closed. ADR 0104 names Approved or Sent; Closed is
  added because a closed order was sent.
- To Order: otherwise.

`app.po_line_supply` runs as its reader, so `app.sign_production` is a definer view with its own row filter on
`places.venue.read`, like `app.expense_budget_lines` (1622) and `app.asset_unit_hire` (R7a). It shows no order
number, vendor, quantity or price. With a line linked, the printer is the order's vendor, shown to procurement
readers from the order, so a sign names its own printer only without a line (`check (po_line_id is null or
printer_vendor_id is null)`). The order line is checked only when it is linked or changed, so a sign whose order is
later canceled stays editable and restorable from Trash; linking one over a manual order mark is refused
(`sign_ordered_manually`). Located means a live pin on a live plan, or words; overdue uses the project venue's local
date, UTC without a venue.

### D7. No new capabilities

Signage reads with `places.venue.read` and writes with `places.site_plan.write` on the project. Levels write with
`places.space.write`; venue specs with `places.venue.write` and space specs with `places.space.write`. Linking a
purchase order line also needs `procurement.po.read` on the project (`sign_po_line_read`), so a sign writer cannot
probe order lines. The Field and Collaborator roles hold `places.site_plan.write` at assigned reach (0203), so field
crews create and edit signs and mark their steps on their own projects; this is intended. `capabilities.yaml` and
0203 are unchanged.

### D8. Venue and space specs are typed columns in one table

`app.place_specs` holds one live row per venue (space_id null) and per space: house power, dock and access,
dimensions, rigging and network. `venue_id` is set on every row, derived from the space for a space row and refused
if sent otherwise; a space has no occupant load (it keeps `app.spaces.capacity`). A NULL is unknown and never passes
(Section 3.7). Network passwords are never stored: the network help points to a Restricted capability document.
Org-specific extras are A117 custom fields; `app.spaces` and `app.signs` become targets. Specs have no title column,
so they stay out of Trash.

### D9. Specs feed advancing and the permit page without changing either engine

`app.provide_place_specs` copies the known power (5000.06.01), rigging (5000.05.02) and connectivity (9000.02.01)
facts of the project venue's spec and its live spaces' specs into Provide capability statements, one per spec and
group, each a copy taken when it runs (description and assertion word), never automatically. They are DOCUMENTED
when a live, unexpired capability document of the venue backs the spec, CLAIMED otherwise. Reconciliation is by URID
only, and a 5000.05.02 requirement usually counts hardware the production brings, so a venue's hang-point count would
give false Met or Gap results: every spec-fed statement has no quantity, and the counts and loads are in the
description. A requirement without a quantity reconciles Met against one; a requirement with a quantity reconciles
Unknown, which never passes. A documented spec is evidence a person cites; no gate evaluator reads it.

The descriptions use only numbers, unit symbols (A, V, Φ, ×, lb, Mbps) and the person's own text, so they read the
same in every language; the UI shows the translated category beside them. Managed rows change only inside the
function (`place_spec_capability_managed`); a person may move one to Trash. The reconciliation surfaces show a
computed "Venue specs changed" tag when the spec changed after the row was written and "Document expired" when a
DOCUMENTED row's document has lapsed; neither is stored.

The Permits page shows a read-only "Venue facts" line on requirements whose canon rule maps to a fact group
(`private.permit_rule_place_facts`, read through `app.permit_rule_place_facts`), from `app.project_place_facts`. The
spaces' capacity total is shown only when every live space has one, with "n of m spaces recorded", so a partial sum
never understates occupancy. `generate_permit_requirements` and `permit_rule_applies` are not touched, so no fact
ever drops a rule.

### D10. Two new document kinds and one new page

Document kinds `site-plan` and `signage-build-sheet` join the pipeline (ADR 0031 amendment B1). Both are computed
live, so their issue time is the generation time; version 1 takes effect at V1. Places > Signage is a new Atlas page
(`places.signage`) with list, table and board views.

## Consequences

- A plan's layout is fixed while crews work from it, and the one Live plan per venue and level is the one they open.
- Drawings follow the same scanning, classification, delivery and logging as every file; a classified drawing is
  never drawn over or printed.
- Lengths and areas are always computed from the drawing and its calibration, and the database, the data layer and
  the canvas agree.
- Sign states can never disagree with procurement, because procurement's facts are read, not copied.
- Venue facts reach advancing only when a person adds them and say so; the permit engine is unchanged.
- Out of scope, as the theme records: geo-referenced maps and basemaps (S5-29), object libraries, zone polygons with
  tasks, fencing panel counts, personnel markers, editor ergonomics, saved map views, the mobile live map, scouting
  markers, the equipment manager, sign direction and Compass install with photo sign-off (G-25), power and network
  planning (G-87, G-88), department or named-user plan access, Compass and Gateway plan views, and Confidential
  drawings on the canvas.
