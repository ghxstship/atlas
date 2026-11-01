-- 2211_role_lens_inbox.sql
-- A128 (RRR-173, S4.8.1-06, ADR 0107): what the role lens needs to keep each Inbox item under the role that brought
-- it, as each sender picks its recipients.
--   * app.inbox_items names the approver of the step an approval request waits on: the role it names
--     (approver_role_id) or the one member (approver_membership_id), as private.step_approver_person_ids (1395)
--     picks them. A step naming a role the person holds shows under that role's lens; a step naming a member, or one
--     that reaches the person as an away approver's delegate, is addressed to them and shows under every lens.
--   * app.role_lens_personal_capabilities lists, per org, the capabilities the signed-in person holds through no
--     role: a direct grant, an org-level record grant, a delegation or their own break-glass session (the other
--     sources of private.person_capability_reach, 1563). A notice its sender picks by such a capability is
--     addressed to the person and shows under every lens.
--
-- The view is app.inbox_items of 1064 with the two step columns added at the end; its comment, column comments and
-- privileges are restated, and the read-only backup login (1650) reads no view.

create or replace view app.inbox_items with (security_invoker = true) as
select n.id, n.org_id, n.created_at, n.kind, n.actor_person_id, n.subject_table, n.subject_id, n.project_id,
  n.message_args, n.read_at,
  case when n.kind in ('approval.requested', 'mention.created', 'assignment.created') then 'Needs You' else 'For Your Information' end as section,
  a.document_type, a.subject_reference, a.amount_minor, a.currency_code, a.approval_state, a.current_step, a.approval_policy_id,
  st.approver_role_id, st.approver_membership_id
from app.notifications n
left join app.approval_instances a on n.subject_table = 'approval_instances' and a.id = n.subject_id and a.deleted_at is null
left join app.approval_steps st on st.approval_policy_id = a.approval_policy_id and st.step_order = a.current_step and st.deleted_at is null
where n.archived_at is null and n.deleted_at is null
  and not exists (select 1 from app.inbox_snoozes s where s.notification_id = n.id and s.deleted_at is null and s.snoozed_until > now());

call private.describe('app.inbox_items', 'The signed-in person''s Inbox (Section 11.10 rule 5): live notifications that are not Done or snoozed, sorted into Needs You (approvals, mentions, assignments) and For Your Information, with the approval an approval request is about and the approver of the step it waits on (2211, for the role lens). Read with the person''s own row level security.', array[
  'id', 'Notification id.',
  'org_id', 'Org of the notification.',
  'created_at', 'When it arrived.',
  'kind', 'Notification kind.',
  'actor_person_id', 'Person whose action caused it.',
  'subject_table', 'Table of the record it is about.',
  'subject_id', 'Record it is about.',
  'project_id', 'Project of the record.',
  'message_args', 'Catalog message arguments.',
  'read_at', 'When the person read it.',
  'section', 'Needs You or For Your Information.',
  'document_type', 'For an approval request: the spend document type.',
  'subject_reference', 'For an approval request: the document''s number or name.',
  'amount_minor', 'For an approval request: the amount in minor units.',
  'currency_code', 'For an approval request: the currency.',
  'approval_state', 'For an approval request: its state now.',
  'current_step', 'For an approval request: the step it waits on.',
  'approval_policy_id', 'For an approval request: its policy.',
  'approver_role_id', 'For an approval request: the role whose holders approve the step it waits on, when the step names a role.',
  'approver_membership_id', 'For an approval request: the one member who approves the step it waits on, when the step names a member.'
]);

revoke all on app.inbox_items from public, anon;
revoke select on app.inbox_items from xos_backup;
grant select on app.inbox_items to authenticated, service_role;

create or replace function app.role_lens_personal_capabilities()
returns table (org_id uuid, capability_code text)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select m.id, m.org_id from app.memberships m
    where m.person_id = private.current_person_id() and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  ),
  personal as (
    select mine.org_id, g.capability_code
    from mine join app.user_capability_grants g on g.membership_id = mine.id
    where g.scope_id is null and g.deleted_at is null and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
    union
    select rg.org_id, rg.capability_code
    from app.record_grants rg
    where rg.org_id in (select mine.org_id from mine) and rg.target_kind = 'organization' and rg.target_id = rg.org_id
      and rg.deleted_at is null and rg.valid_from <= now() and rg.valid_to > now()
      and (rg.grantee_person_id = private.current_person_id()
           or rg.grantee_org_id in (select private.person_org_ids(private.current_person_id())))
    union
    -- A delegation of one capability, or of every approve-class one (a null capability_code), that the delegator holds.
    select d.org_id, c.code
    from mine
    join app.delegations d on d.delegate_membership_id = mine.id and d.org_id = mine.org_id
    join app.memberships dm on dm.id = d.delegator_membership_id
      and dm.deleted_at is null and dm.valid_from <= now() and (dm.valid_to is null or dm.valid_to > now())
    join app.capabilities c on c.code = d.capability_code or (d.capability_code is null and c.capability_class = 'approve')
    where d.deleted_at is null and d.valid_from <= now() and d.valid_to > now()
      and private.person_capability_reach(dm.person_id, d.org_id, c.code, false) is not null
    union
    -- The person's own open break-glass session reaches the Owner role's capabilities org-wide (1203, 1298).
    select b.org_id, rc.capability_code
    from mine
    join app.break_glass_sessions b on b.org_id = mine.org_id and b.person_id = private.current_person_id()
    join app.role_capabilities rc on rc.role_id = private.system_role_id('owner') and rc.reach = 'organization'
      and rc.deleted_at is null
    where b.deleted_at is null and b.started_at <= now() and b.expires_at > now() and b.ended_at is null
  )
  -- Only what the session reaches (an API key or an app reaches less), so it is never wider than the person's own.
  select distinct p.org_id, p.capability_code from personal p
  where private.person_capability_reach(private.current_person_id(), p.org_id, p.capability_code, true) is not null
  order by p.org_id, p.capability_code;
$$;

comment on function app.role_lens_personal_capabilities() is 'For the role lens (Section 4.8.1, ADR 0107): per org, the capabilities the signed-in person holds through no role, from a direct org-wide grant, an org-level record grant, a delegation or their own break-glass session. A notice its sender picks by one of them is addressed to the person, so it shows under every lens. Only capabilities the session reaches are listed.';
revoke all on function app.role_lens_personal_capabilities() from public, anon;
grant execute on function app.role_lens_personal_capabilities() to authenticated, service_role;
