-- pgTAP: 6551, budget versions (B13, RRR-237, gap G-210, ADR 0152). A snapshot copies every live line with its effective
-- markup and client price, is numbered per budget, and never changes; lines are append-only; a Snapshot can go to Trash
-- and a Quote capture cannot (budget_version_in_use); finance.budget.write is required; Trash registration.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code, default_markup_bp) values (pg_temp.id('prj_a'), 'Versioned Budget', 'USD', 2000) returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage deck.', '5000.04.02', 2, 10000, 'X', 'Declared') returning id) insert into world select 'l1', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, markup_bp, xyz, xyz_basis)
  values (pg_temp.id('bud'), 2, 'Sound.', '5000.01.01', 1, null, 1000, 'X', 'Declared') returning id) insert into world select 'l2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 3, 'Gone.', '5000.01.01', 1, 500, 'X', 'Declared') returning id) insert into world select 'l3', id from x;
update app.budget_lines set deleted_at = now() where id = pg_temp.id('l3');

-- Capability -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.snapshot_budget('%s', 'Viewer try')$$, pg_temp.id('bud')), '42501', null,
  'a Viewer cannot take a snapshot');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.snapshot_budget('%s', 'Other org')$$, pg_temp.id('bud')), '42501', null,
  'cross tenant: another org cannot');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.snapshot_budget('%s', '  ')$$, pg_temp.id('bud')), 'XR001', null,
  'a snapshot is named (budget_version_label)');
select throws_ok($$insert into app.budget_versions (budget_id, version_number, label, purpose, currency_code)
  values ((select id from world where key = 'bud'), 1, 'By hand', 'Snapshot', 'USD')$$, '42501', null,
  'signed-in people never insert versions directly');

insert into world select 'v1', app.snapshot_budget(pg_temp.id('bud'), 'Before the rider');
insert into world select 'v2', app.snapshot_budget(pg_temp.id('bud'), 'After the rider');
select is((select array_agg(version_number order by version_number) from app.budget_versions where budget_id = pg_temp.id('bud')),
  array[1, 2]::bigint[], 'versions are numbered per budget from 1');
select is((select purpose::text || '/' || currency_code from app.budget_versions where id = pg_temp.id('v1')), 'Snapshot/USD',
  'a snapshot carries its purpose and the budget''s currency');
select is((select count(*)::int from app.budget_version_lines where budget_version_id = pg_temp.id('v1')), 2,
  'every live line is copied, the deleted one is not');
select is((select client_unit_price_minor from app.budget_version_lines where budget_version_id = pg_temp.id('v1')
           and budget_line_id = pg_temp.id('l1')), 12000::bigint, 'the effective client price is frozen (budget default 20 percent)');
select is((select effective_markup_bp from app.budget_version_lines where budget_version_id = pg_temp.id('v1')
           and budget_line_id = pg_temp.id('l1')), 2000, 'with the effective markup');
select is((select client_unit_price_minor from app.budget_version_lines where budget_version_id = pg_temp.id('v1')
           and budget_line_id = pg_temp.id('l2')), null::bigint, 'an unpriced line stays unpriced in the copy');

-- Immutability -----------------------------------------------------------------------------------------------------------
update app.budget_lines set unit_price_minor = 99999 where id = pg_temp.id('l1');
select is((select unit_price_minor from app.budget_version_lines where budget_version_id = pg_temp.id('v1')
           and budget_line_id = pg_temp.id('l1')), 10000::bigint, 'editing the live line leaves the copy as it was');
select throws_ok(format($$update app.budget_versions set label = 'Renamed' where id = '%s'$$, pg_temp.id('v1')), '42501', null,
  'a version''s label is not writable');
select pg_temp.as_platform();
select throws_ok(format($$update app.budget_versions set label = 'Renamed' where id = '%s'$$, pg_temp.id('v1')), 'XR001', null,
  'and the guard refuses it even to the platform (budget_version_immutable)');
select throws_ok(format($$update app.budget_version_lines set quantity = 9 where budget_version_id = '%s'$$, pg_temp.id('v1')), 'XR001', null,
  'version lines are append-only');
select throws_ok(format($$delete from app.budget_version_lines where budget_version_id = '%s'$$, pg_temp.id('v1')), 'XR001', null,
  'and are never deleted');

-- Trash ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok(format($$update app.budget_versions set deleted_at = now() where id = '%s'$$, pg_temp.id('v2')),
  'a Snapshot version can be deleted');
select pg_temp.as_platform();
insert into world select 'vq', private.capture_budget_version(pg_temp.id('bud'), 'Quote NWL-Q-1 v1', 'Quote');
select pg_temp.as_user('carol');
select throws_ok(format($$update app.budget_versions set deleted_at = now() where id = '%s'$$, pg_temp.id('vq')), 'XR001', null,
  'a Quote capture cannot be deleted (budget_version_in_use)');
select pg_temp.as_user('dave');
update app.budget_versions set deleted_at = now() where id = pg_temp.id('v1');
select pg_temp.as_platform();
select is((select deleted_at from app.budget_versions where id = pg_temp.id('v1')), null::timestamptz,
  'a reader without finance.budget.write cannot delete one: the update policy keeps the row');
select ok(exists (select 1 from private.trash_tables where table_name = 'budget_versions' and title_column = 'label'),
  'budget versions are in Trash, titled by label');
select ok(not exists (select 1 from private.trash_tables where table_name = 'budget_version_lines'),
  'version lines are an Age ledger, never in Trash');
select is((select basis::text from private.retention_policies where table_name = 'app.budget_version_lines'), 'Age',
  'the lines are retained by age');

-- Totals -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select total_minor from app.budget_version_totals where budget_version_id = pg_temp.id('v1')), null::bigint,
  'the version total is NULL with an unpriced line');
select is((select priced_total_minor from app.budget_version_totals where budget_version_id = pg_temp.id('v1')), 20000::bigint,
  'with the priced subtotal beside it');
select is((select unpriced_count from app.budget_version_totals where budget_version_id = pg_temp.id('v1')), 1, 'and the count');
select pg_temp.as_user('frank');
select is_empty($$select 1 from app.budget_versions$$, 'no versions without finance.budget.read');
select is_empty($$select 1 from app.budget_version_lines$$, 'and no lines');
select pg_temp.as_platform();
select ok(not exists (select 1 from pg_roles where rolname = 'xos_backup')
  or not has_table_privilege('xos_backup', 'app.budget_version_totals', 'select'), 'the backup login has no SELECT on the totals view');

select * from finish();
rollback;
