-- pgTAP: migration 6070. Announcing a crisis alert tells the people on the project through private.notify and records how
-- many it reached, honestly: clocked-in people are counted apart, whoever announces is left out, a person with every
-- channel off or no way to be reached is not counted, and an alert only its issuer could receive reads as zero. The
-- all-clear tells the same people. The alert never depends on the fan-out: what its statement cannot send, or cannot send
-- without an error, waits for the worker, and the counts say so.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(76);

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

-- A count means a channel that can actually go -------------------------------------------------------------------------
-- Erin has In App and Email off and Push on, with no device: the push would be suppressed at send time.
create function pg_temp.safety_channels(p_who text, p_in_app boolean, p_email boolean, p_push boolean) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  perform app.set_my_notification_preferences(pg_temp.id('org_a'), jsonb_build_array(
    jsonb_build_object('category', 'safety', 'channel', 'In App', 'enabled', p_in_app),
    jsonb_build_object('category', 'safety', 'channel', 'Email', 'enabled', p_email),
    jsonb_build_object('category', 'safety', 'channel', 'Push', 'enabled', p_push)));
  perform pg_temp.as_platform();
end $$;
create function pg_temp.drill(p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user('carol');
  with x as (
    insert into app.crisis_alerts (project_id, emergency_code, message) values (pg_temp.id('prj_a'), 'CODE_RED', p_key)
    returning id, people_told, people_told_on_site)
  insert into a select p_key, id, people_told, people_told_on_site from x;
  perform pg_temp.as_platform();
end $$;
create function pg_temp.told(p_key text) returns integer
language sql as $$ select a.told from a where a.key = p_key $$;

-- Frank turned everything off above; from here he has it all on again.
select pg_temp.safety_channels('frank', true, true, true);
select pg_temp.drill('base');
select pg_temp.safety_channels('erin', false, false, true);
select pg_temp.drill('no_device');
select is(pg_temp.told('no_device'), pg_temp.told('base') - 1, 'a push with no registered device does not count as telling someone');
select pg_temp.as_platform();
insert into app.push_subscriptions (org_id, membership_id, expo_push_token, platform)
values (pg_temp.id('org_a'), pg_temp.id('erin@org_a'), 'ExponentPushToken[abcdefghijklmnopqrstuv]', 'ios');
select pg_temp.drill('with_device');
select is(pg_temp.told('with_device'), pg_temp.told('base'), 'once a device is registered it does');

-- Dave has only email on, to an address that hard-bounced.
select pg_temp.safety_channels('dave', false, true, false);
select pg_temp.as_platform();
insert into app.suppression_list (org_id, channel, address, reason)
values (pg_temp.id('org_a'), 'Email', 'dave@northwind.test', 'Hard Bounce');
select pg_temp.drill('bounced');
select is(pg_temp.told('bounced'), pg_temp.told('base') - 1, 'an email to a suppressed address does not count');
-- Dave then unsubscribes from all mail: the notification email is not transactional, so the claim suppresses it.
update app.suppression_list set lifted_at = now() where address = 'dave@northwind.test';
insert into app.suppression_list (org_id, channel, address, reason)
values (pg_temp.id('org_a'), 'Email', 'dave@northwind.test', 'Unsubscribe');
select pg_temp.drill('unsubscribed');
select is(pg_temp.told('unsubscribed'), pg_temp.told('base') - 1, 'nor does an email to someone who unsubscribed from all mail');
select pg_temp.safety_channels('dave', true, true, true);
update app.suppression_list set lifted_at = now() where address = 'dave@northwind.test';

-- An engaged external person's Inbox row cannot be turned off, so it is what reaches them with Email and Push off.
insert into app.person_notification_preferences (person_id, category_code, channel, enabled)
values (pg_temp.id('ivy'), 'safety', 'Email', false), (pg_temp.id('ivy'), 'safety', 'Push', false);
select pg_temp.drill('ivy_off');
select is(pg_temp.notes('ivy', 'crisis_alert.issued', (select id from a where key = 'ivy_off')), 1, 'an external person with email and push off still gets the Inbox row');
select is((select count(*)::integer from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
    where n.recipient_person_id = pg_temp.id('ivy') and n.subject_id = (select id from a where key = 'ivy_off')), 0, 'and no delivery');
select is(pg_temp.told('ivy_off'), pg_temp.told('base'), 'and is counted, because that row is theirs to read');

-- Larger than one statement may spend --------------------------------------------------------------------------------------
create or replace function private.crisis_alert_inline_budget() returns interval
language sql immutable set search_path = '' as $$ select interval '0 seconds' $$;
select pg_temp.as_user('carol');
with x as (
  insert into app.crisis_alerts (project_id, emergency_code, message) values (pg_temp.id('prj_a'), 'CODE_RED', 'Too many to send now.')
  returning id, people_told, people_told_on_site, people_waiting, people_not_sent)
insert into a select 'big', id, people_waiting, people_told from x;
select pg_temp.as_platform();
select ok((select told from a where key = 'big') >= 5, 'an alert too large for its statement is written, with people waiting');
select is((select on_site from a where key = 'big'), 0, 'and reads as nobody told yet, not as a failure');
select is((select count(*)::integer from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'big')),
  (select told from a where key = 'big'), 'one waiting row a person');
select is((select count(*)::integer from app.notifications n where n.subject_id = (select id from a where key = 'big')), 0, 'and nothing sent yet');
select is((select s.person_id from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'big') order by s.priority, s.id limit 1),
  pg_temp.id('dave'), 'whoever is clocked in goes first');
select is((select s.message_args ->> 'actorName' from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'big') limit 1),
  'Carol Nguyen', 'and the worker will name who announced it, with nobody signed in');

select pg_temp.as_user('carol');
update app.crisis_alerts set people_waiting = 0, people_not_sent = 9 where id = (select id from a where key = 'big');
select pg_temp.as_platform();
select is((select c.people_waiting from app.crisis_alerts c where c.id = (select id from a where key = 'big')),
  (select told from a where key = 'big'), 'a client cannot rewrite what is waiting');

select ok(private.send_waiting_crisis_alerts() >= 5, 'the worker sends what was left');
select is((select count(*)::integer from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'big')), 0, 'and leaves nothing');
select is((select c.people_waiting from app.crisis_alerts c where c.id = (select id from a where key = 'big')), 0, 'the alert stops waiting');
select is((select c.people_told from app.crisis_alerts c where c.id = (select id from a where key = 'big')),
  (select told from a where key = 'big'), 'and counts them');
select is((select c.people_told_on_site from app.crisis_alerts c where c.id = (select id from a where key = 'big')), 1, 'and who was clocked in');
select is((select n.message_args ->> 'actorName' from app.notifications n
    where n.recipient_person_id = pg_temp.id('frank') and n.subject_id = (select id from a where key = 'big')), 'Carol Nguyen', 'naming who announced it');
select is(private.send_waiting_crisis_alerts(), 0, 'a second run has nothing to do');

-- An all-clear the statement cannot send waits too.
select pg_temp.as_user('alice');
update app.crisis_alerts set ended_at = now() where id = (select id from a where key = 'big');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications n where n.subject_id = (select id from a where key = 'big') and n.kind = 'crisis_alert.ended'), 0, 'the all-clear waits when the statement cannot send it');
select ok(private.send_waiting_crisis_alerts() > 0, 'and the worker sends it');
select is(pg_temp.notes('frank', 'crisis_alert.ended', (select id from a where key = 'big')), 1, 'so people hear it ended');
select is((select c.people_told from app.crisis_alerts c where c.id = (select id from a where key = 'big')),
  (select told from a where key = 'big'), 'and that does not change what the alert reached');

-- An alert that ended before someone's turn is not news to them.
select pg_temp.drill('short');
select pg_temp.as_user('alice');
update app.crisis_alerts set ended_at = now() where id = (select id from a where key = 'short');
select pg_temp.as_platform();
select ok(private.send_waiting_crisis_alerts() >= 0, 'the worker runs');
select is((select count(*)::integer from app.notifications n where n.subject_id = (select id from a where key = 'short') and n.kind = 'crisis_alert.issued'), 0, 'an alert ended before anyone''s turn tells nobody of it');
select is((select c.people_waiting from app.crisis_alerts c where c.id = (select id from a where key = 'short')), 0, 'and nobody waits for it');

-- One person's failure costs nobody else the alert ---------------------------------------------------------------------------
create or replace function private.crisis_alert_inline_budget() returns interval
language sql immutable set search_path = '' as $$ select interval '3 seconds' $$;
create function pg_temp.refuse_frank() returns trigger
language plpgsql as $$
begin
  if new.recipient_person_id = (select w.id from world w where w.key = 'frank') and new.kind = 'crisis_alert.issued' then
    raise exception 'not for frank';
  end if;
  return new;
end $$;
create trigger t00_refuse_frank before insert on app.notifications for each row execute function pg_temp.refuse_frank();
select pg_temp.drill('frank_fails');
select pg_temp.as_platform();
select is(pg_temp.told('frank_fails'), pg_temp.told('base') - 1, 'an error for one person leaves them out of the count');
select is((select c.people_waiting from app.crisis_alerts c where c.id = (select id from a where key = 'frank_fails')), 1, 'and they wait for another try');
select is(pg_temp.notes('dave', 'crisis_alert.issued', (select id from a where key = 'frank_fails')), 1, 'while everyone else is told');
select private.send_waiting_crisis_alerts();
select is((select s.attempts::integer from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'frank_fails')), 1, 'a failed try is counted');
select private.send_waiting_crisis_alerts();
select private.send_waiting_crisis_alerts();
select is((select count(*)::integer from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'frank_fails')), 0, 'after three tries it stops');
select is((select c.people_not_sent from app.crisis_alerts c where c.id = (select id from a where key = 'frank_fails')), 1, 'and says it could not send to them');
select is((select c.people_waiting from app.crisis_alerts c where c.id = (select id from a where key = 'frank_fails')), 0, 'with nobody left waiting');

-- A failure that clears on retry counts as told.
select pg_temp.drill('frank_recovers');
drop trigger t00_refuse_frank on app.notifications;
select private.send_waiting_crisis_alerts();
select is((select c.people_told from app.crisis_alerts c where c.id = (select id from a where key = 'frank_recovers')), pg_temp.told('base'), 'a send that works on retry counts as told');
select is((select c.people_not_sent from app.crisis_alerts c where c.id = (select id from a where key = 'frank_recovers')), 0, 'and is not reported as failed');

select is((select schedule from cron.job where jobname = 'xos_send_waiting_crisis_alerts'), '15 seconds', 'the worker runs every 15 seconds');

-- An all-clear reaches whoever the worker has still to tell, or is telling as it is given --------------------------------
create or replace function private.crisis_alert_inline_budget() returns interval
language sql immutable set search_path = '' as $$ select interval '0 seconds' $$;
select pg_temp.drill('racing');
select pg_temp.as_user('alice');
update app.crisis_alerts set ended_at = now() where id = (select id from a where key = 'racing');
select pg_temp.as_platform();
select is((select count(*)::integer from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'racing') and s.kind = 'crisis_alert.ended'),
  (select count(*)::integer from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'racing') and s.kind = 'crisis_alert.issued'
     and s.person_id <> pg_temp.id('alice')) + 1,
  'the all-clear is queued for everyone still to be told but who gave it, and for who announced it');
-- What a worker run was doing as the all-clear was given: it told frank and committed after the all-clear's statement.
select private.send_crisis_alert_note(pg_temp.id('org_a'), pg_temp.id('frank'), 'crisis_alert.issued', (select id from a where key = 'racing'), pg_temp.id('prj_a'),
  (select s.message_args from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'racing') and s.person_id = pg_temp.id('frank') and s.kind = 'crisis_alert.issued'));
delete from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'racing') and s.person_id = pg_temp.id('frank') and s.kind = 'crisis_alert.issued';
select ok(private.send_waiting_crisis_alerts() > 0, 'the worker runs');
select is(pg_temp.notes('frank', 'crisis_alert.ended', (select id from a where key = 'racing')), 1, 'someone told while the all-clear was given still hears it ended');
select is(pg_temp.notes('dave', 'crisis_alert.issued', (select id from a where key = 'racing')) + pg_temp.notes('dave', 'crisis_alert.ended', (select id from a where key = 'racing')), 0,
  'someone whose turn had not come hears of neither');
select is(pg_temp.notes('carol', 'crisis_alert.ended', (select id from a where key = 'racing')), 1, 'and who announced it hears the all-clear');
select is((select count(*)::integer from private.crisis_alert_sends s where s.alert_id = (select id from a where key = 'racing')), 0, 'leaving nothing waiting');
create or replace function private.crisis_alert_inline_budget() returns interval
language sql immutable set search_path = '' as $$ select interval '3 seconds' $$;

-- A crisis alert goes out before an older backlog ---------------------------------------------------------------------------
create temporary table backlog as
select private.notify(pg_temp.id('org_a'), pg_temp.id('frank'),
  (select t.kind from private.notification_templates t
   join private.notification_categories c on c.code = t.category_code and c.urgent
   where t.channel = 'Email'
     and not exists (select 1 from private.notification_quiet_hours_bypass b where b.kind = t.kind)
   order by t.kind limit 1),
  'app.incidents', gen_random_uuid(), pg_temp.id('prj_a'), '{}'::jsonb) as id;
update app.notification_deliveries set deliver_after = now() - interval '1 day'
where notification_id = (select id from backlog) and channel = 'Email';
select is((select count(*)::integer from app.notification_deliveries where notification_id = (select id from backlog) and channel = 'Email'), 1,
  'an older email of a kind that waits for quiet hours is due');
select pg_temp.drill('first_out');
select pg_temp.as_platform();
select count(*) from app.claim_notification_deliveries('Email', 1);
select is((select d.attempt_count::integer from app.notification_deliveries d where d.notification_id = (select id from backlog) and d.channel = 'Email'), 0,
  'the claim takes a crisis alert ahead of it');

-- Refused, it tells nobody -------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$insert into app.crisis_alerts (project_id, emergency_code, message) values (pg_temp.id('prj_a'), 'CODE_RED', 'Not allowed.')$$,
  '42501', null, 'a person without dispatch cannot announce');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications n where n.message_args ->> 'message' = 'Not allowed.'), 0, 'and nothing was sent');

select * from finish();
rollback;
