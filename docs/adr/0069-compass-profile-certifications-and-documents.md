# ADR 0069: Compass Profile Certifications and Documents

- Status: Accepted
- Date: 2026-10-24
- Decider: A109 (RRR-154), trace row S4.3-16
- Migrations: 1730

## Context

Section 4.3 item 13 gives Compass a Profile with certifications and their expiry reminders, documents, emergency contact and uniform sizes. A78 added the emergency contacts and uniform sizes (ADR 0033, 1340), read online only. A89 sends the expiry reminders (1463, ADR 0045 section 7). Compass itself still showed no certification or document: its Profile had one button that opened Atlas or Gateway.

A crew member needs these lists where they work, often with no signal: at a gate that asks for a rigging certification, or on a site that checks insurance. Before this ADR they also could not open a signed agreement's file from any shell. The attachments storage policy runs as the caller, and an external party cannot read the org's documents.

## Decisions

### 1. The Profile lists exactly what the expiry job reminds

`api_external.my_profile_certifications` and `api_external.my_profile_documents` (1730) return the items `private.send_expiry_reminders` considers for the caller, with the same rules:

- **Certifications:** the org holder records the person holds, and the certifications on their own profile.
  - A renewed record or entry hides the one it replaced.
  - A profile entry carried from an org record shows as that record while the record stands, and as itself once the record is gone.
- **Documents:**
  - Signed and executed engagement documents, while the engagement's documents area is open to the person (Section 8.7), unless the engagement was canceled.
  - The certificates of insurance each org keeps on file for an account where the person is Owner, Admin or Finance, the rule of `api_external.vendor_insurance_certificates`, less those a later certificate of the same coverage replaced.
  - The passport in Work Details.

The views go in `api_external`, not `app`, even for members. They are owner-rights views that filter on the signed-in person, like `api_external.my_certifications` (0763). Nobody, the recording org included, reads another person's rows through them.

### 2. Days count on the job's calendars, and the callout uses its thresholds

- Each row names the zone its days count on: the recording org's for an org item, and the person's own for a profile entry or the passport. The person's zone is UTC until they choose one, as `private.person_today` counts.
- Compass works out the days left on the device (`src/domain/profileCredentials.ts`), so the callout stays right offline as the days pass.
- An item is at the smallest of the 30, 7 and 1-day thresholds that its days left have reached, the rule of `private.expiry_threshold`. Each card's callout names the most urgent stage reached ("Expiring within 7 days") and lists every item within 30 days. Its tone is info at 30 days, warning at 7 and danger at 1.
- Expired items show an Expired tag on their row and stay out of the callout, because the job stops reminding once the date has passed.

### 3. Offline through the REST downloader

- Compass downloads both views with the person's other work into its offline store, as the local tables `profile_certifications` and `profile_documents`.
- The device scope rule admits a row only when its `person_id` is the signed-in person's. The rules are REST-only, because PowerSync does not replicate views. Every audience reads them, so `sources.ts` gained a person source list beside the internal, external and canon lists.
- The Profile reads all of the person's orgs at once, not just the active org.

### 4. Opening a document's file

- A document names the file it opens: the newest clean file among its attachments. That is the document's `app.documents` row for an engagement document, and the certificate itself for a certificate of insurance. A file is named only when it is classified Public or Internal. A newer Confidential file is never passed over for an older Internal one.
- `private.profile_document_file_readable` admits exactly that object to the caller, as an extra branch of the attachments storage policy. Compass then calls `downloadUrl` from `@xos/data/attachments` for a 60-second signed URL. This is the download path every other in-app file takes (0590, 1380).
- Confidential and Restricted files stay where 1380 put them: they need an export capability that no external party holds. Such a document still shows, without a file to open.
- Alternative: a definer RPC that returns the object name, and a signed URL minted by a server with the service role. Rejected, because it would add a second download path with its own logging and expiry. The storage policy already decides who may read an object.

### 5. The passport shows its expiry, never its number

The documents view carries the passport's issuing country and expiry date. It never carries the number or its last four characters (1340 keeps the number encrypted, and the owner reveals it only through the audited RPC). The pgTAP suite checks that no column of either view names a passport, certificate or policy number.

### 6. Editing stays where the items are kept

The Certifications card ends with Edit in Gateway (the Gateway profile) for an external person and Edit in Atlas for a member, as `certificationsUrl` chose before. The Documents card ends with Manage in Gateway (Gateway's Documents) or Manage in Atlas. Both replace the button that only opened the other app.

## Consequences

- A party can open the file of a signed agreement or a certificate of insurance they answer for. The file must be clean and Public or Internal, and only its newest version opens. Members keep exactly the access they had.
- Superseded certifications and certificates no longer show on the Compass Profile. Gateway's Profile still lists every profile entry the person keeps.
- The Maestro flow `profile-credentials` needs the demo crew member's seeded certification and passport (seeds 0230 and 1340).
