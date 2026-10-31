-- 3035_file_version_reviews.sql
-- B14 Event types and project setup (RRR-238; parity gap G-268; ADR 0153 decision D6; block 3030 to 3039). File review
-- per attachment version, on submittals and records: someone other than the uploader approves a version or asks for
-- changes, and a submittal is not Approved while a current file stands at Changes Requested.
--
--   * app.attachment_version_reviews: append-only, one row per review; the reviewer is created_by and the latest
--     review of a version is its decision. Written only by app.review_attachment_version; readable by whoever reads the
--     attachment.
--   * sod_file_review_uploader: the person who uploaded a version cannot review it (a new separation-of-duties rule).
--   * app.attachment_review_status: each live version's latest decision and whether it is the attachment's current
--     (newest Clean) version.
--   * app.transition_submittal is restated from 0492, its only definition: Approved is refused
--     (submittal_files_changes_requested) while a live file's current version stands at Changes Requested.
--   * api_external.submittal_files: the vendor reads each Clean version of the files of its own submittals with the
--     decision and note, never who reviewed, nor the object name or any download path. Like 2610's
--     api_external.submittals it is an owner-rights view filtered by private.vendor_side_open, because vendors cannot
--     read app.attachments through row level security.
-- Reviews are append-only facts and stay out of Trash. app.attachment_review_status revokes select from xos_backup
-- (1650); 1650's rule covers app, private and xpms, not api_external.

create type app.file_review_decision as enum ('Approved', 'Changes Requested');
comment on type app.file_review_decision is 'Decision of a file version review (G-268): Approved, or Changes Requested with a note.';

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_file_review_uploader', 'File reviews', 'The person who uploaded a file version cannot review it.');

-- Reviews ------------------------------------------------------------------------------------------------------------------------

create table app.attachment_version_reviews (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  attachment_version_id uuid not null references app.attachment_versions (id),
  decision app.file_review_decision not null,
  note text,
  constraint attachment_version_reviews_note_length check (note is null or (char_length(note) between 1 and 1000 and note = btrim(note))),
  constraint attachment_version_reviews_changes_note check (decision <> 'Changes Requested' or note is not null)
);

call private.install_domain_table('app.attachment_version_reviews', 'app.attachment_versions', 'attachment_version_id', '{}', true);
create index attachment_version_reviews_version_idx on app.attachment_version_reviews (attachment_version_id, created_at);
call private.describe('app.attachment_version_reviews', 'Reviews of file versions on submittals and records (G-268, ADR 0153 D6): append-only, one row per review, the reviewer in created_by; the latest review of a version is its decision, and a new version starts unreviewed. Written only by app.review_attachment_version; readable by whoever reads the attachment.', array[
  'attachment_version_id', 'File version reviewed.',
  'decision', 'Approved or Changes Requested.',
  'note', 'What to change, required for Changes Requested; up to 1000 characters.'
]);

create policy attachment_version_reviews_read on app.attachment_version_reviews for select to authenticated
  using (attachment_version_id in (select v.id from app.attachment_versions v where private.can_read_attachment(v.attachment_id)));

call private.install_default_retention('app.attachment_version_reviews');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('attachment_version_reviews', 'File reviews are append-only facts of a decision; a new review supersedes one, nothing is undone from Trash.');

-- Reviewing a version ----------------------------------------------------------------------------------------------------------

create or replace function app.review_attachment_version(
  p_attachment_version_id uuid,
  p_decision app.file_review_decision,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_version app.attachment_versions;
  v_attachment app.attachments;
  v_project uuid;
  v_capability text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid;
begin
  select * into v_version from app.attachment_versions v where v.id = p_attachment_version_id and v.deleted_at is null;
  select * into v_attachment from app.attachments a where a.id = v_version.attachment_id and a.deleted_at is null;
  if v_version.id is null or v_attachment.id is null then
    raise exception using errcode = '42501', message = 'file version not found';
  end if;
  if v_attachment.subject_table = 'app.submittals' then
    select s.project_id into v_project from app.submittals s where s.id = v_attachment.subject_id and s.deleted_at is null;
    v_capability := 'procurement.po.write';
  elsif v_attachment.subject_table = 'app.records' then
    select r.project_id into v_project from app.records r where r.id = v_attachment.subject_id and r.deleted_at is null;
    v_capability := 'work.record.write';
  else
    perform private.refuse('file_review_subject', 'Files are reviewed on submittals and records.');
  end if;
  if v_project is null or not private.can_on_project(v_project, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required on the project', v_capability);
  end if;
  if v_version.scan_status <> 'Clean' then
    perform private.refuse('file_review_not_clean', 'Only a file that passed its virus scan is reviewed.');
  end if;
  perform private.assert_separation('sod_file_review_uploader', v_me, v_version.uploaded_by);
  if p_decision is null then
    raise exception using errcode = '22023', message = 'a decision is Approved or Changes Requested';
  end if;
  if (p_decision = 'Changes Requested' and v_note is null) or char_length(coalesce(v_note, '')) > 1000 then
    perform private.refuse('file_review_note_required', 'Say what to change in up to 1,000 characters.');
  end if;
  insert into app.attachment_version_reviews (attachment_version_id, decision, note)
  values (v_version.id, p_decision, v_note)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.review_attachment_version(uuid, app.file_review_decision, text) is 'Reviews one version of a file on a submittal or a record (G-268, ADR 0153 D6): records Approved or Changes Requested with the caller as reviewer. Needs procurement.po.write on the submittal''s project or work.record.write on the record''s project (42501). Refuses a file on another subject (file_review_subject), a version that is not Clean (file_review_not_clean), the person who uploaded it (sod_file_review_uploader) and Changes Requested without a note of up to 1000 characters (file_review_note_required). Returns the review id.';
revoke all on function app.review_attachment_version(uuid, app.file_review_decision, text) from public, anon;
grant execute on function app.review_attachment_version(uuid, app.file_review_decision, text) to authenticated, service_role;

-- Where each version stands -------------------------------------------------------------------------------------------------------

create view app.attachment_review_status with (security_invoker = true) as
select v.id as attachment_version_id, v.attachment_id, v.org_id, a.subject_table, a.subject_id, v.version_number,
  v.scan_status, lr.decision, lr.note, lr.created_at as reviewed_at, lr.created_by as reviewer_person_id,
  v.id = (select c.id from app.attachment_versions c
          where c.attachment_id = v.attachment_id and c.deleted_at is null and c.scan_status = 'Clean'
          order by c.version_number desc limit 1) as is_current
from app.attachment_versions v
join app.attachments a on a.id = v.attachment_id and a.deleted_at is null
left join lateral (
  select r.decision, r.note, r.created_at, r.created_by from app.attachment_version_reviews r
  where r.attachment_version_id = v.id
  order by r.created_at desc, r.id desc limit 1
) lr on true
where v.deleted_at is null;

call private.describe('app.attachment_review_status', 'Where each live file version stands (G-268, ADR 0153 D6): its latest review, if any, and whether it is the attachment''s current version, the newest Clean one. Runs as the reader, so the attachments'' row level security applies.', array[
  'attachment_version_id', 'File version.',
  'attachment_id', 'File the version belongs to.',
  'org_id', 'Org.',
  'subject_table', 'Table of the file''s subject.',
  'subject_id', 'Row the file is attached to.',
  'version_number', 'Version number within the file.',
  'scan_status', 'Virus-scan state; only a Clean version is reviewed.',
  'decision', 'Latest decision on the version; NULL while unreviewed.',
  'note', 'Note of the latest review.',
  'reviewed_at', 'When the latest review was made.',
  'reviewer_person_id', 'Who made the latest review.',
  'is_current', 'True for the newest Clean version of the file.'
]);
revoke all on app.attachment_review_status from public, anon;
grant select on app.attachment_review_status to authenticated, service_role;
revoke select on app.attachment_review_status from xos_backup;

-- Submittal approval waits for its files ------------------------------------------------------------------------------------------
-- Restated from 0492_submittals_sponsor_assets.sql, its only definition, with the file check before Approved.

create or replace function app.transition_submittal(p_submittal_id uuid, p_expected app.review_state, p_next app.review_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.submittals;
  v_entry uuid;
begin
  select * into v_row from app.submittals s where s.id = p_submittal_id and s.deleted_at is null for update;
  if v_row.id is null or not private.can_on_project(v_row.project_id, 'procurement.po.write') then
    raise exception using errcode = '42501', message = 'procurement.po.write is required on the project';
  end if;
  if p_next in ('Approved', 'Returned') then
    perform private.assert_separation('sod_approval_requester', v_person, v_row.created_by);
  end if;
  -- B14 (G-268): no approval while a live file's current version stands at Changes Requested.
  if p_next = 'Approved' and exists (
      select 1 from app.attachments a
      cross join lateral (
        select c.id from app.attachment_versions c
        where c.attachment_id = a.id and c.deleted_at is null and c.scan_status = 'Clean'
        order by c.version_number desc limit 1) cv
      cross join lateral (
        select r.decision from app.attachment_version_reviews r
        where r.attachment_version_id = cv.id
        order by r.created_at desc, r.id desc limit 1) lr
      where a.subject_table = 'app.submittals' and a.subject_id = v_row.id and a.deleted_at is null
        and lr.decision = 'Changes Requested') then
    perform private.refuse('submittal_files_changes_requested', 'A file of this submittal needs changes; review its newest version first.');
  end if;
  v_entry := private.transition_lifecycle('submittal', 'app.submittals', 'submittal_state', 'app.submittal_state_transitions',
    'submittal_id', p_submittal_id, p_expected::text, p_next::text, p_reason);
  perform private.begin_trusted_operation('submittal_review');
  if p_next in ('Approved', 'Returned') then
    update app.submittals set decided_by = v_person, decided_at = now() where id = p_submittal_id;
  elsif p_expected = 'Returned' and p_next = 'Submitted' then
    update app.submittals set revision = revision + 1 where id = p_submittal_id;
  end if;
  perform private.end_trusted_operation('submittal_review');
  return v_entry;
end;
$$;

comment on function app.transition_submittal(uuid, app.review_state, app.review_state, text) is 'Submits, approves, returns or cancels a submittal with compare-and-set: procurement.po.write on the project; approving or returning is never done by the person who created it (sod_approval_requester); approving is refused while a live file''s current version stands at Changes Requested (submittal_files_changes_requested, B14); resubmitting after a return raises the revision.';
revoke all on function app.transition_submittal(uuid, app.review_state, app.review_state, text) from public, anon;
grant execute on function app.transition_submittal(uuid, app.review_state, app.review_state, text) to authenticated, service_role;

-- The vendor's view of its files -----------------------------------------------------------------------------------------------------

create view api_external.submittal_files as
select s.id as submittal_id, a.id as attachment_id, a.title, v.version_number, v.filename, v.uploaded_at,
  lr.decision, lr.note as review_comment
from app.submittals s
join app.attachments a on a.subject_table = 'app.submittals' and a.subject_id = s.id and a.deleted_at is null
  and a.classification not in ('Confidential', 'Restricted')
join app.attachment_versions v on v.attachment_id = a.id and v.deleted_at is null and v.scan_status = 'Clean'
left join lateral (
  select r.decision, r.note from app.attachment_version_reviews r
  where r.attachment_version_id = v.id
  order by r.created_at desc, r.id desc limit 1
) lr on true
where s.deleted_at is null and s.submittal_state <> 'Canceled' and private.vendor_side_open(s.project_id, s.vendor_id);

call private.describe('api_external.submittal_files', 'Files of the submittals the org asked of the caller''s vendor account (G-268, ADR 0153 D6), in the scope of api_external.submittals: each Clean version of a live file that is not Confidential or Restricted, with its latest review''s decision and note. Who reviewed never appears, nor the stored object or any download path.', array[
  'submittal_id', 'Submittal the file is on.',
  'attachment_id', 'File.',
  'title', 'Display name of the file.',
  'version_number', 'Version number within the file.',
  'filename', 'File name of the version as uploaded.',
  'uploaded_at', 'When the version was uploaded.',
  'decision', 'Latest review decision, Approved or Changes Requested; NULL while unreviewed.',
  'review_comment', 'What the org asked to change, or its comment on approval; meant for the vendor, unlike an internal note.'
]);
revoke all on api_external.submittal_files from public, anon;
grant select on api_external.submittal_files to authenticated, service_role;

select private.sync_trash_tables();
