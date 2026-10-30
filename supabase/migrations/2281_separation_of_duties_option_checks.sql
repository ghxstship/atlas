-- 2281_separation_of_duties_option_checks.sql
-- A135 (RRR-197), Section 8.2, ADR 0114: the stricter separation of duties options of 2280 are enforced in the same
-- functions that enforce the built-in rules, each refusing with the option's code and sentence (XR001, message
-- "<code>: <sentence>", hint the code), and only where the org switched the option on.
--   * sod_document_creator: private.approve_under_spend_authority, which every spend approval RPC runs (purchase
--     orders and their change orders, change orders, invoices, requisitions, expenses, payroll runs and settlement
--     rounds), refuses the document's creator; app.decide_approval refuses the creator a step of its approval.
--   * sod_change_order_requester_steps: app.decide_approval refuses a change order's requester any step of its
--     approval, also when someone else requested the approval.
--   * sod_receiver_po_approver: private.guard_goods_receipt and private.guard_receipt_line refuse a receipt, or a
--     line on one, by a person who approved the purchase order or a change order to it (a spend approval or an
--     approving step).
-- Every function below starts from its latest definition (approve_under_spend_authority 1030, decide_approval 1395,
-- guard_goods_receipt and guard_receipt_line 0331) and keeps its behaviour otherwise.

-- Helpers -------------------------------------------------------------------------------------------------------------

create or replace function private.spend_document_creator(p_document_type app.spend_document_type, p_document_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_document_type
    when 'Purchase Order' then coalesce(
      (select po.created_by from app.purchase_orders po where po.id = p_document_id),
      (select c.created_by from app.po_change_orders c where c.id = p_document_id))
    when 'Change Order' then (select c.created_by from app.change_orders c where c.id = p_document_id)
    when 'Invoice Approval' then (select i.created_by from app.invoices i where i.id = p_document_id)
    when 'Requisition' then (select r.created_by from app.requisitions r where r.id = p_document_id)
    when 'Expense' then (select e.created_by from app.expenses e where e.id = p_document_id)
    when 'Payroll Run' then (select r.created_by from app.payroll_runs r where r.id = p_document_id)
    when 'Contract' then (select s.created_by from app.settlement_state_transitions t
                          join app.settlements s on s.id = t.settlement_id where t.id = p_document_id)
  end;
$$;

comment on function private.spend_document_creator(app.spend_document_type, uuid) is 'The person who created a spend document, by the id its approval uses: a purchase order or PO change order, change order, payable invoice, requisition, expense, payroll run, or the settlement of a settlement round (Contract). NULL when unknown.';
revoke all on function private.spend_document_creator(app.spend_document_type, uuid) from public, anon, authenticated;

create or replace function private.is_purchase_order_approver(p_purchase_order_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with docs as (
    select p_purchase_order_id as id
    union all
    select c.id from app.po_change_orders c where c.purchase_order_id = p_purchase_order_id
  )
  select exists (
    select 1 from app.spend_approvals a
    where a.document_type = 'Purchase Order' and a.approver_person_id = p_person_id and a.deleted_at is null
      and a.document_id in (select d.id from docs d)
  ) or exists (
    select 1 from app.approval_decisions d
    join app.approval_instances i on i.id = d.approval_instance_id
    where i.document_type = 'Purchase Order' and d.approver_id = p_person_id and d.approved and d.deleted_at is null
      and i.document_id in (select x.id from docs x)
  );
$$;

comment on function private.is_purchase_order_approver(uuid, uuid) is 'True when the person approved the purchase order or a change order to it: a spend approval (Section 8.1) or an approving step of its approval (1030).';
revoke all on function private.is_purchase_order_approver(uuid, uuid) from public, anon, authenticated;

-- Spend approvals -----------------------------------------------------------------------------------------------------

create or replace function private.approve_under_spend_authority(
  p_org_id uuid,
  p_document_type app.spend_document_type,
  p_document_id uuid,
  p_amount_minor bigint,
  p_currency_code char(3),
  p_account_code text,
  p_cost_center_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_authority app.spend_authorities;
  v_policy uuid;
  v_needed integer;
  v_given integer;
begin
  if private.separation_option_on(p_org_id, 'sod_document_creator') then
    perform private.assert_separation('sod_document_creator', v_person,
      private.spend_document_creator(p_document_type, p_document_id));
  end if;
  if p_amount_minor is null then
    perform private.refuse('spend_unpriced', 'An unpriced amount cannot be approved; price it first.');
  end if;
  v_policy := private.applicable_approval_policy(p_org_id, p_document_type, p_amount_minor, p_currency_code);
  if v_policy is not null and not exists (
    select 1 from app.approval_instances i
    where i.document_type = p_document_type and i.document_id = p_document_id and i.deleted_at is null
      and i.approval_state = 'Approved' and i.currency_code = p_currency_code and i.amount_minor >= p_amount_minor
  ) then
    perform private.refuse('approval_policy_pending',
      format('This %s needs approval under the policy %s before it is approved; request approval first.',
        p_document_type, (select p.name from app.approval_policies p where p.id = v_policy)));
  end if;
  select sa.* into v_authority
  from app.spend_authorities sa
  where sa.org_id = p_org_id and sa.document_type = p_document_type and sa.currency_code = p_currency_code
    and sa.deleted_at is null and sa.valid_from <= now() and (sa.valid_to is null or sa.valid_to > now())
    and (sa.account_code is null or sa.account_code = p_account_code)
    and (sa.cost_center_id is null or sa.cost_center_id = p_cost_center_id)
    and (
      sa.membership_id in (select private.my_membership_ids())
      or sa.role_id in (
        select mr.role_id from app.membership_roles mr
        where mr.deleted_at is null and mr.membership_id in (select private.my_membership_ids()))
    )
  order by sa.limit_minor desc
  limit 1;
  if v_authority.id is null then
    perform private.refuse('spend_authority_missing',
      format('No spend authority lets this person approve a %s in %s.', p_document_type, p_currency_code));
  end if;
  if p_amount_minor > v_authority.limit_minor then
    perform private.refuse('spend_authority_exceeded',
      format('This %s exceeds the approver''s limit; route it to the next approver in the policy.', p_document_type));
  end if;
  if exists (select 1 from app.spend_approvals a
             where a.document_type = p_document_type and a.document_id = p_document_id and a.approver_person_id = v_person) then
    perform private.refuse('spend_approval_duplicate', 'A person approves a document once; a second approval needs a different approver.');
  end if;
  insert into app.spend_approvals (org_id, document_type, document_id, approver_person_id, amount_minor, currency_code, spend_authority_id)
  values (p_org_id, p_document_type, p_document_id, v_person, p_amount_minor, p_currency_code, v_authority.id);
  v_needed := case when v_authority.dual_approval_above_minor is not null
                    and p_amount_minor > v_authority.dual_approval_above_minor then 2 else 1 end;
  select count(distinct a.approver_person_id) into v_given from app.spend_approvals a
  where a.document_type = p_document_type and a.document_id = p_document_id;
  return v_given >= v_needed;
end;
$$;

comment on function private.approve_under_spend_authority(uuid, app.spend_document_type, uuid, bigint, char, text, uuid) is 'Section 8.1, enforced inside every approval RPC: refuses the document''s creator where the org switched on sod_document_creator (Section 8.2, 2281); refuses an unpriced amount; refuses while an Active approval policy applies and no Approved approval covers the document''s amount in its currency (approval_policy_pending, A33); finds the widest limit that applies to the signed-in approver, refuses a missing limit or an amount above it, records the approval, and returns true once enough distinct approvers (two above the dual threshold) have approved.';
revoke all on function private.approve_under_spend_authority(uuid, app.spend_document_type, uuid, bigint, char, text, uuid) from public, anon, authenticated;

-- Approval steps ------------------------------------------------------------------------------------------------------

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
  if private.separation_option_on(v_instance.org_id, 'sod_document_creator') then
    perform private.assert_separation('sod_document_creator', v_person,
      private.spend_document_creator(v_instance.document_type, v_instance.document_id));
  end if;
  if v_instance.document_type = 'Change Order'
     and private.separation_option_on(v_instance.org_id, 'sod_change_order_requester_steps') then
    perform private.assert_separation('sod_change_order_requester_steps', v_person,
      (select c.requested_by from app.change_orders c where c.id = v_instance.document_id));
  end if;
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

comment on function app.decide_approval(uuid, boolean, text) is 'Decides the step an approval is waiting on: an eligible approver of that step (or the delegate of an away approver whose delegation covers the document''s approval capability, 1325 and 1395) who also holds the document''s approval capability (finance.po.approve and so on, on its project), never the requester (sod_approval_requester), one step per person, with a reason when rejecting. Where the org switched them on (2281), never the document''s creator (sod_document_creator) and never a change order''s requester (sod_change_order_requester_steps). Approving the last step approves the instance; a rejection rejects it. Notifies the next step''s approvers, or the requester once decided. Returns the decision id.';

-- Goods receipts ------------------------------------------------------------------------------------------------------

create or replace function private.guard_goods_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
  v_person uuid := private.current_person_id();
begin
  if tg_op = 'INSERT' then
    select * into v_order from app.purchase_orders po where po.id = new.purchase_order_id;
    if v_order.po_state not in ('Approved', 'Sent') then
      perform private.refuse('receipt_order_state', 'Goods are received only against an approved or sent purchase order.');
    end if;
    if v_person is not null and private.separation_option_on(v_order.org_id, 'sod_receiver_po_approver')
       and private.is_purchase_order_approver(v_order.id, v_person) then
      perform private.refuse('sod_receiver_po_approver',
        (select r.description from private.separation_of_duties_rules r where r.code = 'sod_receiver_po_approver'));
    end if;
    new.received_by := coalesce(v_person, new.received_by);
  elsif new.purchase_order_id <> old.purchase_order_id or new.received_by is distinct from old.received_by then
    perform private.refuse('receipt_immutable', 'A receipt keeps its purchase order and receiver.');
  end if;
  return new;
end;
$$;

comment on function private.guard_goods_receipt() is 'Goods receipts: only against approved or sent orders; receiver from the session; never by an approver of the order or a change to it where the org switched on sod_receiver_po_approver (2281).';

create or replace function private.guard_receipt_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line app.po_lines;
  v_received numeric;
  v_person uuid;
begin
  select * into v_line from app.po_lines l where l.id = new.po_line_id for update;
  if v_line.purchase_order_id <> (select r.purchase_order_id from app.goods_receipts r where r.id = new.goods_receipt_id) then
    perform private.refuse('receipt_line_order', 'A receipt line receives a line of the receipt''s purchase order.');
  end if;
  if tg_op = 'UPDATE' and (new.goods_receipt_id <> old.goods_receipt_id or new.po_line_id <> old.po_line_id) then
    perform private.refuse('receipt_line_immutable', 'A receipt line keeps its receipt and order line.');
  end if;
  if tg_op = 'INSERT' then
    v_person := private.current_person_id();
    if v_person is not null and private.separation_option_on(v_line.org_id, 'sod_receiver_po_approver')
       and private.is_purchase_order_approver(v_line.purchase_order_id, v_person) then
      perform private.refuse('sod_receiver_po_approver',
        (select r.description from private.separation_of_duties_rules r where r.code = 'sod_receiver_po_approver'));
    end if;
  end if;
  select coalesce(sum(rl.quantity_received), 0) into v_received from app.receipt_lines rl
  where rl.po_line_id = new.po_line_id and rl.deleted_at is null and rl.id <> new.id;
  if new.deleted_at is null and v_received + new.quantity_received > v_line.quantity then
    perform private.refuse('receipt_exceeds_order', 'Receipts never exceed the quantity ordered.');
  end if;
  return new;
end;
$$;

comment on function private.guard_receipt_line() is 'Receipt lines receive lines of the same order and never beyond the quantity ordered; where the org switched on sod_receiver_po_approver (2281), an approver of the order or a change to it adds none.';

-- Privileges ----------------------------------------------------------------------------------------------------------

revoke all on function app.decide_approval(uuid, boolean, text) from public, anon;
grant execute on function app.decide_approval(uuid, boolean, text) to authenticated, service_role;
revoke all on function private.guard_goods_receipt() from public, anon, authenticated;
revoke all on function private.guard_receipt_line() from public, anon, authenticated;
