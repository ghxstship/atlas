-- 2110_custom_field_required_values.sql
-- A117 Custom fields on forms, pages, peeks and tables (RRR-162, Section 4.5.6 org settings item 16). A field
-- marked required is required on the write path too, not only in the forms: private.guard_custom_field_value
-- (0540) now refuses a value row of a required field whose typed column is empty, and soft deleting one, with
-- custom_value_required. Forms check required fields before creating a row and again on the server; this check
-- is what holds when anything writes custom_field_values directly (the API's customFieldValues operations, an
-- import, a script). A field made required later does not touch rows that have no value yet; their next write
-- has to give one.
--
-- Redefined from its only definition (0540) with the required check added; everything else is unchanged.

create or replace function private.guard_custom_field_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_def app.custom_field_definitions;
  v_org uuid;
begin
  select * into v_def from app.custom_field_definitions d where d.id = new.custom_field_definition_id and d.deleted_at is null;
  if v_def.id is null then
    perform private.refuse('custom_value_field', 'The field does not exist.');
  end if;
  execute format('select org_id from %s where id = $1', v_def.target_table) into v_org using new.target_id;
  if v_org is distinct from new.org_id then
    perform private.refuse('cross_org_reference', 'custom_field_values.target_id points to a row of another org.');
  end if;
  if tg_op = 'UPDATE' and new.target_id <> old.target_id then
    perform private.refuse('custom_value_target_immutable', 'A value stays on its row.');
  end if;
  perform private.check_typed_value(v_def.data_type, to_jsonb(new));
  if new.value_choice_id is not null and (select c.custom_field_definition_id from app.custom_field_choices c where c.id = new.value_choice_id) <> new.custom_field_definition_id then
    perform private.refuse('custom_value_choice', 'The option belongs to another field.');
  end if;
  if new.value_person_id is not null and new.org_id not in (select private.person_org_ids(new.value_person_id)) then
    perform private.refuse('custom_value_person', 'A person value names a member of the org.');
  end if;
  if v_def.required then
    if tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null then
      perform private.refuse('custom_value_required', format('%s is required; change its value instead of removing it.', v_def.label));
    end if;
    if new.deleted_at is null and to_jsonb(new) ->> private.value_column(v_def.data_type) is null then
      perform private.refuse('custom_value_required', format('%s is required and needs a value.', v_def.label));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_custom_field_value() is 'Custom field values: the target row exists in the same org and the value stays on it, only the field type''s column is filled, choices belong to the field, people belong to the org, and a required field''s value is neither empty nor removed (2110).';

revoke all on function private.guard_custom_field_value() from public, anon, authenticated;
