-- 0804_workforce_training_handbook.sql
-- A29 Workforce Suite (Section 4.9 Training, Handbook and SOPs, Assistant; managed in Atlas Knowledge):
--   * Training: short courses of reading, video and quiz lessons, with completion records, certificate
--     numbers and expiry, linked to a canon role, an org certification and a gate criterion. Courses are
--     Draft, Published or Retired; knowledge.sop.publish writes, publishes and assigns them. Quiz answers
--     live in their own table that only course editors read, and app.complete_training grades a learner
--     server side. A completion of a course tied to a certification is turned into a certification record
--     by a verifier (people.certification.verify), never by the learner (invariant 21).
--   * Handbook: a searchable library of articles in sections, with versions, mandatory reads and
--     acknowledgment tracking per version. knowledge.sop.write drafts, knowledge.sop.publish publishes,
--     knowledge.sop.read reads, knowledge.sop.acknowledge acknowledges.
--   * Assistant source (for A25 Aurora AI): app.assistant_knowledge_sources searches the handbook, the
--     org's SOPs and published training lessons the caller can read, ranked, with a route to each source.

create type app.training_course_state as enum ('Draft', 'Published', 'Retired');
comment on type app.training_course_state is 'Training course states: Draft (editable), Published (assignable) and Retired (kept, closed).';

create type app.training_lesson_kind as enum ('Reading', 'Video', 'Quiz');
comment on type app.training_lesson_kind is 'Training lesson kinds: a reading, a video or a quiz.';

create type app.handbook_article_state as enum ('Draft', 'Published', 'Archived');
comment on type app.handbook_article_state is 'Handbook article states: Draft (never published), Published (current version readable) and Archived (withdrawn).';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('training_course', 'Draft', 'Published'),
  ('training_course', 'Published', 'Retired');

insert into private.domain_event_types (code, subject, description) values
  ('training_course.published', 'training_courses', 'A training course was published.'),
  ('training.assigned', 'training_assignments', 'A training course was assigned to a member.'),
  ('training.completed', 'training_completions', 'A member completed a training course.'),
  ('training.certified', 'training_completions', 'A verifier issued the certification a completed course grants.'),
  ('handbook_article.published', 'handbook_articles', 'A handbook article version was published.'),
  ('handbook_article.acknowledged', 'handbook_acknowledgments', 'A member acknowledged a mandatory handbook article.');

-- Training courses -------------------------------------------------------------------------------------------------

create table app.training_courses (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  title text not null,
  summary text,
  role_code text references xpms.dim_role (role_code),
  certification_id uuid references app.certifications (id),
  gate_criterion_id text references xpms.dim_gate_criterion (criterion_id),
  validity_days integer,
  pass_percent smallint not null default 80,
  estimated_minutes smallint,
  course_state app.training_course_state not null default 'Draft',
  constraint training_courses_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint training_courses_summary_length check (summary is null or char_length(summary) <= 2000),
  constraint training_courses_validity check (validity_days is null or validity_days between 1 and 3650),
  constraint training_courses_pass check (pass_percent between 1 and 100),
  constraint training_courses_minutes check (estimated_minutes is null or estimated_minutes between 1 and 600)
);
create index training_courses_role_idx on app.training_courses (role_code);
create index training_courses_certification_idx on app.training_courses (certification_id);
create index training_courses_gate_criterion_idx on app.training_courses (gate_criterion_id);
call private.install_domain_table('app.training_courses', null, null, array['app.certifications', 'certification_id']);
call private.describe('app.training_courses', 'A short training course (Section 4.9 Training) of lessons and quizzes, with completion records and expiry, linked to a role, a certification and a gate criterion.', array[
  'title', 'Course title.',
  'summary', 'What the course teaches.',
  'role_code', 'Canon role the course trains for.',
  'certification_id', 'Org certification a passed course qualifies for.',
  'gate_criterion_id', 'Canon gate criterion the course helps satisfy.',
  'validity_days', 'Days a completion stays current; NULL never expires.',
  'pass_percent', 'Quiz score needed to pass, in percent.',
  'estimated_minutes', 'Expected time to complete.',
  'course_state', 'Draft, Published or Retired.'
]);

create or replace function private.can_read_training_course(p_org_id uuid, p_state app.training_course_state)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_capability(p_org_id, 'knowledge.sop.publish')
    or (p_state <> 'Draft' and private.my_membership_in(p_org_id) is not null);
$$;
comment on function private.can_read_training_course(uuid, app.training_course_state) is 'Whether the signed-in person reads a course: course editors always, every member once it is published.';
revoke all on function private.can_read_training_course(uuid, app.training_course_state) from public, anon;
grant execute on function private.can_read_training_course(uuid, app.training_course_state) to authenticated, service_role;

call private.install_policies('app.training_courses',
  $$private.can_read_training_course(org_id, course_state)$$,
  $$org_id in (select private.orgs_with_capability('knowledge.sop.publish'))$$);

create or replace function private.readable_training_course_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.training_courses c
  where c.deleted_at is null and c.org_id in (select private.my_org_ids()) and private.can_read_training_course(c.org_id, c.course_state);
$$;
comment on function private.readable_training_course_ids() is 'Training courses the signed-in person reads.';
revoke all on function private.readable_training_course_ids() from public, anon;
grant execute on function private.readable_training_course_ids() to authenticated, service_role;

create or replace function private.editable_training_course_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.training_courses c
  where c.deleted_at is null and c.org_id in (select private.orgs_with_capability('knowledge.sop.publish'));
$$;
comment on function private.editable_training_course_ids() is 'Training courses the signed-in person edits (knowledge.sop.publish).';
revoke all on function private.editable_training_course_ids() from public, anon;
grant execute on function private.editable_training_course_ids() to authenticated, service_role;

call private.install_lifecycle('app.training_courses', 'training_course_id', 'course_state', 'training_course', 'Draft',
  $$training_course_id in (select private.readable_training_course_ids())$$);

create table app.training_lessons (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  training_course_id uuid not null references app.training_courses (id),
  position smallint not null,
  title text not null,
  lesson_kind app.training_lesson_kind not null,
  body text,
  video_url text,
  constraint training_lessons_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint training_lessons_position check (position between 1 and 100),
  constraint training_lessons_body_length check (body is null or char_length(body) <= 50000),
  constraint training_lessons_video check ((lesson_kind = 'Video') = (video_url is not null)),
  constraint training_lessons_video_url check (video_url is null or video_url ~ '^https://[^\s]{1,2000}$'),
  constraint training_lessons_reading_body check (lesson_kind <> 'Reading' or body is not null)
);
create unique index training_lessons_position_key on app.training_lessons (training_course_id, position);
call private.install_domain_table('app.training_lessons', 'app.training_courses', 'training_course_id');
call private.describe('app.training_lessons', 'Lessons of a training course, in order: readings, videos and quizzes. They change only while the course is a draft.', array[
  'training_course_id', 'Course.',
  'position', 'Order, from 1.',
  'title', 'Lesson title.',
  'lesson_kind', 'Reading, Video or Quiz.',
  'body', 'Reading text or notes.',
  'video_url', 'HTTPS address of the lesson video.'
]);
call private.install_policies('app.training_lessons',
  $$training_course_id in (select private.readable_training_course_ids())$$,
  $$training_course_id in (select private.editable_training_course_ids())$$);

create table app.training_quiz_questions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  training_lesson_id uuid not null references app.training_lessons (id),
  position smallint not null,
  prompt text not null,
  options text[] not null,
  constraint training_quiz_questions_prompt_length check (char_length(btrim(prompt)) between 1 and 500),
  constraint training_quiz_questions_options check (cardinality(options) between 2 and 6),
  constraint training_quiz_questions_position check (position between 1 and 50)
);
create unique index training_quiz_questions_position_key on app.training_quiz_questions (training_lesson_id, position);
call private.install_domain_table('app.training_quiz_questions', 'app.training_lessons', 'training_lesson_id');
call private.describe('app.training_quiz_questions', 'Questions of a quiz lesson with their options. The correct option is kept in training_quiz_keys, which learners never read.', array[
  'training_lesson_id', 'Quiz lesson.',
  'position', 'Order, from 1.',
  'prompt', 'Question text.',
  'options', 'Answer options, 2 to 6.'
]);
call private.install_policies('app.training_quiz_questions',
  $$exists (select 1 from app.training_lessons l where l.id = training_lesson_id and l.training_course_id in (select private.readable_training_course_ids()))$$,
  $$exists (select 1 from app.training_lessons l where l.id = training_lesson_id and l.training_course_id in (select private.editable_training_course_ids()))$$);

create table app.training_quiz_keys (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  training_quiz_question_id uuid not null references app.training_quiz_questions (id),
  correct_option smallint not null,
  constraint training_quiz_keys_option check (correct_option between 1 and 6)
);
create unique index training_quiz_keys_question_key on app.training_quiz_keys (training_quiz_question_id);
call private.install_domain_table('app.training_quiz_keys', 'app.training_quiz_questions', 'training_quiz_question_id');
call private.describe('app.training_quiz_keys', 'The correct option of each quiz question. Only course editors read it; app.complete_training grades learners.', array[
  'training_quiz_question_id', 'Question.',
  'correct_option', 'Correct option, from 1.'
]);
call private.install_policies('app.training_quiz_keys',
  $$org_id in (select private.orgs_with_capability('knowledge.sop.publish'))$$,
  $$org_id in (select private.orgs_with_capability('knowledge.sop.publish'))$$);

-- Lessons and quizzes change only while their course is a draft.
create or replace function private.guard_training_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_course uuid;
begin
  if tg_table_name = 'training_lessons' then
    v_course := (v_row ->> 'training_course_id')::uuid;
  elsif tg_table_name = 'training_quiz_questions' then
    v_course := (select l.training_course_id from app.training_lessons l where l.id = (v_row ->> 'training_lesson_id')::uuid);
  else
    v_course := (select l.training_course_id from app.training_quiz_questions q
      join app.training_lessons l on l.id = q.training_lesson_id where q.id = (v_row ->> 'training_quiz_question_id')::uuid);
  end if;
  if (select c.course_state from app.training_courses c where c.id = v_course) <> 'Draft' then
    perform private.refuse('training_course_not_draft', 'Lessons and quizzes change only while the course is a draft.');
  end if;
  if tg_table_name = 'training_quiz_questions'
     and (select l.lesson_kind from app.training_lessons l where l.id = (v_row ->> 'training_lesson_id')::uuid) <> 'Quiz' then
    perform private.refuse('training_quiz_lesson', 'Quiz questions belong to a quiz lesson.');
  end if;
  if tg_table_name = 'training_quiz_keys'
     and (v_row ->> 'correct_option')::integer > (select cardinality(q.options) from app.training_quiz_questions q where q.id = (v_row ->> 'training_quiz_question_id')::uuid) then
    perform private.refuse('training_quiz_key', 'The correct option must be one of the question''s options.');
  end if;
  return new;
end;
$$;
comment on function private.guard_training_content() is 'Training lessons, quiz questions and keys change only while their course is a draft; quiz questions sit in quiz lessons and keys name a real option.';
revoke all on function private.guard_training_content() from public, anon, authenticated;
create trigger t42_guard_training_lesson before insert or update on app.training_lessons
  for each row execute function private.guard_training_content();
create trigger t42_guard_training_quiz_question before insert or update on app.training_quiz_questions
  for each row execute function private.guard_training_content();
create trigger t42_guard_training_quiz_key before insert or update on app.training_quiz_keys
  for each row execute function private.guard_training_content();

create table app.training_assignments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  training_course_id uuid not null references app.training_courses (id),
  membership_id uuid not null references app.memberships (id),
  assigned_by_membership_id uuid references app.memberships (id),
  due_on date,
  reason text,
  constraint training_assignments_reason_length check (reason is null or char_length(btrim(reason)) between 1 and 300)
);
create index training_assignments_membership_idx on app.training_assignments (membership_id);
create index training_assignments_assigner_idx on app.training_assignments (assigned_by_membership_id);
call private.install_domain_table('app.training_assignments', 'app.training_courses', 'training_course_id',
  array['app.memberships', 'membership_id', 'app.memberships', 'assigned_by_membership_id']);
create unique index training_assignments_key on app.training_assignments (training_course_id, membership_id) where deleted_at is null;
call private.describe('app.training_assignments', 'Courses assigned to members, with a due date. Withdrawing an assignment soft deletes it.', array[
  'training_course_id', 'Course assigned.',
  'membership_id', 'Learner.',
  'assigned_by_membership_id', 'Who assigned it; NULL for onboarding sequences and system assignments.',
  'due_on', 'Day it is due.',
  'reason', 'Why it was assigned, for example a new role.'
]);
call private.install_policies('app.training_assignments',
  $$membership_id = any (array(select private.my_membership_ids()))
    or org_id = any (array(select private.orgs_with_capability('knowledge.sop.publish')))$$);

create table app.training_lesson_progress (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  training_lesson_id uuid not null references app.training_lessons (id),
  membership_id uuid not null references app.memberships (id),
  completed_at timestamptz not null default now()
);
create unique index training_lesson_progress_key on app.training_lesson_progress (training_lesson_id, membership_id);
create index training_lesson_progress_membership_idx on app.training_lesson_progress (membership_id);
call private.install_domain_table('app.training_lesson_progress', 'app.training_lessons', 'training_lesson_id',
  array['app.memberships', 'membership_id'], true);
call private.describe('app.training_lesson_progress', 'Append-only record of reading and video lessons a learner finished.', array[
  'training_lesson_id', 'Lesson finished.',
  'membership_id', 'Learner.',
  'completed_at', 'When they finished it.'
]);
call private.install_policies('app.training_lesson_progress',
  $$membership_id = any (array(select private.my_membership_ids()))
    or org_id = any (array(select private.orgs_with_capability('knowledge.sop.publish')))$$);

create table app.training_completions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  training_course_id uuid not null references app.training_courses (id),
  membership_id uuid not null references app.memberships (id),
  score_percent smallint,
  passed boolean not null,
  completed_at timestamptz not null default now(),
  expires_at timestamptz,
  certificate_number text,
  certification_holder_id uuid references app.certification_holders (id),
  constraint training_completions_score check (score_percent is null or score_percent between 0 and 100),
  constraint training_completions_certificate check ((certificate_number is not null) = passed),
  constraint training_completions_certificate_format check (certificate_number is null or certificate_number ~ '^TRN-[0-9]{4,}$'),
  constraint training_completions_expiry check (expires_at is null or (passed and expires_at > completed_at))
);
create index training_completions_course_idx on app.training_completions (training_course_id, membership_id);
create index training_completions_membership_idx on app.training_completions (membership_id);
create index training_completions_holder_idx on app.training_completions (certification_holder_id);
create unique index training_completions_certificate_key on app.training_completions (org_id, certificate_number);
call private.install_domain_table('app.training_completions', 'app.training_courses', 'training_course_id',
  array['app.memberships', 'membership_id', 'app.certification_holders', 'certification_holder_id']);
call private.describe('app.training_completions', 'Training completion records (Section 4.9 Training): every attempt with its quiz score, and for a pass a certificate number and expiry. Written only by app.complete_training; the certification link is set once by a verifier.', array[
  'training_course_id', 'Course completed.',
  'membership_id', 'Learner.',
  'score_percent', 'Quiz score in percent; NULL for a course without quizzes.',
  'passed', 'Whether the attempt passed.',
  'completed_at', 'When the attempt finished.',
  'expires_at', 'When a pass stops being current; NULL never expires.',
  'certificate_number', 'Completion certificate number, TRN-0001 upward per org, for passes.',
  'certification_holder_id', 'Certification record a verifier issued from this pass.'
]);
call private.install_policies('app.training_completions',
  $$membership_id = any (array(select private.my_membership_ids()))
    or org_id = any (array(select private.orgs_with_capability('knowledge.sop.publish')))
    or org_id = any (array(select private.orgs_with_capability('people.certification.read')))$$);

create or replace function private.guard_training_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not private.in_trusted_operation('complete_training') then
    perform private.refuse('training_completion_rpc', 'Completions are recorded through app.complete_training.');
  end if;
  if tg_op = 'UPDATE' and (new.training_course_id <> old.training_course_id or new.membership_id <> old.membership_id
     or new.score_percent is distinct from old.score_percent or new.passed <> old.passed or new.completed_at <> old.completed_at
     or new.expires_at is distinct from old.expires_at or new.certificate_number is distinct from old.certificate_number
     or (old.certification_holder_id is not null and new.certification_holder_id is distinct from old.certification_holder_id)) then
    perform private.refuse('training_completion_fixed', 'A completion record keeps its learner, score, result and expiry.');
  end if;
  return new;
end;
$$;
comment on function private.guard_training_completion() is 'Training completions are written only by app.complete_training and never change, except for the certification link set once.';
revoke all on function private.guard_training_completion() from public, anon, authenticated;
create trigger t42_guard_training_completion before insert or update on app.training_completions
  for each row execute function private.guard_training_completion();

-- Training RPCs ------------------------------------------------------------------------------------------------------------

create or replace function app.publish_training_course(p_course_id uuid, p_reason text default 'Published.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_course app.training_courses;
  v_ledger uuid;
begin
  perform private.require_person();
  select * into v_course from app.training_courses c where c.id = p_course_id and c.deleted_at is null;
  if v_course.id is null or v_course.id not in (select private.editable_training_course_ids()) then
    raise exception using errcode = '42501', message = 'the course does not exist or you cannot edit it';
  end if;
  if not exists (select 1 from app.training_lessons l where l.training_course_id = p_course_id and l.deleted_at is null) then
    perform private.refuse('training_course_empty', 'Add at least one lesson before publishing.');
  end if;
  if exists (select 1 from app.training_lessons l where l.training_course_id = p_course_id and l.deleted_at is null and l.lesson_kind = 'Quiz'
             and not exists (select 1 from app.training_quiz_questions q join app.training_quiz_keys k on k.training_quiz_question_id = q.id
                             where q.training_lesson_id = l.id and q.deleted_at is null and k.deleted_at is null)) then
    perform private.refuse('training_quiz_incomplete', 'Every quiz needs at least one question with its correct answer.');
  end if;
  if exists (select 1 from app.training_quiz_questions q join app.training_lessons l on l.id = q.training_lesson_id
             where l.training_course_id = p_course_id and q.deleted_at is null and l.deleted_at is null
               and not exists (select 1 from app.training_quiz_keys k where k.training_quiz_question_id = q.id and k.deleted_at is null)) then
    perform private.refuse('training_quiz_incomplete', 'Every quiz question needs its correct answer.');
  end if;
  v_ledger := private.transition_lifecycle('training_course', 'app.training_courses', 'course_state', 'app.training_course_state_transitions',
    'training_course_id', p_course_id, 'Draft', 'Published', p_reason);
  perform private.emit_event(v_course.org_id, 'training_course.published', 'training_courses', p_course_id, null,
    jsonb_build_object('title', v_course.title, 'role_code', v_course.role_code));
  return v_ledger;
end;
$$;
comment on function app.publish_training_course(uuid, text) is 'Publishes a draft course with at least one lesson and every quiz question keyed (knowledge.sop.publish). Returns the ledger entry id.';
revoke all on function app.publish_training_course(uuid, text) from public, anon;
grant execute on function app.publish_training_course(uuid, text) to authenticated, service_role;

create or replace function app.retire_training_course(p_course_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if p_course_id not in (select private.editable_training_course_ids()) then
    raise exception using errcode = '42501', message = 'the course does not exist or you cannot edit it';
  end if;
  return private.transition_lifecycle('training_course', 'app.training_courses', 'course_state', 'app.training_course_state_transitions',
    'training_course_id', p_course_id, 'Published', 'Retired', p_reason);
end;
$$;
comment on function app.retire_training_course(uuid, text) is 'Retires a published course (knowledge.sop.publish); its completions stay. Returns the ledger entry id.';
revoke all on function app.retire_training_course(uuid, text) from public, anon;
grant execute on function app.retire_training_course(uuid, text) to authenticated, service_role;

create or replace function app.assign_training(p_course_id uuid, p_membership_ids uuid[], p_due_on date default null, p_reason text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_course app.training_courses;
  v_mine uuid;
  v_target uuid;
  v_count integer := 0;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_course from app.training_courses c where c.id = p_course_id and c.deleted_at is null;
  if v_course.id is null or v_course.id not in (select private.editable_training_course_ids()) then
    raise exception using errcode = '42501', message = 'the course does not exist or you cannot assign it';
  end if;
  if v_course.course_state <> 'Published' then
    perform private.refuse('training_course_not_published', 'Only a published course is assigned.');
  end if;
  if p_due_on is not null and p_due_on < current_date then
    perform private.refuse('training_due_past', 'Pick a due date from today on.');
  end if;
  v_mine := private.my_membership_in(v_course.org_id);
  foreach v_target in array coalesce(p_membership_ids, '{}') loop
    if not exists (select 1 from app.memberships m where m.id = v_target and m.org_id = v_course.org_id and m.deleted_at is null
                   and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
      perform private.refuse('training_assignee_inactive', 'Training is assigned only to active members of the org.');
    end if;
    if not exists (select 1 from app.training_assignments a where a.training_course_id = p_course_id and a.membership_id = v_target and a.deleted_at is null) then
      insert into app.training_assignments (training_course_id, membership_id, assigned_by_membership_id, due_on, reason)
      values (p_course_id, v_target, v_mine, p_due_on, nullif(btrim(p_reason), ''))
      returning id into v_id;
      perform private.emit_event(v_course.org_id, 'training.assigned', 'training_assignments', v_id, null,
        jsonb_build_object('training_course_id', p_course_id, 'due_on', p_due_on));
      perform private.notify(v_course.org_id, (select m.person_id from app.memberships m where m.id = v_target), 'training.assigned',
        'app.training_courses', p_course_id, null, jsonb_build_object('title', v_course.title, 'due_on', p_due_on));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
comment on function app.assign_training(uuid, uuid[], date, text) is 'Assigns a published course to active members (knowledge.sop.publish) with an optional due date and reason, notifying each new assignee. Members already assigned are skipped. Returns how many were assigned.';
revoke all on function app.assign_training(uuid, uuid[], date, text) from public, anon;
grant execute on function app.assign_training(uuid, uuid[], date, text) to authenticated, service_role;

create or replace function app.complete_training_lesson(p_lesson_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lesson app.training_lessons;
  v_mine uuid;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_lesson from app.training_lessons l where l.id = p_lesson_id and l.deleted_at is null;
  if v_lesson.id is null or v_lesson.training_course_id not in (select private.readable_training_course_ids())
     or (select c.course_state from app.training_courses c where c.id = v_lesson.training_course_id) <> 'Published' then
    raise exception using errcode = '42501', message = 'the lesson does not exist or is not in a published course';
  end if;
  if v_lesson.lesson_kind = 'Quiz' then
    perform private.refuse('training_quiz_graded', 'A quiz is finished by submitting the course for grading.');
  end if;
  v_mine := private.require_membership_in(v_lesson.org_id);
  select p.id into v_id from app.training_lesson_progress p where p.training_lesson_id = p_lesson_id and p.membership_id = v_mine;
  if v_id is null then
    insert into app.training_lesson_progress (training_lesson_id, membership_id) values (p_lesson_id, v_mine) returning id into v_id;
  end if;
  return v_id;
end;
$$;
comment on function app.complete_training_lesson(uuid) is 'Marks a reading or video lesson of a published course finished for the signed-in learner. Finishing twice returns the first record. Returns the progress id.';
revoke all on function app.complete_training_lesson(uuid) from public, anon;
grant execute on function app.complete_training_lesson(uuid) to authenticated, service_role;

create or replace function app.complete_training(p_course_id uuid, p_answers jsonb default '{}'::jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_course app.training_courses;
  v_mine uuid;
  v_total integer;
  v_correct integer;
  v_score smallint;
  v_passed boolean;
  v_id uuid;
  v_number text;
begin
  perform private.require_person();
  select * into v_course from app.training_courses c where c.id = p_course_id and c.deleted_at is null;
  if v_course.id is null or v_course.id not in (select private.readable_training_course_ids()) then
    raise exception using errcode = '42501', message = 'the course does not exist or is not visible';
  end if;
  if v_course.course_state <> 'Published' then
    perform private.refuse('training_course_not_published', 'This course is not open for completion.');
  end if;
  v_mine := private.require_membership_in(v_course.org_id);
  if exists (select 1 from app.training_lessons l where l.training_course_id = p_course_id and l.deleted_at is null and l.lesson_kind <> 'Quiz'
             and not exists (select 1 from app.training_lesson_progress p where p.training_lesson_id = l.id and p.membership_id = v_mine)) then
    perform private.refuse('training_lessons_unfinished', 'Finish every reading and video lesson first.');
  end if;
  if jsonb_typeof(p_answers) is distinct from 'object' then
    perform private.refuse('training_answers', 'Quiz answers come as an object keyed by question id.');
  end if;
  select count(*)::integer, count(*) filter (where (p_answers ->> q.id::text)::smallint = k.correct_option)::integer
  into v_total, v_correct
  from app.training_quiz_questions q
  join app.training_lessons l on l.id = q.training_lesson_id and l.deleted_at is null
  join app.training_quiz_keys k on k.training_quiz_question_id = q.id and k.deleted_at is null
  where l.training_course_id = p_course_id and q.deleted_at is null;
  v_score := case when v_total > 0 then round(100.0 * v_correct / v_total)::smallint end;
  v_passed := v_score is null or v_score >= v_course.pass_percent;
  if v_passed then
    v_number := 'TRN-' || lpad(private.next_sequence(v_course.org_id, 'training_certificate')::text, 4, '0');
  end if;
  perform private.begin_trusted_operation('complete_training');
  insert into app.training_completions (training_course_id, membership_id, score_percent, passed, expires_at, certificate_number)
  values (p_course_id, v_mine, v_score, v_passed,
    case when v_passed and v_course.validity_days is not null then now() + make_interval(days => v_course.validity_days) end, v_number)
  returning id into v_id;
  perform private.end_trusted_operation('complete_training');
  perform private.emit_event(v_course.org_id, 'training.completed', 'training_completions', v_id, null,
    jsonb_build_object('training_course_id', p_course_id, 'passed', v_passed, 'score_percent', v_score));
  return v_id;
end;
$$;
comment on function app.complete_training(uuid, jsonb) is 'Grades the signed-in learner on a published course once every reading and video lesson is finished: quiz answers keyed by question id (option number from 1) are scored against the keys. A pass gets a certificate number and, for courses with a validity, an expiry. Every attempt is recorded. Returns the completion id.';
revoke all on function app.complete_training(uuid, jsonb) from public, anon;
grant execute on function app.complete_training(uuid, jsonb) to authenticated, service_role;

create or replace function app.issue_training_certification(p_completion_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_completion app.training_completions;
  v_course app.training_courses;
  v_person uuid;
  v_holder uuid;
begin
  perform private.require_person();
  select * into v_completion from app.training_completions c where c.id = p_completion_id and c.deleted_at is null;
  if v_completion.id is null or not private.has_capability(v_completion.org_id, 'people.certification.verify') then
    raise exception using errcode = '42501', message = 'issuing certifications needs people.certification.verify';
  end if;
  select * into v_course from app.training_courses c where c.id = v_completion.training_course_id;
  if v_course.certification_id is null then
    perform private.refuse('training_no_certification', 'This course does not grant a certification.');
  end if;
  if not v_completion.passed then
    perform private.refuse('training_not_passed', 'Only a passed completion grants the certification.');
  end if;
  if v_completion.certification_holder_id is not null then
    return v_completion.certification_holder_id;
  end if;
  v_person := (select m.person_id from app.memberships m where m.id = v_completion.membership_id);
  insert into app.certification_holders (certification_id, person_id, issued_on, expires_on)
  values (v_course.certification_id, v_person, (v_completion.completed_at at time zone 'UTC')::date,
    (v_completion.expires_at at time zone 'UTC')::date)
  returning id into v_holder;
  update app.training_completions set certification_holder_id = v_holder where id = p_completion_id;
  perform private.emit_event(v_completion.org_id, 'training.certified', 'training_completions', p_completion_id, null,
    jsonb_build_object('certification_holder_id', v_holder));
  return v_holder;
end;
$$;
comment on function app.issue_training_certification(uuid) is 'A verifier (people.certification.verify, never the learner) issues the certification a passed course grants, dated by the completion and expiring with it. Issuing twice returns the first record. Returns the certification holder id.';
revoke all on function app.issue_training_certification(uuid) from public, anon;
grant execute on function app.issue_training_certification(uuid) to authenticated, service_role;

-- Handbook ---------------------------------------------------------------------------------------------------------------------

create table app.handbook_sections (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  position smallint not null default 1,
  constraint handbook_sections_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint handbook_sections_position check (position between 1 and 500)
);
call private.install_domain_table('app.handbook_sections');
create unique index handbook_sections_name_key on app.handbook_sections (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.handbook_sections', 'Chapters of the org handbook, in order.', array[
  'name', 'Section name, unique in the org.',
  'position', 'Order in the handbook.'
]);
call private.install_policies('app.handbook_sections',
  $$org_id in (select private.orgs_with_capability('knowledge.sop.read'))$$,
  $$org_id in (select private.orgs_with_capability('knowledge.sop.write'))$$);

create table app.handbook_articles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  handbook_section_id uuid references app.handbook_sections (id),
  title text not null,
  body text not null,
  is_mandatory boolean not null default false,
  article_state app.handbook_article_state not null default 'Draft',
  published_version integer not null default 0,
  published_at timestamptz,
  search_vector tsvector generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) stored,
  constraint handbook_articles_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint handbook_articles_body_length check (char_length(btrim(body)) between 1 and 100000),
  constraint handbook_articles_version check (published_version >= 0),
  constraint handbook_articles_published check ((article_state = 'Draft') = (published_version = 0) and (published_version = 0) = (published_at is null))
);
create index handbook_articles_section_idx on app.handbook_articles (handbook_section_id);
create index handbook_articles_search_idx on app.handbook_articles using gin (search_vector);
call private.install_domain_table('app.handbook_articles', null, null, array['app.handbook_sections', 'handbook_section_id']);
call private.describe('app.handbook_articles', 'A handbook or SOP article (Section 4.9 Handbook and SOPs): searchable, versioned on publish, optionally a mandatory read acknowledged per version. The body is the working draft; members read the published version.', array[
  'handbook_section_id', 'Section the article sits in.',
  'title', 'Article title.',
  'body', 'Working text; the published text lives in handbook_article_versions.',
  'is_mandatory', 'Whether every member must acknowledge the current version.',
  'article_state', 'Draft, Published or Archived.',
  'published_version', 'Latest published version; 0 before the first publish.',
  'published_at', 'When the latest version was published.',
  'search_vector', 'Full text search vector of the title and text, maintained by the database.'
]);

create or replace function private.can_read_handbook_article(p_org_id uuid, p_state app.handbook_article_state)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_capability(p_org_id, 'knowledge.sop.write')
    or (p_state = 'Published' and private.has_capability(p_org_id, 'knowledge.sop.read'));
$$;
comment on function private.can_read_handbook_article(uuid, app.handbook_article_state) is 'Whether the signed-in person reads a handbook article: editors always, readers (knowledge.sop.read) while it is published.';
revoke all on function private.can_read_handbook_article(uuid, app.handbook_article_state) from public, anon;
grant execute on function private.can_read_handbook_article(uuid, app.handbook_article_state) to authenticated, service_role;

call private.install_policies('app.handbook_articles',
  $$private.can_read_handbook_article(org_id, article_state)$$,
  $$org_id in (select private.orgs_with_capability('knowledge.sop.write'))$$);

create or replace function private.readable_handbook_article_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id from app.handbook_articles a
  where a.deleted_at is null and a.org_id in (select private.my_org_ids()) and private.can_read_handbook_article(a.org_id, a.article_state);
$$;
comment on function private.readable_handbook_article_ids() is 'Handbook articles the signed-in person reads.';
revoke all on function private.readable_handbook_article_ids() from public, anon;
grant execute on function private.readable_handbook_article_ids() to authenticated, service_role;

create or replace function private.guard_handbook_article()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('publish_handbook_article') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.article_state <> 'Draft' or new.published_version <> 0 then
      perform private.refuse('handbook_article_initial', 'An article starts as a draft; publish it to make it readable.');
    end if;
  elsif new.article_state is distinct from old.article_state and not (old.article_state = 'Published' and new.article_state = 'Archived')
     or new.published_version <> old.published_version or new.published_at is distinct from old.published_at then
    perform private.refuse('handbook_article_publish_rpc', 'Articles are published through app.publish_handbook_article; a published article can be archived.');
  end if;
  if new.handbook_section_id is not null and not exists (select 1 from app.handbook_sections s where s.id = new.handbook_section_id and s.org_id = new.org_id) then
    perform private.refuse('handbook_section_org', 'The section is not in this org.');
  end if;
  return new;
end;
$$;
comment on function private.guard_handbook_article() is 'Handbook articles start as drafts, publish only through app.publish_handbook_article and may be archived once published.';
revoke all on function private.guard_handbook_article() from public, anon, authenticated;
create trigger t42_guard_handbook_article before insert or update on app.handbook_articles
  for each row execute function private.guard_handbook_article();

create table app.handbook_article_versions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  handbook_article_id uuid not null references app.handbook_articles (id),
  version integer not null,
  title text not null,
  body text not null,
  change_summary text,
  constraint handbook_article_versions_version check (version >= 1),
  constraint handbook_article_versions_summary_length check (change_summary is null or char_length(btrim(change_summary)) between 1 and 500)
);
create unique index handbook_article_versions_key on app.handbook_article_versions (handbook_article_id, version);
call private.install_domain_table('app.handbook_article_versions', 'app.handbook_articles', 'handbook_article_id', '{}', true);
call private.describe('app.handbook_article_versions', 'Append-only published versions of handbook articles; the newest is what members read and acknowledge.', array[
  'handbook_article_id', 'Article.',
  'version', 'Version number, from 1.',
  'title', 'Title as published.',
  'body', 'Text as published.',
  'change_summary', 'What changed from the previous version.'
]);
call private.install_policies('app.handbook_article_versions', $$handbook_article_id in (select private.readable_handbook_article_ids())$$);

create table app.handbook_acknowledgments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  handbook_article_id uuid not null references app.handbook_articles (id),
  version integer not null,
  membership_id uuid not null references app.memberships (id),
  acknowledged_at timestamptz not null default now()
);
create unique index handbook_acknowledgments_key on app.handbook_acknowledgments (handbook_article_id, version, membership_id);
create index handbook_acknowledgments_membership_idx on app.handbook_acknowledgments (membership_id);
call private.install_domain_table('app.handbook_acknowledgments', 'app.handbook_articles', 'handbook_article_id',
  array['app.memberships', 'membership_id'], true);
call private.describe('app.handbook_acknowledgments', 'Append-only acknowledgments of mandatory handbook articles, per version, so a new version asks everyone again.', array[
  'handbook_article_id', 'Article acknowledged.',
  'version', 'Version acknowledged.',
  'membership_id', 'Member who acknowledged.',
  'acknowledged_at', 'When they acknowledged.'
]);
call private.install_policies('app.handbook_acknowledgments',
  $$membership_id = any (array(select private.my_membership_ids()))
    or org_id = any (array(select private.orgs_with_capability('knowledge.sop.publish')))$$);

create or replace function app.publish_handbook_article(p_article_id uuid, p_change_summary text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_article app.handbook_articles;
  v_version integer;
begin
  perform private.require_person();
  select * into v_article from app.handbook_articles a where a.id = p_article_id and a.deleted_at is null;
  if v_article.id is null or v_article.id not in (select private.readable_handbook_article_ids()) then
    raise exception using errcode = '42501', message = 'the article does not exist or is not visible';
  end if;
  if not private.has_capability(v_article.org_id, 'knowledge.sop.publish') then
    perform private.refuse('handbook_publish_authority', 'Publishing handbook articles needs knowledge.sop.publish.');
  end if;
  if v_article.article_state = 'Archived' then
    perform private.refuse('handbook_article_archived', 'An archived article is not published again; write a new article.');
  end if;
  if v_article.published_version > 0 and exists (select 1 from app.handbook_article_versions v where v.handbook_article_id = p_article_id
       and v.version = v_article.published_version and v.title = v_article.title and v.body = v_article.body) then
    perform private.refuse('handbook_article_unchanged', 'Nothing changed since the last published version.');
  end if;
  v_version := v_article.published_version + 1;
  insert into app.handbook_article_versions (handbook_article_id, version, title, body, change_summary)
  values (p_article_id, v_version, v_article.title, v_article.body, nullif(btrim(p_change_summary), ''));
  perform private.begin_trusted_operation('publish_handbook_article');
  update app.handbook_articles set article_state = 'Published', published_version = v_version, published_at = now() where id = p_article_id;
  perform private.end_trusted_operation('publish_handbook_article');
  perform private.emit_event(v_article.org_id, 'handbook_article.published', 'handbook_articles', p_article_id, null,
    jsonb_build_object('version', v_version, 'mandatory', v_article.is_mandatory));
  return v_version;
end;
$$;
comment on function app.publish_handbook_article(uuid, text) is 'Publishes the working text of a handbook article as its next version (knowledge.sop.publish). A mandatory article then asks every member to acknowledge the new version. Returns the version number.';
revoke all on function app.publish_handbook_article(uuid, text) from public, anon;
grant execute on function app.publish_handbook_article(uuid, text) to authenticated, service_role;

create or replace function app.acknowledge_handbook_article(p_article_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_article app.handbook_articles;
  v_mine uuid;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_article from app.handbook_articles a where a.id = p_article_id and a.deleted_at is null;
  if v_article.id is null or v_article.article_state <> 'Published' or v_article.id not in (select private.readable_handbook_article_ids()) then
    raise exception using errcode = '42501', message = 'the article does not exist or is not published';
  end if;
  v_mine := private.require_membership_in(v_article.org_id);
  if not private.has_capability(v_article.org_id, 'knowledge.sop.acknowledge', private.current_person_id()) then
    perform private.refuse('handbook_acknowledge_authority', 'Acknowledging needs knowledge.sop.acknowledge.');
  end if;
  select k.id into v_id from app.handbook_acknowledgments k
  where k.handbook_article_id = p_article_id and k.version = v_article.published_version and k.membership_id = v_mine;
  if v_id is null then
    insert into app.handbook_acknowledgments (handbook_article_id, version, membership_id)
    values (p_article_id, v_article.published_version, v_mine) returning id into v_id;
    perform private.emit_event(v_article.org_id, 'handbook_article.acknowledged', 'handbook_acknowledgments', v_id, null,
      jsonb_build_object('handbook_article_id', p_article_id, 'version', v_article.published_version));
  end if;
  return v_id;
end;
$$;
comment on function app.acknowledge_handbook_article(uuid) is 'Records that the signed-in member read the current version of a published article. Acknowledging twice returns the first record. Returns the acknowledgment id.';
revoke all on function app.acknowledge_handbook_article(uuid) from public, anon;
grant execute on function app.acknowledge_handbook_article(uuid) to authenticated, service_role;

-- Mandatory reads still outstanding for the signed-in member.
create or replace function app.my_mandatory_reads(p_org_id uuid)
returns table (handbook_article_id uuid, title text, version integer, published_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.title, a.published_version, a.published_at
  from app.handbook_articles a
  where a.org_id = p_org_id and a.deleted_at is null and a.article_state = 'Published' and a.is_mandatory
    and a.id in (select private.readable_handbook_article_ids())
    and not exists (select 1 from app.handbook_acknowledgments k where k.handbook_article_id = a.id
      and k.version = a.published_version and k.membership_id = private.my_membership_in(p_org_id))
  order by a.published_at;
$$;
comment on function app.my_mandatory_reads(uuid) is 'Mandatory handbook articles whose current version the signed-in member has not acknowledged, oldest first.';
revoke all on function app.my_mandatory_reads(uuid) from public, anon;
grant execute on function app.my_mandatory_reads(uuid) to authenticated, service_role;

-- Acknowledgment status of an article's current version across the org, for publishers.
create or replace function app.handbook_acknowledgment_status(p_article_id uuid)
returns table (membership_id uuid, person_id uuid, full_name text, acknowledged_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_article app.handbook_articles;
begin
  perform private.require_person();
  select * into v_article from app.handbook_articles a where a.id = p_article_id and a.deleted_at is null;
  if v_article.id is null or not private.has_capability(v_article.org_id, 'knowledge.sop.publish') then
    raise exception using errcode = '42501', message = 'acknowledgment tracking needs knowledge.sop.publish';
  end if;
  return query
    select m.id, m.person_id, coalesce(pe.full_name, ''), k.acknowledged_at
    from app.memberships m
    join app.people pe on pe.id = m.person_id
    left join app.handbook_acknowledgments k on k.handbook_article_id = p_article_id and k.version = v_article.published_version and k.membership_id = m.id
    where m.org_id = v_article.org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    order by k.acknowledged_at nulls first, pe.full_name;
end;
$$;
comment on function app.handbook_acknowledgment_status(uuid) is 'Each active member with when they acknowledged the article''s current version, outstanding first (knowledge.sop.publish).';
revoke all on function app.handbook_acknowledgment_status(uuid) from public, anon;
grant execute on function app.handbook_acknowledgment_status(uuid) to authenticated, service_role;

-- Assistant sources (A25 interface) ---------------------------------------------------------------------------------------------

create or replace function app.assistant_knowledge_sources(p_org_id uuid, p_query text, p_limit integer default 8)
returns table (source_kind text, source_id uuid, title text, version integer, excerpt text, route text, rank real)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query tsquery;
  v_slug text := (select o.slug from app.organizations o where o.id = p_org_id);
begin
  perform private.require_membership_in(p_org_id);
  if coalesce(btrim(p_query), '') = '' then
    return;
  end if;
  v_query := websearch_to_tsquery('english', p_query);
  return query
  select * from (
    select 'Handbook'::text, a.id, v.title, v.version,
      ts_headline('english', v.body, v_query, 'MaxWords=40, MinWords=15, StartSel="", StopSel=""'),
      '/' || v_slug || '/knowledge/handbook?peek=' || a.id::text,
      ts_rank(a.search_vector, v_query)
    from app.handbook_articles a
    join app.handbook_article_versions v on v.handbook_article_id = a.id and v.version = a.published_version
    where a.org_id = p_org_id and a.deleted_at is null and a.article_state = 'Published' and a.search_vector @@ v_query
      and private.can_read_handbook_article(a.org_id, a.article_state)
    union all
    select 'SOP'::text, s.id, s.title, s.version,
      ts_headline('english', s.body, v_query, 'MaxWords=40, MinWords=15, StartSel="", StopSel=""'),
      '/' || v_slug || '/knowledge/sops?peek=' || s.id::text,
      ts_rank(to_tsvector('english', s.title || ' ' || s.body), v_query)
    from app.sops s
    where s.org_id = p_org_id and s.deleted_at is null and s.published_at is not null
      and to_tsvector('english', s.title || ' ' || s.body) @@ v_query
      and private.has_capability(p_org_id, 'knowledge.sop.read')
    union all
    select 'Training'::text, l.id, c.title || ': ' || l.title, null::integer,
      ts_headline('english', l.body, v_query, 'MaxWords=40, MinWords=15, StartSel="", StopSel=""'),
      '/' || v_slug || '/knowledge/training?peek=' || c.id::text,
      ts_rank(to_tsvector('english', l.title || ' ' || coalesce(l.body, '')), v_query)
    from app.training_lessons l join app.training_courses c on c.id = l.training_course_id
    where c.org_id = p_org_id and c.deleted_at is null and l.deleted_at is null and c.course_state = 'Published' and l.body is not null
      and to_tsvector('english', l.title || ' ' || l.body) @@ v_query
  ) found (source_kind, source_id, title, version, excerpt, route, rank)
  order by found.rank desc, found.title
  limit least(greatest(coalesce(p_limit, 8), 1), 25);
end;
$$;
comment on function app.assistant_knowledge_sources(uuid, text, integer) is 'Interface for the Assistant (Section 4.7, A25): full text search over the org''s published handbook articles, published SOPs and published training lessons the caller can read, ranked, each with an excerpt and the Atlas route to the source. Answers must cite only what this returns.';
revoke all on function app.assistant_knowledge_sources(uuid, text, integer) from public, anon;
grant execute on function app.assistant_knowledge_sources(uuid, text, integer) to authenticated, service_role;

call private.install_default_retention('app.training_courses');
call private.install_default_retention('app.training_course_state_transitions');
call private.install_default_retention('app.training_lessons');
call private.install_default_retention('app.training_quiz_questions');
call private.install_default_retention('app.training_quiz_keys');
call private.install_default_retention('app.training_assignments');
call private.install_default_retention('app.training_lesson_progress');
call private.install_default_retention('app.training_completions');
call private.install_default_retention('app.handbook_sections');
call private.install_default_retention('app.handbook_articles');
call private.install_default_retention('app.handbook_article_versions');
call private.install_default_retention('app.handbook_acknowledgments');
