-- pgTAP: migrations 2631 and 2632 (R4), account engagement assignments and the roster area (owner decision 6, ADR 0101).
-- Only an Account Owner or Admin assigns, never themselves, only a confirmed member of the supplying account. An Account
-- Member without an assignment reaches no area of an account engagement; Member duty opens engagement and operational,
-- Advancing Lead also onboarding and roster; Owner and Admin keep every area; Finance keeps engagement, documents and
-- money. The roster area is open from Onboarding to Closing and closed after Complete. Sync scopes follow assignments.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- The areas a person reaches on an engagement now, sorted.
create function pg_temp.areas(p_who text, p_engagement text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.claims(p_who);
  select coalesce(string_agg(a, ',' order by a), '') into v from private.engagement_scope(pg_temp.id(p_engagement)) a;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.membership(p_account text, p_person text) returns uuid
language plpgsql as $$
declare
  v_role text := current_setting('role');
  v_claims text := current_setting('request.jwt.claims', true);
  v uuid;
begin
  -- Read as the platform, whoever the caller is, then restore the caller.
  perform set_config('role', 'postgres', true);
  select m.id into v from app.account_memberships m
  where m.org_id = pg_temp.id(p_account) and m.person_id = pg_temp.id(p_person) and m.deleted_at is null
    and (m.valid_to is null or m.valid_to > now());
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v;
end $$;

-- Fixture: Bayside Audio's crew engagement with no named person, an Admin, two confirmed members and an unconfirmed one --------
select pg_temp.new_user('ada', 'ada@bayside-audio.test', 'Ada Brennan');
select pg_temp.new_user('kai', 'kai@bayside-audio.test', 'Kai Morgan');
select pg_temp.new_user('mo', 'mo@bayside-audio.test', 'Mo Lindqvist');
select pg_temp.new_user('una', 'una@bayside-audio.test', 'Una Fischer');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('ada'), 'Account Admin');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('kai'), 'Account Member');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('mo'), 'Account Member');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('una'), 'Account Member');
select pg_temp.as_user('kai');
select app.accept_account_membership(pg_temp.membership('acct_v', 'kai'));
select pg_temp.as_user('mo');
select app.accept_account_membership(pg_temp.membership('acct_v', 'mo'));
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement',
    '2027-06-01') returning id)
insert into world select 'eng_co', id from x;
select pg_temp.as_platform();

-- Who assigns ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('fiona');
select throws_ok(format($$select app.assign_engagement_member(%L, %L, 'Member')$$, pg_temp.id('eng_co'), pg_temp.membership('acct_v', 'kai')),
  '42501', null, 'Account Finance does not assign');
select pg_temp.as_user('kai');
select throws_ok(format($$select app.assign_engagement_member(%L, %L, 'Member')$$, pg_temp.id('eng_co'), pg_temp.membership('acct_v', 'mo')),
  '42501', null, 'an Account Member does not assign');
select pg_temp.as_user('ada');
select throws_like(format($$select app.assign_engagement_member(%L, %L, 'Advancing Lead')$$, pg_temp.id('eng_co'), pg_temp.membership('acct_v', 'ada')),
  'sod_self_grant:%', 'an Admin never assigns themselves');
select throws_like(format($$select app.assign_engagement_member(%L, %L, 'Member')$$, pg_temp.id('eng_co'), pg_temp.membership('acct_v', 'una')),
  'account_membership_unconfirmed:%', 'an unconfirmed member is not assigned');
select throws_like(format($$select app.assign_engagement_member(%L, %L, 'Member')$$, pg_temp.id('eng_co'), pg_temp.membership('acct_t', 'rita')),
  'assignment_account_mismatch:%', 'another account''s membership is not assigned');
select pg_temp.as_user('rita');
select throws_ok(format($$select app.assign_engagement_member(%L, %L, 'Member')$$, pg_temp.id('eng_co'), pg_temp.membership('acct_t', 'rita')),
  '42501', null, 'another account''s Owner does not assign on this engagement');
select pg_temp.as_platform();

-- Unassigned: nothing --------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_co', 'Onboarding', 'Active');
select is(pg_temp.areas('kai', 'eng_co'), '', 'an Account Member without an assignment reaches no area');
select is(pg_temp.n('kai', format('select 1 from api_external.engagements where id = %L', pg_temp.id('eng_co'))), 0,
  'api_external.engagements returns nothing to them');
select is(pg_temp.areas('victor', 'eng_co'), 'documents,engagement,money,onboarding,operational,roster', 'the Owner keeps every area');
select is(pg_temp.areas('ada', 'eng_co'), 'documents,engagement,money,onboarding,operational,roster', 'and the Admin');
select is(pg_temp.areas('fiona', 'eng_co'), 'documents,engagement,money', 'Account Finance keeps engagement, documents and money');
select is(pg_temp.areas('sam', 'eng_vendor_a'), 'documents,engagement,onboarding',
  'Sam, the Account Member the vendor engagement names, reaches it as its person, all but the roster the account manages');
select is(pg_temp.areas('ivy', 'eng_ivy_a'), 'documents,engagement,onboarding,roster',
  'the person of an engagement no account supplies reaches its roster area too');

-- Member and Advancing Lead ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ada');
select lives_ok(format($$insert into world select 'asg_kai', app.assign_engagement_member(%L, %L, 'Member')$$, pg_temp.id('eng_co'),
  pg_temp.membership('acct_v', 'kai')), 'the Admin assigns Kai as Member');
select lives_ok(format($$insert into world select 'asg_mo', app.assign_engagement_member(%L, %L, 'Advancing Lead')$$, pg_temp.id('eng_co'),
  pg_temp.membership('acct_v', 'mo')), 'and Mo as Advancing Lead');
select pg_temp.as_platform();
select is(pg_temp.areas('kai', 'eng_co'), 'engagement,operational', 'Member duty opens engagement and operational');
select is(pg_temp.areas('mo', 'eng_co'), 'engagement,onboarding,operational,roster', 'Advancing Lead also opens onboarding and roster');
select is(pg_temp.n('kai', format('select 1 from api_external.engagements where id = %L', pg_temp.id('eng_co'))), 1,
  'the assigned member reads the engagement');
select is(pg_temp.n('kai', 'select 1 from api_external.account_engagement_assignments'), 1, 'a member reads their own assignment');
select is(pg_temp.n('victor', 'select 1 from api_external.account_engagement_assignments'), 2, 'the Owner reads every assignment of the account');
select is(pg_temp.n('fiona', 'select 1 from api_external.account_engagement_assignments'), 0, 'Account Finance reads none');
select is((select count(*)::int from private.sync_scope_grants g where g.person_user_id = pg_temp.id('kai_user')
  and g.scope_key = 'engagementIds' and g.scope_value = pg_temp.id('eng_co')::text), 1, 'Kai''s sync scopes gain the engagement');

select pg_temp.as_user('victor');
select is(app.assign_engagement_member(pg_temp.id('eng_co'), pg_temp.membership('acct_v', 'kai'), 'Advancing Lead'), pg_temp.id('asg_kai'),
  'assigning again changes the duty of the live assignment');
select pg_temp.as_platform();
select is(pg_temp.areas('kai', 'eng_co'), 'engagement,onboarding,operational,roster', 'Kai is now an Advancing Lead');
select pg_temp.as_user('victor');
select lives_ok(format($$select app.unassign_engagement_member(%L)$$, pg_temp.id('asg_kai')), 'the Owner removes the assignment');
select pg_temp.as_platform();
select is(pg_temp.areas('kai', 'eng_co'), '', 'Kai reaches nothing again');
select is((select count(*)::int from private.sync_scope_grants g where g.person_user_id = pg_temp.id('kai_user')
  and g.scope_key = 'engagementIds' and g.scope_value = pg_temp.id('eng_co')::text), 0, 'and the sync scope goes');

-- An assignment ends with the membership.
select pg_temp.as_user('mo');
select app.end_account_membership(pg_temp.membership('acct_v', 'mo'));
select pg_temp.as_platform();
select is(pg_temp.areas('mo', 'eng_co'), '', 'a member who left reaches nothing through their assignment');

-- The roster area's time box ---------------------------------------------------------------------------------------------------
select pg_temp.new_user('pia', 'pia@bayside-audio.test', 'Pia Larsen');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('pia'), 'Account Member');
select pg_temp.as_user('pia');
select app.accept_account_membership(pg_temp.membership('acct_v', 'pia'));
select pg_temp.as_user('victor');
select app.assign_engagement_member(pg_temp.id('eng_vendor_a'), pg_temp.membership('acct_v', 'pia'), 'Advancing Lead');
select pg_temp.as_platform();
select is(pg_temp.areas('pia', 'eng_vendor_a'), 'engagement,onboarding,roster', 'an Advancing Lead reaches the roster at Onboarding');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select is(pg_temp.areas('pia', 'eng_vendor_a'), 'engagement,onboarding,operational,roster', 'and while Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select ok(pg_temp.areas('pia', 'eng_vendor_a') like '%roster%', 'and while Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.areas('pia', 'eng_vendor_a'), 'engagement', 'the roster closes at Complete');
select is(pg_temp.areas('victor', 'eng_vendor_a'), 'documents,engagement,money', 'for the Owner too');
-- An artist's Advance representative reaches the roster.
select is(pg_temp.areas('rita', 'eng_art_a'), 'documents,engagement,onboarding,roster',
  'an artist''s Advance representative reaches the roster (rep_art: Advance and Documents, at Onboarding)');

select * from finish();
rollback;
