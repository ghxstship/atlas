-- pgTAP: 1451, bulk edit (A88, RRR-133, Section 11.7). One transaction per call, all or nothing, the capability
-- checked on every row, compare-and-set with expect, a preview that changes nothing, the inverse rows that undo a
-- call, per-row refusals with their rule, and one audit event per call.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(42);

create function pg_temp.new_record(p_project text, p_title text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), 'Task', p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create function pg_temp.bulk(p_resource text, p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language plpgsql as $$
begin
  return case p_resource
    when 'records' then app.bulk_update_records(p_rows, p_preview, p_reason)
    when 'shifts' then app.bulk_update_shifts(p_rows, p_preview, p_reason)
    when 'invoices' then app.bulk_update_invoices(p_rows, p_preview, p_reason)
    when 'asset_units' then app.bulk_update_asset_units(p_rows, p_preview, p_reason)
  end;
end $$;

create function pg_temp.owner_rows(p_keys text[], p_owner text) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('owner_party_id', pg_temp.id(p_owner))))
  from unnest(p_keys) k;
$$;

create function pg_temp.owner_of(p_key text) returns uuid
language sql as $$ select owner_party_id from app.records where id = pg_temp.id(p_key) $$;

-- Fixtures ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into world values ('t1', pg_temp.new_record('prj_a', 'Hang the banner'));
insert into world values ('t2', pg_temp.new_record('prj_a', 'Sweep the deck'));
insert into world values ('t3', pg_temp.new_record('prj_a', 'Test the radios'));
select pg_temp.as_user('carol');
insert into world values ('g1', pg_temp.new_record('prj_a2', 'Book the gala band'));
select pg_temp.as_platform();

-- Preview changes nothing -----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('records', pg_temp.owner_rows(array['t1', 't2'], 'erin'), true) r) x),
  '2', 'a preview counts the rows each value would change');
select is(pg_temp.owner_of('t1'), null, 'and changes nothing');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('records', pg_temp.owner_rows(array['t1'], 'erin'), true) r) x),
  'false', 'a preview never commits');

-- One transaction ----------------------------------------------------------------------------------------------------------
create temporary table answer (r jsonb);
grant all on answer to public;
insert into answer select pg_temp.bulk('records', pg_temp.owner_rows(array['t1', 't2'], 'erin'), false, 'Erin owns load-in.');
select is((select r ->> 'committed' from answer), 'true', 'a bulk change commits');
select is((select (r ->> 'changed')::int from answer), 2, 'and reports both rows changed');
select is(pg_temp.owner_of('t1'), pg_temp.id('erin'), 'the first record has its new owner');
select is(pg_temp.owner_of('t2'), pg_temp.id('erin'), 'and so does the second');
select is(jsonb_array_length((select r -> 'inverse' from answer)), 2, 'the answer carries one inverse row per changed row');
select is((select r -> 'inverse' -> 0 -> 'set' ->> 'owner_party_id' from answer), null, 'the inverse holds the value before');
select is((select r -> 'inverse' -> 0 -> 'expect' ->> 'owner_party_id' from answer), pg_temp.id('erin')::text, 'and expects the value after');

select is(
  (select (r ->> 'unchanged')::int from (select pg_temp.bulk('records', pg_temp.owner_rows(array['t1', 't3'], 'erin')) r) x),
  1, 'a row that already holds the value counts as unchanged');

-- Undo: the inverse goes back through the same RPC ----------------------------------------------------------------------
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('records', (select r -> 'inverse' from answer)) r) x),
  'true', 'sending the inverse back undoes the change');
select is(pg_temp.owner_of('t1'), null, 'the first record is unowned again');
select is(pg_temp.owner_of('t2'), null, 'and so is the second');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('records', (select r -> 'inverse' from answer)) r) x),
  'bulk_stale', 'an undo of a row changed since is refused, never silently overwritten');

-- All or nothing, and the capability on every row ---------------------------------------------------------------------------
delete from answer;
insert into answer select pg_temp.bulk('records', pg_temp.owner_rows(array['t1', 'g1'], 'erin'));
select is((select r ->> 'committed' from answer), 'false', 'a call with a row the caller may not change commits nothing');
select is(pg_temp.owner_of('t1'), null, 'so the allowed row is unchanged too');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('g1')::text, 'the refusal names the row');
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'bulk_row_not_found', 'a row outside the caller''s projects reads as not found (invariant 2)');
select is((select jsonb_array_length(r -> 'inverse') from answer), 0, 'and nothing to undo');

select pg_temp.as_user('gina');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('records', pg_temp.owner_rows(array['t1'], 'erin')) r) x),
  'bulk_row_not_found', 'a Viewer outside the project cannot change its records');
select pg_temp.as_user('xavier');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('records', pg_temp.owner_rows(array['t1'], 'xavier')) r) x),
  'bulk_row_not_found', 'another org cannot change them');
select pg_temp.as_anon();
select throws_ok($$select app.bulk_update_records('[]'::jsonb)$$, '42501', null, 'anon cannot call bulk edit');

-- Rules every single edit meets -----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('records',
    jsonb_build_array(jsonb_build_object('id', pg_temp.id('t1'), 'set', jsonb_build_object('title', 'Hang two banners'))))  r) x),
  'bulk_field_not_editable', 'only the resource''s editable fields change in bulk');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('records',
    (select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('record_state', 'Scheduled'))) from unnest(array['t1', 't2']) k),
    false, 'Crew booked.') r) x),
  '2', 'state changes go through the record lifecycle');
select is((select record_state from app.records where id = pg_temp.id('t2')), 'Scheduled', 'and land');
select is((select count(*)::int from app.record_state_transitions where record_id = pg_temp.id('t2') and reason = 'Crew booked.'), 1,
  'with a ledger entry carrying the reason');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('records',
    jsonb_build_array(jsonb_build_object('id', pg_temp.id('t1'), 'set', jsonb_build_object('record_state', 'Blocked'))))  r) x),
  'record_blocker_required', 'a Blocked move still needs a blocker');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('records',
    jsonb_build_array(jsonb_build_object('id', pg_temp.id('t1'), 'set', jsonb_build_object('record_state', 'Complete'))))  r) x),
  'record_transition_not_allowed', 'and a move the lifecycle forbids is refused');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('records',
    jsonb_build_array(jsonb_build_object('id', pg_temp.id('t1'), 'set', jsonb_build_object('due_at', '2027-06-05T18:00:00Z'))),
    false, 'Truss arrives Friday.') r) x),
  '1', 'a due date changes in bulk');
select is((select reason from app.record_replans where record_id = pg_temp.id('t1') order by created_at desc limit 1), 'Truss arrives Friday.',
  'and from Scheduled onward it is logged as a replan with the reason');

-- Shape -----------------------------------------------------------------------------------------------------------------------
select throws_ok($$select app.bulk_update_records('[]'::jsonb)$$, 'XR001', 'bulk_empty: Select at least one row.', 'an empty selection is refused');
select throws_ok($$select app.bulk_update_records((select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'set', '{}'::jsonb)) from generate_series(1, 501)))$$,
  'XR001', 'bulk_too_large: Change at most 500 rows at a time.', 'at most 500 rows at a time');
select throws_ok($$select app.bulk_update_records(jsonb_build_array(jsonb_build_object('id', (select id from world where key = 't1')), jsonb_build_object('id', (select id from world where key = 't1'))))$$,
  'XR001', 'bulk_duplicate_row: Each row appears once in a bulk change.', 'a row appears once');

-- Audit -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events where action = 'records.bulk_update' and org_id = pg_temp.id('org_a')) >= 3,
  'each committed call writes one records.bulk_update event');
select ok((select count(*) from app.audit_events where action = 'records.update' and subject_id = pg_temp.id('t1')) >= 2,
  'and each row change reaches the ledger through the records audit trail');
select is((select count(*)::int from app.audit_events where action = 'records.bulk_update' and diff ->> 'reason' = 'Erin owns load-in.'), 1,
  'the event names the reason');

-- Shifts, invoices and asset units --------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-01 08:00+00', '2027-06-01 16:00+00', 'America/New_York') returning id)
  insert into world select 's1', id from x;
with x as (insert into app.shifts (project_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '2027-06-01 08:00+00', '2027-06-01 16:00+00', 'America/New_York') returning id)
  insert into world select 's2', id from x;
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('shifts',
    (select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('shift_state', 'Published'))) from unnest(array['s1', 's2']) k)) r) x),
  '2', 'shifts publish in bulk');
select is((select count(*)::int from app.shifts where id in (pg_temp.id('s1'), pg_temp.id('s2')) and shift_state = 'Published'), 2, 'both are Published');

with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '0000.01.01-XOS-001', 'Stage Deck 4x8') returning id) insert into world select 'acls', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, condition_enum_id) values (pg_temp.id('acls'), 'NWL-DECK-101', 'ENM-017') returning id) insert into world select 'u1', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, condition_enum_id) values (pg_temp.id('acls'), 'NWL-DECK-102', 'ENM-017') returning id) insert into world select 'u2', id from x;
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('asset_units',
    (select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('asset_state', 'Received'))) from unnest(array['u1', 'u2']) k)) r) x),
  '2', 'asset units move along their lifecycle in bulk');

select lives_ok($$insert into world values ('cp_client', app.create_counterparty((select id from world where key = 'org_a'), 'Lakeshore Brands', null))$$, 'a client to bill');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code) values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'USD') returning id) insert into world select 'i1', id from x;
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('invoices',
    jsonb_build_array(jsonb_build_object('id', pg_temp.id('i1'), 'set', jsonb_build_object('invoice_state', 'Canceled'))), false, 'Duplicate draft.') r) x),
  '1', 'invoices change state in bulk through their RPCs');
select pg_temp.as_platform();

select * from finish();
rollback;
