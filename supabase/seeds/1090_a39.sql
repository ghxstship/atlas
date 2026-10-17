-- 1090_a39.sql
-- A39 Compass device QA. A second Field sign-in whose worked time is all in the past, so a real clock-in
-- works on a fresh reset (SIM-001). The demo world is set in March 2027, and the Demo Field Lead's time
-- entries sit on those dates; an open entry made today overlaps them, so time_entry_overlap refuses every
-- clock-in the Field Lead makes. The Field Tech below has no entry after the reset day:
--   * Demo Field Tech (tech@example.com), a Field member of the demo org, signing in with 0010's local
--     demo value
--   * a member of the demo project with the Field project role, as the Field Lead is (0107)
--   * two finished shifts on the two days before the reset, accepted, with their time entries
--   * a long show-day shift today (07:00 to 23:30), published to the Field Tech and not yet accepted, so
--     the Field Tech accepts it in Compass and then clocks in on it (journey 10)
--   * a Crew badge valid today, so gate scans grant at the Main Gate when 0217 has loaded
-- Fixed ids continue 0011's numbering:
--   Field Tech user and person   01920000-0000-7000-8000-000000000106
--   Field Tech membership        01920000-0000-7000-8000-00000000a106
--   Shifts                       01920000-0000-7000-8000-000010900001 to ...0003
-- Every change runs as the person who would make it. Idempotent: the sign-in, person and membership use
-- `on conflict do nothing`, and the crew block returns once the Field Tech's first shift exists. Guarded on
-- the demo org (0010) and the demo project (0107).

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', '01920000-0000-7000-8000-000000000106', 'authenticated',
  'authenticated', 'tech@example.com', extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb, '{"full_name": "Demo Field Tech"}'::jsonb,
  now(), now(), '', '', '', ''
where exists (select 1 from app.organizations where id = '01920000-0000-7000-8000-000000000001')
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select
  '01920000-0000-7000-8000-000000000106', u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), null, now(), now()
from auth.users u
where u.id = '01920000-0000-7000-8000-000000000106'
on conflict (provider_id, provider) do nothing;

update app.people p set id = p.user_id
where p.user_id = '01920000-0000-7000-8000-000000000106' and p.id <> p.user_id;

insert into app.memberships (id, org_id, person_id, valid_from)
select '01920000-0000-7000-8000-00000000a106', '01920000-0000-7000-8000-000000000001',
       '01920000-0000-7000-8000-000000000106', '2026-03-16T09:00:00Z'
where exists (select 1 from app.people where id = '01920000-0000-7000-8000-000000000106')
on conflict (id) do nothing;

insert into app.membership_roles (membership_id, role_id, granted_by)
select '01920000-0000-7000-8000-00000000a106', r.id, '01920000-0000-7000-8000-000000000102'
from app.roles r
where r.org_id is null and r.code = 'field'
  and exists (select 1 from app.memberships where id = '01920000-0000-7000-8000-00000000a106')
  and not exists (
    select 1 from app.membership_roles mr
    where mr.membership_id = '01920000-0000-7000-8000-00000000a106' and mr.role_id = r.id and mr.deleted_at is null
  );

insert into app.workspace_members (org_id, workspace_id, membership_id)
select '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000401', '01920000-0000-7000-8000-00000000a106'
where exists (select 1 from app.workspaces where id = '01920000-0000-7000-8000-000000000401')
  and exists (select 1 from app.memberships where id = '01920000-0000-7000-8000-00000000a106')
  and not exists (
    select 1 from app.workspace_members w
    where w.workspace_id = '01920000-0000-7000-8000-000000000401'
      and w.membership_id = '01920000-0000-7000-8000-00000000a106' and w.deleted_at is null
  );

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  c_tech constant uuid := '01920000-0000-7000-8000-000000000106';
  c_tech_m constant uuid := '01920000-0000-7000-8000-00000000a106';
  c_shift_past2 constant uuid := '01920000-0000-7000-8000-000010900001';
  c_shift_past1 constant uuid := '01920000-0000-7000-8000-000010900002';
  c_shift_today constant uuid := '01920000-0000-7000-8000-000010900003';
  c_category constant uuid := '01920000-0000-7000-8000-000000217041';
  c_role constant text := '5000.51.02';
  v_day timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
begin
  if not exists (select 1 from app.projects where id = c_project)
     or not exists (select 1 from app.memberships where id = c_tech_m)
     or exists (select 1 from app.shifts where id = c_shift_past2) then
    return;
  end if;

  -- Producer: puts the Field Tech on the project crew (Field members reach a project's inspections,
  -- incidents and forms only as its members), then publishes two past shifts and today's.
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  insert into app.project_members (project_id, membership_id, project_role) values (c_project, c_tech_m, 'Field');
  insert into app.shifts (id, org_id, project_id, membership_id, role_code, starts_at, ends_at, time_zone) values
    (c_shift_past2, c_org, c_project, c_tech_m, c_role, v_day - interval '2 days' + interval '8 hours', v_day - interval '2 days' + interval '17 hours', 'America/New_York'),
    (c_shift_past1, c_org, c_project, c_tech_m, c_role, v_day - interval '1 day' + interval '8 hours', v_day - interval '1 day' + interval '17 hours', 'America/New_York'),
    (c_shift_today, c_org, c_project, c_tech_m, c_role, v_day + interval '7 hours', v_day + interval '23 hours 30 minutes', 'America/New_York');
  perform app.publish_shifts(array[c_shift_past2, c_shift_past1, c_shift_today], 'Site prep crew schedule published.');

  -- Field Tech: accepts the two past shifts and records the time worked on them. Today's shift stays
  -- Published for the Field Tech to accept in Compass.
  perform set_config('request.jwt.claims', json_build_object('sub', c_tech, 'role', 'authenticated')::text, true);
  perform app.accept_shift(c_shift_past2, 'Confirmed.');
  perform app.accept_shift(c_shift_past1, 'Confirmed.');
  insert into app.time_entries (project_id, membership_id, shift_id, clock_in, clock_out, break_minutes, source) values
    (c_project, c_tech_m, c_shift_past2, v_day - interval '2 days' + interval '7 hours 56 minutes', v_day - interval '2 days' + interval '17 hours 4 minutes', 30, 'Mobile'),
    (c_project, c_tech_m, c_shift_past1, v_day - interval '1 day' + interval '8 hours 3 minutes', v_day - interval '1 day' + interval '16 hours 52 minutes', 30, 'Mobile');

  -- Owner: a Crew badge for the Field Tech, when 0217's credential category exists.
  if exists (select 1 from app.credential_categories where id = c_category) then
    perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
    insert into app.credentials (org_id, credential_category_id, holder_person_id, valid_from, valid_to)
    values (c_org, c_category, c_tech, v_day - interval '1 day', v_day + interval '30 days');
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;
