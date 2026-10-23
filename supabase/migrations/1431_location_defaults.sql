-- 1431_location_defaults.sql
-- A86 Settings surfaces (RRR-131, finding A65-004, WP3), Section 4.5.6 org settings item 9: Locations and Venues
-- defaults.
--   * app.org_location_defaults: at most one live row per org with the jurisdiction and the IANA time zone a new
--     venue starts with. Without a row a new venue starts in the org's own time zone (locale.time_zone) and no
--     jurisdiction is preselected.
--   * app.set_location_defaults: records them (org.locations.write); the time zone must be an IANA name and the
--     jurisdiction a canon jurisdiction. Changes are audited.
-- Reader: the Atlas venue form (apps/atlas/components/places/venues/venue-form.tsx) starts a new venue with these
-- values; a venue already saved keeps its own.

create table app.org_location_defaults (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  jurisdiction_id text references xpms.jurisdiction (jurisdiction_id),
  time_zone text
);

call private.install_domain_table('app.org_location_defaults');
create unique index org_location_defaults_org_key on app.org_location_defaults (org_id) where deleted_at is null;
create index org_location_defaults_jurisdiction_idx on app.org_location_defaults (jurisdiction_id);
call private.describe('app.org_location_defaults', 'What a new venue of the org starts with (Section 4.5.6 item 9): its jurisdiction and its IANA time zone. One live row per org; without one a venue starts in the org''s time zone. Set in Settings, Locations and Venues Defaults.', array[
  'jurisdiction_id', 'Canon jurisdiction a new venue starts in, for example US-FL-MIAMI-DADE; null for none.',
  'time_zone', 'IANA time zone a new venue starts in, for example America/New_York; null for the org''s time zone.'
]);

call private.install_policies('app.org_location_defaults',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.locations.write'))$$);
call private.install_audit_trail('app.org_location_defaults');

create or replace function private.guard_org_location_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.time_zone);
  return new;
end;
$$;

comment on function private.guard_org_location_defaults() is 'Location defaults name an IANA time zone or none.';

create trigger t20_guard_org_location_defaults before insert or update on app.org_location_defaults
  for each row execute function private.guard_org_location_defaults();

-- RPC -----------------------------------------------------------------------------------------------------------------

create or replace function app.set_location_defaults(p_org_id uuid, p_jurisdiction_id text, p_time_zone text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_jurisdiction text := nullif(btrim(p_jurisdiction_id), '');
  v_zone text := nullif(btrim(p_time_zone), '');
begin
  perform private.require_person();
  if p_org_id is null or p_org_id not in (select private.orgs_with_capability('org.locations.write')) then
    raise exception using errcode = '42501', message = 'org.locations.write is required to set location defaults';
  end if;
  if v_jurisdiction is not null and not exists (select 1 from xpms.jurisdiction j where j.jurisdiction_id = v_jurisdiction) then
    perform private.refuse('jurisdiction_unknown', format('%s is not a canon jurisdiction.', v_jurisdiction));
  end if;
  update app.org_location_defaults set jurisdiction_id = v_jurisdiction, time_zone = v_zone
  where org_id = p_org_id and deleted_at is null
  returning id into v_id;
  if v_id is null then
    insert into app.org_location_defaults (org_id, jurisdiction_id, time_zone)
    values (p_org_id, v_jurisdiction, v_zone)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.set_location_defaults(uuid, text, text) is 'Records the jurisdiction and time zone a new venue of the org starts with (Section 4.5.6 item 9; org.locations.write). Empty values clear them.';

-- Retention -----------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.org_location_defaults', interval '90 days');

-- Privileges ----------------------------------------------------------------------------------------------------------

revoke all on function private.guard_org_location_defaults() from public, anon, authenticated;
revoke all on function app.set_location_defaults(uuid, text, text) from public, anon;
grant execute on function app.set_location_defaults(uuid, text, text) to authenticated;
