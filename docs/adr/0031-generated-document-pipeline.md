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
