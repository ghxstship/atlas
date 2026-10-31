-- pgTAP: migration 2697 (R7), the parity additions. Allowance overflow (refuse keeps refusing; review lets the request in,
-- approval needs a reason that lands in the ledger, a locked org refuse beats a project review, a split over the cap per
-- person still refuses) and app.allocation_allowances for the pool, the entries, a duty member and another party;
-- radio channels set as a whole with every refusal, no direct writes, kept out of Trash; availability over a window
-- with linear stock; and the conflicts view.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

select pg_temp.as_user('alice');
insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement, cap_per_person)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Radios', 'Provided', 4, 2);

-- Allowance overflow ---------------------------------------------------------------------------------------------------------
insert into world select 'four', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 4);
select pg_temp.as_user('carol');
select app.decide_allocation(pg_temp.id('four'), 'Approved');
select throws_ok($$select pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1)$$, 'XR001',
  'allocation_cap_engagement: This engagement may have 4 of this; the request goes beyond it.', 'with refuse, a request over the cap is refused');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.allowance_overflow', 'Project', pg_temp.id('prj_a'), 'review');
insert into world select 'extra', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select is(pg_temp.state_of(pg_temp.id('extra')), 'Requested', 'with review at the project, the same request goes in Requested');
insert into world select 'gone', pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_radio', 1);
select pg_temp.as_user('dave');
select app.withdraw_allocation(pg_temp.id('gone'));
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved')$$, pg_temp.id('extra')), 'XR001',
  'allocation_over_allowance_reason: This goes beyond the allowance by 1; give a reason of 1 to 1000 characters.',
  'approving it needs a reason');
select ok(app.decide_allocation(pg_temp.id('extra'), 'Approved', 'A spare for the monitor engineer.',
  jsonb_build_array(jsonb_build_object('source', 'Order Line', 'po_line_id', pg_temp.id('l_rent'), 'quantity', 1))), 'with a reason it is approved');
select pg_temp.as_platform();
select is((select reason from app.advance_allocation_state_transitions where advance_allocation_id = pg_temp.id('extra') and to_state = 'Approved'),
  'A spare for the monitor engineer.', 'and the ledger holds the reason');
select throws_ok($$select pg_temp.alloc('assign', 'carol', 'e_mo', 'class', 'cls_radio', 1)$$, 'XR001',
  'allocation_over_allowance_reason: This goes beyond the allowance by 2; give a reason of 1 to 1000 characters.',
  'assigning above the cap needs the reason in the note');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.split_allocation(%L, jsonb_build_array(jsonb_build_object('roster_entry_id', %L, 'quantity', 2)))$$,
  pg_temp.id('four'), pg_temp.id('e_kai')), 'XR001',
  'allocation_cap_person: This person may have 2 of this; the request goes beyond it.', 'a split over the cap per person still refuses');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.allowance_overflow', 'Organization', null, 'refuse', p_locked => true);
select throws_ok($$select pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_radio', 1)$$, 'XR001',
  'allocation_cap_engagement: This engagement may have 4 of this; the request goes beyond it.', 'a locked org refuse beats the project review');

-- Allowances ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select cap::text || ' ' || requested || ' ' || approved || ' ' || remaining || ' ' || beyond
           from app.allocation_allowances(pg_temp.id('eng_vendor_a')) where offering = 'Radios' and roster_entry_id is null),
  '4 0 5 0 1', 'the pool row: 5 approved against 4, none left, 1 beyond');
select is((select cap::text || ' ' || requested || ' ' || approved || ' ' || remaining || ' ' || beyond
           from app.allocation_allowances(pg_temp.id('eng_vendor_a')) where offering = 'Radios' and roster_entry_id = pg_temp.id('e_kai')),
  '2 0 1 1 0', 'Kai''s row: 1 of 2');
select is((select coalesce(cap::text, 'null') || ' ' || coalesce(remaining::text, 'null')
           from app.allocation_allowances(pg_temp.id('eng_vendor_a')) where offering = 'Travel' and roster_entry_id is null),
  'null null', 'no cap, no remaining');
select is((select count(*)::int from app.allocation_allowances(pg_temp.id('eng_vendor_a')) where offering = 'Guest List'), 0,
  'an offering not offered has no row');
select pg_temp.as_user('mo');
select is((select count(distinct coalesce(roster_entry_id::text, 'pool'))::int from app.allocation_allowances(pg_temp.id('eng_vendor_a'))), 1,
  'a duty Member reads only their own entry''s rows');
select is((select distinct roster_entry_id from app.allocation_allowances(pg_temp.id('eng_vendor_a'))), pg_temp.id('e_mo'), 'their own');
select pg_temp.as_user('pia');
select ok((select count(*) from app.allocation_allowances(pg_temp.id('eng_vendor_a')) where roster_entry_id is null) > 0,
  'the Advancing Lead reads the pool');
select pg_temp.as_user('quinn');
select throws_ok(format($$select * from app.allocation_allowances(%L)$$, pg_temp.id('eng_vendor_a')), '42501', null, 'another party gets 42501');

-- Radio channels -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.radio_channels (project_id, channel_number, name) values
  (pg_temp.id('prj_a'), 1, 'Production'), (pg_temp.id('prj_a'), 3, 'Audio'), (pg_temp.id('prj_a'), 5, 'Security');
insert into app.radio_channels (project_id, channel_number, name) values (pg_temp.id('prj_a2'), 1, 'Gala Production');
insert into world select 'ch' || channel_number, id from app.radio_channels where project_id = pg_temp.id('prj_a');
insert into world select 'ch_other', id from app.radio_channels where project_id = pg_temp.id('prj_a2');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.set_allocation_radio_channels(%L, array[%L, %L]::uuid[])$$, pg_temp.id('extra'), pg_temp.id('ch1'), pg_temp.id('ch3')),
  'channels 1 and 3 for Kai''s radio');
select app.set_allocation_radio_channels(pg_temp.id('extra'), array[pg_temp.id('ch3'), pg_temp.id('ch5')]);
select pg_temp.as_platform();
select is((select string_agg(c.channel_number::text, ',' order by c.channel_number) from app.allocation_radio_channels x
           join app.radio_channels c on c.id = x.radio_channel_id where x.advance_allocation_id = pg_temp.id('extra') and x.deleted_at is null),
  '3,5', 'setting again replaces the set');
select is((select count(*)::int from app.allocation_radio_channels where advance_allocation_id = pg_temp.id('extra') and deleted_at is not null), 1,
  'the dropped link is soft-deleted');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.set_allocation_radio_channels(%L, array[%L]::uuid[])$$, pg_temp.id('extra'), pg_temp.id('ch_other')), 'XR001',
  'allocation_channel_project: A radio is programmed with channels of its own project.', 'a channel of another project');
insert into world select 'badge', pg_temp.alloc('assign', 'carol', 'e_kai', 'category', 'cat_crew', 1);
select pg_temp.as_user('carol');
select throws_ok(format($$select app.set_allocation_radio_channels(%L, array[%L]::uuid[])$$, pg_temp.id('badge'), pg_temp.id('ch1')), 'XR001',
  'allocation_channel_not_asset: Only an asset allocation is programmed with radio channels.', 'a badge takes no channels');
insert into world select 'cable', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_cable', 1);
select pg_temp.as_user('carol');
select throws_ok(format($$select app.set_allocation_radio_channels(%L, array[%L]::uuid[])$$, pg_temp.id('cable'), pg_temp.id('ch1')), 'XR001',
  'allocation_channel_not_radio: Only radios are programmed with channels.', 'cable takes no channels');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.set_allocation_radio_channels(%L, array[%L]::uuid[])$$, pg_temp.id('gone'), pg_temp.id('ch1')), 'XR001',
  'allocation_channel_state: A declined or withdrawn allocation takes no channels.', 'a withdrawn allocation takes no channels');
select throws_ok(format($$select app.set_allocation_radio_channels(%L, array(select gen_random_uuid() from generate_series(1, 17)))$$, pg_temp.id('extra')),
  'XR001', 'allocation_channel_count: A radio is programmed with 0 to 16 channels.', 'at most 16 channels');
select throws_ok(format($$insert into app.allocation_radio_channels (advance_allocation_id, radio_channel_id) values (%L, %L)$$,
  pg_temp.id('extra'), pg_temp.id('ch1')), '42501', null, 'no direct insert');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.set_allocation_radio_channels(%L, '{}')$$, pg_temp.id('extra')), '42501', null, 'channels need advancing or radio rights');
select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'allocation_radio_channels'), 'kept out of Trash');
select ok(not exists (select 1 from private.trash_tables where table_name = 'allocation_radio_channels'), 'and not a Trash table');
select pg_temp.as_user('dave');
select is((select array_to_string(channel_numbers, ',') from app.radio_handout(pg_temp.id('prj_a')) where allocation_id = pg_temp.id('extra')), '3,5',
  'the hand-out reads the channels for a coordinator without safety.incident.read');

-- Availability -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select serviceable_units || ' ' || lot_quantity || ' ' || on_order_quantity || ' ' || total || ' ' || peak_reserved || ' ' || available
           from app.asset_class_availability(pg_temp.id('cls_radio'), '2027-06-01 12:00+00', '2027-06-05 12:00+00')),
  '4 0 2 6 5 1', 'four owned, two on hire, five held: one available');
select is((select peak_reserved from app.asset_class_availability(pg_temp.id('cls_radio'), '2027-08-01', '2027-08-02')), 0::numeric,
  'nothing held outside the window');
select throws_ok(format($$select * from app.asset_class_availability(%L, '2027-06-05', '2027-06-01')$$, pg_temp.id('cls_radio')), 'XR001',
  'availability_window: Ask for a window from a start to a later end, at most 400 days long.', 'a window runs forward');
select throws_ok(format($$select * from app.asset_class_availability(%L, '2027-01-01', '2028-06-01')$$, pg_temp.id('cls_radio')), 'XR001',
  'availability_window: Ask for a window from a start to a later end, at most 400 days long.', 'and lasts at most 400 days');
select pg_temp.as_user('quinn');
select throws_ok(format($$select * from app.asset_class_availability(%L, '2027-06-01', '2027-06-02')$$, pg_temp.id('cls_radio')), '42501', null,
  'availability needs assets or advancing rights in the org');
-- Linear stock.
insert into world select 'cable2', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_cable', 100.25);
select pg_temp.as_user('carol');
select is((select available || ' ' || unit_basis from app.asset_class_availability(pg_temp.id('cls_cable'), '2027-06-01 12:00+00', '2027-06-05 12:00+00')),
  '49.25 lot', 'a cable lot of 150.5 with 101.25 held leaves 49.25 in its unit');
select throws_ok($$select pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_cable', 60)$$, 'XR001',
  'reservation_over_capacity: Not enough of this class is free in that window.', 'a further 60 is refused');

-- Conflicts ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.offering_rules set deleted_at = now() where org_id = pg_temp.id('org_a') and offering = 'Radios';
insert into world select 'pinned', pg_temp.alloc('assign', 'carol', 'e_mo', 'class', 'cls_radio', 1, 'Spare.',
  jsonb_build_array(jsonb_build_object('source', 'Unit', 'asset_unit_id', pg_temp.id('r4'), 'quantity', 1)),
  '2027-09-01 12:00+00', '2027-09-02 12:00+00');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.asset_reservation_conflicts), 0, 'no conflicts yet');
select pg_temp.as_platform();
select private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions', 'asset_unit_id',
  pg_temp.id('r4'), 'Available', 'Deployed', 'Fixture.');
select private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions', 'asset_unit_id',
  pg_temp.id('r4'), 'Deployed', 'Damaged', 'Dropped.');
select pg_temp.as_user('carol');
select is((select conflict from app.asset_reservation_conflicts where allocation_id = pg_temp.id('pinned')), 'Unit Unavailable',
  'a damaged pinned unit is Unit Unavailable');
select pg_temp.as_user('carol');
select app.transition_purchase_order(pg_temp.id('po_rent'), 'Sent', 'Canceled', 'Hire fell through.');
select is((select string_agg(conflict, ',' order by conflict) from app.asset_reservation_conflicts where allocation_id = pg_temp.id('extra')),
  'Class Over Reserved,Order Short', 'a canceled order is Order Short, and the class no longer covers its holds');
select ok(not has_table_privilege('xos_backup', 'app.asset_reservation_conflicts', 'select'), 'xos_backup reads no conflicts');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.asset_reservation_conflicts), 0, 'someone outside the org reads none');

select * from finish();
rollback;
