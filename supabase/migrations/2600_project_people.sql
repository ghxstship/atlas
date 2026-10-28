-- 2600_project_people.sql
-- R1 Advancing wiring fixes (RRR-179, ADR 0100 to 0104). People pickers that reach the people engaged on a project,
-- not only the org's members.
--
--   * private.project_people_reach(project): the caller holds one of the nine capabilities whose forms pick a
--     person or an engagement on the project (badges, travel and lodging, custody, per diems, cues, dock slots,
--     riders, and reading engagements).
--   * app.project_people(project): one row per person a form on the project may pick: current members of the
--     project's org, and people named on the project's live engagements (Onboarding, Blocked, Active, Closing),
--     with the engagement and the account that supplies them. Members of an engaged account who are not named on
--     an engagement never appear; the roster comes with R4.
--   * app.engagement_options(org, project): the live engagements of the org's projects, or of one project, that
--     the caller reaches, for the Vendor, custodian and Set for selects.

create or replace function private.project_people_reach(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from unnest(array[
      'opportunities.engagement.read', 'credentials.credential.issue', 'hospitality.fulfillment.write',
      'hospitality.accommodation.write', 'assets.custody.write', 'crew.time_entry.write', 'show.run_of_show.write',
      'logistics.dock_slot.write', 'advancing.rider.write']) c (capability)
    where private.can_on_project(p_project_id, c.capability));
$$;

comment on function private.project_people_reach(uuid) is 'True when the signed-in person holds, on the project, any capability whose forms pick a project person or engagement: opportunities.engagement.read, credentials.credential.issue, hospitality.fulfillment.write, hospitality.accommodation.write, assets.custody.write, crew.time_entry.write, show.run_of_show.write, logistics.dock_slot.write or advancing.rider.write.';
revoke all on function private.project_people_reach(uuid) from public, anon, authenticated;

create or replace function app.project_people(p_project_id uuid)
returns table (
  person_id uuid,
  full_name text,
  membership_id uuid,
  engagement_id uuid,
  role_type app.external_role_type,
  engagement_state app.engagement_state,
  account_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.project_people_reach(p_project_id) then
    raise exception using errcode = '42501', message = 'a people picker capability is required on the project';
  end if;
  return query
    with project as (
      select p.id, p.org_id from app.projects p where p.id = p_project_id
    ),
    members as (
      select m.person_id, m.id as membership_id
      from app.memberships m
      join project on project.org_id = m.org_id
      where m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    ),
    engaged as (
      select distinct on (e.person_id) e.person_id, e.id as engagement_id, e.role_type, e.engagement_state, o.name as account_name
      from app.engagements e
      left join app.counterparties c on c.id = e.counterparty_id
      left join app.organizations o on o.id = c.organization_id
      where e.project_id = p_project_id and e.person_id is not null and e.deleted_at is null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
      order by e.person_id, (e.engagement_state = 'Active') desc, e.start_date desc, e.id desc
    )
    select h.id, h.full_name, mm.membership_id, g.engagement_id, g.role_type, g.engagement_state, g.account_name
    from (select x.person_id from members x union select y.person_id from engaged y) who
    join app.people h on h.id = who.person_id
    left join members mm on mm.person_id = who.person_id
    left join engaged g on g.person_id = who.person_id
    order by h.full_name, h.id;
end;
$$;

comment on function app.project_people(uuid) is 'People a form on the project may pick (R1): current members of the project''s org with their membership, and people named on the project''s live engagements (Onboarding, Blocked, Active, Closing) with that engagement, its role type and state, and the name of the account that supplies them. One row per person; a person with several live engagements carries the Active one, then the latest start. Needs one of the people picker capabilities on the project (private.project_people_reach).';
revoke all on function app.project_people(uuid) from public, anon;
grant execute on function app.project_people(uuid) to authenticated, service_role;

create or replace function app.engagement_options(p_org_id uuid, p_project_id uuid default null)
returns table (
  engagement_id uuid,
  project_id uuid,
  project_key text,
  role_type app.external_role_type,
  engagement_state app.engagement_state,
  person_id uuid,
  person_name text,
  account_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_membership_in(p_org_id);
  return query
    select e.id, e.project_id, p.project_key, e.role_type, e.engagement_state, e.person_id, h.full_name, o.name
    from app.engagements e
    join app.projects p on p.id = e.project_id and p.org_id = p_org_id
    left join app.people h on h.id = e.person_id
    left join app.counterparties c on c.id = e.counterparty_id
    left join app.organizations o on o.id = c.organization_id
    where e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
      and (p_project_id is null or e.project_id = p_project_id)
      and private.project_people_reach(e.project_id)
    order by p.project_key, e.role_type, coalesce(o.name, h.full_name), e.id;
end;
$$;

comment on function app.engagement_options(uuid, uuid) is 'Live engagements (Onboarding, Blocked, Active, Closing) of the org''s projects, or of one project, on projects where the signed-in member holds a people picker capability (R1), with the project key, the person and the supplying account. Feeds the dock Vendor, custodian and cue Set for selects.';
revoke all on function app.engagement_options(uuid, uuid) from public, anon;
grant execute on function app.engagement_options(uuid, uuid) to authenticated, service_role;
