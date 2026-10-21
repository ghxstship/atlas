-- 1451_bulk_edit.sql
-- A88 (RRR-133, A65-006, ADR 0044). Bulk edit (Section 11.7): change one property across a selection, with a preview
-- of how many rows each value changes, all in one transaction.
--
--   * One driver, private.run_bulk, takes rows as JSON ({id, set, expect}) and calls the resource's row function on
--     each, every row in its own subtransaction so a refusal is caught and reported against that row. Any refusal
--     undoes every change: the call is all or nothing, and the answer lists each refused row with its rule. A preview
--     runs the same work, triggers and capability checks included, and always undoes it, so the preview counts are
--     exactly what applying would do.
--   * Row functions check the caller's capability on each row the way the table's policies do (they run with owner
--     rights) and go through the lifecycle RPCs for state, so every rule a single edit meets applies in bulk too.
--   * expect is compare-and-set: a row whose current value differs from what the caller saw is refused as
--     bulk_stale, so an undo never overwrites a later change by someone else.
--   * A committed call answers the inverse rows (the values before), which undo sends back through the same RPC
--     (server-side inverse), and writes one records.bulk_update style event per org to the audit ledger. Row changes
--     reach the ledger through each table's audit trail; app.records gains one here (field history, 1453).
--   * Adding a resource is one row function, one registry row and one thin app RPC.

-- Registry ---------------------------------------------------------------------------------------------------------

create table private.bulk_resources (
  resource text primary key,
  table_name text not null,
  row_function text not null,
  constraint bulk_resources_resource_format check (resource ~ '^[a-z][a-z0-9_]*$'),
  constraint bulk_resources_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint bulk_resources_function_format check (row_function ~ '^private\.bulk_[a-z0-9_]+_row$')
);

comment on table private.bulk_resources is 'Resources whose rows change in bulk through private.run_bulk (Section 11.7), each with the row function that checks and applies one row.';
comment on column private.bulk_resources.resource is 'Resource name the app RPC passes, for example records.';
comment on column private.bulk_resources.table_name is 'Schema-qualified table the resource lives in; names the audit event.';
comment on column private.bulk_resources.row_function is 'Row function (p_id uuid, p_set jsonb, p_expect jsonb, p_reason text) returning jsonb: org_id, changed, before and after.';

alter table private.bulk_resources enable row level security;
revoke all on private.bulk_resources from public, anon, authenticated;
grant select on private.bulk_resources to service_role;

-- Shared helpers -----------------------------------------------------------------------------------------------------

create or replace function private.bulk_refusal(p_id uuid, p_sqlstate text, p_message text, p_hint text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_rule text;
  v_message text := coalesce(p_message, '');
begin
  if p_sqlstate = 'XR001' then
    v_rule := coalesce(nullif(p_hint, ''), nullif(split_part(v_message, ': ', 1), ''), 'refused');
    if position(v_rule || ': ' in v_message) = 1 then
      v_message := substr(v_message, char_length(v_rule) + 3);
    end if;
  elsif p_sqlstate = '42501' then
    v_rule := 'not_allowed';
  elsif p_sqlstate in ('23514', '23502', '22023', '22P02', '22007', '22008', '22003', '22001') then
    v_rule := 'invalid';
  elsif p_sqlstate = '23503' then
    v_rule := 'invalid_reference';
  elsif p_sqlstate = '23505' then
    v_rule := 'conflict';
  else
    v_rule := 'refused';
  end if;
  return jsonb_build_object('id', p_id, 'rule', v_rule, 'message', v_message);
end;
$$;

comment on function private.bulk_refusal(uuid, text, text, text) is 'One refused row of a bulk change: its id, the rule (the refusal hint, not_allowed, invalid, invalid_reference or conflict) and the sentence.';
revoke all on function private.bulk_refusal(uuid, text, text, text) from public, anon, authenticated;

create or replace function private.bulk_check_fields(p_set jsonb, p_expect jsonb, p_allowed text)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
begin
  if jsonb_typeof(coalesce(p_set, '{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_expect, '{}'::jsonb)) <> 'object' then
    perform private.refuse('bulk_shape', 'Each row carries set and expect as objects of field values.');
  end if;
  for v_key in select k from jsonb_object_keys(coalesce(p_set, '{}'::jsonb)) k
    union select k from jsonb_object_keys(coalesce(p_expect, '{}'::jsonb)) k loop
    if position(',' || v_key || ',' in ',' || p_allowed || ',') = 0 then
      perform private.refuse('bulk_field_not_editable', format('%s cannot be changed in bulk.', v_key));
    end if;
  end loop;
end;
$$;

comment on function private.bulk_check_fields(jsonb, jsonb, text) is 'Refuses a bulk row whose set or expect names a field outside the resource''s comma-separated editable list.';
revoke all on function private.bulk_check_fields(jsonb, jsonb, text) from public, anon, authenticated;

create or replace function private.bulk_check_expect(p_row jsonb, p_expect jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
begin
  for v_key in select k from jsonb_object_keys(coalesce(p_expect, '{}'::jsonb)) k loop
    if (p_row -> v_key) is distinct from (p_expect -> v_key) then
      perform private.refuse('bulk_stale', 'Someone changed this row after you loaded it; reload to see the change.');
    end if;
  end loop;
end;
$$;

comment on function private.bulk_check_expect(jsonb, jsonb) is 'Compare-and-set for a bulk row: refuses with bulk_stale when a field no longer holds the value the caller saw.';
revoke all on function private.bulk_check_expect(jsonb, jsonb) from public, anon, authenticated;

create or replace function private.bulk_pick(p_row jsonb, p_keys jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, p_row -> k), '{}'::jsonb) from jsonb_object_keys(p_keys) k;
$$;

comment on function private.bulk_pick(jsonb, jsonb) is 'The fields of a row named by the keys of another object, as stored (the before and after values of a bulk row).';
revoke all on function private.bulk_pick(jsonb, jsonb) from public, anon, authenticated;

-- The driver -----------------------------------------------------------------------------------------------------------

create or replace function private.run_bulk(p_resource text, p_rows jsonb, p_preview boolean, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_registry private.bulk_resources;
  v_item jsonb;
  v_id uuid;
  v_result jsonb;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_refused jsonb := '[]'::jsonb;
  v_inverse jsonb := '[]'::jsonb;
  v_orgs jsonb := '{}'::jsonb;
  v_fields jsonb := '{}'::jsonb;
  v_state text;
  v_message text;
  v_hint text;
  v_org text;
  v_committed boolean;
begin
  perform private.require_person();
  select * into v_registry from private.bulk_resources b where b.resource = p_resource;
  if v_registry.resource is null then
    perform private.refuse('bulk_resource_unknown', format('%s does not change in bulk.', coalesce(p_resource, 'This resource')));
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    perform private.refuse('bulk_empty', 'Select at least one row.');
  end if;
  if jsonb_array_length(p_rows) > 500 then
    perform private.refuse('bulk_too_large', 'Change at most 500 rows at a time.');
  end if;
  if (select count(distinct e ->> 'id') from jsonb_array_elements(p_rows) e) <> jsonb_array_length(p_rows) then
    perform private.refuse('bulk_duplicate_row', 'Each row appears once in a bulk change.');
  end if;

  begin
    for v_item in select e from jsonb_array_elements(p_rows) e loop
      v_id := null;
      begin
        v_id := (v_item ->> 'id')::uuid;
        if v_id is null then
          perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
        end if;
        execute format('select %s($1, $2, $3, $4)', v_registry.row_function)
          into v_result
          using v_id, coalesce(v_item -> 'set', '{}'::jsonb), coalesce(v_item -> 'expect', '{}'::jsonb), p_reason;
        v_fields := v_fields || coalesce(v_item -> 'set', '{}'::jsonb);
        if coalesce((v_result ->> 'changed')::boolean, false) then
          v_changed := v_changed + 1;
          v_inverse := v_inverse || jsonb_build_array(jsonb_build_object(
            'id', v_id, 'set', v_result -> 'before', 'expect', v_result -> 'after'));
          v_org := v_result ->> 'org_id';
          v_orgs := v_orgs || jsonb_build_object(v_org, coalesce((v_orgs ->> v_org)::integer, 0) + 1);
        else
          v_unchanged := v_unchanged + 1;
        end if;
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
        v_refused := v_refused || jsonb_build_array(private.bulk_refusal(v_id, v_state, v_message, v_hint));
      end;
    end loop;
    if p_preview or jsonb_array_length(v_refused) > 0 then
      raise exception using errcode = 'XB001', message = 'bulk change undone';
    end if;
  exception when sqlstate 'XB001' then
    -- Every row change made in this block is undone: a preview, or a call with a refused row.
    null;
  end;

  v_committed := not p_preview and jsonb_array_length(v_refused) = 0;
  if v_committed and v_changed > 0 then
    for v_org in select k from jsonb_object_keys(v_orgs) k loop
      perform private.write_audit_event(v_org::uuid, p_resource || '.bulk_update', v_registry.table_name, null,
        jsonb_build_object('rows', (v_orgs ->> v_org)::integer,
          'fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(v_fields) k),
          'reason', p_reason));
    end loop;
  end if;

  return jsonb_build_object(
    'preview', coalesce(p_preview, false),
    'committed', v_committed,
    'changed', v_changed,
    'unchanged', v_unchanged,
    'refused', v_refused,
    'inverse', case when v_committed then v_inverse else '[]'::jsonb end);
end;
$$;

comment on function private.run_bulk(text, jsonb, boolean, text) is 'Runs a bulk change of one resource in one transaction: each row in its own subtransaction, all or nothing, a preview that always undoes, per-row refusals, the inverse rows for undo and one audit event per org.';
revoke all on function private.run_bulk(text, jsonb, boolean, text) from public, anon, authenticated;

-- Records (tasks and every other kind) -------------------------------------------------------------------------------

create or replace function private.bulk_records_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.records;
  v_new app.records;
  v_state text;
  v_owner uuid;
  v_accountable uuid;
  v_due timestamptz;
  v_phase text;
  v_keys jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  perform private.bulk_check_fields(p_set, p_expect,
    'record_state,owner_party_id,accountable_party_id,due_at,phase_code,blocker_text,replan_reason');
  select * into v_old from app.records r where r.id = p_id and r.deleted_at is null for update;
  if v_old.id is null
     or not (v_old.project_id in (select private.project_ids_with('work.record.read'))
             or v_old.id in (select private.my_record_ids('work.record.read'))
             or v_old.org_id in (select private.oversight_org_ids('work.record.read'))) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if not (v_old.project_id in (select private.project_ids_with('work.record.write'))
          or v_old.id in (select private.my_record_ids('work.record.write'))) then
    raise exception using errcode = '42501', message = 'work.record.write is required on this record''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);

  v_state := case when p_set ? 'record_state' then p_set ->> 'record_state' else v_old.record_state end;
  v_owner := case when p_set ? 'owner_party_id' then (p_set ->> 'owner_party_id')::uuid else v_old.owner_party_id end;
  v_accountable := case when p_set ? 'accountable_party_id' then (p_set ->> 'accountable_party_id')::uuid else v_old.accountable_party_id end;
  v_due := case when p_set ? 'due_at' then (p_set ->> 'due_at')::timestamptz else v_old.due_at end;
  v_phase := case when p_set ? 'phase_code' then p_set ->> 'phase_code' else v_old.phase_code end;

  if v_state is not distinct from v_old.record_state and v_owner is not distinct from v_old.owner_party_id
     and v_accountable is not distinct from v_old.accountable_party_id and v_due is not distinct from v_old.due_at
     and v_phase is not distinct from v_old.phase_code then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;

  if v_owner is distinct from v_old.owner_party_id or v_accountable is distinct from v_old.accountable_party_id
     or v_due is distinct from v_old.due_at or v_phase is distinct from v_old.phase_code then
    update app.records
    set owner_party_id = v_owner,
        accountable_party_id = v_accountable,
        due_at = v_due,
        phase_code = v_phase,
        replan_reason = case when v_due is distinct from v_old.due_at and v_old.record_state not in ('Proposed', 'Ready')
                             then coalesce(nullif(btrim(p_set ->> 'replan_reason'), ''), nullif(btrim(p_reason), ''), 'Changed in bulk.')
                             else replan_reason end
    where id = p_id;
  end if;
  if v_state is distinct from v_old.record_state then
    perform app.transition_record(p_id, v_old.record_state, v_state,
      coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'), p_set ->> 'blocker_text', p_set ->> 'replan_reason');
  end if;

  select * into v_new from app.records r where r.id = p_id;
  v_keys := p_set - 'blocker_text' - 'replan_reason';
  v_before := private.bulk_pick(to_jsonb(v_old), v_keys);
  v_after := private.bulk_pick(to_jsonb(v_new), v_keys);
  -- Undoing a move out of Blocked or Deferred must name the blocker or the reason again.
  if v_keys ? 'record_state' and v_old.record_state = 'Blocked' then
    v_before := v_before || jsonb_build_object('blocker_text', v_old.blocker_text);
  elsif v_keys ? 'record_state' and v_old.record_state = 'Deferred' then
    v_before := v_before || jsonb_build_object('replan_reason', v_old.replan_reason);
  end if;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true, 'before', v_before, 'after', v_after);
end;
$$;

comment on function private.bulk_records_row(uuid, jsonb, jsonb, text) is 'One record of a bulk change: state through app.transition_record, owner, accountable party, due time and phase. Needs work.record.write on the record as its policy does; a due time change from Scheduled onward is logged as a replan with the reason.';
revoke all on function private.bulk_records_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Shifts -------------------------------------------------------------------------------------------------------------

create or replace function private.bulk_shifts_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.shifts;
  v_new app.shifts;
  v_state app.shift_state;
  v_membership uuid;
  v_keys jsonb := p_set;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'shift_state,membership_id');
  select * into v_old from app.shifts s where s.id = p_id and s.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('crew.shift.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if not private.can_on_project(v_old.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on this shift''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'shift_state' then (p_set ->> 'shift_state')::app.shift_state else v_old.shift_state end;
  v_membership := case when p_set ? 'membership_id' then (p_set ->> 'membership_id')::uuid else v_old.membership_id end;
  if v_state = v_old.shift_state and v_membership is not distinct from v_old.membership_id then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_membership is distinct from v_old.membership_id then
    update app.shifts set membership_id = v_membership where id = p_id;
  end if;
  select * into v_new from app.shifts s where s.id = p_id;
  if v_state <> v_new.shift_state then
    perform app.transition_shift(p_id, v_new.shift_state, v_state, coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'));
  end if;
  select * into v_new from app.shifts s where s.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', private.bulk_pick(to_jsonb(v_old), v_keys), 'after', private.bulk_pick(to_jsonb(v_new), v_keys));
end;
$$;

comment on function private.bulk_shifts_row(uuid, jsonb, jsonb, text) is 'One shift of a bulk change: publish, return to draft or cancel through app.transition_shift, and assign or open the shift. Needs crew.shift.write on the project; a reassigned accepted shift returns to Published as a single reassignment does.';
revoke all on function private.bulk_shifts_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Invoices -----------------------------------------------------------------------------------------------------------

create or replace function private.bulk_invoices_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.invoices;
  v_new app.invoices;
  v_state app.invoice_state;
  v_reason text := coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.');
begin
  perform private.bulk_check_fields(p_set, p_expect, 'invoice_state');
  select * into v_old from app.invoices i where i.id = p_id and i.deleted_at is null;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('finance.invoice.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'invoice_state' then (p_set ->> 'invoice_state')::app.invoice_state else v_old.invoice_state end;
  if v_state = v_old.invoice_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_state = 'Approved' then
    -- Approval keeps every rule of a single approval: the approve capability, separation of duties, a priced and
    -- matched invoice and spend authority. An approval that needs another approver is refused here, so a bulk
    -- approval either approves every row or none.
    if not app.approve_invoice(p_id, v_reason) then
      perform private.refuse('bulk_needs_further_approval', 'This invoice needs another approver under spend authority; approve it on its own.');
    end if;
  elsif v_state = 'Issued' then
    perform private.refuse('bulk_field_not_editable', 'Issue invoices one at a time.');
  else
    perform app.transition_invoice(p_id, v_old.invoice_state, v_state, v_reason);
  end if;
  select * into v_new from app.invoices i where i.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('invoice_state', v_old.invoice_state),
    'after', jsonb_build_object('invoice_state', v_new.invoice_state));
end;
$$;

comment on function private.bulk_invoices_row(uuid, jsonb, jsonb, text) is 'One invoice of a bulk change: approve through app.approve_invoice with all its rules, or dispute, reissue or cancel through app.transition_invoice. An approval waiting for another approver is refused, so the call stays all or nothing.';
revoke all on function private.bulk_invoices_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Asset units --------------------------------------------------------------------------------------------------------

create or replace function private.bulk_asset_units_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.asset_units;
  v_new app.asset_units;
  v_state app.asset_state;
  v_venue uuid;
  v_condition text;
  v_keys jsonb := p_set;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'asset_state,home_venue_id,condition_enum_id');
  select * into v_old from app.asset_units a where a.id = p_id and a.deleted_at is null for update;
  if v_old.id is null or v_old.org_id not in (select private.orgs_with_capability('assets.asset.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.org_id not in (select private.orgs_with_capability('assets.asset.write')) then
    raise exception using errcode = '42501', message = 'assets.asset.write is required.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'asset_state' then (p_set ->> 'asset_state')::app.asset_state else v_old.asset_state end;
  v_venue := case when p_set ? 'home_venue_id' then (p_set ->> 'home_venue_id')::uuid else v_old.home_venue_id end;
  v_condition := case when p_set ? 'condition_enum_id' then p_set ->> 'condition_enum_id' else v_old.condition_enum_id end;
  if v_state = v_old.asset_state and v_venue is not distinct from v_old.home_venue_id
     and v_condition is not distinct from v_old.condition_enum_id then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_venue is distinct from v_old.home_venue_id or v_condition is distinct from v_old.condition_enum_id then
    update app.asset_units set home_venue_id = v_venue, condition_enum_id = v_condition where id = p_id;
  end if;
  if v_state <> v_old.asset_state then
    perform app.transition_asset(p_id, v_old.asset_state, v_state, coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'));
  end if;
  select * into v_new from app.asset_units a where a.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', private.bulk_pick(to_jsonb(v_old), v_keys), 'after', private.bulk_pick(to_jsonb(v_new), v_keys));
end;
$$;

comment on function private.bulk_asset_units_row(uuid, jsonb, jsonb, text) is 'One asset unit of a bulk change: state through app.transition_asset (retiring needs assets.write_off.approve), home venue and condition. Needs assets.asset.write.';
revoke all on function private.bulk_asset_units_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('records', 'app.records', 'private.bulk_records_row'),
  ('shifts', 'app.shifts', 'private.bulk_shifts_row'),
  ('invoices', 'app.invoices', 'private.bulk_invoices_row'),
  ('asset_units', 'app.asset_units', 'private.bulk_asset_units_row');

-- App RPCs -------------------------------------------------------------------------------------------------------------

create or replace function app.bulk_update_records(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('records', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_records(jsonb, boolean, text) is 'Changes records in bulk in one transaction (Section 11.7): rows as [{id, set, expect}] with state, owner, accountable party, due time or phase. All or nothing; answers changed and unchanged counts, each refused row with its rule, and the inverse rows for undo. p_preview checks without changing anything.';

create or replace function app.bulk_update_shifts(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('shifts', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_shifts(jsonb, boolean, text) is 'Publishes, returns to draft, cancels, assigns or opens shifts in bulk in one transaction (Section 11.7), with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_invoices(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('invoices', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_invoices(jsonb, boolean, text) is 'Approves, disputes or cancels invoices in bulk in one transaction (Section 11.7, approve 20 in 60 s), every rule of a single approval applying to each row, with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_asset_units(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('asset_units', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_asset_units(jsonb, boolean, text) is 'Moves asset units along their lifecycle or changes their home venue or condition in bulk in one transaction (Section 11.7), with the answer of app.bulk_update_records.';

revoke all on function app.bulk_update_records(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_shifts(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_invoices(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_asset_units(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_records(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_shifts(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_invoices(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_asset_units(jsonb, boolean, text) to authenticated, service_role;

-- Record changes reach the audit ledger, so bulk edits, their undo and every single edit leave a field-level trail.
call private.install_audit_trail('app.records');
