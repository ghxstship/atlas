-- pgTAP: training courses, hidden quiz keys, server grading, completion records and certification, the
-- versioned handbook with mandatory reads, and the Assistant source search (A29, Section 4.9).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(38);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Courses -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$insert into app.training_courses (org_id, title) values (pg_temp.id('org_a'), 'Fall protection')$$, '42501', null,
  'a field member cannot write courses');

select pg_temp.as_user('carol');
insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Rigging Level 1', 'Northwind Live');
select lives_ok($$with c as (insert into app.training_courses (org_id, title, summary, role_code, certification_id, gate_criterion_id, validity_days, pass_percent)
  values (pg_temp.id('org_a'), 'Rigging basics', 'Slings, shackles and safe working loads.', (select role_code from xpms.dim_role order by role_code limit 1),
  (select id from app.certifications where name = 'Rigging Level 1'), (select criterion_id from xpms.dim_gate_criterion order by ordinal limit 1), 365, 50)
  returning id) insert into k select 'course', id from c$$, 'a manager drafts a course tied to a role, a certification and a gate criterion');
with l as (insert into app.training_lessons (training_course_id, position, title, lesson_kind, body)
  values ((select id from k where key = 'course'), 1, 'Slings', 'Reading', 'Inspect every sling before use.') returning id)
insert into k select 'reading', id from l;
select throws_ok($$insert into app.training_lessons (training_course_id, position, title, lesson_kind) values ((select id from k where key = 'course'), 2, 'Video', 'Video')$$,
  '23514', null, 'a video lesson needs its address');
with l as (insert into app.training_lessons (training_course_id, position, title, lesson_kind)
  values ((select id from k where key = 'course'), 2, 'Check', 'Quiz') returning id)
insert into k select 'quiz', id from l;
with q as (insert into app.training_quiz_questions (training_lesson_id, position, prompt, options)
  values ((select id from k where key = 'quiz'), 1, 'What do you do before a lift?', array['Inspect the sling', 'Skip it']) returning id)
insert into k select 'q1', id from q;
with q as (insert into app.training_quiz_questions (training_lesson_id, position, prompt, options)
  values ((select id from k where key = 'quiz'), 2, 'Who signs off a lift plan?', array['Anyone', 'The head rigger']) returning id)
insert into k select 'q2', id from q;
select throws_ok($$select app.publish_training_course((select id from k where key = 'course'))$$, 'XR001', null, 'every quiz question needs its key');
insert into app.training_quiz_keys (training_quiz_question_id, correct_option) values ((select id from k where key = 'q1'), 1);
select throws_ok($$insert into app.training_quiz_keys (training_quiz_question_id, correct_option) values ((select id from k where key = 'q2'), 3)$$, 'XR001', null,
  'a key names one of the options');
insert into app.training_quiz_keys (training_quiz_question_id, correct_option) values ((select id from k where key = 'q2'), 2);
select lives_ok($$select app.publish_training_course((select id from k where key = 'course'))$$, 'a complete course is published');
select throws_ok($$select app.publish_training_course((select id from k where key = 'course'))$$,
  'XR001', 'training_course_state_conflict: The training course is not in the expected state Draft.', 'a published course is not published again');
select throws_ok($$update app.training_lessons set title = 'Changed' where id = (select id from k where key = 'reading')$$, 'XR001', null,
  'lessons change only while the course is a draft');

select pg_temp.as_user('frank');
select is((select count(*)::integer from app.training_quiz_questions where training_lesson_id = (select id from k where key = 'quiz')), 2,
  'learners read the quiz questions');
select is((select count(*)::integer from app.training_quiz_keys), 0, 'learners never read the answer keys');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.training_courses where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant course reads');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.training_courses$$, '42501', null, 'anon reads no courses');

-- Assignment and completion ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$select app.assign_training((select id from k where key = 'course'), array[pg_temp.id('mia@org_a')])$$, '42501', null,
  'a field member cannot assign training');
select pg_temp.as_user('carol');
select is(app.assign_training((select id from k where key = 'course'), array[pg_temp.id('frank@org_a'), pg_temp.id('erin@org_a')], current_date + 7, 'New riggers'), 2,
  'a manager assigns the course');
select is(app.assign_training((select id from k where key = 'course'), array[pg_temp.id('frank@org_a')]), 0, 'assigning again skips existing assignees');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where kind = 'training.assigned' and subject_id = (select id from k where key = 'course')), 2,
  'each assignee is notified');

select pg_temp.as_user('frank');
select throws_ok($$select app.complete_training((select id from k where key = 'course'), '{}'::jsonb)$$, 'XR001', null,
  'reading lessons come before grading');
select lives_ok($$select app.complete_training_lesson((select id from k where key = 'reading'))$$, 'the learner finishes the reading');
select throws_ok($$select app.complete_training_lesson((select id from k where key = 'quiz'))$$, 'XR001', null, 'a quiz is finished by grading');
select lives_ok($$insert into k select 'fail', app.complete_training((select id from k where key = 'course'),
  jsonb_build_object((select id::text from k where key = 'q1'), 2, (select id::text from k where key = 'q2'), 1))$$, 'a failing attempt is recorded');
select is((select passed::text || ' ' || score_percent || ' ' || (certificate_number is null)::text from app.training_completions where id = (select id from k where key = 'fail')),
  'false 0 true', 'a failed attempt has no certificate');
select lives_ok($$insert into k select 'pass', app.complete_training((select id from k where key = 'course'),
  jsonb_build_object((select id::text from k where key = 'q1'), 1, (select id::text from k where key = 'q2'), 1))$$, 'a passing attempt');
select is((select passed::text || ' ' || score_percent || ' ' || certificate_number || ' ' || (expires_at > now() + interval '364 days')::text
  from app.training_completions where id = (select id from k where key = 'pass')), 'true 50 TRN-0001 true', 'a pass gets a certificate number and its expiry');
select throws_ok($$update app.training_completions set score_percent = 100 where id = (select id from k where key = 'pass')$$, '42501', null,
  'completion records are not edited');
select throws_ok($$select app.issue_training_certification((select id from k where key = 'pass'))$$, '42501', null,
  'the learner never issues their own certification');
select pg_temp.as_user('bob');
select lives_ok($$insert into k select 'holder', app.issue_training_certification((select id from k where key = 'pass'))$$, 'a verifier issues the certification');
select is(app.issue_training_certification((select id from k where key = 'pass')), (select id from k where key = 'holder'), 'issuing twice keeps the first');
select throws_ok($$select app.issue_training_certification((select id from k where key = 'fail'))$$, 'XR001', null, 'a failed attempt grants nothing');

-- Handbook -------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with s as (insert into app.handbook_sections (org_id, name) values (pg_temp.id('org_a'), 'Site rules') returning id) insert into k select 'section', id from s;
with a as (insert into app.handbook_articles (org_id, handbook_section_id, title, body, is_mandatory)
  values (pg_temp.id('org_a'), (select id from k where key = 'section'), 'Hearing protection', 'Wear hearing protection near the main stacks.', true) returning id)
insert into k select 'article', id from a;
select throws_ok($$update app.handbook_articles set article_state = 'Published' where id = (select id from k where key = 'article')$$, 'XR001', null,
  'articles publish only through the RPC');
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.handbook_articles where org_id = pg_temp.id('org_a')), 0, 'drafts are hidden from readers');
select pg_temp.as_user('carol');
select is(app.publish_handbook_article((select id from k where key = 'article'), 'First version.'), 1, 'publishing numbers version 1');
select throws_ok($$select app.publish_handbook_article((select id from k where key = 'article'))$$, 'XR001', null, 'an unchanged article is not republished');
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.my_mandatory_reads(pg_temp.id('org_a'))), 1, 'the mandatory read is outstanding');
select app.acknowledge_handbook_article((select id from k where key = 'article'));
select is((select count(*)::integer from app.my_mandatory_reads(pg_temp.id('org_a'))), 0, 'acknowledging clears it');
select pg_temp.as_user('carol');
update app.handbook_articles set body = 'Wear hearing protection within 10 m of the main stacks.' where id = (select id from k where key = 'article');
select app.publish_handbook_article((select id from k where key = 'article'), 'Added the distance.');
select pg_temp.as_user('frank');
select is((select version from app.my_mandatory_reads(pg_temp.id('org_a'))), 2, 'a new version asks again');
select is((select title from app.assistant_knowledge_sources(pg_temp.id('org_a'), 'hearing protection stacks') limit 1), 'Hearing protection',
  'the Assistant source search finds the published article');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.assistant_knowledge_sources(pg_temp.id('org_a'), 'hearing')$$, '42501', null,
  'the Assistant source search is for the org''s own members');

select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a') and event_type in
  ('training_course.published', 'training.assigned', 'training.completed', 'training.certified', 'handbook_article.published', 'handbook_article.acknowledged')), 9,
  'training and handbook emit their domain events: 1 published course, 2 assigned, 2 completed, 1 certified, 2 article versions, 1 acknowledgment');

select * from finish();
rollback;
