-- pgTAP: migration 2694 (R7), cascades. Completing or canceling an engagement revokes its passes and badges and withdraws
-- its open allocations and those of its entries, by a person without credentials.credential.revoke, releasing holds
-- and telling each person once; custody stays out. A roster entry withdrawn, declined or removed withdraws its
-- allocations and revokes their credentials.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

create function pg_temp.notified(p_who text, p_kind text) returns integer
language sql security definer as $$
  select count(*)::int from app.notifications n where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind
$$;

insert into world select 'pass', pg_temp.alloc('assign', 'carol', 'e_kai', 'category', 'cat_park', 1);
insert into world select 'radio', pg_temp.alloc('assign', 'carol', 'e_kai', 'class', 'cls_radio', 1, null, null,
  now() - interval '1 hour', now() + interval '2 days');
insert into world select 'badge_req', pg_temp.alloc('request', 'dave', 'e_kai', 'category', 'cat_crew', 1);
insert into world select 'pool', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_radio', 2);
insert into world select 'mo_badge', pg_temp.alloc('assign', 'carol', 'e_mo', 'category', 'cat_crew', 1);
select pg_temp.as_user('carol');
select app.issue_allocation('01920000-0000-7000-8694-000000000001', pg_temp.id('pass'), '[{}]');
select app.issue_allocation('01920000-0000-7000-8694-000000000002', pg_temp.id('radio'), '[{"asset_tag": "NWL-RAD-001"}]');
select app.issue_allocation('01920000-0000-7000-8694-000000000003', pg_temp.id('mo_badge'), '[{}]');

-- A roster entry withdrawn --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_mo'), 'Mo moved to another tour.');
select pg_temp.as_platform();
select is((select allocation_state::text || ' ' || withdraw_cause::text from app.advance_allocations where id = pg_temp.id('mo_badge')),
  'Withdrawn Entry Removed', 'withdrawing the entry withdraws its allocation');
select isnt((select revoked_at from app.credentials where allocation_id = pg_temp.id('mo_badge')), null::timestamptz,
  'and revokes its badge, though the account owner holds no revoke capability');
select is((select revoked_by from app.credentials where allocation_id = pg_temp.id('mo_badge')), pg_temp.id('victor'), 'revoked by who withdrew the entry');
select is(pg_temp.notified('mo', 'allocation.withdrawn'), 1, 'Mo hears once');

-- Una declines her entry.
insert into world select 'una_req', pg_temp.alloc('request', 'dave', 'e_una', 'category', 'cat_crew', 1);
select pg_temp.as_user('una');
select app.respond_roster_entry(pg_temp.id('e_una'), 'Declined');
select pg_temp.as_platform();
select is((select withdraw_cause::text from app.advance_allocations where id = pg_temp.id('una_req')), 'Entry Removed', 'a decline by the person withdraws too');

-- The engagement completes ----------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.as_platform();
select is((select count(*)::int from app.advance_allocations where engagement_id = pg_temp.id('eng_vendor_a') and allocation_state = 'Withdrawn'), 0,
  'Closing withdraws nothing');
select pg_temp.as_user('carol');
select app.transition_engagement(pg_temp.id('eng_vendor_a'), 'Closing', 'Complete', 'Show over.');
select pg_temp.as_platform();
select isnt((select revoked_at from app.credentials where allocation_id = pg_temp.id('pass')), null::timestamptz, 'completing revokes the parking pass');
select is((select string_agg(withdraw_cause::text, ',' order by id) from app.advance_allocations
           where id in (pg_temp.id('pass'), pg_temp.id('radio'), pg_temp.id('badge_req'), pg_temp.id('pool'))),
  'Engagement Ended,Engagement Ended,Engagement Ended,Engagement Ended', 'and withdraws every open allocation of the engagement and its entries');
select is((select count(*)::int from app.asset_reservations where advance_allocation_id in (pg_temp.id('radio'), pg_temp.id('pool'))
           and released_at is null), 0, 'their holds are released');
select is((select string_agg(distinct release_reason::text, ',') from app.asset_reservations where advance_allocation_id = pg_temp.id('pool')),
  'Engagement Ended', 'with reason Engagement Ended');
select is((select asset_state::text from app.asset_units where id = pg_temp.id('r1')), 'Deployed', 'custody stays out');
select is(pg_temp.notified('kai', 'allocation.withdrawn'), 1, 'Kai hears once for all of his');

-- Canceled works the same way.
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
insert into world select 'ivy_pass', pg_temp.alloc('assign', 'carol', 'self_ivy', 'category', 'cat_park', 1);
select pg_temp.as_user('carol');
select app.issue_allocation('01920000-0000-7000-8694-000000000004', pg_temp.id('ivy_pass'), '[{}]');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Canceled');
select pg_temp.as_platform();
select isnt((select revoked_at from app.credentials where allocation_id = pg_temp.id('ivy_pass')), null::timestamptz, 'canceling revokes the pass');
select is((select withdraw_cause::text from app.advance_allocations where id = pg_temp.id('ivy_pass')), 'Engagement Ended', 'and withdraws it');

select * from finish();
rollback;
