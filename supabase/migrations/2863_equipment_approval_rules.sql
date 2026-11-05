-- 2863_equipment_approval_rules.sql
-- P9b Equipment approval rules (RRR-223, gap G-31, ADR 0138), the part of P9 that waits on R7's allocations. An
-- Equipment rule gates a radio or cart request from an advance before a reviewer may approve it:
--
--   * app.subject_approvals gains advance_allocation_id. A Requested allocation (origin Requested) of an asset class
--     that carries an offering (Radios or Carts, R7) opens the matching Active Equipment rule's approval when it is
--     made (t91), with private.allocation_requester as the requester (R7, as R10 extends it), never created_by.
--   * app.decide_allocation (from R7's 2693, its only definition on this base) refuses approval_rule_pending while the
--     allocation's live approval is not Approved. An Approved approval does not approve the allocation: a reviewer still
--     does, once, with the sources they choose. Inside R9's answer review (trusted operation advance_answer_review) the
--     gate returns false instead of refusing, so the review commits and the allocation stays Requested for the
--     Allocations queue whichever of R9 and this migration is applied last (review correction C12).
--   * Rejecting a step declines the allocation inside the trusted operation subject_approval_decline, with the reason
--     "Rejected at {step}: {comment}". Withdrawing, declining or deleting the allocation withdraws an approval in review.
--   * The approval helpers of 2860 and 2862 learn the allocation: its holder is the beneficiary, its readers read the
--     approval, advancing.packet.write is the subject's writer, its title is "{class} x{quantity}", and a Withdrawn or
--     decided allocation is no longer reminded. Equipment rules may now be activated.
--   * private.party_org_ids takes both of its open-work definitions: A127's applicants with an open offer (2200) and R4's
--     roster entries (2641). Each was written from 1131 alone, so whichever sorts last would drop the other.
-- subject_approvals stays out of Trash (2860): an approval is withdrawn by Cancel, never restored.

-- 1. The allocation an approval gates ------------------------------------------------------------------------------------------

alter table app.subject_approvals add column advance_allocation_id uuid references app.advance_allocations (id);
comment on column app.subject_approvals.advance_allocation_id is 'Equipment rules: the asset allocation (a radio or cart request from an advance, R7) awaiting approval.';

alter table app.subject_approvals drop constraint subject_approvals_one_subject;
alter table app.subject_approvals add constraint subject_approvals_one_subject
  check (num_nonnulls(credential_id, dock_slot_id, advance_allocation_id) = 1);

create index subject_approvals_advance_allocation_id_idx on app.subject_approvals (advance_allocation_id);
create unique index subject_approvals_one_live_allocation on app.subject_approvals (advance_allocation_id)
  where advance_allocation_id is not null and canceled_at is null and deleted_at is null;

-- The cross-org reference guard now covers the allocation as well as the project, the pass and the dock slot.
drop trigger if exists t30_refuse_cross_org_reference on app.subject_approvals;
create trigger t30_refuse_cross_org_reference before insert or update on app.subject_approvals
  for each row execute function private.refuse_cross_org_reference(
    'app.projects', 'project_id', 'app.credentials', 'credential_id', 'app.dock_slots', 'dock_slot_id',
    'app.advance_allocations', 'advance_allocation_id');

create trigger t15_subject_approvals_allocation_project before insert or update of advance_allocation_id, project_id on app.subject_approvals
  for each row when (new.advance_allocation_id is not null)
  execute function private.copy_parent_project('app.advance_allocations', 'advance_allocation_id');

comment on column app.subject_approvals.project_id is 'Project of the subject (the pass, the dock slot or the allocation), stamped from it on insert (private.copy_parent_project) and never changed.';
comment on table app.subject_approvals is 'A pass, a dock booking or an equipment request going through the approval rule it matched (P9), opened when the row was created. Its state is computed, never stored (ADR 0103): app.subject_approval_status reads the decisions and the cancel stamp. Written only by the approval functions.';

create or replace function private.guard_subject_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule app.approval_rules := private.approval_rule_of(new.approval_rule_id);
begin
  if not private.in_trusted_operation('subject_approval') and auth.uid() is not null then
    perform private.refuse('subject_approval_rpc_only', 'An approval changes only through its functions.');
  end if;
  if tg_op = 'INSERT' then
    if (v_rule.subject = 'Pass') is distinct from (new.credential_id is not null)
       or (v_rule.subject = 'Delivery') is distinct from (new.dock_slot_id is not null)
       or (v_rule.subject = 'Equipment') is distinct from (new.advance_allocation_id is not null) then
      perform private.refuse('subject_approval_subject', 'An approval''s subject is the kind its rule gates.');
    end if;
    return new;
  end if;
  if new.approval_rule_id is distinct from old.approval_rule_id or new.credential_id is distinct from old.credential_id
     or new.dock_slot_id is distinct from old.dock_slot_id or new.advance_allocation_id is distinct from old.advance_allocation_id
     or new.requested_by is distinct from old.requested_by
     or (old.canceled_at is not null and (new.canceled_at is distinct from old.canceled_at
         or new.canceled_by is distinct from old.canceled_by or new.cancel_reason is distinct from old.cancel_reason)) then
    perform private.refuse('subject_approval_rpc_only', 'An approval keeps its rule, subject and requester, and a cancel is final.');
  end if;
  return new;
end;
$$;

comment on function private.guard_subject_approval() is 'Subject approvals change only inside the approval functions (trusted operation subject_approval): an approval''s subject is the kind its rule gates (a pass, a dock slot or an allocation), it keeps its rule, subject and requester, and a cancel is final (P9, 2863).';
revoke all on function private.guard_subject_approval() from public, anon, authenticated;

drop trigger if exists t90_emit_subject_approval_requested on app.subject_approvals;
create trigger t90_emit_subject_approval_requested after insert on app.subject_approvals
  for each row execute function private.emit_subject_event('subject_approval.requested', 'subject_approvals', 'id',
    'approval_rule_id', 'credential_id', 'dock_slot_id', 'advance_allocation_id');

-- 2. Who it is for, who reads it, who writes its subject ------------------------------------------------------------------------

create or replace function private.subject_approval_beneficiary(p_approval_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(c.holder_person_id,
    case when al.id is not null then coalesce(private.allocation_person(al), e.person_id) end)
  from app.subject_approvals a
  left join app.credentials c on c.id = a.credential_id
  left join app.advance_allocations al on al.id = a.advance_allocation_id
  left join app.engagements e on e.id = al.engagement_id
  where a.id = p_approval_id;
$$;

comment on function private.subject_approval_beneficiary(uuid) is 'Who a subject approval benefits, never an approver of it (approval_subject_beneficiary): the pass holder, or the person an allocation is for (its roster entry''s person, or the engaged person of a pool held by a person engagement). A dock booking, and a pool held by an account, benefit nobody in particular (P9, 2863).';
revoke all on function private.subject_approval_beneficiary(uuid) from public, anon, authenticated;

-- Column values only, so the policy keeps its arguments: with neither a pass nor a dock slot, the subject is an allocation.
create or replace function private.can_read_subject_approval(
  p_org_id uuid,
  p_project_id uuid,
  p_rule_id uuid,
  p_requested_by uuid,
  p_credential_id uuid,
  p_dock_slot_id uuid,
  p_include_vendor boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_person_id() is not null and (
    p_requested_by = private.current_person_id()
    or private.is_approval_rule_approver(p_rule_id)
    or (p_credential_id is not null and private.can_on_project(p_project_id, 'credentials.credential.read'))
    or (p_dock_slot_id is not null and private.can_on_project(p_project_id, 'logistics.shipment.read'))
    or (p_credential_id is null and p_dock_slot_id is null
        and (private.can_on_project(p_project_id, 'assets.asset.read')
             or private.can_on_project(p_project_id, 'advancing.packet.read')))
    or private.can_write_approval_rule(p_org_id, p_project_id)
    or (p_include_vendor and p_dock_slot_id is not null and exists (
      select 1 from app.dock_slots d
      where d.id = p_dock_slot_id and d.engagement_id in (select private.my_engagement_ids('operational')))));
$$;

comment on function private.can_read_subject_approval(uuid, uuid, uuid, uuid, uuid, uuid, boolean) is 'Read rule of subject approvals, from column values (P9): the requester, anyone a step of the rule names, readers of the subject on the project (credentials.credential.read for a pass, logistics.shipment.read for a dock slot, assets.asset.read or advancing.packet.read, the allocation read rule of R7, for an allocation, which is the subject when neither a pass nor a dock slot is set, 2863), rule writers, and, with p_include_vendor, the vendor whose engagement the dock slot serves while its operational area is open. The vendor branch covers the approval row only, never its decisions.';
revoke all on function private.can_read_subject_approval(uuid, uuid, uuid, uuid, uuid, uuid, boolean) from public, anon;
grant execute on function private.can_read_subject_approval(uuid, uuid, uuid, uuid, uuid, uuid, boolean) to authenticated, service_role;

create or replace function private.is_subject_writer(p_approval_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.subject_approvals a
    where a.id = p_approval_id
      and ((a.credential_id is not null and (private.can_on_project(a.project_id, 'credentials.credential.issue')
                                             or private.can_on_project(a.project_id, 'credentials.credential.revoke')))
           or (a.dock_slot_id is not null and private.can_on_project(a.project_id, 'logistics.dock_slot.write'))
           or (a.advance_allocation_id is not null and private.can_on_project(a.project_id, 'advancing.packet.write'))));
$$;

comment on function private.is_subject_writer(uuid) is 'True when the signed-in person writes the approval''s subject on its project: credentials.credential.issue or credentials.credential.revoke for a pass, logistics.dock_slot.write for a dock slot, advancing.packet.write (R7''s request and withdraw capability) for an allocation (P9, 2863).';
revoke all on function private.is_subject_writer(uuid) from public, anon, authenticated;

create or replace function private.subject_approval_title(p_approval_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when a.credential_id is not null then
      (select format('Pass %s for %s', c.credential_number, p.full_name)
       from app.credentials c join app.people p on p.id = c.holder_person_id where c.id = a.credential_id)
    when a.dock_slot_id is not null then
      (select format('Dock slot %s %s', z.name, to_char(d.starts_at at time zone coalesce(pr.time_zone, 'UTC'), 'YYYY-MM-DD HH24:MI'))
       from app.dock_slots d join app.zones z on z.id = d.zone_id join app.projects pr on pr.id = d.project_id
       where d.id = a.dock_slot_id)
    when a.advance_allocation_id is not null then
      (select format('%s x%s', k.name, trim_scale(al.quantity))
       from app.advance_allocations al join app.asset_classes k on k.id = al.asset_class_id
       where al.id = a.advance_allocation_id)
  end
  from app.subject_approvals a where a.id = p_approval_id;
$$;

comment on function private.subject_approval_title(uuid) is 'What a subject approval is about, for its notices: "Pass CR-000123 for Jane Doe", "Dock slot Dock A 2027-06-14 14:00" in the project''s time zone, or "Radios x4" for an allocation (P9, 2863). A pass''s title names its holder, so the signed-out link page shows titles only after the access code (2861).';
revoke all on function private.subject_approval_title(uuid) from public, anon, authenticated;

create or replace function private.reminder_subject_live(p_subject_table text, p_subject_id uuid, p_now timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_subject_table <> 'subject_approvals' then true
    else exists (
      select 1 from app.subject_approvals a
      left join app.credentials c on c.id = a.credential_id
      left join app.dock_slots d on d.id = a.dock_slot_id
      left join app.advance_allocations al on al.id = a.advance_allocation_id
      where a.id = p_subject_id
        and (a.credential_id is null or (c.revoked_at is null and c.deleted_at is null))
        and (a.dock_slot_id is null or (d.deleted_at is null and d.ends_at > p_now))
        and (a.advance_allocation_id is null or (al.deleted_at is null and al.allocation_state = 'Requested')))
  end;
$$;

comment on function private.reminder_subject_live(text, uuid, timestamptz) is 'False for a subject approval whose pass is revoked or deleted, whose dock slot is deleted or has ended, or whose allocation is deleted or no longer Requested (Withdrawn, Declined, or approved by a reviewer), so nobody is reminded about it (P9, 2863). True for every other approval.';
revoke all on function private.reminder_subject_live(text, uuid, timestamptz) from public, anon, authenticated;

-- 3. The computed status names the allocation ------------------------------------------------------------------------------------

create or replace view app.subject_approval_status with (security_invoker = true) as
select a.id, a.org_id, a.project_id, a.approval_rule_id, p.rule_name, p.subject, a.credential_id, a.dock_slot_id,
  a.requested_by, a.created_at, p.approval_state, p.current_step, p.current_step_name, p.current_step_has_approver,
  p.step_count, p.waiting_since, a.canceled_at, a.cancel_reason,
  coalesce(v.viewer_may_decide, false) as viewer_may_decide, v.approver_names as current_step_approver_names,
  a.advance_allocation_id
from app.subject_approvals a
cross join lateral private.subject_approval_progress(a.id, a.approval_rule_id, a.canceled_at, a.created_at) p
left join lateral private.subject_step_for_viewer(a.id) v on p.approval_state = 'In Review'
where a.deleted_at is null;

comment on view app.subject_approval_status is 'Every subject approval the signed-in person may read, with its computed state (ADR 0103, P9): In Review at its current step, Approved, Rejected or Canceled. Read with the person''s own row level security on app.subject_approvals.';
comment on column app.subject_approval_status.advance_allocation_id is 'Equipment request (an asset allocation, R7) awaiting approval (2863).';
revoke all on app.subject_approval_status from public, anon;
grant select on app.subject_approval_status to authenticated, service_role;
revoke select on app.subject_approval_status from xos_backup;

-- 4. Opening -----------------------------------------------------------------------------------------------------------------------

create or replace function private.open_subject_approval(
  p_rule_id uuid,
  p_credential_id uuid,
  p_dock_slot_id uuid,
  p_advance_allocation_id uuid,
  p_requested_by uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.begin_trusted_operation('subject_approval');
  insert into app.subject_approvals (approval_rule_id, credential_id, dock_slot_id, advance_allocation_id, requested_by)
  values (p_rule_id, p_credential_id, p_dock_slot_id, p_advance_allocation_id, p_requested_by)
  returning id into v_id;
  perform private.end_trusted_operation('subject_approval');
  perform private.notify_subject_step_approvers(v_id);
  return v_id;
end;
$$;

comment on function private.open_subject_approval(uuid, uuid, uuid, uuid, uuid) is 'Opens the approval of a subject row its rule matched (a pass, a dock slot or an allocation) and asks the first step''s approvers (P9, 2863). The project is stamped from the subject. Returns the approval id.';
revoke all on function private.open_subject_approval(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- 2860's four-argument form stays for the pass and dock slot triggers.
create or replace function private.open_subject_approval(p_rule_id uuid, p_credential_id uuid, p_dock_slot_id uuid, p_requested_by uuid)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select private.open_subject_approval(p_rule_id, p_credential_id, p_dock_slot_id, null::uuid, p_requested_by);
$$;

comment on function private.open_subject_approval(uuid, uuid, uuid, uuid) is 'Opens the approval of a pass or a dock slot its rule matched (P9), through the five-argument form of 2863. Returns the approval id.';
revoke all on function private.open_subject_approval(uuid, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function private.open_equipment_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule uuid;
begin
  if new.asset_class_id is null or new.origin <> 'Requested' or new.allocation_state <> 'Requested' or new.deleted_at is not null
     or not exists (select 1 from app.asset_classes c where c.id = new.asset_class_id and c.offering is not null) then
    return null;
  end if;
  v_rule := private.match_approval_rule(new.project_id, 'Equipment', new.asset_class_id);
  if v_rule is not null then
    perform private.open_subject_approval(v_rule, null, null, new.id, private.allocation_requester(new.id));
  end if;
  return null;
end;
$$;

comment on function private.open_equipment_approval() is 'A request for an asset allocation of a class that carries an offering (Radios or Carts, R7) on a project with a matching Active Equipment rule opens its approval (P9, 2863): the most specific rule for its class. The requester is private.allocation_requester (R7, as R10 extends it), never created_by. An allocation a reviewer assigns, or a share split from an approved pool, opens none: a reviewer already decided it.';
revoke all on function private.open_equipment_approval() from public, anon, authenticated;

create trigger t91_open_equipment_approval after insert on app.advance_allocations
  for each row execute function private.open_equipment_approval();

-- 5. The gate on approving an allocation (from R7's 2693) ---------------------------------------------------------------------

create or replace function private.allocation_approval_pending(p_allocation_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select format('%s is %s; approve the allocation once every step of it is approved.', r.name,
    case when p.approval_state = 'In Review' then format('waiting on %s', p.current_step_name) else lower(p.approval_state::text) end)
  from app.subject_approvals a
  join app.approval_rules r on r.id = a.approval_rule_id
  cross join lateral private.subject_approval_progress(a.id, a.approval_rule_id, a.canceled_at, a.created_at) p
  where a.advance_allocation_id = p_allocation_id and a.canceled_at is null and a.deleted_at is null
    and p.approval_state <> 'Approved'
  limit 1;
$$;

comment on function private.allocation_approval_pending(uuid) is 'The refusal sentence of approval_rule_pending when an allocation''s live approval is not Approved (In Review at a named step, or Rejected), naming the rule; NULL when no approval holds the allocation (P9, 2863). A canceled approval does not hold it.';
revoke all on function private.allocation_approval_pending(uuid) from public, anon, authenticated;

create or replace function app.decide_allocation(p_allocation_id uuid, p_decision app.approval_decision, p_reason text default null,
  p_sources jsonb default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_allocation app.advance_allocations;
  v_beyond numeric;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_pending text;
begin
  select a.* into v_allocation from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null for update;
  if v_allocation.id is null or not private.can_on_project(v_allocation.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'advancing.submission.review is required';
  end if;
  if v_allocation.allocation_state <> 'Requested' then
    perform private.refuse('allocation_state_conflict', format('The allocation is %s already.', v_allocation.allocation_state));
  end if;
  perform private.assert_separation('sod_allocation_requester', v_me, private.allocation_requester(v_allocation.id));

  if p_decision = 'Rejected' then
    if v_reason is null or char_length(v_reason) > 1000 then
      perform private.refuse('allocation_reason_required', 'Say why the allocation is declined, in 1 to 1000 characters.');
    end if;
    perform private.transition_lifecycle('advance_allocation', 'app.advance_allocations', 'allocation_state',
      'app.advance_allocation_state_transitions', 'advance_allocation_id', v_allocation.id, 'Requested', 'Declined', v_reason);
    perform private.notify_allocation(v_allocation.id, 'allocation.decided',
      array[private.allocation_requester(v_allocation.id), private.allocation_person(v_allocation)],
      jsonb_build_object('decision', 'declined', 'reason', v_reason));
    return true;
  end if;

  -- P9: an Equipment rule's approval holds the allocation until every step approves it. R9's answer review leaves it
  -- Requested for the Allocations queue instead of rolling the review back.
  v_pending := private.allocation_approval_pending(v_allocation.id);
  if v_pending is not null then
    if private.in_trusted_operation('advance_answer_review') then
      return false;
    end if;
    perform private.refuse('approval_rule_pending', v_pending);
  end if;

  perform private.assert_allocation_holder(v_allocation.project_id, v_allocation.engagement_id, v_allocation.roster_entry_id, 'approve');
  v_beyond := private.check_allocation_caps(v_allocation, 'approve', v_reason);
  perform private.transition_lifecycle('advance_allocation', 'app.advance_allocations', 'allocation_state',
    'app.advance_allocation_state_transitions', 'advance_allocation_id', v_allocation.id, 'Requested', 'Approved',
    coalesce(v_reason, 'Approved.'));
  select a.* into v_allocation from app.advance_allocations a where a.id = v_allocation.id;
  perform private.reserve_allocation(v_allocation, p_sources);
  perform private.notify_allocation(v_allocation.id, 'allocation.decided',
    array[private.allocation_requester(v_allocation.id), private.allocation_person(v_allocation)],
    jsonb_build_object('decision', 'approved'));
  return true;
end;
$$;
comment on function app.decide_allocation(uuid, app.approval_decision, text, jsonb) is 'A reviewer (advancing.submission.review) decides a Requested allocation with compare-and-set (allocation_state_conflict), never its requester (sod_allocation_requester, private.allocation_requester). Rejected needs a reason of 1 to 1000 characters (allocation_reason_required) and moves to Declined with it in the ledger. Approved waits on an Equipment rule''s approval (approval_rule_pending until it is Approved, P9 2863; inside R9''s answer review it returns false and the allocation stays Requested), then checks the holder again (an entry accepted by both sides), the offering and caps (above the cap with allowance overflow at review it needs a reason, allocation_over_allowance_reason, that goes in the ledger), moves to Approved and reserves an asset allocation from p_sources (allocation_sources_required, reservation_over_capacity, raised for R9 to catch per allocation). Sends allocation.decided to the requester and the person. Returns true, or false when R9''s review left it for the queue.';
revoke all on function app.decide_allocation(uuid, app.approval_decision, text, jsonb) from public, anon;
grant execute on function app.decide_allocation(uuid, app.approval_decision, text, jsonb) to authenticated, service_role;

-- 6. A rejected step declines the allocation ------------------------------------------------------------------------------------

create or replace function private.decline_rejected_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
  v_step text;
  v_reason text;
begin
  select al.* into v_allocation from app.subject_approvals a
  join app.advance_allocations al on al.id = a.advance_allocation_id
  where a.id = new.subject_approval_id and al.deleted_at is null
  for update of al;
  if v_allocation.id is null or v_allocation.allocation_state <> 'Requested' then
    return null;
  end if;
  select s.name into v_step from app.subject_approvals a
  join app.approval_rule_steps s on s.approval_rule_id = a.approval_rule_id and s.step_order = new.step_order and s.deleted_at is null
  where a.id = new.subject_approval_id;
  v_reason := left(format('Rejected at %s: %s', coalesce(v_step, new.step_order::text), btrim(new.comment)), 1000);
  perform private.begin_trusted_operation('subject_approval_decline');
  perform private.transition_lifecycle('advance_allocation', 'app.advance_allocations', 'allocation_state',
    'app.advance_allocation_state_transitions', 'advance_allocation_id', v_allocation.id, 'Requested', 'Declined', v_reason);
  perform private.end_trusted_operation('subject_approval_decline');
  perform private.notify_allocation(v_allocation.id, 'allocation.decided',
    array[private.allocation_requester(v_allocation.id), private.allocation_person(v_allocation)],
    jsonb_build_object('decision', 'declined', 'reason', v_reason));
  return null;
end;
$$;

comment on function private.decline_rejected_allocation() is 'When a step of an Equipment approval is rejected, its Requested allocation is declined inside the trusted operation subject_approval_decline with the reason "Rejected at {step}: {comment}" in the ledger, and the requester and the person hear allocation.decided (P9, 2863). The approver need not hold advancing.submission.review: the rule named them.';
revoke all on function private.decline_rejected_allocation() from public, anon, authenticated;

create trigger t91_decline_rejected_allocation after insert on app.subject_approval_decisions
  for each row when (not new.approved)
  execute function private.decline_rejected_allocation();

-- 7. A withdrawn, declined or deleted allocation withdraws its approval ----------------------------------------------------------

create or replace function private.cancel_equipment_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval uuid;
  v_reason text;
begin
  v_reason := case
    when new.deleted_at is not null and old.deleted_at is null then 'The equipment request was deleted.'
    when new.allocation_state = 'Withdrawn' and old.allocation_state <> 'Withdrawn' then 'The equipment request was withdrawn.'
    when new.allocation_state = 'Declined' and old.allocation_state <> 'Declined' then 'The equipment request was declined.'
  end;
  select a.id into v_approval from app.subject_approvals a
  where a.advance_allocation_id = new.id and a.canceled_at is null and a.deleted_at is null;
  -- Only an approval in review is withdrawn: a rejected step's decline keeps the approval Rejected, and a decided one stays.
  if v_reason is not null and v_approval is not null and private.subject_approval_state(v_approval) = 'In Review' then
    perform private.cancel_subject_approval_row(v_approval, private.current_person_id(), v_reason);
  end if;
  return null;
end;
$$;

comment on function private.cancel_equipment_approval() is 'Withdrawing, declining or deleting an allocation withdraws its approval while it is In Review, with the reason, and retires its requests, reminders and links (P9, 2863). A Rejected or Approved approval is left as decided.';
revoke all on function private.cancel_equipment_approval() from public, anon, authenticated;

create trigger t91_cancel_equipment_approval after update of allocation_state, deleted_at on app.advance_allocations
  for each row when (new.allocation_state is distinct from old.allocation_state
                     or (old.deleted_at is null and new.deleted_at is not null))
  execute function private.cancel_equipment_approval();

-- 8. Equipment rules may be activated (from 2860) ----------------------------------------------------------------------------------

create or replace function app.transition_approval_rule(
  p_approval_rule_id uuid,
  p_expected app.approval_policy_state,
  p_next app.approval_policy_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rule app.approval_rules;
  v_step record;
begin
  perform private.require_person();
  select * into v_rule from app.approval_rules r where r.id = p_approval_rule_id and r.deleted_at is null for update;
  if v_rule.id is null or not private.can_write_approval_rule(v_rule.org_id, v_rule.project_id) then
    raise exception using errcode = '42501', message = 'projects.settings.write or org.approval_policies.write is required';
  end if;
  if p_next = 'Active' then
    if not exists (select 1 from app.approval_rule_steps s where s.approval_rule_id = v_rule.id and s.deleted_at is null) then
      perform private.refuse('approval_rule_no_steps', format('Add at least one step to %s before activating it.', v_rule.name));
    end if;
    for v_step in
      select s.id, s.name from app.approval_rule_steps s
      where s.approval_rule_id = v_rule.id and s.deleted_at is null and s.approver_engagement_id is not null
      order by s.step_order
    loop
      if not private.approval_step_reachable(v_step.id) then
        perform private.refuse('approval_step_no_approver',
          format('Nobody the step %s names has an XOS account to receive approval emails. Invite them to Gateway first, or name another approver.', v_step.name));
      end if;
    end loop;
  end if;
  return private.transition_lifecycle('approval_rule', 'app.approval_rules', 'rule_state',
    'app.approval_rule_state_transitions', 'approval_rule_id', p_approval_rule_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_approval_rule(uuid, app.approval_policy_state, app.approval_policy_state, text) is 'Activates or retires an approval rule with compare-and-set (projects.settings.write on its project or org.approval_policies.write, P9). Activation needs at least one step (approval_rule_no_steps), and every engagement step must name someone with an XOS account (approval_step_no_approver). Equipment rules gate radio and cart requests from advances (2863). A second Active rule of the same project, subject and filter is refused by approval_rules_one_active. Returns the ledger entry id.';
revoke all on function app.transition_approval_rule(uuid, app.approval_policy_state, app.approval_policy_state, text) from public, anon;
grant execute on function app.transition_approval_rule(uuid, app.approval_policy_state, app.approval_policy_state, text) to authenticated, service_role;

-- 9. Who a person works with as an external party (2200 and 2641 together) -----------------------------------------------------

create or replace function private.party_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.org_id from app.engagements e
  where e.person_id = p_person_id and e.deleted_at is null
  union
  select c.org_id from app.counterparties c
  join app.account_memberships m on m.org_id = c.organization_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where c.deleted_at is null
  union
  select a.org_id from app.applications a
  join app.offers o on o.application_id = a.id and o.deleted_at is null and o.offer_state in ('Sent', 'Countered')
  where a.applicant_person_id = p_person_id and a.deleted_at is null
  union
  select r.org_id from app.engagement_roster_entries r
  where r.person_id = p_person_id and r.deleted_at is null and r.entry_state <> 'Withdrawn';
$$;

comment on function private.party_org_ids(uuid) is 'Orgs a person works with as an external party: through an engagement of their own, an active membership in an external account the org holds as a counterparty, an application of their own with an offer still open (A127), so the offer''s notices reach them, or a live roster entry on one of the org''s engagements (R4).';
revoke all on function private.party_org_ids(uuid) from public, anon, authenticated;

-- 10. Trash ---------------------------------------------------------------------------------------------------------------------------

-- subject_approvals keeps 2860's Trash exclusion: an approval is withdrawn by Cancel, with its reason, and is never restored.
select private.sync_trash_tables();
