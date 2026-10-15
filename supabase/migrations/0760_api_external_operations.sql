-- 0760_api_external_operations.sql
-- A28 Engagements and Marketplace (RRR-30). Section 8.7 operational projections for external Compass (A17) and
-- Gateway, over A03 tables that need no change:
--   * app.engagement_cues: the cues of a running order that are an artist's set times, so an artist reads only
--     their own set and never the rest of the show
--   * api_external.run_of_show and api_external.cues: Client parties read the whole running order of projects they
--     are engaged on; Artist parties (and representatives holding the Advance scope) read only their set cues and
--     the running orders that hold them
--   * api_external.day_sheets: every external party with operational reach on the project
--   * api_external.dock_slots: a Vendor party reads the slots booked for shipments it carries
--   * api_external.credentials: a person reads their own badges; an artist's representative with the Advance scope
--     reads the artist's badges
-- Every view runs as its owner with an explicit row filter built from the 0710 helpers, which take column values
-- (ADR 0016 item 14). Operational reach opens at Active and closes at Complete (Section 8.7 time box). No view
-- carries who called a cue, who issued or revoked a badge, or any internal note.
-- Shifts, asset custody and the external time entry path follow once A03 adds engagement_id to shifts and time
-- entries.

-- Artist set times ----------------------------------------------------------------------------------------------

create table app.engagement_cues (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  cue_id uuid not null references app.cues (id),
  deleted_at timestamptz
);

create index engagement_cues_engagement_id_idx on app.engagement_cues (engagement_id);
create index engagement_cues_cue_id_idx on app.engagement_cues (cue_id);
create unique index engagement_cues_key on app.engagement_cues (engagement_id, cue_id) where deleted_at is null;

call private.install_domain_table('app.engagement_cues', 'app.engagements', 'engagement_id', array['app.cues', 'cue_id']);
call private.describe('app.engagement_cues', 'Cues of a running order that are an artist''s set times (Section 4.4.4: the artist sees set times). The artist and their representative read these cues through api_external.cues and never the rest of the running order.', array[
  'engagement_id', 'Artist engagement whose set the cue marks.',
  'cue_id', 'Cue of a running order of the same project.'
]);

create or replace function private.guard_engagement_cue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_cue_project uuid;
begin
  if tg_op = 'UPDATE' and (new.engagement_id <> old.engagement_id or new.cue_id <> old.cue_id) then
    perform private.refuse('engagement_cue_immutable', 'A set time keeps its engagement and cue; remove it and add another.');
  end if;
  select e.* into v_engagement from app.engagements e where e.id = new.engagement_id;
  if v_engagement.role_type not in ('Artist') then
    perform private.refuse('engagement_cue_artist_only', 'Set times belong to artist engagements.');
  end if;
  select r.project_id into v_cue_project from app.cues c join app.run_of_show r on r.id = c.run_of_show_id where c.id = new.cue_id;
  if v_cue_project is distinct from v_engagement.project_id then
    perform private.refuse('engagement_cue_project_mismatch', 'A set time is a cue of the engagement''s own project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engagement_cue() is 'Set times: only on artist engagements, only cues of a running order of the engagement''s project, and a set time keeps its engagement and cue.';

create trigger t40_guard_engagement_cue before insert or update on app.engagement_cues
  for each row execute function private.guard_engagement_cue();

call private.install_policies('app.engagement_cues',
  $$engagement_id in (select private.internal_engagement_ids('show.run_of_show.read'))$$,
  $$engagement_id in (select private.internal_engagement_ids('show.run_of_show.write'))$$);

revoke insert, update on app.engagement_cues from authenticated;
grant insert (engagement_id, cue_id), update (deleted_at) on app.engagement_cues to authenticated;

-- Helpers (column values in, ADR 0016 item 14) ---------------------------------------------------------------------

create or replace function private.engaged_as(p_project_id uuid, p_role_type app.external_role_type)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.engaged_role_types(p_project_id) t where t = p_role_type);
$$;

comment on function private.engaged_as(uuid, app.external_role_type) is 'Section 8.7: true when the signed-in person reaches the project''s operational area through an engagement of the role type.';

create or replace function private.my_set_cue_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ec.cue_id from app.engagement_cues ec
  where ec.deleted_at is null and ec.engagement_id in (select private.my_engagement_ids('operational'));
$$;

comment on function private.my_set_cue_ids() is 'Set time cues of artist engagements whose operational area the signed-in person reaches now: the artist, or a representative with the Advance scope.';

create or replace function private.external_credential_visible(p_project_id uuid, p_holder_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    where e.project_id = p_project_id and e.person_id = p_holder_person_id and e.deleted_at is null
      and (p_holder_person_id = private.current_person_id()
        or (e.role_type = 'Artist' and private.represents(p_holder_person_id, 'Advance')))
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational'));
$$;

comment on function private.external_credential_visible(uuid, uuid) is 'Section 8.7: true when the signed-in person may read a badge of the project held by the person: their own, or a represented artist''s with the Advance scope, while that engagement''s operational area is open. Takes the badge''s column values.';

create or replace function private.external_dock_slot_visible(p_project_id uuid, p_shipment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.shipments s
    join app.engagements e on e.project_id = s.project_id and e.counterparty_id = s.carrier_counterparty_id
    where s.id = p_shipment_id and s.project_id = p_project_id and s.deleted_at is null
      and e.deleted_at is null and e.role_type = 'Vendor'
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational'));
$$;

comment on function private.external_dock_slot_visible(uuid, uuid) is 'Section 8.7: true when the signed-in person reaches a Vendor engagement on the project whose account carries the shipment the slot is booked for. Takes the slot''s column values.';

-- Projections -----------------------------------------------------------------------------------------------------------

create view api_external.run_of_show as
select r.id, r.project_id, p.name as project_name, r.name, r.show_date
from app.run_of_show r
join app.projects p on p.id = r.project_id
where r.deleted_at is null
  and (private.engaged_as(r.project_id, 'Client')
    or exists (select 1 from app.cues c where c.run_of_show_id = r.id and c.deleted_at is null and c.id in (select private.my_set_cue_ids())));

call private.describe('api_external.run_of_show', 'Running orders the caller may read (Section 8.7): every running order of a project where the caller holds a Client engagement in its operational area, and for artists and their Advance representatives only the running orders that hold their set.', array[
  'id', 'Running order.', 'project_id', 'Project.', 'project_name', 'Project name.', 'name', 'Running order name.', 'show_date', 'Show day.']);

create view api_external.cues as
select c.id, c.run_of_show_id, c.position, c.label, c.planned_at, c.duration, c.called_at,
  (c.id in (select private.my_set_cue_ids())) as is_my_set
from app.cues c
join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
where c.deleted_at is null
  and (private.engaged_as(r.project_id, 'Client') or c.id in (select private.my_set_cue_ids()));

call private.describe('api_external.cues', 'Cues the caller may read: all cues of a Client''s projects, and for artists only their set times. Who called a cue never appears.', array[
  'id', 'Cue.', 'run_of_show_id', 'Running order.', 'position', 'Order in the running order.', 'label', 'Cue label.',
  'planned_at', 'Planned time.', 'duration', 'Planned length.', 'called_at', 'When the cue was called.',
  'is_my_set', 'True when the cue is one of the caller''s own set times.']);

create view api_external.day_sheets as
select d.id, d.project_id, p.name as project_name, d.day, d.body
from app.day_sheets d
join app.projects p on p.id = d.project_id
where d.deleted_at is null and private.is_engaged_party(d.project_id);

call private.describe('api_external.day_sheets', 'Day sheets of projects where the caller reaches the operational area through an engagement (Section 8.7): the schedule and notes everyone on the day works from.', array[
  'id', 'Day sheet.', 'project_id', 'Project.', 'project_name', 'Project name.', 'day', 'Day covered.', 'body', 'Day sheet content as rich text.']);

create view api_external.dock_slots as
select d.id, d.project_id, p.name as project_name, d.zone_id, z.code as zone_code, z.name as zone_name, d.shipment_id,
  s.direction, s.tracking_identifier, d.starts_at, d.ends_at
from app.dock_slots d
join app.projects p on p.id = d.project_id
join app.zones z on z.id = d.zone_id
join app.shipments s on s.id = d.shipment_id
where d.deleted_at is null and private.external_dock_slot_visible(d.project_id, d.shipment_id);

call private.describe('api_external.dock_slots', 'Dock slots booked for shipments the caller''s vendor account carries, on projects where its Vendor engagement is in the operational area (Section 8.7). Other vendors'' slots never appear.', array[
  'id', 'Dock slot.', 'project_id', 'Project.', 'project_name', 'Project name.', 'zone_id', 'Dock zone.', 'zone_code', 'Zone code.',
  'zone_name', 'Zone name.', 'shipment_id', 'Shipment.', 'direction', 'Inbound or Outbound.', 'tracking_identifier', 'Carrier tracking number.',
  'starts_at', 'Slot start.', 'ends_at', 'Slot end.']);

create view api_external.credentials as
select c.id, k.project_id, p.name as project_name, k.code as category_code, k.name as category_name, c.holder_person_id,
  h.full_name as holder_name, c.credential_number, c.valid_from, c.valid_to, c.revoked_at
from app.credentials c
join app.credential_categories k on k.id = c.credential_category_id and k.deleted_at is null
join app.projects p on p.id = k.project_id
join app.people h on h.id = c.holder_person_id
where c.deleted_at is null and private.external_credential_visible(k.project_id, c.holder_person_id);

call private.describe('api_external.credentials', 'Badges the caller may read (Section 8.7): their own on projects where their engagement is in the operational area, and a represented artist''s with the Advance scope. Who issued or revoked a badge never appears.', array[
  'id', 'Credential.', 'project_id', 'Project.', 'project_name', 'Project name.', 'category_code', 'Category code.',
  'category_name', 'Category name.', 'holder_person_id', 'Holder.', 'holder_name', 'Holder name.',
  'credential_number', 'Number printed and scanned.', 'valid_from', 'When it starts working.', 'valid_to', 'When it stops working.',
  'revoked_at', 'When it was revoked.']);

-- Privileges -------------------------------------------------------------------------------------------------------------

revoke all on function private.guard_engagement_cue() from public, anon, authenticated;
revoke all on function private.engaged_as(uuid, app.external_role_type) from public, anon;
revoke all on function private.my_set_cue_ids() from public, anon;
revoke all on function private.external_credential_visible(uuid, uuid) from public, anon;
revoke all on function private.external_dock_slot_visible(uuid, uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need these.
grant execute on function private.engaged_as(uuid, app.external_role_type) to authenticated, service_role;
grant execute on function private.my_set_cue_ids() to authenticated, service_role;
grant execute on function private.external_credential_visible(uuid, uuid) to authenticated, service_role;
grant execute on function private.external_dock_slot_visible(uuid, uuid) to authenticated, service_role;

revoke all on api_external.run_of_show, api_external.cues, api_external.day_sheets, api_external.dock_slots, api_external.credentials
  from public, anon;
grant select on api_external.run_of_show, api_external.cues, api_external.day_sheets, api_external.dock_slots, api_external.credentials
  to authenticated, service_role;
