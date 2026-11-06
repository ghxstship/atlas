-- 2990_crew_access_links.sql
-- B10 Crew onboarding, recruitment and account-free field access (RRR-234, gap G-125, Section 4.4.6, Section 7.5
-- invariant 8, ADR 0149 decision 2). Crew without the app could not see or accept their shifts (R12). A crew access
-- link is another token flow beside /advance and /sign: a link and a 6-digit code that show one worker their own shifts
-- on one project in Gateway (/shifts/{token}) and let them accept their own Published shift. No session is created and
-- no person: the worker is already a person who accepted an org membership, an engagement or a roster entry (ADR 0008).
--   * app.crew_access_links: one live link per worker and project (the same worker shape as shifts: exactly one of
--     membership_id, engagement_id and roster_entry_id), stored only as SHA-256 hashes: the token, and the token-salted
--     code (0769). 1 hour to 30 days; locked at 5 wrong codes; closed as soon as the worker stops working
--     (private.crew_access_worker_live mirrors the signed-in reach without a session), their project or org is removed,
--     or they delete their account (t60_revoke_crew_access_links). Excluded from Trash: a link is access, issued again and
--     never restored. Exempt from the read-only guard, so a signed-in visitor's open still counts a wrong code and never
--     raises; api_public.crew_access_accept_shift refuses crew_access_read_only itself, for anyone.
--   * app.issue_crew_access_links (crew.shift.write on the project, all or nothing, the token and code shown once, and
--     the org's verified custom Gateway host when it has one) and app.revoke_crew_access_link.
--   * app.crew_access_link_list and app.crew_access_workers read names under definer, with crew.shift.write on the
--     project as their own row filter; a name is never read through app.people from the caller's side (1275).
--   * private.resolve_crew_access_link follows 1295: private.require_read_write() before any lookup, the row locked FOR
--     UPDATE, and it never raises, so a wrong code's count persists.
--   * api_public.crew_access_shifts returns rendered fields only (no rate, no other worker, no internal note): the
--     link worker's Published, Accepted and Canceled shifts on the link project from 12 hours ago to 14 days ahead,
--     with the job title from the Roles Library and the venue as text (coalesce of the scope node's venue and the
--     project's; no maps, S5-29). api_public.crew_access_accept_shift is the one write: the worker accepts their own
--     Published shift, checked as app.accept_shift and app.accept_engaged_shift check it, with the shift locked.
--     Refusals come back as REFUSE with a reason code, as 0769, 1295 and Gateway's other token flows read them.
--   * Declining stays signed-in (A127's app.decline_shift); there is no punching through a link (kiosk PINs, Compass and
--     R12's supervisor punches cover time).

-- Before the table, so the tenant guards install no read-only trigger (2654 is the model).
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.crew_access_links', 'Opening a link counts wrong codes and opens without raising; issuing refuses a read-only org itself, revoking stays possible, and accepting a shift refuses crew_access_read_only.');

create table app.crew_access_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  membership_id uuid references app.memberships (id),
  engagement_id uuid references app.engagements (id),
  roster_entry_id uuid references app.engagement_roster_entries (id),
  token_hash bytea not null,
  access_code_hash bytea not null,
  expires_at timestamptz not null,
  failed_attempts smallint not null default 0,
  last_opened_at timestamptz,
  open_count integer not null default 0,
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint crew_access_links_one_worker check (num_nonnulls(membership_id, engagement_id, roster_entry_id) = 1),
  constraint crew_access_links_token_hash check (octet_length(token_hash) = 32),
  constraint crew_access_links_access_code_hash check (octet_length(access_code_hash) = 32),
  constraint crew_access_links_failed_attempts check (failed_attempts between 0 and 5),
  constraint crew_access_links_open_count check (open_count >= 0),
  constraint crew_access_links_token_hash_key unique (token_hash)
);

create index crew_access_links_project_idx on app.crew_access_links (project_id);
create index crew_access_links_membership_id_idx on app.crew_access_links (membership_id);
create index crew_access_links_engagement_id_idx on app.crew_access_links (engagement_id);
create index crew_access_links_roster_entry_id_idx on app.crew_access_links (roster_entry_id);
create unique index crew_access_links_live_membership_key on app.crew_access_links (project_id, membership_id)
  where membership_id is not null and revoked_at is null and deleted_at is null;
create unique index crew_access_links_live_engagement_key on app.crew_access_links (project_id, engagement_id)
  where engagement_id is not null and revoked_at is null and deleted_at is null;
create unique index crew_access_links_live_roster_entry_key on app.crew_access_links (project_id, roster_entry_id)
  where roster_entry_id is not null and revoked_at is null and deleted_at is null;

call private.install_domain_table('app.crew_access_links', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.engagements', 'engagement_id', 'app.engagement_roster_entries', 'roster_entry_id']);
call private.describe('app.crew_access_links', 'A crew access link (B10, ADR 0149 decision 2): a token and a 6-digit code that show one worker their own shifts on one project in Gateway without signing in, and let them accept their own Published shift. Stored only as hashes; written only by the link RPCs; one live link per worker and project.', array[
  'org_id', 'Owning org, derived from the project.',
  'project_id', 'Project whose shifts the link shows.',
  'membership_id', 'Worker by org membership, as on app.shifts.',
  'engagement_id', 'Worker by engagement, as on app.shifts.',
  'roster_entry_id', 'Worker by roster entry, as on app.shifts (R4, R12).',
  'token_hash', 'SHA-256 of the token (xcrw_ and 64 hex characters), the only form stored. Never selectable.',
  'access_code_hash', 'SHA-256 of the token, a colon and the 6-digit code. Never selectable.',
  'expires_at', 'When the link stops working, 1 hour to 30 days after it was issued.',
  'failed_attempts', 'Wrong codes entered; the link locks at 5.',
  'last_opened_at', 'When the worker last opened their shifts with the link.',
  'open_count', 'How many times the worker opened their shifts with the link.',
  'revoked_at', 'When a crew lead revoked it or issued the worker a new one.'
]);

call private.install_policies('app.crew_access_links',
  $$project_id in (select private.project_ids_with('crew.shift.write'))$$);
revoke select, insert, update on app.crew_access_links from authenticated;
grant select (id, org_id, project_id, membership_id, engagement_id, roster_entry_id, expires_at, failed_attempts, last_opened_at,
  open_count, revoked_at, deleted_at, created_at, created_by, updated_at, updated_by) on app.crew_access_links to authenticated;

call private.install_default_retention('app.crew_access_links');
call private.install_audit_trail('app.crew_access_links');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('crew_access_links', 'A link is access: it is issued again, never restored.')
on conflict (table_name) do nothing;

insert into private.domain_event_types (code, subject, description) values
  ('crew_access_link.issued', 'crew_access_links', 'A crew access link was issued to a worker for a project.'),
  ('crew_access_link.revoked', 'crew_access_links', 'A crew access link was revoked.')
on conflict (code) do nothing;

-- Hashing ----------------------------------------------------------------------------------------------------------------

create or replace function private.crew_access_token_hash(p_token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, ''), 'sha256');
$$;

comment on function private.crew_access_token_hash(text) is 'SHA-256 of a crew access token, the only form stored.';
revoke all on function private.crew_access_token_hash(text) from public, anon, authenticated;

create or replace function private.crew_access_code_hash(p_token text, p_code text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, '') || ':' || coalesce(btrim(p_code), ''), 'sha256');
$$;

comment on function private.crew_access_code_hash(text, text) is 'SHA-256 of the token, a colon and the access code: the token salts the 6-digit code (0769).';
revoke all on function private.crew_access_code_hash(text, text) from public, anon, authenticated;

-- Who the link still reaches ------------------------------------------------------------------------------------------------

create or replace function private.crew_access_worker_live(
  p_org_id uuid,
  p_project_id uuid,
  p_membership_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from app.projects p join app.organizations o on o.id = p.org_id
      where p.id = p_project_id and p.org_id = p_org_id and p.deleted_at is null and o.deleted_at is null)
    and case
    -- A live membership of the link's org (private.my_membership_ids, 0204), of a person who has not deleted their account.
    when p_membership_id is not null then exists (
      select 1 from app.memberships m
      join app.people pe on pe.id = m.person_id and pe.deleted_at is null
      where m.id = p_membership_id and m.org_id = p_org_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
    -- The engagement's operational area (0710, 2632): a person engaged on the project, Active or Closing.
    when p_engagement_id is not null then exists (
      select 1 from app.engagements e
      join app.people pe on pe.id = e.person_id and pe.deleted_at is null
      where e.id = p_engagement_id and e.project_id = p_project_id and e.deleted_at is null
        and e.engagement_state in ('Active', 'Closing'))
    -- private.my_roster_entry_ids('operational') (2635): accepted by both sides on an Active or Closing engagement. A self
    -- entry holds no person of its own, so the person resolves through the engagement.
    else exists (
      select 1 from app.engagement_roster_entries r
      join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
      join app.people pe on pe.id = private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) and pe.deleted_at is null
      where r.id = p_roster_entry_id and r.deleted_at is null
        and r.entry_state = 'Accepted' and r.person_response = 'Accepted'
        and e.project_id = p_project_id and e.engagement_state in ('Active', 'Closing'))
  end;
$$;

comment on function private.crew_access_worker_live(uuid, uuid, uuid, uuid, uuid) is 'True while a link''s worker still works for the org on the link''s project, mirroring the signed-in reach without a session: the project and org are live, and the worker is a live membership, an engagement on the project that is Active or Closing with a person, or a live roster entry Accepted by both sides on such an engagement, of a person who has not deleted their account.';
-- app.crew_access_link_list calls it, and a view's functions are checked against the caller.
revoke all on function private.crew_access_worker_live(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function private.crew_access_worker_live(uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

create or replace function private.crew_access_worker_shifts(p_link app.crew_access_links)
returns setof app.shifts
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from app.shifts s
  where s.project_id = p_link.project_id and s.deleted_at is null
    and (s.membership_id = p_link.membership_id or s.engagement_id = p_link.engagement_id
         or s.roster_entry_id = p_link.roster_entry_id);
$$;

comment on function private.crew_access_worker_shifts(app.crew_access_links) is 'The live shifts of a link''s worker on the link''s project, matched on the link''s one worker column.';
revoke all on function private.crew_access_worker_shifts(app.crew_access_links) from public, anon, authenticated;

-- Issuing and revoking -------------------------------------------------------------------------------------------------------

create or replace function app.issue_crew_access_links(p_project_id uuid, p_workers jsonb, p_valid_for interval default interval '7 days')
returns table (
  link_id uuid,
  membership_id uuid,
  engagement_id uuid,
  roster_entry_id uuid,
  person_name text,
  token text,
  access_code text,
  expires_at timestamptz,
  gateway_host text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_worker jsonb;
  v_link app.crew_access_links;
  v_token text;
  v_code text;
  v_ids uuid[] := '{}';
  v_membership uuid;
  v_engagement uuid;
  v_roster uuid;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_gateway_host text;
begin
  perform private.require_person();
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.can_on_project(v_project.id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project';
  end if;
  if private.org_read_only(v_project.org_id) then
    perform private.refuse('org_read_only', 'This organization is read-only, so it cannot issue crew access links.');
  end if;
  -- The rule of api_public.org_brand_for_host (1355), read here because app.org_domains needs org.settings.read and links
  -- must not differ by issuer.
  select d.hostname into v_gateway_host from app.org_domains d
  where d.org_id = v_project.org_id and d.purpose = 'Gateway' and d.verification_state = 'Verified' and d.deleted_at is null
    and private.white_label_in_force(d.org_id, 'custom_domain')
  order by d.hostname
  limit 1;
  if p_valid_for is null or p_valid_for < interval '1 hour' or p_valid_for > interval '30 days' then
    perform private.refuse('crew_access_validity', 'A crew access link works for 1 hour to 30 days.');
  end if;
  if p_workers is null or jsonb_typeof(p_workers) <> 'array' or jsonb_array_length(p_workers) not between 1 and 200 then
    perform private.refuse('crew_access_batch', 'Issue links to 1 to 200 workers at a time.');
  end if;
  for v_worker in select w from jsonb_array_elements(p_workers) w loop
    if jsonb_typeof(v_worker) <> 'object'
       or (select count(*) from jsonb_object_keys(v_worker) k where k in ('membership_id', 'engagement_id', 'roster_entry_id')
           and jsonb_typeof(v_worker -> k) = 'string') <> 1
       or exists (select 1 from jsonb_object_keys(v_worker) k where k not in ('membership_id', 'engagement_id', 'roster_entry_id'))
       or exists (select 1 from jsonb_each_text(v_worker) x where x.value !~* v_uuid) then
      perform private.refuse('crew_access_worker', 'Name each worker by exactly one of membership_id, engagement_id or roster_entry_id.');
    end if;
    v_membership := (v_worker ->> 'membership_id')::uuid;
    v_engagement := (v_worker ->> 'engagement_id')::uuid;
    v_roster := (v_worker ->> 'roster_entry_id')::uuid;
    v_link := null;
    v_link.project_id := v_project.id;
    v_link.membership_id := v_membership;
    v_link.engagement_id := v_engagement;
    v_link.roster_entry_id := v_roster;
    if not private.crew_access_worker_live(v_project.org_id, v_project.id, v_membership, v_engagement, v_roster) or not exists (
      select 1 from private.crew_access_worker_shifts(v_link) s
      where s.shift_state in ('Published', 'Accepted') and s.ends_at > now()) then
      perform private.refuse('crew_access_not_working', 'Each worker needs an upcoming Published or Accepted shift on this project and must still work for the organization.');
    end if;
    -- The worker's earlier live link for the project stops working.
    update app.crew_access_links l set revoked_at = now()
    where l.project_id = v_project.id and l.revoked_at is null and l.deleted_at is null
      and (l.membership_id = v_membership or l.engagement_id = v_engagement or l.roster_entry_id = v_roster);
    v_token := 'xcrw_' || encode(extensions.gen_random_bytes(32), 'hex');
    v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    insert into app.crew_access_links (project_id, membership_id, engagement_id, roster_entry_id, token_hash, access_code_hash, expires_at)
    values (v_project.id, v_membership, v_engagement, v_roster, private.crew_access_token_hash(v_token),
      private.crew_access_code_hash(v_token, v_code), now() + p_valid_for)
    returning * into v_link;
    v_ids := v_ids || v_link.id;
    perform private.emit_event(v_link.org_id, 'crew_access_link.issued', 'crew_access_links', v_link.id, v_link.project_id,
      jsonb_build_object('expires_at', v_link.expires_at));
    return query select v_link.id, v_link.membership_id, v_link.engagement_id, v_link.roster_entry_id,
      (select p.full_name from app.people p where p.id = private.shift_worker_person_id(v_link.membership_id, v_link.engagement_id, v_link.roster_entry_id)),
      v_token, v_code, v_link.expires_at, v_gateway_host;
  end loop;
  perform private.write_audit_event(v_project.org_id, 'crew_access.links_issued', 'app.projects', v_project.id,
    jsonb_build_object('link_ids', to_jsonb(v_ids), 'valid_for', p_valid_for::text));
end;
$$;

comment on function app.issue_crew_access_links(uuid, jsonb, interval) is 'A crew lead (crew.shift.write on the project; 42501 otherwise) issues crew access links, all or nothing: p_workers is [{membership_id | engagement_id | roster_entry_id}], 1 to 200 (crew_access_batch), each naming exactly one worker column (crew_access_worker), a live worker with an upcoming Published or Accepted shift on the project (crew_access_not_working); valid for 1 hour to 30 days, 7 by default (crew_access_validity). Revokes each worker''s earlier live link for the project and writes one crew_access.links_issued audit event. Returns each link with its token (xcrw_ and 64 hex) and 6-digit code, shown once and stored only as hashes, and the org''s verified custom Gateway host when custom domains are in force. A read-only org refuses org_read_only.';

create or replace function app.revoke_crew_access_link(p_link_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.crew_access_links;
begin
  perform private.require_person();
  select * into v_link from app.crew_access_links l where l.id = p_link_id and l.deleted_at is null for update;
  if v_link.id is null or not private.can_on_project(v_link.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project';
  end if;
  if v_link.revoked_at is not null then
    return;
  end if;
  update app.crew_access_links set revoked_at = now() where id = v_link.id;
  perform private.emit_event(v_link.org_id, 'crew_access_link.revoked', 'crew_access_links', v_link.id, v_link.project_id, '{}'::jsonb);
end;
$$;

comment on function app.revoke_crew_access_link(uuid) is 'A crew lead (crew.shift.write on the project) revokes a crew access link at once; revoking twice keeps the first time.';

-- Account deletion --------------------------------------------------------------------------------------------------------

create or replace function private.revoke_crew_access_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Deletion ends memberships and cancels engagements but never touches a roster entry, so every arm is revoked here.
  update app.crew_access_links l set revoked_at = now()
  where l.revoked_at is null and l.deleted_at is null
    and private.shift_worker_person_id(l.membership_id, l.engagement_id, l.roster_entry_id) = new.id;
  return null;
end;
$$;

comment on function private.revoke_crew_access_links() is 'After a person is deleted (account deletion, 1112): revokes their live crew access links on all three worker arms. The worker resolves through private.shift_worker_person_id, which reads unfiltered rows.';
revoke all on function private.revoke_crew_access_links() from public, anon, authenticated;

create trigger t60_revoke_crew_access_links after update of deleted_at on app.people
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.revoke_crew_access_links();

-- Atlas reads --------------------------------------------------------------------------------------------------------------

-- A definer helper, because a view's functions are checked against the caller and the shift worker resolver stays closed.
create or replace function private.crew_access_person_name(p_membership_id uuid, p_engagement_id uuid, p_roster_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pe.full_name from app.people pe where pe.id = private.shift_worker_person_id(p_membership_id, p_engagement_id, p_roster_entry_id);
$$;

comment on function private.crew_access_person_name(uuid, uuid, uuid) is 'The name of a crew access link''s worker, for app.crew_access_link_list, whose row filter is crew.shift.write on the project. NULL once the person deleted their account.';
revoke all on function private.crew_access_person_name(uuid, uuid, uuid) from public, anon;
grant execute on function private.crew_access_person_name(uuid, uuid, uuid) to authenticated, service_role;

create view app.crew_access_link_list as
select l.id, l.org_id, l.project_id, p.name as project_name, l.membership_id, l.engagement_id, l.roster_entry_id,
  private.crew_access_person_name(l.membership_id, l.engagement_id, l.roster_entry_id) as person_name,
  l.expires_at, l.failed_attempts, l.last_opened_at, l.open_count, l.revoked_at,
  case when l.revoked_at is not null then 'Revoked'
       when l.failed_attempts >= 5 then 'Locked'
       when l.expires_at <= now() then 'Expired'
       when not private.crew_access_worker_live(l.org_id, l.project_id, l.membership_id, l.engagement_id, l.roster_entry_id) then 'Closed'
       else 'Live' end as link_status
from app.crew_access_links l
join app.projects p on p.id = l.project_id
where l.deleted_at is null
  and l.project_id in (select private.project_ids_with('crew.shift.write'));

call private.describe('app.crew_access_link_list', 'Crew access links as the Crew access links page reads them (B10): the worker''s name read under definer and the status. Rows follow the link read rule: crew.shift.write on the project. Never a hash.', array[
  'id', 'Link.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'project_name', 'Project name.',
  'membership_id', 'Worker by org membership.',
  'engagement_id', 'Worker by engagement.',
  'roster_entry_id', 'Worker by roster entry.',
  'person_name', 'Worker''s name; NULL once they deleted their account.',
  'expires_at', 'When the link stops working.',
  'failed_attempts', 'Wrong codes entered.',
  'last_opened_at', 'When it was last opened.',
  'open_count', 'How many times it was opened.',
  'revoked_at', 'When it was revoked.',
  'link_status', 'Revoked, Locked, Expired, Closed (the worker stopped working on the project) or Live.'
]);

revoke all on app.crew_access_link_list from public, anon;
revoke select on app.crew_access_link_list from xos_backup;
grant select on app.crew_access_link_list to authenticated, service_role;

create or replace function app.crew_access_workers(p_project_id uuid)
returns table (
  membership_id uuid,
  engagement_id uuid,
  roster_entry_id uuid,
  person_name text,
  next_shift_starts_at timestamptz,
  time_zone text,
  has_live_link boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.org_id into v_org from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null or not private.can_on_project(p_project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project';
  end if;
  return query
    select w.membership_id, w.engagement_id, w.roster_entry_id, pe.full_name, w.starts_at, w.time_zone,
      exists (select 1 from app.crew_access_links l
              where l.project_id = p_project_id and l.revoked_at is null and l.deleted_at is null and l.expires_at > now()
                and l.failed_attempts < 5
                and (l.membership_id = w.membership_id or l.engagement_id = w.engagement_id or l.roster_entry_id = w.roster_entry_id))
    from (
      select distinct on (s.membership_id, s.engagement_id, s.roster_entry_id)
        s.membership_id, s.engagement_id, s.roster_entry_id, s.starts_at, s.time_zone
      from app.shifts s
      where s.project_id = p_project_id and s.deleted_at is null and s.shift_state in ('Published', 'Accepted')
        and s.ends_at > now() and num_nonnulls(s.membership_id, s.engagement_id, s.roster_entry_id) = 1
      order by s.membership_id, s.engagement_id, s.roster_entry_id, s.starts_at
    ) w
    join app.people pe on pe.id = private.shift_worker_person_id(w.membership_id, w.engagement_id, w.roster_entry_id)
      and pe.deleted_at is null
    where private.crew_access_worker_live(v_org, p_project_id, w.membership_id, w.engagement_id, w.roster_entry_id)
    order by pe.full_name, w.starts_at;
end;
$$;

comment on function app.crew_access_workers(uuid) is 'The workers a crew lead can issue a link to on a project (crew.shift.write on the project; 42501 otherwise): live workers with an upcoming Published or Accepted shift, with their name, next shift and its zone, and whether they hold a live link. An agency slot resolves to nobody and is left out.';

-- Resolving ----------------------------------------------------------------------------------------------------------------

create or replace function private.resolve_crew_access_link(p_token text, p_code text)
returns table (link_id uuid, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.crew_access_links;
begin
  perform private.require_read_write();
  select * into v_link from app.crew_access_links l where l.token_hash = private.crew_access_token_hash(p_token) for update;
  if v_link.id is null or v_link.deleted_at is not null or v_link.revoked_at is not null then
    return query select null::uuid, 'crew_access_token_invalid'::text;
    return;
  end if;
  if v_link.failed_attempts >= 5 then
    return query select null::uuid, 'crew_access_token_locked'::text;
    return;
  end if;
  if v_link.access_code_hash <> private.crew_access_code_hash(p_token, p_code) then
    update app.crew_access_links l set failed_attempts = least(l.failed_attempts + 1, 5) where l.id = v_link.id;
    return query select null::uuid,
      (case when v_link.failed_attempts + 1 >= 5 then 'crew_access_token_locked' else 'crew_access_access_code' end)::text;
    return;
  end if;
  if v_link.expires_at <= now() then
    return query select null::uuid, 'crew_access_token_expired'::text;
    return;
  end if;
  if not private.crew_access_worker_live(v_link.org_id, v_link.project_id, v_link.membership_id, v_link.engagement_id, v_link.roster_entry_id) then
    return query select null::uuid, 'crew_access_not_working'::text;
    return;
  end if;
  return query select v_link.id, null::text;
end;
$$;

comment on function private.resolve_crew_access_link(text, text) is 'Resolves a crew access link and its code to the link id, or a refusal reason, in order: invalid (missing, revoked or deleted), locked after 5 wrong codes, wrong code (counted; the fifth locks), expired, or the worker no longer works. Refuses a read-only transaction and locks the row first (1295), and never raises, so the count persists.';
revoke all on function private.resolve_crew_access_link(text, text) from public, anon, authenticated;

-- The public RPCs ----------------------------------------------------------------------------------------------------------

create or replace function api_public.crew_access_shifts(p_token text, p_access_code text)
returns table (
  refusal text,
  reason text,
  org_id uuid,
  org_slug text,
  org_name text,
  person_name text,
  project_name text,
  link_expires_at timestamptz,
  shift_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  time_zone text,
  job_title text,
  scope_node_name text,
  venue_name text,
  venue_street_address text,
  venue_locality text,
  shift_state app.shift_state
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link_id uuid;
  v_reason text;
  v_link app.crew_access_links;
begin
  select r.link_id, r.reason into v_link_id, v_reason from private.resolve_crew_access_link(p_token, p_access_code) r;
  if v_reason is not null then
    return query select 'REFUSE'::text, v_reason, null::uuid, null::text, null::text, null::text, null::text, null::timestamptz, null::uuid,
      null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text, null::text,
      null::app.shift_state;
    return;
  end if;
  update app.crew_access_links l set last_opened_at = now(), open_count = l.open_count + 1 where l.id = v_link_id
  returning * into v_link;
  return query
    with head as (
      select o.id as org_id, o.slug::text as org_slug, o.name as org_name, pe.full_name as person_name, p.name as project_name,
        p.venue_id as project_venue_id
      from app.projects p
      join app.organizations o on o.id = p.org_id
      left join app.people pe on pe.id = private.shift_worker_person_id(v_link.membership_id, v_link.engagement_id, v_link.roster_entry_id)
      where p.id = v_link.project_id
    ), shift_rows as (
      select s.id, s.starts_at, s.ends_at, s.time_zone, xr.job_title::text as job_title, sn.name as scope_node_name,
        v.name as venue_name, v.street_address, v.locality, s.shift_state
      from private.crew_access_worker_shifts(v_link) s
      cross join head h
      left join xpms.role xr on xr.role_code = s.role_code
      left join app.scope_nodes sn on sn.id = s.scope_node_id and sn.deleted_at is null
      left join app.venues v on v.id = coalesce(sn.venue_id, h.project_venue_id) and v.deleted_at is null
      where s.shift_state in ('Published', 'Accepted', 'Canceled')
        and s.ends_at >= now() - interval '12 hours' and s.starts_at <= now() + interval '14 days'
      order by s.starts_at, s.id
      limit 100
    )
    select null::text, null::text, h.org_id, h.org_slug, h.org_name, h.person_name, h.project_name, v_link.expires_at, r.id, r.starts_at,
      r.ends_at, r.time_zone, r.job_title, r.scope_node_name, r.venue_name, r.street_address, r.locality, r.shift_state
    from head h
    left join shift_rows r on true
    order by r.starts_at nulls first, r.id;
end;
$$;

comment on function api_public.crew_access_shifts(text, text) is 'A worker''s shifts through a crew access link and its code, without an account (B10): the org (its id only for Gateway''s brand scope, never rendered), the worker''s name and the project, then each of the worker''s Published, Accepted and Canceled shifts on the project from 12 hours ago to 14 days ahead (at most 100, never a Draft), with its times and zone, the job title, the show and the venue as text. One row with no shift when there is none. Nothing else: no rate, no other worker, no note. Counts the open. Refusals come back as one row with refusal REFUSE and the reason: crew_access_token_invalid, crew_access_token_locked, crew_access_access_code, crew_access_token_expired or crew_access_not_working.';

create or replace function api_public.crew_access_accept_shift(p_token text, p_access_code text, p_shift_id uuid)
returns table (refusal text, reason text, shift_state app.shift_state)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link_id uuid;
  v_reason text;
  v_link app.crew_access_links;
  v_shift app.shifts;
begin
  select r.link_id, r.reason into v_link_id, v_reason from private.resolve_crew_access_link(p_token, p_access_code) r;
  if v_reason is not null then
    return query select 'REFUSE'::text, v_reason, null::app.shift_state;
    return;
  end if;
  select * into v_link from app.crew_access_links l where l.id = v_link_id;
  if private.org_read_only(v_link.org_id) then
    return query select 'REFUSE'::text, 'crew_access_read_only'::text, null::app.shift_state;
    return;
  end if;
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  -- The worker match of app.accept_shift and app.accept_engaged_shift: the shift names the link's one worker column.
  if v_shift.id is null or v_shift.project_id <> v_link.project_id
     or not ((v_link.membership_id is not null and v_shift.membership_id is not distinct from v_link.membership_id)
             or (v_link.engagement_id is not null and v_shift.engagement_id is not distinct from v_link.engagement_id)
             or (v_link.roster_entry_id is not null and v_shift.roster_entry_id is not distinct from v_link.roster_entry_id)) then
    return query select 'REFUSE'::text, 'crew_access_shift_not_yours'::text, null::app.shift_state;
    return;
  end if;
  if v_shift.shift_state <> 'Published' then
    return query select 'REFUSE'::text, 'crew_access_shift_state'::text, v_shift.shift_state;
    return;
  end if;
  perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', v_shift.id, 'Published', 'Accepted', 'Accepted through a crew access link.');
  perform private.write_audit_event(v_shift.org_id, 'crew_access.shift_accepted', 'app.shifts', v_shift.id,
    jsonb_build_object('link_id', v_link.id));
  return query select null::text, null::text, 'Accepted'::app.shift_state;
end;
$$;

comment on function api_public.crew_access_accept_shift(text, text, uuid) is 'The one write of a crew access link (B10): the worker accepts their own Published shift on the link''s project (Published to Accepted, ledger reason ''Accepted through a crew access link.'') and a crew_access.shift_accepted audit event is written. Refusals come back as REFUSE with the reason: the link reasons of api_public.crew_access_shifts, crew_access_read_only (for anyone, signed in or not), crew_access_shift_not_yours or crew_access_shift_state.';

-- Privileges ---------------------------------------------------------------------------------------------------------------

revoke all on function app.issue_crew_access_links(uuid, jsonb, interval) from public, anon;
revoke all on function app.revoke_crew_access_link(uuid) from public, anon;
revoke all on function app.crew_access_workers(uuid) from public, anon;
revoke all on function api_public.crew_access_shifts(text, text) from public;
revoke all on function api_public.crew_access_accept_shift(text, text, uuid) from public;
grant execute on function app.issue_crew_access_links(uuid, jsonb, interval) to authenticated, service_role;
grant execute on function app.revoke_crew_access_link(uuid) to authenticated, service_role;
grant execute on function app.crew_access_workers(uuid) to authenticated, service_role;
grant execute on function api_public.crew_access_shifts(text, text) to anon, authenticated, service_role;
grant execute on function api_public.crew_access_accept_shift(text, text, uuid) to anon, authenticated, service_role;

select private.sync_trash_tables();
