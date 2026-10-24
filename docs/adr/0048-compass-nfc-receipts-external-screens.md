# ADR 0048: Compass NFC, Receipt Capture and Native External Screens

- Status: Accepted
- Date: 2026-10-21
- Decider: built and recorded by A92 (RRR-137)
- Closes: A65-011 parts 1 and 2 (NFC, expenses, native external screens); parts 3 and 4 belong to A93
- Migrations: 1490 (range 1490 to 1499, ADR 0022)

## Context

The A65 requirements trace found Compass missing three things the spec asks for:

- **NFC.** Section 4.3 item 7 and Section 13 Scanning ask for NFC NDEF beside barcodes, for asset custody, receiving
  and credential checks. `src/domain/scan.ts` decoded NDEF text, but no NFC module was installed and no screen read a tag.
- **Expenses.** Section 4.3 item 11 asks for "receipt capture with OCR prefill, posting to a budget line". The More entry
  opened Atlas.
- **External More items.** Section 4.5.7 gives each external role type its own More entries (timesheets, per diem, travel
  and lodging, onboarding; purchase orders, deliveries, submittals; time entries, deliverables; advance summary, rider,
  settlement; reports; proof of performance). All of them handed off to Gateway.

## Decision

### 1. NFC through react-native-nfc-manager 4.0.0-beta.10

- **Version.** v3 supports only React Native's legacy architecture; Expo SDK 57 (React Native 0.86) is New Architecture
  only. v4 is the TurboModule line. 4.0.0 shipped on 2026-10-09, inside the two-week rule, so Compass pins
  4.0.0-beta.10 (2026-10-03), the newest v4 release at least two weeks old. Moving to 4.0.0 is a follow-up once it is two
  weeks old.
- **Config.** The library's config plugin adds the NDEF and TAG reader entitlement, `NFCReaderUsageDescription` (English
  in `app.json`, Spanish in `locales/es.json`) and the Android NFC permission with `android.hardware.nfc` not required.
- **Reading.** Every camera mode of the Scan tab gains Read NFC tag. A tag's first well-known text or URI record is the
  code; a tag with neither reads as its serial number in hex. The code then takes exactly the path of a camera or typed
  scan (`classify` with symbology `nfc`): credential checks against the access grid, asset custody, receiving, lookup, and
  the intake queue for an unknown code (`app.scan_symbology` already had `NFC`).
- **Writing.** The spec asks for no tag writing. Lookup offers one write, because it is how an NFC sticker becomes
  scannable at all: a found unit's asset tag is written as one NDEF text record (at most 100 characters, which fits an
  NTAG213). Nothing is written to the server.
- **Test builds.** `EXPO_PUBLIC_XOS_FAKE_NFC=1` replaces the radio with an on-screen test tag
  (`src/runtime/nfc.ts`, `src/screens/NfcControls.tsx`), as A66's fake recorder does for the microphone. `app.config.ts`
  refuses every test-only switch in an EAS build (`TEST_ONLY_SWITCHES`), and the nightly iOS and Android Maestro builds set
  it. Only the reader changes; the screens are the same.

### 2. Receipt capture writes through one offline RPC

- **Photo.** From Compass's camera, or one photo picked in the system photo picker (`expo-image-picker` 57.0.20, the SDK's
  version). The picker runs outside Compass and hands over only the chosen photo, so Compass asks for no photo library
  permission (`photosPermission: false`, held by `test/store-release.test.ts`). The photo is compressed to a 2048 px long
  edge and re-encoded as JPEG, which drops EXIF and its location (Section 13 Media).
- **Aurora.** Reading uses the existing document extraction (`aurora.extract`, kind `receipt`, targeting `expenses.create`)
  through the public API with the person's own token. Compass checks `aurora.status` first: with extraction off, the plan
  without Aurora, the allowance used or the phone offline, no photo leaves the device and the form says why. The request
  carries only the photo and the fixed file name `receipt.jpg` (`receiptExtractionRequest`), so no person, project, vendor
  or Restricted value reaches the model; the server's `app.ai_begin_request` checks the switch again. Each field Aurora
  read shows its confidence; a NO_ANSWER field stays empty for the person.
- **Confirmation.** The person checks every field and chooses the budget line before saving (Section 4.7: a person
  confirms before anything is written). The amount is in the budget's currency; a receipt in another currency is
  flagged and its amount left for the person, never converted.
- **Write path.** Confirming through `aiSuggestions.confirm` would write `expenses.create` online only. Compass instead
  queues one write: the photo uploads to field-media under `<org_id>/expense-receipts/<project_id>/`, then
  `app.submit_expense_receipt` files the expense and its `app.expense_receipts` row, replayed once through
  `app.apply_sync_mutation`. When the person kept Aurora's reading, the RPC moves that suggestion Proposed, Confirmed,
  Applied with the expense as the record written, so the agent provenance is kept; an expired suggestion stays as it is,
  and anyone else's is refused.
- **Who.** Filing needs `finance.expense.write` on the project (feature `expenses.submit`), the canon capability for
  recording expenses; the RPC and the storage policy check the same. The Field role does not hold it today (owner step
  below). Budget lines sync without amounts; the person's own expenses sync by submitter.

### 3. External More items are native, read-only lists

- Each entry is a Compass screen (`src/domain/external.ts`, `src/screens/ExternalPageScreen.tsx`) over the api_external
  projections Gateway reads, downloaded per role type by the REST downloader (`audiences` on each source) and kept on the
  device, so they read offline. PowerSync replicates base tables only, so every new table's device scope rule is
  `restOnly` and `sync-rules.yaml` is unchanged.
- Lines without a project of their own (purchase order, rider, settlement and advance lines, external cues) take their
  parent's project on download (`parent` on the source), so the device-side scope check can place them.
- The onboarding checklist matters before operational access opens, so `DownloadScope` gains `onboardingEngagementIds`
  (engagements not Complete or Canceled) for onboarding items only.
- **Calendars (A71).** Calendar dates are shown as written. Instants show in the project's zone, travel in each end's own
  zone; "today", per diem's today and overdue follow the project's calendar (`@xos/data/calendar`), as Gateway's
  engagement view does with `todayIn(engagement.projectTimeZone)`. Without a known zone, the person's own zone applies.
  A person who chose their own zone (`me.time_zone_display`, A97's `scheduleZone`) sees instants there; dates don't move.
- **Actions.** Submitting a timesheet, uploading onboarding documents, acknowledging an order, handing in a deliverable,
  answering the advance or responding to a settlement stay on the engagement in Gateway; each screen opens its engagement
  tab there. Proof of performance lists the sponsor's entitlements and the proof documents shared with them; capturing
  proof photos from Compass needs a write path for external parties and is a follow-up.

## Consequences

- Compass's More menu has no Gateway or Atlas row left (`elsewhere` is empty for every audience); the mechanism stays
  for any later entry.
- Seed `1490_a92.sql` adds an external crew member with an Active engagement for the Maestro flow; existing personas are
  untouched.
- Owner steps: enable NFC Tag Reading on the App ID before a signed build; decide whether the Field role (or a project
  role) should hold `finance.expense.write` so field staff can file expenses; the Anthropic key on the deployment (as for
  every Aurora feature).

## Amendment (2026-10-23): the Field role files expenses

ADR 0033 decision 76 settles the owner step above: the Field role holds `finance.expense.write` at assigned
reach, on the projects its holder is assigned to (migration 1622). The line picker reads `app.expense_budget_lines`, the
lines of projects where the person records expenses, without quantities or prices, so a field crew member files expenses
without reading the budget. A receipt photo reads with its expense: `finance.expense.read` on the project, or having
submitted it. Approval stays with the budget owner: Field holds no `finance.expense.approve`, the submitter never
approves their own expense, and only the submitter or someone holding `finance.expense.approve` cancels or resubmits
one.
