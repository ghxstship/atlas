-- 2332_a140.sql
-- A140 (RRR-204) Compass fixture for sponsors' proof-of-performance photos (migration 2332, Maestro
-- sponsor-proof-photo): a sponsor whose engagement on the demo project is Active, with one entitlement to photograph.
-- Builds on 0010 (demo org) and 0107 (the NWS project); loads cleanly without them. A new person and account, so
-- sponsor@ of 1080 (no engagement, which Gateway journey 47 expects) is untouched. The sign-in uses the shared demo
-- password of 0010 and an address on example.com. Idempotent: fixed ids in this file's block (...00023320xxx) with
-- `on conflict do nothing`, and the engagement moves only from its expected state, through the lifecycle engine.
--
--   Person       activation.sponsor@example.com, Demo Activation Sponsor (no membership: an external party)
--   Account      Demo Activation Brand, with the person as Account Owner, a counterparty of the demo org
--   Engagement   Sponsor, June 4 to 6 2027, Active
--   Entitlement  Logo on the LED wall between sets, 6, due June 6

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  p_sponsor constant uuid := '01920000-0000-7000-8000-000023320101';
  a_brand constant uuid := '01920000-0000-7000-8000-000023320301';
  m_owner constant uuid := '01920000-0000-7000-8000-000023320201';
  c_brand constant uuid := '01920000-0000-7000-8000-000023320401';
  e_sponsor constant uuid := '01920000-0000-7000-8000-000023320701';
  s_entitlement constant uuid := '01920000-0000-7000-8000-000023320901';
begin
  if not exists (select 1 from app.projects where id = c_project and org_id = c_org) then
    return;
  end if;

  -- The sign-in. The person trigger (0206) creates the person; the update moves it to the fixed id.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  )
  values ('00000000-0000-0000-0000-000000000000', p_sponsor, 'authenticated', 'authenticated', 'activation.sponsor@example.com',
    extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    jsonb_build_object('full_name', 'Demo Activation Sponsor'), now(), now(), '', '', '', '')
  on conflict (id) do nothing;

  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (p_sponsor, p_sponsor, p_sponsor::text, 'email',
    jsonb_build_object('sub', p_sponsor::text, 'email', 'activation.sponsor@example.com', 'email_verified', true), null, now(), now())
  on conflict (provider_id, provider) do nothing;

  update app.people p set id = p.user_id where p.user_id = p_sponsor and p.id <> p.user_id;

  -- The sponsor's account, its Account Owner, and the account as a counterparty of the demo org.
  insert into app.organizations (id, slug, name, organization_type, created_by)
  values (a_brand, 'demo-activation-brand', 'Demo Activation Brand', 'For-Profit', p_sponsor)
  on conflict (id) do nothing;
  insert into app.account_memberships (id, org_id, person_id) values (m_owner, a_brand, p_sponsor) on conflict (id) do nothing;
  insert into app.account_membership_roles (account_membership_id, account_role, granted_by)
  select m_owner, 'Account Owner', null
  where not exists (select 1 from app.account_membership_roles r
    where r.account_membership_id = m_owner and r.account_role = 'Account Owner' and r.deleted_at is null);
  insert into app.counterparties (id, org_id, organization_id)
  select c_brand, c_org, a_brand
  where not exists (select 1 from app.counterparties c where c.org_id = c_org and c.organization_id = a_brand and c.deleted_at is null)
  on conflict (id) do nothing;

  -- The engagement (a Sponsor engagement carries no work terms, 1624), its onboarding passed, then Active.
  insert into app.engagements (id, project_id, person_id, counterparty_id, role_type, start_date, end_date)
  values (e_sponsor, c_project, p_sponsor, c_brand, 'Sponsor', '2027-06-04', '2027-06-06')
  on conflict (id) do nothing;
  update app.onboarding_items i set submitted_at = coalesce(i.submitted_at, now() - interval '3 days')
  where i.engagement_id = e_sponsor and i.deleted_at is null;
  insert into app.onboarding_verifications (onboarding_item_id, outcome, verified_at, expires_on, note)
  select i.id, 'Passed', now() - interval '2 days', date '2028-06-30', 'Checked by the demo seed.'
  from app.onboarding_items i
  where i.engagement_id = e_sponsor and i.deleted_at is null
    and not exists (select 1 from app.onboarding_verifications v where v.onboarding_item_id = i.id);
  if (select engagement_state from app.engagements where id = e_sponsor) = 'Onboarding' then
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', e_sponsor, 'Onboarding', 'Active', 'Onboarding complete.');
  end if;

  insert into app.sponsor_entitlements (id, project_id, counterparty_id, description, quantity, due_on)
  values (s_entitlement, c_project, c_brand, 'Logo on the LED wall between sets', 6, '2027-06-06')
  on conflict (id) do nothing;
end;
$$;
