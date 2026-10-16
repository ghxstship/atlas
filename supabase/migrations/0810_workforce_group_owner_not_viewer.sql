-- 0810_workforce_group_owner_not_viewer.sql
-- A29 Workforce Suite. A group Owner adds, changes and removes the group's members, which are other
-- people's rows. Under the rule that no Viewer updates another person's rows (Wave 6 security
-- review), ownership grants that only to a membership holding a role other than Viewer: a Viewer
-- made Owner keeps reading the group and its chat but cannot edit its members. Communication
-- managers (org.communication.write) are unchanged.

create or replace function private.my_owned_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select gm.group_id from app.group_members gm
  where gm.deleted_at is null
    and gm.group_role = 'Owner'
    and gm.membership_id in (select private.my_membership_ids())
    and exists (
      select 1 from app.membership_roles mr
      join app.roles r on r.id = mr.role_id
      where mr.membership_id = gm.membership_id
        and mr.deleted_at is null
        and r.deleted_at is null
        and r.code <> 'viewer'
    );
$$;

comment on function private.my_owned_group_ids() is 'Groups the signed-in person owns through a membership with a role other than Viewer; a Viewer Owner cannot edit members (0810).';
revoke all on function private.my_owned_group_ids() from public, anon;
grant execute on function private.my_owned_group_ids() to authenticated, service_role;
