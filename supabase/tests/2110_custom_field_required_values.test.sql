-- pgTAP: a required custom field is required on the write path (A117, RRR-162, 2110). A value row of a required
-- field needs its typed column filled and cannot be soft deleted; optional fields clear as before, and a field made
-- optional again clears freely.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(11);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

select pg_temp.as_user('bob');
insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, required, filterable, sort_order) values
  (pg_temp.id('org_a'), 'app.projects', 'po_reference', 'PO Reference', 'Text', true, true, 1),
  (pg_temp.id('org_a'), 'app.projects', 'seats', 'Seats', 'Number', false, false, 2),
  (pg_temp.id('org_a'), 'app.projects', 'tier', 'Tier', 'Choice', true, true, 3);
insert into k select field_key, id from app.custom_field_definitions where org_id = pg_temp.id('org_a');
insert into app.custom_field_choices (custom_field_definition_id, choice_key, label, sort_order) values
  ((select id from k where key = 'tier'), 'gold', 'Gold', 1);

select pg_temp.as_user('dave');
select throws_like(
  $$insert into app.custom_field_values (custom_field_definition_id, target_id) values ((select id from k where key = 'po_reference'), pg_temp.id('prj_a'))$$,
  'custom_value_required: PO Reference is required%', 'a required field''s value row needs a value');
select lives_ok(
  $$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values ((select id from k where key = 'po_reference'), pg_temp.id('prj_a'), 'PO-2207')$$,
  'a required field takes a value in its typed column');
select throws_like(
  $$update app.custom_field_values set value_text = null where custom_field_definition_id = (select id from k where key = 'po_reference')$$,
  'custom_value_required:%', 'a required value cannot be emptied');
select throws_like(
  $$update app.custom_field_values set deleted_at = now() where custom_field_definition_id = (select id from k where key = 'po_reference')$$,
  'custom_value_required:%', 'a required value cannot be removed');
select lives_ok(
  $$update app.custom_field_values set value_text = 'PO-2208' where custom_field_definition_id = (select id from k where key = 'po_reference')$$,
  'a required value changes to another value');
select throws_like(
  $$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values ((select id from k where key = 'tier'), pg_temp.id('prj_a'), 'gold')$$,
  'custom_value_type:%', 'a value in the wrong column is still refused for its type before required is judged');
select lives_ok(
  $$insert into app.custom_field_values (custom_field_definition_id, target_id, value_choice_id) values ((select id from k where key = 'tier'), pg_temp.id('prj_a'), (select id from app.custom_field_choices where choice_key = 'gold'))$$,
  'a required choice takes an option of its field');

select lives_ok(
  $$insert into app.custom_field_values (custom_field_definition_id, target_id, value_number) values ((select id from k where key = 'seats'), pg_temp.id('prj_a'), 1200)$$,
  'an optional field takes a value');
select lives_ok(
  $$update app.custom_field_values set deleted_at = now() where custom_field_definition_id = (select id from k where key = 'seats')$$,
  'an optional value is removed as before');

select pg_temp.as_user('bob');
update app.custom_field_definitions set required = false where field_key = 'po_reference' and org_id = pg_temp.id('org_a');
select pg_temp.as_user('dave');
select lives_ok(
  $$update app.custom_field_values set deleted_at = now() where custom_field_definition_id = (select id from k where key = 'po_reference')$$,
  'once the field is optional its value is removed freely');

select pg_temp.as_platform();
select is(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'private.guard_custom_field_value()'::regprocedure),
  true, 'the guard stays security definer with an empty search_path');

select * from finish();
rollback;
