---
title: Search
summary: Find any record, person, document, setting or page from the command menu, and narrow a search with operators.
kind: guide
nodes: ["*"]
order: 6
---

Press **Mod+K** or **/** anywhere in Atlas to open the command menu. Before you type, it lists what you opened last (up to 50 records, incidents, documents, SOPs and handbook articles), the common actions and the search operators. Everything works from the keyboard: the arrow keys move, **Enter** opens, **Esc** closes.

## What search finds

- Records and incidents, by title or by key (type `NWS-12`).
- People in your organization, by name.
- Documents, SOPs and handbook articles, by title and text.
- Asset classes by name, and units by asset tag, class or serial (type `MH-002`). They show under **Inventory**.
- Settings, by name or key: type `time zone` to reach the Localization page with the field ready to change.
- Pages, help articles and actions such as **New record** or **Approve timesheets**.

You only ever see what you are allowed to open. Each word you type also matches the start of longer words, so `instal` finds "Install the stage deck".

## Operators

Add operators to narrow a search. They show as chips under the search field; one the menu does not understand is marked so you can fix it.

- `type:` a record kind (`type:task`), or `person`, `incident`, `document`, `sop`, `article`, `asset` or `"asset class"`.
- `project:` a project key or the start of its name (`project:NWS`).
- `assignee:me`, or part of someone's name (`assignee:ana`).
- `status:` a state (`status:blocked`), or `open` or `closed`.
- `phase:`, `urid:` and `dept:` narrow records by phase, URID or department.
- `is:blocked`, `is:open`, `is:overdue` and `is:mine`.
- `before:` and `after:` the day something last changed: a date (`2026-10-01`), `today`, `yesterday` or a count of days (`after:7d` is the last week).
- `due:` `today`, `overdue`, `<7d` (due within a week) or a date.

Put words in quotes to find them together (`"load in"`), and put a minus before a word, a phrase or an operator to leave it out (`-strike`, `-status:complete`). Dates follow your organization's time zone.

## Search by meaning

When an Admin turns on **Semantic search** in Settings, AI features, search also finds documents, SOPs and handbook articles that mean what you typed even when they use other words. These results say **Related**. The text is processed by an embedding model inside the platform; nothing is sent to another provider.
