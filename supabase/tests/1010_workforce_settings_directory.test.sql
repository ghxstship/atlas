-- pgTAP: workforce settings, read receipts, the directory with on-site presence and consented counts, and the
-- platform wiring of every workforce table (A29 late slot 1010).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(18);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Settings -------------------------------------------------------------------------------------------------------
select is((select count(*)::integer from private.setting_definitions where setting_key in
  ('communication.read_receipts', 'communication.feed_reactions_default', 'communication.feed_comments_default', 'workforce.work_phone')), 4,
  'the workforce settings are registered');

-- Read receipts follow the org setting.
select pg_temp.as_user('carol');
insert into k select 'dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('frank@org_a'));
select app.send_chat_message((select id from k where key = 'dm'), 'Can you cover Saturday?');
select pg_temp.as_user('frank');
select app.mark_conversation_read((select id from k where key = 'dm'));
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.conversation_read_receipts((select id from k where key = 'dm')) where last_read_at is not null), 1,
  'read receipts show who read the conversation');
select pg_temp.as_user('bob');
select app.set_setting(pg_temp.id('org_a'), 'communication.read_receipts', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.conversation_read_receipts((select id from k where key = 'dm'))), 0, 'turning read receipts off hides them');
select pg_temp.as_user('gina');
select throws_ok($$select * from app.conversation_read_receipts((select id from k where key = 'dm'))$$, '42501', null, 'outsiders get no receipts');

-- Directory -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.workforce_directory(pg_temp.id('org_a'))), 8, 'every member reads the org directory');
select is((select count(*)::integer from app.workforce_directory(pg_temp.id('org_a'), 'frank')), 1, 'the directory is searchable');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.workforce_directory(pg_temp.id('org_a'))$$, '42501', null, 'no cross-tenant directory');
select pg_temp.as_anon();
select throws_ok($$select * from app.workforce_directory(pg_temp.id('org_a'))$$, '42501', null, 'anon has no directory');

select pg_temp.as_user('frank');
select app.set_personal_setting('workforce.work_phone', p_value_text => '+1 305 555 0199', p_org_id => pg_temp.id('org_a'));
select pg_temp.as_platform();
insert into app.geofences (venue_id, name, boundary)
values (pg_temp.id('venue_a'), 'Pier gate', 'SRID=4326;POLYGON((-80.20 25.76, -80.18 25.76, -80.18 25.78, -80.20 25.78, -80.20 25.76))'::extensions.geography);
with t as (insert into app.time_entries (project_id, membership_id, clock_in, source) values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), now() - interval '2 hours', 'Mobile') returning id)
insert into k select 'entry', id from t;
insert into app.clock_punches (id, project_id, membership_id, time_entry_id, punch_kind, device_time, effective_at, source, geofence_id, geofence_verified)
values (gen_random_uuid(), pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (select id from k where key = 'entry'), 'In', now() - interval '2 hours', now() - interval '2 hours', 'Mobile',
  (select id from app.geofences where name = 'Pier gate'), true);
select pg_temp.as_user('carol');
select is((select on_site_now::text || ' ' || work_phone from app.workforce_directory(pg_temp.id('org_a'), 'frank')), 'true +1 305 555 0199',
  'the directory shows who is on site now and the work phone they shared');
select is((select count(*)::integer from app.workforce_directory(pg_temp.id('org_a'), null, true)), 1, 'filtering to on site lists only them');
select is((select full_name from app.workforce_directory(pg_temp.id('org_a')) limit 1), 'Frank Adeyemi', 'on-site members come first');
select is((select recognition_count from app.workforce_directory(pg_temp.id('org_a'), 'frank')), null::integer, 'no recognition count without consent');

-- Platform wiring of every workforce table ------------------------------------------------------------------------------
select pg_temp.as_platform();
create temporary table wf_tables as
select c.relname::text as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'app' and c.relkind = 'r' and c.relname = any (array[
  'groups', 'group_members', 'conversations', 'conversation_members', 'chat_messages', 'feed_posts', 'feed_acknowledgments', 'feed_reactions',
  'polls', 'poll_options', 'poll_votes', 'surveys', 'survey_state_transitions', 'survey_questions', 'survey_participations', 'survey_responses',
  'survey_answers', 'workforce_events', 'event_rsvps', 'event_check_ins', 'form_templates', 'form_template_state_transitions', 'form_template_versions',
  'form_submissions', 'form_submission_state_transitions', 'training_courses', 'training_course_state_transitions', 'training_lessons',
  'training_quiz_questions', 'training_quiz_keys', 'training_assignments', 'training_lesson_progress', 'training_completions', 'handbook_sections',
  'handbook_articles', 'handbook_article_versions', 'handbook_acknowledgments', 'recognitions', 'help_desk_teams', 'help_desk_team_members',
  'occupancy_counters', 'occupancy_counts', 'weather_thresholds', 'weather_alert_roles', 'weather_readings', 'weather_alerts', 'guest_check_ins',
  'lost_found_items', 'lost_item_state_transitions', 'lost_found_claims']);
select is((select count(*)::integer from wf_tables), 50, 'the suite has its 50 tables');
select is((select count(*)::integer from wf_tables t join pg_catalog.pg_class c on c.relname = t.name join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'app'
  where c.relrowsecurity), 50, 'every workforce table has row level security');
select is((select array_agg(t.name order by t.name) from wf_tables t
  where not exists (select 1 from private.retention_policies r where r.table_name = 'app.' || t.name)), null::text[],
  'every workforce table has a retention policy');
select is((select array_agg(t.name order by t.name) from wf_tables t
  where obj_description(('app.' || t.name)::regclass, 'pg_class') is null), null::text[], 'every workforce table is described');
select is((select count(*)::integer from private.sync_rpcs where rpc in ('app.send_chat_message', 'app.submit_form', 'app.record_occupancy_count', 'app.check_in_guest')), 4,
  'field RPCs replay offline');
select is((select count(*)::integer from private.comment_subjects where table_name in ('app.feed_posts', 'app.chat_messages', 'app.lost_found_items', 'app.groups')), 4,
  'feed posts, messages, lost items and groups carry comments and attachments');

select * from finish();
rollback;
