-- 2743_advance_tracks.sql
-- R11 Status tracks per advance with sign-off (RRR-192; parity gap G-176, ADR 0100 and 0103). A packet's sections are
-- grouped into tracks (Finance, Technical, Hospitality, Catering, Travel, Logistics, General), and a reviewer signs off a
-- recipient's track once every section on it is done. The sign-off is a fact (who and when); the track's state is
-- computed and never stored.
--
--   1. app.advance_track and app.advance_sections.track (General by default). A grouping label: it stays editable
--      after send, so R9's private.guard_advance_section is unchanged. api_external.advance_sections (R9's 2714)
--      appends it.
--   2. app.advance_track_signoffs: one live sign-off per recipient and track, written only by the RPCs below; a
--      revocation keeps the row with its reason. The signer is the row's created_by; the revoker is in the audit trail.
--   3. app.advance_track_progress (security_invoker): one row per live sent packet, recipient and track with a live
--      section, with its counts and track_state (Not Started, In Progress, Ready for Sign-off, Signed Off, Reopened).
--   4. api_external.advance_track_progress: the caller's own recipients' tracks for Gateway, without reviewer names.
--   5. app.sign_off_advance_track and app.revoke_advance_track_signoff, for holders of advancing.submission.review.
-- No notification kind is added.

-- 1. Tracks -------------------------------------------------------------------------------------------------------------------

create type app.advance_track as enum ('Finance', 'Technical', 'Hospitality', 'Catering', 'Travel', 'Logistics', 'General');
comment on type app.advance_track is 'The track an advance section belongs to (R11, G-176): Finance, Technical, Hospitality, Catering, Travel, Logistics or General. A reviewer signs off each recipient''s track once every section on it is done.';

alter table app.advance_sections add column track app.advance_track not null default 'General';
comment on column app.advance_sections.track is 'Track the section is grouped under, General by default (R11). A grouping label that stays editable after the packet is sent.';

create index advance_sections_track_idx on app.advance_sections (advance_packet_id, track) where deleted_at is null;

create or replace view api_external.advance_sections as
select s.id, s.advance_packet_id, s.position, s.title, s.prompt, s.section_kind, s.window_kind, s.max_lines, s.per_person,
  s.track
from app.advance_sections s
where s.deleted_at is null and s.advance_packet_id in (select x.id from api_external.advance_packets x);

call private.describe('api_external.advance_sections', 'Sections of the caller''s advance packets.', array[
  'id', 'Section.', 'advance_packet_id', 'Packet.', 'position', 'Order.', 'title', 'Title.', 'prompt', 'What is asked.',
  'section_kind', 'Text, File, Schedule Window, Item Request, Crew Roster, Guest List or Credential Request (R9).',
  'window_kind', 'What a Schedule Window section asks the time of.',
  'max_lines', 'Most files, windows or lines one answer may hold.',
  'per_person', 'True when every item or credential line names one person on the roster.',
  'track', 'Finance, Technical, Hospitality, Catering, Travel, Logistics or General (R11).']);

revoke all on api_external.advance_sections from public, anon;
grant select on api_external.advance_sections to authenticated, service_role;

-- 2. Sign-offs ----------------------------------------------------------------------------------------------------------------

create table app.advance_track_signoffs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_recipient_id uuid not null references app.advance_recipients (id),
  track app.advance_track not null,
  signed_off_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text,
  deleted_at timestamptz,
  constraint advance_track_signoffs_revoke_pair check ((revoked_at is null) = (revoke_reason is null)),
  constraint advance_track_signoffs_revoke_reason check (revoke_reason is null or char_length(btrim(revoke_reason)) between 1 and 500),
  constraint advance_track_signoffs_revoked_after check (revoked_at is null or revoked_at >= signed_off_at)
);

create index advance_track_signoffs_recipient_idx on app.advance_track_signoffs (advance_recipient_id);
create unique index advance_track_signoffs_live_key on app.advance_track_signoffs (advance_recipient_id, track)
  where revoked_at is null and deleted_at is null;

call private.install_domain_table('app.advance_track_signoffs', 'app.advance_recipients', 'advance_recipient_id');
call private.install_policies('app.advance_track_signoffs',
  $$advance_recipient_id in (select r.id from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
    where p.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
revoke insert, update, delete on app.advance_track_signoffs from authenticated;
call private.describe('app.advance_track_signoffs', 'A reviewer''s sign-off of one recipient''s track of an advance packet (R11, G-176): every section on the track was done when it was signed. The signer is created_by and the time signed_off_at; a revocation keeps the row with its reason, and whoever revoked it is in the audit trail. Written only by app.sign_off_advance_track and app.revoke_advance_track_signoff; the track''s state is computed in app.advance_track_progress.', array[
  'advance_recipient_id', 'Recipient whose track was signed off.',
  'track', 'Track signed off.',
  'signed_off_at', 'When it was signed off.',
  'revoked_at', 'When the sign-off was revoked; NULL while it stands.',
  'revoke_reason', 'Why it was revoked, 1 to 500 characters; set with revoked_at and only then.'
]);
call private.install_audit_trail('app.advance_track_signoffs');
call private.install_default_retention('app.advance_track_signoffs');

create or replace function private.guard_advance_track_signoff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('advance_track_signoff') then
    perform private.refuse('advance_track_signoff_internal', 'Sign off a track with app.sign_off_advance_track and revoke it with app.revoke_advance_track_signoff.');
  end if;
  if tg_op = 'UPDATE' and (new.advance_recipient_id <> old.advance_recipient_id or new.track <> old.track
      or new.signed_off_at <> old.signed_off_at or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)) then
    perform private.refuse('advance_track_signoff_fixed', 'A sign-off keeps its recipient, track and time, and a revoked one stays revoked.');
  end if;
  return new;
end;
$$;

comment on function private.guard_advance_track_signoff() is 'A track sign-off is written only inside app.sign_off_advance_track and app.revoke_advance_track_signoff (trusted operation advance_track_signoff); it keeps its recipient, track and time, and a revoked one stays revoked.';
revoke all on function private.guard_advance_track_signoff() from public, anon, authenticated;

create trigger t40_guard_advance_track_signoff before insert or update on app.advance_track_signoffs
  for each row execute function private.guard_advance_track_signoff();

insert into private.domain_event_types (code, subject, description) values
  ('advance_track.signed_off', 'advance_track_signoffs', 'A reviewer signed off a recipient''s track of an advance packet.')
on conflict (code) do nothing;

create trigger t90_emit_advance_track_signed_off after insert on app.advance_track_signoffs
  for each row execute function private.emit_row_event('advance_track.signed_off', '-', 'advance_recipient_id', 'track');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('advance_track_signoffs', 'A sign-off is revoked with a reason, never deleted and restored')
on conflict (table_name) do nothing;

-- The Tracks pane follows sign-offs live (as 1450 and 2740).
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables p
                     where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = 'advance_track_signoffs') then
    alter publication supabase_realtime add table app.advance_track_signoffs;
  end if;
end $$;

-- 3. Track progress -----------------------------------------------------------------------------------------------------------

create view app.advance_track_progress with (security_invoker = on) as
with cells as (
  select g.org_id, g.project_id, g.advance_packet_id, g.advance_recipient_id, g.recipient_label, s.track,
    g.cell_state, g.latest_submission_id, g.submitted_at, g.overdue,
    g.cell_state in ('Accepted', 'Complete', 'Not Applicable') as done
  from app.advance_progress g
  join app.advance_sections s on s.id = g.advance_section_id
),
tracks as (
  select c.org_id, c.project_id, c.advance_packet_id, c.advance_recipient_id, c.recipient_label, c.track,
    count(*)::integer as sections_total,
    count(*) filter (where c.done)::integer as sections_done,
    bool_or(c.overdue) as overdue,
    bool_and(c.cell_state = 'Not Applicable' or (c.cell_state = 'Missing' and c.latest_submission_id is null)) as untouched,
    bool_or(c.cell_state <> 'Not Applicable') as applicable,
    max(c.submitted_at) as last_submitted_at
  from cells c
  group by c.org_id, c.project_id, c.advance_packet_id, c.advance_recipient_id, c.recipient_label, c.track
)
select t.org_id, t.project_id, t.advance_packet_id, t.advance_recipient_id, t.recipient_label, t.track,
  t.sections_total, t.sections_done, t.sections_total - t.sections_done as sections_outstanding, t.overdue,
  o.id as signoff_id, o.signed_off_at, private.advance_party_label(t.project_id, o.created_by, null) as signed_off_by_name,
  case
    when o.id is not null and t.sections_done = t.sections_total
      and (t.last_submitted_at is null or t.last_submitted_at <= o.signed_off_at) then 'Signed Off'
    when o.id is not null then 'Reopened'
    when t.sections_done = t.sections_total then 'Ready for Sign-off'
    when t.untouched and t.applicable then 'Not Started'
    else 'In Progress'
  end as track_state
from tracks t
left join app.advance_track_signoffs o on o.advance_recipient_id = t.advance_recipient_id and o.track = t.track
  and o.revoked_at is null and o.deleted_at is null;

call private.describe('app.advance_track_progress', 'Where each recipient of a sent advance packet stands on each track (R11, G-176): one row per live sent packet, recipient and track with a live section, from app.advance_progress and the live sign-off. track_state is computed, never stored. Runs with the caller''s policies; the signer''s name is read for readers of the project''s packets only.', array[
  'org_id', 'Org that sent the packet.',
  'project_id', 'Project of the packet.',
  'advance_packet_id', 'Packet.',
  'advance_recipient_id', 'Recipient.',
  'recipient_label', 'The recipient''s name.',
  'track', 'Track.',
  'sections_total', 'Live sections on the track.',
  'sections_done', 'Sections Accepted, Complete or Not Applicable.',
  'sections_outstanding', 'Sections not done yet.',
  'overdue', 'True when a section on the track is overdue.',
  'signoff_id', 'The live sign-off; NULL when none stands.',
  'signed_off_at', 'When the track was signed off.',
  'signed_off_by_name', 'Who signed it off.',
  'track_state', 'Not Started (every section that applies is Missing with no answer), In Progress, Ready for Sign-off (every section done, no sign-off), Signed Off (signed off, every section done, no answer after it), or Reopened (signed off, but a section is no longer done or a newer answer arrived).'
]);

revoke all on app.advance_track_progress from public, anon;
grant select on app.advance_track_progress to authenticated, service_role;
revoke select on app.advance_track_progress from xos_backup;

-- 4. Gateway --------------------------------------------------------------------------------------------------------------------

create view api_external.advance_track_progress as
select t.advance_recipient_id, t.advance_packet_id, t.track, t.sections_total, t.sections_done, t.track_state, t.signed_off_at
from app.advance_track_progress t
where t.advance_recipient_id in (select x.id from api_external.my_advance_recipients x);

call private.describe('api_external.advance_track_progress', 'Where the caller''s advance recipients stand on each track (R11, G-176): the same recipients as api_external.my_advance_recipients (Section 8.7), with the computed state and when a track was signed off. Who signed off never appears.', array[
  'advance_recipient_id', 'Recipient.', 'advance_packet_id', 'Packet.', 'track', 'Track.',
  'sections_total', 'Sections on the track.', 'sections_done', 'Sections done.',
  'track_state', 'Not Started, In Progress, Ready for Sign-off, Signed Off or Reopened.',
  'signed_off_at', 'When the track was signed off; NULL when it is not.']);

revoke all on api_external.advance_track_progress from public, anon;
grant select on api_external.advance_track_progress to authenticated, service_role;

-- 5. Signing off ----------------------------------------------------------------------------------------------------------------

create or replace function app.sign_off_advance_track(p_recipient_id uuid, p_track app.advance_track)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient app.advance_recipients;
  v_packet app.advance_packets;
  v_total integer;
  v_done integer;
  v_id uuid;
begin
  perform private.require_person();
  select r.* into v_recipient from app.advance_recipients r where r.id = p_recipient_id and r.deleted_at is null;
  select p.* into v_packet from app.advance_packets p where p.id = v_recipient.advance_packet_id and p.deleted_at is null;
  if v_recipient.id is null or v_packet.id is null
     or not private.can_on_project(v_packet.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'this track is not yours to sign off';
  end if;
  if v_packet.sent_at is null then
    perform private.refuse('advance_packet_unsent', 'Send the packet before signing off its tracks.');
  end if;
  select count(*)::integer, count(*) filter (where g.cell_state in ('Accepted', 'Complete', 'Not Applicable'))::integer
  into v_total, v_done
  from app.advance_progress g join app.advance_sections s on s.id = g.advance_section_id
  where g.advance_recipient_id = v_recipient.id and s.track = p_track;
  if v_total = 0 then
    perform private.refuse('advance_track_empty', 'No section of the packet is on this track.');
  end if;
  if exists (select 1 from app.advance_track_signoffs o where o.advance_recipient_id = v_recipient.id and o.track = p_track
             and o.revoked_at is null and o.deleted_at is null) then
    perform private.refuse('advance_track_signed_off', 'This track is signed off already; revoke the sign-off to sign it again.');
  end if;
  if v_done < v_total then
    perform private.refuse('advance_track_incomplete', 'Every section on the track must be accepted, complete or not applicable first.');
  end if;
  perform private.begin_trusted_operation('advance_track_signoff');
  begin
    insert into app.advance_track_signoffs (advance_recipient_id, track) values (v_recipient.id, p_track) returning id into v_id;
  exception when unique_violation then
    perform private.end_trusted_operation('advance_track_signoff');
    perform private.refuse('advance_track_signed_off', 'This track is signed off already; revoke the sign-off to sign it again.');
  end;
  perform private.end_trusted_operation('advance_track_signoff');
  return v_id;
end;
$$;

comment on function app.sign_off_advance_track(uuid, app.advance_track) is 'A reviewer with advancing.submission.review on the project signs off one recipient''s track of a sent packet (R11, G-176), once every live section on it is Accepted, Complete or Not Applicable. Refuses advance_packet_unsent, advance_track_empty (no live section on the track), advance_track_signed_off (a live sign-off stands) and advance_track_incomplete; 42501 without the capability. Returns the sign-off id.';
revoke all on function app.sign_off_advance_track(uuid, app.advance_track) from public, anon;
grant execute on function app.sign_off_advance_track(uuid, app.advance_track) to authenticated, service_role;

create or replace function app.revoke_advance_track_signoff(p_signoff_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_signoff app.advance_track_signoffs;
  v_project uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_person();
  select o.* into v_signoff from app.advance_track_signoffs o
  where o.id = p_signoff_id and o.revoked_at is null and o.deleted_at is null;
  select p.project_id into v_project from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
  where r.id = v_signoff.advance_recipient_id;
  if v_signoff.id is null or v_project is null or not private.can_on_project(v_project, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'this sign-off is not yours to revoke';
  end if;
  if char_length(v_reason) not between 1 and 500 then
    perform private.refuse('advance_track_revoke_reason', 'Say why the sign-off is revoked, in 1 to 500 characters.');
  end if;
  perform private.begin_trusted_operation('advance_track_signoff');
  update app.advance_track_signoffs set revoked_at = now(), revoke_reason = v_reason where id = v_signoff.id;
  perform private.end_trusted_operation('advance_track_signoff');
end;
$$;

comment on function app.revoke_advance_track_signoff(uuid, text) is 'A reviewer with advancing.submission.review on the project revokes a live track sign-off with a reason of 1 to 500 characters (advance_track_revoke_reason) (R11, G-176); the row stays, and the track can be signed off again. 42501 without the capability or for a sign-off already revoked.';
revoke all on function app.revoke_advance_track_signoff(uuid, text) from public, anon;
grant execute on function app.revoke_advance_track_signoff(uuid, text) to authenticated, service_role;

select private.sync_trash_tables();
