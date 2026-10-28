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

The record full page (`TemplateRecord`), the side peek (`SidePeek`) and every collection
(`TemplateCollection`) mark their region with `data-shortcut-scope` (`record` or `view`). The control
that does an action carries `data-shortcut="<registry id>"`, on itself or on a wrapper. The Atlas key
handler looks the key up in the focused region's scope and asks `@xos/ui/shortcut-targets` for the
control: it clicks a button, focuses a field (selecting a title's text, opening a select's picker
where the browser allows) or focuses the first control of a wrapper marked `data-shortcut-focus`. A
region without the control leaves the key alone. A side peek is a dialog, so the shell's single keys
stay quiet in it, but the peek's own record keys answer; a menu open inside it silences both.

A feature binds its control to a shortcut by carrying the attribute; nothing in the handler changes.
An action whose only control sits in a menu (Save view) keeps a `hidden` button with the attribute as
its target. Alternative: each component registers a handler with the shell. Rejected: every module
would import shell code, and controls in `packages/ui` cannot reach Atlas's shell.

### 2. Gateway's letter keys come from the server

Gateway has no rebinding and ships no registry. Its layout builds the person's G sequences (only for
destinations their navigation offers) and the account and Switch org keys from the registry, and the
frame answers them. The help panel lists the same ids.

### 3. Help articles hold generated lists

An article holds `<!-- shortcuts <shell> <group> -->` and `<!-- /shortcuts -->`; each shell's help
generator (`help.test.ts` with `XOS_WRITE_GENERATED=1`) fills the lines between them from the
registry and the locale's catalog (`packages/schemas/src/shortcuts/docs.ts`, `fillPartials` in
`@xos/help/node`), and every other run fails while a list differs. The in-app parser and the docs
site's parser skip the marker lines. Alternative: a directive expanded at render time. Rejected: the
docs site reads the Markdown files itself, and generated lists keep the files readable as written.

## Consequences

- Record and view keys hold their letters against global shortcuts (a person cannot bind S globally),
  as list keys already do; two region scopes never meet, so a record and a view may reuse a letter.
- A shortcut that changes a default key regenerates the articles in the same change; a package that
  adds a shortcut after another merged must rerun both help generators.
