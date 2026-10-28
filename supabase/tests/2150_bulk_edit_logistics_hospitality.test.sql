-- pgTAP: 2150, bulk edit of shipments, dock slots, fulfillments, BEOs and room blocks (A121, RRR-167, Section 11.7).
-- For each resource: a preview changes nothing, a commit changes every row, the inverse undoes it, one refused row
-- rolls back the whole call, another org's row is refused as not found, and the rules a single edit meets still apply
-- (the dock overlap and check-in freeze, the fulfillment lifecycle, the BEO approval authority and its separation from
-- the author, the canon freight types). Each table gains the audit trail, and each call writes one audit event.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(47);

create temporary table answer (key text primary key, r jsonb);
grant all on answer to public;

create function pg_temp.bulk(p_resource text, p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language plpgsql as $$
begin
  return case p_resource
    when 'shipments' then app.bulk_update_shipments(p_rows, p_preview, p_reason)
    when 'dock_slots' then app.bulk_update_dock_slots(p_rows, p_preview, p_reason)
    when 'fulfillments' then app.bulk_update_fulfillments(p_rows, p_preview, p_reason)
    when 'beos' then app.bulk_update_beos(p_rows, p_preview, p_reason)
    when 'accommodation_blocks' then app.bulk_update_accommodation_blocks(p_rows, p_preview, p_reason)
  end;
end $$;

-- Rows setting one field to one value; a text value is a world key when it names one, else itself.
create function pg_temp.rows(p_keys text[], p_field text, p_value text) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set',
    jsonb_build_object(p_field, case when p_value is null then null
      else to_jsonb(coalesce(pg_temp.id(p_value)::text, p_value)) end)))
  from unnest(p_keys) k;
$$;

-- The first canon Freight Type row, a text id the world table (uuids) cannot hold.
create function pg_temp.freight() returns text
language sql stable as $$
  select record_id from xpms.std_enumeration where enum_domain = 'Freight Type' order by record_id limit 1
$$;

create function pg_temp.keep(p_key text, p_answer jsonb) returns jsonb
language sql as $$ insert into answer values (p_key, p_answer) returning r $$;

create function pg_temp.got(p_key text) returns jsonb
language sql as $$ select r from answer where key = p_key $$;

-- Fixtures: two docks, two carriers and a hotel of org A, one counterparty of org B ---------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-A', 'Dock A') returning id) insert into world select 'dock_a', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-B', 'Dock B') returning id) insert into world select 'dock_b', id from x;
select pg_temp.as_platform();
with x as (insert into app.counterparties (org_id, organization_id) values (pg_temp.id('org_a'), pg_temp.id('org_b')) returning id) insert into world select 'carrier', id from x;
with x as (insert into app.counterparties (org_id, organization_id) values (pg_temp.id('org_a'), pg_temp.id('org_c')) returning id) insert into world select 'hotel', id from x;
with x as (insert into app.counterparties (org_id, organization_id) values (pg_temp.id('org_b'), pg_temp.id('org_c')) returning id) insert into world select 'b_party', id from x;

select pg_temp.as_user('dave');
with x as (insert into app.shipments (project_id, direction) values (pg_temp.id('prj_a'), 'Inbound') returning id) insert into world select 's1', id from x;
with x as (insert into app.shipments (project_id, direction) values (pg_temp.id('prj_a'), 'Inbound') returning id) insert into world select 's2', id from x;
with x as (insert into app.dock_slots (project_id, zone_id, starts_at, ends_at)
  values (pg_temp.id('prj_a'), pg_temp.id('dock_a'), '2027-06-01 06:00+00', '2027-06-01 08:00+00') returning id) insert into world select 'd1', id from x;
with x as (insert into app.dock_slots (project_id, zone_id, starts_at, ends_at)
  values (pg_temp.id('prj_a'), pg_temp.id('dock_a'), '2027-06-01 09:00+00', '2027-06-01 10:00+00') returning id) insert into world select 'd2', id from x;
with x as (insert into app.dock_slots (project_id, zone_id, starts_at, ends_at)
  values (pg_temp.id('prj_a'), pg_temp.id('dock_b'), '2027-06-01 07:00+00', '2027-06-01 07:30+00') returning id) insert into world select 'd_busy', id from x;
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Catering', 'Crew Lunch') returning id) insert into world select 'f1', id from x;
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Catering', 'Crew Dinner') returning id) insert into world select 'f2', id from x;
with x as (insert into app.beos (project_id, event_at, guest_count) values (pg_temp.id('prj_a'), '2027-06-01 17:00+00', 80) returning id) insert into world select 'b1', id from x;
with x as (insert into app.beos (project_id, event_at, guest_count) values (pg_temp.id('prj_a'), '2027-06-02 17:00+00', 90) returning id) insert into world select 'b2', id from x;
with x as (insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held)
  values (pg_temp.id('prj_a'), 'Crew Block', '2027-06-01', '2027-06-04', 4) returning id) insert into world select 'r1', id from x;
with x as (insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held)
  values (pg_temp.id('prj_a'), 'Talent Block', '2027-06-01', '2027-06-03', 2) returning id) insert into world select 'r2', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.shipments (project_id, direction) values (pg_temp.id('prj_a2'), 'Outbound') returning id) insert into world select 's_other', id from x;
select pg_temp.as_user('xavier');
with x as (insert into app.shipments (project_id, direction) values (pg_temp.id('prj_b'), 'Inbound') returning id) insert into world select 's_b', id from x;

-- Shipments ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(pg_temp.bulk('shipments', pg_temp.rows(array['s1', 's2'], 'freight_type_enum_id', pg_temp.freight()), true) ->> 'changed', '2',
  'a shipment preview counts both rows');
select is((select freight_type_enum_id from app.shipments where id = pg_temp.id('s1')), null, 'and changes nothing');
select is(pg_temp.keep('ship', pg_temp.bulk('shipments', pg_temp.rows(array['s1', 's2'], 'freight_type_enum_id', pg_temp.freight()))) ->> 'committed', 'true',
  'a freight type changes in bulk');
select is((select count(*)::int from app.shipments where id in (pg_temp.id('s1'), pg_temp.id('s2')) and freight_type_enum_id = pg_temp.freight()), 2,
  'both shipments carry the new freight type');
select is(pg_temp.bulk('shipments', pg_temp.got('ship') -> 'inverse') ->> 'committed', 'true', 'sending the inverse back undoes it');
select is((select count(*)::int from app.shipments where id in (pg_temp.id('s1'), pg_temp.id('s2')) and freight_type_enum_id is null), 2,
  'both shipments are unset again');
select is(pg_temp.bulk('shipments', pg_temp.rows(array['s1'], 'freight_type_enum_id', 'ENM-082')) -> 'refused' -> 0 ->> 'rule', 'enumeration_domain',
  'a value outside the Freight Type enumeration is refused');
select is(pg_temp.bulk('shipments', pg_temp.rows(array['s1', 's2'], 'carrier_counterparty_id', 'carrier')) ->> 'changed', '2', 'the carrier changes in bulk');
select is(pg_temp.bulk('shipments', pg_temp.rows(array['s1'], 'carrier_counterparty_id', 'b_party')) -> 'refused' -> 0 ->> 'id', pg_temp.id('s1')::text,
  'a carrier of another org is refused against its row');
select is(pg_temp.bulk('shipments', pg_temp.rows(array['s1', 's2'], 'direction', 'Outbound')) ->> 'changed', '2', 'the direction changes in bulk');
select is(pg_temp.keep('ship_mixed', pg_temp.bulk('shipments', pg_temp.rows(array['s1', 's_other'], 'direction', 'Inbound'))) ->> 'committed', 'false',
  'a call with a shipment of a project the caller is not on commits nothing');
select is((select direction::text from app.shipments where id = pg_temp.id('s1')), 'Outbound', 'so the allowed row keeps its direction');
select is(pg_temp.got('ship_mixed') -> 'refused' -> 0 ->> 'rule', 'bulk_row_not_found', 'and the other reads as not found (invariant 2)');
select is(pg_temp.bulk('shipments', pg_temp.rows(array['s_b'], 'direction', 'Outbound')) -> 'refused' -> 0 ->> 'rule', 'bulk_row_not_found',
  'another org''s shipment is refused as not found');
select is(pg_temp.bulk('shipments', pg_temp.rows(array['s1'], 'tracking_identifier', '1Z999')) -> 'refused' -> 0 ->> 'rule', 'bulk_field_not_editable',
  'only the editable fields change in bulk');
select pg_temp.as_platform();
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a2'), pg_temp.id('gina@org_a'), 'Coordinator');
select pg_temp.as_user('gina');
select is(pg_temp.bulk('shipments', pg_temp.rows(array['s_other'], 'direction', 'Inbound')) -> 'refused' -> 0 ->> 'rule', 'not_allowed',
  'a Viewer on the project reads its shipments but cannot change them');

-- Dock slots ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(pg_temp.keep('dock', pg_temp.bulk('dock_slots', pg_temp.rows(array['d2'], 'zone_id', 'dock_b'))) ->> 'committed', 'true',
  'a dock slot moves to another dock');
select is((select zone_id from app.dock_slots where id = pg_temp.id('d2')), pg_temp.id('dock_b'), 'and lands there');
select is(pg_temp.bulk('dock_slots', pg_temp.got('dock') -> 'inverse') ->> 'committed', 'true', 'the inverse moves it back');
select is((select zone_id from app.dock_slots where id = pg_temp.id('d2')), pg_temp.id('dock_a'), 'to its first dock');
select is(pg_temp.keep('dock_overlap', pg_temp.bulk('dock_slots', pg_temp.rows(array['d1', 'd2'], 'zone_id', 'dock_b'))) -> 'refused' -> 0 ->> 'rule',
  'dock_slot_overlap', 'a move onto a dock already booked then is refused');
select is((select zone_id from app.dock_slots where id = pg_temp.id('d2')), pg_temp.id('dock_a'), 'and the row that fit stays put too');
select pg_temp.as_user('frank');
update app.dock_slots set checked_in_at = now() where id = pg_temp.id('d2');
select pg_temp.as_user('dave');
select is(pg_temp.bulk('dock_slots', pg_temp.rows(array['d2'], 'zone_id', 'dock_b')) -> 'refused' -> 0 ->> 'rule', 'dock_slot_checked_in',
  'a checked-in slot keeps its dock');

-- Fulfillments ---------------------------------------------------------------------------------------------------------------
select is(pg_temp.keep('ful', pg_temp.bulk('fulfillments', pg_temp.rows(array['f1', 'f2'], 'fulfillment_state', 'Active'), false, 'Caterer confirmed.')) ->> 'changed',
  '2', 'fulfillments move along their lifecycle in bulk');
select is((select count(*)::int from app.fulfillment_state_transitions
  where fulfillment_id in (pg_temp.id('f1'), pg_temp.id('f2')) and to_state = 'Active' and reason = 'Caterer confirmed.'), 2,
  'with a ledger entry carrying the reason');
select is(pg_temp.bulk('fulfillments', pg_temp.got('ful') -> 'inverse') -> 'refused' -> 0 ->> 'rule', 'fulfillment_transition_not_allowed',
  'an undo the lifecycle forbids (Active back to Proposed) is refused');
select is(pg_temp.bulk('fulfillments', pg_temp.rows(array['f1'], 'fulfillment_state', 'Proposed')) -> 'refused' -> 0 ->> 'rule',
  'fulfillment_transition_not_allowed', 'as is any move the lifecycle forbids');
select is(pg_temp.keep('ful_sup', pg_temp.bulk('fulfillments', pg_temp.rows(array['f1', 'f2'], 'counterparty_id', 'hotel'))) ->> 'changed', '2',
  'the supplier changes in bulk');
select is(pg_temp.bulk('fulfillments', pg_temp.got('ful_sup') -> 'inverse') ->> 'committed', 'true', 'and that undoes');
select is((select count(*)::int from app.fulfillments where id in (pg_temp.id('f1'), pg_temp.id('f2')) and counterparty_id is null), 2,
  'leaving both without a supplier');

-- BEOs ---------------------------------------------------------------------------------------------------------------------
select is(pg_temp.bulk('beos', jsonb_build_array(jsonb_build_object('id', pg_temp.id('b1'), 'set', jsonb_build_object('approved_at', true))))
  -> 'refused' -> 0 ->> 'rule', 'sod_approval_requester', 'the author cannot approve a BEO in bulk either');
select is((select approved_at from app.beos where id = pg_temp.id('b1')), null, 'and nothing is approved');
select pg_temp.as_user('alice');
select is(pg_temp.bulk('beos', jsonb_build_array(
    jsonb_build_object('id', pg_temp.id('b1'), 'set', jsonb_build_object('approved_at', true)),
    jsonb_build_object('id', pg_temp.id('b2'), 'set', jsonb_build_object('approved_at', true))), true) ->> 'changed', '2',
  'an approver previews approving two BEOs');
select is(pg_temp.keep('beo', pg_temp.bulk('beos', jsonb_build_array(
    jsonb_build_object('id', pg_temp.id('b1'), 'set', jsonb_build_object('approved_at', true)),
    jsonb_build_object('id', pg_temp.id('b2'), 'set', jsonb_build_object('approved_at', true))))) ->> 'committed', 'true',
  'and approves them in one call');
select is((select count(*)::int from app.beos where id in (pg_temp.id('b1'), pg_temp.id('b2')) and approved_by = pg_temp.id('alice')), 2,
  'each approval is stamped with the approver');
select is(pg_temp.bulk('beos', pg_temp.got('beo') -> 'inverse') -> 'refused' -> 0 ->> 'rule', 'beo_approved',
  'an approval cannot be undone: an approved BEO stays approved');

-- Room blocks --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(pg_temp.keep('blk', pg_temp.bulk('accommodation_blocks', pg_temp.rows(array['r1', 'r2'], 'counterparty_id', 'hotel'))) ->> 'changed', '2',
  'room blocks change hotel in bulk');
select is((select count(*)::int from app.accommodation_blocks where id in (pg_temp.id('r1'), pg_temp.id('r2')) and counterparty_id = pg_temp.id('hotel')), 2,
  'both blocks are held by the new hotel');
select is(pg_temp.bulk('accommodation_blocks', pg_temp.got('blk') -> 'inverse') ->> 'committed', 'true', 'the inverse undoes it');
select is(pg_temp.bulk('accommodation_blocks', pg_temp.got('blk') -> 'inverse') -> 'refused' -> 0 ->> 'rule', 'bulk_stale',
  'and a second undo of rows changed since is refused, never silently overwritten');
select pg_temp.as_user('gina');
select is(pg_temp.bulk('accommodation_blocks', pg_temp.rows(array['r1'], 'counterparty_id', 'hotel')) -> 'refused' -> 0 ->> 'rule', 'bulk_row_not_found',
  'a Viewer outside the project cannot change room blocks');

-- Callers, audit -------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select app.bulk_update_shipments('[]'::jsonb)$$, '42501', null, 'anon cannot call bulk edit of shipments');
select throws_ok($$select app.bulk_update_beos('[]'::jsonb)$$, '42501', null, 'nor of BEOs');
select pg_temp.as_platform();
select is((select count(*)::int from private.bulk_resources where resource in ('shipments', 'dock_slots', 'fulfillments', 'beos', 'accommodation_blocks')), 5,
  'the five resources are registered with the driver');
select ok((select count(*) from app.audit_events where org_id = pg_temp.id('org_a') and action = 'shipments.bulk_update') >= 3,
  'each committed shipment call writes one shipments.bulk_update audit event');
select ok(exists (select 1 from app.audit_events where org_id = pg_temp.id('org_a') and action = 'shipments.update' and subject_id = pg_temp.id('s1')),
  'and each row change reaches the ledger through the table''s audit trail');
select is((select count(*)::int from pg_catalog.pg_trigger where tgname = 't85_audit_trail'
  and tgrelid in ('app.shipments'::regclass, 'app.dock_slots'::regclass, 'app.fulfillments'::regclass, 'app.beos'::regclass, 'app.accommodation_blocks'::regclass)), 5,
  'the five tables carry the audit trail');

select * from finish();
rollback;
