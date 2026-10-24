-- 1770_bulk_versions.sql
-- A118 (RRR-163, A65-006, ADR 0077). Inline edits send the version they edited (Section 11.7): the bulk property RPCs
-- of 1451, which every table's row menu and undo use, take the row's updated_at in expect, and a stale save answers
-- the values the row holds now, so the person sees theirs beside their own and chooses.
--
--   * expect may carry updated_at, the version the caller loaded, on every resource; set never may. A matching
--     version passes. A version that moved on is not yet a conflict: the row is checked field by field against the
--     other expected values (the ones the caller started from), so a change someone else made to another field
--     merges, and only a field both people changed is refused as bulk_stale. A version with nothing else expected
--     refuses any later change.
--   * Values compare by meaning: two spellings of one instant are equal whatever offset or precision the client
--     sent, so a time read through the API never conflicts with the same time in the row.
--   * A bulk_stale refusal carries current: the row's values now for every field the row set or expected, and its
--     updated_at. It is read after the row function's own capability checks passed, so it shows nothing the caller
--     could not read. A "keep mine" resend expects the version in current.
--   * Each function is redefined from 1451, its only earlier definition; the inverse rows of a committed call are
--     unchanged, so an undo still expects the values after, field by field.

-- Fields -------------------------------------------------------------------------------------------------------------

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
  -- updated_at is the version the caller loaded: expected on any resource, never set.
  for v_key in select k from jsonb_object_keys(coalesce(p_set, '{}'::jsonb)) k
    union select k from jsonb_object_keys(coalesce(p_expect, '{}'::jsonb) - 'updated_at') k loop
    if position(',' || v_key || ',' in ',' || p_allowed || ',') = 0 then
      perform private.refuse('bulk_field_not_editable', format('%s cannot be changed in bulk.', v_key));
    end if;
  end loop;
end;
$$;

comment on function private.bulk_check_fields(jsonb, jsonb, text) is 'Refuses a bulk row whose set or expect names a field outside the resource''s comma-separated editable list. expect may also carry updated_at, the version the caller loaded; set may not.';
revoke all on function private.bulk_check_fields(jsonb, jsonb, text) from public, anon, authenticated;

-- Compare by meaning -------------------------------------------------------------------------------------------------

create or replace function private.bulk_same_value(p_a jsonb, p_b jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_a is not distinct from p_b then
    return true;
  end if;
  -- A JSON null and a field the row does not carry are both unset.
  if coalesce(p_a, 'null'::jsonb) = 'null'::jsonb and coalesce(p_b, 'null'::jsonb) = 'null'::jsonb then
    return true;
  end if;
  -- Two spellings of one instant: 2027-06-05T18:00:00Z and 2027-06-05T18:00:00.000+00:00.
  if jsonb_typeof(p_a) = 'string' and jsonb_typeof(p_b) = 'string'
     and (p_a #>> '{}') ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}'
     and (p_b #>> '{}') ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then
    begin
      return (p_a #>> '{}')::timestamptz = (p_b #>> '{}')::timestamptz;
    exception when others then
      return false;
    end;
  end if;
  return false;
end;
$$;

comment on function private.bulk_same_value(jsonb, jsonb) is 'Whether two field values of a bulk row are the same: equal JSON, both unset, or two spellings of one instant.';
revoke all on function private.bulk_same_value(jsonb, jsonb) from public, anon, authenticated;

-- Compare-and-set with the version -------------------------------------------------------------------------------------

create or replace function private.bulk_check_expect(p_row jsonb, p_expect jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_expect jsonb := coalesce(p_expect, '{}'::jsonb);
  v_key text;
begin
  if v_expect ? 'updated_at' then
    -- Nobody saved since the caller loaded the row.
    if private.bulk_same_value(p_row -> 'updated_at', v_expect -> 'updated_at') then
      return;
    end if;
    if (v_expect - 'updated_at') = '{}'::jsonb then
      perform private.refuse('bulk_stale', 'Someone changed this row after you loaded it; reload to see the change.');
    end if;
  end if;
  -- Someone saved since: only a field both people changed is a conflict.
  for v_key in select k from jsonb_object_keys(v_expect - 'updated_at') k loop
    if not private.bulk_same_value(p_row -> v_key, v_expect -> v_key) then
      perform private.refuse('bulk_stale', 'Someone changed this row after you loaded it; reload to see the change.');
    end if;
  end loop;
end;
$$;

comment on function private.bulk_check_expect(jsonb, jsonb) is 'Compare-and-set for a bulk row: passes when expect.updated_at is the row''s version; otherwise refuses with bulk_stale when a field no longer holds the value the caller started from, or when the version was all the caller expected.';
revoke all on function private.bulk_check_expect(jsonb, jsonb) from public, anon, authenticated;

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
  v_refusal jsonb;
  v_current jsonb;
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
        v_refusal := private.bulk_refusal(v_id, v_state, v_message, v_hint);
        if v_refusal ->> 'rule' = 'bulk_stale' and v_id is not null then
          -- The row function let the caller read and change this row before it found the later save, so the
          -- values now go back with the refusal; the caller holds its own, and the conflict shows both.
          execute format('select to_jsonb(t) from %s t where t.id = $1', v_registry.table_name) into v_current using v_id;
          v_refusal := v_refusal || jsonb_build_object('current', private.bulk_pick(v_current,
            coalesce(v_item -> 'set', '{}'::jsonb) || coalesce(v_item -> 'expect', '{}'::jsonb) || '{"updated_at": null}'::jsonb));
        end if;
        v_refused := v_refused || jsonb_build_array(v_refusal);
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

comment on function private.run_bulk(text, jsonb, boolean, text) is 'Runs a bulk change of one resource in one transaction: each row in its own subtransaction, all or nothing, a preview that always undoes, per-row refusals (a bulk_stale one with the row''s current values and version), the inverse rows for undo and one audit event per org.';
revoke all on function private.run_bulk(text, jsonb, boolean, text) from public, anon, authenticated;

-- The app RPCs keep their 1451 bodies; their comments now name the version.

comment on function app.bulk_update_records(jsonb, boolean, text) is 'Changes records in bulk in one transaction (Section 11.7): rows as [{id, set, expect}] with state, owner, accountable party, due time or phase, expect optionally carrying the updated_at the caller loaded. All or nothing; answers changed and unchanged counts, each refused row with its rule (a stale one with the row''s current values), and the inverse rows for undo. p_preview checks without changing anything.';
