-- 1395_approval_delegation_scope.sql
-- Orchestrator fix (RRR-121, audit of A76 on batch-c): Out of Office delegation for approvals (1325) follows what
-- was delegated, and an approval always reaches someone who can act on it. While an approver is away
-- (me.out_of_office.enabled and the dates, private.person_away):
--
--   * A delegation counts for an approval step only when it covers the document's approval capability: its
--     capability_code is that capability, or it is null (every approve-class capability, 0202) and the capability is
--     approve-class, the rule private.person_capability_reach applies. A delegate for timesheets no longer decides,
--     reads or is asked about purchase orders, and the away approver is still asked.
--   * private.spend_approve_capability names the capability a spend document type is approved with, the mapping
--     private.spend_document_facts uses.
--   * private.is_step_approver takes that capability; private.is_policy_approver and app.decide_approval pass it.
--   * private.step_approver_person_ids replaces an away approver only by delegates who can still act on the approval:
--     p_unavailable lists the requester and the people who already decided a step. With no such delegate the approver
--     stays, so no approval goes unseen. private.notify_step_approvers passes them.
--
-- Every function below starts from its latest definition (1030 and 1325) and keeps its behaviour otherwise.

create or replace function private.spend_approve_capability(p_document_type app.spend_document_type)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_document_type
    when 'Purchase Order' then 'finance.po.approve'
    when 'Change Order' then 'finance.change_order.approve'
    when 'Invoice Approval' then 'finance.invoice.approve'
    when 'Requisition' then 'people.requisition.approve'
    when 'Expense' then 'finance.expense.approve'
    when 'Payroll Run' then 'crew.pay_period.manage'
  end;
$$;

comment on function private.spend_approve_capability(app.spend_document_type) is 'The capability a spend document type is approved with, as private.spend_document_facts names it (finance.po.approve for a Purchase Order and so on); null for a Contract (1395).';
revoke all on function private.spend_approve_capability(app.spend_document_type) from public, anon, authenticated;

-- Delegates who cover the capability ---------------------------------------------------------------------------------

create or replace function private.away_delegate_person_ids(p_org_id uuid, p_delegator_membership_id uuid, p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct em.person_id
  from app.delegations d
  join app.memberships dm on dm.id = d.delegator_membership_id
  join app.memberships em on em.id = d.delegate_membership_id
  where d.org_id = p_org_id and d.delegator_membership_id = p_delegator_membership_id and d.deleted_at is null
    and d.valid_from <= now() and d.valid_to > now()
    and em.deleted_at is null and em.valid_from <= now() and (em.valid_to is null or em.valid_to > now())
    and p_capability is not null
    and (d.capability_code = p_capability
         or (d.capability_code is null and exists (
           select 1 from app.capabilities c where c.code = p_capability and c.capability_class = 'approve')))
    and private.person_away(dm.person_id, p_org_id);
$$;

comment on function private.away_delegate_person_ids(uuid, uuid, text) is 'The people a member delegated a capability to in an org, while that member is out of office (1325): delegations of that capability, or of every approve-class capability (null capability_code) when it is approve-class (1395). Empty while the member is in, or for a null capability.';
revoke all on function private.away_delegate_person_ids(uuid, uuid, text) from public, anon, authenticated;

-- Who may decide a step ----------------------------------------------------------------------------------------------

drop function private.is_step_approver(uuid, uuid, uuid);

create or replace function private.is_step_approver(p_org_id uuid, p_role_id uuid, p_membership_id uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select m.id, m.person_id from app.memberships m
    where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and (m.id = p_membership_id
           or (p_role_id is not null and exists (select 1 from app.membership_roles mr
               where mr.membership_id = m.id and mr.role_id = p_role_id and mr.deleted_at is null)))
  )
  select (p_membership_id is not null or p_role_id is not null) and (
    exists (select 1 from eligible e where e.person_id = private.current_person_id())
    or exists (select 1 from eligible e
               where private.current_person_id() in (select private.away_delegate_person_ids(p_org_id, e.id, p_capability))));
$$;

comment on function private.is_step_approver(uuid, uuid, uuid, text) is 'True when the signed-in person may decide a step naming this role or membership in the org: they hold the role through an active membership, they are the member, or they are the delegate of such an approver who is out of office (1325) and the delegation covers p_capability, the document''s approval capability (1395).';
revoke all on function private.is_step_approver(uuid, uuid, uuid, text) from public, anon;
grant execute on function private.is_step_approver(uuid, uuid, uuid, text) to authenticated, service_role;

create or replace function private.is_policy_approver(p_policy_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.approval_steps s
    join app.approval_policies p on p.id = s.approval_policy_id
    where s.approval_policy_id = p_policy_id and s.deleted_at is null
      and private.is_step_approver(s.org_id, s.approver_role_id, s.approver_membership_id,
        private.spend_approve_capability(p.document_type)));
$$;

comment on function private.is_policy_approver(uuid) is 'True when the signed-in person is an approver of any step of the policy, including the delegate of an away approver whose delegation covers the policy''s approval capability (1395).';

-- Who is asked to decide a step --------------------------------------------------------------------------------------

drop function private.step_approver_person_ids(uuid, smallint);

create or replace function private.step_approver_person_ids(
  p_policy_id uuid,
  p_step_order smallint,
  p_unavailable uuid[] default '{}'
)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select distinct m.id, m.person_id, s.org_id, private.spend_approve_capability(p.document_type) as capability
    from app.approval_steps s
    join app.approval_policies p on p.id = s.approval_policy_id
    join app.memberships m on m.org_id = s.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    where s.approval_policy_id = p_policy_id and s.step_order = p_step_order and s.deleted_at is null
      and (m.id = s.approver_membership_id
           or exists (select 1 from app.membership_roles mr
                      where mr.membership_id = m.id and mr.role_id = s.approver_role_id and mr.deleted_at is null))
  ),
  stand_in as (
    select e.id as approver_membership_id, d as person_id
    from eligible e
    cross join lateral private.away_delegate_person_ids(e.org_id, e.id, e.capability) d
    where d <> all (coalesce(p_unavailable, '{}'::uuid[]))
  )
  select e.person_id from eligible e
  where not exists (select 1 from stand_in x where x.approver_membership_id = e.id)
  union
  select x.person_id from stand_in x;
$$;

comment on function private.step_approver_person_ids(uuid, smallint, uuid[]) is 'People to ask to decide one step of a policy now, for notifications. An approver who is out of office is replaced by their delegates whose delegation covers the policy''s approval capability (1325, 1395), leaving out p_unavailable (the requester and people who already decided a step); with no such delegate the approver is asked.';
revoke all on function private.step_approver_person_ids(uuid, smallint, uuid[]) from public, anon, authenticated;

create or replace function private.notify_step_approvers(p_instance app.approval_instances)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_title text := p_instance.document_type::text || coalesce(' ' || p_instance.subject_reference, '');
  v_unavailable uuid[] := array[p_instance.requested_by] || coalesce(
    (select array_agg(d.approver_id) from app.approval_decisions d where d.approval_instance_id = p_instance.id),
    '{}'::uuid[]);
begin
  for v_person in
    select x from private.step_approver_person_ids(p_instance.approval_policy_id, p_instance.current_step, v_unavailable) x
    where x <> p_instance.requested_by
      and not exists (select 1 from app.approval_decisions d
                      where d.approval_instance_id = p_instance.id and d.approver_id = x)
  loop
    perform private.notify(p_instance.org_id, v_person, 'approval.requested', 'approval_instances', p_instance.id,
      p_instance.project_id, jsonb_build_object('title', v_title,
        'actorName', (select p.full_name from app.people p where p.id = p_instance.requested_by)));
  end loop;
end;
$$;

comment on function private.notify_step_approvers(app.approval_instances) is 'Notifies everyone who may decide the instance''s current step (approval.requested), except the requester and people who already decided a step. An away approver whose only delegates are those people is notified in their place (1395).';
revoke all on function private.notify_step_approvers(app.approval_instances) from public, anon, authenticated;

-- Deciding ----------------------------------------------------------------------------------------------------------

create or replace function app.decide_approval(p_approval_instance_id uuid, p_approved boolean, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_instance app.approval_instances;
  v_step app.approval_steps;
  v_next smallint;
  v_decision uuid;
  v_title text;
  v_capability text;
begin
  select * into v_instance from app.approval_instances i
  where i.id = p_approval_instance_id and i.deleted_at is null for update;
  if v_instance.id is null or v_instance.org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'approval not found';
  end if;
  if v_instance.approval_state <> 'In Review' then
    perform private.refuse('approval_not_in_review', format('This approval is %s; only an approval in review is decided.', v_instance.approval_state));
  end if;
  perform private.assert_separation('sod_approval_requester', v_person, v_instance.requested_by);
  select f.approve_capability into v_capability from private.spend_document_facts(v_instance.document_type, v_instance.document_id) f;
  select * into v_step from app.approval_steps s
  where s.approval_policy_id = v_instance.approval_policy_id and s.step_order = v_instance.current_step and s.deleted_at is null;
  if v_step.id is null or not private.is_step_approver(v_instance.org_id, v_step.approver_role_id, v_step.approver_membership_id, v_capability) then
    perform private.refuse('approval_not_step_approver', 'You are not an approver of the step this approval is waiting on.');
  end if;
  if v_capability is null
     or (v_instance.project_id is not null and not private.can_on_project(v_instance.project_id, v_capability))
     or (v_instance.project_id is null and not private.has_capability(v_instance.org_id, v_capability)) then
    perform private.refuse('approval_approver_capability',
      'Approving this document needs its approval capability; a step''s approver must also hold it.');
  end if;
  if exists (select 1 from app.approval_decisions d where d.approval_instance_id = v_instance.id and d.approver_id = v_person) then
    perform private.refuse('approval_one_step_per_approver', 'You already decided a step of this approval; the next step needs another approver.');
  end if;
  if not coalesce(p_approved, false) and (p_comment is null or char_length(btrim(p_comment)) = 0) then
    perform private.refuse('approval_rejection_reason', 'Say why when you reject an approval.');
  end if;

  insert into app.approval_decisions (approval_instance_id, step_order, approver_id, approved, comment)
  values (v_instance.id, v_instance.current_step, v_person, coalesce(p_approved, false), nullif(btrim(p_comment), ''))
  returning id into v_decision;

  v_title := v_instance.document_type::text || coalesce(' ' || v_instance.subject_reference, '');
  if not coalesce(p_approved, false) then
    perform private.transition_lifecycle('approval', 'app.approval_instances', 'approval_state',
      'app.approval_state_transitions', 'approval_instance_id', v_instance.id, 'In Review', 'Rejected', btrim(p_comment));
  else
    select min(s.step_order) into v_next from app.approval_steps s
    where s.approval_policy_id = v_instance.approval_policy_id and s.deleted_at is null and s.step_order > v_instance.current_step;
    if v_next is null then
      perform private.transition_lifecycle('approval', 'app.approval_instances', 'approval_state',
        'app.approval_state_transitions', 'approval_instance_id', v_instance.id, 'In Review', 'Approved',
        coalesce(nullif(btrim(p_comment), ''), 'Every step approved.'));
    else
      perform private.begin_trusted_operation('approval_decision');
      update app.approval_instances set current_step = v_next where id = v_instance.id returning * into v_instance;
      perform private.end_trusted_operation('approval_decision');
      perform private.notify_step_approvers(v_instance);
      return v_decision;
    end if;
  end if;
  perform private.notify(v_instance.org_id, v_instance.requested_by, 'approval.decided', 'approval_instances', v_instance.id,
    v_instance.project_id, jsonb_build_object('title', v_title, 'decision', case when p_approved then 'approved' else 'rejected' end,
      'actorName', (select p.full_name from app.people p where p.id = v_person)));
  return v_decision;
end;
$$;

comment on function app.decide_approval(uuid, boolean, text) is 'Decides the step an approval is waiting on: an eligible approver of that step (or the delegate of an away approver whose delegation covers the document''s approval capability, 1325 and 1395) who also holds the document''s approval capability (finance.po.approve and so on, on its project), never the requester (sod_approval_requester), one step per person, with a reason when rejecting. Approving the last step approves the instance; a rejection rejects it. Notifies the next step''s approvers, or the requester once decided. Returns the decision id.';

drop function private.away_delegate_person_ids(uuid, uuid);
