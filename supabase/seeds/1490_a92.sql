-- 1490_a92.sql
-- A92 (RRR-137) Compass fixtures for the external More screens (A65-011 part 2): one external crew member whose
-- engagement on the demo project is Active, with what Compass shows natively and offline. Builds on 0010 (demo org),
-- 0107 (the NWS project, America/New_York) and 0228 (the Crew onboarding requirement); loads cleanly without them.
-- A new person, so the crew person of 0010 and 0228 (still in Onboarding, which crew-external-today and the Gateway
-- journeys expect) is untouched. The sign-in uses the shared demo password of 0010 and an address on example.com.
-- Idempotent: fixed ids in this file's block (...00014900xxx) with `on conflict do nothing`, and the engagement moves
-- only from its expected state, through the lifecycle engine.
--
--   Person      road.crew@example.com, Demo Road Crew (no membership: an external party)
--   Engagement  Crew, 5000.51.02, June 4 to 6 2027, every onboarding item passed, then Active
--   Timesheet   June 4 to 6, Proposed
--   Per diem    USD 60.00 on each of June 4, 5 and 6
--   Travel      LAX to MIA on June 3 (9:00 AM PDT out, 8:05 PM EDT in) and MIA to LAX on June 7

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  p_crew constant uuid := '01920000-0000-7000-8000-000014900101';
  e_crew constant uuid := '01920000-0000-7000-8000-000014900701';
  t_sheet constant uuid := '01920000-0000-7000-8000-000014900801';
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
  values ('00000000-0000-0000-0000-000000000000', p_crew, 'authenticated', 'authenticated', 'road.crew@example.com',
    extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    jsonb_build_object('full_name', 'Demo Road Crew'), now(), now(), '', '', '', '')
  on conflict (id) do nothing;

  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (p_crew, p_crew, p_crew::text, 'email',
    jsonb_build_object('sub', p_crew::text, 'email', 'road.crew@example.com', 'email_verified', true), null, now(), now())
  on conflict (provider_id, provider) do nothing;

  update app.people p set id = p.user_id where p.user_id = p_crew and p.id <> p.user_id;

  -- The engagement, with its onboarding packet (0730 creates one item per requirement that applies).
  insert into app.engagements (id, project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
    agreed_rate_minor, currency_code, start_date, end_date)
  values (e_crew, c_project, p_crew, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
    90000, 'USD', '2027-06-04', '2027-06-06')
  on conflict (id) do nothing;

  update app.onboarding_items i set submitted_at = coalesce(i.submitted_at, now() - interval '3 days')
  where i.engagement_id = e_crew and i.deleted_at is null;
  insert into app.onboarding_verifications (onboarding_item_id, outcome, verified_at, expires_on, note)
  select i.id, 'Passed', now() - interval '2 days', date '2028-06-30', 'Checked by the demo seed.'
  from app.onboarding_items i
  where i.engagement_id = e_crew and i.deleted_at is null
    and not exists (select 1 from app.onboarding_verifications v where v.onboarding_item_id = i.id);

  if (select engagement_state from app.engagements where id = e_crew) = 'Onboarding' then
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', e_crew, 'Onboarding', 'Active', 'Onboarding complete.');
  end if;

  insert into app.timesheets (id, project_id, engagement_id, period_start, period_end)
  values (t_sheet, c_project, e_crew, '2027-06-04', '2027-06-06')
  on conflict (id) do nothing;

  insert into app.per_diems (id, project_id, engagement_id, day, amount_minor, currency_code)
  values
    ('01920000-0000-7000-8000-000014900811', c_project, e_crew, '2027-06-04', 6000, 'USD'),
    ('01920000-0000-7000-8000-000014900812', c_project, e_crew, '2027-06-05', 6000, 'USD'),
    ('01920000-0000-7000-8000-000014900813', c_project, e_crew, '2027-06-06', 6000, 'USD')
  on conflict (id) do nothing;

  insert into app.travel_segments (id, project_id, person_id, engagement_id, travel_mode, operator_name, service_identifier,
    confirmation_identifier, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone)
  values
    ('01920000-0000-7000-8000-000014900821', c_project, p_crew, e_crew, 'Flight', 'Coastal Air', 'CA 210', 'QX7PLM',
     'LAX', '2027-06-03T16:00:00Z', 'America/Los_Angeles', 'MIA', '2027-06-04T00:05:00Z', 'America/New_York'),
    ('01920000-0000-7000-8000-000014900822', c_project, p_crew, e_crew, 'Flight', 'Coastal Air', 'CA 211', 'QX7PLM',
     'MIA', '2027-06-07T14:00:00Z', 'America/New_York', 'LAX', '2027-06-07T19:40:00Z', 'America/Los_Angeles')
  on conflict (id) do nothing;
end;
$$;
