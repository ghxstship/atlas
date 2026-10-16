# Upload scanning

Section 9 requires MIME sniffing and virus scanning on uploads (finding A22-011). This folder runs
the scanner for local development.

## How a file is scanned

1. A file lands in a scanned bucket:
   - `attachments`: `app.complete_attachment_upload` queues the job `attachment.scan` (migration 0590).
   - `field-media`, `onboarding-uploads`, `profile-media` and `org-brand`: a trigger on `storage.objects`
     queues a row in `private.object_scans` (migration 1041).
2. The `upload-scan` Edge Function runs on a schedule with the service key and calls `runUploadScans`
   from `@xos/platform`. For each due scan it:
   - downloads the file and, for attachments, checks its SHA-256 against the one given at upload;
   - checks the leading bytes against the declared type and the extension
     (`packages/platform/src/scanning/content.ts`);
   - for zip archives, refuses more than 1,000 entries, more than 100 MiB unpacked, a compression
     ratio over 100, encrypted entries, paths outside the archive, ZIP64 and any archive nested in
     another. Office documents are zip containers and may embed one another;
   - streams the file to clamd (`clamavScanner`, INSTREAM over TCP);
   - records the verdict with `app.record_attachment_scan` or `app.record_object_scan`, and removes an
     infected or refused file from storage.
3. Only Clean attachments can be downloaded. In `field-media` and `onboarding-uploads`, only the
   uploader reads a file before it is Clean. `profile-media` and `org-brand` are public, so no read
   gate is possible: the worker removes what is not clean, and A22-004 limits both to raster images.
4. When clamd or storage cannot answer, the scan is retried with backoff. After five attempts it is
   recorded as Scan Failed and the file stays closed.

## Local development

```sh
CLAMAV_IMAGE=<image pinned in ADR 0001> \
  docker compose -f infra/scanning/docker-compose.yaml -p xos4-clamav up -d
```

Add `CLAMD_HOST=host.docker.internal` and `CLAMD_PORT=3310` to `supabase/functions/.env`, serve the
functions, and call the worker with the service key:

```sh
curl -X POST "$SUPABASE_URL/functions/v1/upload-scan" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

The EICAR test file (see eicar.org) comes back `Infected`; any ordinary file comes back `Clean`.
The same pipeline runs in `packages/platform/test/scanning.test.ts` against a scripted clamd.

## Scheduling

Schedule `upload-scan` every minute with the platform's cron, as for `webhook-dispatch`. Production
scanning needs a reachable clamd or a hosted scanner adapter; that choice is the owner's
(`infra/runbooks/hosted-security-settings.md`).
