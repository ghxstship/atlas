-- pgTAP: migration 2605 (RRR-209 interim), Account Member reads of per diems and lot movements. For a vendor-supplied
-- person (sam, supplied by Bayside Audio), an Account Member who is not that person and not assigned to the engagement
-- (mo) reads neither its per diems nor its lot movements from the tables; the account's Owner and
-- Admin still read both, and so does sam. Org readers with crew.time_entry.read or assets.asset.read, a member's own
-- rows, and an artist's Advance representative read as before. Account Finance, an unrelated person and another
-- tenant read nothing. The engagement branch keeps its time box. Policies, comments and grants are checked.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.per_diems(p_who text, p_engagement text) returns integer
language sql as $$
  select pg_temp.n(p_who, format('select 1 from app.per_diems where engagement_id = %L', pg_temp.id(p_engagement)));
$$;

create function pg_temp.lot_moves(p_who text, p_engagement text) returns integer
language sql as $$
  select pg_temp.n(p_who, format('select 1 from app.asset_lot_movements where custodian_engagement_id = %L', pg_temp.id(p_engagement)));
$$;

-- The account's Admin and a second Account Member who is not the supplied person (as in 2601).
select pg_temp.new_user('ada', 'ada@bayside-audio.test', 'Ada Brennan');
select pg_temp.new_user('mo', 'mo@bayside-audio.test', 'Mo Lindqvist');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('ada'), 'Account Admin');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('mo'), 'Account Member');
select pg_temp.as_platform();

select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');

-- Per diems: one for sam's vendor engagement, one for the artist's, one for a member (frank).
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.per_diem', 'Project', pg_temp.id('prj_a'), 'provided');
insert into app.per_diems (project_id, engagement_id, day, amount_minor, currency_code) values
  (pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), '2027-06-01', 6500, 'USD'),
  (pg_temp.id('prj_a'), pg_temp.id('eng_art_a'), '2027-06-02', 9000, 'USD');
insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-01', 5000, 'USD');
select pg_temp.as_platform();

-- Lot movements: a check-out to each engagement and one to a member (frank).
select pg_temp.as_user('carol');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '9000.03.01-XPMS-003', 'Digital Two-Way Radio') returning id)
  insert into world select 'cls', id from x;
with x as (insert into app.asset_lots (asset_class_id, venue_id, quantity) values (pg_temp.id('cls'), pg_temp.id('venue_a'), 20) returning id)
  insert into world select 'lot', id from x;
insert into world values
  ('ev1', '01920000-0000-7000-8240-000000000001'), ('ev2', '01920000-0000-7000-8240-000000000002'),
  ('ev3', '01920000-0000-7000-8240-000000000003');
select is((select outcome from app.apply_asset_scan(pg_temp.id('ev1'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-out',
    null, pg_temp.id('eng_vendor_a'), null, null, null, 4)), 'applied', 'four radios go out to sam''s vendor engagement');
select is((select outcome from app.apply_asset_scan(pg_temp.id('ev2'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-out',
    null, pg_temp.id('eng_art_a'), null, null, null, 2)), 'applied', 'two go out to the artist''s engagement');
select is((select outcome from app.apply_asset_scan(pg_temp.id('ev3'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-out',
    pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'), null, 1)), 'applied', 'and one to a member');
select pg_temp.as_platform();

-- The Account Member is refused both reads ---------------------------------------------------------------------------------
-- The helper is asked as postgres with mo's claims: signed-in users have no usage on schema private.
select pg_temp.as_user('mo');
select set_config('role', 'postgres', true);
-- Since R4 (2632) an Account Member reaches only the engagements assigned to them, so mo, who is not assigned, no longer
-- reaches the operational area at all; 2605's policies refuse the reads either way.
select ok(pg_temp.id('eng_vendor_a') not in (select private.my_engagement_ids('operational')),
  'an unassigned Account Member does not reach the engagement''s operational area (R4, 2632)');
select pg_temp.as_platform();
select is(pg_temp.per_diems('mo', 'eng_vendor_a'), 0, 'an Account Member does not read the supplied person''s per diems');
select is(pg_temp.lot_moves('mo', 'eng_vendor_a'), 0, 'nor the lot movements made to the supplied person''s engagement');
select is(pg_temp.n('mo', 'select 1 from app.per_diems'), 0, 'an Account Member reads no per diem at all');
select is(pg_temp.n('mo', 'select 1 from app.asset_lot_movements'), 0, 'and no lot movement');

-- The account's Owner and Admin still read ----------------------------------------------------------------------------------
select is(pg_temp.per_diems('victor', 'eng_vendor_a'), 1, 'the Account Owner reads the supplied person''s per diem');
select is(pg_temp.lot_moves('victor', 'eng_vendor_a'), 1, 'and the lot movement');
select is(pg_temp.per_diems('ada', 'eng_vendor_a'), 1, 'the Account Admin reads the per diem');
select is(pg_temp.lot_moves('ada', 'eng_vendor_a'), 1, 'and the lot movement');
select is(pg_temp.per_diems('victor', 'eng_art_a'), 0, 'the vendor account does not read another engagement''s per diems');
select is(pg_temp.lot_moves('victor', 'eng_art_a'), 0, 'nor its lot movements');

-- The person themselves, and the artist's Advance representative ------------------------------------------------------------
select is(pg_temp.per_diems('sam', 'eng_vendor_a'), 1, 'the supplied person reads their own per diem, though also an Account Member');
select is(pg_temp.lot_moves('sam', 'eng_vendor_a'), 1, 'and the lot movement made to their engagement');
select is(pg_temp.n('sam', 'select 1 from app.per_diems'), 1, 'and nothing else');
select is(pg_temp.per_diems('art', 'eng_art_a'), 1, 'the artist reads their own per diem');
select is(pg_temp.lot_moves('art', 'eng_art_a'), 1, 'and their lot movement');
select is(pg_temp.per_diems('rita', 'eng_art_a'), 1, 'the artist''s Advance representative reads the per diem');
select is(pg_temp.lot_moves('rita', 'eng_art_a'), 1, 'and the lot movement');
select is(pg_temp.n('frank', format('select 1 from app.per_diems where membership_id = %L', pg_temp.id('frank@org_a'))), 1,
  'a member reads their own per diem');
select is(pg_temp.n('frank', format('select 1 from app.asset_lot_movements where custodian_membership_id = %L', pg_temp.id('frank@org_a'))), 1,
  'and the lot movement made to them');

-- Org readers with the capability still read ---------------------------------------------------------------------------------
select is(pg_temp.n('carol', format('select 1 from app.per_diems where project_id = %L', pg_temp.id('prj_a'))), 3,
  'an org Manager with crew.time_entry.read reads every per diem of the project');
select is(pg_temp.n('carol', format('select 1 from app.asset_lot_movements where asset_lot_id = %L', pg_temp.id('lot'))), 3,
  'and, with assets.asset.read, every movement of the lot');
select is(pg_temp.n('alice', format('select 1 from app.per_diems where project_id = %L', pg_temp.id('prj_a'))), 3, 'so does the org Owner');
select is(pg_temp.n('alice', format('select 1 from app.asset_lot_movements where asset_lot_id = %L', pg_temp.id('lot'))), 3, 'for both');

-- Others read nothing ---------------------------------------------------------------------------------------------------------
select is(pg_temp.per_diems('fiona', 'eng_vendor_a'), 0, 'Account Finance does not read the per diem');
select is(pg_temp.lot_moves('fiona', 'eng_vendor_a'), 0, 'nor the lot movement');
select is(pg_temp.n('ivy', 'select 1 from app.per_diems'), 0, 'an unrelated person reads no per diem');
select is(pg_temp.n('ivy', 'select 1 from app.asset_lot_movements'), 0, 'and no lot movement');
select is(pg_temp.n('xavier', 'select 1 from app.per_diems'), 0, 'another tenant reads no per diem');
select is(pg_temp.n('xavier', 'select 1 from app.asset_lot_movements'), 0, 'and no lot movement');

-- The time box still applies ---------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select is(pg_temp.per_diems('victor', 'eng_vendor_a'), 1, 'Closing keeps the operational area open for the Owner');
select is(pg_temp.per_diems('mo', 'eng_vendor_a'), 0, 'and still closed to the Account Member');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.per_diems('victor', 'eng_vendor_a'), 0, 'Complete closes the per diem for the Owner');
select is(pg_temp.lot_moves('victor', 'eng_vendor_a'), 0, 'and the lot movement');
select is(pg_temp.per_diems('sam', 'eng_vendor_a'), 0, 'and for the person');
select is(pg_temp.per_diems('carol', 'eng_vendor_a'), 1, 'org readers are not time-boxed');

-- Policies, comments and grants -----------------------------------------------------------------------------------------------
select policies_are('app', 'per_diems', array['per_diems_read', 'per_diems_insert', 'per_diems_update'], 'per_diems keeps its three policies');
select policies_are('app', 'asset_lot_movements', array['asset_lot_movements_read'], 'asset_lot_movements keeps its one policy');
select policy_cmd_is('app', 'per_diems', 'per_diems_read', 'select', 'per_diems_read is a select policy');
select policy_cmd_is('app', 'asset_lot_movements', 'asset_lot_movements_read', 'select', 'asset_lot_movements_read is a select policy');
select policy_roles_are('app', 'per_diems', 'per_diems_read', array['authenticated'], 'per_diems_read applies to signed-in users');
select policy_roles_are('app', 'asset_lot_movements', 'asset_lot_movements_read', array['authenticated'],
  'asset_lot_movements_read applies to signed-in users');
select ok(obj_description(p.oid, 'pg_policy') like '%RRR-209%' and obj_description(p.oid, 'pg_policy') like '%R4%',
  p.polname || '''s comment names RRR-209 and R4')
from pg_policy p
where (p.polrelid, p.polname) in (('app.per_diems'::regclass, 'per_diems_read'), ('app.asset_lot_movements'::regclass, 'asset_lot_movements_read'));
select ok(has_table_privilege('authenticated', t, 'select'), t || ' stays readable by signed-in users')
from unnest(array['app.per_diems', 'app.asset_lot_movements']) t;
select ok(not has_table_privilege('anon', t, 'select'), t || ' stays closed to anon')
from unnest(array['app.per_diems', 'app.asset_lot_movements']) t;
select ok(has_table_privilege('authenticated', 'app.per_diems', 'insert') and has_table_privilege('authenticated', 'app.per_diems', 'update'),
  'per diems stay writable under their write policies');
select ok(not has_table_privilege('authenticated', 'app.asset_lot_movements', 'insert')
    and not has_table_privilege('authenticated', 'app.asset_lot_movements', 'update'),
  'the lot ledger stays append-only through app.apply_asset_scan');
select ok(not has_table_privilege('authenticated', t, 'delete'), t || ' grants no delete')
from unnest(array['app.per_diems', 'app.asset_lot_movements']) t;

select * from finish();
rollback;
