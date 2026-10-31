-- pgTAP: migration 2696 (R7), bulk decisions. A preview changes nothing; a commit approves and declines through
-- app.decide_allocation; the inverse of a decision is refused (bulk_decision_final); the requester separation applies
-- to each row.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

insert into world select 'a1', pg_temp.alloc('request', 'dave', 'e_kai', 'travel', null, 1);
insert into world select 'a2', pg_temp.alloc('request', 'dave', 'e_mo', 'travel', null, 1);
insert into world select 'a3', pg_temp.alloc('request', 'carol', 'e_mo', 'category', 'cat_crew', 1);

select pg_temp.as_platform();
select ok(exists (select 1 from private.bulk_resources where resource = 'advance_allocations'), 'allocations are a bulk resource');

create function pg_temp.rows(p_state text, variadic p_keys text[]) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('allocation_state', p_state))) from unnest(p_keys) k
$$;

select pg_temp.as_user('carol');
select is((app.bulk_update_advance_allocations(pg_temp.rows('Approved', 'a1', 'a2'), true) ->> 'committed')::boolean, false, 'a preview commits nothing');
select is(pg_temp.state_of(pg_temp.id('a1')), 'Requested', 'and changes nothing');
select pg_temp.as_user('carol');
select lives_ok($$select app.bulk_update_advance_allocations(pg_temp.rows('Approved', 'a1'))$$, 'a commit approves');
select is(pg_temp.state_of(pg_temp.id('a1')), 'Approved', 'through decide');
select pg_temp.as_user('carol');
select lives_ok($$select app.bulk_update_advance_allocations(pg_temp.rows('Declined', 'a2'), false, 'Driving down.')$$, 'and declines with the reason');
select pg_temp.as_platform();
select is((select reason from app.advance_allocation_state_transitions where advance_allocation_id = pg_temp.id('a2') and to_state = 'Declined'),
  'Driving down.', 'the call''s one reason is in the ledger');
select pg_temp.as_user('carol');
select is(app.bulk_update_advance_allocations(pg_temp.rows('Requested', 'a1')) #>> '{refused,0,rule}', 'bulk_decision_final',
  'an approval is never undone');
select is(app.bulk_update_advance_allocations(pg_temp.rows('Approved', 'a2')) #>> '{refused,0,rule}', 'bulk_decision_final',
  'nor a decline');
select is(app.bulk_update_advance_allocations(pg_temp.rows('Approved', 'a3')) #>> '{refused,0,rule}', 'sod_allocation_requester',
  'the requester cannot approve their own request in bulk');
select is(pg_temp.state_of(pg_temp.id('a3')), 'Requested', 'it stays Requested');

select * from finish();
rollback;
