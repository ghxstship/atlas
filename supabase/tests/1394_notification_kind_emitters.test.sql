-- pgTAP: migration 1394, emitters for shift.assigned, shift.changed, incident.reported and assignment.created
-- (RRR-125, ADR 0033 decision 35). Publishing a shift, reassigning it or approving a claim on it tells its worker;
-- moving a published shift tells its worker, at once during quiet hours when it starts within 12 hours; a new
-- incident tells the project's dispatchers at once; assigning a member to a record tells them. Quiet hours are set
-- relative to now in UTC, so the suite never depends on the clock.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(24);

create function pg_temp.notes(p_person text, p_kind text) returns integer
language sql as $$
  select count(*)::integer from app.notifications n where n.recipient_person_id = pg_temp.id(p_person) and n.kind = p_kind
$$;
create function pg_temp.latest(p_person text, p_kind text) returns app.notifications
language sql as $$
  select n.* from app.notifications n where n.recipient_person_id = pg_temp.id(p_person) and n.kind = p_kind
  order by n.created_at desc, n.id desc limit 1
$$;
create function pg_temp.sms_status(p_notification uuid) returns text
language sql as $$
  select d.message_status::text from app.notification_deliveries d where d.notification_id = p_notification and d.channel = 'SMS'
$$;
create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Dave and Bob are inside their own quiet hours (an hour ago to ten hours from now) and take texts.
select pg_temp.as_platform();
update auth.users set phone = '15555550144', phone_confirmed_at = now() where id = pg_temp.id('dave_user');
update auth.users set phone = '15555550145', phone_confirmed_at = now() where id = pg_temp.id('bob_user');
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source) values
  (pg_temp.id('org_a'), pg_temp.id('dave'), '+15555550144', 'Opt In', 'Web'),
  (pg_temp.id('org_a'), pg_temp.id('bob'), '+15555550145', 'Opt In', 'Web');
insert into app.notification_settings (membership_id, time_zone, quiet_hours_start, quiet_hours_end)
select m, 'UTC', ((now() at time zone 'UTC') - interval '1 hour')::time, ((now() at time zone 'UTC') + interval '10 hours')::time
from unnest(array[pg_temp.id('dave@org_a'), pg_temp.id('bob@org_a')]) m;
select pg_temp.as_user('dave');
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[{"category": "schedule", "channel": "SMS", "enabled": true}]'::jsonb);
select pg_temp.as_user('bob');
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[{"category": "safety", "channel": "SMS", "enabled": true}]'::jsonb);

-- Shifts --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '0000.50.01', now() + interval '2 days', now() + interval '2 days 8 hours',
    'America/New_York') returning id)
  insert into k select 'sh1', id from x;
update app.shifts set starts_at = starts_at + interval '1 hour' where id = (select id from k where key = 'sh1');
select pg_temp.as_platform();
select is(pg_temp.notes('dave', 'shift.assigned'), 0, 'a draft shift tells nobody');
select is(pg_temp.notes('dave', 'shift.changed'), 0, 'nor does moving a draft');

select pg_temp.as_user('carol');
select app.publish_shifts(array[(select id from k where key = 'sh1')]);
select pg_temp.as_platform();
select is(pg_temp.notes('dave', 'shift.assigned'), 1, 'publishing a shift tells its worker');
select is((pg_temp.latest('dave', 'shift.assigned')).message_args ->> 'startsAt',
  (select to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from app.shifts s where s.id = (select id from k where key = 'sh1')),
  'with the start as an ISO instant');
select is((pg_temp.latest('dave', 'shift.assigned')).message_args - 'startsAt' - 'endsAt',
  jsonb_build_object('title', (select ro.job_title || ' (Northwind Summer Series)' from xpms.role ro where ro.role_code = '0000.50.01'),
    'actorName', 'Carol Nguyen'),
  'its role and project as the title, and the scheduler as the actor');
select is((pg_temp.latest('dave', 'shift.assigned')).subject_table, 'app.shifts', 'about the shift');

select pg_temp.as_user('carol');
update app.shifts set starts_at = starts_at + interval '30 minutes', ends_at = ends_at + interval '30 minutes'
where id = (select id from k where key = 'sh1');
select pg_temp.as_platform();
select is(pg_temp.notes('dave', 'shift.changed'), 1, 'moving a published shift tells its worker');
select is(pg_temp.sms_status((pg_temp.latest('dave', 'shift.changed')).id), 'Digest',
  'a change to a shift two days away waits out quiet hours');
select pg_temp.as_user('carol');
update app.shifts set starts_at = now() + interval '3 hours', ends_at = now() + interval '11 hours'
where id = (select id from k where key = 'sh1');
select pg_temp.as_platform();
select is(pg_temp.sms_status((pg_temp.latest('dave', 'shift.changed')).id), 'Queued',
  'a change to a shift starting within 12 hours goes at once, inside quiet hours');
select pg_temp.as_user('carol');
update app.shifts set time_zone = 'America/Chicago' where id = (select id from k where key = 'sh1');
select pg_temp.as_platform();
select is(pg_temp.notes('dave', 'shift.changed'), 2, 'an edit that keeps the times tells nobody');

select pg_temp.as_user('carol');
update app.shifts set membership_id = pg_temp.id('frank@org_a') where id = (select id from k where key = 'sh1');
select pg_temp.as_platform();
select is(pg_temp.notes('frank', 'shift.assigned'), 1, 'reassigning a published shift tells the new worker');
select is(pg_temp.notes('dave', 'shift.assigned') + pg_temp.notes('dave', 'shift.changed'), 3, 'and not the one it was taken from');

-- Open shifts: a first-come claim is the claimer's own act; an approved claim is the supervisor's.
select pg_temp.as_user('bob');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.open_shift_claiming', 'Project', pg_temp.id('prj_a'), 'first-come');
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', now() + interval '3 days', now() + interval '3 days 6 hours', 'America/New_York') returning id)
  insert into k select 'open1', id from x;
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', now() + interval '5 days', now() + interval '5 days 6 hours', 'America/New_York') returning id)
  insert into k select 'open2', id from x;
select app.publish_shifts(array[(select id from k where key = 'open1'), (select id from k where key = 'open2')]);
select pg_temp.as_platform();
select is(pg_temp.notes('frank', 'shift.assigned'), 1, 'publishing an open shift tells nobody');
select pg_temp.as_user('frank');
select app.claim_open_shift((select id from k where key = 'open1'));
select pg_temp.as_platform();
select is((select s.membership_id from app.shifts s where s.id = (select id from k where key = 'open1')), pg_temp.id('frank@org_a'),
  'a first-come claim gives frank the shift');
select is(pg_temp.notes('frank', 'shift.assigned'), 1, 'and tells nobody: he claimed it himself');

select pg_temp.as_user('bob');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.open_shift_claiming', 'Project', pg_temp.id('prj_a'), 'approval');
select pg_temp.as_user('frank');
insert into k values ('claim', app.claim_open_shift((select id from k where key = 'open2')));
select pg_temp.as_platform();
select is(pg_temp.notes('frank', 'shift.assigned'), 1, 'a claim waiting for approval tells nobody yet');
select pg_temp.as_user('carol');
select app.decide_shift_claim((select id from k where key = 'claim'), true);
select pg_temp.as_platform();
select is((pg_temp.latest('frank', 'shift.assigned')).subject_id, (select id from k where key = 'open2'),
  'approving the claim tells the claimant the shift is theirs');

select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('carol@org_a'), '0000.50.01', now() + interval '4 days', now() + interval '4 days 6 hours',
    'America/New_York') returning id)
  insert into k select 'own', id from x;
select app.publish_shifts(array[(select id from k where key = 'own')]);
select pg_temp.as_platform();
select is(pg_temp.notes('carol', 'shift.assigned'), 0, 'nobody is told of their own change');

-- Incidents -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at)
  values (pg_temp.id('prj_a'), 'Truss Failure at Stage Left', 'ENM-097', now()) returning id)
  insert into k select 'inc', id from x;
select pg_temp.as_platform();
select is((select count(*)::integer from private.project_member_people_with(pg_temp.id('prj_a'), 'safety.incident.dispatch') d
           where d <> pg_temp.id('dave')
             and (select count(*) from app.notifications n
                  where n.recipient_person_id = d and n.kind = 'incident.reported' and n.subject_id = (select id from k where key = 'inc')) = 1),
  (select count(*)::integer from private.project_member_people_with(pg_temp.id('prj_a'), 'safety.incident.dispatch') d
   where d <> pg_temp.id('dave')),
  'a new incident tells each of the project''s dispatchers once');
select is(pg_temp.notes('dave', 'incident.reported'), 0, 'but not the reporter');
select is((pg_temp.latest('bob', 'incident.reported')).message_args,
  jsonb_build_object('title', 'Truss Failure at Stage Left', 'actorName', 'Dave Lindqvist'), 'naming the incident and its reporter');
select is(pg_temp.sms_status((pg_temp.latest('bob', 'incident.reported')).id), 'Queued', 'and it goes at once, inside quiet hours');

-- Assignments ---------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
with r as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Hang the downstage truss', 'Y', 'Declared') returning id)
  insert into k select 'task', id from r;
select pg_temp.as_user('carol');
insert into app.record_assignments (record_id, membership_id) values
  ((select id from k where key = 'task'), pg_temp.id('frank@org_a')),
  ((select id from k where key = 'task'), pg_temp.id('carol@org_a'));
select pg_temp.as_platform();
select is((select concat_ws('|', n.subject_table, n.subject_id = (select id from k where key = 'task'), n.project_id = pg_temp.id('prj_a'),
                    n.message_args ->> 'title', n.message_args ->> 'actorName')
           from app.notifications n where n.recipient_person_id = pg_temp.id('frank') and n.kind = 'assignment.created'),
  'app.records|t|t|Hang the downstage truss|Carol Nguyen', 'assigning a member to a record tells them who assigned what');
select is(pg_temp.notes('carol', 'assignment.created'), 0, 'assigning oneself tells nobody');

select * from finish();
rollback;
