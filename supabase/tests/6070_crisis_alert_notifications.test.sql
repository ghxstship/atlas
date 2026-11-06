-- pgTAP: migration 6070. Announcing a crisis alert tells the people on the project through private.notify and records how
-- many it reached, honestly: clocked-in people are counted apart, whoever announces is left out, a person with every
-- channel off is not counted, and an alert only its issuer could receive reads as zero. The all-clear tells the same people.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(30);

create function pg_temp.notes(p_person text, p_kind text, p_alert uuid) returns integer
language sql as $$
  select count(*)::integer from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = p_kind and n.subject_id = p_alert
$$;
create temporary table a (key text primary key, id uuid, told integer, on_site integer);
grant select, insert on a to public;

-- Who is where: dave is clocked in on the project, inside his own quiet hours. Ivy is engaged and on no time entry.
-- Gina is a Viewer of the org outside the project.
select pg_temp.as_platform();
insert into app.time_entries (org_id, project_id, membership_id, clock_in)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), now() - interval '1 hour');
insert into app.notification_settings (membership_id, time_zone, quiet_hours_start, quiet_hours_end)
values (pg_temp.id('dave@org_a'), 'UTC', ((now() at time zone 'UTC') - interval '1 hour')::time, ((now() at time zone 'UTC') + interval '10 hours')::time);
select pg_temp.as_user('alice');
select app.transition_engagement(pg_temp.id('eng_ivy_a'), 'Onboarding', 'Active', 'Starts now.');

-- Mia is not on the project but has a published shift on it starting within the hour.
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('mia@org_a'), '0000.50.01', now() + interval '1 hour', now() + interval '9 hours', 'America/New_York') returning id)
select app.publish_shifts(array(select id from x));

-- Announcing ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (
  insert into app.crisis_alerts (project_id, emergency_code, message, people_told, people_told_on_site)
  values (pg_temp.id('prj_a'), 'CODE_RED', 'Clear the north lawn.', 999, 999)
  returning id, people_told, people_told_on_site)
insert into a select 'alert', id, people_told, people_told_on_site from x;
select pg_temp.as_platform();

select isnt((select told from a where key = 'alert'), 999, 'the caller never sets what an alert reached');
select is((select told from a where key = 'alert'),
  (select count(*)::integer from app.notifications n where n.kind = 'crisis_alert.issued' and n.subject_id = (select id from a where key = 'alert')),
  'the alert returns how many it told, as the insert''s result');
select is((select on_site from a where key = 'alert'), 1, 'and how many of them were clocked in');
select is((select c.people_told from app.crisis_alerts c where c.id = (select id from a where key = 'alert')),
  (select told from a where key = 'alert'), 'and keeps it on the row');
select is(pg_temp.notes('dave', 'crisis_alert.issued', (select id from a where key = 'alert')), 1, 'someone clocked in is told, once');
select is(pg_temp.notes('frank', 'crisis_alert.issued', (select id from a where key = 'alert')), 1, 'a project member not clocked in is told');
select is(pg_temp.notes('ivy', 'crisis_alert.issued', (select id from a where key = 'alert')), 1, 'an engaged external person is told');
select is(pg_temp.notes('mia', 'crisis_alert.issued', (select id from a where key = 'alert')), 1, 'someone on a shift starting soon is told');
select is(pg_temp.notes('alice', 'crisis_alert.issued', (select id from a where key = 'alert')), 1, 'an org-wide dispatcher is told');
select is(pg_temp.notes('carol', 'crisis_alert.issued', (select id from a where key = 'alert')), 0, 'whoever announced is not');
select is(pg_temp.notes('gina', 'crisis_alert.issued', (select id from a where key = 'alert')), 0, 'nor is an org member with no part in the project');
select is(pg_temp.notes('xavier', 'crisis_alert.issued', (select id from a where key = 'alert')), 0, 'nor another org');
select is(pg_temp.notes('quinn', 'crisis_alert.issued', (select id from a where key = 'alert')), 0, 'nor another org''s engaged party');

select is((select n.message_args - 'actorName' from app.notifications n
    where n.recipient_person_id = pg_temp.id('dave') and n.kind = 'crisis_alert.issued' and n.subject_id = (select id from a where key = 'alert')),
  jsonb_build_object('title', coalesce(
      (select c.label from app.emergency_codes c where c.org_id = pg_temp.id('org_a') and c.code = 'CODE_RED' and c.deleted_at is null),
      (select c.label from xpms.emergency_code c where c.code = 'CODE_RED')),
    'project', 'Northwind Summer Series', 'message', 'Clear the north lawn.'),
  'the notification carries the code, the project and the announcement');
select ok((select bool_and(d.message_status = 'Queued') from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id
    where n.recipient_person_id = pg_temp.id('dave') and n.kind = 'crisis_alert.issued'),
  'it goes at once, inside quiet hours');
select is((select array_agg(d.channel::text order by d.channel::text) from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id
    where n.recipient_person_id = pg_temp.id('frank') and n.kind = 'crisis_alert.issued'),
  array['Email', 'Push'], 'by the channels the system already uses, push included');
select is((select array_agg(d.channel::text order by d.channel::text) from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id
    where n.recipient_person_id = pg_temp.id('ivy') and n.kind = 'crisis_alert.issued'),
  array['Email', 'Push'], 'and an external person gets their email and push too');

-- What was reached stays as recorded ------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
update app.crisis_alerts set people_told = 0, message = 'Clear the north lawn now.' where id = (select id from a where key = 'alert');
select pg_temp.as_platform();
select is((select c.people_told from app.crisis_alerts c where c.id = (select id from a where key = 'alert')),
  (select told from a where key = 'alert'), 'an update cannot rewrite what an alert reached');

-- A person with every channel of the category off is not counted --------------------------------------------------------
select pg_temp.as_user('frank');
select app.set_my_notification_preferences(pg_temp.id('org_a'),
  '[{"category": "safety", "channel": "In App", "enabled": false},
    {"category": "safety", "channel": "Email", "enabled": false},
    {"category": "safety", "channel": "Push", "enabled": false}]'::jsonb);
select pg_temp.as_user('carol');
with x as (
  insert into app.crisis_alerts (project_id, emergency_code, message) values (pg_temp.id('prj_a'), 'CODE_RED', 'Second drill.')
  returning id, people_told, people_told_on_site)
insert into a select 'second', id, people_told, people_told_on_site from x;
select pg_temp.as_platform();
select is((select told from a where key = 'second'), (select told from a where key = 'alert') - 1,
  'someone who turned every safety channel off is not counted as told');

-- All-clear -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.crisis_alerts set ended_at = now() where id = (select id from a where key = 'alert');
select pg_temp.as_platform();
select is(pg_temp.notes('dave', 'crisis_alert.ended', (select id from a where key = 'alert')), 1, 'the all-clear tells who was told of the alert');
select is(pg_temp.notes('ivy', 'crisis_alert.ended', (select id from a where key = 'alert')), 1, 'external people too');
select is(pg_temp.notes('carol', 'crisis_alert.ended', (select id from a where key = 'alert')), 1, 'and whoever announced it');
select is(pg_temp.notes('alice', 'crisis_alert.ended', (select id from a where key = 'alert')), 0, 'but not whoever gave it');
select is((select n.message_args - 'actorName' from app.notifications n
    where n.recipient_person_id = pg_temp.id('dave') and n.kind = 'crisis_alert.ended' and n.subject_id = (select id from a where key = 'alert')),
  jsonb_build_object('title', coalesce(
      (select c.label from app.emergency_codes c where c.org_id = pg_temp.id('org_a') and c.code = 'CODE_RED' and c.deleted_at is null),
      (select c.label from xpms.emergency_code c where c.code = 'CODE_RED')),
    'project', 'Northwind Summer Series'),
  'naming the code and the project');

-- An alert already over, such as a seed or history, tells nobody ----------------------------------------------------------
select pg_temp.as_user('carol');
with x as (
  insert into app.crisis_alerts (project_id, emergency_code, message, issued_at, ended_at)
  values (pg_temp.id('prj_a'), 'CODE_RED', 'History.', now() - interval '2 days', now() - interval '1 day')
  returning id, people_told, people_told_on_site)
insert into a select 'history', id, people_told, people_told_on_site from x;
select pg_temp.as_platform();
select is((select told from a where key = 'history'), null::integer, 'an alert written as already ended records no reach');
select is((select count(*)::integer from app.notifications n where n.subject_id = (select id from a where key = 'history')), 0, 'and tells nobody');

-- Nobody to tell: Xavier alone on Harbor Lights, the alert is recorded and reads as zero ------------------------------------
select pg_temp.as_platform();
update app.memberships set deleted_at = now() where org_id = pg_temp.id('org_b') and person_id <> pg_temp.id('xavier');
update app.engagements set deleted_at = now() where project_id = pg_temp.id('prj_b');
select pg_temp.as_user('xavier');
with x as (
  insert into app.crisis_alerts (project_id, emergency_code, message) values (pg_temp.id('prj_b'), 'CODE_RED', 'Nobody here.')
  returning id, people_told, people_told_on_site)
insert into a select 'nobody', id, people_told, people_told_on_site from x;
select pg_temp.as_platform();
select is((select told from a where key = 'nobody'), 0, 'an alert with nobody else to tell records zero');
select is((select on_site from a where key = 'nobody'), 0, 'and zero on site');

-- Refused, it tells nobody -------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$insert into app.crisis_alerts (project_id, emergency_code, message) values (pg_temp.id('prj_a'), 'CODE_RED', 'Not allowed.')$$,
  '42501', null, 'a person without dispatch cannot announce');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications n where n.message_args ->> 'message' = 'Not allowed.'), 0, 'and nothing was sent');

select * from finish();
rollback;
