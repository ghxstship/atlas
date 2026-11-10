-- Briefings for outside crew and staff in Compass (Today's Briefings block). Workforce events are read only by the org's
-- members (private.readable_workforce_event_ids), so a crew member or staff engaged on a project from outside the org
-- never saw the briefing called for that project. This view gives them the project's own briefings, the ones whose
-- audience is the project, on projects where they hold an operational Crew or Staff engagement. Organization-, team-,
-- role- and group-wide events stay with the members they address.

create view api_external.briefings as
select e.id, e.project_id, p.name as project_name, p.time_zone, e.title, e.agenda, e.location,
  e.starts_at, e.ends_at, e.canceled_at, e.cancel_reason
from app.workforce_events e
join app.projects p on p.id = e.project_id and p.deleted_at is null
where e.deleted_at is null
  and e.event_kind = 'Briefing'
  and e.audience_kind = 'Project'
  and e.project_id in (
    select g.project_id from app.engagements g
    where g.role_type in ('Crew', 'Staff') and g.deleted_at is null
      and g.id in (select private.my_engagement_ids('operational')));

call private.describe('api_external.briefings', 'Project briefings for outside crew and staff (Section 4.9 Events, Compass Today): each briefing whose audience is a project where the caller holds an operational Crew or Staff engagement. Canceled briefings stay, with their reason, so the crew sees the change.', array[
  'id', 'Briefing.', 'project_id', 'Project.', 'project_name', 'Project name.', 'time_zone', 'Time zone of the project.',
  'title', 'Title of the briefing.', 'agenda', 'Agenda.', 'location', 'Where it is held.',
  'starts_at', 'When it starts.', 'ends_at', 'When it ends.', 'canceled_at', 'When it was canceled; null while it stands.',
  'cancel_reason', 'Why it was canceled.']);
revoke all on api_external.briefings from public, anon;
grant select on api_external.briefings to authenticated, service_role;
