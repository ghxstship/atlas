-- pgTAP: 1306 (A71, RRR-116). Org-wide dates on the org's calendar (locale.time_zone): training due dates and
-- certification dates, access review due dates, onboarding expiry, passes and reminders, and the 1099-NEC year.
-- As in 1305, org_a takes a zone whose date differs from UTC's right now, so each assertion tells the org's
-- calendar from the database's UTC date at any time of day.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(18);

create temporary table clock as
  select s.zone, (now() at time zone s.zone)::date as local_on, (now() at time zone 'UTC')::date as utc_on
  from (select case when extract(hour from now() at time zone 'UTC') >= 12 then 'Pacific/Kiritimati' else 'Etc/GMT+12' end as zone) s;
grant select on clock to public;
create function pg_temp.zone() returns text language sql stable as $$ select zone from clock $$;
create function pg_temp.local_on() returns date language sql stable as $$ select local_on from clock $$;
create function pg_temp.utc_on() returns date language sql stable as $$ select utc_on from clock $$;
create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

select isnt(pg_temp.local_on(), pg_temp.utc_on(), 'the suite''s zone is on another date than UTC right now');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'locale.time_zone', 'Organization', pg_temp.id('org_a'), pg_temp.zone(), null, null, true);
select pg_temp.as_platform();
select is(private.org_today(pg_temp.id('org_a')), pg_temp.local_on(), 'org_a is on the suite''s zone');

-- Access reviews --------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok(format($$insert into app.access_review_campaigns (org_id, name, due_on) values (%L, 'Yesterday Review', %L)$$,
  pg_temp.id('org_a'), pg_temp.local_on() - 1), 'XR001', 'access_review_due_past: Choose a due date from today on.',
  'a campaign due yesterday on the org''s calendar is refused');
select lives_ok(format($$insert into app.access_review_campaigns (org_id, name, due_on) values (%L, 'Today Review', %L)$$,
  pg_temp.id('org_a'), pg_temp.local_on()), 'one due today on the org''s calendar opens');

-- Training ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Rigging Level 1', 'Northwind Live');
with c as (insert into app.training_courses (org_id, title, summary, role_code, certification_id, gate_criterion_id, validity_days, pass_percent)
  values (pg_temp.id('org_a'), 'Rigging basics', 'Slings, shackles and safe working loads.', (select role_code from xpms.dim_role order by role_code limit 1),
  (select id from app.certifications where name = 'Rigging Level 1'), (select criterion_id from xpms.dim_gate_criterion order by ordinal limit 1), 365, 50)
  returning id) insert into k select 'course', id from c;
with l as (insert into app.training_lessons (training_course_id, position, title, lesson_kind, body)
  values ((select id from k where key = 'course'), 1, 'Slings', 'Reading', 'Inspect every sling before use.') returning id)
insert into k select 'reading', id from l;
with l as (insert into app.training_lessons (training_course_id, position, title, lesson_kind)
  values ((select id from k where key = 'course'), 2, 'Check', 'Quiz') returning id)
insert into k select 'quiz', id from l;
with q as (insert into app.training_quiz_questions (training_lesson_id, position, prompt, options)
  values ((select id from k where key = 'quiz'), 1, 'What do you do before a lift?', array['Inspect the sling', 'Skip it']) returning id)
insert into k select 'q1', id from q;
insert into app.training_quiz_keys (training_quiz_question_id, correct_option) values ((select id from k where key = 'q1'), 1);
select app.publish_training_course((select id from k where key = 'course'));
select throws_ok(format($$select app.assign_training(%L, array[%L]::uuid[], %L)$$,
  (select id from k where key = 'course'), pg_temp.id('frank@org_a'), pg_temp.local_on() - 1),
  'XR001', 'training_due_past: Pick a due date from today on.', 'training due yesterday on the org''s calendar is refused');
select is(app.assign_training((select id from k where key = 'course'), array[pg_temp.id('frank@org_a')], pg_temp.local_on(), 'New riggers'), 1,
  'training due today on the org''s calendar is assigned');

select pg_temp.as_user('frank');
select app.complete_training_lesson((select id from k where key = 'reading'));
insert into k select 'pass', app.complete_training((select id from k where key = 'course'),
  jsonb_build_object((select id::text from k where key = 'q1'), 1));
select pg_temp.as_user('bob');
insert into k select 'holder', app.issue_training_certification((select id from k where key = 'pass'));
select pg_temp.as_platform();
select is((select h.issued_on from app.certification_holders h where h.id = (select id from k where key = 'holder')),
  (select (c.completed_at at time zone pg_temp.zone())::date from app.training_completions c where c.id = (select id from k where key = 'pass')),
  'the certification is dated by the completion''s day on the org''s calendar');
select is((select h.issued_on from app.certification_holders h where h.id = (select id from k where key = 'holder')), pg_temp.local_on(),
  'which is today there, not on UTC');
select is((select h.expires_on from app.certification_holders h where h.id = (select id from k where key = 'holder')),
  (select (c.expires_at at time zone pg_temp.zone())::date from app.training_completions c where c.id = (select id from k where key = 'pass')),
  'and expires on the org''s calendar too');

-- Onboarding ------------------------------------------------------------------------------------------------------
create function pg_temp.item(p_engagement text, p_requirement text) returns uuid
language sql stable as $$
  select i.id from app.onboarding_items i where i.engagement_id = pg_temp.id(p_engagement) and i.onboarding_requirement_id = pg_temp.id(p_requirement)
$$;
grant execute on function pg_temp.item(text, text) to public;
select pg_temp.as_user('carol');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method, valid_for_days, remind_days_before)
  values (pg_temp.id('org_a'), 'Certificate of Insurance', 'Document Upload', 'Crew', 'Reviewer', 365, 30) returning id) insert into world select 'req_coi', id from r;
with e as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01') returning id)
  insert into world select 'eng_quinn_a', id from e;
insert into app.onboarding_verifications (onboarding_item_id, outcome) values (pg_temp.item('eng_quinn_a', 'req_coi'), 'Passed');
select is((select expires_on from app.onboarding_verifications where onboarding_item_id = pg_temp.item('eng_quinn_a', 'req_coi')),
  pg_temp.local_on() + 365, 'a pass expires the requirement''s validity after today on the org''s calendar');

insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on) values (pg_temp.item('eng_quinn_a', 'req_coi'), 'Passed', pg_temp.local_on());
select pg_temp.as_platform();
select ok(private.onboarding_item_passes(pg_temp.item('eng_quinn_a', 'req_coi')), 'a pass that expires today on the org''s calendar still passes');
select pg_temp.as_user('quinn');
select is((select reminder_due from app.onboarding_item_status where onboarding_item_id = pg_temp.item('eng_quinn_a', 'req_coi')), true,
  'and its expiry reminder is due');
select pg_temp.as_user('carol');
insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on) values (pg_temp.item('eng_quinn_a', 'req_coi'), 'Passed', pg_temp.local_on() + 30);
select pg_temp.as_user('quinn');
select is((select reminder_due from app.onboarding_item_status where onboarding_item_id = pg_temp.item('eng_quinn_a', 'req_coi')), true,
  'the reminder comes due 30 days before the expiry on the org''s calendar');
select pg_temp.as_user('carol');
insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on) values (pg_temp.item('eng_quinn_a', 'req_coi'), 'Passed', pg_temp.local_on() + 31);
select pg_temp.as_user('quinn');
select is((select reminder_due from app.onboarding_item_status where onboarding_item_id = pg_temp.item('eng_quinn_a', 'req_coi')), false,
  'and not a day earlier');
select pg_temp.as_user('carol');
insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on) values (pg_temp.item('eng_quinn_a', 'req_coi'), 'Passed', pg_temp.local_on() - 1);
select pg_temp.as_platform();
select ok(not private.onboarding_item_passes(pg_temp.item('eng_quinn_a', 'req_coi')), 'a pass that expired yesterday on the org''s calendar no longer passes');
select pg_temp.as_user('quinn');
select is((select passes from app.onboarding_item_status where onboarding_item_id = pg_temp.item('eng_quinn_a', 'req_coi')), false,
  'the party sees it as not passing');

-- Form 1099-NEC ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok(format($$select count(*) from app.form_1099_nec_rows(%L, %s)$$, pg_temp.id('org_a'), extract(year from pg_temp.local_on())::int),
  'this year on the org''s calendar has a 1099-NEC file');
select throws_ok(format($$select count(*) from app.form_1099_nec_rows(%L, %s)$$, pg_temp.id('org_a'), extract(year from pg_temp.local_on())::int + 1),
  'XR001', 'form_1099_year: Choose a tax year from 2020 to this year.', 'next year on the org''s calendar does not');
select pg_temp.as_platform();

select * from finish();
rollback;
