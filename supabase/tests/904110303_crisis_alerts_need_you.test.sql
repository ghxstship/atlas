-- pgTAP: a crisis alert in force sits in the Inbox's Needs You (crawl 4.9, 904110303). Carol announces a Code Red on
-- prj_a, which tells frank (a project member): his crisis_alert.issued is Needs You. Once the all-clear reaches him, it
-- and the all-clear are For Your Information. Routine kinds keep their sections, and nobody sees another's items.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

select pg_temp.as_user('carol');
with x as (insert into app.crisis_alerts (project_id, emergency_code, message)
  values (pg_temp.id('prj_a'), 'CODE_RED', 'Clear the north lawn.') returning id)
insert into world select 'alert', id from x;

select pg_temp.as_user('frank');
select is((select count(*)::int from app.inbox_items i where i.kind = 'crisis_alert.issued' and i.subject_id = pg_temp.id('alert')), 1,
  'frank is told of the alert in his Inbox');
select is((select i.section from app.inbox_items i where i.kind = 'crisis_alert.issued' and i.subject_id = pg_temp.id('alert')),
  'Needs You', 'and it needs him while it is in force');

select pg_temp.as_user('dave');
select is((select i.section from app.inbox_items i where i.kind = 'crisis_alert.issued' and i.subject_id = pg_temp.id('alert')),
  'Needs You', 'as it needs every person it told');

select pg_temp.as_user('carol');
update app.crisis_alerts set ended_at = now() where id = pg_temp.id('alert');

select pg_temp.as_user('frank');
select is((select i.section from app.inbox_items i where i.kind = 'crisis_alert.issued' and i.subject_id = pg_temp.id('alert')),
  'For Your Information', 'once the all-clear reaches him, the alert is for his information');
select is((select i.section from app.inbox_items i where i.kind = 'crisis_alert.ended' and i.subject_id = pg_temp.id('alert')),
  'For Your Information', 'and so is the all-clear');

-- Routine sections are unchanged: an assignment still needs the person.
select pg_temp.as_platform();
insert into app.notifications (org_id, recipient_person_id, kind, message_args)
values (pg_temp.id('org_a'), pg_temp.id('frank'), 'assignment.created', '{"title": "Hang truss"}');
select pg_temp.as_user('frank');
select is((select i.section from app.inbox_items i where i.kind = 'assignment.created'), 'Needs You',
  'an assignment still needs the person');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.inbox_items i where i.subject_id = pg_temp.id('alert')), 0,
  'another org sees none of it');

select * from finish();
rollback;
