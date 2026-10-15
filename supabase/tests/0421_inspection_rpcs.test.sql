-- pgTAP: A09 inspection RPCs (migration 0421) and comment subjects (0960). Starting an inspection,
-- recording results with the canon enumeration, a Failed result opening exactly one punch item
-- (journey 17), sign-off separation and freezing, same-tenant allow, cross-tenant and anon deny,
-- Viewer deny, and the Compass sync allowlist.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(25);

select pg_temp.as_user('carol');
with x as (insert into app.inspection_templates (org_id, name) values (pg_temp.id('org_a'), 'Stage Walk') returning id) insert into world select 'tpl', id from x;
with x as (insert into app.inspection_items (inspection_template_id, position, prompt, is_critical) values (pg_temp.id('tpl'), 1, 'Deck edges guarded', true) returning id) insert into world select 'item1', id from x;
with x as (insert into app.inspection_items (inspection_template_id, position, prompt) values (pg_temp.id('tpl'), 2, 'Exits clear') returning id) insert into world select 'item2', id from x;
with x as (insert into app.inspection_templates (org_id, name) values (pg_temp.id('org_a'), 'Other Walk') returning id) insert into world select 'tpl2', id from x;
with x as (insert into app.inspection_items (inspection_template_id, position, prompt) values (pg_temp.id('tpl2'), 1, 'Other item') returning id) insert into world select 'other_item', id from x;

-- Start ------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into world values ('insp', app.start_inspection((select id from world where key = 'prj_a'), (select id from world where key = 'tpl'), null))$$,
  'a project Coordinator starts an inspection');
select is((select inspector_person_id from app.inspections where id = pg_temp.id('insp')), pg_temp.id('dave'), 'the inspector is the session person');
select throws_ok($$select app.start_inspection((select id from world where key = 'prj_a2'), (select id from world where key = 'tpl'), null)$$,
  '42501', null, 'a Coordinator cannot start an inspection on a project they are not on');
select pg_temp.as_user('xavier');
select throws_ok($$select app.start_inspection((select id from world where key = 'prj_a'), (select id from world where key = 'tpl'), null)$$,
  '42501', null, 'another org cannot start an inspection here');
select throws_ok($$select app.start_inspection((select id from world where key = 'prj_b'), (select id from world where key = 'tpl'), null)$$,
  '42501', null, 'a template of another org is not visible to this org''s project');
select pg_temp.as_anon();
select throws_ok($$select app.start_inspection((select id from world where key = 'prj_a'), (select id from world where key = 'tpl'), null)$$,
  '42501', null, 'anon cannot start an inspection');

-- Results and punch items ---------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into world values ('res1', app.record_inspection_result((select id from world where key = 'insp'), (select id from world where key = 'item1'), 'ENM-084', 'Rail missing at stage left.', null))$$,
  'a Failed result is recorded');
select is((select count(*)::int from app.punch_items where inspection_result_id = pg_temp.id('res1')), 1, 'a Failed result opens a punch item (journey 17)');
select is((select r.title || ' | ' || r.record_kind || ' | ' || r.record_subtype from app.punch_items p join app.records r on r.id = p.record_id where p.inspection_result_id = pg_temp.id('res1')),
  'Correct Deck edges guarded | Task | Execute', 'the punch task is the Execute task "Correct <item prompt>"');
select lives_ok($$select app.record_inspection_result((select id from world where key = 'insp'), (select id from world where key = 'item1'), 'ENM-084', 'Still missing.', null)$$,
  'recording the same failure again succeeds');
select is((select count(*)::int from app.punch_items where inspection_result_id = pg_temp.id('res1')), 1, 'the punch item is created once per result');
select is((select note from app.inspection_results where id = pg_temp.id('res1')), 'Still missing.', 'the result is replaced, not duplicated');
select lives_ok($$insert into world values ('res2', app.record_inspection_result((select id from world where key = 'insp'), (select id from world where key = 'item2'), 'ENM-082', null, null))$$,
  'a Passed result is recorded');
select is((select count(*)::int from app.punch_items where inspection_result_id = pg_temp.id('res2')), 0, 'a Passed result opens no punch item');
select throws_ok($$select app.record_inspection_result((select id from world where key = 'insp'), (select id from world where key = 'other_item'), 'ENM-082', null, null)$$,
  'XR001', null, 'a result answers an item of the inspection''s own template');
select throws_ok($$select app.record_inspection_result((select id from world where key = 'insp'), (select id from world where key = 'item2'), 'ENM-097', null, null)$$,
  'XR001', null, 'a result comes from the canon Inspection Result enumeration');
select pg_temp.as_user('gina');
select throws_ok($$select app.record_inspection_result((select id from world where key = 'insp'), (select id from world where key = 'item2'), 'ENM-082', null, null)$$,
  '42501', null, 'a Viewer cannot record results');

-- Sign-off --------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.sign_off_inspection((select id from world where key = 'insp'))$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'the inspector cannot sign off their own inspection');
select pg_temp.as_user('gina');
select throws_ok($$select app.sign_off_inspection((select id from world where key = 'insp'))$$, '42501', null, 'a Viewer cannot sign off');
select pg_temp.as_user('alice');
select lives_ok($$select app.sign_off_inspection((select id from world where key = 'insp'))$$, 'an Owner who is not the inspector signs off');
select is((select signed_off_by from app.inspections where id = pg_temp.id('insp')), pg_temp.id('alice'), 'the sign-off is recorded');
select throws_ok($$select app.sign_off_inspection((select id from world where key = 'insp'))$$,
  'XR001', 'inspection_signed_off: A signed-off inspection''s results never change.', 'an inspection is signed off once');
select pg_temp.as_user('dave');
select throws_ok($$select app.record_inspection_result((select id from world where key = 'insp'), (select id from world where key = 'item2'), 'ENM-084', null, null)$$,
  'XR001', null, 'results freeze at sign-off');

-- Allowlists -----------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from private.sync_rpcs where rpc in ('app.start_inspection', 'app.record_inspection_result', 'app.sign_off_inspection')), 3,
  'the inspection RPCs are allowlisted for Compass sync replay');
select is((select count(*)::int from private.comment_subjects where table_name in ('app.spaces', 'app.zones', 'app.capability_documents', 'app.site_plans', 'app.permit_requirements', 'app.inspection_templates', 'app.capability_statements', 'app.venues', 'app.inspections')), 9,
  'every Places and Safety table is commentable');

select * from finish();
rollback;
