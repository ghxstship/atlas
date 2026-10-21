-- 0230_demo_settings_profiles.sql
-- A30 Identity, Profiles and Settings. The demo tenant's settings, brand, domains, legal acceptances, profiles
-- and verification (Section 19.6: a demo tenant seed exercises every feature). Builds on 0010_demo_identity.sql
-- and loads cleanly without it. Idempotent: every insert checks for its row first. Canon values (category URIDs,
-- jurisdictions) are read from xpms.

do $$
declare
  v_org constant uuid := '01920000-0000-7000-8000-000000000001';
  v_vendor constant uuid := '01920000-0000-7000-8000-000000000301';
  v_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  v_admin constant uuid := '01920000-0000-7000-8000-000000000102';
  v_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  v_field constant uuid := '01920000-0000-7000-8000-000000000104';
  v_crew constant uuid := '01920000-0000-7000-8000-000000000201';
  v_vendor_contact constant uuid := '01920000-0000-7000-8000-000000000302';
  v_workspace constant uuid := '01920000-0000-7000-8000-000000000401';
  v_domain uuid;
  v_cert uuid;
  v_holder uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = v_org) then
    return;
  end if;

  -- Settings: the time zone is locked at org level (journey 63); kiosks are on for the org (the Compass kiosk
  -- journey); Miami rounds punches to 15 minutes and asks kiosks for a photo on every punch.
  insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text, locked)
  select v_org, s.key, 'Organization', v_org, s.value, s.locked
  from (values
    ('locale.time_zone', 'America/New_York', true),
    ('org.legal_name', 'Demo Productions LLC', false),
    ('payroll.pay_period', 'weekly', false),
    ('gateway.marketplace_visibility', 'public', false),
    ('help.support_email', 'support@example.com', false)
  ) as s (key, value, locked)
  where not exists (select 1 from app.setting_values v where v.org_id = v_org and v.setting_key = s.key
    and v.scope_kind = 'Organization' and v.deleted_at is null);
  insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text)
  select v_org, 'time.rounding_minutes', 'Workspace', v_workspace, '15'
  where exists (select 1 from app.workspaces w where w.id = v_workspace)
    and not exists (select 1 from app.setting_values v where v.setting_key = 'time.rounding_minutes'
      and v.scope_kind = 'Workspace' and v.scope_id = v_workspace and v.deleted_at is null);
  insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_boolean)
  select v_org, 'time.photo_on_punch', 'Workspace', v_workspace, true
  where exists (select 1 from app.workspaces w where w.id = v_workspace)
    and not exists (select 1 from app.setting_values v where v.setting_key = 'time.photo_on_punch'
      and v.scope_kind = 'Workspace' and v.scope_id = v_workspace and v.deleted_at is null);
  insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_boolean)
  select v_org, 'time.kiosk_enabled', 'Organization', v_org, true
  where not exists (select 1 from app.setting_values v where v.org_id = v_org and v.setting_key = 'time.kiosk_enabled'
    and v.scope_kind = 'Organization' and v.deleted_at is null);
  insert into app.personal_setting_values (person_id, org_id, setting_key, value_text)
  select v_producer, v_org, 'me.persona', 'producer'
  where not exists (select 1 from app.personal_setting_values p where p.person_id = v_producer and p.setting_key = 'me.persona'
    and p.deleted_at is null);
  insert into app.personal_setting_values (person_id, setting_key, value_text)
  select v_field, 'me.theme', 'dark'
  where not exists (select 1 from app.personal_setting_values p where p.person_id = v_field and p.setting_key = 'me.theme'
    and p.deleted_at is null);

  -- Brand and domains: the Team plan includes white label and custom domains.
  insert into app.org_brands (org_id, display_name, email_sender_name, support_email, legal_entity_name, suppress_powered_by)
  select v_org, 'Demo Productions', 'Demo Productions', 'support@example.com', 'Demo Productions LLC', true
  where not exists (select 1 from app.org_brands b where b.org_id = v_org and b.deleted_at is null);
  if not exists (select 1 from app.org_domains d where d.org_id = v_org and d.hostname = 'gateway.example.com' and d.deleted_at is null) then
    insert into app.org_domains (org_id, hostname, purpose) values (v_org, 'gateway.example.com', 'Gateway') returning id into v_domain;
    perform app.record_domain_verification(v_domain, true);
  end if;
  insert into app.org_domains (org_id, hostname, purpose)
  select v_org, 'atlas.example.com', 'Atlas'
  where not exists (select 1 from app.org_domains d where d.org_id = v_org and d.hostname = 'atlas.example.com' and d.deleted_at is null);

  -- Legal acceptances recorded when the Owner created the org.
  insert into app.legal_acceptances (org_id, person_id, user_id, document_slug, document_version, ip)
  select v_org, v_owner, v_owner, d.slug, '1.0.0-draft', '203.0.113.10'
  from (values ('terms-of-service'), ('data-processing-agreement')) as d (slug)
  where not exists (select 1 from app.legal_acceptances a where a.org_id = v_org and a.document_slug = d.slug);

  -- Favorites.
  insert into app.favorites (org_id, person_id, node_id, sort_order)
  select v_org, v_producer, f.node, f.ord
  from (values ('projects', 0), ('schedule', 1)) as f (node, ord)
  where not exists (select 1 from app.favorites x where x.person_id = v_producer and x.org_id = v_org and x.node_id = f.node
    and x.deleted_at is null);

  -- Person profiles.
  insert into app.person_profiles (person_id, handle, headline, city, country_code, visibility)
  select p.id, p.handle, p.headline, 'Miami', 'US', p.visibility::app.profile_visibility
  from (values
    (v_owner, 'demo-owner', 'Founder and executive producer', 'Network'),
    (v_admin, 'demo-admin', 'Operations and systems', 'Private'),
    (v_producer, 'demo-producer', 'Producer, festivals and tours', 'Network'),
    (v_field, 'demo-field-lead', 'Field lead, load-in and strike', 'Network'),
    (v_crew, 'demo-crew', 'Rigger and stagehand, arena and festival', 'Public')
  ) as p (id, handle, headline, visibility)
  where exists (select 1 from app.people pe where pe.id = p.id)
    and not exists (select 1 from app.person_profiles x where x.person_id = p.id and x.deleted_at is null);
  update app.person_profiles set bio = 'Fifteen years rigging arena tours and festival main stages.',
    rate_minor = 45000, rate_currency = 'USD', rate_unit = 'Day', marketplace_discoverable = true
  where person_id = v_crew and bio is null;
  insert into app.profile_section_visibility (person_id, section, visibility)
  select v_crew, 'rates', 'Network'
  where exists (select 1 from app.person_profiles x where x.person_id = v_crew)
    and not exists (select 1 from app.profile_section_visibility s where s.person_id = v_crew and s.section = 'rates' and s.deleted_at is null);
  insert into app.person_skills (person_id, cat_urid, sort_order)
  select v_crew, c.cat_urid, c.ord
  from (values ('5000.05.02', 1), ('5000.51.01', 2), ('5000.04.01', 3)) as c (cat_urid, ord)
  where exists (select 1 from xpms.dim_category d where d.cat_urid = c.cat_urid)
    and exists (select 1 from app.person_profiles x where x.person_id = v_crew)
    and not exists (select 1 from app.person_skills s where s.person_id = v_crew and s.cat_urid = c.cat_urid and s.deleted_at is null);
  insert into app.person_languages (person_id, language_tag, proficiency)
  select v_crew, l.tag, l.level::app.language_proficiency
  from (values ('en', 'Native'), ('es', 'Fluent')) as l (tag, level)
  where exists (select 1 from app.person_profiles x where x.person_id = v_crew)
    and not exists (select 1 from app.person_languages s where s.person_id = v_crew and s.language_tag = l.tag and s.deleted_at is null);
  insert into app.person_links (person_id, label, url)
  select v_crew, 'Portfolio', 'https://example.com/crew'
  where exists (select 1 from app.person_profiles x where x.person_id = v_crew)
    and not exists (select 1 from app.person_links s where s.person_id = v_crew and s.deleted_at is null);
  insert into app.portfolio_items (person_id, portfolio_kind, title, url, sort_order)
  select v_crew, 'Link', 'Main stage rig, summer festival', 'https://example.com/crew/main-stage', 1
  where exists (select 1 from app.person_profiles x where x.person_id = v_crew)
    and not exists (select 1 from app.portfolio_items s where s.person_id = v_crew and s.deleted_at is null);

  -- A certification the demo org verified, carried to the crew person's profile (ADR 0019 carry-over).
  select c.id into v_cert from app.certifications c where c.org_id = v_org and c.name = 'Arena Rigging' and c.deleted_at is null;
  if v_cert is null then
    insert into app.certifications (org_id, name, issuing_body) values (v_org, 'Arena Rigging', 'ETCP') returning id into v_cert;
  end if;
  select h.id into v_holder from app.certification_holders h where h.certification_id = v_cert and h.person_id = v_crew and h.deleted_at is null;
  if v_holder is null and exists (select 1 from app.people pe where pe.id = v_crew) then
    insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
    values (v_cert, v_crew, v_admin, '2025-03-01', '2028-03-01') returning id into v_holder;
  end if;
  if v_holder is not null and not exists (select 1 from app.person_certifications pc where pc.source_certification_holder_id = v_holder) then
    perform private.begin_trusted_operation('certification_carry');
    insert into app.person_certifications (person_id, name, issuing_body, issued_on, expires_on, source_certification_holder_id,
      verified_by_org_id, verified_at)
    values (v_crew, 'Arena Rigging', 'ETCP', '2025-03-01', '2028-03-01', v_holder, v_org, now());
    perform private.end_trusted_operation('certification_carry');
  end if;

  -- Organization profiles and verification.
  insert into app.organization_profiles (org_id, handle, about, website_url, contact_email, visibility)
  select v_org, 'demo-productions', 'Festival and touring production from Miami: staging, rigging and show operations.',
    'https://example.com', 'hello@example.com', 'Public'
  where not exists (select 1 from app.organization_profiles p where p.org_id = v_org and p.deleted_at is null);
  insert into app.organization_profile_capabilities (org_id, cat_urid)
  select v_org, c.cat_urid from (values ('5000.50.02'), ('5000.04.01'), ('5000.05.02')) as c (cat_urid)
  where exists (select 1 from xpms.dim_category d where d.cat_urid = c.cat_urid)
    and not exists (select 1 from app.organization_profile_capabilities x where x.org_id = v_org and x.cat_urid = c.cat_urid and x.deleted_at is null);
  insert into app.organization_service_regions (org_id, jurisdiction_id)
  select v_org, 'US-FL-MIAMI-DADE'
  where exists (select 1 from xpms.jurisdiction j where j.jurisdiction_id = 'US-FL-MIAMI-DADE')
    and not exists (select 1 from app.organization_service_regions x where x.org_id = v_org and x.deleted_at is null);
  insert into app.organization_profile_members (org_id, person_id, title, sort_order)
  select v_org, v_producer, 'Producer', 1
  where not exists (select 1 from app.organization_profile_members x where x.org_id = v_org and x.person_id = v_producer and x.deleted_at is null);
  insert into app.organization_verifications (org_id, method, provider_reference)
  select v_org, 'Business Registry', 'demo-registry-0001'
  where not exists (select 1 from app.organization_verifications x where x.org_id = v_org);

  if exists (select 1 from app.organizations o where o.id = v_vendor) then
    insert into app.organization_profiles (org_id, handle, about, visibility)
    select v_vendor, 'demo-staging-supply', 'Staging, decks and rigging hardware for rent across South Florida.', 'Public'
    where not exists (select 1 from app.organization_profiles p where p.org_id = v_vendor and p.deleted_at is null);
    insert into app.organization_profile_capabilities (org_id, cat_urid)
    select v_vendor, '5000.04.02'
    where exists (select 1 from xpms.dim_category d where d.cat_urid = '5000.04.02')
      and not exists (select 1 from app.organization_profile_capabilities x where x.org_id = v_vendor and x.deleted_at is null);
    insert into app.organization_profile_members (org_id, person_id, title)
    select v_vendor, v_vendor_contact, 'Account Owner'
    where exists (select 1 from app.people pe where pe.id = v_vendor_contact)
      and not exists (select 1 from app.organization_profile_members x where x.org_id = v_vendor and x.person_id = v_vendor_contact and x.deleted_at is null);
  end if;
end;
$$;
