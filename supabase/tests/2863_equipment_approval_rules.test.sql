-- pgTAP: migration 2863, Equipment approval rules (P9b, G-31, ADR 0138) over R7's allocations. An Equipment rule
-- activates; a radio request on the project opens one approval with private.allocation_requester as its requester and
-- the person it is for as its beneficiary, while an assigned allocation and a class with no offering open none; a
-- reviewer cannot approve the allocation (approval_rule_pending) until every step approves, and R9's answer review
-- leaves it Requested instead of rolling back; an Approved approval does not approve the allocation by itself; a
-- rejected step declines the allocation with "Rejected at {step}: {comment}"; withdrawing or declining the allocation
-- withdraws an approval in review, and nobody is reminded about it; readers of allocations read the approval, an
-- outsider does not.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select plan(32);

create function pg_temp.approval_of(p_allocation text) returns uuid
language sql security definer as $$
  select a.id from app.subject_approvals a where a.advance_allocation_id = pg_temp.id(p_allocation) order by a.created_at desc limit 1
$$;
create function pg_temp.approval_state(p_allocation text) returns text
language sql security definer as $$ select private.subject_approval_state(pg_temp.approval_of(p_allocation))::text $$;
create function pg_temp.cancel_reason(p_allocation text) returns text
language sql security definer as $$ select a.cancel_reason from app.subject_approvals a where a.id = pg_temp.approval_of(p_allocation) $$;
-- R9's answer review, as its trigger runs it: inside the trusted operation advance_answer_review (2711).
create function pg_temp.in_answer_review(p_allocation text) returns boolean
language plpgsql security definer as $$
declare
  v boolean;
begin
  perform private.begin_trusted_operation('advance_answer_review');
  v := app.decide_allocation(pg_temp.id(p_allocation), 'Approved', null, null);
  perform private.end_trusted_operation('advance_answer_review');
  return v;
end $$;

-- An Equipment rule for the org's radios on prj_a: bob decides -----------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.approval_rules (project_id, subject, name, asset_class_id)
           values (pg_temp.id('prj_a'), 'Equipment', 'Radio requests', pg_temp.id('cls_radio')) returning id)
  insert into world select 'rule_radio', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_radio'), 1, 'Quartermaster', pg_temp.id('bob@org_a'));
select lives_ok($$select app.transition_approval_rule((select id from world where key = 'rule_radio'), 'Draft', 'Active', 'Gate radios.')$$,
  'an Equipment rule is activated now that equipment requests are gated');

-- 1. A radio request opens one approval ----------------------------------------------------------------------------------------
insert into world select 'a_kai', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1, 'For the stage manager.');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subject_approvals where advance_allocation_id = pg_temp.id('a_kai')), 1,
  'a radio request on the project opens one approval');
select is((select project_id from app.subject_approvals where id = pg_temp.approval_of('a_kai')), pg_temp.id('prj_a'),
  'it carries the allocation''s project');
select is((select approval_rule_id from app.subject_approvals where id = pg_temp.approval_of('a_kai')), pg_temp.id('rule_radio'),
  'under the Equipment rule its class matched');
select is((select requested_by from app.subject_approvals where id = pg_temp.approval_of('a_kai')), private.allocation_requester(pg_temp.id('a_kai')),
  'the requester is private.allocation_requester');
select is((select requested_by from app.subject_approvals where id = pg_temp.approval_of('a_kai')), pg_temp.id('dave'),
  'which is dave, who asked');
select is(private.subject_approval_beneficiary(pg_temp.approval_of('a_kai')), pg_temp.id('kai'),
  'the person the radio is for is the beneficiary, never an approver');
select is(pg_temp.approval_state('a_kai'), 'In Review', 'the approval is In Review');
select is((select recipient_person_id from app.notifications where kind = 'approval.requested' and subject_table = 'subject_approvals'
           and subject_id = pg_temp.approval_of('a_kai')), pg_temp.id('bob'), 'the step''s approver is asked');
select is((select message_args ->> 'title' from app.notifications where kind = 'approval.requested' and subject_id = pg_temp.approval_of('a_kai')),
  (select name from app.asset_classes where id = pg_temp.id('cls_radio')) || ' x1', 'the request names the class and the quantity');
select is((select message_args ->> 'subject' from app.notifications where kind = 'approval.requested' and subject_id = pg_temp.approval_of('a_kai')),
  'Equipment', 'as an Equipment approval');

insert into world select 'a_cable', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_cable', 10);
insert into world select 'a_assigned', pg_temp.alloc('assign', 'carol', 'e_mo', 'class', 'cls_radio', 1);
select pg_temp.as_platform();
select is((select count(*)::integer from app.subject_approvals where advance_allocation_id in (pg_temp.id('a_cable'), pg_temp.id('a_assigned'))), 0,
  'a class with no offering, and an allocation a reviewer assigns, open none');
select is(pg_temp.state_of(pg_temp.id('a_assigned')), 'Approved', 'the assigned allocation is Approved as before');

-- 2. The gate --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_like(format($$select app.decide_allocation(%L, 'Approved')$$, pg_temp.id('a_kai')),
  'approval_rule_pending: Radio requests is waiting on Quartermaster%', 'a reviewer cannot approve the request while its rule is in review');
select is(pg_temp.in_answer_review('a_kai'), false, 'inside R9''s answer review the gate returns false instead of refusing');
select is(pg_temp.state_of(pg_temp.id('a_kai')), 'Requested', 'and the allocation stays Requested for the Allocations queue');
select pg_temp.as_user('carol');
select ok(app.decide_allocation(pg_temp.id('a_cable'), 'Approved'), 'an allocation no rule gates is approved as before');

select pg_temp.as_user('bob');
select lives_ok(format($$select app.decide_subject_approval(%L, true)$$, pg_temp.approval_of('a_kai')), 'bob approves the step');
select is(pg_temp.approval_state('a_kai'), 'Approved', 'the approval is Approved');
select is(pg_temp.state_of(pg_temp.id('a_kai')), 'Requested', 'an Approved approval does not approve the allocation by itself');
select pg_temp.as_user('carol');
select ok(app.decide_allocation(pg_temp.id('a_kai'), 'Approved'), 'the reviewer approves it once every step has');
select is(pg_temp.state_of(pg_temp.id('a_kai')), 'Approved', 'and it is Approved');

-- 3. A rejected step declines the allocation -------------------------------------------------------------------------------------
insert into world select 'a_mo', pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_radio', 1);
select pg_temp.as_user('bob');
select lives_ok(format($$select app.decide_subject_approval(%L, false, 'Mo has one already.')$$, pg_temp.approval_of('a_mo')),
  'bob rejects the step with a reason');
select pg_temp.as_platform();
select is(pg_temp.state_of(pg_temp.id('a_mo')), 'Declined', 'rejecting the step declines the allocation');
select is((select reason from app.advance_allocation_state_transitions where advance_allocation_id = pg_temp.id('a_mo') and to_state = 'Declined'),
  'Rejected at Quartermaster: Mo has one already.', 'with the step and the comment as its reason');
select is(pg_temp.approval_state('a_mo'), 'Rejected', 'the approval stays Rejected, not withdrawn');
select is((select count(*)::integer from app.notifications where kind = 'allocation.decided' and subject_id = pg_temp.id('a_mo')
           and recipient_person_id = pg_temp.id('dave') and message_args ->> 'decision' = 'declined'), 1,
  'the requester hears the allocation was declined');

-- 4. Withdrawing or declining the allocation withdraws the approval --------------------------------------------------------------
insert into world select 'a_w', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('dave');
select app.withdraw_allocation(pg_temp.id('a_w'), 'No longer needed.');
select pg_temp.as_platform();
select is(pg_temp.cancel_reason('a_w'), 'The equipment request was withdrawn.', 'withdrawing the allocation withdraws its approval');
select is(private.reminder_subject_live('subject_approvals', pg_temp.approval_of('a_w'), now()), false, 'and nobody is reminded about it');

insert into world select 'a_d', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('carol');
select app.decide_allocation(pg_temp.id('a_d'), 'Rejected', 'Over the radio budget.');
select pg_temp.as_platform();
select is(pg_temp.cancel_reason('a_d'), 'The equipment request was declined.', 'a reviewer declining the allocation withdraws its approval in review');

-- 5. Who reads it ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select approval_state::text from app.subject_approval_status where advance_allocation_id = pg_temp.id('a_kai')), 'Approved',
  'a reader of the allocations reads its approval''s computed state');
select pg_temp.as_user('quinn');
select is((select count(*)::integer from app.subject_approval_status where advance_allocation_id = pg_temp.id('a_kai')), 0,
  'an outsider reads none');

select * from finish();
rollback;
