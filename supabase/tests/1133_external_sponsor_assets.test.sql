-- pgTAP: migration 1133, sponsor asset approvals in Gateway (finding A38-005, journey 47). The sponsor account reads
-- the submitted assets of its entitlements while its engagement is operational, never drafts or who decided; its
-- Owner approves or returns (with a reason) a submitted asset and resubmits a returned one; every allowed and refused
-- move; denial for a supplied member, another account, another tenant and anon; the org's own review still works.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(24);

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: Brightwave Drinks sponsors prj_a; Lena is a member of its account ----------------------------------------
select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.new_user('lena', 'lena@brightwave-drinks.test', 'Lena Park');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select app.add_account_member(pg_temp.id('acct_s'), pg_temp.id('lena'), 'Account Member');
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '5000.51.02', 'INDEPENDENT_CONTRACTOR',
    'Day Rate', 'Per Engagement', '2027-06-01') returning id) insert into world select 'eng_sponsor', id from e;
select pg_temp.as_user('carol');
with s as (insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Main stage banner placement', 2) returning id) insert into world select 'ent', id from s;
with a as (insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title, usage_note)
  values (pg_temp.id('ent'), 'Artwork', 'Main stage banner, 12 by 4 metres', 'Upstage left truss') returning id) insert into world select 'asset', id from a;
with a as (insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title)
  values (pg_temp.id('ent'), 'Copy', 'PA announcement script') returning id) insert into world select 'draft', id from a;
select pg_temp.as_platform();

-- Reading -----------------------------------------------------------------------------------------------------------
select is(pg_temp.n('sol', 'select 1 from api_external.sponsor_assets'), 0, 'Onboarding: assets wait for the operational area');
select pg_temp.move_engagement('eng_sponsor', 'Onboarding', 'Active');
select is(pg_temp.n('sol', 'select 1 from api_external.sponsor_assets'), 0, 'a draft the org has not submitted never shows');
select pg_temp.as_user('carol');
select app.transition_sponsor_asset(pg_temp.id('asset'), 'Proposed', 'Submitted', 'Proof ready for the sponsor.');
select pg_temp.as_platform();
select is(pg_temp.n('sol', 'select 1 from api_external.sponsor_assets'), 1, 'the sponsor reads the submitted asset');
select pg_temp.as_user('sol');
select ok((select awaiting_sponsor from api_external.sponsor_assets), 'awaiting the sponsor''s answer');
select is((select entitlement_description from api_external.sponsor_assets), 'Main stage banner placement', 'with its entitlement');
select pg_temp.as_platform();
select hasnt_column('api_external', 'sponsor_assets', 'decided_by', 'who decided on the org side never appears');
select is(pg_temp.n('lena', 'select 1 from api_external.sponsor_assets'), 1, 'an Account Member reads it too');
select is(pg_temp.n('victor', 'select 1 from api_external.sponsor_assets'), 0, 'denial: another account');
select is(pg_temp.n('xavier', 'select 1 from api_external.sponsor_assets'), 0, 'denial: another tenant');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.sponsor_assets', '42501', null, 'anon reads none');

-- Answering ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('lena');
select throws_ok(format($$select app.respond_sponsor_asset('%s', 'Submitted', 'Approved', null)$$, pg_temp.id('asset')), '42501', null,
  'an Account Member cannot answer for the sponsor');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.respond_sponsor_asset('%s', 'Submitted', 'Approved', null)$$, pg_temp.id('asset')), '42501', null,
  'another account cannot answer');
select pg_temp.as_user('sol');
select throws_ok(format($$select app.respond_sponsor_asset('%s', 'Submitted', 'Canceled', 'No.')$$, pg_temp.id('asset')), 'XR001',
  'sponsor_asset_response: A sponsor approves or returns a submitted asset, or resubmits a returned one.', 'a sponsor never cancels');
select throws_ok(format($$select app.respond_sponsor_asset('%s', 'Submitted', 'Returned', ' ')$$, pg_temp.id('asset')), 'XR001',
  'sponsor_asset_return_reason: Say what to change when returning an asset.', 'a return says what to change');
select throws_ok(format($$select app.respond_sponsor_asset('%s', 'Proposed', 'Submitted', null)$$, pg_temp.id('draft')), '42501', null,
  'a draft is not the sponsor''s to see or move');
select lives_ok(format($$select app.respond_sponsor_asset('%s', 'Submitted', 'Returned', 'Use the white logo on dark backgrounds.')$$, pg_temp.id('asset')),
  'the sponsor returns it with a reason');
select pg_temp.as_platform();
select is((select decided_by from app.sponsor_assets where id = pg_temp.id('asset')), pg_temp.id('sol'), 'the sponsor is recorded as deciding');
select pg_temp.as_user('sol');
select throws_ok(format($$select app.respond_sponsor_asset('%s', 'Submitted', 'Approved', null)$$, pg_temp.id('asset')), 'XR001', null,
  'compare-and-set refuses a stale state');
select lives_ok(format($$select app.respond_sponsor_asset('%s', 'Returned', 'Submitted', 'Logo file replaced.')$$, pg_temp.id('asset')),
  'the sponsor resubmits a returned asset');
select pg_temp.as_platform();
select is((select revision from app.sponsor_assets where id = pg_temp.id('asset')), 1, 'as a new revision');
select pg_temp.as_user('sol');
select lives_ok(format($$select app.respond_sponsor_asset('%s', 'Submitted', 'Approved', null)$$, pg_temp.id('asset')), 'the sponsor approves it');
select is((select asset_state::text from api_external.sponsor_assets), 'Approved', 'and reads it Approved');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('asset') and event_type = 'sponsor_asset.state_changed'), 4,
  'every move is recorded and emits sponsor_asset.state_changed');
select is((select count(*)::int from app.sponsor_asset_state_transitions where sponsor_asset_id = pg_temp.id('asset')), 5,
  'the ledger holds the birth and every move');

select * from finish();
rollback;
