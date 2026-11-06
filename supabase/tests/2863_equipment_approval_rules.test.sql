-- pgTAP: migration 2863, Equipment approval rules (P9b, G-31, ADR 0138) over R7's allocations. An Equipment rule
-- activates; a radio request on the project opens one approval with private.allocation_requester as its requester and
-- the person it is for as its beneficiary, while an assigned allocation and a class with no offering open none; a
-- reviewer cannot approve the allocation (approval_rule_pending) until every step approves, and R9's answer review
-- leaves it Requested instead of rolling back (simulated: R9 is not on this base, see the merge train); an Approved approval does not approve the allocation by itself; a
-- rejected step declines the allocation with "Rejected at {step}: {comment}"; withdrawing or declining the allocation
-- or deleting it withdraws an approval in review, and nobody is reminded about it; withdrawing the approval withdraws
-- the request whoever does it (the requester, the subject's writer, a rule writer who also reviews), so a reviewer can
-- never approve a request no step approved, and anyone else is refused; a rule on a class with no offering does not
-- activate; readers of allocations read the approval, an outsider does not.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select plan(76);

create function pg_temp.approval_of(p_allocation text) returns uuid
language sql security definer as $$
  select a.id from app.subject_approvals a where a.advance_allocation_id = pg_temp.id(p_allocation) order by a.created_at desc limit 1
$$;
create function pg_temp.approval_state(p_allocation text) returns text
language sql security definer as $$ select private.subject_approval_state(pg_temp.approval_of(p_allocation))::text $$;
create function pg_temp.cancel_reason(p_allocation text) returns text
language sql security definer as $$ select a.cancel_reason from app.subject_approvals a where a.id = pg_temp.approval_of(p_allocation) $$;
create function pg_temp.is_subject_writer(p_allocation text) returns boolean
language sql security definer as $$ select private.is_subject_writer(pg_temp.approval_of(p_allocation)) $$;
create function pg_temp.writes_the_rule(p_allocation text) returns boolean
language sql security definer as $$
  select private.can_write_approval_rule(a.org_id, a.project_id) from app.subject_approvals a where a.id = pg_temp.approval_of(p_allocation)
$$;
create function pg_temp.withdrawal(p_allocation text) returns text
language sql security definer as $$
  select al.withdraw_cause::text || ': ' || tr.reason from app.advance_allocations al
  join app.advance_allocation_state_transitions tr on tr.advance_allocation_id = al.id and tr.to_state = 'Withdrawn'
  where al.id = pg_temp.id(p_allocation)
$$;
create function pg_temp.notified(p_who text, p_kind text, p_allocation text) returns integer
language sql security definer as $$
  select count(*)::integer from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind and n.subject_table = 'advance_allocations' and n.subject_id = pg_temp.id(p_allocation)
$$;
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
-- The body of private.on_answer_reviewed on batch-c (4711), for one allocation: a perform inside a subtransaction that
-- catches only the refusals it leaves for the queue, and rolls the review back for anything else, approval_rule_pending included.
create function pg_temp.answer_review_loop(p_allocation text, p_outcome text default 'Accepted', p_return_reason text default null) returns void
language plpgsql security definer as $$
declare
  v_hint text;
begin
  perform private.begin_trusted_operation('advance_answer_review');
  if p_outcome = 'Accepted' then
    begin
      perform app.decide_allocation(pg_temp.id(p_allocation), 'Approved', null, null);
    exception when sqlstate 'XR001' then
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint not in ('allocation_sources_required', 'reservation_over_capacity', 'allocation_over_allowance_reason',
                        'allocation_entry_not_accepted') then
        raise;
      end if;
    end;
  else
    perform app.decide_allocation(pg_temp.id(p_allocation), 'Rejected', p_return_reason, null);
  end if;
  perform private.end_trusted_operation('advance_answer_review');
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
select lives_ok($$select pg_temp.answer_review_loop('a_kai')$$, 'R9''s trigger body commits its review with the rule pending');
select is(pg_temp.state_of(pg_temp.id('a_kai')), 'Requested', 'and still leaves the allocation Requested');
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

-- A decision from the email link (2861) has no session, and the rule named the approver, so it declines the same way.
insert into world select 'a_link', pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_radio', 1);
select pg_temp.as_platform();
select lives_ok(format($$select private.decide_subject_approval_as(%L, %L, false, 'Not this week.', 'Email link')$$,
  pg_temp.approval_of('a_link'), pg_temp.id('bob')), 'a rejection from the email link needs no session');
select is(pg_temp.state_of(pg_temp.id('a_link')), 'Declined', 'and declines the allocation');
select is((select reason from app.advance_allocation_state_transitions where advance_allocation_id = pg_temp.id('a_link') and to_state = 'Declined'),
  'Rejected at Quartermaster: Not this week.', 'with the same reason');

-- 4. Withdrawing or declining the allocation withdraws the approval --------------------------------------------------------------
insert into world select 'a_w', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('dave');
select app.withdraw_allocation(pg_temp.id('a_w'), 'No longer needed.');
select pg_temp.as_platform();
select is(pg_temp.cancel_reason('a_w'), 'The equipment request was withdrawn.', 'withdrawing the allocation withdraws its approval');
select is(private.reminder_subject_live('subject_approvals', pg_temp.approval_of('a_w'), now()), false, 'and nobody is reminded about it');
select is(pg_temp.withdrawal('a_w'), 'Requester: No longer needed.', 'the withdrawal keeps its own reason, not the approval''s');

insert into world select 'a_d', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('carol');
select app.decide_allocation(pg_temp.id('a_d'), 'Rejected', 'Over the radio budget.');
select pg_temp.as_platform();
select is(pg_temp.cancel_reason('a_d'), 'The equipment request was declined.', 'a reviewer declining the allocation withdraws its approval in review');
select is(private.reminder_subject_live('subject_approvals', pg_temp.approval_of('a_d'), now()), false, 'and nobody is reminded about a declined request');
select is(private.reminder_subject_live('subject_approvals', pg_temp.approval_of('a_kai'), now()), false, 'nor about one a reviewer has approved');

-- R9 returning an answer declines the allocation the same way.
insert into world select 'a_ret', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('carol');
select lives_ok($$select pg_temp.answer_review_loop('a_ret', 'Returned', 'Ask for this on the crew sheet.')$$, 'R9''s return declines a gated request');
select pg_temp.as_platform();
select is(pg_temp.state_of(pg_temp.id('a_ret')), 'Declined', 'the allocation is Declined');
select is(pg_temp.cancel_reason('a_ret'), 'The equipment request was declined.', 'and its approval is withdrawn');

insert into world select 'a_del', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_platform();
select is(private.reminder_subject_live('subject_approvals', pg_temp.approval_of('a_del'), now()), true, 'an approval in review on a live request is reminded');
update app.advance_allocations set deleted_at = now() where id = pg_temp.id('a_del');
select is(pg_temp.cancel_reason('a_del'), 'The equipment request was deleted.', 'deleting the allocation withdraws its approval in review');
select is(private.reminder_subject_live('subject_approvals', pg_temp.approval_of('a_del'), now()), false, 'and nobody is reminded about it');
select is(pg_temp.state_of(pg_temp.id('a_del')), 'Requested', 'a deleted row keeps its state: the cancel does not move it');

-- 4b. Withdrawing the approval withdraws the request, whoever does it, so it never lifts the gate -----------------------------------
-- The requester, from Approvals. Without this, carol could approve a request no step approved.
insert into world select 'a_req', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('dave');
select is(pg_temp.is_subject_writer('a_req') and not pg_temp.writes_the_rule('a_req'), true, 'dave writes advance requests and not the rule');
select throws_like(format($$select app.cancel_subject_approval(%L, ' ')$$, pg_temp.approval_of('a_req')),
  'approval_cancel_reason:%', 'withdrawing the approval needs a reason');
select is(pg_temp.state_of(pg_temp.id('a_req')), 'Requested', 'and a refused cancel moves nothing');
select pg_temp.as_user('dave');
select lives_ok(format($$select app.cancel_subject_approval(%L, 'Kai borrowed one.')$$, pg_temp.approval_of('a_req')),
  'the requester withdraws the approval');
select is(pg_temp.approval_state('a_req'), 'Canceled', 'the approval is Canceled');
select is(pg_temp.state_of(pg_temp.id('a_req')), 'Withdrawn', 'and the request is Withdrawn with it');
select is(pg_temp.withdrawal('a_req'), 'Requester: Approval withdrawn: Kai borrowed one.', 'by the requester, with the approval''s reason in the ledger');
select is(pg_temp.notified('kai', 'allocation.withdrawn', 'a_req'), 1, 'the person it was for hears');
select is(pg_temp.notified('dave', 'allocation.withdrawn', 'a_req'), 0, 'the requester, who did it, does not');
select pg_temp.as_user('carol');
select throws_like(format($$select app.decide_allocation(%L, 'Approved')$$, pg_temp.id('a_req')),
  'allocation_state_conflict:%', 'a reviewer cannot approve what the requester withdrew');

-- The subject's writer: dave writes advance requests, so he may withdraw one carol asked for, and it is withdrawn too.
insert into world select 'a_wr', pg_temp.alloc('request', 'carol', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('dave');
select lives_ok(format($$select app.cancel_subject_approval(%L, 'Asked twice.')$$, pg_temp.approval_of('a_wr')),
  'the subject''s writer withdraws the approval, through advancing.packet.write alone');
select is(pg_temp.state_of(pg_temp.id('a_wr')), 'Withdrawn', 'and the request is Withdrawn');
select is(pg_temp.withdrawal('a_wr'), 'Reviewer: Approval withdrawn: Asked twice.', 'by someone other than its requester');
select is(pg_temp.notified('carol', 'allocation.withdrawn', 'a_wr'), 1, 'the requester hears');

-- A rule writer who also reviews cannot do both steps alone: carol manages, so she writes rules and reviews.
insert into world select 'a_both', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('carol');
select ok(pg_temp.writes_the_rule('a_both'), 'carol writes the rule');
select lives_ok(format($$select app.cancel_subject_approval(%L, 'Nobody can decide this step.')$$, pg_temp.approval_of('a_both')),
  'a rule writer withdraws the approval');
select is(pg_temp.state_of(pg_temp.id('a_both')), 'Withdrawn', 'and the request is Withdrawn');
select pg_temp.as_user('carol');
select throws_like(format($$select app.decide_allocation(%L, 'Approved')$$, pg_temp.id('a_both')),
  'allocation_state_conflict:%', 'so a reviewer who writes rules cannot cancel the gate and then approve');
select is(pg_temp.notified('dave', 'allocation.withdrawn', 'a_both'), 1, 'the requester hears why');
select is((select message_args ->> 'reason' from app.notifications where kind = 'allocation.withdrawn' and subject_id = pg_temp.id('a_both')
           and recipient_person_id = pg_temp.id('dave')), 'Nobody can decide this step.', 'in the rule writer''s words');

-- Anyone else is refused, and the gate still holds.
insert into world select 'a_no', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('gina');
select is(pg_temp.is_subject_writer('a_no') or pg_temp.writes_the_rule('a_no'), false, 'gina neither writes advance requests nor the rule');
select throws_ok(format($$select app.cancel_subject_approval(%L, 'Not mine to withdraw.')$$, pg_temp.approval_of('a_no')), '42501', null,
  'and is refused');
select is(pg_temp.state_of(pg_temp.id('a_no')), 'Requested', 'the request stays Requested');
select is(pg_temp.approval_state('a_no'), 'In Review', 'and its approval In Review');

-- A rule that could never fire does not activate.
select pg_temp.as_user('alice');
with x as (insert into app.approval_rules (project_id, subject, name, asset_class_id)
           values (pg_temp.id('prj_a'), 'Equipment', 'Cable requests', pg_temp.id('cls_cable')) returning id)
  insert into world select 'rule_cable', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_cable'), 1, 'Quartermaster', pg_temp.id('bob@org_a'));
select throws_like(format($$select app.transition_approval_rule(%L, 'Draft', 'Active', 'Gate cable.')$$, pg_temp.id('rule_cable')),
  'approval_rule_class_no_offering:%', 'an Equipment rule on a class with no offering does not activate');

-- 5. Who reads it ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select approval_state::text from app.subject_approval_status where advance_allocation_id = pg_temp.id('a_kai')), 'Approved',
  'a reader of the allocations reads its approval''s computed state');
select pg_temp.as_user('quinn');
select is((select count(*)::integer from app.subject_approval_status where advance_allocation_id = pg_temp.id('a_kai')), 0,
  'an outsider reads none');

-- 6. Refused moves of the two lifecycles this gate joins ----------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_like(format($$select app.transition_approval_rule(%L, 'Active', 'Draft', 'Back to the drawing board.')$$, pg_temp.id('rule_radio')),
  'approval_rule_transition_not_allowed:%', 'an Active rule does not go back to a Draft');
select pg_temp.as_platform();
select throws_like(format($$select private.transition_lifecycle('advance_allocation', 'app.advance_allocations', 'allocation_state',
    'app.advance_allocation_state_transitions', 'advance_allocation_id', %L, 'Declined', 'Requested', 'Reopen.')$$, pg_temp.id('a_mo')),
  'advance_allocation_transition_not_allowed:%', 'a Declined allocation does not go back to Requested');
select is(pg_temp.state_of(pg_temp.id('a_mo')), 'Declined', 'and stays Declined');
select is(pg_temp.approval_state('a_mo'), 'Rejected', 'with its approval still Rejected');

select * from finish();
rollback;
