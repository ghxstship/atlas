-- pgTAP: migration 3007 (B11, G-106), material import. Both targets and their destinations, the destination guard, who
-- may see a job, commit inside the destination, strong keys, catalogue matching, the currency rule, and undo on an order
-- past Proposed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 3001_supply_world.psql

select no_plan();

create function pg_temp.path(p_person text) returns text
language sql as $$ select pg_temp.id(p_person) || '/' || gen_random_uuid() || '.csv' $$;
create function pg_temp.po_job(p_person text, p_order text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.as_user(p_person);
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, purchase_order_id)
  values (pg_temp.id('org_a'), 'po_lines', 'CSV', 'lines.csv', pg_temp.path(p_person), pg_temp.id(p_order)) returning id into v_id;
  return v_id;
end $$;
create function pg_temp.need_job(p_person text, p_project text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.as_user(p_person);
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, project_id)
  values (pg_temp.id('org_a'), 'procurement_needs', 'CSV', 'needs.csv', pg_temp.path(p_person), pg_temp.id(p_project)) returning id into v_id;
  return v_id;
end $$;

-- 1. Targets ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select destination from app.import_targets where code = 'procurement_needs'), 'project_id', 'needs import into a project');
select is((select destination from app.import_targets where code = 'po_lines'), 'purchase_order_id', 'order lines into a purchase order');
select set_eq($$select field_name from app.import_target_fields where target_code = 'po_lines' and strong_key$$, $$values ('line_number')$$, 'an order line''s strong key is its number');
select set_eq($$select field_name from app.import_target_fields where target_code = 'procurement_needs' and strong_key$$, $$values ('description')$$, 'a need''s is its description');

-- 2. The destination guard ----------------------------------------------------------------------------------------------------------------
select pg_temp.order_with('o1', 2);
insert into world select 'j_po', pg_temp.po_job('carol', 'o1');
select pg_temp.as_platform();
select is((select project_id from app.import_jobs where id = pg_temp.id('j_po')), pg_temp.id('prj_a'), 'a po_lines job carries the order''s project');
select pg_temp.as_user('carol');
select throws_like(format($$update app.import_jobs set purchase_order_id = null where id = %L$$, pg_temp.id('j_po')), 'import_job_immutable:%', 'the order is fixed once set');
select throws_like(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path) values (%L, 'po_lines', 'CSV', 'x.csv', %L)$$, pg_temp.id('org_a'), pg_temp.path('carol')), 'import_destination_required:%', 'naming no order refuses');
select throws_like(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, purchase_order_id, project_id) values (%L, 'po_lines', 'CSV', 'x.csv', %L, %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('carol'), pg_temp.id('o1'), pg_temp.id('prj_a')), 'import_destination_unexpected:%', 'naming a project too refuses');
select throws_like(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, purchase_order_id) values (%L, 'procurement_needs', 'CSV', 'x.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('carol'), pg_temp.id('o1')), 'import_destination_unexpected:%', 'a need job names no order');
select throws_like(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, purchase_order_id) values (%L, 'venues', 'CSV', 'x.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('carol'), pg_temp.id('o1')), 'import_destination_unexpected:%', 'nor does an org-wide target');
select pg_temp.order_with('o_sent', 2);
select pg_temp.approve_order('o_sent');
select throws_like($$select pg_temp.po_job('carol', 'o_sent')$$, 'import_po_not_proposed:%', 'a po_lines job on a non-Proposed order refuses import_po_not_proposed');

-- 3. Who may see it -------------------------------------------------------------------------------------------------------------------------
select pg_temp.producer('reader', 'procurement.po.read');
select pg_temp.as_user('reader');
select is((select count(*)::integer from app.import_jobs where id = pg_temp.id('j_po')), 0, 'a reader without procurement.po.write cannot see the job');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.import_jobs where id = pg_temp.id('j_po')), 1, 'a writer can');
select pg_temp.as_user('reader');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, purchase_order_id) values (%L, 'po_lines', 'CSV', 'x.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('reader'), pg_temp.id('o1')), '42501', null, 'nor start one');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.import_destinations(pg_temp.id('org_a'), 'po_lines')), 0, 'another org lists no destination');
select pg_temp.as_user('carol');
select ok(exists (select 1 from app.import_destinations(pg_temp.id('org_a'), 'po_lines') d where d.destination_id = pg_temp.id('o1') and d.label like 'NWL-PO-% · %'), 'Proposed orders list by key and vendor');
select is((select count(*)::integer from app.import_destinations(pg_temp.id('org_a'), 'po_lines') d where d.destination_id = pg_temp.id('o_sent')), 0, 'orders past Proposed do not');
select ok(exists (select 1 from app.import_destinations(pg_temp.id('org_a'), 'procurement_needs') d where d.destination_id = pg_temp.id('prj_a')), 'projects list for needs');

-- 4. Commit inside the destination ------------------------------------------------------------------------------------------------------------
create function pg_temp.row_of(p_job uuid, p_batch out uuid, p_row out uuid) language plpgsql as $$
begin
  perform pg_temp.as_platform();
  update app.import_jobs set import_status = 'Detected' where id = p_job;
  update app.import_jobs set import_status = 'Mapped', mapping_confirmed_at = now(), mapping_confirmed_by = pg_temp.id('carol') where id = p_job;
  update app.import_jobs set import_status = 'Validated' where id = p_job;
  p_row := app.record_import_row(p_job, 'Sheet', 2, 'Valid');
  update app.import_jobs set import_status = 'Committing' where id = p_job;
  insert into app.import_batches (import_job_id) values (p_job) returning id into p_batch;
end $$;

select pg_temp.as_platform();
insert into world select 'j_row', r.p_row from pg_temp.row_of(pg_temp.id('j_po')) r;
insert into world select 'j_batch', b.id from app.import_batches b where b.import_job_id = pg_temp.id('j_po');
select pg_temp.order_with('o2', 2);
select pg_temp.as_platform();
select throws_like(format($$select app.commit_import_write(%L, %L, %L, 'Created')$$, pg_temp.id('j_row'), pg_temp.id('j_batch'), pg_temp.id('o2_l')), 'import_target_outside_destination:%', 'a row outside the destination refuses');
select lives_ok(format($$select app.commit_import_write(%L, %L, %L, 'Created')$$, pg_temp.id('j_row'), pg_temp.id('j_batch'), pg_temp.id('o1_l')), 'a row of the order commits');

-- 5. Strong keys ---------------------------------------------------------------------------------------------------------------------------------
select is(app.import_strong_key_match(pg_temp.id('j_po'), '{"line_number":"1"}'), pg_temp.id('o1_l'), 'an order line matches on its number inside the order');
select is(app.import_strong_key_match(pg_temp.id('j_po'), '{"line_number":"9"}'), null::uuid, 'and not otherwise');
insert into world select 'j_need', pg_temp.need_job('carol', 'prj_a');
select pg_temp.as_user('carol');
select app.add_procurement_needs(pg_temp.id('prj_a'), '[{"description":"  Shure SM58  ","quantity":3}]');
select pg_temp.as_platform();
select ok(app.import_strong_key_match(pg_temp.id('j_need'), '{"description":" shure sm58 "}') is not null, 'a need matches on its trimmed, lower-case description');
insert into world select 'j_need2', pg_temp.need_job('alice', 'prj_a2');
select pg_temp.as_platform();
select is(app.import_strong_key_match(pg_temp.id('j_need2'), '{"description":"shure sm58"}'), null::uuid, 'only inside its project');

-- 6. Catalogue matching -------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.vendor_products (vendor_id, vendor_sku, element_id, unit_price_minor, currency_code) values
  (pg_temp.id('ven'), 'SKU-1', '3000.05.01-GHXST-010', 4200, 'USD'),
  (pg_temp.id('ven'), 'SKU-2', '3000.05.01-GHXST-011', 7700, 'EUR');
select pg_temp.as_platform();
select is((select m.element_id from app.import_material_match(pg_temp.id('j_po'), 'SKU-1', 'anything') m), '3000.05.01-GHXST-010', 'an exact SKU of the order''s vendor gives the element');
select is((select m.unit_price_minor from app.import_material_match(pg_temp.id('j_po'), 'SKU-1', null) m), 4200::bigint, 'and the price');
select is((select m.currency_code || '/' || m.order_currency_code from app.import_material_match(pg_temp.id('j_po'), 'SKU-2', null) m), 'EUR/USD', 'with both currencies, so the worker leaves a foreign price blank');
select is((select m.match_source from app.import_material_match(pg_temp.id('j_po'), null, 'truss sections') m), 'asset_class', 'an exact class name matches');
select is((select m.asset_class_id from app.import_material_match(pg_temp.id('j_po'), null, 'Truss Sectionss') m), pg_temp.id('cls_truss'), 'and a near one at 0.85');
select is((select count(*)::integer from app.import_material_match(pg_temp.id('j_po'), 'NOPE', 'Fog machine') m), 0, 'an unmatched row names nothing');

-- 7. Undo ---------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.import_batches set committed_at = now() where id = pg_temp.id('j_batch');
update app.import_jobs set import_status = 'Committed' where id = pg_temp.id('j_po');
select pg_temp.approve_order('o1');
select pg_temp.as_user('carol');
select results_eq(format($$select reverted, kept from app.undo_import_batch(%L, 'Wrong file.')$$, pg_temp.id('j_batch')), $$values (0, 1)$$, 'undo keeps a line of an order past Proposed instead of failing the batch');
select pg_temp.as_platform();
select is((select undo_reason from app.import_row_results where id = pg_temp.id('j_row')), 'The purchase order is no longer Proposed.', 'with a reason');
select is((select deleted_at from app.po_lines where id = pg_temp.id('o1_l')), null::timestamptz, 'and the line stays');

-- A Proposed order reverts.
select pg_temp.order_with('o3', 2);
insert into world select 'j3', pg_temp.po_job('carol', 'o3');
select pg_temp.as_platform();
insert into world select 'j3_row', r.p_row from pg_temp.row_of(pg_temp.id('j3')) r;
insert into world select 'j3_batch', b.id from app.import_batches b where b.import_job_id = pg_temp.id('j3');
select app.commit_import_write(pg_temp.id('j3_row'), pg_temp.id('j3_batch'), pg_temp.id('o3_l'), 'Created');
update app.import_batches set committed_at = now() where id = pg_temp.id('j3_batch');
update app.import_jobs set import_status = 'Committed' where id = pg_temp.id('j3');
select pg_temp.as_user('carol');
select results_eq(format($$select reverted, kept from app.undo_import_batch(%L, 'Wrong file.')$$, pg_temp.id('j3_batch')), $$values (1, 0)$$, 'undo reverts a line on a Proposed order');

select * from finish();
rollback;
