-- 2100_custom_object_record_activity.sql
--
-- A114 (RRR-159, ADR 0022 block 2100-2109). Section 4.6.3: every custom object gets "the record side peek, comments,
-- attachments, activity, ... webhooks". A custom object record could carry comments and files, but nothing recorded
-- what happened to it: no audit trail, no field history and no domain event, so its peek had no activity to show and
-- webhooks and automations (1480) never heard of it. This migration:
--   * keeps app.custom_object_records a comment and attachment subject (0580 registered it; restated so the target no
--     longer rests on 0540 having run first). Its files are served by the attachments bucket's storage policies (0590,
--     1380), which read a version only through its attachment and the subject's own read policy;
--   * gives app.custom_object_records an audit trail (t85), and writes every change of a record's values to that same
--     trail, one update per write and record, each field keyed values.{field_key}: a value lives in its own row of
--     app.custom_object_values, but it is a field of the record, and its history is the record's;
--   * lists the table in private.field_history_subjects, so app.field_history (1452, not redefined here) answers for
--     its rows;
--   * adds custom_object_record.created, .updated and .deleted to the event catalog, with emitters on the record and
--     on its values, so webhooks subscribe to them and automations trigger on them.

-- 1. Comment and attachment subject ----------------------------------------------------------------------------------------

insert into private.comment_subjects (table_name) values ('app.custom_object_records')
on conflict (table_name) do nothing;

-- 2. Audit trail and field history ---------------------------------------------------------------------------------------

call private.install_audit_trail('app.custom_object_records');

insert into private.field_history_subjects (table_name) values ('app.custom_object_records')
on conflict (table_name) do nothing;

create or replace function private.custom_object_value_json(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or nullif(p_value -> 'deleted_at', 'null'::jsonb) is not null then null
    when nullif(p_value -> 'value_currency', 'null'::jsonb) is not null
      then jsonb_build_object('minor', p_value -> 'value_money_minor', 'currency', p_value -> 'value_currency')
    else coalesce(nullif(p_value -> 'value_text', 'null'::jsonb), nullif(p_value -> 'value_number', 'null'::jsonb),
      nullif(p_value -> 'value_date', 'null'::jsonb), nullif(p_value -> 'value_timestamp', 'null'::jsonb),
      nullif(p_value -> 'value_boolean', 'null'::jsonb), nullif(p_value -> 'value_choice_id', 'null'::jsonb),
      nullif(p_value -> 'value_person_id', 'null'::jsonb))
  end;
$$;

comment on function private.custom_object_value_json(jsonb) is 'The value an app.custom_object_values row (as JSON) holds, as the record''s history shows it: text, number, date, timestamp or boolean as itself, a choice or person as its id, money as {minor, currency}; null for a soft-deleted row or one holding nothing.';

-- 3. Domain events --------------------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('custom_object_record.created', 'custom_object_records', 'A custom object record was created.'),
  ('custom_object_record.updated', 'custom_object_records', 'A custom object record''s title or one of its field values changed.'),
  ('custom_object_record.deleted', 'custom_object_records', 'A custom object record was moved to Trash.');

create or replace function private.custom_object_record_event_data(p_record_id uuid, p_changed text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('object_key', t.object_key, 'custom_object_type_id', r.custom_object_type_id, 'title', r.title)
    || case when p_changed is null then '{}'::jsonb else jsonb_build_object('changed', to_jsonb(p_changed)) end
  from app.custom_object_records r
  join app.custom_object_types t on t.id = r.custom_object_type_id
  where r.id = p_record_id;
$$;

comment on function private.custom_object_record_event_data(uuid, text[]) is 'Payload of a custom_object_record event: the object''s key (its API route /api/v1/objects/{objectKey}), the object type, the record''s title and, for an update, what changed (title, or values.{field_key} for each field).';

create or replace function private.emit_custom_object_record_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.emit_event(new.org_id, tg_argv[0], 'custom_object_records', new.id, null,
    private.custom_object_record_event_data(new.id, case when tg_nargs > 1 then array[tg_argv[1]] end));
  return null;
end;
$$;

comment on function private.emit_custom_object_record_event() is 'After insert or update trigger on app.custom_object_records: emits the event named by the first argument with the record''s payload; a second argument names what changed.';

create trigger t90_emit_custom_object_record_created after insert on app.custom_object_records
  for each row execute function private.emit_custom_object_record_event('custom_object_record.created');
create trigger t90_emit_custom_object_record_updated after update on app.custom_object_records
  for each row when (old.deleted_at is null and new.deleted_at is null and old.title is distinct from new.title)
  execute function private.emit_custom_object_record_event('custom_object_record.updated', 'title');
create trigger t90_emit_custom_object_record_deleted after update on app.custom_object_records
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_custom_object_record_event('custom_object_record.deleted');

-- 4. Value changes are record changes -------------------------------------------------------------------------------------

create or replace function private.after_custom_object_values_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := '[]'::jsonb;
  v_new jsonb := '[]'::jsonb;
  v_change record;
begin
  if private.in_trusted_operation('retention_purge') then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) into v_old from old_rows o;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) into v_new from new_rows n;
  end if;
  for v_change in
    with o as (select e from jsonb_array_elements(v_old) e),
         n as (select e from jsonb_array_elements(v_new) e),
         pairs as (
           select coalesce(n.e, o.e) as value_row, o.e as old_row, n.e as new_row
           from n full join o on (o.e ->> 'id') = (n.e ->> 'id')
         ),
         fields as (
           select (p.value_row ->> 'org_id')::uuid as org_id,
                  (p.value_row ->> 'custom_object_record_id')::uuid as record_id,
                  'values.' || f.field_key as field,
                  private.custom_object_value_json(p.old_row) as old_value,
                  private.custom_object_value_json(p.new_row) as new_value
           from pairs p
           join app.custom_object_fields f on f.id = (p.value_row ->> 'custom_object_field_id')::uuid
         )
    select f.org_id, f.record_id,
           jsonb_object_agg(f.field, coalesce(f.old_value, 'null'::jsonb)) as old_values,
           jsonb_object_agg(f.field, coalesce(f.new_value, 'null'::jsonb)) as new_values,
           array_agg(f.field order by f.field) as changed
    from fields f
    where f.old_value is distinct from f.new_value
    group by f.org_id, f.record_id
  loop
    perform private.write_audit_event(v_change.org_id, 'custom_object_records.update', 'app.custom_object_records',
      v_change.record_id, jsonb_build_object('old', v_change.old_values, 'new', v_change.new_values));
    if exists (select 1 from app.custom_object_records r where r.id = v_change.record_id and r.deleted_at is null) then
      perform private.emit_event(v_change.org_id, 'custom_object_record.updated', 'custom_object_records', v_change.record_id,
        null, private.custom_object_record_event_data(v_change.record_id, v_change.changed));
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.after_custom_object_values_change() is 'After insert, update or delete statement trigger on app.custom_object_values: for each record whose values the statement changed, writes one custom_object_records.update to the record''s audit trail (fields keyed values.{field_key}, old and new as private.custom_object_value_json reads them) and, while the record is not in Trash, emits custom_object_record.updated naming the changed fields. Retention purges are not recorded.';

create trigger t85_custom_object_values_insert after insert on app.custom_object_values
  referencing new table as new_rows
  for each statement execute function private.after_custom_object_values_change();
create trigger t85_custom_object_values_update after update on app.custom_object_values
  referencing old table as old_rows new table as new_rows
  for each statement execute function private.after_custom_object_values_change();
create trigger t85_custom_object_values_delete after delete on app.custom_object_values
  referencing old table as old_rows
  for each statement execute function private.after_custom_object_values_change();

-- Privileges -------------------------------------------------------------------------------------------------------------

revoke all on function private.custom_object_value_json(jsonb) from public, anon, authenticated;
revoke all on function private.custom_object_record_event_data(uuid, text[]) from public, anon, authenticated;
revoke all on function private.emit_custom_object_record_event() from public, anon, authenticated;
revoke all on function private.after_custom_object_values_change() from public, anon, authenticated;
