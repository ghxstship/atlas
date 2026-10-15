-- 1010_workforce_settings_directory.sql
-- A29 Workforce Suite, late slot (1010 to 1014, ADR 0022). Runs after A30's settings registry (0850) and
-- profiles (0860), which sort after the 0800 range:
--   1. Settings declared in packages/schemas/settings/a29.yaml: read receipts and the feed's default
--      reaction and comment switches (Settings, Communication), and a member's own work phone for the
--      directory's call button (Personal settings, Work details).
--   2. Read receipts: app.conversation_read_receipts shows who has read a conversation only while the org
--      has read receipts on (Section 4.9 Chat: "read receipts (optional per org)").
--   3. Directory (Section 4.9 Directory): the org's active members, reusing A30's people and profiles (never
--      a copy), with roles, who is on site now (an open time entry whose clock-in was verified inside a
--      geofence), the work phone the member chose to share and their recognition count when they consented.

select private.define_setting('communication.read_receipts', 'Boolean', 'org.communication.write', array['organization'], false, p_default_boolean => true);
select private.define_setting('communication.feed_reactions_default', 'Boolean', 'org.communication.write', array['organization'], false, p_default_boolean => true);
select private.define_setting('communication.feed_comments_default', 'Boolean', 'org.communication.write', array['organization'], false, p_default_boolean => true);
select private.define_setting('workforce.work_phone', 'Text', 'me.work_details.write', array['personal'], false, p_max_length => 32);

-- An org-level boolean setting: the org's value, or the platform default.
create or replace function private.org_boolean_setting(p_org_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select v.value_boolean from app.setting_values v
     where v.org_id = p_org_id and v.setting_key = p_key and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null),
    (select d.default_boolean from private.setting_definitions d where d.setting_key = p_key));
$$;
comment on function private.org_boolean_setting(uuid, text) is 'An org''s value of a boolean setting, or its platform default.';
revoke all on function private.org_boolean_setting(uuid, text) from public, anon;
grant execute on function private.org_boolean_setting(uuid, text) to authenticated, service_role;

create or replace function app.conversation_read_receipts(p_conversation_id uuid)
returns table (membership_id uuid, full_name text, last_read_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select c.org_id from app.conversations c where c.id = p_conversation_id and c.deleted_at is null);
begin
  perform private.require_person();
  if v_org is null or p_conversation_id not in (select private.my_conversation_ids()) then
    raise exception using errcode = '42501', message = 'the conversation does not exist or you are not in it';
  end if;
  if not private.org_boolean_setting(v_org, 'communication.read_receipts') then
    return;
  end if;
  return query
    select cm.membership_id, coalesce(pe.full_name, ''), cm.last_read_at
    from app.conversation_members cm
    join app.memberships m on m.id = cm.membership_id
    join app.people pe on pe.id = m.person_id
    where cm.conversation_id = p_conversation_id and cm.deleted_at is null and cm.membership_id <> private.my_membership_in(v_org)
    order by cm.last_read_at desc nulls last;
end;
$$;
comment on function app.conversation_read_receipts(uuid) is 'When the other members of a conversation last read it, for its members, only while the org has read receipts on (communication.read_receipts); empty otherwise.';
revoke all on function app.conversation_read_receipts(uuid) from public, anon;
grant execute on function app.conversation_read_receipts(uuid) to authenticated, service_role;

create or replace function app.workforce_directory(p_org_id uuid, p_search text default null, p_on_site_only boolean default false)
returns table (
  membership_id uuid,
  person_id uuid,
  full_name text,
  preferred_name text,
  headline text,
  photo_path text,
  role_names text[],
  on_site_now boolean,
  on_site_project_id uuid,
  on_site_since timestamptz,
  work_phone text,
  recognition_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_membership_in(p_org_id);
  return query
    with members as (
      select m.id, m.person_id from app.memberships m
      where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    ),
    on_site as (
      select distinct on (te.membership_id) te.membership_id, te.project_id, te.clock_in
      from app.time_entries te
      join members mm on mm.id = te.membership_id
      where te.clock_out is null and te.deleted_at is null and te.clock_in >= now() - interval '24 hours'
        and exists (select 1 from app.clock_punches cp where cp.time_entry_id = te.id and cp.punch_kind = 'In'
                    and cp.geofence_verified and cp.deleted_at is null)
      order by te.membership_id, te.clock_in desc
    )
    select mm.id, mm.person_id, coalesce(pe.full_name, ''),
      case when pp.visibility in ('Network', 'Public') then pp.preferred_name end,
      case when pp.visibility in ('Network', 'Public') then pp.headline end,
      case when pp.visibility in ('Network', 'Public') then pp.photo_path end,
      coalesce((select array_agg(coalesce(r.name, r.code) order by r.band) from app.membership_roles mr join app.roles r on r.id = mr.role_id
                where mr.membership_id = mm.id and mr.deleted_at is null), '{}'),
      os.membership_id is not null, os.project_id, os.clock_in,
      (select psv.value_text from app.personal_setting_values psv where psv.person_id = mm.person_id and psv.setting_key = 'workforce.work_phone'
         and psv.deleted_at is null and (psv.org_id is null or psv.org_id = p_org_id) order by psv.org_id nulls last limit 1),
      app.recognition_count(p_org_id, mm.person_id)
    from members mm
    join app.people pe on pe.id = mm.person_id and pe.deleted_at is null
    left join app.person_profiles pp on pp.person_id = mm.person_id and pp.deleted_at is null
    left join on_site os on os.membership_id = mm.id
    where (coalesce(btrim(p_search), '') = '' or pe.full_name ilike '%' || btrim(p_search) || '%'
           or (pp.visibility in ('Network', 'Public') and (pp.preferred_name ilike '%' || btrim(p_search) || '%' or pp.headline ilike '%' || btrim(p_search) || '%')))
      and (not coalesce(p_on_site_only, false) or os.membership_id is not null)
    order by os.membership_id is null, pe.full_name;
end;
$$;
comment on function app.workforce_directory(uuid, text, boolean) is 'The searchable people directory of an org for its members (Section 4.9 Directory): name, profile basics the person shares with their network, roles, whether they are on site now (open time entry clocked in inside a geofence within 24 hours), the work phone they chose to share and their recognition count when consented. On-site members first.';
revoke all on function app.workforce_directory(uuid, text, boolean) from public, anon;
grant execute on function app.workforce_directory(uuid, text, boolean) to authenticated, service_role;
