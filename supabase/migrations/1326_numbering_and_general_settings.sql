-- 1326_numbering_and_general_settings.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1): the Numbering and General settings that the database applies
-- (Section 4.5.6 items 2, 3 and 19).
--
--   * numbering.document_number_padding (default 4, 1 to 10): the digits in the documents the org numbers. A new
--     receivable invoice and a training certificate take their number from private.document_number, so a padding of
--     4 gives INV-0042 and TRN-0042.
--   * org.invoice_number_prefix (default INV-): a receivable invoice created without a number gets the org's prefix
--     and the next number of the org's invoice sequence. An invoice that carries its own number keeps it, and payable
--     invoices keep the vendor's number.
--   * org.default_workspace: a new membership in the org is added to that workspace, so new members start in it. A
--     value that names no live workspace of the org is ignored.

create or replace function private.document_number(p_org_id uuid, p_prefix text, p_sequence_name text)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select coalesce(p_prefix, '') || lpad(private.next_sequence(p_org_id, p_sequence_name)::text,
    greatest(coalesce(private.setting_integer(p_org_id, 'numbering.document_number_padding'), 4)::integer, 1), '0');
$$;

comment on function private.document_number(uuid, text, text) is 'The next document number of an org''s sequence: the prefix and the number padded to numbering.document_number_padding digits (1326). A number longer than the padding keeps every digit.';
revoke all on function private.document_number(uuid, text, text) from public, anon, authenticated;

-- Receivable invoice numbers -------------------------------------------------------------------------------------------

create or replace function private.number_receivable_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.direction = 'Receivable' and nullif(btrim(new.invoice_number), '') is null then
    new.invoice_number := private.document_number(new.org_id,
      coalesce(private.setting_text(new.org_id, 'org.invoice_number_prefix'), 'INV-'), 'invoice');
  end if;
  return new;
end;
$$;

comment on function private.number_receivable_invoice() is 'Numbers a new receivable invoice that has no number: org.invoice_number_prefix and the next invoice number padded to numbering.document_number_padding (1326).';
revoke all on function private.number_receivable_invoice() from public, anon, authenticated;

create trigger t35_number_receivable_invoice before insert on app.invoices
  for each row execute function private.number_receivable_invoice();

-- Training certificate numbers ----------------------------------------------------------------------------------------------

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
    v_number := private.document_number(v_course.org_id, 'TRN-', 'training_certificate');
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
comment on function app.complete_training(uuid, jsonb) is 'Grades the signed-in learner on a published course once every reading and video lesson is finished: quiz answers keyed by question id (option number from 1) are scored against the keys. A pass gets a certificate number padded to the org''s numbering.document_number_padding (1326) and, for courses with a validity, an expiry. Every attempt is recorded. Returns the completion id.';

-- Default workspace ---------------------------------------------------------------------------------------------------------

create or replace function private.join_default_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_value text := private.setting_text(new.org_id, 'org.default_workspace');
  v_workspace uuid;
begin
  if v_value is null or v_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  select w.id into v_workspace from app.workspaces w
  where w.id = v_value::uuid and w.org_id = new.org_id and w.deleted_at is null;
  if v_workspace is not null and not exists (
    select 1 from app.workspace_members wm
    where wm.workspace_id = v_workspace and wm.membership_id = new.id and wm.deleted_at is null) then
    insert into app.workspace_members (workspace_id, membership_id) values (v_workspace, new.id);
  end if;
  return null;
end;
$$;

comment on function private.join_default_workspace() is 'Adds a new membership to the org''s default workspace (org.default_workspace, 1326) when the setting names a live workspace of the org.';
revoke all on function private.join_default_workspace() from public, anon, authenticated;

create trigger t82_join_default_workspace after insert on app.memberships
  for each row execute function private.join_default_workspace();
