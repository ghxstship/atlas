# ADR 0034: Upload Scanning with Self-Hosted ClamAV, and Other Owner Decisions of 2026-10-19

- Status: Accepted
- Date: 2026-10-19
- Decider: the owner (decisions 10, 17, 27, 28 and 33, approved 2026-10-19), carried out by A57 (RRR-102)

## Context

Section 9 requires server-side virus scanning of uploads. A34 built the pipeline (A22-011, migration 1041, ADR 0026 item 4): content checks, a `VirusScanner` port, a ClamAV adapter that streams to clamd with INSTREAM, and the `upload-scan` Edge Function. Which scanner production would run was left to the owner (ADR 0026 consequences), so files failed closed: attachments stayed in Scanning and field and onboarding files reached only their uploaders.

Four smaller decisions were taken the same day: the `buffers` dependency without a license, the Spanish word for a project gate, legacy `.xls` imports, and the limit of the org IP allow-list.

## Decision

1. **Upload scanning is self-hosted ClamAV, `clamav/clamav:1.5.4` (decision 10).**
   - The image is pinned in ADR 0001 (amendment below). Files never leave XOS infrastructure, so there is no new subprocessor.
   - `selectVirusScanner` in `@xos/platform` reads `XOS_CLAMAV_HOST` and `XOS_CLAMAV_PORT` (default 3310). These replace the earlier `CLAMD_HOST` and `CLAMD_PORT`.
   - The adapter times out a clamd that stops answering (60 s), and the scan is retried with backoff, as before.
   - **No scanner in production fails closed.** Without `XOS_CLAMAV_HOST`, `upload-scan` claims nothing and answers 503. Files stay quarantined and keep their scan attempts until a scanner is configured.
   - **Local development only: a logged pass-through.** On a local stack, `upload-scan` marks files clean without scanning and logs a warning for every file it lets through. A local stack means a loopback or Docker-internal `SUPABASE_URL` (`kong`, `localhost`, `127.0.0.1`, `::1`, `host.docker.internal`, `*.localhost`), and `XOS_ENVIRONMENT` must not be `production`. No ADR or spec section covered this case. A hosted or self-hosted production `SUPABASE_URL` never matches.
   - **Quarantine covers every upload bucket (migration 1240).**
     - The `imports` and `support-screenshots` buckets join `private.object_scans`, next to field-media, onboarding-uploads, profile-media and org-brand. Attachments keep their per-version state (0590).
     - In imports and support-screenshots only the uploader can read a file at all (1061, 1034). An import's detection is queued only when its spreadsheet scans Clean. An Infected or refused spreadsheet fails the import without being parsed. The import worker also checks the scan before every read.
     - Support tooling reads screenshots with the service role, so it must check `app.object_scan_status` before it opens one.
   - **Uploaders are told why.** The worker removes an infected file. Its Infected or Scan Failed verdict now stays, with the uploader's id, until that name is uploaded again. `app.my_upload_scan_status` answers only the uploader. Atlas uses it to explain a failed import, and attachment panels explain a blocked file, in plain words in en-US and es-US.
   - **Public buckets are still not gated.** profile-media and org-brand objects are public by URL, so a read cannot wait for the scan. The worker removes what is not Clean, and A22-004 limits both to raster images. Moving uploads into a private staging bucket first is the fix if this is no longer acceptable.
   - Deployment is in `infra/runbooks/production.md` and the self-hosting guide. Local use is in `infra/scanning/README.md`. The image is published for linux/amd64 only. Run it on an amd64 host, or under emulation on Apple silicon (`platform: linux/amd64`).

2. **`buffers` 0.1.1 is removed (decision 17).** It came from `exceljs` 4.4.0, through `unzipper` 0.10.14 and `binary` 0.3.0, and declares no license. A pnpm override in `pnpm-workspace.yaml` (`exceljs>unzipper: 0.12.3`) moves exceljs to unzipper 0.12.3 (MIT). That version no longer depends on `binary` or `buffers`, and it keeps the `Parse` API that exceljs's streaming reader uses. A streamed `.xlsx` was read back to check it. `licenses:check` no longer reports `buffers`. The Edge import map loads `npm:exceljs@4.4.0` through Deno, which resolves its own tree. Edge Functions only write `.xlsx`, through JSZip, so they never load unzipper.

3. **Spanish: a project gate is a "compuerta" (decision 27).**
   - es-US catalogs, help articles (gates, home, projects, glossary, schedule, advancing, activity) and the `@xos/ui` strings say "compuerta" wherever a project gate is meant.
   - "Puerta" stays for a physical door or gate: the guest door list, occupancy counted at the doors, door times, the vehicle gate in logistics and Compass, and a venue gate named in an example.
   - `packages/i18n/test/terminology.test.ts` and `apps/atlas/test/help.test.ts` hold both rules.

4. **`.xls` import is dropped (decision 28).**
   - Atlas refuses a `.xls` upload with `import_xls_unsupported`: "Older .xls files cannot be read. Save the sheet as .xlsx or .csv and upload it again." The check is `checkImportUpload` in `@xos/data`.
   - The database refuses it for every caller (migration 1241). The imports bucket takes only text/csv and `.xlsx`, object names must end in `.csv` or `.xlsx`, and a new XLS import job raises the same refusal.
   - `XLS` stays in `app.import_source` for the history of earlier jobs, and in the v1 contract, whose `source` enum is unchanged. The API answers a `.xls` import with that refusal.
   - Attachments may still hold `.xls` files. They are stored and scanned but never parsed.

5. **The IP allow-list limit is documented, not fixed (decision 33).** The org IP allow-list (migration 1201, A52) is enforced where Atlas and the API check credentials. It is not enforced on direct calls to the Supabase REST endpoint (PostgREST, and Storage and Realtime alike) with a valid session token. Only Atlas and the API runtime see the caller's own address; row level security does not, so it cannot apply the list. `legal/security-overview.md` and `infra/runbooks/hosted-security-settings.md` say so plainly. The planned fix is routing all data access through the API, so that the Supabase endpoint no longer accepts end-user tokens directly.

## Consequences

- Production needs a clamd that the Edge Functions can reach before uploads leave quarantine. Until then, nothing changes from today's fail-closed behavior.
- Locally, imports wait for `upload-scan` to run. The pass-through marks them clean. The e2e helper passes the import scans itself, because no clamd runs in e2e.
- The license check still reports `sentry` (FSL-1.1-Apache-2.0) and `@img/sharp-libvips-*` (LGPL-3.0-or-later). These are separate owner and counsel decisions.

## Amends

- ADR 0026 consequences, "Production virus scanner": decided here.
- ADR 0001: `clamav/clamav` 1.5.4 and the `unzipper` 0.12.3 override (amendment of 2026-10-19, A57).
