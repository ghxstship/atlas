-- pgTAP: migration 2904 (B1, RRR-225; ADR 0140 D6 and D7). Signs are numbered per project, placed on a pin of their own
-- project, linked to an uncanceled order line of their project only by a reader of its orders, carry artwork attached to
-- themselves, and take their production marks only through app.mark_sign_step. Field crews on the project read and write
-- signs; a Viewer reads only. Signs, venue levels and site plan shapes are in Trash.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2681_supply_world.psql
\ir 2900_places_parts.psql

select * from no_plan();

-- Numbers and the display key -----------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.signs (project_id, title, sign_type, quantity, width_in, height_in, substrate, urid)
  values (pg_temp.id('prj_a'), 'Main entrance arrow', 'Directional', 4, 24, 36, 'Coroplast', '4000.05.02') returning id) insert into world select 's1', id from x;
with x as (insert into app.signs (project_id, title, sign_type) values (pg_temp.id('prj_a'), 'Bar menu', 'Menu') returning id) insert into world select 's2', id from x;
select is((select string_agg(sign_number::text, ',' order by sign_number) from app.signs where project_id = pg_temp.id('prj_a')), '1,2',
  'signs are numbered per project, as a Field crew member on the project writes them');
select is((select app.sign_display_key(s) from app.signs s where s.id = pg_temp.id('s2')), 'NWL-SGN-2', 'the display key is {project_key}-SGN-{n}');
select throws_ok($$update app.signs set sign_number = 9 where id = pg_temp.id('s1')$$, 'XR001', null, 'a sign keeps its number');
select throws_ok($$insert into app.signs (project_id, title, sign_type, urid) values (pg_temp.id('prj_a'), 'Odd', 'Menu', '5000.06.01')$$, '23514', null,
  'a sign keys only to the signage categories');

-- Guards ---------------------------------------------------------------------------------------------------------------------
select lives_ok($$update app.signs set site_plan_pin_id = pg_temp.id('pin_a') where id = pg_temp.id('s1')$$, 'a pin of the project places the sign');
select pg_temp.as_user('alice');
with x as (insert into app.site_plan_pins (site_plan_id, label, x_ratio, y_ratio)
  values (pg_temp.id('plan_b'), 'Gala door', 0.5, 0.5) returning id) insert into world select 'pin_b', id from x;
select pg_temp.as_user('frank');
select throws_ok($$update app.signs set site_plan_pin_id = pg_temp.id('pin_b') where id = pg_temp.id('s2')$$, 'XR001',
  'sign_pin_project: Place the sign on a pin of a site plan of its own project.', 'a pin on another project is refused');
select throws_ok($$update app.signs set po_line_id = pg_temp.id('l_deck') where id = pg_temp.id('s2')$$, 'XR001',
  'sign_po_line_read: Linking a purchase order line needs access to the project''s purchase orders.', 'linking an order line needs procurement.po.read');
select throws_ok($$update app.signs set ordered_at = now() where id = pg_temp.id('s2')$$, 'XR001',
  'sign_step_rpc_only: Mark a sign ordered, printed or placed with its step actions.', 'step stamps change only through mark_sign_step');
select throws_ok($$insert into app.signs (project_id, title, sign_type, placed_at, placed_by) values (pg_temp.id('prj_a'), 'Pre', 'Menu', now(), pg_temp.id('frank'))$$,
  'XR001', null, 'nor on insert');
select pg_temp.clean_file('art1', 'app.signs', pg_temp.id('s1'), 'arrow.png', 'image/png');
select pg_temp.clean_file('art_other', 'app.signs', pg_temp.id('s2'), 'menu.png', 'image/png');
select lives_ok($$update app.signs set artwork_version_id = pg_temp.id('art1') where id = pg_temp.id('s1')$$, 'artwork attached to the sign is its artwork');
select throws_ok($$update app.signs set artwork_version_id = pg_temp.id('art_other') where id = pg_temp.id('s1')$$, 'XR001',
  'sign_artwork_subject: The artwork is a file attached to this sign.', 'artwork on another subject is refused');

select pg_temp.as_user('carol');
select throws_ok($$update app.signs set po_line_id = pg_temp.id('l_deck'), printer_vendor_id = pg_temp.id('ven') where id = pg_temp.id('s2')$$, '23514', null,
  'with an order line the printer is the order''s vendor, never a copy');
select lives_ok($$update app.signs set po_line_id = pg_temp.id('l3') where id = pg_temp.id('s2')$$, 'a procurement reader links a line of the project');
select pg_temp.as_user('xavier');
with x as (insert into app.signs (project_id, title, sign_type) values (pg_temp.id('prj_b'), 'Pier', 'Menu') returning id) insert into world select 'sx', id from x;
select throws_ok($$update app.signs set po_line_id = pg_temp.id('l_deck') where id = pg_temp.id('sx')$$, null, null,
  'a line of another org''s project is refused');

-- Steps ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$select app.mark_sign_step(pg_temp.id('s2'), 'Ordered')$$, 'XR001',
  'sign_ordered_by_po: This sign is ordered through its purchase order line.', 'a sign with an order line is not marked ordered');
select throws_ok($$select app.mark_sign_step(pg_temp.id('s2'), 'Placed')$$, 'XR001',
  'sign_placed_needs_location: Give the sign a pin or a location before you mark it placed.', 'placing needs a location');
select lives_ok($$select app.mark_sign_step(pg_temp.id('s1'), 'Ordered')$$, 'a sign without a line is marked ordered');
select pg_temp.as_user('carol');
select throws_ok($$update app.signs set po_line_id = pg_temp.id('l_deck') where id = pg_temp.id('s1')$$, 'XR001',
  'sign_ordered_manually: This sign is marked ordered. Undo Mark ordered first, then link the order line.', 'an order line never overrides a manual mark');
select pg_temp.as_user('frank');
select app.mark_sign_step(pg_temp.id('s1'), 'Printed');
select app.mark_sign_step(pg_temp.id('s1'), 'Placed');
select is((select (ordered_at is not null)::text || (printed_at is not null)::text || (placed_by = pg_temp.id('frank'))::text from app.signs where id = pg_temp.id('s1')),
  'truetruetrue', 'each step is stamped, placed with the session person');
select app.mark_sign_step(pg_temp.id('s1'), 'Placed', false);
select is((select (placed_at is null and placed_by is null)::text from app.signs where id = pg_temp.id('s1')), 'true', 'undo clears the mark');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'sign.step_marked' and subject_id = pg_temp.id('s1')), 4, 'every mark emits sign.step_marked');
select pg_temp.as_user('frank');
select pg_temp.as_user('carol');
select app.transition_purchase_order(pg_temp.id('po3'), 'Proposed', 'Canceled', 'Not needed.');
with x as (insert into app.signs (project_id, title, sign_type) values (pg_temp.id('prj_a'), 'Sponsor wall', 'Sponsor') returning id) insert into world select 's3', id from x;
select throws_ok($$update app.signs set po_line_id = pg_temp.id('l3') where id = pg_temp.id('s3')$$, 'XR001',
  'sign_po_line_project: Link a line of a purchase order of this project that is not canceled.', 'a line of a canceled order is refused');
select pg_temp.as_user('frank');
select lives_ok($$update app.signs set location_text = 'By the bar' where id = pg_temp.id('s2')$$, 'a sign whose order was later canceled stays editable');

-- Access -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select ok((select count(*) from app.signs where project_id = pg_temp.id('prj_a')) = 3, 'a Viewer reads the signs');
select throws_ok($$insert into app.signs (project_id, title, sign_type) values (pg_temp.id('prj_a'), 'Viewer', 'Menu')$$, '42501', null, 'but writes none');
select throws_ok($$select app.mark_sign_step(pg_temp.id('s1'), 'Printed', false)$$, '42501', null, 'nor marks a step');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.signs where project_id = pg_temp.id('prj_a')), 0, 'another org reads none');

-- Registration -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(exists (select 1 from app.comment_subjects where table_name = 'app.signs'), 'signs take comments and attachments');
select ok(exists (select 1 from app.custom_field_targets where table_name = 'app.signs'), 'and custom fields');
select set_eq($$select table_name from private.trash_tables where table_name in ('signs', 'venue_levels', 'site_plan_shapes')$$,
  $$values ('signs'), ('venue_levels'), ('site_plan_shapes')$$, 'signs, venue levels and shapes are in Trash');
select is((select title_column from private.trash_tables where table_name = 'site_plan_shapes'), 'label', 'a shape is listed by its label');
select is((select title_column from private.trash_tables where table_name = 'venue_levels'), 'name', 'a level by its name');
select ok(not exists (select 1 from private.trash_tables where table_name in ('place_specs', 'site_plan_state_transitions')),
  'specs and the plan ledger stay out of Trash');
select pg_temp.as_user('frank');
update app.signs set deleted_at = now() where id = pg_temp.id('s2');
select ok(exists (select 1 from app.trash_items where subject_table = 'signs' and subject_id = pg_temp.id('s2')), 'a deleted sign is in Trash');
update app.signs set deleted_at = null where id = pg_temp.id('s2');
select is((select deleted_at from app.signs where id = pg_temp.id('s2')), null, 'and restores');

select * from finish();
rollback;
