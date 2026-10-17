-- 1132_profile_sections_org_directory.sql
-- A44 Gateway, notification and Compass gaps (RRR-88), finding A38-003 (journeys 61 and 62).
--   * app.share_profile_sections: a person shares chosen sections of their own profile with one org, as a consent
--     snapshot read from the profile itself (headline, bio, pronouns, location, skills, certifications, rates,
--     languages and links). It adds to the share an application carries, or starts one. Sharing is the owner's
--     choice whatever each section's visibility: a Private rate shared with the org applied to reaches that org
--     only (Section 4.8.3: Private is the owner and the orgs the owner shared it with). Field keys are
--     profile.<section>; the org reads them through app.profile_share_fields' existing policy
--   * app.explore_organizations: Public organization profiles for Gateway's Explore, with the verified badge,
--     the verified domain and the count of Public opportunities open now. Signed-in people only; indexing stays
--     the profile's own search_indexing (off by default)

create or replace function private.profile_section_value(p_person_id uuid, p_section app.profile_section)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case p_section
    when 'headline' then (select p.headline from app.person_profiles p where p.person_id = p_person_id and p.deleted_at is null)
    when 'bio' then (select p.bio from app.person_profiles p where p.person_id = p_person_id and p.deleted_at is null)
    when 'pronouns' then (select p.pronouns from app.person_profiles p where p.person_id = p_person_id and p.deleted_at is null)
    when 'location' then (select nullif(concat_ws(', ', p.city, p.country_code), '') from app.person_profiles p
                          where p.person_id = p_person_id and p.deleted_at is null)
    when 'rates' then (select case when p.rate_minor is not null then
                         jsonb_build_object('amount_minor', p.rate_minor, 'currency', p.rate_currency, 'unit', p.rate_unit)::text end
                       from app.person_profiles p where p.person_id = p_person_id and p.deleted_at is null)
    when 'skills' then (select string_agg(d.category, '; ' order by s.sort_order, d.category) from app.person_skills s
                        join xpms.dim_category d on d.cat_urid = s.cat_urid
                        where s.person_id = p_person_id and s.deleted_at is null)
    when 'certifications' then (select string_agg(c.name || ' (' || c.issuing_body || ')', '; ' order by c.name)
                                from app.person_certifications c where c.person_id = p_person_id and c.deleted_at is null)
    when 'languages' then (select string_agg(l.language_tag || ' ' || l.proficiency::text, '; ' order by l.language_tag)
                           from app.person_languages l where l.person_id = p_person_id and l.deleted_at is null)
    when 'links' then (select string_agg(k.label || ': ' || k.url, '; ' order by k.sort_order, k.label)
                       from app.person_links k where k.person_id = p_person_id and k.deleted_at is null)
  end;
$$;

comment on function private.profile_section_value(uuid, app.profile_section) is 'A section of a person''s own profile as one snapshot value: text for headline, bio, pronouns and location; a JSON object of amount_minor, currency and unit for rates; semicolon-separated lists for skills, certifications, languages and links. NULL when the section is empty.';

create or replace function app.share_profile_sections(p_org_id uuid, p_profile_share_id uuid, p_sections app.profile_section[])
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_share app.profile_shares;
  v_section app.profile_section;
begin
  if coalesce(cardinality(p_sections), 0) = 0 then
    perform private.refuse('profile_share_sections', 'Choose at least one profile section to share.');
  end if;
  if exists (select 1 from unnest(p_sections) s where s in ('photo', 'portfolio', 'availability', 'references', 'organizations')) then
    perform private.refuse('profile_share_section_kind', 'Photo, portfolio, availability, references and organizations are not shared this way.');
  end if;
  if p_profile_share_id is null then
    insert into app.profile_shares (org_id, person_id) values (p_org_id, v_me) returning * into v_share;
  else
    select s.* into v_share from app.profile_shares s where s.id = p_profile_share_id and s.deleted_at is null;
    if v_share.id is null or v_share.person_id is distinct from v_me then
      raise exception using errcode = '42501', message = 'only the person who gave a share adds to it';
    end if;
    if v_share.revoked_at is not null then
      perform private.refuse('profile_share_revoked', 'This share was revoked. Share your profile again.');
    end if;
    if v_share.org_id <> p_org_id then
      perform private.refuse('profile_share_org', 'A share goes to one org.');
    end if;
  end if;
  foreach v_section in array (select array_agg(distinct s) from unnest(p_sections) s) loop
    insert into app.profile_share_fields (profile_share_id, field_key, field_value)
    values (v_share.id, 'profile.' || v_section::text, left(private.profile_section_value(v_me, v_section), 4000))
    on conflict (profile_share_id, field_key) where deleted_at is null do update set field_value = excluded.field_value;
  end loop;
  return v_share.id;
end;
$$;

comment on function app.share_profile_sections(uuid, uuid, app.profile_section[]) is 'Shares chosen sections of the signed-in person''s own profile with one org (journey 61): adds a snapshot field profile.<section> per section, read from the profile, to the person''s own unrevoked share for that org, or starts a share when none is given. Returns the share id. The org reads the fields through app.profile_share_fields.';

-- Explore: Public organization profiles ----------------------------------------------------------------------------

create or replace function app.explore_organizations(p_query text default null, p_limit integer default 24)
returns table (
  handle text,
  name text,
  about text,
  logo_path text,
  verified boolean,
  verified_domain text,
  open_opportunities integer,
  indexable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.handle, o.name, p.about, p.logo_path, private.organization_verified(p.org_id),
    (select d.hostname from app.org_domains d
     where d.org_id = p.org_id and d.deleted_at is null and d.purpose = 'Verified Domain' and d.verification_state = 'Verified'
     order by d.verified_at limit 1),
    (select count(*)::int from app.opportunities op
     where op.org_id = p.org_id and op.deleted_at is null and op.opportunity_state = 'Published' and op.visibility = 'Public'),
    p.search_indexing
  from app.organization_profiles p
  join app.organizations o on o.id = p.org_id and o.deleted_at is null
  where p.deleted_at is null and p.visibility = 'Public' and private.current_person_id() is not null
    and (nullif(btrim(p_query), '') is null
         or o.name ilike '%' || btrim(p_query) || '%' or coalesce(p.about, '') ilike '%' || btrim(p_query) || '%')
  order by o.name
  limit least(greatest(coalesce(p_limit, 24), 1), 100);
$$;

comment on function app.explore_organizations(text, integer) is 'Public organization profiles for Gateway Explore (journey 62), signed-in only: name, about, logo, the verified badge, the verified domain and how many Public opportunities are open. indexable is the profile''s own search_indexing, off unless the org turns it on.';

revoke all on function private.profile_section_value(uuid, app.profile_section) from public, anon, authenticated;
revoke all on function app.share_profile_sections(uuid, uuid, app.profile_section[]) from public, anon;
grant execute on function app.share_profile_sections(uuid, uuid, app.profile_section[]) to authenticated, service_role;
revoke all on function app.explore_organizations(text, integer) from public, anon;
grant execute on function app.explore_organizations(text, integer) to authenticated, service_role;
