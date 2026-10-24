# ADR 0061: Watermarked Uploaded PDFs

- Status: Proposed
- Date: 2026-10-23
- Decider: A103 (RRR-148), for the orchestrator's review
- Addresses: finding A65-016 part 2; Section 8.6 (data loss prevention); trace row S8.6-03
- Migrations: 1690 and 1691 (range 1690 to 1699)

## Context

Section 8.6 puts the viewer's email and a timestamp on Confidential and Restricted PDFs and images. A82 (migration 1380) built share links and the image half: a Confidential or Restricted PNG or JPEG leaves Atlas as a tagged PDF rendered through the ADR 0031 pipeline with the line on every page. Uploaded PDFs had no path:

- `app.record_file_download` answered `watermark = false` for a Confidential or Restricted PDF, so `/files/{version}` sent it as stored.
- The share link guard refused a Confidential link to a PDF (`share_link_watermark_unsupported`), since nothing could mark one.
- A Confidential or Restricted HEIC, WebP or GIF image (all three are allowed in the attachments bucket) also downloaded in Atlas as stored, for the same reason.

pdfkit, the ADR 0031 renderer, writes new PDFs only; it cannot open an existing one. A102 owns the generated-file half (`report-files.ts`, the export worker) and is out of scope here.

## Decision

1. **pdf-lib 1.17.1 stamps uploaded PDFs** (`packages/data/src/documents/pdf-watermark.ts`). It is MIT licensed, pure JavaScript, and its dependencies (pako, tslib and two pdf-lib packages) were already allowed or in the lockfile. It loads on first use, as pdfkit does. The overlay:
   - keeps every page, its content stream and its resources as they were; pdf-lib wraps the old content in a saved graphics state so the overlay always draws in page space;
   - does not trust the page to keep that state balanced. It reads the page's content the way a viewer tokenizes it and closes what the page leaves open just inside the wrapper: a save for every restore made without one, a restore for every save left open, and an open text object, path or marked-content sequence (such as hidden optional content). A crafted page with an extra restore, a 1 percent scale and a 1 by 1 clip, which pushed the line out of sight before, now leaves the line in the page's initial state. Counting an operator a viewer would skip only adds saves before the content or restores after it, so a disagreement errs on the safe side. A page whose content ends inside a string, an inline image, an array or a dictionary would swallow the line, and is refused;
   - normalizes boxes that list their corners in reverse, and draws within the crop box clipped to the media box;
   - drops an XFA form (and `NeedsRendering`), which a viewer would show instead of the marked pages;
   - draws the line twice on every page: across the middle at 32 degrees and 16 percent opacity (the angle and opacity of the generated documents' watermark), and small along the bottom edge at 85 percent so it is readable;
   - follows the page's /Rotate and crop box, so the line reads upright as the page is displayed;
   - marks both copies as `/Artifact` marked content, so a tagged PDF keeps its reading order and screen readers skip the overlay;
   - draws with the Standard 14 Helvetica, so nothing is embedded. A character outside WinAnsi falls back to its base letter, or a question mark (`printable`, render.ts). Both launch locales fit WinAnsi;
   - leaves the document's metadata alone (`updateMetadata: false`) and writes without object streams.
2. **A copy that must carry the mark and cannot is refused, never sent unmarked.** `copyForViewer` (`apps/atlas/lib/files/deliver.ts`) answers a refusal for:
   - an image other than PNG or JPEG. HEIC needs a native decoder and GIF and WebP a pure-JavaScript one to become a PDF; refusing keeps the bundle and the attack surface small, and the uploader can add a PNG, JPEG or PDF copy;
   - an encrypted PDF, which pdf-lib cannot write back. Owner-password PDFs (print or copy restrictions) are encrypted too;
   - a PDF pdf-lib cannot parse;
   - a PDF over the limits on reading an untrusted file in the request path: 50 MiB (the bucket's own limit), 5,000 pages, and 256 MiB inflated in all. pdf-lib inflates object and cross-reference streams on load with no limit, so each is inflated first, bounded, with `node:zlib`'s `maxOutputLength`; a deflate bomb is refused before pdf-lib reads it. Streams under a filter other than Flate alone (LZW, run length) are decoded only when under 64 KiB.

   `/files/{version}` answers the refusal as text in the reader's language (`compliance.download.download_watermark_unsupported`), and the share route sends the visitor back to the link page with `share_link_watermark_unsupported`. The database refuses the image case first (step 3), so the web shell's refusal is the last line for the PDF cases.

3. **The database rules move with it** (migration 1690). `private.watermarkable_content_type` counts `application/pdf`. `private.guard_share_link` keeps every rule and now refuses only the image types the watermark cannot carry, so a Confidential PDF may have a link. Restricted files still never get one. `app.record_file_download` answers `watermark = true` for every Confidential or Restricted PDF and refuses (`download_watermark_unsupported`) an image the watermark cannot carry, instead of answering it unmarked.
4. **The download name says it is a marked copy.** A PDF goes out as `{name}-watermarked.pdf`, as images already did (`watermarkedFileName`).
5. **Only the web shell receives a copy that must carry the mark** (migration 1691). The web shell watermarks because the Edge runtime's CPU limit cannot stamp large PDFs and images, so it must be the only one to receive those bytes:
   - **The handover secret.** The file-download Edge Function answers a ticket for a Confidential or Restricted PDF or image only to a caller presenting `XOS_FILE_HANDOVER_SECRET` as a bearer token, a random value of at least 32 characters set in both the function's secrets and Atlas's environment. It passes `p_watermarks` to `app.consume_file_download_ticket`, which otherwise answers nothing and leaves the ticket unused. A link's recipient who calls `api_public.open_share_link` and the function directly, holding the token and the code, gets 404. Unset on either side, those files are refused in Atlas (`download_watermark_unavailable`) and on the link page (`share_link_unavailable`), never sent unmarked; Public and Internal files and Confidential files of other types are unaffected. The function also answers `X-XOS-Watermark` from the file's classification at that moment, and the web shell marks the copy if either the open or the handover says so, so a file raised to Confidential between the two is still marked.
   - **In-app downloads move to tickets.** `app.record_file_download` issues a ticket (naming the member, `private.file_download_tickets.person_id`) for every copy that must carry the mark, and `/files/{version}` trades it at the function with the secret instead of reading Storage as the viewer.
   - **Storage refuses direct reads of those objects.** `private.attachment_download_allowed`, and so the attachments storage policy, no longer lets a member holding the export capability read a Confidential or Restricted PDF or image straight from Storage (`download`, `createSignedUrl`), unmarked and unlogged. The 1380 capability rules still hold for every other file. The one exception is the org export holder (`org.organization.delete`, the Owner) with step-up, whose full export of Section 14.7 carries the org's originals.

## Consequences

- A watermarked copy of a digitally signed PDF no longer validates. pdf-lib 1.17.1 rewrites the file rather than appending an incremental update. The stored original keeps its signature, and Public and Internal files go out as stored.
- A download refused because a PDF is encrypted or unreadable was already logged by `app.record_file_download` or `api_public.open_share_link`, which run before the bytes are read. The log then records an attempt that delivered nothing.
- The org export of Section 14.7 (Settings, Danger zone) still carries originals. It is the org's own data, taken out by the Owner, not a copy for a viewer.
- **The owner sets the handover secret** in each environment before Confidential and Restricted PDFs and images download again: the same random value (`openssl rand -hex 32`) as the file-download function's secret `XOS_FILE_HANDOVER_SECRET` and as `XOS_FILE_HANDOVER_SECRET` in the `atlas` Vercel project (`infra/runbooks/production.md`). Until then those files are refused, never sent unmarked; this includes the Confidential PNG and JPEG images that 1380 already delivered. CI and local stacks write a fresh value into `supabase/functions/.env` and `apps/atlas/.env.local` for each run.
- **Who can still reach an original.** The Owner, with step-up, through the full org export or the Storage API; and the service role (the workers and the file-download function). A leaked handover secret lets its holder remove the mark only from files they already hold a ticket for, that is, a link with its token and code or a download they may make anyway.
- An overlay draws over the page's content, not over its annotations: an opaque annotation (a form field or stamp covering the page) is still drawn above the line. Flattening annotations would change the forms people share, so it is left as it is.
