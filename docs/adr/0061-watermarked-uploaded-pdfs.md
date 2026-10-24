# ADR 0061: Watermarked Uploaded PDFs

- Status: Proposed
- Date: 2026-10-23
- Decider: A103 (RRR-148), for the orchestrator's review
- Addresses: finding A65-016 part 2; Section 8.6 (data loss prevention); trace row S8.6-03
- Migrations: 1690 (range 1690 to 1699)

## Context

Section 8.6 puts the viewer's email and a timestamp on Confidential and Restricted PDFs and images. A82 (migration 1380) built share links and the image half: a Confidential or Restricted PNG or JPEG leaves Atlas as a tagged PDF rendered through the ADR 0031 pipeline with the line on every page. Uploaded PDFs had no path:

- `app.record_file_download` answered `watermark = false` for a Confidential or Restricted PDF, so `/files/{version}` sent it as stored.
- The share link guard refused a Confidential link to a PDF (`share_link_watermark_unsupported`), since nothing could mark one.
- A Confidential or Restricted HEIC, WebP or GIF image (all three are allowed in the attachments bucket) also downloaded in Atlas as stored, for the same reason.

pdfkit, the ADR 0031 renderer, writes new PDFs only; it cannot open an existing one. A102 owns the generated-file half (`report-files.ts`, the export worker) and is out of scope here.

## Decision

1. **pdf-lib 1.17.1 stamps uploaded PDFs** (`packages/data/src/documents/pdf-watermark.ts`). It is MIT licensed, pure JavaScript, and its dependencies (pako, tslib and two pdf-lib packages) were already allowed or in the lockfile. It loads on first use, as pdfkit does. The overlay:
   - keeps every page, its content stream and its resources as they were; pdf-lib wraps the old content in a saved graphics state so the overlay always draws in page space;
   - draws the line twice on every page: across the middle at 32 degrees and 16 percent opacity (the angle and opacity of the generated documents' watermark), and small along the bottom edge at 85 percent so it is readable;
   - follows the page's /Rotate and crop box, so the line reads upright as the page is displayed;
   - marks both copies as `/Artifact` marked content, so a tagged PDF keeps its reading order and screen readers skip the overlay;
   - draws with the Standard 14 Helvetica, so nothing is embedded. A character outside WinAnsi falls back to its base letter, or a question mark (`printable`, render.ts). Both launch locales fit WinAnsi;
   - leaves the document's metadata alone (`updateMetadata: false`) and writes without object streams.
2. **A copy that must carry the mark and cannot is refused, never sent unmarked.** `copyForViewer` (`apps/atlas/lib/files/deliver.ts`) answers a refusal for:
   - an image other than PNG or JPEG. HEIC needs a native decoder and GIF and WebP a pure-JavaScript one to become a PDF; refusing keeps the bundle and the attack surface small, and the uploader can add a PNG, JPEG or PDF copy;
   - an encrypted PDF, which pdf-lib cannot write back. Owner-password PDFs (print or copy restrictions) are encrypted too;
   - a PDF pdf-lib cannot parse.

   `/files/{version}` answers the refusal as text in the reader's language (`compliance.download.download_watermark_unsupported`), and the share route sends the visitor back to the link page with `share_link_watermark_unsupported`. The database refuses the image case first (step 3), so the web shell's refusal is the last line for the PDF cases.

3. **The database rules move with it** (migration 1690). `private.watermarkable_content_type` counts `application/pdf`. `private.guard_share_link` keeps every rule and now refuses only the image types the watermark cannot carry, so a Confidential PDF may have a link. Restricted files still never get one. `app.record_file_download` answers `watermark = true` for every Confidential or Restricted PDF and refuses (`download_watermark_unsupported`) an image the watermark cannot carry, instead of answering it unmarked.
4. **The download name says it is a marked copy.** A PDF goes out as `{name}-watermarked.pdf`, as images already did (`watermarkedFileName`).

## Consequences

- A watermarked copy of a digitally signed PDF no longer validates. pdf-lib 1.17.1 rewrites the file rather than appending an incremental update. The stored original keeps its signature, and Public and Internal files go out as stored.
- A download refused because a PDF is encrypted or unreadable was already logged by `app.record_file_download` or `api_public.open_share_link`, which run before the bytes are read. The log then records an attempt that delivered nothing.
- The org export of Section 14.7 (Settings, Danger zone) still carries originals. It is the org's own data, taken out by the Owner, not a copy for a viewer.
- **What still reaches the stored bytes.** The web shell watermarks because it holds no service role: it reads the file as the viewer (in-app) or receives it from the file-download Edge Function against a single-use ticket (share links). Two calls outside Atlas still return the stored bytes:
  - a member holding `data.export.confidential` (or `data.export.restricted` with step-up) who calls the Storage API directly with their own session. The capability rules of 1380 hold there; the watermark does not;
  - a link's recipient who calls `api_public.open_share_link` and the file-download function directly, holding the token and the access code.
- **Closing those two** needs the web shell to prove itself to the file-download function: a handover secret set in both, the storage policy refusing direct reads of objects that must carry the watermark, and in-app downloads moving to tickets. Making the function stamp the file itself instead runs into the Edge runtime's CPU limit on large PDFs and images. Neither is in this package; the owner can schedule the handover secret as a follow-up.
