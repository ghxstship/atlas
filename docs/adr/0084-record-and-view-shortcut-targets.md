# ADR 0084: Record and View Shortcuts on Marked Controls, Help Lists from the Registry

- Status: Accepted
- Date: 2026-10-27
- Decider: A125 (RRR-170), trace rows S11.2-02 and S3.15-08
- Migrations: none

## Context

Section 11.2 asks for a shortcut for every action. A81 (RRR-126) made
`packages/schemas/shortcuts.yaml` the single source and answered global keys, G then a letter and
the Inbox's own keys, but a record's actions (change state, assign, comment, edit the title, open the
full page, copy the link, move to Trash) and a view's (switch, filters, save, export) had none. Those
controls live in dozens of module components, some in `packages/ui` and some built by other packages
in parallel (A102's Export, A117's filter builder). The help articles named keys by hand, so a
changed default left them wrong (finding A65-007).

## Decisions

### 1. A shortcut finds its control by attribute, in the region around focus

A region answers for a scope. The record full page (`TemplateRecord`) and every collection
(`TemplateCollection`) are regions by the template root they already carry (`data-template="record"`
for `record`, `data-template="collection"` for `view`), so the templates and the pages that load them
gain no bytes. Any other region carries `data-shortcut-scope`: the side peeks mark themselves
`record`. `SidePeek` and `Drawer` (with `shortcutScope="record"`) set it on their portaled content, so
the collection kit's `PeekDrawer` (39 modules), the objects, project, advancing, running order, day
sheet and call sheet peeks are regions, and the finance, crew and operations peeks, which render
their own panels, carry it themselves. The control that does an action carries
`data-shortcut="<registry id>"`, on itself or on a wrapper. The Atlas key handler, which loads on
demand, looks the key up in the focused region's scope and asks `@xos/ui/shortcut-targets` for the
control: it clicks a button, opens a menu trigger with the arrow key, focuses a field (selecting a
title's text, opening a select's picker where the browser allows), focuses the selected option of a
radio group or tab list (the view switcher), or focuses the first control of a wrapper marked
`data-shortcut-focus` (a row of state moves). A region without the control leaves the key alone, with
one exception: Copy link on a record that shows no Copy link control (a full page) copies the address
on screen, which is the record's. Open full page does nothing on the full page itself. A side peek is
a dialog, so the shell's single keys stay quiet in it, but the peek's own record keys answer; a menu
open inside it silences both.

A feature binds its control to a shortcut by carrying the attribute; nothing in the handler changes.
The marked controls are shared ones, so each covers many record pages: the collection kit's state
moves (`TransitionButtons`), finance's (`TransitionBar`), logistics' move form and record delete,
the permit, asset unit, engagement and project state moves, Work's state, owner, title and Trash
controls, both shared comment composers, the side peek's Open full, Copy link and clickable state, the
other peeks' Open full (and the crew peek's Copy link), the objects peek's board column and the day
and call sheet peeks' Move to Trash. A record page whose module has no such control (most have no inline title, owner or Trash
control) leaves that key alone. Open the filters presses the filter builder's Add filter (A117), which
loads with the filter bar, not with the page; Export is A102's control. Save view's only control sits
in the saved-views menu, so the view switcher keeps a `hidden` button with the attribute as its target.
Alternative: each component registers a handler with the shell. Rejected: every module would import
shell code, and controls in `packages/ui` cannot reach Atlas's shell.

### 2. Gateway's letter keys come from the server

Gateway has no rebinding and ships no registry. Its layout builds the person's G sequences (only for
destinations their navigation offers) and the account and Switch org keys from the registry, and the
frame's letter handler (`components/shell/letter-keys.ts`, tested on its own) answers them. The help
panel lists the same ids. Gateway's keys are the registry defaults, and G waits for its second key
without the hint Atlas shows; both follow if Gateway gains rebinding.

### 3. Help articles hold generated lists

An article holds `<!-- shortcuts <shell> <group> -->` and `<!-- /shortcuts -->`; each shell's help
generator (`help.test.ts` with `XOS_WRITE_GENERATED=1`) fills the lines between them from the
registry and the locale's catalog (`packages/schemas/src/shortcuts/docs.ts`, `fillPartials` in
`@xos/help/node`), and every other run fails while a list differs. The in-app parser and the docs
site's parser skip the marker lines. Alternative: a directive expanded at render time. Rejected: the
docs site reads the Markdown files itself, and generated lists keep the files readable as written.

## Consequences

- Record and view keys hold their letters against global shortcuts (a person cannot bind S globally),
  as list keys already do. A list can sit in any region and takes its keys first, so no scope may bind
  J, K, X or the other list keys. Two other region scopes never meet, so a record and a view may reuse
  a letter.
- A person's stored binding that the registry now refuses (its keys now belong to a new shortcut) is
  dropped, and Personal settings, Keyboard Shortcuts names those shortcuts above the list.
- A shortcut that changes a default key regenerates the articles in the same change; a package that
  adds a shortcut after another merged must rerun both help generators.
