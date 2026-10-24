-- pgTAP: 1801, bulk edit of guest lists (A121, RRR-167, Section 11.7). A reviewer approves several requests in one
-- call, a preview changes nothing, one request the reviewer made rolls the whole call back (sod_guest_requester), the
-- door checks approved guests in together, the one-way moves refuse an undo, another org's guest reads as not found,
-- and the guest list gains the audit trail.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(15);

create temporary table answer (key text primary key, r jsonb);
grant all on answer to public;

create function pg_temp.rows(p_keys text[], p_state text) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('entry_state', p_state))) from unnest(p_keys) k;
$$;

create function pg_temp.keep(p_key text, p_answer jsonb) returns jsonb
language sql as $$ insert into answer values (p_key, p_answer) returning r $$;

create function pg_temp.got(p_key text) returns jsonb
language sql as $$ select r from answer where key = p_key $$;

create function pg_temp.state_of(p_key text) returns text
language sql as $$ select entry_state::text from app.guest_list_entries where id = pg_temp.id(p_key) $$;

-- Fixtures: frank requests three guests, dave one ----------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Jordan Pike') returning id) insert into world select 'g1', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Morgan Lee') returning id) insert into world select 'g2', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Sasha Bell') returning id) insert into world select 'g3', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Riley Chen') returning id) insert into world select 'g_own', id from x;
select pg_temp.as_user('xavier');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_b'), 'Avery Stone') returning id) insert into world select 'g_b', id from x;

-- Decisions --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(app.bulk_update_guest_list_entries(pg_temp.rows(array['g1', 'g2'], 'Approved'), true) ->> 'changed', '2',
  'a reviewer previews approving two requests');
select is(pg_temp.state_of('g1'), 'Requested', 'and nothing is decided');
select is(pg_temp.keep('own', app.bulk_update_guest_list_entries(pg_temp.rows(array['g1', 'g_own'], 'Approved'))) ->> 'committed', 'false',
  'a call that includes the reviewer''s own request commits nothing');
select is(pg_temp.got('own') -> 'refused' -> 0 ->> 'rule', 'sod_guest_requester', 'the refusal names separation of duties');
select is(pg_temp.got('own') -> 'refused' -> 0 ->> 'id', pg_temp.id('g_own')::text, 'against the reviewer''s own request');
select is(pg_temp.state_of('g1'), 'Requested', 'so the other request stays undecided too');
select is(pg_temp.keep('approve', app.bulk_update_guest_list_entries(pg_temp.rows(array['g1', 'g2'], 'Approved'))) ->> 'changed', '2',
  'the reviewer approves both requests in one call');
select is((select count(*)::int from app.guest_list_entries where id in (pg_temp.id('g1'), pg_temp.id('g2')) and decided_by = pg_temp.id('dave')), 2,
  'each decision is stamped with the reviewer');
select is(app.bulk_update_guest_list_entries(pg_temp.got('approve') -> 'inverse') -> 'refused' -> 0 ->> 'rule', 'guest_entry_transition',
  'a decision moves one way, so its undo is refused');

-- The door ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is(app.bulk_update_guest_list_entries(pg_temp.rows(array['g1', 'g2'], 'Checked In')) ->> 'changed', '2',
  'the door checks approved guests in together');
select is(app.bulk_update_guest_list_entries(pg_temp.rows(array['g3'], 'Approved')) -> 'refused' -> 0 ->> 'rule', 'guest_entry_authority',
  'a Field member cannot approve in bulk either');
select is(app.bulk_update_guest_list_entries(pg_temp.rows(array['g3'], 'Checked In')) -> 'refused' -> 0 ->> 'rule', 'guest_entry_transition',
  'and a requested guest is not checked in');

-- Reach --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(app.bulk_update_guest_list_entries(pg_temp.rows(array['g_b'], 'Approved')) -> 'refused' -> 0 ->> 'rule', 'bulk_row_not_found',
  'another org''s guest reads as not found');
select pg_temp.as_anon();
select throws_ok($$select app.bulk_update_guest_list_entries('[]'::jsonb)$$, '42501', null, 'anon cannot call it');
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events where org_id = pg_temp.id('org_a') and action = 'guest_list_entries.bulk_update'),
  'a committed call writes a guest_list_entries.bulk_update audit event');

select * from finish();
rollback;
