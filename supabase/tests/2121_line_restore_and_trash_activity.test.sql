-- pgTAP: 2121, deletes that undo (A118, RRR-163, Section 11.7). Invoice, settlement and budget lines are soft
-- deleted into Trash and restore through app.restore_trash_item; a restored line keeps its number when it is free
-- and moves to the end when a later line took it. Moving a record or a line to Trash emits its .trashed event with
-- the project, which the Activity feed shows to the people who may read the project, and only the move to Trash
-- emits it. A line's event carries none of the line's content, since the feed reaches people without finance read.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(31);

create function pg_temp.events(p_type text, p_key text) returns integer
language sql as $$
  select count(*)::int from app.domain_events e where e.event_type = p_type and e.subject_id = pg_temp.id(p_key)
$$;

create function pg_temp.line_number_of(p_table text, p_key text) returns integer
language plpgsql as $$
declare v integer;
begin
  execute format('select line_number from app.%I where id = $1', p_table) into v using pg_temp.id(p_key);
  return v;
end $$;

-- Fixtures: an invoice, a settlement and a budget, each with two lines -------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code) values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_v_a'), 'USD') returning id)
  insert into world select 'inv', id from x;
with x as (insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor) values (pg_temp.id('inv'), 1, 'Rigging.', 4000) returning id)
  insert into world select 'il1', id from x;
with x as (insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor) values (pg_temp.id('inv'), 2, 'Truss.', 9000) returning id)
  insert into world select 'il2', id from x;
with x as (insert into app.settlements (engagement_id, title, currency_code) values (pg_temp.id('eng_art_a'), 'Opening Night', 'USD') returning id)
  insert into world select 'stl', id from x;
with x as (insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values (pg_temp.id('stl'), 1, 'Guarantee', 'Guarantee.', 500000) returning id)
  insert into world select 'sl1', id from x;
with x as (insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values (pg_temp.id('stl'), 2, 'Bonus', 'Sell-out bonus.', 50000) returning id)
  insert into world select 'sl2', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage rental.', '0000.01.01', 1, 100000, 'X', 'Declared') returning id) insert into world select 'bl1', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 2, 'Barricade.', '0000.01.01', 1, 20000, 'X', 'Declared') returning id) insert into world select 'bl2', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Task', 'Hang the banner', 'Y', 'Declared') returning id)
  insert into world select 'rec', id from x;

-- Lines go to Trash and come back --------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
update app.invoice_lines set deleted_at = now() where id = pg_temp.id('il2');
update app.settlement_lines set deleted_at = now() where id = pg_temp.id('sl2');
update app.budget_lines set deleted_at = now() where id = pg_temp.id('bl2');
select is((select count(*)::int from app.trash_items where subject_id in (pg_temp.id('il2'), pg_temp.id('sl2'), pg_temp.id('bl2'))), 3,
  'deleted invoice, settlement and budget lines are in Trash');
select is((select title from app.trash_items where subject_id = pg_temp.id('il2')), 'Truss.', 'named by their description');
select is(app.restore_trash_item('invoice_lines', pg_temp.id('il2')), 1, 'an invoice line restores through the Trash RPC');
select is(pg_temp.line_number_of('invoice_lines', 'il2'), 2, 'and keeps its number while it is free');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'trash.restored' and subject_id = pg_temp.id('il2')), 1, 'the restore is recorded');
select pg_temp.as_user('carol');

-- A later line took the number ------------------------------------------------------------------------------------------
update app.invoice_lines set deleted_at = now() where id = pg_temp.id('il2');
with x as (insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor) values (pg_temp.id('inv'), 2, 'Motors.', 7000) returning id)
  insert into world select 'il3', id from x;
select lives_ok($$select app.restore_trash_item('invoice_lines', (select id from world where key = 'il2'))$$,
  'an invoice line restores even after a new line took its number');
select is(pg_temp.line_number_of('invoice_lines', 'il2'), 3, 'and moves to the end');
select is(pg_temp.line_number_of('invoice_lines', 'il3'), 2, 'the newer line keeps its place');

with x as (insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values (pg_temp.id('stl'), 2, 'Expense', 'Catering.', 8000) returning id)
  insert into world select 'sl3', id from x;
select is(app.restore_trash_item('settlement_lines', pg_temp.id('sl2')), 1, 'a settlement line restores through the Trash RPC');
select is(pg_temp.line_number_of('settlement_lines', 'sl2'), 3, 'at the end when its number was taken');

with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 2, 'Fencing.', '0000.01.01', 1, 15000, 'X', 'Declared') returning id) insert into world select 'bl3', id from x;
select lives_ok($$update app.budget_lines set deleted_at = null where id = (select id from world where key = 'bl2')$$,
  'a budget line Undo restores even after a new line took its number');
select is(pg_temp.line_number_of('budget_lines', 'bl2'), 3, 'and moves to the end');

-- Only the people who may edit the line restore it.
update app.invoice_lines set deleted_at = now() where id = pg_temp.id('il3');
select pg_temp.as_user('gina');
select throws_ok($$select app.restore_trash_item('invoice_lines', (select id from world where key = 'il3'))$$, '42501', null,
  'a Viewer outside the project cannot restore an invoice line');
select pg_temp.as_user('xavier');
select throws_ok($$select app.restore_trash_item('invoice_lines', (select id from world where key = 'il3'))$$, '42501', null,
  'nor can another org');

-- 2122: a child table that grants UPDATE on deleted_at alone (as project_shares, applications and api_keys do) is
-- walked, so its rows deleted with the line come back with it.
select pg_temp.as_platform();
create table app.a118_line_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_line_id uuid not null references app.invoice_lines (id),
  note text not null,
  deleted_at timestamptz
);
grant select on app.a118_line_notes to authenticated;
grant update (deleted_at) on app.a118_line_notes to authenticated;
insert into app.a118_line_notes (invoice_line_id, note) values (pg_temp.id('il1'), 'Rigging quote attached.');
select pg_temp.as_user('carol');
update app.invoice_lines set deleted_at = now() where id = pg_temp.id('il1');
select pg_temp.as_platform();
update app.a118_line_notes set deleted_at = now();
select pg_temp.as_user('carol');
select is(app.restore_trash_item('invoice_lines', pg_temp.id('il1')), 2,
  'a child whose table grants UPDATE on deleted_at alone is restored with its line');
select pg_temp.as_platform();
select is((select count(*)::int from app.a118_line_notes where deleted_at is null), 1, 'and is live again');

-- Moving to Trash reaches Activity --------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(pg_temp.events('invoice_line.trashed', 'il2'), 2, 'each move of an invoice line to Trash emits invoice_line.trashed');
select is(pg_temp.events('settlement_line.trashed', 'sl2'), 1, 'a settlement line emits settlement_line.trashed');
select is(pg_temp.events('budget_line.trashed', 'bl2'), 1, 'a budget line emits budget_line.trashed');
select is((select project_id from app.domain_events where event_type = 'invoice_line.trashed' and subject_id = pg_temp.id('il2') limit 1),
  pg_temp.id('prj_a'), 'a line''s event carries its parent''s project');
select is((select count(*)::int from app.domain_events where event_type like '%line.trashed' and data <> '{}'::jsonb), 0,
  'a line''s event carries none of the line''s content');

-- The project's feed reaches a Collaborator on the project without finance read: they see that a line went to Trash,
-- never what it said.
select pg_temp.as_user('erin');
select is((select count(*)::int from app.settlement_lines where id = pg_temp.id('sl2')), 0,
  'a Collaborator on the project cannot read the settlement line');
select is((select count(*)::int from app.activity_feed(pg_temp.id('org_a'), pg_temp.id('prj_a')) f
  where f.event_type = 'settlement_line.trashed' and f.subject_id = pg_temp.id('sl2')), 1,
  'but sees its deletion in the project''s Activity feed');
select is((select count(*)::int from app.activity_feed(pg_temp.id('org_a'), pg_temp.id('prj_a')) f
  where f.event_type like '%line.trashed' and (f.data::text like '%Sell-out%' or f.data::text like '%Truss%' or f.data::text like '%Barricade%')), 0,
  'without the line''s description');
select is((select count(*)::int from app.trash_items where subject_id = pg_temp.id('il3')), 0,
  'and Trash, read under their row level security, names no line to them');
select pg_temp.as_platform();

select pg_temp.as_user('dave');
update app.records set title = 'Hang two banners' where id = pg_temp.id('rec');
select pg_temp.as_platform();
select is(pg_temp.events('record.trashed', 'rec'), 0, 'editing a record emits no trashed event');
select pg_temp.as_user('dave');
update app.records set deleted_at = now() where id = pg_temp.id('rec');
select pg_temp.as_platform();
select is(pg_temp.events('record.trashed', 'rec'), 1, 'moving it to Trash emits record.trashed');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.activity_feed(pg_temp.id('org_a'), pg_temp.id('prj_a')) f
  where f.event_type = 'record.trashed' and f.subject_id = pg_temp.id('rec')), 1, 'which the project''s Activity feed shows');
select is(app.restore_trash_item('records', pg_temp.id('rec')), 1, 'and the record restores from it through the Trash RPC');
select pg_temp.as_platform();
select is(pg_temp.events('record.trashed', 'rec'), 1, 'a restore emits no trashed event');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.activity_feed((select id from world where key = 'org_a'))$$, '42501', null,
  'another org cannot read the feed that shows it');
select pg_temp.as_platform();

select * from finish();
rollback;
