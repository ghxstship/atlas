-- 2183_shared_records_leave_out_archived.sql
-- A124 (RRR-169), trace row S4.10-02. The records an org shares with an engaged external party (api_external.records,
-- 0750) filtered on deleted_at only, so a record archived in Atlas (2180) stayed on the party's Gateway schedule and in
-- their calendar feed (1410), which reads this view. It restates the view's latest definition (0750) with archived
-- records left out, the same columns in the same order, so its grants and its dependents carry over; unarchiving brings
-- the record back. The view is in api_external, which the xos_backup default grant (1650) does not cover.

create or replace view api_external.records as
select r.id, r.project_id, r.record_kind, r.record_subtype, r.record_state, r.title, r.starts_at, r.ends_at, r.due_at, r.time_zone
from app.records r
where r.deleted_at is null and r.archived_at is null and private.is_engaged_party(r.project_id)
  and exists (
    select 1 from app.record_external_visibility v
    where v.record_id = r.id and v.deleted_at is null
      and (v.external_role_type in (select private.engaged_role_types(r.project_id))
        or v.person_id = private.current_person_id()
        or v.organization_id in (select private.engaged_organization_ids(r.project_id))));

call private.describe('api_external.records', 'Project records whose external visibility names the caller''s role type, person or organization, on projects where the caller holds an Active or Closing engagement (Section 8.7 operational access). Archived records are left out until they are unarchived (A124).', array[
  'id', 'Record.', 'project_id', 'Project.', 'record_kind', 'Record kind.', 'record_subtype', 'Subtype.',
  'record_state', 'Record state.', 'title', 'Title.', 'starts_at', 'Start.', 'ends_at', 'End.', 'due_at', 'Due.',
  'time_zone', 'IANA time zone of typed local times.']);

revoke all on api_external.records from public, anon;
grant select on api_external.records to authenticated, service_role;
