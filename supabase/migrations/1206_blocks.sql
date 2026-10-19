-- 1206_blocks.sql
-- A52 settings features (RRR-97, ADR 0032 amendment). Personal settings, Profile Privacy (Section 4.5.6) lists "blocked
-- people and organizations", and Section 7.3 names `blocks` beside the profile tables. A50 retired the blocks resource
-- because no section said what a block hides or where it is enforced. This migration defines it and enforces it where
-- profiles are read:
--   * app.blocks: a person blocks another person or an organization by URN (urn:xpms:person:{id} or
--     urn:xpms:organization:{id}). Only the person reads and writes their own blocks; nobody blocks themselves or an
--     organization they belong to. Unblocking is deleting the row.
--   * What a block hides (Section 4.8.3 profile visibility, extended):
--       - the blocker's person profile, every section of it and every profile RPC built on it, from the blocked person and
--         from every member of a blocked organization, whatever the profile's visibility level;
--       - the blocked person's profile from the blocker, and a blocked organization's profile from the blocker, so the
--         block works both ways.
--     Enforcement is in private.profile_visible_to_me and private.org_profile_visible_to_me, which every api_public
--     profile RPC already calls; signed-in callers cannot read another person's profile row directly (0860).
--   * A block never ends a membership, an engagement or the messages that belong to one: work an org and a person already
--     share continues under its own rules (Section 4.4.4).

create table app.blocks (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  blocked_urn text not null,
  blocked_person_id uuid references app.people (id),
  blocked_organization_id uuid references app.organizations (id),
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint blocks_one_target check (num_nonnulls(blocked_person_id, blocked_organization_id) = 1),
  constraint blocks_urn_format check (blocked_urn ~ '^urn:xpms:(person|organization):[0-9a-f-]{36}$')
);

create unique index blocks_person_urn_key on app.blocks (person_id, blocked_urn) where deleted_at is null;
create index blocks_blocked_person_idx on app.blocks (blocked_person_id) where deleted_at is null;
create index blocks_blocked_organization_idx on app.blocks (blocked_organization_id) where deleted_at is null;
create index blocks_created_by_idx on app.blocks (created_by);
create index blocks_updated_by_idx on app.blocks (updated_by);

call private.install_audit_columns('app.blocks');
call private.describe('app.blocks', 'People and organizations a person has blocked (Section 4.5.6 Profile Privacy). A block hides the blocker''s profile from the blocked person and from every member of a blocked organization, and hides the blocked profile from the blocker. It never ends a membership or an engagement. Read and written only by the blocker.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Person who blocked, from the session.',
  'blocked_urn', 'URN of the blocked profile: urn:xpms:person:{id} or urn:xpms:organization:{id}.',
  'blocked_person_id', 'Blocked person, resolved from the URN; NULL when an organization is blocked.',
  'blocked_organization_id', 'Blocked organization, resolved from the URN; NULL when a person is blocked.',
  'created_at', 'When the block was made.',
  'created_by', 'Person who made it.',
  'updated_at', 'When it last changed.',
  'updated_by', 'Person who last changed it.',
  'deleted_at', 'When the person unblocked; the block no longer applies.'
]);

alter table app.blocks enable row level security;
revoke all on app.blocks from public, anon, authenticated;
grant select on app.blocks to authenticated;
grant insert (blocked_urn) on app.blocks to authenticated;
grant update (deleted_at) on app.blocks to authenticated;
grant all on app.blocks to service_role;

create policy blocks_owner_read on app.blocks for select to authenticated
  using (person_id = (select private.current_person_id()));
create policy blocks_owner_insert on app.blocks for insert to authenticated
  with check (person_id = (select private.current_person_id()));
create policy blocks_owner_update on app.blocks for update to authenticated
  using (person_id = (select private.current_person_id()))
  with check (person_id = (select private.current_person_id()));

create or replace function private.guard_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_key text;
  v_id uuid;
begin
  if tg_op = 'UPDATE' then
    if new.person_id <> old.person_id or new.blocked_urn <> old.blocked_urn then
      perform private.refuse('block_immutable', 'Unblock and block again instead of changing a block.');
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      perform private.refuse('block_immutable', 'Block again with a new row.');
    end if;
    return new;
  end if;

  new.person_id := coalesce(private.current_person_id(), new.person_id);
  select u.kind, lower(u.key) into v_kind, v_key from xpms.urn_parse(btrim(new.blocked_urn)) u;
  begin
    v_id := v_key::uuid;
  exception when invalid_text_representation then
    v_id := null;
  end;
  if v_kind not in ('person', 'organization') or v_id is null then
    perform private.refuse('block_target', 'Block a person (urn:xpms:person:{id}) or an organization (urn:xpms:organization:{id}).');
  end if;
  new.blocked_urn := 'urn:xpms:' || v_kind || ':' || v_id::text;
  if v_kind = 'person' then
    if not exists (select 1 from app.people p where p.id = v_id and p.deleted_at is null) then
      perform private.refuse('block_target', 'No such person.');
    end if;
    if v_id = new.person_id then
      perform private.refuse('block_self', 'A person cannot block themselves.');
    end if;
    new.blocked_person_id := v_id;
    new.blocked_organization_id := null;
  else
    if not exists (select 1 from app.organizations o where o.id = v_id) then
      perform private.refuse('block_target', 'No such organization.');
    end if;
    if exists (select 1 from app.memberships m where m.person_id = new.person_id and m.org_id = v_id and m.deleted_at is null
                 and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
       or exists (select 1 from app.account_memberships a where a.person_id = new.person_id and a.org_id = v_id
                    and a.deleted_at is null and (a.valid_to is null or a.valid_to > now())) then
      perform private.refuse('block_own_org', 'Leave an organization before blocking it.');
    end if;
    new.blocked_organization_id := v_id;
    new.blocked_person_id := null;
  end if;
  return new;
end;
$$;

comment on function private.guard_block() is 'Blocks: the blocker is the session person; the URN must name an existing person or organization, never the blocker or an organization they belong to; the target is resolved into blocked_person_id or blocked_organization_id; a block never changes target or comes back once lifted.';
revoke all on function private.guard_block() from public, anon, authenticated;

create trigger t40_guard_block before insert or update on app.blocks
  for each row execute function private.guard_block();

-- Enforcement ------------------------------------------------------------------------------------------------------------

create or replace function private.blocked_between(p_viewer_id uuid, p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer_id is not null and p_owner_id is not null and p_viewer_id <> p_owner_id and (
    exists (select 1 from app.blocks b where b.deleted_at is null
              and ((b.person_id = p_owner_id and b.blocked_person_id = p_viewer_id)
                or (b.person_id = p_viewer_id and b.blocked_person_id = p_owner_id)))
    or exists (select 1 from app.blocks b
               join app.memberships m on m.org_id = b.blocked_organization_id and m.person_id = p_viewer_id
                 and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
               where b.person_id = p_owner_id and b.deleted_at is null)
    or exists (select 1 from app.blocks b
               join app.account_memberships a on a.org_id = b.blocked_organization_id and a.person_id = p_viewer_id
                 and a.deleted_at is null and (a.valid_to is null or a.valid_to > now())
               where b.person_id = p_owner_id and b.deleted_at is null));
$$;

comment on function private.blocked_between(uuid, uuid) is 'True when a block stands between a viewer and a person profile''s owner: either person blocked the other, or the owner blocked an organization the viewer belongs to (membership or account membership).';
revoke all on function private.blocked_between(uuid, uuid) from public, anon, authenticated;

create or replace function private.profile_visible_to_me(p_person_id uuid, p_visibility app.profile_visibility)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_person_id() = p_person_id, false)
    or (not private.blocked_between(private.current_person_id(), p_person_id)
        and (p_visibility = 'Public'
             or (p_visibility = 'Network' and private.in_network(private.current_person_id(), p_person_id))));
$$;

comment on function private.profile_visible_to_me(uuid, app.profile_visibility) is 'True when the signed-in person or anon may see a person profile at all: always the owner; otherwise its visibility decides, unless a block stands between them (1206).';

create or replace function private.org_profile_visible_to_me(p_org_id uuid, p_visibility app.profile_visibility)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.belongs_to_org(p_org_id)
    or (not exists (select 1 from app.blocks b
                    where b.person_id = private.current_person_id() and b.blocked_organization_id = p_org_id
                      and b.deleted_at is null)
        and (p_visibility = 'Public'
             or (p_visibility = 'Network' and private.org_in_network(private.current_person_id(), p_org_id))));
$$;

comment on function private.org_profile_visible_to_me(uuid, app.profile_visibility) is 'True when the viewer may see an organization profile: always to its own members; otherwise Public to everyone and Network to its network, unless the viewer blocked the organization (1206).';

-- Account deletion (1112) soft-deletes the person: the blocks they made go with their account.
create or replace function private.drop_blocks_of_deleted_person()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from app.blocks b where b.person_id = new.id;
  return null;
end;
$$;

comment on function private.drop_blocks_of_deleted_person() is 'After a person is deleted (account deletion, 1112): removes the blocks they made, personal data that leaves with the account.';
revoke all on function private.drop_blocks_of_deleted_person() from public, anon, authenticated;

create trigger t80_drop_blocks_of_deleted_person after update of deleted_at on app.people
  for each row when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.drop_blocks_of_deleted_person();
