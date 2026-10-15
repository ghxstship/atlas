-- 0931_brand_lookup_org_id.sql
-- Orchestrator correction to A30's 0850. Gateway scopes api_external rows by org_id, so the public brand
-- lookups also return the org id. An org id is not secret: invites, sign-in and token pages already
-- reveal which org they belong to. The return type changes, so the functions are dropped and recreated.

drop function api_public.org_brand_for_host(text);
drop function api_public.org_brand_for_slug(text);

create function api_public.org_brand_for_host(p_host text)
returns table (
  org_id uuid,
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  suppress_powered_by boolean,
  surface app.org_domain_purpose
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.org_id, b.*, d.purpose
  from app.org_domains d
  cross join lateral private.public_brand(d.org_id) b
  where d.hostname = lower(btrim(p_host)) and d.purpose in ('Atlas', 'Gateway')
    and d.verification_state = 'Verified' and d.deleted_at is null
    and private.org_has_feature(d.org_id, 'custom_domain');
$$;

comment on function api_public.org_brand_for_host(text) is 'White label lookup by request host (Section 4.4.7): the org id and brand of the org whose verified custom Atlas or Gateway domain the host is, with the surface it serves. Returns nothing for any other host, and nothing once the plan no longer includes custom domains.';
revoke all on function api_public.org_brand_for_host(text) from public;
grant execute on function api_public.org_brand_for_host(text) to anon, authenticated, service_role;

create function api_public.org_brand_for_slug(p_org_slug text)
returns table (
  org_id uuid,
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  suppress_powered_by boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, b.* from app.organizations o cross join lateral private.public_brand(o.id) b
  where o.slug = p_org_slug and o.deleted_at is null;
$$;

comment on function api_public.org_brand_for_slug(text) is 'White label lookup by org slug, for branded invite, sign-in and token pages on the platform domain. Returns the org id and the public brand fields.';
revoke all on function api_public.org_brand_for_slug(text) from public;
grant execute on function api_public.org_brand_for_slug(text) to anon, authenticated, service_role;
