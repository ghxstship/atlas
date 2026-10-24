-- 1730_compass_profile_credentials.sql
--
-- A109 (RRR-154), Section 4.3 item 13 (trace S4.3-16): Compass's Profile shows the person's certifications and
-- documents, and reads them offline. The REST downloader pulls both lists into the device's offline store, as it does
-- the external More screens (A92), so the Profile shows them with no signal (ADR 0069).
--   * api_external.my_profile_certifications: the certifications A89's expiry job reminds the caller of (1463, ADR 0045
--     section 7): the org holder records they hold and the certifications they entered on their own profile. A profile
--     entry carried from an org record shows as that record while the record stands, and a renewed record or entry
--     hides the one it replaced, as the job skips both. Each row names its issuer, whether an org verified it, and the
--     calendar its days count on: the org's for an org record, the person's own for a profile entry (UTC until they
--     choose a zone, as private.person_today counts).
--   * api_external.my_profile_documents: signed and executed engagement documents of the caller's engagements while
--     their documents area is open (Section 8.7) and the engagement was not canceled; the certificates of insurance each
--     org keeps on file for an account the caller answers for (api_external.vendor_insurance_certificates' rule, 0766),
--     less those a later certificate of the same coverage replaced; and the passport in their Work Details: its issuing
--     country and expiry, never the number, which 1340 keeps encrypted. Days count on the org's calendar for org items
--     and on the person's for the passport, as the job counts them.
--   * A document whose file is a clean Public or Internal attachment (the newest file of an engagement document's
--     document, the newest file on a certificate of insurance) names that file, and the attachments storage policy
--     lets the caller read it, so Compass opens it through a short-lived signed URL, the path every in-app download
--     takes (0590, 1380). Until now a party saw a signed agreement in Gateway but could not open its file. Confidential
--     and Restricted files stay as 1380 left them: they need an export capability that no external party holds.
-- Both views are owner-rights views with their own row filter on the signed-in person, like
-- api_external.my_certifications (0763), so another person, and anyone in an org the person does not work with, reads
-- nothing.

-- 1. Which documents are the caller's ------------------------------------------------------------------------------------

create or replace function private.my_profile_engagement_document_ids()
returns setof uuid
language sql
stable
rows 10
security definer
set search_path = ''
as $$
  select d.id from app.engagement_documents d
  join app.engagements e on e.id = d.engagement_id and e.deleted_at is null and e.engagement_state <> 'Canceled'
  where d.deleted_at is null and d.engagement_document_state in ('Signed', 'Executed')
    and d.engagement_id in (select private.my_engagement_ids('documents'));
$$;

comment on function private.my_profile_engagement_document_ids() is 'Engagement documents on the signed-in person''s Compass Profile (A109): Signed or Executed, on an engagement that was not canceled and whose documents area they reach now (Section 8.7), the documents the expiry job reminds them of (1463).';
revoke all on function private.my_profile_engagement_document_ids() from public, anon;
grant execute on function private.my_profile_engagement_document_ids() to authenticated, service_role;

create or replace function private.my_profile_insurance_certificate_ids()
returns setof uuid
language sql
stable
rows 10
security definer
set search_path = ''
as $$
  select ic.id from app.insurance_certificates ic
  join app.vendors v on v.id = ic.vendor_id and v.deleted_at is null
  where ic.deleted_at is null
    and private.counterparty_area_open(null, v.counterparty_id, 'documents',
      array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[])
    and not exists (select 1 from app.insurance_certificates i2
                    where i2.vendor_id = ic.vendor_id and i2.deleted_at is null and i2.id <> ic.id
                      and lower(btrim(i2.coverage_type)) = lower(btrim(ic.coverage_type)) and i2.valid_to > ic.valid_to);
$$;

comment on function private.my_profile_insurance_certificate_ids() is 'Certificates of insurance on the signed-in person''s Compass Profile (A109): those each org keeps on file for an account where they are Owner, Admin or Finance while an engagement with that org has the documents area open (as api_external.vendor_insurance_certificates), less any a later certificate of the same coverage replaced, as the expiry job skips it (1463).';
revoke all on function private.my_profile_insurance_certificate_ids() from public, anon;
grant execute on function private.my_profile_insurance_certificate_ids() to authenticated, service_role;

-- The file a profile document opens: the newest clean version among the subject's attachments, only when that file is
-- Public or Internal. A newer Confidential file is not skipped for an older Internal one, which would open an outdated
-- copy; the document then has no file to open in Compass.
create or replace function private.profile_document_file_id(p_subject_table text, p_subject_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when f.classification in ('Public', 'Internal') then f.id end
  from (
    select v.id, a.classification from app.attachment_versions v
    join app.attachments a on a.id = v.attachment_id and a.deleted_at is null
    where a.subject_table = p_subject_table and a.subject_id = p_subject_id
      and v.deleted_at is null and v.scan_status = 'Clean'
    order by v.uploaded_at desc nulls last, v.version_number desc, v.id desc
    limit 1) f;
$$;

comment on function private.profile_document_file_id(text, uuid) is 'The attachment version a Compass Profile document opens (A109): the newest clean file attached to the subject, when it is classified Public or Internal; NULL otherwise. Takes the subject; never decides who may open it. api_external.my_profile_documents calls it for the caller''s own documents.';
revoke all on function private.profile_document_file_id(text, uuid) from public, anon;
grant execute on function private.profile_document_file_id(text, uuid) to authenticated, service_role;

-- The calendar of the caller's personal items. A view runs its functions as the caller, who may not read another
-- person's zone (private.person_time_zone, 1460), so the views ask for their own here.
create or replace function private.my_personal_time_zone()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.person_time_zone(private.current_person_id()), 'UTC');
$$;

comment on function private.my_personal_time_zone() is 'The zone the signed-in person''s personal items count their days in (A109): their personal locale.time_zone, UTC until they choose one, as private.person_today counts.';
revoke all on function private.my_personal_time_zone() from public, anon;
grant execute on function private.my_personal_time_zone() to authenticated, service_role;

-- 2. The certifications ---------------------------------------------------------------------------------------------------

create view api_external.my_profile_certifications as
select r.id, r.person_id, 'Org Record'::text as source, r.name, r.issuing_body, r.issued_on, r.expires_on, true as is_verified,
  r.org_id as verified_by_org_id, o.name as verified_by_org_name, private.org_time_zone(r.org_id) as time_zone
from (
  select h.id, h.person_id, h.org_id, c.name, c.issuing_body, h.issued_on, h.expires_on,
    row_number() over (partition by h.certification_id order by h.expires_on desc nulls first, h.issued_on desc, h.id desc) as rank
  from app.certification_holders h
  join app.certifications c on c.id = h.certification_id and c.deleted_at is null
  where h.deleted_at is null and h.person_id = private.current_person_id()) r
join app.organizations o on o.id = r.org_id
where r.rank = 1
union all
select r.id, r.person_id, 'Profile'::text, r.name, r.issuing_body, r.issued_on, r.expires_on, r.verified_at is not null,
  r.verified_by_org_id, o.name, private.my_personal_time_zone()
from (
  select pc.id, pc.person_id, pc.name, pc.issuing_body, pc.issued_on, pc.expires_on, pc.verified_at, pc.verified_by_org_id,
    row_number() over (partition by lower(btrim(pc.name)) order by pc.expires_on desc nulls first, pc.issued_on desc, pc.id desc) as rank
  from app.person_certifications pc
  where pc.deleted_at is null and pc.person_id = private.current_person_id()
    and not exists (select 1 from app.certification_holders h
                    where h.id = pc.source_certification_holder_id and h.person_id = pc.person_id and h.deleted_at is null)) r
left join app.organizations o on o.id = r.verified_by_org_id
where r.rank = 1;

call private.describe('api_external.my_profile_certifications', 'The caller''s certifications on the Compass Profile (A109): the org holder records they hold and the certifications on their own profile, the items the expiry job reminds them of (1463). A profile entry carried from a standing org record shows as that record; a renewed record or entry hides the one it replaced. Compass keeps them offline and calls out what expires within the job''s 30, 7 and 1-day thresholds.', array[
  'id', 'Holder record (Org Record) or profile certification (Profile).',
  'person_id', 'The caller.',
  'source', 'Org Record for a certification an org recorded for the caller; Profile for one on their own profile.',
  'name', 'Certification name.',
  'issuing_body', 'Body that issues it.',
  'issued_on', 'Day issued.',
  'expires_on', 'Day it expires; NULL when it does not expire.',
  'is_verified', 'True when an org verified it: always for an org record, and for a profile entry an org verified.',
  'verified_by_org_id', 'Org that recorded or verified it; NULL for an unverified profile entry.',
  'verified_by_org_name', 'Name of that org.',
  'time_zone', 'IANA zone of the calendar its days count on: the recording org''s for an org record, the caller''s own (UTC until they choose one) for a profile entry, as the expiry job counts them.'
]);

-- 3. The documents ----------------------------------------------------------------------------------------------------------

create view api_external.my_profile_documents as
select d.id, private.current_person_id() as person_id, 'Engagement Document'::text as document_type,
  d.document_kind::text as document_kind, d.title, d.org_id, o.name as org_name, p.name as project_name, null::text as issuer,
  d.expires_on, d.engagement_document_state::text as document_state, private.org_time_zone(d.org_id) as time_zone,
  f.id as file_version_id, f.version_number as file_version_number, f.object_name as file_object_name, f.filename as file_name,
  f.content_type as file_content_type, f.size_bytes as file_size_bytes, f.classification as file_classification
from app.engagement_documents d
join app.engagements e on e.id = d.engagement_id
join app.projects p on p.id = e.project_id
join app.organizations o on o.id = d.org_id
left join lateral (
  select v.id, v.version_number, v.object_name, v.filename, v.content_type, v.size_bytes, a.classification::text as classification
  from app.attachment_versions v join app.attachments a on a.id = v.attachment_id
  where v.id = private.profile_document_file_id('app.documents', d.document_id)
  limit 1) f on true
where d.id in (select private.my_profile_engagement_document_ids())
union all
select ic.id, private.current_person_id(), 'Insurance Certificate'::text, null::text, ic.coverage_type, ic.org_id, o.name, null::text,
  ic.insurer, ic.valid_to, null::text, private.org_time_zone(ic.org_id),
  f.id, f.version_number, f.object_name, f.filename, f.content_type, f.size_bytes, f.classification
from app.insurance_certificates ic
join app.organizations o on o.id = ic.org_id
left join lateral (
  select v.id, v.version_number, v.object_name, v.filename, v.content_type, v.size_bytes, a.classification::text as classification
  from app.attachment_versions v join app.attachments a on a.id = v.attachment_id
  where v.id = private.profile_document_file_id('app.insurance_certificates', ic.id)
  limit 1) f on true
where ic.id in (select private.my_profile_insurance_certificate_ids())
union all
select w.id, w.person_id, 'Passport'::text, null::text, null::text, null::uuid, null::text, null::text,
  w.passport_issuing_country::text, w.passport_expires_on, null::text, private.my_personal_time_zone(),
  null::uuid, null::integer, null::text, null::text, null::text, null::bigint, null::text
from app.person_work_details w
where w.deleted_at is null and w.person_id = private.current_person_id()
  and (w.passport_number_last4 is not null or w.passport_expires_on is not null);

call private.describe('api_external.my_profile_documents', 'The caller''s documents on the Compass Profile (A109): signed and executed engagement documents of their engagements while the documents area is open, the certificates of insurance each org keeps on file for an account they answer for, and their passport''s issuing country and expiry (never its number). Compass keeps them offline, calls out what expires within the expiry job''s thresholds (1463), and opens a document''s Public or Internal file through a signed URL.', array[
  'id', 'Engagement document, certificate of insurance, or the caller''s Work Details row for the passport.',
  'person_id', 'The caller.',
  'document_type', 'Engagement Document, Insurance Certificate or Passport.',
  'document_kind', 'Kind of an engagement document (Agreement, Rider and so on); NULL for the others.',
  'title', 'Title of an engagement document, or the coverage of a certificate of insurance; NULL for the passport.',
  'org_id', 'Org the document is with; NULL for the passport.',
  'org_name', 'Name of that org.',
  'project_name', 'Project of an engagement document''s engagement.',
  'issuer', 'Insurer of a certificate of insurance, or the passport''s issuing country (ISO 3166-1 alpha-2).',
  'expires_on', 'Day it expires: an engagement document''s expiry, a certificate''s last day, the passport''s expiry.',
  'document_state', 'Signed or Executed for an engagement document; NULL for the others.',
  'time_zone', 'IANA zone of the calendar its days count on: the org''s for an org document, the caller''s own (UTC until they choose one) for the passport, as the expiry job counts them.',
  'file_version_id', 'Attachment version the document opens: its newest clean file when Public or Internal; NULL when it has none to open.',
  'file_version_number', 'Version number of that file within its attachment.',
  'file_object_name', 'Object name of that file in the attachments bucket, which the caller may read through a signed URL.',
  'file_name', 'File name.',
  'file_content_type', 'Content type of the file.',
  'file_size_bytes', 'File size in bytes.',
  'file_classification', 'Classification of the file: Public or Internal.'
]);

revoke all on api_external.my_profile_certifications, api_external.my_profile_documents from public, anon;
grant select on api_external.my_profile_certifications, api_external.my_profile_documents to authenticated, service_role;

-- 4. Opening a document's file -----------------------------------------------------------------------------------------------
-- The attachments storage policy (0590, with 1380's export check) runs as the caller, so an external party, who cannot
-- read the org's documents or certificates of insurance, never resolved their files. This definer check adds exactly the
-- file each of the caller's profile documents names.

create or replace function private.profile_document_file_readable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.attachment_versions v
    join app.attachments a on a.id = v.attachment_id and a.deleted_at is null
    where v.object_name = p_object_name and v.deleted_at is null and v.scan_status = 'Clean'
      and v.id = private.profile_document_file_id(a.subject_table, a.subject_id)
      and case a.subject_table
        when 'app.documents' then exists (
          select 1 from app.engagement_documents d
          where d.document_id = a.subject_id and d.id in (select private.my_profile_engagement_document_ids()))
        when 'app.insurance_certificates' then a.subject_id in (select private.my_profile_insurance_certificate_ids())
        else false
      end);
$$;

comment on function private.profile_document_file_readable(text) is 'True when the object is the file one of the signed-in person''s Compass Profile documents opens (A109): the newest clean Public or Internal file of a signed or executed engagement document, or of a certificate of insurance, on their profile. The attachments storage policy admits it beside the files the caller reads through the subject''s own policy.';
revoke all on function private.profile_document_file_readable(text) from public, anon;
grant execute on function private.profile_document_file_readable(text) to authenticated, service_role;

alter policy attachments_object_read on storage.objects
  using (bucket_id = 'attachments' and (
    (private.attachment_object_readable(name) and private.attachment_download_allowed(name))
    or private.profile_document_file_readable(name)));
