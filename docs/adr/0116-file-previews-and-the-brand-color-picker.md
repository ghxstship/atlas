# ADR 0116: File Previews and the Brand Color Picker

- Status: Accepted
- Date: 2026-10-28
- Decider: Package A142 (RRR-205)
- Migrations: none

## Context

Section 11.4 lists ColorPicker and FilePreviewer among the components the product relies on, and finding A65-006
recorded that `packages/ui` had both but no app rendered them (trace row S11.4-02). The brand editor in Settings drew
its own hex field and color input and asked a server action for the contrast result on every change. File rows only
offered Download.

Previews have to respect classification. A Confidential or Restricted PDF, PNG or JPEG never leaves Atlas without the
viewer's email and the time on it (Section 8.6, A103), and Restricted files need step-up. Those rules live in
`/files/{version}` (`app/files/[version]/route.ts`, `lib/files/deliver.ts`) and in `app.record_file_download`.

## Decisions

### 1. A preview reads the same route a download does

Preview fetches `/files/{version}` (or a generated document's own route) from the browser. Whatever that route
answers is what the previewer draws: a classified PNG arrives as the watermarked PDF and previews as a PDF, a refusal
arrives as the route's own sentence and is shown as is, and every preview is logged in `app.file_access_log` as the
download it is. No preview path reads Storage, a signed URL or the stored bytes directly, and `deliver.ts` is
unchanged. Public and Internal files go through the same route rather than a signed Storage URL, which the Atlas CSP
would not let the page fetch anyway.

### 2. PDFs are drawn with pdf.js on the main thread

A browser's built-in PDF viewer in a frame would need `frame-src` for blob URLs or an inline copy of the response,
and its own toolbar would duplicate FilePreviewer's page and zoom controls. Atlas adds `pdfjs-dist` 6.4.299
(Apache-2.0) and draws one page at a time on a canvas, with FilePreviewer's page buttons and zoom steps. Its worker
module is imported in place of a Worker, so no worker script is served and the CSP keeps `worker-src 'self'`.
Version 6 has no eval path. The optional `@napi-rs/canvas` (Node rendering) is listed in
`ignoredOptionalDependencies`, since Atlas never renders PDFs on the server. pdf.js loads only when a PDF preview opens.

### 3. Images and video play from the received bytes

An image shows as `<img>` and a video as `<video>` from a blob URL of the delivered bytes. `img-src` already allowed
`blob:`; `media-src 'self' blob:` is added for video. SVG and HTML are never previewed, since they can carry script.
Files over 25 MB are not fetched for preview; the previewer offers the download.

### 4. Office files show the download

Server conversion of Office files is excluded, so Word, Excel, PowerPoint, OpenDocument and RTF files open the
previewer with a sentence and a Download button instead of being fetched.

### 5. The color picker measures the theme engine's own pairs

`lib/brand/contrast.ts` turns every pair `contrast-pairs.json` declares for `accent-default` into ColorPicker checks,
with the counterpart resolved per theme and each hover or pressed overlay carried along. ColorPicker gains an optional
overlay per check, composited by `composite`, which moved from `check-contrast.js` to the browser-safe `ratio.js` so
both run one arithmetic. A unit test holds the live result equal to `checkAccent` across a spread of colors. Save is
disabled while any pair fails, and the save action still checks the accent and refuses a failure. The server action
that answered each keystroke is gone.

## Consequences

- Shared collection components load only a small Preview button; the drawer, FilePreviewer and pdf.js load on demand.
- A preview counts as a download in the access log, and a member without the export capability for a classified file
  cannot preview it, as they cannot download it.
- New accent rules in `contrast-pairs.json` appear in the picker with their rule and token names until they get copy.
