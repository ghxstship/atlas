# Upload scanning

Section 9 requires MIME sniffing and virus scanning on uploads (finding A22-011). The owner chose self-hosted
ClamAV, the `clamav/clamav` 1.5.4 image (decision 10, ADR 0033). This folder runs it for local development.
Production deployment is in `infra/runbooks/production.md`, under "Upload scanning (ClamAV)".

## How a file is scanned

1. A file lands in a scanned bucket:
   - `attachments`: `app.complete_attachment_upload` queues the job `attachment.scan` (migration 0590).
   - `field-media`, `onboarding-uploads`, `profile-media`, `org-brand`, `imports` and `support-screenshots`:
     a trigger on `storage.objects` queues a row in `private.object_scans` (migrations 1041 and 1240).
2. The `upload-scan` Edge Function runs on a schedule with the service key and calls `runUploadScans`
   from `@xos/platform`. For each due scan it:
   - downloads the file and, for attachments, checks its SHA-256 against the one given at upload;
   - checks the leading bytes against the declared type and the extension
     (`packages/platform/src/scanning/content.ts`);
   - for zip archives, refuses more than 1,000 entries, more than 100 MiB unpacked, a compression
     ratio over 100, encrypted entries, paths outside the archive, ZIP64 and any archive nested in
     another. Office documents are zip containers and may embed one another;
   - streams the file to clamd (`clamavScanner`, INSTREAM over TCP, 60-second timeout);
   - records the verdict with `app.record_attachment_scan` or `app.record_object_scan`, and removes an
     infected or refused file from storage.
3. Files stay quarantined until they are Clean:
   - Only Clean attachments can be downloaded.
   - In `field-media` and `onboarding-uploads`, only the uploader reads a file before it is Clean. In
     `imports` and `support-screenshots`, only the uploader reads a file at all.
   - An import is detected only once its spreadsheet is Clean. An infected spreadsheet fails the import
     without being parsed.
   - `profile-media` and `org-brand` are public, so no read gate is possible. The worker removes what is
     not Clean, and A22-004 limits both to raster images.
4. The uploader is told why. An Infected or Scan Failed verdict outlives the removed file, and
   `app.my_upload_scan_status` answers the uploader only. Atlas shows a plain-language message on the
   import and under a blocked attachment.
5. When clamd or storage cannot answer, the scan is retried with backoff. After five attempts it is
   recorded as Scan Failed and the file stays closed.

## Which scanner runs

`selectVirusScanner` (`packages/platform/src/scanning/select.ts`) reads the function's environment:

| Environment                                             | Scanner                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `XOS_CLAMAV_HOST` set (`XOS_CLAMAV_PORT`, default 3310) | ClamAV                                                                                                |
| No host, local stack                                    | Pass-through: every file is marked clean, with a warning logged for each one. Local development only. |
| No host, anywhere else                                  | None. `upload-scan` answers 503 and claims nothing, so files stay quarantined until a scanner is set. |

A local stack means `SUPABASE_URL` points at `kong`, `localhost`, `127.0.0.1`, `::1`,
`host.docker.internal` or a `*.localhost` name, and `XOS_ENVIRONMENT` is not `production`.

## Local development

```sh
docker compose -f infra/scanning/docker-compose.yaml -p xos4-clamav up -d
```

Add `XOS_CLAMAV_HOST=host.docker.internal` and `XOS_CLAMAV_PORT=3310` to `supabase/functions/.env`,
serve the functions, and call the worker with the service key:

```sh
curl -X POST "$SUPABASE_URL/functions/v1/upload-scan" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Without those two variables, the local stack uses the logged pass-through. Uploads still need the worker
to run before they leave quarantine. For example, an import waits in "Checking the file for viruses"
until `upload-scan` is called.

The EICAR test file (see eicar.org) comes back `Infected`; any ordinary file comes back `Clean`.

## Tests

- `packages/platform/test/scanning.test.ts` and `scanner-select.test.ts` run the pipeline against a
  scripted clamd with an EICAR-style stream.
- The integration suite in `scanner-select.test.ts` streams EICAR and a spreadsheet to a real clamd when
  `XOS_CLAMAV_TEST_HOST` (and optionally `XOS_CLAMAV_TEST_PORT`) names one:

  ```sh
  docker compose -f infra/scanning/docker-compose.yaml -p xos4-clamav up -d --wait
  XOS_CLAMAV_TEST_HOST=127.0.0.1 pnpm --filter @xos/platform exec vitest run test/scanner-select.test.ts
  ```

- pgTAP: `supabase/tests/1041_upload_scanning.test.sql` and `1240_upload_quarantine.test.sql`.

## Scheduling

Schedule `upload-scan` every minute with the platform's cron, as for `webhook-dispatch`.
