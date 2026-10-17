-- 1064_inbox.sql
-- A36 Inbox (Section 4.5.2, Section 11.10 rule 5): one inbox model on A18's notifications (0520) and A33's
-- approvals (1030).
--   * inbox_snoozes: a person snoozes a notification (H) until a time; it leaves the Inbox until then
--   * app.inbox_items: the person's live notifications sorted into Needs You and For Your Information, with
--     the approval each approval request is about, read with the person's own row level security
--   * app.act_on_notification: act where the notification arrives, without opening the record: approve or
--     reject the approval it asks for (the Inbox A and R keys, and the push notification's action buttons,
--     which call the same operation through the API), or mark it Done (E)

create table app.inbox_snoozes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  notification_id uuid not null,
  notification_created_at timestamptz not null,
  snoozed_until timestamptz not null,
  foreign key (notification_id, notification_created_at) references app.notifications (id, created_at)
);

call private.install_domain_table('app.inbox_snoozes');
create unique index inbox_snoozes_one_per_notification on app.inbox_snoozes (notification_id) where deleted_at is null;
create index inbox_snoozes_notification_idx on app.inbox_snoozes (notification_id, notification_created_at);
create index inbox_snoozes_person_idx on app.inbox_snoozes (person_id, snoozed_until);

call private.describe('app.inbox_snoozes', 'A notification the recipient snoozed (Section 11.10 rule 5, the H key): it leaves the Inbox until snoozed_until, then returns. Only the recipient reads or writes it.', array[
  'person_id', 'Recipient who snoozed it; always the signed-in person.',
  'notification_id', 'Notification snoozed.',
  'notification_created_at', 'Creation time of the notification, its partition key.',
  'snoozed_until', 'When it comes back to the Inbox, at most 30 days ahead.'
]);

create or replace function private.guard_inbox_snooze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note app.notifications;
begin
  select * into v_note from app.notifications n
  where n.id = new.notification_id and n.created_at = new.notification_created_at;
  if v_note.id is null or v_note.recipient_person_id <> private.current_person_id() then
    raise exception using errcode = '42501', message = 'notification not found';
  end if;
  new.person_id := v_note.recipient_person_id;
  new.org_id := v_note.org_id;
  if new.snoozed_until <= now() or new.snoozed_until > now() + interval '30 days' then
    perform private.refuse('inbox_snooze_window', 'Snooze a notification for up to 30 days.');
  end if;
  return new;
end;
$$;

comment on function private.guard_inbox_snooze() is 'Snoozes: only the recipient snoozes their own notification, for up to 30 days; the person and org come from the notification.';
revoke all on function private.guard_inbox_snooze() from public, anon, authenticated;

create trigger t05_guard_inbox_snooze before insert or update on app.inbox_snoozes
  for each row execute function private.guard_inbox_snooze();

call private.install_policies('app.inbox_snoozes',
  $$person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$,
  $$person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$);

create view app.inbox_items with (security_invoker = true) as
select n.id, n.org_id, n.created_at, n.kind, n.actor_person_id, n.subject_table, n.subject_id, n.project_id,
  n.message_args, n.read_at,
  case when n.kind in ('approval.requested', 'mention.created', 'assignment.created') then 'Needs You' else 'For Your Information' end as section,
  a.document_type, a.subject_reference, a.amount_minor, a.currency_code, a.approval_state, a.current_step, a.approval_policy_id
from app.notifications n
left join app.approval_instances a on n.subject_table = 'approval_instances' and a.id = n.subject_id and a.deleted_at is null
where n.archived_at is null and n.deleted_at is null
  and not exists (select 1 from app.inbox_snoozes s where s.notification_id = n.id and s.deleted_at is null and s.snoozed_until > now());

call private.describe('app.inbox_items', 'The signed-in person''s Inbox (Section 11.10 rule 5): live notifications that are not Done or snoozed, sorted into Needs You (approvals, mentions, assignments) and For Your Information, with the approval an approval request is about. Read with the person''s own row level security.', array[
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
  'approval_policy_id', 'For an approval request: its policy.'
]);

revoke all on app.inbox_items from public, anon;
grant select on app.inbox_items to authenticated, service_role;

create or replace function app.act_on_notification(p_notification_id uuid, p_action text, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_note app.notifications;
begin
  select * into v_note from app.notifications n
  where n.id = p_notification_id and n.recipient_person_id = v_person
    and n.org_id in (select private.my_org_ids()) and n.deleted_at is null;
  if v_note.id is null then
    raise exception using errcode = '42501', message = 'notification not found';
  end if;
  if p_action not in ('approve', 'reject', 'done') or p_action is null then
    perform private.refuse('inbox_action_unknown', 'An Inbox item is approved, rejected or marked Done.');
  end if;
  if p_action in ('approve', 'reject') then
    if v_note.kind <> 'approval.requested' or v_note.subject_table <> 'approval_instances' then
      perform private.refuse('inbox_action_not_offered', 'Only an approval request is approved or rejected from the Inbox.');
    end if;
    perform app.decide_approval(v_note.subject_id, p_action = 'approve', p_comment);
  end if;
  update app.notifications set read_at = coalesce(read_at, now()), archived_at = now()
  where id = v_note.id and created_at = v_note.created_at;
  return v_note.id;
end;
$$;

comment on function app.act_on_notification(uuid, text, text) is 'Acts on a notification where it arrives (Section 11.10 rule 5), for its recipient only: approve or reject the approval an approval request asks for (app.decide_approval decides every rule, so a refusal names it and the item stays), or mark it Done. A decided or Done item leaves the Inbox. Push notification actions call it through the API. Returns the notification id.';
revoke all on function app.act_on_notification(uuid, text, text) from public, anon;
grant execute on function app.act_on_notification(uuid, text, text) to authenticated, service_role;

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.inbox_snoozes', 'Age', 'created_at', interval '18 months', 'Delete', 'Kept no longer than the notifications they snooze.');
