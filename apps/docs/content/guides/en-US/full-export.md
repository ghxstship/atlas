---
title: Full export
summary: One ZIP archive of your organization's data and metadata, with JSON and CSV for every table, the stored files and a manifest, and how to read it.
section: operate
order: 13
---

The full export is one ZIP archive of everything your organization keeps in XOS: every table as JSON and as CSV, the files people uploaded, and a manifest that lists it all. It is the export the Terms of Service promise when you cancel or switch providers, and the Owner can take it at any time, on every plan.

## Download it

1. In Atlas, open **Settings**, then **Danger zone**. Only the Owner sees the download.
2. Choose **Download the full export**. The archive carries Restricted data, so your session must have passed a second factor. If it has not, Atlas asks for one first.
3. The browser saves `<org>-export-<date>.zip`, named with your organization's slug and today's date on your organization's calendar.

Each export is logged with its table, row and file counts, which **Exports taken** lists on the same page. While a canceled organization is read-only, for 30 days after cancellation, the download stays available.

## What is in the archive

| Path                                | What it holds                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                     | The first entry: every table and file in the archive, with counts and hashes. Read it first.                                      |
| `records/<table>.json`              | One table: an array of rows, each an object with every column you may read, values exactly as kept.                               |
| `records/<table>.csv`               | The same rows as CSV, with a header row in the table's column order.                                                              |
| `files/attachments/<id>-<filename>` | One stored file: its file version id, then its file name with any character other than a letter, digit, `.`, `_` or `-` made `_`. |

The tables are every table of your organization in the `app` schema, read with the Owner's own access, one file pair per table. Rows in Trash are included, with `deleted_at` set. Rows that only one person may read, such as another member's tour progress or personal preferences, are not.

The [data dictionary](dictionary:) describes every table and column: what it holds, its type, whether it may be empty, and the table it points to.

## The manifest

`manifest.json` is a JSON object:

| Field              | What it holds                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `format`           | Always `xos-org-export`.                                                                                         |
| `version`          | The format version, `1`. A change that would break a reader gets a new version.                                  |
| `orgId`            | Your organization's id.                                                                                          |
| `orgSlug`          | Your organization's slug.                                                                                        |
| `createdAt`        | When the export was built, in UTC (ISO 8601).                                                                    |
| `tables`           | One entry per table: `table`, `rows` (the row count), and `json` and `csv`, the paths of its two files.          |
| `files`            | One entry per stored file: `path`, `bytes`, `sha256` (the hash kept when it was uploaded, or null) and `source`. |
| `filesOmitted`     | How many stored files are not in the archive (see below).                                                        |
| `unreadableTables` | Tables that could not be read. They are listed here, never left out silently.                                    |

The download response carries the SHA-256 of `manifest.json` in its `X-Export-Manifest-Sha256` header, and XOS keeps the same hash in the export log ([`app.org_exports`](dictionary:app.org_exports)), so you can show later that an archive is the one you downloaded.

## JSON and CSV

JSON files are UTF-8, one array per table, indented. Values are exactly as stored: text and codes as strings, numbers as numbers, money in minor units beside its currency column, times in UTC, and an empty value as `null`, never zero.

CSV files follow RFC 4180: UTF-8, a header row, lines ending in CRLF, and fields with a comma, quote or line break in double quotes. An empty value is an empty cell. A `jsonb` or array column holds its JSON text. A text value a spreadsheet would run as a formula (one starting with `=`, `+`, `-` or `@`) gets a leading apostrophe; the JSON file keeps it exactly.

## Files

The archive holds the files people uploaded to records that passed the upload scan and are not deleted, in the order they were added, up to 500 files and 500 MB in all, so one archive stays downloadable. `filesOmitted` counts the files over that limit and any that could not be read; the attachment rows in `records/attachment_versions.json` still describe every one. When you switch providers, ask for the files left out as part of transition support (see [Switching providers](guide:switching)).

## Generated PDFs

Purchase orders, invoices, change orders, day sheets, call sheets, run of show, BEOs, badges, inspection and incident reports, final cost reports and agreement certificates are generated from their records each time they are opened, as tagged PDF/UA-1. The archive holds the records they are built from. A PDF someone uploaded is a stored file and is under `files/`. To keep a generated document as a PDF, open its record in Atlas and download it; this works while a canceled organization is read-only too.

## What is not in it

- **Columns no one reads directly**, such as full bank account numbers, pay amounts and token or PIN hashes. They are kept behind their own access paths and are left out of the table's files; the CSV header shows exactly which columns a table has.
- **Platform data** that is not your organization's, such as plans and the Standard Library templates. Your organization's own copies of Standard Library documents and procedures are included.
- **Presence and other live state**, which XOS never stores.

For a nightly copy into your own bucket instead of a download, see [Warehouse delivery](guide:warehouse-delivery). For records one at a time or in pages, use the [API reference](reference:projects).
