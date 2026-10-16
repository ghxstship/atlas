-- 1042_quiz_key_follows_option.sql
-- A34 security fixes (RRR-78), gate 29 finding A22-008 (quiz part): app.training_quiz_keys.correct_option
-- is a position in app.training_quiz_questions.options, so reordering or editing a draft question's options
-- silently changed which answer was graded correct.
--
-- The options stay a short ordered list of labels on the question (2 to 6, registered in
-- docs/adr/denormalization-register.md), and the key now follows its option:
--   * a question's options are distinct, so each label names exactly one option
--   * when a question's options change, each live key moves to the new position of the label it pointed
--     to; if that label was removed, the change is refused until the editor sets the correct answer again
-- Edit the options first, then the key if the correct answer itself changes.

create or replace function private.guard_training_quiz_options()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(distinct lower(btrim(o))) from unnest(new.options) o) <> cardinality(new.options) then
    perform private.refuse('training_quiz_options_distinct', 'Each answer option of a question must be different.');
  end if;
  return new;
end;
$$;

comment on function private.guard_training_quiz_options() is 'Quiz questions: answer options are distinct (ignoring case and spaces), so a label names one option and the answer key can follow it (A22-008).';

create trigger t43_guard_training_quiz_options before insert or update of options on app.training_quiz_questions
  for each row execute function private.guard_training_quiz_options();

create or replace function private.follow_training_quiz_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key app.training_quiz_keys;
  v_label text;
  v_position integer;
begin
  if new.options is not distinct from old.options then
    return null;
  end if;
  for v_key in select * from app.training_quiz_keys k where k.training_quiz_question_id = new.id and k.deleted_at is null loop
    v_label := old.options[v_key.correct_option];
    v_position := array_position(new.options, v_label);
    if v_position is null then
      perform private.refuse('training_quiz_key_option_removed',
        'The correct answer was removed from the options. Set the correct answer again, then change the options.');
    end if;
    if v_position <> v_key.correct_option then
      update app.training_quiz_keys set correct_option = v_position where id = v_key.id;
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.follow_training_quiz_key() is 'After a quiz question''s options change: each live answer key moves to the new position of the option it named, so reordering never changes the graded answer; removing the keyed option is refused (A22-008).';

create trigger t60_follow_training_quiz_key after update of options on app.training_quiz_questions
  for each row execute function private.follow_training_quiz_key();

revoke all on function private.guard_training_quiz_options() from public, anon, authenticated;
revoke all on function private.follow_training_quiz_key() from public, anon, authenticated;
