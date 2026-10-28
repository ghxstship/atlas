-- 2370_export_scoped_views.sql
--
-- Collections that export the rows their page shows (A102, RRR-146; Section 4.6.4). Three Atlas collections exported
-- more than the page showed, because the table each read had no column to narrow it by:
--
--   * My Work exported app.record_assignments, every assignment the reader could read in the org (for an Owner, all of
--     them), while the page shows the reader's own open records. app.my_work_export is that list, keyed on the reader:
--     the open records they own, are accountable for or are assigned to through one of their memberships, filtered as
--     @xos/data listMyWork filters them.
--   * A project's Activity and Overview exported the org's whole feed: app.activity_events has no project. The page
--     reads app.activity_feed with the project, which compares the domain event's project. app.activity_export adds
--     that project to each activity row.
--   * A project's Procurement receipts exported the org's goods receipts: app.goods_receipts has no project either.
--     app.goods_receipt_export adds the project of the receipt's purchase order.
--
-- Each view runs as its reader (security_invoker), so the row level security of the tables it reads still decides
-- which rows appear. The domain events table is readable only by webhook managers, so an activity row's project comes
-- from private.domain_event_project_id, which answers only for events of the reader's orgs. As every new view, each
-- takes back the backup login's default SELECT (1650).

create or replace function private.domain_event_project_id(p_domain_event_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.project_id from app.domain_events e
  where e.id = p_domain_event_id and e.org_id in (select private.my_org_ids());
$$;

comment on function private.domain_event_project_id(uuid) is 'Project of a domain event of one of the signed-in person''s orgs, or null for an org-level event or another org''s. Lets app.activity_export show an activity row''s project to readers who cannot read app.domain_events (ADR 0016 rule 14: takes the id as an argument).';
revoke all on function private.domain_event_project_id(uuid) from public, anon;
grant execute on function private.domain_event_project_id(uuid) to authenticated, service_role;

-- Activity with its project ----------------------------------------------------------------------------------------

create view app.activity_export with (security_invoker = on) as
select a.id, a.org_id, private.domain_event_project_id(a.domain_event_id) as project_id,
  a.created_at, a.actor_person_id, a.domain_event_id
from app.activity_events a;

call private.describe('app.activity_export', 'The activity feed with the project of each entry''s domain event (Section 4.2 Activity, 4.6.4): what a project''s Activity and Overview export, scoped to the project as the page is. Runs as the reader, so app.activity_events'' row level security applies.', array[
  'id', 'Activity id.',
  'org_id', 'Org.',
  'project_id', 'Project of the activity''s domain event, or null for an org-level event.',
  'created_at', 'When the activity was recorded.',
  'actor_person_id', 'Person whose action raised the event, or null for services and scheduled jobs.',
  'domain_event_id', 'Domain event the activity shows.'
]);
revoke all on app.activity_export from public, anon;
grant select on app.activity_export to authenticated, service_role;
revoke select on app.activity_export from xos_backup;

-- Goods receipts with their project --------------------------------------------------------------------------------

create view app.goods_receipt_export with (security_invoker = on) as
select g.id, g.org_id, po.project_id, g.purchase_order_id, g.received_at, g.received_by, g.note
from app.goods_receipts g
join app.purchase_orders po on po.id = g.purchase_order_id
where g.deleted_at is null;

call private.describe('app.goods_receipt_export', 'Goods receipts with the project of their purchase order (Section 4.6.4): what Procurement''s receipts export, on a project tab scoped to the project. Runs as the reader, so the row level security of goods receipts and purchase orders applies.', array[
  'id', 'Goods receipt.',
  'org_id', 'Org.',
  'project_id', 'Project of the receipt''s purchase order.',
  'purchase_order_id', 'Purchase order received against.',
  'received_at', 'When the goods were received.',
  'received_by', 'Person who received them.',
  'note', 'Note on the receipt.'
]);
revoke all on app.goods_receipt_export from public, anon;
grant select on app.goods_receipt_export to authenticated, service_role;
revoke select on app.goods_receipt_export from xos_backup;

-- My Work ----------------------------------------------------------------------------------------------------------

create view app.my_work_export with (security_invoker = on) as
select r.id, r.org_id, r.project_id, r.record_number, r.title, r.record_kind, r.record_state,
  r.due_at, r.starts_at, r.ends_at, r.updated_at
from app.records r
where r.deleted_at is null
  and r.record_state not in ('Complete', 'Canceled', 'Deferred')
  and (
    r.owner_party_id = (select private.current_person_id())
    or r.accountable_party_id = (select private.current_person_id())
    or r.id in (
      select ra.record_id from app.record_assignments ra
      where ra.deleted_at is null and ra.membership_id in (select private.my_membership_ids())
    )
  );

call private.describe('app.my_work_export', 'The signed-in person''s My Work (Section 4.5.4, 4.6.4): the open records they own, are accountable for or are assigned to through one of their memberships, as @xos/data listMyWork reads them. What My Work exports, so an Owner exports their own list and not every assignment in the org. Runs as the reader, so records'' row level security applies.', array[
  'id', 'Record.',
  'org_id', 'Org.',
  'project_id', 'Project of the record.',
  'record_number', 'Number of the record within its project.',
  'title', 'Title of the record.',
  'record_kind', 'Kind of record.',
  'record_state', 'State of the record; never Complete, Canceled or Deferred.',
  'due_at', 'When the record is due.',
  'starts_at', 'When the record starts.',
  'ends_at', 'When the record ends.',
  'updated_at', 'When the record last changed.'
]);
revoke all on app.my_work_export from public, anon;
grant select on app.my_work_export to authenticated, service_role;
revoke select on app.my_work_export from xos_backup;
