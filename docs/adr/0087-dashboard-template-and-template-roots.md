# ADR 0087: The Dashboard Template, Saved Spans and Template Roots

- Status: Accepted
- Date: 2026-10-27
- Decider: A129 (RRR-174), trace row S11.6-01; Section 20.1 criterion 10
- Migrations: 2220_dashboard_layout_settings.sql

## Context

Section 11.6 gives Home, the report dashboards and the partner console one Dashboard template: a
header with the date range and scope picker and a 12-column tile grid whose tiles resize in grid
units. `TemplateDashboard` was a three-column grid nobody used; Home and the partner console drew
their own grids. Section 20.1 criterion 10 asks that every Atlas page use one of the eleven
templates, and nothing could check it: a template left no mark in the page.

## Decisions

### 1. Tiles, spans and resizing live in `packages/ui`; the copy comes from the app

`TemplateDashboard` takes `tiles` (id, label, default span, minimum span, content), the person's
saved `spans`, and an optional `resize`. Each tile spans whole columns from its minimum (3 by
default) to 12. With `resize`, a handle on the tile's inline end is a vertical separator whose value
is the span: the arrow keys change it by one column (mirrored in right-to-left), Home and End jump to
the limits, a drag snaps to whole grid units, a polite live region says the new span, and
`resize.onChange` receives every span once a key changes one or a drag ends. Below md the grid is
one column and the handles hide.

The handle's name and the announcement are functions in `resize`, not `ui` catalog keys. The en-US
`ui` catalog ships with every Atlas page, and the key pages have almost no JavaScript budget left;
the strings live in the app's `home` catalog instead, which never reaches the bundle.

Alternative: a drag-and-drop grid library with free placement (rows and columns). Rejected: Section
11.6 asks only for spans in grid units, and a library would add to every dashboard's bundle.

### 2. A person's spans are a personal setting, `tile:span` pairs

`me.dashboard_layout.home` and `me.dashboard_layout.partner` (registry file `a129.yaml`, migration 2220) are personal Text settings of at most 600 characters, set for every org, such as
`checklist:8,plan:4`. Atlas reads them with the page's other settings; a pair whose tile id or span
does not fit is skipped, so a stale value never breaks Home, and a tile the person does not see keeps
no span. The save action accepts only the dashboard's own tile ids and spans of 1 to 12.

The registry gains the text input `layout`: arranged in place, so the Personal settings page shows
the setting's label, whether the person arranged it, and Reset, never a field. Gateway and Compass
offer no `layout` setting. Home shows Reset layout once a span differs from the default.

Alternatives: JSON in the value (rejected: longer, and a field nobody should edit by hand either
way); a table of its own like the sidebar layout (rejected: the settings registry already gives a
personal value with audit, reset and the database guard).

The report dashboards keep their saved grid positions (A43), which are shared per user or team and
place tiles by row and column; they are a different, richer layout and stay as they are.

### 3. Every template root names itself, and a spec checks one per page

Each `Template*` root renders `data-template="<name>"` (collection, record, split-view, dashboard,
settings, wizard, grid-editor, document, auth, gateway-shell, system). `e2e/a11y/templates.a11y.ts`
visits every route the accessibility sweep visits, for each demo role, and expects exactly one
outermost template root in the page's main region; a template inside another (a Collection inside
the Settings template's form column) belongs to it. Pages found without one (the generated index and
empty-state pages, Home's views, Activity, the audit log, gates, a saved project view, marketplace
settings and the load error) now stand on the Collection template, and the partner console sections
on Collection with the overview on Dashboard.

Alternative: a static scan of page imports. Rejected as the check: a page can import a template and
still render none in a branch; the scan only helped find the pages to fix.
