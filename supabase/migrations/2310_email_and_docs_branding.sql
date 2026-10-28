-- 2310_email_and_docs_branding.sql
--
-- A138 (RRR-201), trace row S12-01, Section 12: "Brand per org applied on Atlas, Gateway, emails, PDFs, the docs site
-- (Enterprise) and Compass." Atlas, Gateway, PDFs and Compass already wear an org's brand; this adds the two lookups
-- notification email and the docs site read (ADR 0066):
--   * app.email_brand_for_org: what the notification worker (the service role) puts on an org's email while white
--     label is in force for it (private.white_label_in_force, 1355, so a downgrade grace keeps it to the end of the
--     paid period): the brand name and logo, the accent after partner inheritance (private.public_brand), the sender
--     name and the support address replies go to. Without white label in force it returns nothing and the email
--     wears the platform brand, as it did before.
--   * api_public.docs_brand_for_slug: the docs site's public lookup, for anyone. It returns only an Enterprise org's
--     name, logos and accent, and only while white label is in force, so nothing about an org without a branded
--     docs site, nor whether it exists, can be read through it.
-- Both read private.public_brand (latest definition 1355) and redefine nothing.

-- Plan gate ------------------------------------------------------------------------------------------------------------

create or replace function private.docs_brand_in_force(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.white_label_in_force(p_org_id, 'white_label')
    and exists (select 1 from private.org_plan_limits l where l.org_id = p_org_id and l.plan_code = 'enterprise');
$$;

comment on function private.docs_brand_in_force(uuid) is 'True while an org''s docs site wears its brand (Section 12, the docs site is Enterprise): its plan in force is Enterprise (a live Plan override''s or the subscription''s) and white label is in force. A downgrade below Enterprise reverts the docs site at once; emails keep the brand while white label stays in force.';
revoke all on function private.docs_brand_in_force(uuid) from public, anon, authenticated;

-- Email ----------------------------------------------------------------------------------------------------------------

create or replace function app.email_brand_for_org(p_org_id uuid)
returns table (
  brand_name text,
  sender_name text,
  reply_to text,
  logo_path text,
  accent_hex text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pb.name,
    coalesce(b.email_sender_name, pb.name),
    b.support_email,
    pb.logo_light_path,
    pb.accent_hex
  from app.organizations o
  cross join lateral private.public_brand(o.id) pb
  left join app.org_brands b on b.org_id = o.id and b.deleted_at is null
  where o.id = p_org_id and o.deleted_at is null
    and private.white_label_in_force(o.id, 'white_label');
$$;

comment on function app.email_brand_for_org(uuid) is 'Worker API (service role): the brand an org''s notification email wears while white label is in force (Section 12): the brand name, the From name (email_sender_name, else the brand name), the support address replies go to, the light logo''s path in the org-brand bucket and the accent after partner inheritance. No row without white label in force; the email then wears the platform brand. The worker drops an accent that fails the email contrast check.';
revoke all on function app.email_brand_for_org(uuid) from public, anon, authenticated;
grant execute on function app.email_brand_for_org(uuid) to service_role;

-- Docs site ------------------------------------------------------------------------------------------------------------

create or replace function api_public.docs_brand_for_slug(p_org_slug text)
returns table (
  name text,
  logo_light_path text,
  logo_dark_path text,
  accent_hex text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pb.name, pb.logo_light_path, pb.logo_dark_path, pb.accent_hex
  from app.organizations o
  cross join lateral private.public_brand(o.id) pb
  where o.slug = lower(btrim(p_org_slug)) and o.deleted_at is null
    and private.docs_brand_in_force(o.id);
$$;

comment on function api_public.docs_brand_for_slug(text) is 'Docs site white label (Section 12, Enterprise): the brand name, light and dark logo paths in the public org-brand bucket and the accent of the org with this slug, while it is on Enterprise with white label in force. Returns nothing for any other slug, so it never says whether an org exists. The docs site applies the accent only when it passes the contrast gate.';
revoke all on function api_public.docs_brand_for_slug(text) from public;
grant execute on function api_public.docs_brand_for_slug(text) to anon, authenticated, service_role;
