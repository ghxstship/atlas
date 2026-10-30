-- pgTAP: migration 2860, approval rules (P9, G-31, ADR 0138). A pass or a dock booking that matches a project's Active
-- rule opens one approval, whose state is computed (ADR 0103); the most specific rule wins; steps are fixed once the rule
-- is Active; an access scan of a pass waiting on its approval is Denied; each refusal of a decision names its rule; an
-- engagement step's outside approver decides; revoking or deleting the subject cancels the approval; a step nobody may
-- decide stays In Review for a rule writer to cancel; readers, the vendor of a delivery and everyone else see what the
-- read rule allows.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(59);

create function pg_temp.approval_of(p_credential text) returns uuid language sql as $$
  select a.id from app.subject_approvals a where a.credential_id = pg_temp.id(p_credential) and a.canceled_at is null
$$;
create function pg_temp.state_of(p_approval uuid) returns text language sql as $$
  select approval_state::text || coalesce(' ' || current_step, '') from app.subject_approval_status where id = p_approval
$$;
create function pg_temp.scan(p_credential text) returns text language sql as $$
  insert into app.access_scans (credential_id, zone_id) values (pg_temp.id(p_credential), pg_temp.id('zone')) returning result::text
$$;
create function pg_temp.issue(p_key text, p_category text, p_holder text) returns void language plpgsql as $$
declare
  v_id uuid;
begin
  insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id(p_category), pg_temp.id(p_holder))
  returning id into v_id;
  insert into world values (p_key, v_id);
end $$;

-- Fixture: zones, two categories with grid rows on prj_a, one category on prj_a2, a dock zone ----------------------------
select pg_temp.as_user('alice');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'FOH', 'Front of House') returning id) insert into world select 'zone', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DCK', 'Dock A') returning id) insert into world select 'dock', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'ALL', 'All Access') returning id) insert into world select 'cat_all', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CRW', 'Crew') returning id) insert into world select 'cat_crew', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a2'), 'ALL', 'All Access') returning id) insert into world select 'cat_gala', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
select pg_temp.id(c), pg_temp.id('zone'), 'ENM-036', now() - interval '1 day', now() + interval '1 day' from unnest(array['cat_all', 'cat_crew']) c;

-- A Pass rule for All Access on prj_a: step 1 bob, step 2 ivy's engagement, decided from email ------------------------------
with x as (insert into app.approval_rules (project_id, subject, name, credential_category_id)
           values (pg_temp.id('prj_a'), 'Pass', 'All Access passes', pg_temp.id('cat_all')) returning id) insert into world select 'rule_all', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_all'), 1, 'Production manager', pg_temp.id('bob@org_a'));
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_engagement_id, signed_out_links)
values (pg_temp.id('rule_all'), 2, 'Crew chief', pg_temp.id('eng_ivy_a'), true);

select is((select org_id from app.approval_rules where id = pg_temp.id('rule_all')), pg_temp.id('org_a'), 'a rule takes its project''s org');
select throws_like($$insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id, signed_out_links)
  values ((select id from world where key = 'rule_all'), 3, 'Bad', (select id from world where key = 'dave@org_a'), true)$$,
  '%approval_rule_steps_signed_out_engagement%', 'only an engagement step decides from email');
select throws_like($$insert into app.approval_rules (project_id, subject, name, zone_id)
  values ((select id from world where key = 'prj_a'), 'Pass', 'Wrong filter', (select id from world where key = 'dock'))$$,
  '%approval_rules_filter_subject%', 'a filter is used only with its own subject');
select throws_like($$insert into app.approval_rules (project_id, subject, name, credential_category_id)
  values ((select id from world where key = 'prj_a'), 'Pass', 'Other project', (select id from world where key = 'cat_gala'))$$,
  'approval_rule_filter_project:%', 'a Pass rule matches a category of its own project');

-- Activation ------------------------------------------------------------------------------------------------------------------
with x as (insert into app.approval_rules (project_id, subject, name) values (pg_temp.id('prj_a'), 'Pass', 'No steps') returning id)
  insert into world select 'rule_empty', id from x;
select throws_like($$select app.transition_approval_rule((select id from world where key = 'rule_empty'), 'Draft', 'Active', 'Go.')$$,
  'approval_rule_no_steps:%No steps%', 'a rule needs a step before it is activated');
with x as (insert into app.approval_rules (project_id, subject, name) values (pg_temp.id('prj_a'), 'Equipment', 'Radios') returning id)
  insert into world select 'rule_equipment', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_equipment'), 1, 'Quartermaster', pg_temp.id('bob@org_a'));
select throws_like($$select app.transition_approval_rule((select id from world where key = 'rule_equipment'), 'Draft', 'Active', 'Go.')$$,
  'approval_rule_equipment_pending:%', 'an Equipment rule stays a Draft until equipment requests are gated (2863)');
-- An outside party with no XOS account cannot receive approval emails.
select pg_temp.as_platform();
with p as (insert into app.people (full_name) values ('Offline Vendor') returning id) insert into world select 'offline', id from p;
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
           values (pg_temp.id('prj_a'), pg_temp.id('offline'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')
           returning id) insert into world select 'eng_offline', id from x;
with x as (insert into app.approval_rules (project_id, subject, name, credential_category_id)
           values (pg_temp.id('prj_a'), 'Pass', 'Unreachable', pg_temp.id('cat_crew')) returning id) insert into world select 'rule_unreachable', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_engagement_id)
values (pg_temp.id('rule_unreachable'), 1, 'Offline vendor', pg_temp.id('eng_offline'));
select throws_like($$select app.transition_approval_rule((select id from world where key = 'rule_unreachable'), 'Draft', 'Active', 'Go.')$$,
  'approval_step_no_approver:%Offline vendor%', 'an engagement step whose party has no account cannot be activated');

select lives_ok($$select app.transition_approval_rule((select id from world where key = 'rule_all'), 'Draft', 'Active', 'Gate All Access.')$$,
  'the All Access rule is activated');
select throws_like($$insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
  values ((select id from world where key = 'rule_all'), 3, 'Late step', (select id from world where key = 'dave@org_a'))$$,
  'approval_rule_step_not_draft:%All Access passes%', 'steps of an Active rule do not change, and the refusal names the rule');
select throws_like($$update app.approval_rules set credential_category_id = (select id from world where key = 'cat_crew') where id = (select id from world where key = 'rule_all')$$,
  'approval_rule_not_draft:%', 'an Active rule keeps its filter');
select throws_like($$update app.approval_rules set deleted_at = now() where id = (select id from world where key = 'rule_all')$$,
  'approval_rule_active_delete:%', 'an Active rule is retired before it is deleted');
with x as (insert into app.approval_rules (project_id, subject, name, credential_category_id)
           values (pg_temp.id('prj_a'), 'Pass', 'All Access again', pg_temp.id('cat_all')) returning id) insert into world select 'rule_dup', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_dup'), 1, 'Admin', pg_temp.id('bob@org_a'));
select throws_ok($$select app.transition_approval_rule((select id from world where key = 'rule_dup'), 'Draft', 'Active', 'Go.')$$,
  '23505', null, 'a second Active rule for the same project, subject and filter is refused');
select pg_temp.as_user('gina');
select throws_ok($$select app.transition_approval_rule((select id from world where key = 'rule_dup'), 'Draft', 'Retired', 'No.')$$,
  '42501', null, 'a Viewer does not change a rule''s state');

-- 1. A pass opens one approval ------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.issue('cred_frank', 'cat_all', 'frank');
select pg_temp.issue('cred_crew', 'cat_crew', 'frank');
select pg_temp.issue('cred_gala', 'cat_gala', 'frank');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subject_approvals where credential_id = pg_temp.id('cred_frank')), 1,
  'an All Access pass on the project opens one approval');
select is((select count(*)::integer from app.subject_approvals where credential_id in (pg_temp.id('cred_crew'), pg_temp.id('cred_gala'))), 0,
  'a pass of another category, or on another project, opens none');
select is((select project_id from app.subject_approvals where id = pg_temp.approval_of('cred_frank')), pg_temp.id('prj_a'),
  'the approval carries its pass''s project');
select is((select requested_by from app.subject_approvals where id = pg_temp.approval_of('cred_frank')), pg_temp.id('carol'),
  'and whoever issued it as the requester');
select pg_temp.as_user('carol');
select is(pg_temp.state_of(pg_temp.approval_of('cred_frank')), 'In Review 1', 'the requester sees it In Review at step 1');
select is((select current_step_name from app.subject_approval_status where id = pg_temp.approval_of('cred_frank')), 'Production manager',
  'with the step''s name');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where kind = 'approval.requested' and subject_table = 'subject_approvals'
           and subject_id = pg_temp.approval_of('cred_frank')), 1, 'only step 1''s approver is asked');
select is((select recipient_person_id from app.notifications where kind = 'approval.requested' and subject_id = pg_temp.approval_of('cred_frank')),
  pg_temp.id('bob'), 'and that is bob');
select ok((select message_args ->> 'title' from app.notifications where kind = 'approval.requested' and subject_id = pg_temp.approval_of('cred_frank'))
  ~ '^Pass CR-[0-9]{6} for ', 'the request names the pass and its holder');

-- 3. The access-scan gate ----------------------------------------------------------------------------------------------------
select is(pg_temp.scan('cred_frank'), 'Denied', 'a pass In Review does not open a door the grid allows');
select is(pg_temp.scan('cred_crew'), 'Granted', 'a pass no rule gates still does');

-- 4. Refusals --------------------------------------------------------------------------------------------------------------------
create temporary table a (id uuid);
grant select, insert, delete on a to public;
insert into a select pg_temp.approval_of('cred_frank');
select pg_temp.as_user('carol');
select throws_like($$select app.decide_subject_approval((select id from a), true)$$, 'sod_approval_requester:%',
  'the requester does not decide');
select pg_temp.as_user('frank');
select throws_like($$select app.decide_subject_approval((select id from a), true)$$, 'approval_subject_beneficiary:%',
  'nor does the pass holder');
select pg_temp.as_user('dave');
select throws_like($$select app.decide_subject_approval((select id from a), true)$$, 'approval_not_step_approver:%',
  'nor anyone the current step does not name');
select pg_temp.as_user('bob');
select throws_like($$select app.decide_subject_approval((select id from a), false, '  ')$$, 'approval_rejection_reason:%',
  'a rejection needs a reason');
select lives_ok($$select app.decide_subject_approval((select id from a), true, 'Fine by me.')$$, 'bob approves step 1');
select is(pg_temp.state_of((select id from a)), 'In Review 2', 'the approval moves to step 2');
select throws_like($$select app.decide_subject_approval((select id from a), true)$$, 'approval_one_step_per_approver:%',
  'bob does not decide a second step');
select pg_temp.as_platform();
select is((select archived_at is not null from app.notifications where kind = 'approval.requested' and subject_id = (select id from a)
           and recipient_person_id = pg_temp.id('bob')), true, 'bob''s request leaves his Inbox once the step is decided');
select is((select count(*)::integer from app.notifications where kind = 'approval.requested' and subject_id = (select id from a)
           and recipient_person_id = pg_temp.id('ivy')), 1, 'ivy, the engagement step''s outside approver, is asked next');
select is(pg_temp.scan('cred_frank'), 'Denied', 'one approved step of two still does not open the door');

-- 5. The outside approver decides -------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is(pg_temp.state_of((select id from a)), 'In Review 2', 'the outside approver reads the approval she is asked about');
select lives_ok($$select app.decide_subject_approval((select id from a), true)$$, 'ivy approves the last step signed in');
select pg_temp.as_platform();
select is(pg_temp.state_of((select id from a)), 'Approved', 'every step approved, the approval is Approved');
select is((select decided_via from app.subject_approval_decisions where subject_approval_id = (select id from a) and step_order = 2), 'App',
  'decided in the app');
select is((select message_args ->> 'decision' from app.notifications where kind = 'approval.decided' and subject_id = (select id from a)
           and recipient_person_id = pg_temp.id('carol')), 'approved', 'the requester hears it was approved');
select is(pg_temp.scan('cred_frank'), 'Granted', 'and the pass opens the door');

-- A rejection gates, a canceled approval does not ---------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.issue('cred_dave', 'cat_all', 'dave');
delete from a;
insert into a select pg_temp.approval_of('cred_dave');
select pg_temp.as_user('bob');
select lives_ok($$select app.decide_subject_approval((select id from a), false, 'Not on the list.')$$, 'bob rejects dave''s pass');
select is(pg_temp.state_of((select id from a)), 'Rejected', 'the approval is Rejected');
select is(pg_temp.scan('cred_dave'), 'Denied', 'a rejected pass is denied');
select pg_temp.as_user('carol');
select pg_temp.issue('cred_erin', 'cat_all', 'erin');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.cancel_subject_approval(%L, 'No.')$$, pg_temp.approval_of('cred_erin')), '42501', null,
  'someone who neither asked nor writes rules or passes does not cancel');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.cancel_subject_approval(%L, 'Issued in error.')$$, pg_temp.approval_of('cred_erin')),
  'the requester cancels');
select is(pg_temp.scan('cred_erin'), 'Granted', 'a canceled approval does not gate the pass');

-- Revoking the pass cancels its approval -------------------------------------------------------------------------------------------
select pg_temp.issue('cred_gina', 'cat_all', 'gina');
insert into world select 'appr_gina', pg_temp.approval_of('cred_gina');
update app.credentials set revoked_at = now() where id = pg_temp.id('cred_gina');
select pg_temp.as_platform();
select is((select cancel_reason from app.subject_approvals where id = pg_temp.id('appr_gina')), 'The pass was revoked.',
  'revoking a pass withdraws its approval');
select is((select count(*)::integer from app.notifications where subject_id = pg_temp.id('appr_gina') and archived_at is null), 0,
  'and its open requests leave the Inbox');

-- The most specific rule wins ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.approval_rules (project_id, subject, name) values (pg_temp.id('prj_a'), 'Pass', 'Every pass') returning id)
  insert into world select 'rule_any', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_any'), 1, 'Owner', pg_temp.id('alice@org_a'));
select app.transition_approval_rule(pg_temp.id('rule_any'), 'Draft', 'Active', 'Gate every pass.');
select pg_temp.as_user('carol');
select pg_temp.issue('cred_mia_all', 'cat_all', 'mia');
select pg_temp.issue('cred_mia_crew', 'cat_crew', 'mia');
select pg_temp.as_platform();
select is((select approval_rule_id from app.subject_approvals where credential_id = pg_temp.id('cred_mia_all')), pg_temp.id('rule_all'),
  'a rule whose filter matches wins over a rule with none');
select is((select approval_rule_id from app.subject_approvals where credential_id = pg_temp.id('cred_mia_crew')), pg_temp.id('rule_any'),
  'and the rule with no filter takes the rest');

-- A step nobody may decide ---------------------------------------------------------------------------------------------------------
-- alice is the only approver of Every pass; a pass for alice leaves the step with nobody.
select pg_temp.as_user('carol');
select pg_temp.issue('cred_alice', 'cat_crew', 'alice');
select pg_temp.as_user('alice');
select is((select approval_state::text || ' ' || current_step_has_approver::text from app.subject_approval_status
           where id = pg_temp.approval_of('cred_alice')), 'In Review false', 'a step whose only approver holds the pass waits on no one');
select lives_ok(format($$select app.cancel_subject_approval(%L, 'Nobody can decide it.')$$, pg_temp.approval_of('cred_alice')),
  'and a rule writer cancels it');

-- 2. Deliveries, the vendor's read and everyone else -------------------------------------------------------------------------------
with x as (insert into app.approval_rules (project_id, subject, name, zone_id)
           values (pg_temp.id('prj_a'), 'Delivery', 'Dock A bookings', pg_temp.id('dock')) returning id) insert into world select 'rule_dock', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_dock'), 1, 'Logistics', pg_temp.id('carol@org_a'));
select app.transition_approval_rule(pg_temp.id('rule_dock'), 'Draft', 'Active', 'Gate Dock A.');
with x as (insert into app.dock_slots (project_id, zone_id, engagement_id, starts_at, ends_at)
           values (pg_temp.id('prj_a'), pg_temp.id('dock'), pg_temp.id('eng_vendor_a'), now() + interval '2 days', now() + interval '2 days 2 hours')
           returning id) insert into world select 'slot', id from x;
select pg_temp.as_platform();
insert into world select 'appr_slot', a.id from app.subject_approvals a where a.dock_slot_id = pg_temp.id('slot');
select ok((select message_args ->> 'title' from app.notifications where kind = 'approval.requested' and subject_id = pg_temp.id('appr_slot'))
  like 'Dock slot Dock A %', 'a dock booking on a gated zone opens its approval, titled by the dock and time');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.as_user('sam');
select is((select approval_state::text from app.subject_approval_status where dock_slot_id = pg_temp.id('slot')), 'In Review',
  'the vendor whose engagement the slot serves reads its approval state');
select is((select count(*)::integer from app.subject_approval_decisions), 0, 'but none of its decisions');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.subject_approval_status), 0, 'another org sees none of these approvals');
select pg_temp.as_user('alice');
update app.dock_slots set deleted_at = now() where id = pg_temp.id('slot');
select pg_temp.as_platform();
select is((select cancel_reason from app.subject_approvals where id = pg_temp.id('appr_slot')), 'The dock slot was deleted.',
  'deleting the dock slot withdraws its approval');

-- Catalog -------------------------------------------------------------------------------------------------------------------------
select ok(not has_table_privilege('xos_backup', 'app.subject_approval_status', 'SELECT'), 'the backup login does not read the status view');
select ok(not has_table_privilege('authenticated', 'app.subject_approvals', 'INSERT')
  and not has_table_privilege('authenticated', 'app.subject_approvals', 'UPDATE')
  and not has_table_privilege('authenticated', 'app.subject_approval_decisions', 'INSERT'),
  'signed-in callers write approvals and decisions only through the functions');

select * from finish();
rollback;
