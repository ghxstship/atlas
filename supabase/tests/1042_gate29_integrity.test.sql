-- Gate 29 (A22-007, A22-008): the registered stored values stay true to their sources.
--   * occupancy: current_count equals the sum of the live door counts, count_after is the running sum,
--     and the ledger cannot be edited or trashed by callers (refresh rule in the denormalization register)
--   * quiz keys follow their option when a draft question's options are reordered or edited (1042)
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Occupancy (A22-007) ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with s as (insert into app.spaces (venue_id, name, capacity) values (pg_temp.id('venue_a'), 'Gate 29 Deck', 50) returning id)
insert into k select 'deck', id from s;
select pg_temp.as_user('carol');
insert into k select 'counter', app.create_occupancy_counter(pg_temp.id('prj_a'), 'Gate 29 Deck', (select id from k where key = 'deck'));
select pg_temp.as_user('frank');
select app.record_occupancy_count((select id from k where key = 'counter'), 12, 'North');
select app.record_occupancy_count((select id from k where key = 'counter'), -5, 'North');
select app.record_occupancy_count((select id from k where key = 'counter'), 9, 'South');

select pg_temp.as_platform();
select is(
  (select c.current_count - coalesce((select sum(n.delta) from app.occupancy_counts n where n.occupancy_counter_id = c.id and n.deleted_at is null), 0)
   from app.occupancy_counters c where c.id = (select id from k where key = 'counter')),
  0::bigint, 'the stored count equals the sum of the door counts');
select is(
  (select count(*)::integer from (
     select n.count_after, sum(n.delta) over (order by n.id) as running
     from app.occupancy_counts n where n.occupancy_counter_id = (select id from k where key = 'counter')) r
   where r.count_after <> r.running),
  0, 'each count_after is the running sum of the ledger');

select pg_temp.as_user('carol');
select throws_ok(format($$update app.occupancy_counts set delta = 40 where occupancy_counter_id = %L$$, (select id from k where key = 'counter')),
  '42501', null, 'callers cannot edit a door count');
select throws_ok(format($$update app.occupancy_counts set deleted_at = now() where occupancy_counter_id = %L$$, (select id from k where key = 'counter')),
  '42501', null, 'callers cannot move a door count to Trash');
select pg_temp.as_platform();
select throws_ok(format($$update app.occupancy_counts set delta = 40 where occupancy_counter_id = %L$$, (select id from k where key = 'counter')),
  null, null, 'even the platform cannot edit the append-only ledger');

-- Quiz keys follow their option (A22-008) ------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with c as (insert into app.training_courses (org_id, title, summary) values (pg_temp.id('org_a'), 'Gate 29 quiz', 'Keys follow options.') returning id)
insert into k select 'course', id from c;
with l as (insert into app.training_lessons (training_course_id, position, title, lesson_kind)
  values ((select id from k where key = 'course'), 1, 'Check', 'Quiz') returning id)
insert into k select 'quiz', id from l;
with q as (insert into app.training_quiz_questions (training_lesson_id, position, prompt, options)
  values ((select id from k where key = 'quiz'), 1, 'Who signs off a lift plan?', array['Anyone', 'The head rigger', 'The driver']) returning id)
insert into k select 'q1', id from q;
insert into app.training_quiz_keys (training_quiz_question_id, correct_option) values ((select id from k where key = 'q1'), 2);

update app.training_quiz_questions set options = array['The head rigger', 'The driver', 'Anyone'] where id = (select id from k where key = 'q1');
select is((select correct_option from app.training_quiz_keys where training_quiz_question_id = (select id from k where key = 'q1')),
  1::smallint, 'reordering the options moves the key with its option');

update app.training_quiz_questions set options = array['The driver', 'The head rigger', 'Anyone', 'A volunteer'] where id = (select id from k where key = 'q1');
select is((select correct_option from app.training_quiz_keys where training_quiz_question_id = (select id from k where key = 'q1')),
  2::smallint, 'adding an option keeps the key on the same answer');
select is((select options[k2.correct_option] from app.training_quiz_questions q join app.training_quiz_keys k2 on k2.training_quiz_question_id = q.id
           where q.id = (select id from k where key = 'q1')),
  'The head rigger', 'the graded answer is still the head rigger');

select throws_ok(format($$update app.training_quiz_questions set options = array['Anyone', 'The driver'] where id = %L$$, (select id from k where key = 'q1')),
  'XR001', null, 'removing the keyed option is refused until the key is set again');
select throws_ok(format($$update app.training_quiz_questions set options = array['Anyone', 'anyone '] where id = %L$$, (select id from k where key = 'q1')),
  'XR001', null, 'options must be distinct');
select throws_ok(format($$insert into app.training_quiz_questions (training_lesson_id, position, prompt, options) values (%L, 2, 'Dup', array['Yes', 'YES'])$$,
  (select id from k where key = 'quiz')), 'XR001', null, 'a new question with duplicate options is refused');

-- Changing the key itself still works after options settle.
update app.training_quiz_keys set correct_option = 3 where training_quiz_question_id = (select id from k where key = 'q1');
select is((select correct_option from app.training_quiz_keys where training_quiz_question_id = (select id from k where key = 'q1')),
  3::smallint, 'the editor can still change the correct answer');

select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.training_quiz_keys where training_quiz_question_id = (select id from k where key = 'q1')),
  0, 'cross-tenant: another org reads no keys');

select * from finish();
rollback;
