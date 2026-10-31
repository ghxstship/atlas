-- pgTAP: migration 2700 (R8), the party side's allocation RPCs. The engaged person of an Artist engagement, an Advance
-- representative, an Account Owner, an Account Admin and an Advancing Lead request; a plain Account Member, a duty
-- Member and the worker a company sends are refused allocation_not_your_engagement, and a Complete engagement refuses.
-- Requestable items (allocation_not_requestable, allocation_item_kind, offering_not_offered) and both caps. A split makes
-- approved shares, moves holds and sends allocation.assigned; an unsplit gives them back; the person on the roster
-- withdraws a request they made while the engagement is live; a withdrawal refuses what was
-- issued. The bulk resource previews, commits, undoes through its inverse and refuses bulk_stale.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

insert into world values ('ev1', '01920000-0000-7000-8700-000000000001');

-- Ada, an Account Admin of Bayside Audio.
select pg_temp.new_user('ada', 'ada@bayside-audio.test', 'Ada Brandt');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('ada'), 'Account Admin');
select pg_temp.as_user('ada');
select app.accept_account_membership(pg_temp.membership('acct_v', 'ada'));
select pg_temp.as_platform();

-- Requests an engaged allocation as p_who, by world keys; p_entry and p_item may be NULL.
create function pg_temp.req(p_who text, p_engagement text, p_entry text, p_kind text, p_item text, p_quantity numeric,
  p_service text default null) returns uuid
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  return app.request_engaged_allocation(pg_temp.id(p_engagement), p_kind, p_quantity, '2027-06-01 12:00+00', '2027-06-05 12:00+00',
    'America/New_York', case when p_entry is not null then pg_temp.id(p_entry) end,
    case when p_item is not null then pg_temp.id(p_item) end, p_service::app.allocation_service_kind, null);
end $$;

create function pg_temp.notified(p_who text, p_kind text, p_subject uuid) returns integer
language sql security definer as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind and n.subject_id = p_subject
$$;

create function pg_temp.share_of(p_pool text, p_entry text) returns numeric
language sql security definer as $$
  select coalesce(sum(a.quantity), 0) from app.advance_allocations a
  where a.parent_allocation_id = pg_temp.id(p_pool) and a.roster_entry_id = pg_temp.id(p_entry)
    and a.allocation_state = 'Approved' and a.deleted_at is null
$$;

select pg_temp.as_user('alice');
insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement, cap_per_person)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Radios', 'Provided', 6, 2);

-- Who may ask ----------------------------------------------------------------------------------------------------------------
insert into world select 'v_pool', pg_temp.req('victor', 'eng_vendor_a', null, 'asset_class', 'cls_radio', 6);
select is(pg_temp.state_of(pg_temp.id('v_pool')), 'Requested', 'the Account Owner asks for six radios for the pool');
select pg_temp.as_platform();
select is((select created_by from app.advance_allocations where id = pg_temp.id('v_pool')), pg_temp.id('victor'),
  'with the Owner stamped as requester');
insert into world select 'badge', pg_temp.req('ada', 'eng_vendor_a', 'e_kai', 'credential_category', 'cat_crew', 1);
select is(pg_temp.state_of(pg_temp.id('badge')), 'Requested', 'an Account Admin asks for a badge for Kai: a credential need is a request');
insert into world select 'pd', pg_temp.req('pia', 'eng_vendor_a', 'e_mo', 'service', null, 1, 'Per Diem');
select is(pg_temp.state_of(pg_temp.id('pd')), 'Requested', 'an Advancing Lead asks for Mo''s per diem');
select lives_ok($$select pg_temp.req('art', 'eng_art_a', null, 'credential_category', 'cat_crew', 2)$$,
  'the engaged artist asks for the band''s badges');
select lives_ok($$select pg_temp.req('rita', 'eng_art_a', null, 'fulfillment', 'ful_cat', 4)$$,
  'and the artist''s Advance representative for catering');
select throws_ok($$select pg_temp.req('kai', 'eng_vendor_a', null, 'service', null, 1, 'Travel')$$, 'XR001',
  'allocation_not_your_engagement: Only the people who answer for this engagement ask for and share out what it needs.',
  'a plain Account Member is refused (decision 6)');
select throws_ok($$select pg_temp.req('mo', 'eng_vendor_a', null, 'service', null, 1, 'Travel')$$, 'XR001',
  'allocation_not_your_engagement: Only the people who answer for this engagement ask for and share out what it needs.',
  'so is a member assigned with the Member duty');
select throws_ok($$select pg_temp.req('sam', 'eng_vendor_a', null, 'service', null, 1, 'Travel')$$, 'XR001',
  'allocation_not_your_engagement: Only the people who answer for this engagement ask for and share out what it needs.',
  'and the worker the company sends');

-- What may be asked for ---------------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.req('victor', 'eng_vendor_a', 'self_art', 'service', null, 1, 'Travel')$$, 'XR001',
  'allocation_entry_not_on_engagement: That person is not on this engagement''s roster.', 'an entry of another engagement');
select throws_ok($$select pg_temp.req('victor', 'eng_vendor_a', null, 'asset_class', 'cls_cable', 1)$$, 'XR001',
  'allocation_not_requestable: That item is not one this project lets you ask for.', 'a class that answers for no offering');
select throws_ok($$select pg_temp.req('victor', 'eng_vendor_a', null, 'fulfillment', 'ful_trv', 1)$$, 'XR001',
  'allocation_not_requestable: That item is not one this project lets you ask for.', 'a fulfillment that is not Catering');
select throws_ok($$select pg_temp.req('victor', 'eng_vendor_a', null, 'service', null, 1)$$, 'XR001',
  'allocation_not_requestable: That item is not one this project lets you ask for.', 'a service names Travel or Per Diem');
select throws_ok($$select pg_temp.req('victor', 'eng_vendor_a', null, 'gadget', null, 1)$$, 'XR001',
  'allocation_item_kind: Ask for a credential, an asset, a catering, a room, travel or per diem.', 'an unknown item kind');
select pg_temp.as_user('alice');
insert into world values ('cls_cart', app.ensure_offering_asset_class(pg_temp.id('org_a'), 'Carts'));
select throws_ok($$select pg_temp.req('victor', 'eng_vendor_a', null, 'asset_class', 'cls_cart', 1)$$, 'XR001',
  'offering_not_offered: Carts is not offered on this engagement''s project.', 'only offered items are requested (decision 7)');
select throws_ok($$select pg_temp.req('victor', 'eng_vendor_a', null, 'asset_class', 'cls_radio', 1)$$, 'XR001',
  'allocation_cap_engagement: This engagement may have 6 of this; the request goes beyond it.', 'the cap per engagement');
select throws_ok($$select pg_temp.req('victor', 'eng_vendor_a', 'e_kai', 'asset_class', 'cls_radio', 3)$$, 'XR001',
  'allocation_cap_person: This person may have 2 of this; the request goes beyond it.', 'the cap per person');

-- A Complete engagement ---------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select lives_ok($$select pg_temp.req('ivy', 'eng_ivy_a', null, 'service', null, 1, 'Travel')$$,
  'an individually engaged crew member asks for their own travel');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select throws_ok($$select pg_temp.req('ivy', 'eng_ivy_a', null, 'service', null, 1, 'Travel')$$, 'XR001',
  'allocation_engagement_closed: The engagement is complete or canceled.', 'a Complete engagement refuses');

-- Reading: a plain member sees only their own rows ------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select is((select array_agg(allocation_id order by allocation_id) from api_external.advance_allocations),
  array[pg_temp.id('badge')], 'Kai reads only his own badge request');
select pg_temp.as_user('victor');
select ok((select count(*) from api_external.advance_allocations where engagement_id = pg_temp.id('eng_vendor_a')) = 3,
  'the Owner reads the pool and every person''s rows');

-- Sharing out ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select ok(app.decide_allocation(pg_temp.id('v_pool'), 'Approved', null, jsonb_build_array(
    jsonb_build_object('source', 'Class Stock', 'quantity', 4),
    jsonb_build_object('source', 'Order Line', 'po_line_id', pg_temp.id('l_rent'), 'quantity', 2))),
  'production approves the pool from stock and the rental line');
select pg_temp.as_user('kai');
select throws_ok(format($$select app.split_engaged_allocation(%L, jsonb_build_array(jsonb_build_object('roster_entry_id', %L, 'quantity', 1)))$$,
  pg_temp.id('v_pool'), pg_temp.id('e_kai')), 'XR001',
  'allocation_not_your_engagement: Only the people who answer for this engagement ask for and share out what it needs.',
  'a plain member does not share out the pool');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.split_engaged_allocation(%L, jsonb_build_array(jsonb_build_object('roster_entry_id', %L, 'quantity', 1)))$$,
  pg_temp.id('badge'), pg_temp.id('e_kai')), 'XR001',
  'allocation_not_pool: Only an approved allocation held by a party is split to its people.', 'only a pool is split');
create temporary table shares on commit drop as
select unnest(app.split_engaged_allocation(pg_temp.id('v_pool'), jsonb_build_array(
  jsonb_build_object('roster_entry_id', pg_temp.id('e_kai'), 'quantity', 1),
  jsonb_build_object('roster_entry_id', pg_temp.id('e_mo'), 'quantity', 1)))) as id;
select pg_temp.as_platform();
insert into world select 'kai_share', a.id from shares s join app.advance_allocations a on a.id = s.id
where a.roster_entry_id = pg_temp.id('e_kai');
insert into world select 'mo_share', a.id from shares s join app.advance_allocations a on a.id = s.id
where a.roster_entry_id = pg_temp.id('e_mo');
select pg_temp.as_platform();
select is((select string_agg(origin::text || ' ' || allocation_state::text, ',') from app.advance_allocations
           where parent_allocation_id = pg_temp.id('v_pool')), 'Split Approved,Split Approved', 'the Owner shares out two approved radios');
select is((select quantity from app.advance_allocations where id = pg_temp.id('v_pool')), 4::numeric, 'the pool keeps four');
select is(pg_temp.holds(pg_temp.id('kai_share')), 'stock:1', 'the share holds a radio from class stock');
select is(pg_temp.holds(pg_temp.id('v_pool')), 'line:2,stock:2', 'the pool''s stock hold went down by two');
select is(pg_temp.notified('kai', 'allocation.assigned', pg_temp.id('kai_share')), 1, 'allocation.assigned reaches Kai');

select pg_temp.as_user('pia');
select is(app.unsplit_engaged_allocation(pg_temp.id('mo_share')), 1::numeric, 'the Advancing Lead gives Mo''s radio back');
select pg_temp.as_platform();
select is((select allocation_state::text || ' ' || withdraw_cause::text from app.advance_allocations where id = pg_temp.id('mo_share')),
  'Withdrawn Requester', 'a share returned whole is Withdrawn by the requesting side');
select is((select quantity from app.advance_allocations where id = pg_temp.id('v_pool')), 5::numeric, 'and the pool has five again');

-- Withdrawing ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select throws_ok(format($$select app.withdraw_engaged_allocation(%L, 'Not needed.')$$, pg_temp.id('kai_share')), 'XR001',
  'allocation_not_your_engagement: Only the people who answer for this engagement ask for and share out what it needs.',
  'Kai does not withdraw a share someone else asked for');
select pg_temp.as_user('victor');
select lives_ok(format($$select app.withdraw_engaged_allocation(%L, 'Mo drives in.')$$, pg_temp.id('pd')),
  'the Owner withdraws a Requested per diem');
select is(pg_temp.state_of(pg_temp.id('pd')), 'Withdrawn', 'it is Withdrawn');
select pg_temp.as_user('carol');
select ok(app.decide_allocation(pg_temp.id('badge'), 'Approved'), 'production approves Kai''s badge');
select is((app.issue_allocation(pg_temp.id('ev1'), pg_temp.id('badge'), '[{}]')) ->> 'outcome', 'applied', 'and issues it');
select pg_temp.as_user('ada');
select throws_ok(format($$select app.withdraw_engaged_allocation(%L, 'Changed plans.')$$, pg_temp.id('badge')), 'XR001',
  'allocation_issued: Something of this allocation was issued; check it in or revoke it first.', 'an issued allocation stays');

-- Bulk assignment from the pool ----------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(exists (select 1 from private.bulk_resources where resource = 'engaged_allocation_assignments'),
  'assignments from a pool are a bulk resource');
create function pg_temp.assign_rows(p_quantity text, p_expect text default null) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object('id', pg_temp.id('e_kai'),
    'set', jsonb_build_object('pool_allocation_id', pg_temp.id('v_pool'), 'quantity', p_quantity))
    || case when p_expect is null then '{}'::jsonb
            else jsonb_build_object('expect', jsonb_build_object('pool_allocation_id', pg_temp.id('v_pool'), 'quantity', p_expect)) end)
$$;
select pg_temp.as_user('victor');
select is((app.bulk_update_engaged_allocation_assignments(pg_temp.assign_rows('2'), true) ->> 'committed')::boolean, false,
  'a preview commits nothing');
select is(pg_temp.share_of('v_pool', 'e_kai'), 1::numeric, 'and changes nothing');
select pg_temp.as_user('victor');
create temporary table outcome on commit drop as
select app.bulk_update_engaged_allocation_assignments(pg_temp.assign_rows('2', '1')) as o;
select is((select (o ->> 'changed')::int from outcome), 1, 'a commit gives Kai a second radio');
select is(pg_temp.share_of('v_pool', 'e_kai'), 2::numeric, 'Kai holds two');
select pg_temp.as_platform();
select is(pg_temp.notified('kai', 'allocation.assigned', (select a.id from app.advance_allocations a
  where a.parent_allocation_id = pg_temp.id('v_pool') and a.roster_entry_id = pg_temp.id('e_kai') and a.id <> pg_temp.id('kai_share')
  and a.allocation_state = 'Approved')), 1, 'and hears of the new share');
select pg_temp.as_user('victor');
select is((app.bulk_update_engaged_allocation_assignments((select o -> 'inverse' from outcome)) ->> 'committed')::boolean, true,
  'the inverse undoes it');
select is(pg_temp.share_of('v_pool', 'e_kai'), 1::numeric, 'Kai is back to one, the newest share returned first');
select pg_temp.as_user('victor');
select is(app.bulk_update_engaged_allocation_assignments((select o -> 'inverse' from outcome)) #>> '{refused,0,rule}', 'bulk_stale',
  'undoing twice is stale');
select pg_temp.as_user('pia');
select is(app.bulk_update_engaged_allocation_assignments(pg_temp.assign_rows('3')) #>> '{refused,0,rule}', 'allocation_cap_person',
  'a share stays within the cap per person');
select pg_temp.as_user('kai');
select is(app.bulk_update_engaged_allocation_assignments(pg_temp.assign_rows('2')) #>> '{refused,0,rule}', 'bulk_row_not_found',
  'a plain member reaches no row');

-- The person on the roster takes back their own request -------------------------------------------------------------------------
-- A per diem Kai asked for himself while he still answered for the company's side: the fixture stamps him as its
-- requester (created_by), past the audit trigger that keeps created_by on an update.
insert into world select 'kai_pd', pg_temp.req('victor', 'eng_vendor_a', 'e_kai', 'service', null, 1, 'Per Diem');
select pg_temp.as_platform();
alter table app.advance_allocations disable trigger t90_stamp_audit_columns;
update app.advance_allocations set created_by = pg_temp.id('kai') where id = pg_temp.id('kai_pd');
alter table app.advance_allocations enable trigger t90_stamp_audit_columns;
select pg_temp.as_user('kai');
select lives_ok(format($$select app.withdraw_engaged_allocation(%L, 'Driving in.')$$, pg_temp.id('kai_pd')),
  'Kai, now a plain member, withdraws the per diem he asked for');
select is(pg_temp.state_of(pg_temp.id('kai_pd')), 'Withdrawn', 'it is Withdrawn');
insert into world select 'kai_pd2', pg_temp.req('victor', 'eng_vendor_a', 'e_kai', 'service', null, 1, 'Per Diem');
select pg_temp.as_platform();
alter table app.advance_allocations disable trigger t90_stamp_audit_columns;
update app.advance_allocations set created_by = pg_temp.id('kai') where id = pg_temp.id('kai_pd2');
alter table app.advance_allocations enable trigger t90_stamp_audit_columns;
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select pg_temp.as_user('kai');
select throws_ok(format($$select app.withdraw_engaged_allocation(%L, 'Driving in.')$$, pg_temp.id('kai_pd2')), 'XR001',
  'allocation_not_your_engagement: Only the people who answer for this engagement ask for and share out what it needs.',
  'once the engagement is complete, his roster entry no longer reaches it');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.withdraw_engaged_allocation(%L, 'Driving in.')$$, pg_temp.id('kai_pd2')), 'XR001',
  'allocation_engagement_closed: The engagement is complete or canceled.', 'and the party side reads it as closed');

select * from finish();
rollback;
