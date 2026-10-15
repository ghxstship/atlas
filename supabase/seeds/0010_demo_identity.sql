-- 0010_demo_identity.sql
-- A30 Identity, Profiles and Settings. The demo tenant's identity core (Section 19.6), using the
-- fixed ids of 0000_demo_tenant_conventions.sql:
--   * the demo org, an Organization of type For-Profit on the Team plan, with one workspace and one team
--   * four sign-ins with their people and memberships: Owner (owner), Admin (admin), Producer
--     (manager) and Field (field)
--   * the external crew person, who signs in to Gateway and Compass and holds no membership
--   * the vendor organization, an external account without a subscription, and its account owner
--
-- Every later seed may reference these rows. Idempotent: every insert is `on conflict do nothing`, and
-- a second load changes nothing. Sign-ins use addresses on example.com only. The shared demo password
-- below is a local test value for these seeded accounts and works only against a local stack.
--
-- Extra fixed ids this file adds (reported to the orchestrator for the conventions file):
--   Demo workspace                                  01920000-0000-7000-8000-000000000401
--   Demo team                                       01920000-0000-7000-8000-000000000501
--   Demo vendor account owner user and person       01920000-0000-7000-8000-000000000302
--   Memberships 01920000-0000-7000-8000-00000000a101 to a104, in the order of the four users

-- Sign-ins --------------------------------------------------------------------------------------------
-- The person trigger (0206) creates each person with a fresh id; the update afterwards moves it to the
-- fixed id while nothing references it yet.

with demo_user (id, email, full_name) as (
  values
    ('01920000-0000-7000-8000-000000000101'::uuid, 'owner@example.com', 'Demo Owner'),
    ('01920000-0000-7000-8000-000000000102'::uuid, 'admin@example.com', 'Demo Admin'),
    ('01920000-0000-7000-8000-000000000103'::uuid, 'producer@example.com', 'Demo Producer'),
    ('01920000-0000-7000-8000-000000000104'::uuid, 'field@example.com', 'Demo Field Lead'),
    ('01920000-0000-7000-8000-000000000201'::uuid, 'crew@example.com', 'Demo Crew Member'),
    ('01920000-0000-7000-8000-000000000302'::uuid, 'vendor@example.com', 'Demo Vendor Contact')
)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  jsonb_build_object('full_name', u.full_name), now(), now(), '', '', '', ''
from demo_user u
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select u.id, u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), null, now(), now()
from auth.users u
where u.id in (
  '01920000-0000-7000-8000-000000000101', '01920000-0000-7000-8000-000000000102',
  '01920000-0000-7000-8000-000000000103', '01920000-0000-7000-8000-000000000104',
  '01920000-0000-7000-8000-000000000201', '01920000-0000-7000-8000-000000000302'
)
on conflict (provider_id, provider) do nothing;

update app.people p set id = p.user_id
where p.user_id in (
  '01920000-0000-7000-8000-000000000101', '01920000-0000-7000-8000-000000000102',
  '01920000-0000-7000-8000-000000000103', '01920000-0000-7000-8000-000000000104',
  '01920000-0000-7000-8000-000000000201', '01920000-0000-7000-8000-000000000302'
)
  and p.id <> p.user_id;

-- Organizations -----------------------------------------------------------------------------------------

insert into app.organizations (id, slug, name, organization_type, created_by)
values
  ('01920000-0000-7000-8000-000000000001', 'demo-productions', 'Demo Productions', 'For-Profit',
   '01920000-0000-7000-8000-000000000101'),
  ('01920000-0000-7000-8000-000000000301', 'demo-staging-supply', 'Demo Staging Supply', 'For-Profit',
   '01920000-0000-7000-8000-000000000302')
on conflict (id) do nothing;

-- The demo org subscribes on the Team plan; the vendor is an external account and has no subscription.
do $$
begin
  if not exists (
    select 1 from app.subscriptions s where s.org_id = '01920000-0000-7000-8000-000000000001' and s.deleted_at is null
  ) then
    perform private.create_subscription('01920000-0000-7000-8000-000000000001', 'team');
  end if;
end;
$$;

-- Memberships and roles ---------------------------------------------------------------------------------

insert into app.memberships (id, org_id, person_id, valid_from)
values
  ('01920000-0000-7000-8000-00000000a101', '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000101', '2026-01-05T09:00:00Z'),
  ('01920000-0000-7000-8000-00000000a102', '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000102', '2026-01-05T09:00:00Z'),
  ('01920000-0000-7000-8000-00000000a103', '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000103', '2026-02-02T09:00:00Z'),
  ('01920000-0000-7000-8000-00000000a104', '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000104', '2026-03-02T09:00:00Z')
on conflict (id) do nothing;

insert into app.membership_roles (membership_id, role_id, granted_by)
select m.membership_id, r.id, m.granted_by
from (
  values
    ('01920000-0000-7000-8000-00000000a101'::uuid, 'owner', null::uuid),
    ('01920000-0000-7000-8000-00000000a102'::uuid, 'admin', '01920000-0000-7000-8000-000000000101'::uuid),
    ('01920000-0000-7000-8000-00000000a103'::uuid, 'manager', '01920000-0000-7000-8000-000000000101'::uuid),
    ('01920000-0000-7000-8000-00000000a104'::uuid, 'field', '01920000-0000-7000-8000-000000000102'::uuid)
) as m (membership_id, role_code, granted_by)
join app.roles r on r.org_id is null and r.code = m.role_code
where not exists (
  select 1 from app.membership_roles mr
  where mr.membership_id = m.membership_id and mr.role_id = r.id and mr.deleted_at is null
);

-- Workspace and team ------------------------------------------------------------------------------------

insert into app.workspaces (id, org_id, slug, name)
values ('01920000-0000-7000-8000-000000000401', '01920000-0000-7000-8000-000000000001', 'miami', 'Miami')
on conflict (id) do nothing;

insert into app.workspace_members (org_id, workspace_id, membership_id)
select '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000401', m.id
from app.memberships m
where m.org_id = '01920000-0000-7000-8000-000000000001'
  and not exists (
    select 1 from app.workspace_members w
    where w.workspace_id = '01920000-0000-7000-8000-000000000401' and w.membership_id = m.id and w.deleted_at is null
  );

insert into app.teams (id, org_id, name, description)
values ('01920000-0000-7000-8000-000000000501', '01920000-0000-7000-8000-000000000001', 'Production',
  'Plans and runs the shows the org produces.')
on conflict (id) do nothing;

insert into app.team_members (org_id, team_id, membership_id)
select '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000501', m.id
from (values ('01920000-0000-7000-8000-00000000a103'::uuid), ('01920000-0000-7000-8000-00000000a104'::uuid)) as m (id)
where not exists (
  select 1 from app.team_members t
  where t.team_id = '01920000-0000-7000-8000-000000000501' and t.membership_id = m.id and t.deleted_at is null
);

-- Vendor account ----------------------------------------------------------------------------------------

insert into app.account_memberships (id, org_id, person_id)
values ('01920000-0000-7000-8000-00000000b301', '01920000-0000-7000-8000-000000000301', '01920000-0000-7000-8000-000000000302')
on conflict (id) do nothing;

insert into app.account_membership_roles (account_membership_id, account_role, granted_by)
select '01920000-0000-7000-8000-00000000b301', 'Account Owner', null
where not exists (
  select 1 from app.account_membership_roles r
  where r.account_membership_id = '01920000-0000-7000-8000-00000000b301' and r.account_role = 'Account Owner'
    and r.deleted_at is null
);
