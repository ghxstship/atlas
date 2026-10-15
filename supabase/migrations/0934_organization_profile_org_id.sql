-- 0934_organization_profile_org_id.sql
-- Orchestrator correction to A30's 0860. Gateway lists an org's open opportunities on /c/{handle} by org_id
-- (api_external rows are keyed by it), so the public organization profile also returns the org id. As with
-- the brand lookups (0931), an org id is not secret. The return type changes, so the function is recreated.

drop function api_public.organization_profile(text);

create function api_public.organization_profile(p_handle text)
returns table (
  org_id uuid,
  handle text,
  redirected boolean,
  name text,
  about text,
  logo_path text,
  cover_path text,
  website_url text,
  contact_email text,
  verified boolean,
  visibility app.profile_visibility,
  indexable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id, p.handle, p.handle <> lower(btrim(p_handle)), o.name, p.about, p.logo_path, p.cover_path, p.website_url, p.contact_email,
    private.organization_verified(p.org_id), p.visibility, p.visibility = 'Public' and p.search_indexing
  from private.organization_profile_by_handle(p_handle) p
  join app.organizations o on o.id = p.org_id and o.deleted_at is null
  where p.id is not null and private.org_profile_visible_to_me(p.org_id, p.visibility);
$$;

comment on function api_public.organization_profile(text) is 'An organization''s profile at /c/{handle} (Section 4.8.2) as the viewer may see it, with its org id and the verified badge (business identity). Follows a redirect from an old handle.';
revoke all on function api_public.organization_profile(text) from public;
grant execute on function api_public.organization_profile(text) to anon, authenticated, service_role;
