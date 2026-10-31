-- pgTAP: migration 2695 (R7), the computed status. display_status for every branch, issued and returned counted from the
-- possession rows, no price column, no select for xos_backup, the holders view, and catering counts: the headcount,
-- dietary needs suppressed below five, the allergy row only with data.restricted.read.medical, and one access-log row
-- per person counted.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

-- A person on the vendor roster, accepted by both sides.
create function pg_temp.rostered(p_key text, p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.new_user(p_key, p_key || '@bayside-audio.test', p_name);
  perform pg_temp.as_user('victor');
  perform app.add_account_member(pg_temp.id('acct_v'), pg_temp.id(p_key), 'Account Member');
  perform pg_temp.as_user(p_key);
  perform app.accept_account_membership(pg_temp.membership('acct_v', p_key));
  perform pg_temp.as_user('victor');
  v := app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id(p_key), '9000.50.02');
  perform app.submit_roster(pg_temp.id('eng_vendor_a'));
  perform pg_temp.as_user('carol');
  perform app.review_roster_entry(v, 'Accepted');
  perform pg_temp.as_user(p_key);
  perform app.respond_roster_entry(v, 'Accepted');
  perform pg_temp.as_platform();
  return v;
end $$;

-- Catering for the person, shared with Dietary Needs.
create function pg_temp.eats(p_key text, p_entry text, p_needs app.dietary_need[], p_allergies text, p_event uuid) returns void
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user(p_key);
  perform app.ensure_my_work_details();
  update app.person_work_details set dietary_needs = p_needs, allergies = p_allergies where person_id = pg_temp.id(p_key);
  perform app.share_work_details(pg_temp.id('eng_vendor_a'), '{Dietary Needs}');
  v := pg_temp.alloc('assign', 'carol', p_entry, 'fulfillment', 'ful_cat', 1);
  perform pg_temp.as_user('alice');
  perform app.issue_allocation(p_event, v, '[{}]');
  perform pg_temp.as_platform();
end $$;

-- Every branch ----------------------------------------------------------------------------------------------------------------
insert into world select 'requested', pg_temp.alloc('request', 'dave', 'e_kai', 'travel', null, 1);
select is(pg_temp.status_of(pg_temp.id('requested')), 'Requested', 'Requested');
insert into world select 'declined', pg_temp.alloc('request', 'dave', 'e_kai', 'travel', null, 1);
select pg_temp.as_user('carol');
select app.decide_allocation(pg_temp.id('declined'), 'Rejected', 'Flying with the band.');
select is(pg_temp.status_of(pg_temp.id('declined')), 'Declined', 'Declined');
select pg_temp.as_user('carol');
select is((select decline_reason || ' ' || decided_by::text from app.advance_allocation_status where allocation_id = pg_temp.id('declined')),
  'Flying with the band. ' || pg_temp.id('carol')::text, 'the decision and its reason come from the ledger');
insert into world select 'withdrawn', pg_temp.alloc('request', 'dave', 'e_kai', 'travel', null, 1);
select pg_temp.as_user('dave');
select app.withdraw_allocation(pg_temp.id('withdrawn'));
select is(pg_temp.status_of(pg_temp.id('withdrawn')), 'Withdrawn', 'Withdrawn');
insert into world select 'approved', pg_temp.alloc('assign', 'carol', 'e_kai', 'travel', null, 1);
select is(pg_temp.status_of(pg_temp.id('approved')), 'Approved', 'Approved with nothing held or issued');
insert into world select 'reserved', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_radio', 2);
select is(pg_temp.status_of(pg_temp.id('reserved')), 'Reserved', 'Reserved when holds cover the quantity');

-- The rental line: Sent and not acknowledged, then acknowledged, then received.
insert into world select 'ordered', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_radio', 1, null,
  jsonb_build_array(jsonb_build_object('source', 'Order Line', 'po_line_id', pg_temp.id('l_rent'), 'quantity', 1)));
select is(pg_temp.status_of(pg_temp.id('ordered')), 'On Order', 'On Order while the vendor has not acknowledged');
select pg_temp.as_platform();
insert into app.po_acknowledgments (purchase_order_id, acknowledged_by) values (pg_temp.id('po_rent'), pg_temp.id('victor'));
select is(pg_temp.status_of(pg_temp.id('ordered')), 'Confirmed', 'Confirmed once acknowledged');
select pg_temp.as_user('carol');
select app.receive_goods('01920000-0000-7000-8695-000000000001', pg_temp.id('po_rent'),
  jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_rent'), 'quantity', 2, 'asset_tags', jsonb_build_array('NWL-RNT-101', 'NWL-RNT-102'))));
select is(pg_temp.status_of(pg_temp.id('ordered')), 'Received', 'Received once the line came in');
select pg_temp.as_user('carol');
select is((select received_quantity from app.advance_allocation_status where allocation_id = pg_temp.id('ordered')), 1::numeric,
  'received counts up to what the hold holds');

-- A Proposed order.
select pg_temp.as_user('carol');
insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD');
insert into world select 'po_draft', id from app.purchase_orders where project_id = pg_temp.id('prj_a') and po_state = 'Proposed';
insert into app.po_lines (purchase_order_id, line_number, description, element_id, quantity, unit_price_minor)
values (pg_temp.id('po_draft'), 1, 'Radios to buy.', '3000.05.01-GHXST-013', 3, 40000);
insert into world select 'l_draft', id from app.po_lines where purchase_order_id = pg_temp.id('po_draft');
insert into world select 'awaiting', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_radio', 1, null,
  jsonb_build_array(jsonb_build_object('source', 'Order Line', 'po_line_id', pg_temp.id('l_draft'), 'quantity', 1)));
select is(pg_temp.status_of(pg_temp.id('awaiting')), 'Awaiting Order', 'Awaiting Order while its order is Proposed');

-- Issued, partly, returned, revoked.
insert into world select 'two', pg_temp.alloc('assign', 'carol', 'e_kai', 'class', 'cls_radio', 2, null, null,
  '2027-07-10 12:00+00', '2027-07-12 12:00+00');
select pg_temp.as_user('alice');
select app.issue_allocation('01920000-0000-7000-8695-000000000002', pg_temp.id('two'), '[{"asset_tag": "NWL-RAD-001"}]');
select is(pg_temp.status_of(pg_temp.id('two')), 'Partly Issued', 'Partly Issued');
select pg_temp.as_user('alice');
select app.issue_allocation('01920000-0000-7000-8695-000000000003', pg_temp.id('two'), '[{"asset_tag": "NWL-RAD-002"}]');
select is(pg_temp.status_of(pg_temp.id('two')), 'Issued', 'Issued');
select pg_temp.as_user('carol');
select is((select issued_quantity from app.advance_allocation_status where allocation_id = pg_temp.id('two')), 2::numeric,
  'issued is counted from the custody rows');
select pg_temp.as_user('alice');
-- Check-in ids sort after the issue rows written in this same transaction (created_at is the transaction time).
select app.apply_asset_scan('f1920000-0000-7000-8695-000000000004', pg_temp.id('org_a'), 'NWL-RAD-001', 'check-in');
select app.apply_asset_scan('f1920000-0000-7000-8695-000000000005', pg_temp.id('org_a'), 'NWL-RAD-002', 'check-in');
select is(pg_temp.status_of(pg_temp.id('two')), 'Returned', 'Returned once both are checked in');

insert into world select 'badge', pg_temp.alloc('assign', 'carol', 'e_kai', 'category', 'cat_crew', 1);
select pg_temp.as_user('alice');
select app.issue_allocation('01920000-0000-7000-8695-000000000006', pg_temp.id('badge'), '[{}]');
update app.credentials set revoked_at = now() where allocation_id = pg_temp.id('badge');
select is(pg_temp.status_of(pg_temp.id('badge')), 'Revoked', 'Revoked when its credentials are');

-- Shape and grants ----------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from information_schema.columns
           where table_schema = 'app' and table_name = 'advance_allocation_status' and column_name ~ 'price|minor|cost'), 0, 'no price column');
select ok(not has_table_privilege('xos_backup', 'app.advance_allocation_status', 'select'), 'xos_backup reads no status');
select ok(not has_table_privilege('xos_backup', 'app.allocation_holders', 'select'), 'nor holders');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.advance_allocation_status), 0, 'a viewer outside the project reads none');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.allocation_holders where engagement_id = pg_temp.id('eng_vendor_a') and holder_kind = 'Pool'), 1,
  'the vendor is one pool');
select is((select holder_name from app.allocation_holders where roster_entry_id = pg_temp.id('e_kai')), 'Kai Morgan', 'and Kai a person on it');

-- Catering counts -------------------------------------------------------------------------------------------------------------------
select pg_temp.eats('kai', 'e_kai', '{Vegan}', 'Shellfish', '01920000-0000-7000-8695-000000000101');
select pg_temp.eats('mo', 'e_mo', '{Vegan,Halal}', null, '01920000-0000-7000-8695-000000000102');
insert into world select 'e_p1', pg_temp.rostered('p1', 'Pat One');
insert into world select 'e_p2', pg_temp.rostered('p2', 'Pat Two');
insert into world select 'e_p3', pg_temp.rostered('p3', 'Pat Three');
select pg_temp.eats('p1', 'e_p1', '{Vegan}', 'Nuts', '01920000-0000-7000-8695-000000000103');
select pg_temp.eats('p2', 'e_p2', '{Vegan}', null, '01920000-0000-7000-8695-000000000104');
select pg_temp.eats('p3', 'e_p3', '{Vegan}', null, '01920000-0000-7000-8695-000000000105');
select pg_temp.as_user('hops');
select is((select headcount from app.catering_counts(pg_temp.id('ful_cat')) where dietary_need is null), 5, 'five people are on the catering');
select is((select headcount::text || ' ' || suppressed::text from app.catering_counts(pg_temp.id('ful_cat')) where dietary_need = 'Vegan'),
  '5 false', 'five vegans are counted');
select is((select coalesce(headcount::text, 'null') || ' ' || suppressed::text from app.catering_counts(pg_temp.id('ful_cat')) where dietary_need = 'Halal'),
  'null true', 'one halal meal is suppressed below five');
select is((select count(*)::int from app.catering_counts(pg_temp.id('ful_cat')) where dietary_need = 'Allergies'), 0,
  'no allergy row without data.restricted.read.medical');
select pg_temp.as_platform();
select is(pg_temp.events('mo', 'dietary_needs.counted'), 4, 'each call logs one row for each person counted');
select is(pg_temp.events('mo', 'allergies.counted'), 0, 'and no allergy count');
insert into app.user_capability_grants (org_id, membership_id, capability_code, scope_kind, scope_id, reason)
select pg_temp.id('org_a'), m.id, 'data.restricted.read.medical', 'project', pg_temp.id('prj_a'), 'Catering lead for the series.'
from app.memberships m where m.person_id = pg_temp.id('hops') and m.org_id = pg_temp.id('org_a') and m.deleted_at is null;
select pg_temp.as_user('hops');
select is((select coalesce(headcount::text, 'null') || ' ' || suppressed::text from app.catering_counts(pg_temp.id('ful_cat')) where dietary_need = 'Allergies'),
  'null true', 'with the medical capability the allergy row appears, suppressed below five');
select pg_temp.as_platform();
select is(pg_temp.events('kai', 'allergies.counted'), 1, 'the allergy count is logged for each person counted');
select pg_temp.as_user('gina');
select throws_ok(format($$select * from app.catering_counts(%L)$$, pg_temp.id('ful_cat')), '42501', null,
  'catering counts need hospitality.fulfillment.read');

select * from finish();
rollback;
