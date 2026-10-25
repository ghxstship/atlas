-- pgTAP: migration 0770, client approvals (Section 4.4.4 Client, Section 8.7). Requests only to Client engagements
-- and for items of the engagement's project, the client decides once (rejection needs a reason), shared change orders
-- NULL-aware without budget coding, RLS (same tenant, cross tenant, anon, role band) and the time box.
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

-- Fixture: Coral Group as Northwind's Client on prj_a, a budget and two change orders --------------------------------------
select pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
select pg_temp.as_user('cleo');
insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));
select pg_temp.as_user('alice');
insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cleo'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id) insert into world select 'eng_client', id from e;
with b as (insert into app.budgets (project_id, name, currency_code, is_baseline) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD', true) returning id)
  insert into world select 'bud', id from b;
with c as (insert into app.change_orders (project_id, budget_id, title, order_type_enum_id, reason)
  values (pg_temp.id('prj_a'), pg_temp.id('bud'), 'Add a second stage', 'ENM-092', 'The client asked for a second stage.') returning id)
  insert into world select 'co', id from c;
insert into app.change_order_lines (change_order_id, description, urid, quantity, unit_price_minor) values
  (pg_temp.id('co'), 'Second stage deck.', '0000.01.01', 1, 1200000), (pg_temp.id('co'), 'Second stage audio.', '0000.01.01', 1, null);
with c as (insert into app.change_orders (project_id, budget_id, title, order_type_enum_id) values (pg_temp.id('prj_a'), pg_temp.id('bud'), 'Internal reallocation', 'ENM-092') returning id)
  insert into world select 'co_internal', id from c;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_client', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');

-- Requests ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.request_client_approval('%s', '%s', null, 'Please approve.')$$, pg_temp.id('eng_ivy_a'), pg_temp.id('co')),
  'XR001', null, 'requests go only to Client engagements');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.request_client_approval('%s', '%s', null, null)$$, pg_temp.id('eng_client'), pg_temp.id('co')),
  '42501', null, 'role band: a Viewer cannot ask');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.request_client_approval('%s', '%s', null, null)$$, pg_temp.id('eng_client'), pg_temp.id('co')),
  '42501', null, 'cross tenant: another org cannot ask');
select pg_temp.as_user('carol');
with r as (select app.request_client_approval(pg_temp.id('eng_client'), pg_temp.id('co'), null, 'Second stage for the finale.') as id)
  insert into world select 'req', id from r;
select throws_ok(format($$select app.request_client_approval('%s', '%s', null, null)$$, pg_temp.id('eng_client'), pg_temp.id('co')),
  '23505', null, 'one open request per item');
select pg_temp.as_platform();
select is((select requested_by from app.client_approval_requests where id = pg_temp.id('req')), pg_temp.id('carol'), 'the asker comes from the session');

-- What the client sees ----------------------------------------------------------------------------------------------------------
select is(pg_temp.n('cleo', 'select 1 from api_external.client_approvals where decision is null'), 1, 'own engagement: the client sees the open request');
select is(pg_temp.n('cleo', 'select 1 from api_external.change_orders'), 1, 'and only the shared change order');
select pg_temp.as_user('cleo');
select is((select total_minor from api_external.change_orders), null::bigint, 'an unpriced line leaves the total blank');
select is((select count(*)::int from api_external.change_order_lines), 2, 'the client reads its lines');
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'select 1 from api_external.client_approvals'), 0, 'denial: a Crew party');
select is(pg_temp.n('victor', 'select 1 from api_external.change_orders'), 0, 'denial: another account');
select hasnt_column('api_external', 'change_order_lines', 'budget_line_id', 'budget coding never reaches externals');
select hasnt_column('api_external', 'client_approvals', 'requested_by', 'the org-side asker never reaches externals');

-- Deciding ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.decide_client_approval('%s', 'Approved', null)$$, pg_temp.id('req')), '42501', null, 'another party cannot decide');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_client_approval('%s', 'Approved', null)$$, pg_temp.id('req')), '42501', null, 'the org cannot decide for the client');
select pg_temp.as_user('cleo');
select throws_ok(format($$select app.decide_client_approval('%s', 'Rejected', ' ')$$, pg_temp.id('req')), 'XR001', null, 'a rejection says why');
select lives_ok(format($$select app.decide_client_approval('%s', 'Approved', 'Approved for the finale.')$$, pg_temp.id('req')), 'the client approves');
select throws_ok(format($$select app.decide_client_approval('%s', 'Rejected', 'Changed our mind.')$$, pg_temp.id('req')), 'XR001', null, 'a decision is final');
select pg_temp.as_platform();
select is((select decided_by from app.client_approval_requests where id = pg_temp.id('req')), pg_temp.id('cleo'), 'the decider comes from the session');
select throws_ok(format($$update app.client_approval_requests set decision = 'Rejected' where id = '%s'$$, pg_temp.id('req')), 'XR001', null,
  'a decision is final on every path');
select ok(exists (select 1 from app.domain_events where event_type = 'client_approval.decided'), 'the decision emits an event');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.client_approval_requests), 0, 'externals never read the app table');
select pg_temp.as_user('carol');
select is((select decision::text from app.client_approval_requests where id = pg_temp.id('req')), 'Approved', 'same tenant: the org reads the decision');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.client_approval_requests), 0, 'cross tenant: none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.client_approval_requests', '42501', null, 'anon deny');
select throws_ok('select 1 from api_external.client_approvals', '42501', null, 'anon deny on the projection');
select pg_temp.as_platform();

-- Time box ------------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_client', 'Active', 'Closing');
select pg_temp.move_engagement('eng_client', 'Closing', 'Complete');
select is(pg_temp.n('cleo', 'select 1 from api_external.client_approvals'), 0, 'Complete: approvals close with the operational area');

select * from finish();
rollback;
