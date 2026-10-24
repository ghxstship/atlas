-- 1500_compass_org_brands.sql
-- A93 (RRR-138, A65-011 parts 3 and 4): Compass applies each org's brand at runtime after sign-in (Section 12
-- Mobile) and shows an org's brand chip beside its items on the combined Today (Section 4.5.7 org switching).
--
-- app.my_org_brands returns the public half of the brand (private.public_brand, with the partner inheritance
-- of 1060) for every org the signed-in person works in: orgs where they hold an active membership and orgs
-- whose engagements they reach as an external party. app.org_brands itself stays readable only by members
-- (0850), so an engaged freelancer never reads another org's brand row, only these public fields, which
-- api_public.org_brand_for_slug already serves anonymously. Nothing here writes; app.org_brands is unchanged.

create or replace function app.my_org_brands()
returns table (
  org_id uuid,
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
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
  select o.org_id, b.org_slug, b.name, b.logo_light_path, b.logo_dark_path, b.accent_hex, b.neutral_tint_hex,
    b.font_family, b.radius_scale, b.suppress_powered_by
  from (
    select m.org_id from private.my_org_ids() as m (org_id)
    union
    select e.org_id from app.engagements e
    where e.deleted_at is null and e.id in (select private.my_engagement_ids('engagement'))
  ) o
  cross join lateral private.public_brand(o.org_id) b
  order by b.name, o.org_id;
$$;

comment on function app.my_org_brands() is 'Compass runtime brand (Section 12 Mobile, Section 4.5.7 org switching): the public brand fields (name, logos, accent, neutral tint, font, radius, Powered by XOS) of every org the signed-in person holds an active membership in or reaches through an engagement. Org brands inherit from a partner as private.public_brand resolves them; nothing for any other org.';
revoke all on function app.my_org_brands() from public, anon;
grant execute on function app.my_org_brands() to authenticated, service_role;
