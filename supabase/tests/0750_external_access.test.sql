-- pgTAP: Section 8.7 external access through the api_external projections (gate 24). For every projection:
-- access through own engagement, account engagement and representation, denial for another party's engagement,
-- denial after close (18 months after Complete, except own tax forms and payments), and denial of internal-only
-- columns (a catalog check over every api_external column, so later views are covered too). Gate 33: one person
-- holding several engagements across orgs, and an internal member of one org engaged by another.
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

-- Internal-only columns never reach api_external (catalog, so later views are checked too) -----------------------------
select is(
  (select coalesce(string_agg(c.table_name || '.' || c.column_name, ', ' order by c.table_name, c.column_name), '')
   from information_schema.columns c
   where c.table_schema = 'api_external'
     and (c.column_name in ('internal_note', 'note', 'standing', 'reason', 'review_on', 'tin_encrypted', 'agreed_rate_minor',
                            'provider_account_reference', 'blocker_text', 'org_note')
          or c.column_name like '%margin%' or c.column_name like '%budget%' or c.column_name like '%internal%')),
  '', 'no api_external column carries internal notes, margins, budget lines, pool standing, Do Not Engage reasons, reviewer notes or secrets');
select is(
  (select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'api_external' and c.relkind = 'v'
     and (has_table_privilege('anon', c.oid, 'select') or not has_table_privilege('authenticated', c.oid, 'select'))),
  '', 'every api_external view is readable by signed-in users and never by anon');
select is(
  (select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'api_external' and c.relkind = 'v' and obj_description(c.oid, 'pg_class') is null),
  '', 'every api_external view is documented');
select is(
  (select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'api_external' and c.relkind = 'v' and pg_get_viewdef(c.oid) ~* 'select\s+\*'),
  '', 'every api_external view lists its columns');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.engagements', '42501', null, 'anon cannot read external projections');
select pg_temp.as_platform();

-- Engagements ---------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.engagements'), 2, 'gate 33: ivy reads her engagements with two orgs');
select is(pg_temp.n('ivy', $$select 1 from api_external.engagements where id = '$$ || pg_temp.id('eng_quinn_b') || $$'$$), 0,
  'denial for another party''s engagement in an org she also works for');
select is(pg_temp.n('victor', 'select 1 from api_external.engagements'), 1, 'access through account engagement: the Account Owner');
select is(pg_temp.n('sam', 'select 1 from api_external.engagements'), 1, 'access through own engagement: the supplied technician');
select is(pg_temp.n('rita', 'select 1 from api_external.engagements'), 1, 'access through representation: the artist''s agent');
select is(pg_temp.n('quinn', $$select 1 from api_external.engagements where org_id = '$$ || pg_temp.id('org_a') || $$'$$), 0, 'denial for a stranger to the org');
select is(pg_temp.n('mia', 'select 1 from api_external.engagements'), 1, 'gate 33: a member of Northwind reads her external engagement with Harbor Lights');
select is(pg_temp.n('dave', 'select 1 from api_external.engagements'), 0, 'internal members have no external engagements to read');
select pg_temp.as_user('ivy');
select is((select rate_minor from api_external.engagements where id = pg_temp.id('eng_ivy_a')), null::bigint, 'the party''s rate stays hidden until the money area opens');
select is((select areas from api_external.engagements where id = pg_temp.id('eng_ivy_a')), array['documents', 'engagement', 'onboarding'], 'Onboarding opens engagement, documents and onboarding');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('ivy');
select is((select rate_minor from api_external.engagements where id = pg_temp.id('eng_ivy_a')), 99000::bigint, 'at Active the party reads their own rate');
select pg_temp.as_platform();
select pg_temp.as_user('rita');
select is((select rate_minor from api_external.engagements where id = pg_temp.id('eng_art_a')), null::bigint,
  'a representative without the Settlement scope never sees the artist''s fee');
select pg_temp.as_platform();

-- Documents, onboarding, threads ---------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.engagement_documents (engagement_id, document_kind, title) values
  (pg_temp.id('eng_ivy_a'), 'Agreement', 'Crew Agreement'),
  (pg_temp.id('eng_vendor_a'), 'Statement of Work', 'Audio Scope'),
  (pg_temp.id('eng_art_a'), 'Rider', 'Technical Rider');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method, is_blocking)
  values (pg_temp.id('org_a'), 'Emergency Contact', 'Form', 'Vendor', 'Reviewer', false) returning id) select 1;
insert into app.onboarding_items (engagement_id, onboarding_requirement_id)
  select pg_temp.id('eng_vendor_a'), r.id from app.onboarding_requirements r where r.name = 'Emergency Contact';
insert into app.onboarding_verifications (onboarding_item_id, outcome, note)
  select i.id, 'Failed', 'Number did not connect.' from app.onboarding_items i where i.engagement_id = pg_temp.id('eng_vendor_a');
with t as (insert into app.engagement_threads (engagement_id, subject) values (pg_temp.id('eng_vendor_a'), 'Load-In') returning id)
  insert into world select 'thread_load_in', id from t;
insert into app.engagement_messages (engagement_thread_id, body) values (pg_temp.id('thread_load_in'), 'Dock 2 at 06:00.');
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'select 1 from api_external.engagement_documents'), 1, 'documents: own engagement');
select is(pg_temp.n('fiona', 'select 1 from api_external.engagement_documents'), 1, 'documents: account engagement (Finance)');
select is(pg_temp.n('rita', 'select 1 from api_external.engagement_documents'), 1, 'documents: representation with the Documents scope');
select is(pg_temp.n('quinn', 'select 1 from api_external.engagement_documents'), 0, 'documents: denial for another party');
select is(pg_temp.n('sam', 'select 1 from api_external.onboarding_items'), 1, 'onboarding: own engagement');
select is(pg_temp.n('victor', 'select 1 from api_external.onboarding_items'), 1, 'onboarding: account engagement (Owner)');
select is(pg_temp.n('fiona', 'select 1 from api_external.onboarding_items'), 0, 'onboarding: Account Finance has no onboarding area');
select is(pg_temp.n('quinn', 'select 1 from api_external.onboarding_items'), 0, 'onboarding: denial for another party');
select pg_temp.as_user('sam');
select is((select latest_outcome::text from api_external.onboarding_items), 'Failed', 'the party sees the outcome but never the reviewer note');
select pg_temp.as_platform();
select is(pg_temp.n('sam', 'select 1 from api_external.engagement_messages'), 1, 'messages: own engagement');
select is(pg_temp.n('victor', 'select 1 from api_external.engagement_threads'), 1, 'threads: account engagement');
select is(pg_temp.n('ivy', 'select 1 from api_external.engagement_messages'), 0, 'messages: denial for another party');

-- Records by external visibility (operational, from Active) -------------------------------------------------------------
select pg_temp.as_user('carol');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Task', 'Hang the banner', 'Y', 'Declared') returning id)
  insert into world select 'rec_vendor', id from r;
insert into app.record_external_visibility (record_id, external_role_type) values (pg_temp.id('rec_vendor'), 'Vendor');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Task', 'Rig the truss', 'Y', 'Declared') returning id)
  insert into world select 'rec_ivy', id from r;
insert into app.record_external_visibility (record_id, person_id) values (pg_temp.id('rec_ivy'), pg_temp.id('ivy'));
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Task', 'Count the float', 'Y', 'Declared') returning id)
  insert into world select 'rec_internal', id from r;
select pg_temp.as_platform();
select is(pg_temp.n('victor', 'select 1 from api_external.records'), 0, 'records stay closed while the account''s engagement is Onboarding');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select is(pg_temp.n('victor', 'select 1 from api_external.records'), 1, 'records: account engagement sees records shown to its role type');
select is(pg_temp.n('ivy', 'select 1 from api_external.records'), 1, 'records: own engagement sees records naming the person');
select is(pg_temp.n('ivy', $$select 1 from api_external.records where id = '$$ || pg_temp.id('rec_vendor') || $$'$$), 0, 'a Crew party does not see a Vendor record');
select is(pg_temp.n('victor', $$select 1 from api_external.records where id = '$$ || pg_temp.id('rec_internal') || $$'$$), 0, 'records without external visibility stay internal');
select is(pg_temp.n('quinn', 'select 1 from api_external.records'), 0, 'records: denial for another party');
select is(pg_temp.n('fiona', 'select 1 from api_external.records'), 0, 'Account Finance has no operational area');

-- Money -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on, reference_identifier, payment_state)
values (pg_temp.id('cp_v_a'), 'Payable', 255000, 'USD', '2027-06-20', 'REM-0001', 'Proposed');
alter table app.payments disable trigger user;
update app.payments set payment_state = 'Approved' where reference_identifier = 'REM-0001';
alter table app.payments enable trigger user;
select is(pg_temp.n('fiona', 'select 1 from api_external.payments'), 1, 'payments: Account Finance sees payments to the account');
select is(pg_temp.n('sam', 'select 1 from api_external.payments'), 0, 'an Account Member does not');
select is(pg_temp.n('ivy', 'select 1 from api_external.payments'), 0, 'payments: denial for another party');
select pg_temp.as_user('ivy');
select app.submit_tax_form(pg_temp.id('org_a'), 'W-9', '111223333');
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'select 1 from api_external.tax_forms where tin_last4 = ''3333'''), 1, 'tax forms: own, last four only');
select is(pg_temp.n('quinn', 'select 1 from api_external.tax_forms'), 0, 'tax forms: denial for another party');

-- Denial after close ----------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.n('sam', 'select 1 from api_external.records'), 0, 'operational records close at Complete');
select is(pg_temp.n('victor', 'select 1 from api_external.engagement_documents'), 1, 'documents stay open at Complete');
select pg_temp.as_user('fiona');
select is((select rate_minor from api_external.engagements), (select standard_rate_minor from xpms.rate_card where rate_card_id = 'LRC-009'),
  'money stays open at Complete: Finance reads the rate');
select pg_temp.as_platform();
select pg_temp.backdate_close('eng_vendor_a', interval '19 months');
select is(pg_temp.n('victor', 'select 1 from api_external.engagements'), 0, 'denial after close: the account loses the engagement 18 months after Complete');
select is(pg_temp.n('victor', 'select 1 from api_external.engagement_documents'), 0, 'and its documents');
select is(pg_temp.n('sam', 'select 1 from api_external.engagement_messages'), 0, 'and its messages');
select is(pg_temp.n('victor', 'select 1 from api_external.onboarding_items'), 0, 'and its onboarding');
select is(pg_temp.n('fiona', 'select 1 from api_external.payments'), 1, 'payments are the party''s own and never close');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select pg_temp.backdate_close('eng_ivy_a', interval '2 years');
select is(pg_temp.n('ivy', 'select 1 from api_external.engagements'), 1, 'ivy keeps only her open engagement with Harbor Lights');
select is(pg_temp.n('ivy', 'select 1 from api_external.tax_forms'), 1, 'own tax forms never close');

-- Marketplace projections --------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.opportunities (project_id, role_type, role_code, title, visibility, rate_type, pay_min_minor, pay_max_minor, currency_code, deadline_at)
values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Pier Riggers', 'Invited', 'Day', 80000, 90000, 'USD', now() + interval '3 days');
insert into world select 'opp_x', id from app.opportunities where title = 'Pier Riggers';
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp_x'), pg_temp.id('quinn'));
insert into app.opportunity_questions (opportunity_id, prompt, sort_order) values (pg_temp.id('opp_x'), 'Years rigging?', 1);
insert into app.opportunity_positions (opportunity_id, label) values (pg_temp.id('opp_x'), 'Rigger');
select app.transition_opportunity(pg_temp.id('opp_x'), 'Draft', 'Pending Approval', 'Submit.');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.opportunities'), 0, 'an unpublished opportunity is invisible even to invitees');
select pg_temp.as_user('carol');
select app.transition_opportunity(pg_temp.id('opp_x'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.opportunities'), 1, 'an invitee reads the opportunity');
select is(pg_temp.n('quinn', 'select 1 from api_external.opportunity_questions'), 1, 'and its questions');
select is(pg_temp.n('quinn', 'select 1 from api_external.opportunity_positions'), 1, 'and its positions');
select is(pg_temp.n('ivy', 'select 1 from api_external.opportunities'), 0, 'others do not');
select pg_temp.as_user('quinn');
select is((select rate_on_request from api_external.opportunities), false, 'posted compensation is not Rate on Request');
with a as (insert into app.applications (opportunity_id, applicant_person_id) values (pg_temp.id('opp_x'), pg_temp.id('quinn')) returning id) insert into world select 'app_x', id from a;
select pg_temp.as_user('carol');
insert into app.interviews (application_id, interview_kind, scheduled_at, duration_minutes, location_text, internal_note)
values (pg_temp.id('app_x'), 'Audition', '2027-05-02 16:00+00', 20, 'Pier stage', 'Check the harness inspection.');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.applications'), 1, 'applications: own');
select is(pg_temp.n('quinn', 'select 1 from api_external.interviews'), 1, 'interviews: own, without the internal note');
select is(pg_temp.n('ivy', 'select 1 from api_external.applications'), 0, 'applications: denial for another party');
select is(pg_temp.n('ivy', 'select 1 from api_external.interviews'), 0, 'interviews: denial for another party');

-- Ratings ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_vendor_a'), 'Organization', 4, 'Solid crew.');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.ratings'), 1, 'a rating released by time shows on profiles to every signed-in user');
select pg_temp.as_user('quinn');
select is((select rated_organization_id from api_external.ratings), pg_temp.id('acct_v'), 'it names the rated account');
select pg_temp.as_platform();

-- Accounts, representation, availability ------------------------------------------------------------------------------------
select is(pg_temp.n('sam', 'select 1 from api_external.account_members'), 3, 'an account member reads the roster');
select is(pg_temp.n('quinn', 'select 1 from api_external.account_members'), 0, 'a stranger reads no roster');
select pg_temp.as_user('fiona');
select is((select my_roles from api_external.my_accounts), array['Account Finance']::app.account_role[], 'a member reads their own account roles');
select pg_temp.as_platform();
select is(pg_temp.n('art', 'select 1 from api_external.representations'), 1, 'the artist reads their representation');
select is(pg_temp.n('rita', 'select 1 from api_external.representations where scopes = array[''Advance'', ''Documents'']::app.representation_scope[]'), 1, 'with its scopes');
select is(pg_temp.n('quinn', 'select 1 from api_external.representations'), 0, 'a stranger reads none');
select pg_temp.as_user('quinn');
with c as (insert into app.availability_calendars (person_id, time_zone, visibility) values (pg_temp.id('quinn'), 'UTC', 'Public') returning id)
  insert into world select 'cal_quinn', id from c;
insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind, note)
  values (pg_temp.id('cal_quinn'), '2027-06-01', '2027-06-02', 'Unavailable', 'Private matter.');
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'select 1 from api_external.availability'), 1, 'a Public calendar shows its periods without notes');

select * from finish();
rollback;
