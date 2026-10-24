-- 1332_sso_join_and_scim_users.sql
-- A77 Authentication and step-up (RRR-122; finding A65-002, Section 9 "Enterprise SAML SSO and SCIM provisioning are
-- available on the Enterprise plan"). 0638 holds identity providers, just-in-time joins and the SCIM handlers; two pieces
-- were missing for the sign-in path and the SCIM endpoint:
--   * app.join_by_sso_session(): after a single sign-on, Atlas's callback asks which org the session's identity provider
--     belongs to. The provider id comes from the sign-in itself (auth.users app metadata `sso:<provider id>`), so the
--     caller cannot name another org. When the provider joins people just in time, the person joins with its default
--     role through app.join_by_sso (0638), so the plan limits, the Owner rule and the membership guards still apply.
--   * app.scim_user_for_email(email): the SCIM Edge Function finds the auth user an identity provider pushes before it
--     creates one. Service role only, like the other SCIM functions.

create or replace function app.join_by_sso_session()
returns table (org_id uuid, slug text, joined boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_claim text;
  v_provider app.identity_providers;
  v_member boolean;
begin
  select u.raw_app_meta_data ->> 'provider' into v_claim from auth.users u where u.id = (select auth.uid());
  if v_claim is null or v_claim not like 'sso:%' then
    return;
  end if;
  select * into v_provider from app.identity_providers p
  where p.auth_provider_id = substr(v_claim, 5) and p.deleted_at is null;
  if v_provider.id is null then
    return;
  end if;
  select exists (
    select 1 from app.memberships m
    where m.org_id = v_provider.org_id and m.person_id = v_me and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) into v_member;
  if not v_member then
    if not v_provider.jit_enabled or not private.org_has_feature(v_provider.org_id, 'saml_sso') then
      return;
    end if;
    perform app.join_by_sso(v_provider.org_id);
  end if;
  return query select o.id, o.slug, not v_member from app.organizations o where o.id = v_provider.org_id and o.deleted_at is null;
end;
$$;

comment on function app.join_by_sso_session() is 'After a single sign-on (Section 9): the org whose identity provider signed the caller in, joining it with the provider''s default role when the provider adds people just in time (app.join_by_sso, 0638). The provider comes from the sign-in''s own app metadata. No row when the session is not a single sign-on, the provider is unknown, or it does not add people and the caller is not a member.';
revoke all on function app.join_by_sso_session() from public, anon;
grant execute on function app.join_by_sso_session() to authenticated;

create or replace function app.scim_user_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u
  where lower(u.email) = lower(btrim(p_email)) and u.deleted_at is null
  order by u.created_at
  limit 1;
$$;

comment on function app.scim_user_for_email(text) is 'SCIM endpoint: the sign-in that holds an email address, so provisioning reuses an existing account instead of creating a second one. Service role only.';
revoke all on function app.scim_user_for_email(text) from public, anon, authenticated;
grant execute on function app.scim_user_for_email(text) to service_role;
