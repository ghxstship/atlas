---
title: Warehouse delivery
summary: Nightly Parquet or CSV files of your organization's data in your own bucket, with the published schema and what is never delivered.
section: operate
order: 12
---

Warehouse delivery puts a copy of your organization's data in a bucket you own, every night, so your warehouse can load it. It is part of the Enterprise plan. XOS writes files; it never hands out database credentials.

## Set it up

1. In Atlas, open **Settings**, then **Integrations**, then **Warehouse delivery**. You need the **Schedule report delivery and warehouse delivery** capability.
2. Add a destination: the bucket, its region, a folder, the format (Parquet or CSV) and the hour of the nightly delivery (UTC).
3. Store the bucket credential. It is kept in Vault and never shown again.
4. Choose **Deliver now** to check it, or wait for the night.

S3 and any S3-compatible service work today: Amazon S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2 and Google Cloud Storage through its interoperability endpoint. For a service other than Amazon S3, give its HTTPS endpoint. Private and internal addresses are refused. Native Google Cloud Storage, Azure Blob, BigQuery and Snowflake destinations are not available yet.

The credential is JSON with an access key that may only write to the bucket and folder:

```json
{ "access_key_id": "<access key id>", "secret_access_key": "<secret access key>" }
```

Add `"session_token"` for temporary credentials.

## What arrives

Each delivery writes one folder, `<folder>/<date>/<delivery id>/`:

| File              | What it holds                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `<table>.parquet` | One table. A table over 50,000 rows comes in parts: `<table>.part-0001.parquet`, and so on.          |
| `_schema.json`    | The schema of this delivery: every table, its columns and types, and the columns left out, with why. |
| `_manifest.json`  | Written last: every file with its rows, bytes and SHA-256. Load a delivery only once it is there.    |

Rows are your organization's live rows created before the delivery started. Deleted rows are not delivered. Each file is complete on its own; a new delivery replaces nothing earlier.

Parquet files have one row group, uncompressed, with every column nullable. Types:

| Schema type | Parquet type                          |
| ----------- | ------------------------------------- |
| `string`    | BYTE_ARRAY, UTF8                      |
| `int32`     | INT32                                 |
| `int64`     | INT64                                 |
| `double`    | DOUBLE                                |
| `boolean`   | BOOLEAN                               |
| `date`      | INT32, DATE                           |
| `timestamp` | INT64, TIMESTAMP in UTC, microseconds |

CSV files have a header row, quote fields as RFC 4180 says, and put an apostrophe before a value a spreadsheet would run as a formula.

## Tables

`projects`, `records`, `venues`, `counterparties`, `vendors`, `budget_lines`, `purchase_orders`, `po_lines`, `change_orders`, `invoices`, `payments`, `expenses`, `shipments`, `asset_units`, `shifts`, `timesheets`, `incidents`, `engagements` and `pay_rates`. The columns of each are the columns of the table of the same name in the API reference; the settings page and every `_schema.json` list them exactly.

## What is never delivered

- **Restricted columns**, such as pay rates, bank details, tax identifiers, government identifiers and medical notes. Exporting Restricted data needs step-up authentication each time, which a nightly delivery cannot give.
- **Confidential columns**, unless someone with the confidential export capability turns them on for the destination.
- **Encrypted values**, which leave XOS only through their own screens.

Every delivery is in the audit log, with the files it wrote and the number of columns it left out.
