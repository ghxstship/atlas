-- pgTAP: submittals, sponsor assets, entitlement deliveries and proof of performance (migration 0492),
-- plus the 0995 audit trail and comment subjects. Same-tenant allow, cross-tenant deny, anon deny,
-- role bands, every allowed and refused move, sod_approval_requester, revisions, guards and the view.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(44);

select pg_temp.as_user('alice');
insert into world values ('cp', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
insert into world values ('cp_s', app.create_counterparty(pg_temp.id('org_a'), 'Gulfside Brewing', 'Sponsor'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp')) returning id) insert into world select 'ven', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a2'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po_other', id from x;

-- Submittals ------------------------------------------------------------------------------------------------
with x as (insert into app.submittals (project_id, vendor_id, submittal_kind, title, spec_reference)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'Shop Drawing', 'Main stage deck framing', 'S-101') returning id)
  insert into world select 'sub', id from x;
select is((select org_id from app.submittals where id = pg_temp.id('sub')), pg_temp.id('org_a'), 'the org comes from the project');
select ok((select submittal_number from app.submittals where id = pg_temp.id('sub')) > 0, 'the number comes from the project sequence');
select is((select submittal_state::text from app.submittals where id = pg_temp.id('sub')), 'Proposed', 'a submittal starts Proposed');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'submittal'), 7, 'the submittal lifecycle declares seven moves');
select throws_ok($$insert into app.submittals (project_id, vendor_id, purchase_order_id, submittal_kind, title)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'ven'), (select id from world where key = 'po_other'), 'Product Data', 'Wrong order')$$,
  'XR001', 'submittal_order_project: A submittal supports a purchase order of its own project.', 'a purchase order of another project is refused');
select throws_ok($$insert into app.submittals (project_id, vendor_id, submittal_kind, title, revision)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'ven'), 'Sample', 'Revised', 2)$$,
  'XR001', null, 'the revision is never set by hand');
select throws_ok($$update app.submittals set submittal_state = 'Approved' where id = (select id from world where key = 'sub')$$,
  'XR001', null, 'the state changes only through the RPC');
select throws_ok($$update app.submittals set decided_at = now() where id = (select id from world where key = 'sub')$$,
  'XR001', null, 'decision columns change only through the RPC');
select throws_ok($$update app.submittals set vendor_id = (select id from world where key = 'ven') , project_id = (select id from world where key = 'prj_a2') where id = (select id from world where key = 'sub')$$,
  'XR001', null, 'the project never changes');
-- Asked by someone other than the creator, so sod_approval_requester passes and the rules refuse (A54-003).
select pg_temp.as_user('bob');
select throws_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Proposed', 'Approved', 'Skip.')$$,
  'XR001', 'submittal_transition_not_allowed: A submittal cannot move from Proposed to Approved.', 'a Proposed submittal cannot be approved before it is submitted');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Proposed', 'Submitted', 'Drawings attached.')$$, 'Proposed to Submitted');
select throws_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Submitted', 'Approved', 'Mine.')$$,
  'XR001', null, 'the creator cannot approve (sod_approval_requester)');
select throws_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Proposed', 'Submitted', 'Stale.')$$,
  'XR001', 'submittal_state_conflict: The submittal is not in the expected state Proposed.', 'compare-and-set refuses a stale state');
select pg_temp.as_user('bob');
select lives_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Submitted', 'Returned', 'Add connection details.')$$, 'another person returns it');
select is((select decided_by from app.submittals where id = pg_temp.id('sub')), pg_temp.id('bob'), 'the reviewer is recorded');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Returned', 'Submitted', 'Revised drawings.')$$, 'Returned to Submitted');
select is((select revision from app.submittals where id = pg_temp.id('sub')), 1, 'resubmitting raises the revision');
select pg_temp.as_user('bob');
select lives_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Submitted', 'Approved', 'Approved as drawn.')$$, 'another person approves');
select throws_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Approved', 'Canceled', 'Late.')$$, 'XR001', 'submittal_transition_not_allowed: A submittal cannot move from Approved to Canceled.', 'an approved submittal is final');
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('sub') and event_type = 'submittal.state_changed'), 4, 'each move emits submittal.state_changed');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.submittals where id = pg_temp.id('sub')), 1, 'a project member reads the submittal');
select throws_ok($$select app.transition_submittal((select id from world where key = 'sub'), 'Approved', 'Canceled', 'x')$$, '42501', null, 'a Member cannot move a submittal');
select throws_ok($$insert into app.submittals (project_id, vendor_id, submittal_kind, title) values ((select id from world where key = 'prj_a'), (select id from world where key = 'ven'), 'Other', 'Member try')$$,
  '42501', null, 'a Member cannot create submittals');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.submittals), 0, 'a Viewer outside the project reads none');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.submittals where org_id = pg_temp.id('org_a')), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.submittals', '42501', null, 'anon cannot read submittals');

-- Sponsor assets ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s'), 'Logo on the main stage scrim.', 4) returning id) insert into world select 'ent', id from x;
with x as (insert into app.sponsor_entitlements (project_id, counterparty_id, description)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s'), 'Naming rights on the VIP terrace.') returning id) insert into world select 'ent2', id from x;
with x as (insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title) values (pg_temp.id('ent'), 'Logo', 'Gulfside primary logo') returning id)
  insert into world select 'asset', id from x;
select is((select org_id from app.sponsor_assets where id = pg_temp.id('asset')), pg_temp.id('org_a'), 'the asset''s org comes from its entitlement');
select lives_ok($$select app.transition_sponsor_asset((select id from world where key = 'asset'), 'Proposed', 'Submitted', 'Artwork uploaded.')$$, 'Proposed to Submitted');
select throws_ok($$select app.transition_sponsor_asset((select id from world where key = 'asset'), 'Submitted', 'Approved', 'Mine.')$$,
  'XR001', null, 'the uploader cannot approve');
select pg_temp.as_user('bob');
select lives_ok($$select app.transition_sponsor_asset((select id from world where key = 'asset'), 'Submitted', 'Approved', 'Brand approved.')$$, 'another person approves');
select throws_ok($$select app.transition_sponsor_asset((select id from world where key = 'asset'), 'Approved', 'Returned', 'Undo.')$$, 'XR001', 'sponsor_asset_transition_not_allowed: A sponsor asset cannot move from Approved to Returned.', 'an approved asset is final');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title) values ((select id from world where key = 'ent'), 'Copy', 'Member try')$$,
  '42501', null, 'a Member cannot add sponsor assets');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.sponsor_assets where org_id = pg_temp.id('org_a')), 0, 'another org reads no sponsor assets');

-- Deliveries and proof of performance ------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.as_user('carol');
insert into app.entitlement_deliveries (sponsor_entitlement_id, delivered_on, quantity_delivered, note) values (pg_temp.id('ent'), '2026-07-04', 2, 'Two scrims hung.');
select is((select recorded_by from app.entitlement_deliveries where sponsor_entitlement_id = pg_temp.id('ent')), pg_temp.id('carol'), 'the recorder comes from the session');
select is((select is_met from app.sponsor_proof_of_performance where sponsor_entitlement_id = pg_temp.id('ent')), false, 'two of four is not met');
insert into app.entitlement_deliveries (sponsor_entitlement_id, delivered_on, quantity_delivered) values (pg_temp.id('ent'), '2026-07-05', 2);
select is((select quantity_delivered from app.sponsor_proof_of_performance where sponsor_entitlement_id = pg_temp.id('ent')), 4::numeric, 'deliveries sum');
select is((select is_met from app.sponsor_proof_of_performance where sponsor_entitlement_id = pg_temp.id('ent')), true, 'four of four is met');
insert into app.entitlement_deliveries (sponsor_entitlement_id, delivered_on) values (pg_temp.id('ent2'), '2026-07-05');
select is((select quantity_delivered from app.sponsor_proof_of_performance where sponsor_entitlement_id = pg_temp.id('ent2')), null::numeric, 'an uncounted delivery leaves the sum NULL');
select is((select is_met from app.sponsor_proof_of_performance where sponsor_entitlement_id = pg_temp.id('ent2')), false, 'an uncountable entitlement is met only when marked fulfilled');
select throws_ok($$update app.entitlement_deliveries set recorded_by = (select id from world where key = 'bob') where sponsor_entitlement_id = (select id from world where key = 'ent2')$$,
  'XR001', null, 'the recorder never changes');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.sponsor_proof_of_performance where project_id = pg_temp.id('prj_a')), 0, 'another org reads no proof of performance');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('ent') or (event_type = 'entitlement_delivery.recorded' and org_id = pg_temp.id('org_a'))), 3, 'each delivery emits entitlement_delivery.recorded');

-- Late slot: audit and comment subjects ------------------------------------------------------------------------------
select ok(exists (select 1 from app.audit_events where subject_id = pg_temp.id('sub')), 'submittal changes reach the audit ledger');
select ok(exists (select 1 from private.comment_subjects where table_name = 'app.submittals'), 'submittals carry comments and attachments');

select * from finish();
rollback;
