-- 1500_a93.sql
-- A93 Compass org switching and tenant brand (RRR-138, A65-011 part 3). A person who works for two orgs, so
-- the combined Today, the org switcher, the brand chips and the runtime brand can be walked on a fresh reset
-- (Maestro flow multi-org-today):
--   * Demo Multi-Org Crew (orgs@example.com), signing in with 0010's local demo value: a Field member of
--     the demo org (Demo Productions, 0010) on the demo project, and a Field member of Demo Harbor Stages
--   * Demo Harbor Stages, a second tenant owned by Demo Harbor Owner (harbor@example.com), branded
--     "Harbor Stages" with an amber accent that passes the contrast pairs in every theme; the demo org keeps
--     the platform brand
--   * one shift today in each org on its own project's calendar: 10:00 to 18:00 in New York (demo project)
--     and 12:00 to 20:00 in Los Angeles (Harbor Stages Pier Week), each published to the person, and a day
--     sheet for today in Los Angeles
-- Fixed ids use this seed's number:
--   Multi-org person (user and person)   01920000-0000-7000-8000-000000150001
--   Harbor owner (user and person)       01920000-0000-7000-8000-000000150002
--   Harbor project                       01920000-0000-7000-8000-000000150020
--   Shifts                               01920000-0000-7000-8000-000000150031 and ...150032
-- Every change runs as the person who would make it, through the app's RPCs where one exists. Idempotent:
-- the users use `on conflict do nothing` and the org block returns once the Harbor project exists. Guarded
-- on the demo org (0010) and the demo project (0107).

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb, jsonb_build_object('full_name', u.full_name),
  now(), now(), '', '', '', ''
from (values
  ('01920000-0000-7000-8000-000000150001'::uuid, 'orgs@example.com', 'Demo Multi-Org Crew'),
  ('01920000-0000-7000-8000-000000150002'::uuid, 'harbor@example.com', 'Demo Harbor Owner')
) as u (id, email, full_name)
where exists (select 1 from app.organizations where id = '01920000-0000-7000-8000-000000000001')
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select u.id, u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), null, now(), now()
from auth.users u
where u.id in ('01920000-0000-7000-8000-000000150001', '01920000-0000-7000-8000-000000150002')
on conflict (provider_id, provider) do nothing;

update app.people p set id = p.user_id
where p.user_id in ('01920000-0000-7000-8000-000000150001', '01920000-0000-7000-8000-000000150002')
  and p.id <> p.user_id;

do $$
declare
  c_demo_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_demo_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_demo_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_demo_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  c_multi constant uuid := '01920000-0000-7000-8000-000000150001';
  c_harbor_owner constant uuid := '01920000-0000-7000-8000-000000150002';
  c_harbor_project constant uuid := '01920000-0000-7000-8000-000000150020';
  c_shift_ny constant uuid := '01920000-0000-7000-8000-000000150031';
  c_shift_la constant uuid := '01920000-0000-7000-8000-000000150032';
  c_role constant text := '5000.51.02';
  v_field uuid;
  v_harbor uuid;
  v_token text;
  v_demo_m uuid;
  v_harbor_m uuid;
  v_ny_day timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
  v_la_day timestamptz := date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
begin
  if not exists (select 1 from app.projects where id = c_demo_project)
     or not exists (select 1 from app.people where id = c_multi)
     or exists (select 1 from app.projects where id = c_harbor_project) then
    return;
  end if;
  select r.id into v_field from app.roles r where r.org_id is null and r.code = 'field';

  -- Demo Productions: the Owner invites the person as Field; the person accepts.
  perform set_config('request.jwt.claims', json_build_object('sub', c_demo_owner, 'role', 'authenticated')::text, true);
  select i.invite_token into v_token from app.invite_member(c_demo_org, 'orgs@example.com', v_field) i;
  perform set_config('request.jwt.claims', json_build_object('sub', c_multi, 'role', 'authenticated')::text, true);
  select a.membership_id into v_demo_m from app.accept_invite(v_token) a;

  -- Demo Harbor Stages: its Owner creates it, brands it and invites the person as Field.
  perform set_config('request.jwt.claims', json_build_object('sub', c_harbor_owner, 'role', 'authenticated')::text, true);
  v_harbor := app.create_organization('Demo Harbor Stages', 'demo-harbor-stages');
  insert into app.org_brands (org_id, display_name, accent_hex) values (v_harbor, 'Harbor Stages', '#B45309');
  select i.invite_token into v_token from app.invite_member(v_harbor, 'orgs@example.com', v_field) i;
  perform set_config('request.jwt.claims', json_build_object('sub', c_multi, 'role', 'authenticated')::text, true);
  select a.membership_id into v_harbor_m from app.accept_invite(v_token) a;

  -- Harbor Owner: the Pier Week project in Los Angeles, the person on its crew, today's shift and day sheet.
  perform set_config('request.jwt.claims', json_build_object('sub', c_harbor_owner, 'role', 'authenticated')::text, true);
  insert into app.projects (id, org_id, project_key, name, time_zone)
  values (c_harbor_project, v_harbor, 'HSP', 'Harbor Stages Pier Week', 'America/Los_Angeles');
  insert into app.project_members (project_id, membership_id, project_role) values (c_harbor_project, v_harbor_m, 'Field');
  insert into app.shifts (id, org_id, project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (c_shift_la, v_harbor, c_harbor_project, v_harbor_m, c_role, v_la_day + interval '12 hours',
          v_la_day + interval '20 hours', 'America/Los_Angeles');
  perform app.publish_shifts(array[c_shift_la], 'Pier Week crew schedule published.');
  insert into app.day_sheets (org_id, project_id, day, body)
  values (v_harbor, c_harbor_project, (now() at time zone 'America/Los_Angeles')::date,
          'Load-in at the pier from noon. Crew parking at Gate 3.');

  -- Demo Producer: the person on the demo project's crew and today's shift in New York.
  perform set_config('request.jwt.claims', json_build_object('sub', c_demo_producer, 'role', 'authenticated')::text, true);
  insert into app.project_members (project_id, membership_id, project_role) values (c_demo_project, v_demo_m, 'Field');
  insert into app.shifts (id, org_id, project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (c_shift_ny, c_demo_org, c_demo_project, v_demo_m, c_role, v_ny_day + interval '10 hours',
          v_ny_day + interval '18 hours', 'America/New_York');
  perform app.publish_shifts(array[c_shift_ny], 'Pier crew schedule published.');

  perform set_config('request.jwt.claims', '', true);
end;
$$;
