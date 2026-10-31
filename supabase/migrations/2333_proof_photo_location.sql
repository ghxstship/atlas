-- 2333_proof_photo_location.sql
--
-- A140 (RRR-204; ADR 0117 decision 1): the org's media.keep_photo_location (2330) applies to a sponsor's
-- proof-of-performance photos too. Compass resolves settings for the person in the org they are a member of, and a
-- sponsor is an external party with no membership, so the device never held the org's value and proof photos always
-- left without their location. The entitlement the sponsor photographs now carries its org's value.
--
-- api_external.sponsor_entitlements is 1307's definition with keep_photo_location appended: the org's own value of
-- the setting, or its default (off). The view keeps its row filter, its other columns in the same order and its
-- grants; the org's choice is a rule for the photos taken of its entitlements, not something the sponsor could not
-- already see in the photos themselves.

create or replace view api_external.sponsor_entitlements as
select s.id, s.project_id, p.name as project_name, c.organization_id as account_id, s.description, s.quantity, s.due_on, s.fulfilled_at,
  (s.fulfilled_at is null and s.due_on is not null and s.due_on < private.zone_today(p.time_zone)) as is_overdue,
  coalesce(private.org_boolean_setting(s.org_id, 'media.keep_photo_location'), false) as keep_photo_location
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
  'is_overdue', 'True when past due on the project''s calendar (its time zone) and not delivered.',
  'keep_photo_location', 'True when the entitlement''s org keeps where a photo was taken (media.keep_photo_location, 2330); Compass applies it to proof-of-performance photos of the entitlement.']);

revoke all on api_external.sponsor_entitlements from public, anon;
grant select on api_external.sponsor_entitlements to authenticated, service_role;
