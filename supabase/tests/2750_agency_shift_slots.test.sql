-- pgTAP: migration 2750 (R12), agency slots and roster shifts. Only a Staff company engagement can be a slot; a shift
-- names at most one worker column; members neither see nor claim slots or roster shifts; placing a roster person on a
-- published slot tells them (shift.assigned) and refreshes their sync scope; api_external.shifts shows a lead the slots
-- and holder names, the placed person only their own, and nothing to an unassigned Account Member, another party or
-- anyone once the engagement is Complete.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

-- What a slot is ------------------------------------------------------------------------------------------------------------
select ok(private.is_agency_slot_engagement(pg_temp.id('eng_agency')), 'a Staff company engagement with no person is an agency slot');
select ok(not private.is_agency_slot_engagement(pg_temp.id('eng_vendor_a')), 'a Vendor company engagement is not');
select ok(not private.is_agency_slot_engagement(pg_temp.id('eng_ivy_a')), 'nor a freelancer''s own engagement');
select pg_temp.as_user('carol');
with e as (insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-01') returning id)
  insert into world select 'eng_vendor_company', id from e;
select pg_temp.as_platform();
select ok(not private.is_agency_slot_engagement(pg_temp.id('eng_vendor_company')), 'nor a Vendor company engagement with no person');
select pg_temp.as_user('carol');
select is(pg_temp.refusal($$insert into app.shifts (project_id, engagement_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_vendor_company'), pg_temp.at_day(30), pg_temp.at_day(34), 'America/New_York')$$),
  'engagement_worker_person', 'so a shift cannot name it');
select lives_ok($$insert into app.shifts (project_id, engagement_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_agency'), pg_temp.at_day(30), pg_temp.at_day(34), 'America/New_York')$$,
  'while a shift writer allocates an agency slot');

-- One worker ------------------------------------------------------------------------------------------------------------------
select throws_ok($$insert into app.shifts (project_id, membership_id, engagement_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), pg_temp.id('eng_agency'), pg_temp.at_day(30), pg_temp.at_day(34), 'America/New_York')$$,
  '23514', null, 'a shift names at most one worker column');
select is(pg_temp.refusal($$insert into app.shifts (project_id, roster_entry_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), pg_temp.at_day(30), pg_temp.at_day(34), 'America/New_York')$$),
  'roster_shift_rpc', 'a roster entry is put on a shift only through app.assign_roster_shift');
select is(pg_temp.refusal($$update app.shifts set roster_entry_id = pg_temp.id('e_stella'), engagement_id = null where id = pg_temp.id('slot_1')$$),
  'roster_shift_rpc', 'even by a shift writer');

-- Members and open shifts -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::int from app.shifts where id in (pg_temp.id('slot_1'), pg_temp.id('slot_2'))), 0,
  'a field member sees no agency slot among the open shifts');
select is((select count(*)::int from app.shifts where id = pg_temp.id('sh_open')), 1, 'and still sees the open shift');
select is(pg_temp.refusal($$select app.claim_open_shift(pg_temp.id('slot_1'))$$), 'shift_already_claimed', 'nor claims a slot');
select pg_temp.as_user('carol');
select is(pg_temp.refusal($$select app.assign_open_shift(pg_temp.id('slot_1'), pg_temp.id('dave@org_a'))$$), 'shift_already_filled',
  'the drag board fills no agency slot with a member');

-- Placing Stella ------------------------------------------------------------------------------------------------------------------
-- Her scopes are cleared first, so their return shows the shift trigger refreshed them.
select pg_temp.as_platform();
delete from private.sync_scope_grants where person_user_id = pg_temp.id('stella_user');
select pg_temp.as_user('olga');
select is(app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella')), pg_temp.id('slot_1'), 'the agency lead places Stella on slot 1');
select pg_temp.as_platform();
select is((select num_nonnulls(membership_id, engagement_id, roster_entry_id) || ':' || roster_entry_id::text from app.shifts where id = pg_temp.id('slot_1')),
  '1:' || pg_temp.id('e_stella')::text, 'the shift names the entry and no longer the engagement');
select is(pg_temp.notified('stella', 'shift.assigned', 'slot_1'), 1, 'Stella is told the shift is hers');
select is((select array_agg(scope_value) from private.sync_scope_grants where person_user_id = pg_temp.id('stella_user') and scope_key = 'rosterEntryIds'),
  array[pg_temp.id('e_stella')::text], 'and her sync scopes were refreshed');

select pg_temp.as_user('frank');
select is((select count(*)::int from app.shifts where id = pg_temp.id('slot_1')), 0, 'a member never sees a roster shift');
select is(pg_temp.refusal($$select app.claim_open_shift(pg_temp.id('slot_1'))$$), 'shift_already_claimed', 'nor claims one');

-- api_external.shifts ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('olga');
select is((select array_agg(id::text || ':' || coalesce(holder_name, '-') || ':' || is_agency_slot order by starts_at, id) from api_external.shifts),
  array[pg_temp.id('slot_1')::text || ':Stella Okafor:false', pg_temp.id('slot_2')::text || ':-:true'],
  'the lead reads the slot Stella holds, with her name, and the open slot');
select pg_temp.as_user('stella');
select is((select array_agg(id::text || ':' || coalesce(holder_name, '-')) from api_external.shifts),
  array[pg_temp.id('slot_1')::text || ':Stella Okafor'], 'Stella reads only her own shift');
select pg_temp.as_user('theo');
select is((select count(*)::int from api_external.shifts), 0, 'Theo, on the roster but not placed, reads none');
select pg_temp.as_user('uma');
select is((select count(*)::int from api_external.shifts), 0, 'an unassigned Account Member of the agency is denied (decision 6)');
select pg_temp.as_user('victor');
select is((select count(*)::int from api_external.shifts where id in (pg_temp.id('slot_1'), pg_temp.id('slot_2'))), 0,
  'another party reads neither');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
           where table_schema = 'api_external' and table_name = 'shifts'),
  array['id', 'engagement_id', 'project_id', 'project_name', 'scope_node_id', 'scope_node_name', 'role_code', 'job_title',
        'starts_at', 'ends_at', 'time_zone', 'shift_state', 'roster_entry_id', 'holder_name', 'is_agency_slot'],
  'no internal column appears');

select pg_temp.move_engagement('eng_agency', 'Active', 'Closing');
select pg_temp.move_engagement('eng_agency', 'Closing', 'Complete');
select pg_temp.as_user('olga');
select is((select count(*)::int from api_external.shifts), 0, 'the lead reads nothing once the engagement is Complete');
select pg_temp.as_user('stella');
select is((select count(*)::int from api_external.shifts), 0, 'nor does Stella');

select * from finish();
rollback;
