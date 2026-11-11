-- 4.11 fix (crawl 4.9, RRR-243): only an Account Owner removes an Account Owner from a company account. Granting
-- and removing the Owner role already keep to the Owner band (app.add_account_member and app.remove_account_role,
-- 0710: 'only an Owner grants Owner', 'only an Owner removes Owner'), but app.end_account_membership checked only that
-- the caller was an Owner or Admin, so an Account Admin could end an Owner's whole membership whenever another Owner
-- remained (only sole_account_owner stopped it). It now refuses an Admin who ends someone else's membership that holds
-- Account Owner (account_role_band). A member leaving, an Owner leaving while another Owner stays, and an Owner or
-- Admin removing a member who is not an Owner behave as before. The definition starts from 0710, the only one; the
-- signature, security definer, search_path, grants and description stay, and the description now says so.
create or replace function app.end_account_membership(p_account_membership_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_member app.account_memberships;
begin
  select * into v_member from app.account_memberships m where m.id = p_account_membership_id and m.deleted_at is null;
  if v_member.id is null then
    raise exception using errcode = '42501', message = 'account membership not found';
  end if;
  if v_member.person_id <> v_me then
    perform private.assert_account_admin(v_member.org_id);
    if exists (
        select 1 from app.account_membership_roles r
        where r.account_membership_id = v_member.id and r.account_role = 'Account Owner' and r.deleted_at is null)
       and not exists (select 1 from private.account_role(v_member.org_id) r where r = 'Account Owner') then
      perform private.refuse('account_role_band', 'Only an Account Owner removes Account Owner.');
    end if;
  end if;
  update app.account_memberships set valid_to = now() where id = v_member.id and (valid_to is null or valid_to > now());
end;
$$;

comment on function app.end_account_membership(uuid) is 'Ends an account membership at once: a member leaving, or an Account Owner or Admin removing them. Only an Account Owner removes a member who holds Account Owner (account_role_band), and the last Account Owner cannot leave.';

revoke all on function app.end_account_membership(uuid) from public, anon;
grant execute on function app.end_account_membership(uuid) to authenticated, service_role;
