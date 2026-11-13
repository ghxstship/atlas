-- 4.11 fix (crawl 4.9): a crisis alert in force sits in the Inbox's Needs You. app.inbox_items put every kind but
-- approvals, mentions and assignments under For Your Information, so a Code Red landed there beside routine notices,
-- the Inbox's count (Needs You) read 0, and Atlas, Compass and Gateway styled it as any other row.
--
-- crisis_alert.issued is now Needs You until the all-clear: while no crisis_alert.ended about the same alert has reached
-- the same person (6800 sends the all-clear to everyone it told). The test reads only the person's own notifications,
-- under their own row level security, as the view always has (security_invoker), so it holds for crew who may not read
-- the alert's row. The all-clear itself, and a past alert, stay For Your Information.
--
-- Definition from 5861 (the latest), with its description, comments and grants restated.

create or replace view app.inbox_items with (security_invoker = true) as
select n.id, n.org_id, n.created_at, n.kind, n.actor_person_id, n.subject_table, n.subject_id, n.project_id,
  n.message_args, n.read_at,
  case
    when n.kind in ('approval.requested', 'approval.reminder', 'mention.created', 'assignment.created') then 'Needs You'
    when n.kind = 'crisis_alert.issued' and not exists (
      select 1 from app.notifications e
      where e.subject_id = n.subject_id and e.recipient_person_id = n.recipient_person_id
        and e.kind = 'crisis_alert.ended' and e.subject_table = 'app.crisis_alerts' and e.deleted_at is null) then 'Needs You'
    else 'For Your Information'
  end as section,
  a.document_type, a.subject_reference, a.amount_minor, a.currency_code, a.approval_state, a.current_step, a.approval_policy_id,
  st.approver_role_id, st.approver_membership_id,
  sa.approval_state as subject_approval_state, sa.subject as subject_approval_subject, sa.current_step as subject_approval_current_step
from app.notifications n
left join app.approval_instances a on n.subject_table = 'approval_instances' and a.id = n.subject_id and a.deleted_at is null
left join app.approval_steps st on st.approval_policy_id = a.approval_policy_id and st.step_order = a.current_step and st.deleted_at is null
left join app.subject_approval_status sa on n.subject_table = 'subject_approvals' and sa.id = n.subject_id
where n.archived_at is null and n.deleted_at is null and n.kind <> 'approval.link_code'
  and not exists (select 1 from app.inbox_snoozes s where s.notification_id = n.id and s.deleted_at is null and s.snoozed_until > now());

call private.describe('app.inbox_items', 'The signed-in person''s Inbox (Section 11.10 rule 5): live notifications that are not Done or snoozed, sorted into Needs You (approval requests and reminders, mentions, assignments, and a crisis alert until its all-clear reaches the person) and For Your Information, with the approval an approval request is about: a spend approval''s document and the approver of the step it waits on (3211, for the role lens), or a pass, dock booking or equipment approval''s computed state (P9). Access-code emails of signed-out approval links never show. Read with the person''s own row level security.', array[
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
  'section', 'Needs You or For Your Information. A crisis alert is Needs You until its all-clear reaches the person.',
  'document_type', 'For an approval request: the spend document type.',
  'subject_reference', 'For an approval request: the document''s number or name.',
  'amount_minor', 'For an approval request: the amount in minor units.',
  'currency_code', 'For an approval request: the currency.',
  'approval_state', 'For an approval request: its state now.',
  'current_step', 'For an approval request: the step it waits on.',
  'approval_policy_id', 'For an approval request: its policy.',
  'approver_role_id', 'For an approval request: the role whose holders approve the step it waits on, when the step names a role.',
  'approver_membership_id', 'For an approval request: the one member who approves the step it waits on, when the step names a member.',
  'subject_approval_state', 'For a request or reminder about a pass, dock booking or equipment approval: its computed state now (P9).',
  'subject_approval_subject', 'For such a request: Pass, Delivery or Equipment.',
  'subject_approval_current_step', 'For such a request: the step it waits on while In Review.'
]);

revoke all on app.inbox_items from public, anon;
grant select on app.inbox_items to authenticated, service_role;
revoke select on app.inbox_items from xos_backup;
