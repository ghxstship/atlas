-- 2714_external_advance_views.sql
-- R9 What Gateway reads of typed advances and supplied assets (RRR-189; Section 8.7, owner decision 6). Views in
-- api_external run as their owner with explicit row filters and column allowlists, as 0750 does. Existing views are
-- recreated from their latest definition with new columns appended at the end only.
--
--   1. api_external.my_advance_recipients (0768) appends engagement_id; 2716 appends names_due_at.
--   2. api_external.advance_sections (0768) appends section_kind, window_kind, max_lines and per_person.
--   3. api_external.advance_section_choices: the classes and categories a section offers, with their names.
--   4. api_external.advance_submissions (0768) appends answer_note, the recipient's own note (0750's doctrine test keeps
--      the bare name note for internal notes).
--   5. api_external.advance_submission_lines: the lines of the caller's answers, with the allocation each asked for.
--   6. api_external.advance_submission_files: the files of the caller's answers, with the title and scan state.
--   7. api_external.sponsor_assets (1133) appends asset_source; awaiting_sponsor holds for an org asset Submitted to
--      the sponsor or a sponsor asset Returned to it.
--   8. api_external.sponsor_asset_files: the files of the sponsor's supplied assets, with the title and scan state.
-- No view in app, private or xpms is created here. Who reviewed, and internal columns, never appear.

-- 1. Recipients ---------------------------------------------------------------------------------------------------------

create or replace view api_external.my_advance_recipients as
select r.id, r.advance_packet_id, r.person_id, c.organization_id as account_id, r.engagement_id
from app.advance_recipients r
join app.advance_packets p on p.id = r.advance_packet_id and p.deleted_at is null and p.sent_at is not null
left join app.counterparties c on c.id = r.counterparty_id
where r.deleted_at is null and private.advance_recipient_open(p.project_id, r.person_id, r.counterparty_id);

call private.describe('api_external.my_advance_recipients', 'Advance recipients the caller answers for: themselves, their account, or a represented artist with the Advance scope, on sent packets.', array[
  'id', 'Recipient.', 'advance_packet_id', 'Packet.', 'person_id', 'Recipient person.', 'account_id', 'Recipient account.',
  'engagement_id', 'Engagement the recipient answers under (R9); NULL when none is linked.']);

-- 2. Sections ------------------------------------------------------------------------------------------------------------

create or replace view api_external.advance_sections as
select s.id, s.advance_packet_id, s.position, s.title, s.prompt, s.section_kind, s.window_kind, s.max_lines, s.per_person
from app.advance_sections s
where s.deleted_at is null and s.advance_packet_id in (select x.id from api_external.advance_packets x);

call private.describe('api_external.advance_sections', 'Sections of the caller''s advance packets.', array[
  'id', 'Section.', 'advance_packet_id', 'Packet.', 'position', 'Order.', 'title', 'Title.', 'prompt', 'What is asked.',
  'section_kind', 'Text, File, Schedule Window, Item Request, Crew Roster, Guest List or Credential Request (R9).',
  'window_kind', 'What a Schedule Window section asks the time of.',
  'max_lines', 'Most files, windows or lines one answer may hold.',
  'per_person', 'True when every item or credential line names one person on the roster.']);

-- 3. Choices ------------------------------------------------------------------------------------------------------------------

create view api_external.advance_section_choices as
select c.id, c.advance_section_id, c.asset_class_id, ac.name as class_name, ac.offering,
  c.credential_category_id, k.name as category_name, k.category_kind
from app.advance_section_choices c
left join app.asset_classes ac on ac.id = c.asset_class_id
left join app.credential_categories k on k.id = c.credential_category_id
where c.deleted_at is null and c.advance_section_id in (select x.id from api_external.advance_sections x);

call private.describe('api_external.advance_section_choices', 'What the caller''s Item Request and Credential Request sections offer (R9): asset classes with the offering each answers for, and credential categories with their kind.', array[
  'id', 'Choice.', 'advance_section_id', 'Section.', 'asset_class_id', 'Asset class offered.', 'class_name', 'Class name.',
  'offering', 'Offering the class answers for, such as Radios or Carts.', 'credential_category_id', 'Credential category offered.',
  'category_name', 'Category name.', 'category_kind', 'Access or Parking.']);

-- 4. Answers ------------------------------------------------------------------------------------------------------------------

create or replace view api_external.advance_submissions as
select a.id, a.advance_section_id, a.advance_recipient_id, a.body, a.submitted_at, a.reviewed_at, a.review_outcome, a.return_reason,
  a.note as answer_note
from app.advance_submissions a
where a.deleted_at is null and a.advance_recipient_id in (select x.id from api_external.my_advance_recipients x);

call private.describe('api_external.advance_submissions', 'Answers given for the caller''s advance recipients, with the review outcome and any reason an answer was returned. Who reviewed never appears.', array[
  'id', 'Answer.', 'advance_section_id', 'Section.', 'advance_recipient_id', 'Recipient.', 'body', 'Answer as rich text, or the summary of a typed answer.',
  'submitted_at', 'When given.', 'reviewed_at', 'When reviewed.', 'review_outcome', 'Accepted or Returned.', 'return_reason', 'Why it was returned.',
  'answer_note', 'The recipient''s own note on a typed answer (R9).']);

-- 5. Lines -----------------------------------------------------------------------------------------------------------------------

create view api_external.advance_submission_lines as
select l.id, l.advance_submission_id, l.line_number, l.asset_class_id, ac.name as class_name, l.credential_category_id,
  k.name as category_name, l.roster_entry_id, pp.full_name as person_name, l.quantity,
  lower(l.needed_window) as needed_from, upper(l.needed_window) as needed_to, l.window_zone, l.note as line_note, al.id as allocation_id
from app.advance_submission_lines l
left join app.asset_classes ac on ac.id = l.asset_class_id
left join app.credential_categories k on k.id = l.credential_category_id
left join private.roster_people rp on rp.roster_entry_id = l.roster_entry_id
left join app.people pp on pp.id = rp.person_id
left join app.advance_allocations al on al.advance_submission_line_id = l.id and al.deleted_at is null
where l.advance_submission_id in (select x.id from api_external.advance_submissions x);

call private.describe('api_external.advance_submission_lines', 'The lines of the caller''s typed advance answers (R9): windows, items and credentials with the person named and the allocation each line asked for; its stage is in api_external.advance_allocations.', array[
  'id', 'Line.', 'advance_submission_id', 'Answer.', 'line_number', 'Order in the answer.', 'asset_class_id', 'Asset class asked for.',
  'class_name', 'Class name.', 'credential_category_id', 'Credential category asked for.', 'category_name', 'Category name.',
  'roster_entry_id', 'Person on the roster the line is for.', 'person_name', 'That person''s name.', 'quantity', 'How many.',
  'needed_from', 'Window start.', 'needed_to', 'Window end.', 'window_zone', 'IANA time zone of the window.', 'line_note', 'The recipient''s own note on the line.',
  'allocation_id', 'Allocation the line asked for; NULL for a window line.']);

-- 6. Files ---------------------------------------------------------------------------------------------------------------------------

create view api_external.advance_submission_files as
select f.id, f.advance_submission_id, f.position, f.document_id, d.title, coalesce(s.scan_status::text, 'Scanning') as scan_status
from app.advance_submission_files f
join app.documents d on d.id = f.document_id
left join lateral (
  select v.storage_uri from app.document_versions v where v.document_id = d.id order by v.version_number desc limit 1
) v on true
left join private.object_scans s on s.bucket_id = 'party-uploads'
  and s.object_name = substr(v.storage_uri, char_length('storage://party-uploads/') + 1)
where f.advance_submission_id in (select x.id from api_external.advance_submissions x);

call private.describe('api_external.advance_submission_files', 'The files of the caller''s File answers (R9), with the document title and the virus-scan state of the upload.', array[
  'id', 'File.', 'advance_submission_id', 'Answer.', 'position', 'Order in the answer.', 'document_id', 'Document.',
  'title', 'Document title.', 'scan_status', 'Scanning, Clean, Infected or Scan Failed.']);

-- 7. Sponsor assets -----------------------------------------------------------------------------------------------------------------

create or replace view api_external.sponsor_assets as
select a.id, a.sponsor_entitlement_id, x.project_id, x.project_name, x.account_id, x.description as entitlement_description,
  a.asset_kind, a.title, a.usage_note, a.due_on, a.revision, a.asset_state, a.decided_at,
  (a.asset_state = 'Submitted' and a.asset_source = 'Org Supplied') or (a.asset_state = 'Returned' and a.asset_source = 'Sponsor Supplied')
    as awaiting_sponsor,
  a.asset_source
from app.sponsor_assets a
join api_external.sponsor_entitlements x on x.id = a.sponsor_entitlement_id
where a.deleted_at is null and a.asset_state <> 'Proposed';

call private.describe('api_external.sponsor_assets', 'Brand assets of the entitlements the caller''s sponsor account is owed (journey 47), once submitted, while the Sponsor engagement is in the operational area: the org''s for the sponsor to approve, and the sponsor''s own for the org to approve (R9). Drafts and who decided on the org side never appear.', array[
  'id', 'Asset.', 'sponsor_entitlement_id', 'Entitlement.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'account_id', 'The caller''s sponsor account.', 'entitlement_description', 'What the entitlement is.',
  'asset_kind', 'Logo, Artwork, Copy, Video or Other.', 'title', 'What the asset is.', 'usage_note', 'Where and how it is used.',
  'due_on', 'When it is needed.', 'revision', 'Revision number.', 'asset_state', 'Submitted, Approved, Returned or Canceled.',
  'decided_at', 'When it was last approved or returned.',
  'awaiting_sponsor', 'True while the sponsor is to act: an org asset Submitted to it, or its own asset Returned to it.',
  'asset_source', 'Org Supplied or Sponsor Supplied (R9).']);

-- 8. Sponsor asset files ------------------------------------------------------------------------------------------------------------

create view api_external.sponsor_asset_files as
select f.id, f.sponsor_asset_id, f.revision, f.position, f.document_id, d.title, coalesce(s.scan_status::text, 'Scanning') as scan_status
from app.sponsor_asset_files f
join app.documents d on d.id = f.document_id
left join lateral (
  select v.storage_uri from app.document_versions v where v.document_id = d.id order by v.version_number desc limit 1
) v on true
left join private.object_scans s on s.bucket_id = 'party-uploads'
  and s.object_name = substr(v.storage_uri, char_length('storage://party-uploads/') + 1)
where f.sponsor_asset_id in (select x.id from api_external.sponsor_assets x);

call private.describe('api_external.sponsor_asset_files', 'The files of the sponsor''s supplied brand assets (R9), by revision, with the document title and the virus-scan state of the upload.', array[
  'id', 'File.', 'sponsor_asset_id', 'Asset.', 'revision', 'Revision the file was supplied with.', 'position', 'Order within the revision.',
  'document_id', 'Document.', 'title', 'Document title.', 'scan_status', 'Scanning, Clean, Infected or Scan Failed.']);

-- Privileges -------------------------------------------------------------------------------------------------------------------------

revoke all on api_external.my_advance_recipients, api_external.advance_sections, api_external.advance_section_choices,
  api_external.advance_submissions, api_external.advance_submission_lines, api_external.advance_submission_files,
  api_external.sponsor_assets, api_external.sponsor_asset_files
  from public, anon;
grant select on api_external.my_advance_recipients, api_external.advance_sections, api_external.advance_section_choices,
  api_external.advance_submissions, api_external.advance_submission_lines, api_external.advance_submission_files,
  api_external.sponsor_assets, api_external.sponsor_asset_files
  to authenticated, service_role;
