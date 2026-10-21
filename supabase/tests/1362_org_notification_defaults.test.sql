-- pgTAP: org notification defaults and mandatory categories (A80, RRR-125, finding A65-021, Section 4.5.6 item 29),
-- the In App column, and the member's matrix and settings RPCs (personal settings item 8).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

create function pg_temp.channels(p_notification uuid) returns text
language sql as $$
  select coalesce(string_agg(d.channel::text, ',' order by d.channel), '')
  from app.notification_deliveries d where d.notification_id = p_notification
$$;

create function pg_temp.cell(p_category text, p_channel text) returns text
language sql as $$
  select concat_ws(':', m.enabled, m.org_default, m.locked, m.chosen)
  from app.my_notification_matrix(pg_temp.id('org_a')) m where m.category_code = p_category and m.channel::text = p_channel
$$;

create temporary table n (key text primary key, id uuid);
grant select on n to public;

-- Who sets the org defaults ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.set_org_notification_defaults(pg_temp.id('org_a'), '[]'::jsonb, '["safety"]'::jsonb)$$, '42501', null,
  'a member without org.notifications.write cannot set org defaults');
select throws_ok($$insert into app.org_notification_defaults (org_id, category_code, channel, enabled)
  values (pg_temp.id('org_a'), 'feed', 'Email', false)$$, '42501', null, 'nor write the table directly');

select pg_temp.as_user('bob');
select lives_ok($$select app.set_org_notification_defaults(pg_temp.id('org_a'),
  '[{"category": "feed", "channel": "Email", "enabled": false}, {"category": "safety", "channel": "SMS", "enabled": true}]'::jsonb,
  '["safety"]'::jsonb)$$, 'an admin sets defaults and a mandatory category');
select is((select count(*)::integer from app.org_notification_defaults where org_id = pg_temp.id('org_a')), 2, 'one row per category and channel');
select lives_ok($$select app.set_org_notification_defaults(pg_temp.id('org_a'),
  '[{"category": "feed", "channel": "Email", "enabled": false}, {"category": "safety", "channel": "SMS", "enabled": true}]'::jsonb,
  '["safety"]'::jsonb)$$, 'setting the same defaults again is idempotent');
select is((select count(*)::integer from app.org_notification_defaults where org_id = pg_temp.id('org_a')), 2, 'no duplicate rows');
select is((select count(*)::integer from app.org_mandatory_notification_categories where org_id = pg_temp.id('org_a') and deleted_at is null), 1,
  'one mandatory category');

select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.org_notification_defaults), 0, 'no cross-tenant reads of org defaults');

-- Defaults apply to members who did not choose --------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(pg_temp.cell('feed', 'Email'), 'f:f:f:f', 'the matrix shows the org default when the member did not choose');
select is(pg_temp.cell('safety', 'Push'), 't:t:t:f', 'a mandatory category locks every channel its default has on');
select is(pg_temp.cell('safety', 'SMS'), 't:t:t:f', 'including SMS when the org turned it on (consent still decides the send)');
select is(pg_temp.cell('mentions', 'SMS'), 'f:f:f:f', 'SMS stays off by default elsewhere');

select pg_temp.as_platform();
insert into n values ('feed', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'announcement.posted'));
select is(pg_temp.channels((select id from n where key = 'feed')), 'Push', 'the org''s Email default for feed applies');
insert into n values ('safety', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'incident.reported'));
select is(pg_temp.channels((select id from n where key = 'safety')), 'Email,SMS,Push', 'a mandatory category goes on every locked channel');

-- Members choose, except where the org locked it ---------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(app.set_my_notification_preferences(pg_temp.id('org_a'),
  '[{"category": "feed", "channel": "Email", "enabled": true}, {"category": "comments", "channel": "In App", "enabled": false}]'::jsonb), 2,
  'a member records their choices');
select is(pg_temp.cell('feed', 'Email'), 't:f:f:t', 'their choice beats the org default');
select throws_ok($$select app.set_my_notification_preferences(pg_temp.id('org_a'), '[{"category": "safety", "channel": "Push", "enabled": false}]'::jsonb)$$,
  'XR001', null, 'a locked channel cannot be turned off');
select throws_ok($$insert into app.notification_preferences (membership_id, category_code, channel, enabled)
  values (pg_temp.id('dave@org_a'), 'safety', 'Email', false)$$, 'XR001', null, 'not even by writing the table directly');

select pg_temp.as_platform();
insert into n values ('comment', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'comment.created'));
select ok((select archived_at is not null from app.notifications where id = (select id from n where key = 'comment')),
  'with In App off the notification is recorded already archived, out of the Inbox');
select is(pg_temp.channels((select id from n where key = 'comment')), 'Email,Push', 'while its outside channels still go');

-- Quiet hours and digest -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select app.set_my_notification_settings(pg_temp.id('org_a'), 'America/Chicago', '22:00', '07:00', 'Daily', 8::smallint);
select app.set_my_notification_settings(pg_temp.id('org_a'), 'America/Chicago', '21:00', '07:00', 'Weekly', 9::smallint);
select is((select concat_ws('|', time_zone, quiet_hours_start, digest_frequency, digest_hour) from app.notification_settings
           where membership_id = pg_temp.id('dave@org_a') and deleted_at is null), 'America/Chicago|21:00:00|Weekly|9',
  'a member keeps one settings row, updated in place');

select pg_temp.as_user('xavier');
select throws_ok($$select app.set_my_notification_preferences(pg_temp.id('org_a'), '[]'::jsonb)$$, '42501', null,
  'someone outside the org sets nothing there');

select * from finish();
rollback;
