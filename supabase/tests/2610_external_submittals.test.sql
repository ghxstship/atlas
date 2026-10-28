-- pgTAP: migration 2610 (R2), the vendor's submittals in Gateway. The vendor account's Owner, Admin and Member read the
-- account's submittals on a project it is engaged on; Account Finance, an unrelated person and another tenant read none.
-- Canceled rows stay hidden and the return reason shows only while Returned. The vendor submits a Proposed submittal and
-- resubmits a Returned one with a note; refusals for a wrong expected state, an empty note, a non-vendor and a stale
-- state. The org's review after a vendor submit keeps sod_approval_requester on the member who created the submittal.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.view_row(p_who text, p_key text) returns api_external.submittals
language plpgsql as $$
declare v api_external.submittals;
begin
  perform pg_temp.as_user(p_who);
  select * into v from api_external.submittals s where s.id = pg_temp.id(p_key);
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: Bayside Audio as Northwind's vendor, an Admin and a second Member, three submittals on prj_a, one on prj_a2 ---------
select pg_temp.new_user('ada', 'ada@bayside-audio.test', 'Ada Brennan');
select pg_temp.new_user('mo', 'mo@bayside-audio.test', 'Mo Lindqvist');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('ada'), 'Account Admin');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('mo'), 'Account Member');

select pg_temp.as_user('carol');
with v as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v_a')) returning id) insert into world select 'ven', id from v;
with x as (insert into app.submittals (project_id, vendor_id, submittal_kind, title, spec_reference, due_on)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'Shop Drawing', 'Delay tower rigging plan', 'S-201', '2027-05-20') returning id)
  insert into world select 'sub', id from x;
with x as (insert into app.submittals (project_id, vendor_id, submittal_kind, title, due_on)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'Product Data', 'Line array cut sheets', '2027-05-22') returning id)
  insert into world select 'sub2', id from x;
with x as (insert into app.submittals (project_id, vendor_id, submittal_kind, title)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'Sample', 'Cable ramp sample') returning id)
  insert into world select 'sub_cancel', id from x;
with x as (insert into app.submittals (project_id, vendor_id, submittal_kind, title)
  values (pg_temp.id('prj_a2'), pg_temp.id('ven'), 'Certificate', 'Gala rigging certificate') returning id)
  insert into world select 'sub_gala', id from x;
select app.transition_submittal(pg_temp.id('sub_cancel'), 'Proposed', 'Canceled', 'No longer needed.');
select pg_temp.as_platform();

select is(pg_temp.n('victor', 'select 1 from api_external.submittals'), 0, 'nothing reads before the engagement is Active');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');

-- Who reads --------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('victor', 'select 1 from api_external.submittals'), 2, 'the Account Owner reads the account''s live submittals on the project');
select is(pg_temp.n('ada', 'select 1 from api_external.submittals'), 2, 'the Account Admin reads them');
select is(pg_temp.n('mo', 'select 1 from api_external.submittals'), 2, 'an Account Member reads them');
-- R4 turns this on: once private.engagement_area_open checks the Advancing assignment, an Account Member who is not
-- assigned reads none (decision 6), and this line becomes
--   select is(pg_temp.n('mo', 'select 1 from api_external.submittals'), 0, 'an unassigned Account Member reads none');
select is(pg_temp.n('fiona', 'select 1 from api_external.submittals'), 0, 'Account Finance reads none');
select is(pg_temp.n('ivy', 'select 1 from api_external.submittals'), 0, 'an unrelated external person reads none');
select is(pg_temp.n('xavier', 'select 1 from api_external.submittals'), 0, 'another tenant reads none');
select is(pg_temp.n('victor', format('select 1 from api_external.submittals where id = %L', pg_temp.id('sub_cancel'))), 0,
  'a canceled submittal is hidden');
select is(pg_temp.n('victor', format('select 1 from api_external.submittals where id = %L', pg_temp.id('sub_gala'))), 0,
  'a project the account is not engaged on stays hidden');
select is((pg_temp.view_row('victor', 'sub')).account_id, pg_temp.id('acct_v'), 'the row names the vendor account');
select ok((pg_temp.view_row('victor', 'sub')).return_reason is null and (pg_temp.view_row('victor', 'sub')).submitted_at is null,
  'a Proposed submittal has no return reason and no submission time');

-- Submitting -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select lives_ok(format($$select app.submit_engaged_submittal(%L, 'Proposed', '  Rigging plan attached, rev A.  ')$$, pg_temp.id('sub')),
  'the vendor submits a Proposed submittal');
select pg_temp.as_platform();
select is((select reason from app.submittal_state_transitions where submittal_id = pg_temp.id('sub') and to_state = 'Submitted'),
  'Rigging plan attached, rev A.', 'the note is the transition''s reason');
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('sub') and event_type = 'submittal.state_changed'), 1,
  'submitting emits submittal.state_changed');
select is((pg_temp.view_row('mo', 'sub')).submittal_state::text, 'Submitted', 'the vendor side reads it as Submitted');
select ok((pg_temp.view_row('mo', 'sub')).submitted_at is not null, 'with the submission time');

-- Refusals -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ada');
select throws_ok(format($$select app.submit_engaged_submittal(%L, 'Submitted', 'Approve it.')$$, pg_temp.id('sub')),
  'XR001', 'submittal_response: A vendor submits a proposed submittal or resubmits a returned one.', 'the vendor never decides a submittal');
select throws_ok(format($$select app.submit_engaged_submittal(%L, 'Proposed', '   ')$$, pg_temp.id('sub2')),
  'XR001', 'submittal_note_length: Say what you are submitting in 1 to 500 characters.', 'an empty note is refused');
select throws_ok(format($$select app.submit_engaged_submittal(%L, 'Proposed', %L)$$, pg_temp.id('sub2'), repeat('x', 501)),
  'XR001', 'submittal_note_length: Say what you are submitting in 1 to 500 characters.', 'a note over 500 characters is refused');
select throws_ok(format($$select app.submit_engaged_submittal(%L, 'Proposed', 'Again.')$$, pg_temp.id('sub')),
  'XR001', 'submittal_state_conflict: The submittal is not in the expected state Proposed.', 'compare-and-set refuses a state that moved');
select pg_temp.as_user('fiona');
select throws_ok(format($$select app.submit_engaged_submittal(%L, 'Proposed', 'Cut sheets attached.')$$, pg_temp.id('sub2')),
  '42501', 'only the vendor answers for this submittal', 'Account Finance does not answer');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.submit_engaged_submittal(%L, 'Proposed', 'Cut sheets attached.')$$, pg_temp.id('sub2')),
  '42501', 'only the vendor answers for this submittal', 'a non-vendor does not answer');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.submit_engaged_submittal(%L, 'Proposed', 'Certificate attached.')$$, pg_temp.id('sub_gala')),
  '42501', 'only the vendor answers for this submittal', 'nor one on a project the account is not engaged on');
select pg_temp.as_platform();

-- Return and resubmit --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok(format($$select app.transition_submittal(%L, 'Submitted', 'Returned', 'Show the bridle points.')$$, pg_temp.id('sub')),
  'the org returns it: bob did not create it, so sod_approval_requester passes');
select pg_temp.as_platform();
select is((pg_temp.view_row('victor', 'sub')).return_reason, 'Show the bridle points.', 'the vendor reads the reason while Returned');
select pg_temp.as_user('mo');
select lives_ok(format($$select app.submit_engaged_submittal(%L, 'Returned', 'Bridle points added on sheet 2.')$$, pg_temp.id('sub')),
  'an Account Member resubmits a Returned submittal');
select pg_temp.as_platform();
select is((select revision from app.submittals where id = pg_temp.id('sub')), 1, 'resubmitting raises the revision by 1');
select ok((pg_temp.view_row('victor', 'sub')).return_reason is null, 'the return reason goes once it is resubmitted');
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('sub') and event_type = 'submittal.state_changed'), 3,
  'each move emits submittal.state_changed');

select pg_temp.as_user('carol');
select throws_ok(format($$select app.transition_submittal(%L, 'Submitted', 'Approved', 'Looks right.')$$, pg_temp.id('sub')),
  'XR001', null, 'the member who created it still cannot approve after a vendor submit');
select pg_temp.as_user('bob');
select lives_ok(format($$select app.transition_submittal(%L, 'Submitted', 'Approved', 'Approved as drawn.')$$, pg_temp.id('sub')),
  'another member approves after the vendor''s submit (sod_approval_requester)');
select pg_temp.as_platform();
select is((pg_temp.view_row('victor', 'sub')).submittal_state::text, 'Approved', 'the vendor reads the approval');
select ok((pg_temp.view_row('victor', 'sub')).decided_at is not null, 'with when it was decided');

-- Time box ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select is(pg_temp.n('victor', 'select 1 from api_external.submittals'), 2, 'Closing keeps the operational area open');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.n('victor', 'select 1 from api_external.submittals'), 0, 'Complete closes the vendor''s submittals');

-- Catalog ----------------------------------------------------------------------------------------------------------------------------
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
  where table_schema = 'api_external' and table_name = 'submittals'),
  array['id', 'project_id', 'project_name', 'account_id', 'submittal_number', 'submittal_kind', 'title', 'spec_reference', 'due_on',
    'revision', 'submittal_state', 'decided_at', 'purchase_order_id', 'return_reason', 'submitted_at'],
  'the view lists its columns; who decided never appears');
select ok(has_table_privilege('authenticated', 'api_external.submittals', 'select'), 'signed-in users read the view');
select ok(not has_table_privilege('anon', 'api_external.submittals', 'select'), 'anon does not');
select ok(not has_function_privilege('anon', 'app.submit_engaged_submittal(uuid, app.review_state, text)', 'execute'), 'anon cannot submit');
select ok(not has_function_privilege('anon', 'private.vendor_side_open(uuid, uuid)', 'execute'), 'anon cannot call vendor_side_open');

select * from finish();
rollback;
