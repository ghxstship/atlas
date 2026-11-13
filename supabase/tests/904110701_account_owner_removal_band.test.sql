-- pgTAP: migration 904110701, only an Account Owner removes an Account Owner (crawl 4.9). In Bayside Audio (acct_v)
-- victor is the Owner; he makes fiona a second Owner and sam an Admin. sam cannot end either Owner's membership, even
-- with two Owners on the account, while he still removes a plain member; an Owner removes the other Owner, and a member
-- still leaves on their own.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(8);

create function pg_temp.membership(p_who text) returns uuid
language sql as $$
  select m.id from app.account_memberships m
  where m.org_id = pg_temp.id('acct_v') and m.person_id = pg_temp.id(p_who) and m.deleted_at is null
  order by m.valid_from desc limit 1
$$;

create function pg_temp.live(p_who text) returns boolean
language sql as $$
  select exists (select 1 from app.account_memberships m
    where m.id = pg_temp.membership(p_who) and (m.valid_to is null or m.valid_to > now()))
$$;

select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('fiona'), 'Account Owner');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('sam'), 'Account Admin');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('quinn'), 'Account Member');
select pg_temp.as_platform();
insert into world select 'm_' || w, pg_temp.membership(w) from unnest(array['victor', 'fiona', 'sam', 'quinn']) w;

select pg_temp.as_user('sam');
select throws_ok(format($$select app.end_account_membership('%s')$$, pg_temp.id('m_fiona')),
  'XR001', 'account_role_band: Only an Account Owner removes Account Owner.',
  'an Admin cannot remove an Owner while another Owner remains');
select throws_ok(format($$select app.end_account_membership('%s')$$, pg_temp.id('m_victor')),
  'XR001', 'account_role_band: Only an Account Owner removes Account Owner.',
  'nor the Owner who made them Admin');
select pg_temp.as_platform();
select ok(pg_temp.live('fiona') and pg_temp.live('victor'), 'both Owners keep their memberships');

select pg_temp.as_user('sam');
select lives_ok(format($$select app.end_account_membership('%s')$$, pg_temp.id('m_quinn')),
  'an Admin still removes a member who is not an Owner');
select pg_temp.as_platform();
select ok(not pg_temp.live('quinn'), 'and the member''s access ends at once');

select pg_temp.as_user('victor');
select lives_ok(format($$select app.end_account_membership('%s')$$, pg_temp.id('m_fiona')),
  'an Owner removes another Owner');
select pg_temp.as_platform();
select ok(not pg_temp.live('fiona'), 'and that Owner''s access ends');

select pg_temp.as_user('sam');
select lives_ok(format($$select app.end_account_membership('%s')$$, pg_temp.id('m_sam')),
  'an Admin still leaves on their own');
select pg_temp.as_platform();

select * from finish();
rollback;
