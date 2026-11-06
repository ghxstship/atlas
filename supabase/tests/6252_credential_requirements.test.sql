-- pgTAP: migration 6252 (B8, G-148), training required before a badge. Only a Published course can be required. A
-- course requirement is met by a passed, unexpired completion through a membership of the org, current or ended; a
-- certification requirement by a live, unexpired certification a verifier recorded, for members and non-members alike. An unmet requirement blocks a direct issue and
-- app.issue_allocation; credential_issue_check lists it; existing credentials are untouched; requirements follow row
-- level security and stay in one org.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

-- Fixture: a published course, a certification, a category with an existing badge ---------------------------------------
select pg_temp.as_platform();
with x as (insert into app.training_courses (org_id, title) values (pg_temp.id('org_a'), 'Rigging Safety') returning id) insert into world select 'course', id from x;
with x as (insert into app.training_courses (org_id, title) values (pg_temp.id('org_a'), 'Crowd Basics') returning id) insert into world select 'draft_course', id from x;
with x as (insert into app.training_courses (org_id, title) values (pg_temp.id('org_a'), 'Old Rigging') returning id) insert into world select 'retired_course', id from x;
-- Publishing needs lessons (0804); the fixture sets the states directly.
set local session_replication_role = replica;
update app.training_courses set course_state = 'Published' where id = pg_temp.id('course');
update app.training_courses set course_state = 'Retired' where id = pg_temp.id('retired_course');
set local session_replication_role = origin;
select pg_temp.as_user('carol');
with x as (insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Site Induction', 'Northwind Live') returning id) insert into world select 'cert', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'RIG', 'Riggers') returning id) insert into world select 'cat_rig', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'IND', 'Inducted') returning id) insert into world select 'cat_ind', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_rig'), pg_temp.id('erin')) returning id) insert into world select 'old_badge', id from x;

-- Policies ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.credential_category_requirements (credential_category_id, training_course_id)
  values ((select id from world where key = 'cat_rig'), (select id from world where key = 'course'))$$,
  '42501', null, 'a Coordinator without credentials.category.write cannot add a requirement');
select pg_temp.as_user('carol');
with x as (insert into app.credential_category_requirements (credential_category_id, training_course_id)
  values (pg_temp.id('cat_rig'), pg_temp.id('course')) returning id) insert into world select 'req_course', id from x;
with x as (insert into app.credential_category_requirements (credential_category_id, certification_id)
  values (pg_temp.id('cat_ind'), pg_temp.id('cert')) returning id) insert into world select 'req_cert', id from x;
select throws_ok($$insert into app.credential_category_requirements (credential_category_id, training_course_id, certification_id)
  values ((select id from world where key = 'cat_rig'), (select id from world where key = 'course'), (select id from world where key = 'cert'))$$,
  '23514', null, 'a requirement is a course or a certification, not both');
select throws_ok($$insert into app.credential_category_requirements (credential_category_id, training_course_id)
  values ((select id from world where key = 'cat_rig'), (select id from world where key = 'course'))$$,
  '23505', null, 'a course is required once per category');
select throws_ok($$insert into app.credential_category_requirements (credential_category_id, training_course_id)
  values ((select id from world where key = 'cat_rig'), (select id from world where key = 'draft_course'))$$,
  'XR001', 'credential_requirement_course_state: Only a published training course can be required.', 'a Draft course cannot be required');
select throws_ok($$insert into app.credential_category_requirements (credential_category_id, training_course_id)
  values ((select id from world where key = 'cat_rig'), (select id from world where key = 'retired_course'))$$,
  'XR001', 'credential_requirement_course_state: Only a published training course can be required.', 'nor a Retired one');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.credential_category_requirements where credential_category_id in (pg_temp.id('cat_rig'), pg_temp.id('cat_ind'))), 2,
  'a project member with credentials.credential.read sees the requirements');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.credential_category_requirements), 0, 'another org sees none');
select pg_temp.as_platform();
select is((select org_id from app.credential_category_requirements where id = pg_temp.id('req_course')), pg_temp.id('org_a'), 'a requirement takes its category''s org');
select is((select org_id from app.credential_category_requirements where id = pg_temp.id('req_cert')), pg_temp.id('org_a'), 'for a certification too');

-- A course requirement ------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.credentials where id = pg_temp.id('old_badge') and revoked_at is null), 1, 'a badge issued before the requirement is untouched');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_rig'), (select id from world where key = 'frank'))$$,
  'XR001', 'credential_training_incomplete: The holder has not met what this category requires: Rigging Safety.',
  'a member with no completion of the course is refused, naming the course');
select is((select string_agg(check_code || ':' || blocking::text || ':' || title, ',') from app.credential_issue_check(pg_temp.id('cat_rig'), pg_temp.id('frank'))),
  'training_missing:true:Rigging Safety', 'the issue check lists the unmet course as blocking');

select pg_temp.as_platform();
set local session_replication_role = replica;
insert into app.training_completions (org_id, training_course_id, membership_id, passed, certificate_number, expires_at, completed_at)
values (pg_temp.id('org_a'), pg_temp.id('course'), pg_temp.id('frank@org_a'), true, 'TRN-9001', now() + interval '10 days', now() - interval '1 day'),
       (pg_temp.id('org_a'), pg_temp.id('course'), pg_temp.id('dave@org_a'), true, 'TRN-9002', now() - interval '1 day', now() - interval '30 days'),
       (pg_temp.id('org_a'), pg_temp.id('course'), pg_temp.id('bob@org_a'), false, null, null, now() - interval '1 day');
set local session_replication_role = origin;

select pg_temp.as_user('carol');
select is((select string_agg(check_code || ':' || blocking::text, ',') from app.credential_issue_check(pg_temp.id('cat_rig'), pg_temp.id('frank'), now(), now() + interval '30 days')),
  'training_expires_first:false', 'a completion that expires before the badge ends is a warning, not a block');
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id, valid_to) values ((select id from world where key = 'cat_rig'), (select id from world where key = 'frank'), now() + interval '30 days')$$,
  'after passing the course, frank''s badge is issued');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_rig'), (select id from world where key = 'dave'))$$,
  'XR001', null, 'an expired completion does not meet the requirement');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_rig'), (select id from world where key = 'bob'))$$,
  'XR001', null, 'a failed attempt does not meet it');
select pg_temp.as_user('frank');
select throws_ok($$select * from app.credential_issue_check((select id from world where key = 'cat_rig'), (select id from world where key = 'dave'))$$,
  '42501', null, 'the issue check needs credentials.credential.issue');

-- A completion through a membership that has since ended still counts; the completion's own expiry governs.
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.memberships set valid_from = now() - interval '90 days', valid_to = now() - interval '1 day' where id = pg_temp.id('mia@org_a');
insert into app.training_completions (org_id, training_course_id, membership_id, passed, certificate_number, expires_at, completed_at)
values (pg_temp.id('org_a'), pg_temp.id('course'), pg_temp.id('mia@org_a'), true, 'TRN-9003', null, now() - interval '60 days');
set local session_replication_role = origin;
select pg_temp.as_user('carol');
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_rig'), (select id from world where key = 'mia'))$$,
  'a completion through an ended membership meets the course requirement');

-- A certification requirement, met by a non-member --------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_ind'), (select id from world where key = 'nina'))$$,
  'XR001', null, 'a person without a membership and without the certification is refused');
insert into app.certification_holders (certification_id, person_id, issued_on) values (pg_temp.id('cert'), pg_temp.id('nina'), current_date);
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_ind'), (select id from world where key = 'nina'))$$,
  'once a verifier records the certification, the badge is issued');
insert into app.certification_holders (certification_id, person_id, issued_on, expires_on) values (pg_temp.id('cert'), pg_temp.id('paul'), current_date - 30, current_date - 1);
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_ind'), (select id from world where key = 'paul'))$$,
  'XR001', null, 'an expired certification blocks again');
select pg_temp.as_user('paul');
select throws_ok($$update app.certification_holders set expires_on = null where person_id = (select id from world where key = 'paul')$$,
  'XR001', 'certification_holder_verifier_only: The holder changes only their consent; a verifier corrects the dates, removes or restores the record.',
  'the holder cannot clear the expiry of their own certification to meet the requirement');
select throws_ok($$update app.certification_holders set issued_on = issued_on - 1 where person_id = (select id from world where key = 'paul')$$,
  'XR001', 'certification_holder_verifier_only: The holder changes only their consent; a verifier corrects the dates, removes or restores the record.',
  'nor change when it was issued');
select throws_ok($$update app.certification_holders set deleted_at = now() where person_id = (select id from world where key = 'paul')$$,
  'XR001', 'certification_holder_verifier_only: The holder changes only their consent; a verifier corrects the dates, removes or restores the record.',
  'nor remove it');
select lives_ok($$update app.certification_holders set public_verification_consented = true where person_id = (select id from world where key = 'paul')$$,
  'the holder still changes their consent');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_ind'), (select id from world where key = 'paul'))$$,
  'XR001', null, 'so the expired certification still blocks');
select lives_ok($$update app.certification_holders set expires_on = current_date + 1 where person_id = (select id from world where key = 'paul')$$,
  'a verifier still corrects the dates');
select lives_ok($$update app.certification_holders set expires_on = current_date - 1 where person_id = (select id from world where key = 'paul')$$,
  'in either direction');

-- The project's date decides a certification's expiry -----------------------------------------------------------------------------
-- A zone whose date differs from UTC's right now, whatever the hour: UTC-12 before noon's reach, UTC+14 from 10:00 UTC on.
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.projects set time_zone = case when extract(hour from now() at time zone 'UTC') < 10 then 'Etc/GMT+12' else 'Pacific/Kiritimati' end
where id = (select c.project_id from app.credential_categories c where c.id = pg_temp.id('cat_ind'));
set local session_replication_role = origin;
create function pg_temp.project_today() returns date language sql stable as $$
  select (now() at time zone p.time_zone)::date from app.credential_categories c join app.projects p on p.id = c.project_id where c.id = pg_temp.id('cat_ind')
$$;
select isnt(pg_temp.project_today(), (now() at time zone 'UTC')::date, 'the fixture''s project date is not the UTC date');
select pg_temp.as_user('carol');
insert into app.certification_holders (certification_id, person_id, issued_on, expires_on) values
  (pg_temp.id('cert'), pg_temp.id('xavier'), pg_temp.project_today() - 30, pg_temp.project_today()),
  (pg_temp.id('cert'), pg_temp.id('cora'), pg_temp.project_today() - 30, pg_temp.project_today() - 1);
select pg_temp.as_platform();
select is((select is_met from private.credential_requirements_state(pg_temp.id('cat_ind'), pg_temp.id('xavier'), null)), true,
  'a certification expiring today on the project''s calendar still counts');
select is((select expires_at from private.credential_requirements_state(pg_temp.id('cat_ind'), pg_temp.id('xavier'), null)),
  (select (pg_temp.project_today() + 1)::timestamp at time zone p.time_zone from app.credential_categories c join app.projects p on p.id = c.project_id where c.id = pg_temp.id('cat_ind')),
  'and stops at the project''s midnight');
select is((select is_met from private.credential_requirements_state(pg_temp.id('cat_ind'), pg_temp.id('cora'), null)), false,
  'one that expired yesterday on the project''s calendar does not');
set local session_replication_role = replica;
update app.projects set time_zone = 'America/New_York' where id = (select c.project_id from app.credential_categories c where c.id = pg_temp.id('cat_ind'));
set local session_replication_role = origin;

select pg_temp.as_user('xavier');
select throws_ok($$insert into app.credential_category_requirements (credential_category_id, certification_id)
  values ((select id from world where key = 'cat_ind'), (select id from world where key = 'cert'))$$,
  '42501', null, 'another org cannot add a requirement to this org''s category');

-- app.issue_allocation is blocked by the same rule -----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.credential_category_requirements (credential_category_id, certification_id) values (pg_temp.id('cat_crew'), pg_temp.id('cert'));
insert into world select 'badge', pg_temp.alloc('assign', 'carol', 'e_kai', 'category', 'cat_crew', 1);
select pg_temp.as_user('carol');
select is((select string_agg(check_code, ',') from app.credential_issue_check(pg_temp.id('cat_crew'), pg_temp.id('kai'))), 'training_missing',
  'the issue check lists the certification kai lacks');
select throws_ok(format($$select app.issue_allocation('01920000-0000-7000-8972-000000000001', %L, '[{}]')$$, pg_temp.id('badge')),
  'XR001', 'credential_training_incomplete: The holder has not met what this category requires: Site Induction.',
  'an Approved badge allocation is not issued before the requirement is met');
insert into app.certification_holders (certification_id, person_id, issued_on) values (pg_temp.id('cert'), pg_temp.id('kai'), current_date);
select is((app.issue_allocation('01920000-0000-7000-8972-000000000002', pg_temp.id('badge'), '[{}]')) ->> 'outcome', 'applied',
  'and is issued once kai holds the certification');

-- The helpers are internal ------------------------------------------------------------------------------------------------------
-- Callers reach the requirements through app.credential_issue_check and app.credential_review (6253), which check the
-- project first; the helper is not granted to them. The check runs as the platform role, since naming a private function
-- needs usage on the schema, which callers lack.
select pg_temp.as_platform();
select ok(not has_function_privilege('authenticated', 'private.credential_requirements_state(uuid, uuid, timestamptz)', 'execute'),
  'the requirement helper is not granted to callers');
select pg_temp.as_user('carol');
select is((select missing_requirements from app.credential_review(array[pg_temp.id('old_badge')])), 1,
  'the review counts what the holder of an older badge does not meet');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.credential_review(array[pg_temp.id('old_badge')])), 0, 'and tells another org nothing');
select pg_temp.as_platform();

select * from finish();
rollback;
