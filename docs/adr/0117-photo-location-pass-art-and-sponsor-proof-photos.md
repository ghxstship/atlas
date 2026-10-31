# ADR 0117: Photo Location, Pass Art from the Org Logo, and Sponsor Proof Photos

- Status: Accepted
- Date: 2026-10-28
- Decider: A140 (RRR-204), trace row S13-10
- Migrations: 2330, 2331, 2332, 2333

## Context

Three gaps were left in Compass after A92 and A93 (finding A65-011):

- Section 13 Media says "EXIF location kept only if the org enables it". Compass resized every photo and re-encoded
  it, which dropped its EXIF, and no org could keep the location.
- Wallet passes used a plain icon in the org's accent color. The org's logo was never on the pass. The widget
  gallery's names and descriptions were English only.
- The Section 4.5.7 role table gives External Sponsor "Proof-of-performance capture with photos", and journey 47
  says "entitlement fulfillment is captured with photos in Compass". A92 built the sponsor's proof-of-performance
  screen read-only. ADR 0048 left the write path for later, because no external party could write a photo.

## Decisions

### 1. Photo location is an org setting, off by default

`media.keep_photo_location` (organization scope, edited with `data.classification.write` in Settings, Data and
Privacy) is a registry setting (`packages/schemas/settings/a140.yaml`, 2330). The registry renders the field on that
page in Atlas, so no contributed panel is needed. Compass downloads the value with its other settings.

A sponsor is an external party with no membership, so Compass resolves no org values for them. For proof photos,
`api_external.sponsor_entitlements` carries the entitlement's org's value as `keep_photo_location` (2333), and the
proof-of-performance screen takes the photo with that rule in place of the person's resolved values
(`proofPhotoSettings`). The entitlement's org decides, never the sponsor.

When the setting is on, `processPhoto` writes the place back into the resized JPEG as GPS EXIF
(`src/domain/exif.ts`). The segment holds only the GPS tags: version, latitude, longitude and, when known, altitude.
It replaces any Exif segment the encoder wrote, so nothing else the camera recorded travels with the photo.

Compass takes the place from the camera's own GPS tags. When the camera recorded none (iOS cameras through
AVFoundation do not tag photos), it uses the device's last position from the past two minutes. It does so only when
Compass already holds location permission. Compass never asks for location just to tag a photo. When the setting is
off, Compass asks the camera for no EXIF and the file leaves without a location.

The rule applies to every photo `processPhoto` handles: incidents, inspections, form photos, kiosk punches and proof
photos. Receipt photos (`runtime/receipts.ts`) are documents, not field photos, and keep no location.

### 2. Pass art comes from the org's PNG logo

`app.my_wallet_pass` returns `logo_path` (2331): the org's dark-theme logo, else its light one. It comes from
`private.public_brand`, which is already public. The pass is the accent color with white labels, which is why the
dark-theme logo comes first.

The wallet-pass function reads the logo from the public org-brand bucket and draws the pass images from it:

- the icon at 1x, 2x and 3x: the logo on the pass color;
- the logo image: the logo itself, fitted to 160 by 50 points;
- the strip of a shift pass (an event ticket): the logo in the middle of the pass color. Wallet has no strip for a
  generic pass.

Once the pass carries the logo image, it drops `logoText`, so the org's name is not shown twice. Google Wallet fetches
images itself, so it gets the logo's public URL.

Only PNG logos are drawn. The bucket also allows SVG, WebP and ICO, and the Edge runtime has no library to rasterize
them (A85). The decoder (`packages/platform/src/wallet/png.ts`) reads non-interlaced PNGs of every color type, up to
4096 by 4096 pixels. It inflates with the runtime's `DecompressionStream`, and deflates its output with
`CompressionStream`.

Any logo the function cannot read falls back to 1501's accent icon, and so does a failed fetch. A logo never costs
the person their pass. The PNG code loads only for a pass with a logo, so the function's boot code stays inside its
120 KB budget.

### 3. Widget gallery text is generated from the catalogs

WidgetKit shows the gallery's names and descriptions before Compass has run, so the App Group cannot carry them.
`CompassWidgets.swift` writes each one in en-US, and that text is the lookup key. `en.lproj` and `es.lproj`
`Localizable.strings` translate it. `test/widget-gallery.test.ts` generates both files from
`compass.glance.gallery` (`pnpm --filter @xos/compass generate:widget-strings`). The same test fails when the Swift
literals and the en-US catalog disagree.

### 4. Sponsors write proof photos under Section 8.7

The write path fits the security model, so it is built (2332):

- **The engagement is the key.** Only someone who reaches the operational area of a Sponsor engagement may capture
  on it. That is the engaged person, or an Account Owner, Admin or Member of the sponsor's account, while the
  engagement is Active or Closing (`private.can_capture_proof_photo`). Account Finance does not reach the
  operational area, so it captures nothing. At Complete the operational area closes, and capture closes with it.
- **Only the sponsor's own deliverables.** `app.record_proof_of_performance_photo` checks three things: the
  entitlement and the engagement are the same sponsor's, on the same project, in the org the path names. Any other
  combination is refused as not found, so nobody learns whether another party's entitlement exists.
- **A folder per engagement.** Photos go to field-media under `<org_id>/proof-of-performance/<engagement_id>/`. The
  storage policy lets the same people write there and read there. The org reads with `vendors.vendor.read` on the
  project, as it reads the entitlement's deliveries and brand assets (0492). No other party, and no crew member on
  the same project, reads the folder.
- **Scanned like every field photo.** Every field-media object is queued for upload-scan (1041). Until the object
  scans Clean, the restrictive read policy keeps it from everyone but its uploader.
- **Projections only.** The sponsor reads `api_external.proof_of_performance_photos`, never the app table. The view
  has no person ids and no audit columns.
- **Offline, once.** Compass queues the photo like an expense receipt. The uploader stores the file first, then the
  RPC replays through `app.apply_sync_mutation`, idempotent on the device-minted id.

The sponsor's team sees every photo on its engagement, not only its own: the people at an activation share the
work, as they share the engagement's entitlements. "Anyone else's files" means another party's or the org's, and
the engagement folder keeps them out.

A photo is evidence, not the org's acceptance. It does not record an entitlement delivery or mark the entitlement
fulfilled; the org still does both. Nothing in the app deletes a photo, so the table stays out of Trash (ADR 0110).

## Consequences

- Turning photo location on changes only photos taken afterwards. Photos already uploaded stay as they are.
- An org whose logo is an SVG, WebP or icon file keeps the accent icon until it uploads a PNG.
- The org has no Atlas page for sponsor proof photos yet: it reads the table and the files through the API and the
  storage policy. A review surface is left for later.
- The Maestro flow `sponsor-proof-photo` uses the Demo Activation Sponsor of seed 2332. That sponsor is a new person
  and account, so `sponsor@` stays without an engagement, which Gateway journey 47 expects.
