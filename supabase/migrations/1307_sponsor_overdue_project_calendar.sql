-- 1307_sponsor_overdue_project_calendar.sql
-- A71 (RRR-116): a sponsor entitlement is overdue once its due date has passed on the project's calendar
-- (app.projects.time_zone, the venue's), not the database's UTC date. Before, an entitlement due today showed
-- overdue to the sponsor in Gateway from 20:00 in New York. The view keeps its columns; only is_overdue changes.

create or replace view api_external.sponsor_entitlements as
select s.id, s.project_id, p.name as project_name, c.organization_id as account_id, s.description, s.quantity, s.due_on, s.fulfilled_at,
  (s.fulfilled_at is null and s.due_on is not null and s.due_on < private.zone_today(p.time_zone)) as is_overdue
from app.sponsor_entitlements s
join app.projects p on p.id = s.project_id
join app.counterparties c on c.id = s.counterparty_id
where s.deleted_at is null
  and exists (
    select 1 from app.engagements e
    where e.project_id = s.project_id and e.counterparty_id = s.counterparty_id and e.deleted_at is null and e.role_type = 'Sponsor')
  and private.counterparty_area_open(s.project_id, s.counterparty_id, 'operational',
    array['Account Owner', 'Account Admin', 'Account Member']::app.account_role[]);

call private.describe('api_external.sponsor_entitlements', 'Entitlements the caller''s sponsor account is owed on a project where its Sponsor engagement is in the operational area (Section 8.7), with due dates and delivery.', array[
  'id', 'Entitlement.', 'project_id', 'Project.', 'project_name', 'Project name.', 'account_id', 'Sponsor account.',
  'description', 'The entitlement.', 'quantity', 'How many, when countable.', 'due_on', 'When owed.', 'fulfilled_at', 'When delivered; NULL while owed.',
  'is_overdue', 'True when past due on the project''s calendar (its time zone) and not delivered.']);
