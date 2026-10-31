# ADR 0031: Generated Document Pipeline

- Status: Accepted
- Date: 2026-10-19
- Decider: A49 (RRR-93), for the orchestrator

## Context

Section 11.9 lists twelve generated documents: purchase order, invoice, change order, day sheet, call sheet, run of show, BEO, credential badge, inspection report, incident report, final cost report and signed agreement certificate. Each needs a versioned template using the tenant brand and legal entity, and a tagged PDF (PDF/UA) render with a reading order, alternative text for logos and real table headers. Each must print on US Letter and A4 and show its record key, version, generation time and a QR code that opens the record. Section 18 gate 19 requires veraPDF to pass for every template.

Before this ADR, only report runs rendered PDFs, untagged, with pdfkit 0.20.2 (ADR 0029, `packages/data/src/report-files.ts`). The stack table in Section 9 names "HTML templates rendered to tagged PDF through headless Chromium".

## Decision

1. **Renderer: pdfkit 0.20.2, already pinned (ADR 0001, A43 amendment), not headless Chromium.**
   - pdfkit 0.20.2 writes tagged PDF with a structure tree, marked content, artifacts, `/Lang`, `DisplayDocTitle` and the PDF/UA identification in XMP (`subset: "PDF/UA"`).
   - It runs inside the Next.js server and in plain Node (tests, the veraPDF check) with no browser binary, which keeps serverless functions small. Chromium's print-to-PDF output does not mark page furniture as artifacts or give table headers a scope, so it would need post-processing to pass veraPDF.
   - The renderer (`packages/data/src/documents/render.ts`) lays out a small document model (headings, paragraphs, field tables, line tables) instead of HTML. Section 11.9's "versioned HTML template" is met as a versioned TypeScript template over that model; the Section 9 stack row is amended here.
   - pdfkit stays in `serverExternalPackages` in Atlas and Gateway, so it is loaded from `node_modules` on the server and never bundled into a client chunk.

2. **What the renderer guarantees, per PDF/UA-1.**
   - One `Document` structure element holds every element in reading order: brand, `H1` title, the facts table, the record link, the QR `Figure`, then the blocks.
   - Every table has a `Caption`; header cells are `TH` with `Scope` Column, and the label cells of a field table are `TH` with `Scope` Row. A header row repeated on a later page is a Pagination artifact, so it is read once.
   - The logo and the QR code are `Figure` elements with alternative text from the catalog. Rules, page numbers and the footer key are artifacts.
   - Inter Regular and SemiBold (SIL OFL 1.1, Latin subset from `@fontsource/inter` 5.3.0) are embedded and subset. They ship as hex text in `fonts.generated.ts` (`pnpm --filter @xos/data documents:fonts`), so there is no runtime file read; hex rather than base64 so the finish guard can never match a word in the data. WOFF 1.0, because fontkit 2.0.4 cannot subset composite glyphs from WOFF2.
   - A character outside the Latin subset falls back to its NFKD base letter or `?`, because drawing `.notdef` fails PDF/UA.
   - pdfkit writes a CIDSet for any subset numbered 1, meant for PDF/A-1, and its CIDSet omits the composite glyph parts fontkit adds, which veraPDF refuses (7.21.4.2-2). The CIDSet is optional in PDF/UA, so the renderer holds the part number as the text `"1"`: the XMP still says `pdfuaid:part` 1 and no CIDSet is written.
   - Logos embed when the stored file is PNG or JPEG; any other format (SVG) falls back to the brand name as text.

3. **Templates are versioned by issue time.** `TEMPLATES` keeps every version of every kind with an `effectiveFrom` instant. A record renders with the latest version whose `effectiveFrom` is not after the record's issue time, so a re-render of an old record uses the version it was issued with. A template change ships as a new version, never as an edit to a shipped one. The issue time of each kind:

   | Document                     | Issue time                           |
   | ---------------------------- | ------------------------------------ |
   | Purchase order               | `created_at`                         |
   | Invoice                      | `issued_on`, else `created_at`       |
   | Change order                 | `created_at`                         |
   | Day sheet, call sheet        | `published_at`, else `updated_at`    |
   | Run of show                  | `show_date`                          |
   | BEO                          | `approved_at`, else `created_at`     |
   | Credential badge             | `created_at`                         |
   | Inspection report            | `signed_off_at`, else `inspected_at` |
   | Incident report              | `created_at`                         |
   | Final cost report            | the generation time (computed live)  |
   | Signed agreement certificate | `signed_at`                          |

   No migration is needed: the version follows from data every record already holds. The PDF carries the version in its facts block and the `X-Document-Template-Version` response header.

4. **Data is read as the caller.**
   - Atlas: `loadDocumentData` reads each record through `@xos/data` with the viewer's own client, so row level security decides what a document shows. The record's project must belong to the org in the URL; a record of another org the viewer also belongs to answers 404, so a document never carries one org's record under another org's brand (ADR 0003). An agreement certificate exists only once the agreement is signed.
   - Gateway: external parties read only `api_external` views. `loadExternalDocumentData` reads the same views the engagement tabs show (purchase orders, invoices, change orders, runs of show, credentials), so a vendor, client or crew member downloads exactly the record their tab lists. The views carry no project key, so Gateway documents name a purchase order `PO{n}` and leave the project key off other keys.

5. **Delivery.**
   - Atlas route: `/{org}/documents/{kind}/{id}`, `?paper=a4` for A4 (US Letter by default). Every Section 11.9 record view shows a secondary "Download PDF" and "PDF (A4)" action, so each screen keeps one primary action.
   - Gateway route: `/documents/{kind}/{id}?engagement={key}`, offered on the engagement tabs that list those records.
   - The QR code opens the record in the shell that served the document: the Atlas page and `peek` query of the record, or the Gateway engagement tab.
   - All copy is in the `documents` catalog namespace (en-US and es-US). Atlas lists it as server-only, so it never reaches a client bundle; Gateway's client namespaces are an allow-list that omits it.

6. **veraPDF in CI.** `pnpm --filter @xos/data documents:verapdf` renders all twelve templates from fixture data (`test/documents/fixtures.ts`) on Letter and A4 in en-US and es-US (48 files) and validates each against PDF/UA-1 with the Docker image `verapdf/cli:v1.30.2`. It exits 1 on any failure. The fixtures include unpriced lines, a table spanning pages, long wrapping text and characters outside the font subset.

## Alternatives considered

- **Headless Chromium (Playwright's or `@sparticuz/chromium`) from HTML templates.** Rejected for now: a browser binary in every serverless function, and its tagged output needs post-processing to pass PDF/UA. The document model keeps the door open to an HTML renderer later behind the same `renderDocumentPdf`.
- **Storing the issuing template version on each record (a migration on every document table).** Rejected: the issue time each record already has decides the version deterministically, with no write on download.
- **A new `@xos/documents` package.** Rejected: the templates read `@xos/data` record types and the loaders are repository code; a subpath (`@xos/data/documents/*`) kept out of the package index is enough to keep it server-only.

## Consequences

- Section 9's stack row for generated documents now reads pdfkit with a document model; this ADR amends it.
- Gate 19 needs the CI job that runs `documents:verapdf` (the YAML is in the A49 report for the orchestrator).
- Gateway does not offer the signed agreement certificate: Gateway signing runs on a token page without a session, and the signer's certificate is downloaded from Atlas by the org. Day sheets, call sheets, BEOs, inspections, incidents and the final cost report are offered in Atlas only, because Gateway's tabs do not list them as records.
- A tenant logo stored as SVG prints as the brand name until a PNG or JPEG logo is uploaded.

## Amendment (2026-10-30, R7, RRR-187): the radio hand-out

- **A thirteenth record document.** `radio-handout` is added beyond Section 11.9's twelve.
  - It is keyed by the project id, so it is served at `/{org}/documents/radio-handout/{projectId}`.
  - Its loader reads `app.radio_handout`, as the caller and for a project of the org.
  - It lists one row per radio allocation, sorted by party and then person: the person, the party, the radio, the
    tags issued, the channels and the status, plus blank Signature and Returned columns for the hand-out table.
- **Classification and version.** It prints names, asset tags and channel numbers, so it is Internal. It is computed
  live, so like the final cost report it renders with the version in force at generation time.
- **Delivery.** It is offered in Atlas only, from the allocations page. Its QR code opens that page filtered to the
  project's assets.
- **veraPDF.** The gate now renders thirteen templates. With the two papers and two locales that is 52 record files
  (48 before).

## Amendment (P5, G-144): card sizes, the badge photo and batch printing

The owner approved the competitor parity audit on 2026-10-28; gap G-144 asks for printable photo badges. These decisions extend the pipeline for the credential badge only.

1. **Card papers, for the badge only.** `PrintSize` adds A6 (297.64 by 419.53 pt) and CR80, the ID-1 card (153.01 by 242.65 pt, portrait), to Letter and A4. `printSizesFor("credential-badge")` is all four; every other kind keeps `PAPERS`, and `Paper` and `isPaper` still mean Letter or A4, so compliance forms and Gateway accept only those. The Atlas document route parses `?paper=` with `isPrintSizeFor`: a card size on any other kind prints on Letter, and Gateway documents stay Letter and A4. `renderDocumentPdf` refuses a card paper for any other kind.
2. **The card layout** (`render-card.ts`) is one tagged PDF/UA-1 page: brand logo `Figure` or name, a row with the portrait `Figure` and the scan code `Figure`, the holder's name as `H1` (12 pt shrinking to 9 pt on CR80, 18 to 12 on A6, wrapping past three lines rather than truncating), compact paragraphs for the category, number and validity window, on A6 a fields `Table` with row headers, and a facts line (record key, template version, generation time). The border and accent rule are artifacts. The template builds the blocks in card order when the context's paper is a card; the layout places blocks by kind and never reads a label.
3. **One QR on a card.** On A6 and CR80 the only QR is the badge's gate code, `XOSCR1:<credential number>`, the wallet pass form (ADR 0049) that Compass reads as the credential. Two codes on a 54 mm card send gate staff to the wrong one, so the record link QR of decision 2 is left out on card papers only. Letter and A4 keep the header with the record link QR, as Section 11.9 requires; badge version 2 adds the gate code in the body there too.
4. **Template versions are chosen by paper.** A version may name the papers it prints on (`papers`, Letter and A4 when absent). `templateFor(versions, issuedAt, paper)` considers only those versions, takes the latest whose `effectiveFrom` is not after the issue time, or the earliest of them. Credential badge version 2 (portrait, name, gate code, fields, scan note) takes effect at `BADGE_V2_FROM = 2027-02-01T00:00:00Z`, a fixed instant after the planned release that ships it (4.2b), so a credential issued on production before that release keeps version 1 on Letter and A4 (decision 3). A6 and CR80 never existed under version 1, so every credential renders version 2 there. Atlas dates a badge by the credential's creation; Gateway's `api_external.credentials` view exposes no creation time, so Gateway dates it by the start of its validity window. A credential created before `BADGE_V2_FROM` whose window starts after it therefore downloads as version 2 on Letter and A4 in Gateway and version 1 in Atlas. Both carry the same credential details, and only version 2 adds the photo and the gate code; exposing the creation time on that view (an additive API change) would close the difference and is left to a later package.
5. **The badge photo.** The badge prints, in resolution order computed at read time (`app.credential_photo_states`, 2822): the org's badge photo for the holder once its object scanned Clean; else the holder's profile photo when the caller may see the photo section of the profile, no block stands between them (ADR 0033 decision 57), and it is a JPEG or PNG of at most 2 MiB; else the placeholder "No photo on file". The holder gives the badge photo in Gateway (Profile, Badge photos), from an upload they crop by hand or their own profile photo, with a `credential_photo` consent record, and withdraws it there; an issuer may ask for one (`credential_photo.requested`) or remove it. There is no capture at a desk. The photo is Internal, like the badge it prints on (no Section 8.6 watermark), and no machine learning reads it.
6. **Batch printing.** `GET /{org}/documents/badges?id=…&paper=…` prints 1 to 100 credentials in one file: one `Document` root, a `Sect` per badge starting on a new page, each with its own facts and page numbers. Credentials the viewer cannot read, of another org (ADR 0003), revoked or expired are left out and counted in `X-Badges-Skipped`. A run of 100 badges with photos is larger than Vercel's 4.5 MB buffered function response, so the route streams the PDF: each badge's pages are written as soon as it is drawn. If streaming is found not to lift the cap on the deployed functions, the batch maximum is lowered until the worst case fits, and this amendment and the print panel notice record the new cap.
7. **veraPDF** also renders, per locale, CR80 and A6 badges with and without a photo, version 2 on Letter and A4 with a photo, and 3-badge batches on CR80 and Letter (16 more files); the per-kind loop keeps the version 1 badge, issued before `BADGE_V2_FROM`.

## Amendment (B8, RRR-232, G-68 and G-71): the guest pass

ADR 0147 decision 6 gives guests passes, not credentials. These decisions extend the pipeline for the guest pass only.

1. **A new kind, `guest-pass`.** It is keyed by the guest list entry, so it is served at
   `/{org}/documents/guest-pass/{id}` through the existing `[kind]/[id]` route. Its loader reads the entry as the
   caller (`advancing.packet.read` through row level security) and answers not found unless the guest is Approved or
   Checked In, so a Requested or Declined guest has no pass.
2. **Card papers, as the badge.** `printSizesFor("guest-pass")` is the badge's four sizes with A6 as the default; the
   guest-email worker attaches the A6 pass. The card layout (`render-card.ts`) places its blocks by kind: the guest's
   name as the heading, the scan code `XOSGP1:<pass code>` as the only QR, and compact paragraphs for the pass type,
   the show and its date in the project's time zone, "Admits {n} more" when plus-ones are over 0, and the table.
   There is no portrait.
3. **Classification and version.** It prints a name, a pass code and a table, so it is Internal. Version 1 takes
   effect at a fixed instant no earlier than the planned release of the package that ships it, as P5's
   `BADGE_V2_FROM`; the record key in its facts line is the pass code.
4. **veraPDF** renders the guest pass on A6 and CR80 in en-US and es-US (four more files).
