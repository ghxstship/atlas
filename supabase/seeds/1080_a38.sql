-- 1080_a38.sql
-- A38 (RRR-82) external role fixtures for the Section 20.2 journeys the Gateway and Atlas specs
-- automate (journeys 42, 44 to 48, 51, 59 and 60). Builds on 0010 (demo org, Owner, crew person,
-- vendor) and 0228 (opportunities); loads cleanly without them. Every sign-in uses the shared demo
-- password of 0010 and an address on example.com. Idempotent: fixed ids in this file's block
-- (...000010800xxx) with `on conflict do nothing`, and every state move runs only from its
-- expected state, through the lifecycle engine.
--
--   People      agency@ (Demo Crew Agency, Account Owner), staff.one@ and staff.two@ (its roster),
--               contractor@ (Demo Design Studio, Account Owner), artist@, agent@ (Demo Talent
--               Agency, Account Owner, representing the artist), client@ (Demo Client Brand),
--               sponsor@ (Demo Sponsor Beverage), finance@ (a Finance Lead of the demo org who has
--               never signed in), multi@ (journey 59: Admin of Demo Bayside Studios, Producer and
--               member of the demo org, crew for Demo Harbor Events, artist for Demo Night
--               Festival), orgs.owner@ (Owner of those three orgs), supplier@ (Demo Lighting Rentals, an
--               external account with history that subscribes in journey 60)
--   Accounts    the six external accounts above, without subscriptions, each a counterparty of the
--               demo org
--   History     Demo Lighting Rentals' completed vendor engagement with the demo org, rated by the org
--               (one-sided, so the rating stays unreleased until the 14 days pass or the vendor rates)

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  p_agency constant uuid := '01920000-0000-7000-8000-000010800101';
  p_staff1 constant uuid := '01920000-0000-7000-8000-000010800102';
  p_staff2 constant uuid := '01920000-0000-7000-8000-000010800103';
  p_contractor constant uuid := '01920000-0000-7000-8000-000010800104';
  p_artist constant uuid := '01920000-0000-7000-8000-000010800105';
  p_agent constant uuid := '01920000-0000-7000-8000-000010800106';
  p_client constant uuid := '01920000-0000-7000-8000-000010800107';
  p_sponsor constant uuid := '01920000-0000-7000-8000-000010800108';
  p_finance constant uuid := '01920000-0000-7000-8000-000010800109';
  p_multi constant uuid := '01920000-0000-7000-8000-000010800110';
  p_partner constant uuid := '01920000-0000-7000-8000-000010800111';
  p_supplier constant uuid := '01920000-0000-7000-8000-000010800112';
  a_agency constant uuid := '01920000-0000-7000-8000-000010800301';
  a_studio constant uuid := '01920000-0000-7000-8000-000010800302';
  a_talent constant uuid := '01920000-0000-7000-8000-000010800303';
  a_client constant uuid := '01920000-0000-7000-8000-000010800304';
  a_sponsor constant uuid := '01920000-0000-7000-8000-000010800305';
  a_supplier constant uuid := '01920000-0000-7000-8000-000010800306';
  o_bayside constant uuid := '01920000-0000-7000-8000-000010800501';
  o_harbor constant uuid := '01920000-0000-7000-8000-000010800502';
  o_night constant uuid := '01920000-0000-7000-8000-000010800503';
  j_harbor constant uuid := '01920000-0000-7000-8000-000010800601';
  j_night constant uuid := '01920000-0000-7000-8000-000010800602';
  e_supplier constant uuid := '01920000-0000-7000-8000-000010800701';
  e_multi_crew constant uuid := '01920000-0000-7000-8000-000010800702';
  e_multi_artist constant uuid := '01920000-0000-7000-8000-000010800703';
  r_talent constant uuid := '01920000-0000-7000-8000-000010800801';
  v_counterparty uuid;
  v_org uuid;
  v_person uuid;
begin
  if not exists (select 1 from app.organizations where id = c_org) then
    return;
  end if;

  -- Sign-ins. The person trigger (0206) creates each person; the update moves it to the fixed id.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  )
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
    extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    jsonb_build_object('full_name', u.full_name), now(), now(), '', '', '', ''
  from (values
    (p_agency, 'agency@example.com', 'Demo Agency Lead'),
    (p_staff1, 'staff.one@example.com', 'Demo Staff One'),
    (p_staff2, 'staff.two@example.com', 'Demo Staff Two'),
    (p_contractor, 'contractor@example.com', 'Demo Contractor'),
    (p_artist, 'artist@example.com', 'Demo Artist'),
    (p_agent, 'agent@example.com', 'Demo Artist Agent'),
    (p_client, 'client@example.com', 'Demo Client Contact'),
    (p_sponsor, 'sponsor@example.com', 'Demo Sponsor Lead'),
    (p_finance, 'finance@example.com', 'Demo Finance Lead'),
    (p_multi, 'multi@example.com', 'Demo Multi Role'),
    (p_partner, 'orgs.owner@example.com', 'Demo Multi Org Owner'),
    (p_supplier, 'supplier@example.com', 'Demo Supplier Owner')
  ) as u (id, email, full_name)
  on conflict (id) do nothing;

  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  select u.id, u.id, u.id::text, 'email',
    jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), null, now(), now()
  from auth.users u
  where u.id between p_agency and p_supplier
  on conflict (provider_id, provider) do nothing;

  update app.people p set id = p.user_id
  where p.user_id between p_agency and p_supplier and p.id <> p.user_id;

  -- External accounts: organizations without a subscription, each with its Account Owner.
  insert into app.organizations (id, slug, name, organization_type, created_by)
  values
    (a_agency, 'demo-crew-agency', 'Demo Crew Agency', 'For-Profit', p_agency),
    (a_studio, 'demo-design-studio', 'Demo Design Studio', 'For-Profit', p_contractor),
    (a_talent, 'demo-talent-agency', 'Demo Talent Agency', 'For-Profit', p_agent),
    (a_client, 'demo-client-brand', 'Demo Client Brand', 'For-Profit', p_client),
    (a_sponsor, 'demo-sponsor-beverage', 'Demo Sponsor Beverage', 'For-Profit', p_sponsor),
    (a_supplier, 'demo-lighting-rentals', 'Demo Lighting Rentals', 'For-Profit', p_supplier)
  on conflict (id) do nothing;

  insert into app.account_memberships (id, org_id, person_id)
  values
    ('01920000-0000-7000-8000-000010800201', a_agency, p_agency),
    ('01920000-0000-7000-8000-000010800202', a_agency, p_staff1),
    ('01920000-0000-7000-8000-000010800203', a_agency, p_staff2),
    ('01920000-0000-7000-8000-000010800204', a_studio, p_contractor),
    ('01920000-0000-7000-8000-000010800205', a_talent, p_agent),
    ('01920000-0000-7000-8000-000010800206', a_client, p_client),
    ('01920000-0000-7000-8000-000010800207', a_sponsor, p_sponsor),
    ('01920000-0000-7000-8000-000010800208', a_supplier, p_supplier)
  on conflict (id) do nothing;

  insert into app.account_membership_roles (account_membership_id, account_role, granted_by)
  select m.id, m.role::app.account_role, null
  from (values
    ('01920000-0000-7000-8000-000010800201'::uuid, 'Account Owner'),
    ('01920000-0000-7000-8000-000010800202'::uuid, 'Account Member'),
    ('01920000-0000-7000-8000-000010800203'::uuid, 'Account Member'),
    ('01920000-0000-7000-8000-000010800204'::uuid, 'Account Owner'),
    ('01920000-0000-7000-8000-000010800205'::uuid, 'Account Owner'),
    ('01920000-0000-7000-8000-000010800206'::uuid, 'Account Owner'),
    ('01920000-0000-7000-8000-000010800207'::uuid, 'Account Owner'),
    ('01920000-0000-7000-8000-000010800208'::uuid, 'Account Owner')
  ) as m (id, role)
  where not exists (
    select 1 from app.account_membership_roles r
    where r.account_membership_id = m.id and r.account_role = m.role::app.account_role and r.deleted_at is null
  );

  -- Each account is a counterparty of the demo org.
  insert into app.counterparties (id, org_id, organization_id)
  select x.id, c_org, x.account
  from (values
    ('01920000-0000-7000-8000-000010800401'::uuid, a_agency),
    ('01920000-0000-7000-8000-000010800402'::uuid, a_studio),
    ('01920000-0000-7000-8000-000010800403'::uuid, a_talent),
    ('01920000-0000-7000-8000-000010800404'::uuid, a_client),
    ('01920000-0000-7000-8000-000010800405'::uuid, a_sponsor),
    ('01920000-0000-7000-8000-000010800406'::uuid, a_supplier)
  ) as x (id, account)
  where not exists (
    select 1 from app.counterparties c where c.org_id = c_org and c.organization_id = x.account and c.deleted_at is null
  )
  on conflict (id) do nothing;

  -- The talent agency represents the artist in every scope, accepted by the artist.
  insert into app.representations (id, org_id, artist_person_id, representative_person_id, expires_on, accepted_at)
  values (r_talent, a_talent, p_artist, p_agent, '2028-12-31', now())
  on conflict (id) do nothing;
  insert into app.representation_scopes (representation_id, scope)
  select r_talent, s.scope::app.representation_scope
  from (values ('Offers'), ('Advance'), ('Settlement'), ('Documents')) as s (scope)
  where not exists (
    select 1 from app.representation_scopes x where x.representation_id = r_talent and x.scope = s.scope::app.representation_scope
  );

  -- Journey 51: a Finance Lead (a Manager whose persona is finance-lead) who has never signed in.
  insert into app.memberships (id, org_id, person_id, valid_from)
  values ('01920000-0000-7000-8000-000010800901', c_org, p_finance, '2026-09-01T09:00:00Z')
  on conflict (id) do nothing;
  insert into app.personal_setting_values (person_id, org_id, setting_key, value_text)
  select p_finance, c_org, 'me.persona', 'finance-lead'
  where not exists (
    select 1 from app.personal_setting_values v
    where v.person_id = p_finance and v.org_id = c_org and v.setting_key = 'me.persona' and v.deleted_at is null
  );

  -- Journey 59: three more orgs owned by the partner, and the multi-role person's place in each.
  insert into app.organizations (id, slug, name, organization_type, created_by)
  values
    (o_bayside, 'demo-bayside-studios', 'Demo Bayside Studios', 'For-Profit', p_partner),
    (o_harbor, 'demo-harbor-events', 'Demo Harbor Events', 'For-Profit', p_partner),
    (o_night, 'demo-night-festival', 'Demo Night Festival', 'For-Profit', p_partner)
  on conflict (id) do nothing;
  foreach v_org in array array[o_bayside, o_harbor, o_night] loop
    if not exists (select 1 from app.subscriptions s where s.org_id = v_org and s.deleted_at is null) then
      perform private.create_subscription(v_org, 'team');
    end if;
  end loop;

  insert into app.memberships (id, org_id, person_id, valid_from)
  values
    ('01920000-0000-7000-8000-000010800902', o_bayside, p_partner, '2026-08-01T09:00:00Z'),
    ('01920000-0000-7000-8000-000010800903', o_harbor, p_partner, '2026-08-01T09:00:00Z'),
    ('01920000-0000-7000-8000-000010800904', o_night, p_partner, '2026-08-01T09:00:00Z'),
    ('01920000-0000-7000-8000-000010800905', o_bayside, p_multi, '2026-08-15T09:00:00Z'),
    ('01920000-0000-7000-8000-000010800906', c_org, p_multi, '2026-08-15T09:00:00Z')
  on conflict (id) do nothing;

  insert into app.membership_roles (membership_id, role_id, granted_by)
  select m.membership_id, r.id, m.granted_by
  from (values
    ('01920000-0000-7000-8000-000010800901'::uuid, 'manager', c_owner),
    ('01920000-0000-7000-8000-000010800902'::uuid, 'owner', null::uuid),
    ('01920000-0000-7000-8000-000010800903'::uuid, 'owner', null::uuid),
    ('01920000-0000-7000-8000-000010800904'::uuid, 'owner', null::uuid),
    ('01920000-0000-7000-8000-000010800905'::uuid, 'admin', p_partner),
    ('01920000-0000-7000-8000-000010800906'::uuid, 'manager', c_owner),
    ('01920000-0000-7000-8000-000010800906'::uuid, 'member', c_owner)
  ) as m (membership_id, role_code, granted_by)
  join app.roles r on r.org_id is null and r.code = m.role_code
  where not exists (
    select 1 from app.membership_roles mr
    where mr.membership_id = m.membership_id and mr.role_id = r.id and mr.deleted_at is null
  );

  insert into app.projects (id, org_id, project_key, name, time_zone, jurisdiction_id, starts_on, ends_on, created_by)
  values
    (j_harbor, o_harbor, 'HEV', 'Harbor Fall Regatta', 'America/New_York', 'US-FL-MIAMI-DADE', '2027-09-10', '2027-09-12', p_partner),
    (j_night, o_night, 'NFX', 'Night Festival 2027', 'America/New_York', 'US-FL-MIAMI-DADE', '2027-07-16', '2027-07-18', p_partner)
  on conflict (id) do nothing;

  insert into app.engagements (id, project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
    agreed_rate_minor, currency_code, start_date, end_date)
  values
    (e_multi_crew, j_harbor, p_multi, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
     90000, 'USD', '2027-09-10', '2027-09-12'),
    (e_multi_artist, j_night, p_multi, 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
     250000, 'USD', '2027-07-17', '2027-07-17')
  on conflict (id) do nothing;

  -- Journey 60: Demo Lighting Rentals' history with the demo org, a completed and rated engagement.
  select c.id into v_counterparty from app.counterparties c
  where c.org_id = c_org and c.organization_id = a_supplier and c.deleted_at is null;
  if not exists (select 1 from app.projects where id = c_project) then
    return;
  end if;
  insert into app.engagements (id, project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date, end_date)
  values (e_supplier, c_project, p_supplier, v_counterparty, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate',
    'Per Engagement', '2027-02-01', '2027-02-03')
  on conflict (id) do nothing;
  if (select engagement_state from app.engagements where id = e_supplier) = 'Onboarding' then
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', e_supplier, 'Onboarding', 'Active', 'Onboarding complete.');
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', e_supplier, 'Active', 'Closing', 'Show complete; close-out started.');
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', e_supplier, 'Closing', 'Complete', 'Final invoice paid.');
    insert into app.ratings (engagement_id, rater_side, score, comment)
    values (e_supplier, 'Organization', 5, 'Moving heads arrived early and every fixture worked.');
  end if;
end;
$$;
