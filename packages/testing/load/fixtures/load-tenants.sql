-- Load users for the k6 scripts (Section 5.1). Signs in as load-<tenant>-<n>@load.example.test with
-- the password in :password, every user a Producer (manager role) in exactly one org, so the public
-- API binds each session to its org without a context switch. The API limits each caller to 600
-- requests a minute, so full-scale runs spread virtual users across many accounts.
--
-- Two shapes:
--   Platform: :tenants new organizations on the Enterprise plan, :users members each.
--     psql "$DB_URL" -v tenants=20 -v users=500 -v password="'<load password>'" -f load-tenants.sql
--   Tenant: :users members of one existing org with records to read and write (on staging, the demo
--   tenant), numbered as tenant :first_tenant.
--     psql "$DB_URL" -v tenants=1 -v users=500 -v first_tenant=99 -v join_org=demo-productions \
--       -v password="'<load password>'" -f load-tenants.sql
--
-- Run only against a local stack or the staging project, never production. Idempotent: rerunning
-- adds nothing that exists. load.example.test is a reserved test domain, so no mail reaches a person.

\set ON_ERROR_STOP on
\if :{?first_tenant}
\else
\set first_tenant 1
\endif

begin;

create temporary table load_spec on commit drop as
select t, n
from generate_series(:first_tenant, :first_tenant + :tenants - 1) as t,
  generate_series(1, :users) as n;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
  format('load-%s-%s@load.example.test', s.t, s.n),
  extensions.crypt(:password, extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  jsonb_build_object('full_name', format('Load User %s-%s', s.t, s.n)), now(), now(), '', '', '', ''
from load_spec s
where not exists (
  select 1 from auth.users u where u.email = format('load-%s-%s@load.example.test', s.t, s.n)
);

insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), now(), now()
from auth.users u
where u.email like 'load-%@load.example.test'
on conflict (provider_id, provider) do nothing;

\if :{?join_org}
-- Tenant shape: every user joins the existing org.
create temporary table load_org on commit drop as
select o.id from app.organizations o where o.slug = :'join_org' and o.deleted_at is null;
\else
-- Platform shape: one organization per tenant, created by its first user, on the Enterprise plan.
insert into app.organizations (slug, name, organization_type, created_by)
select format('load-tenant-%s', t), format('Load Tenant %s', t), 'For-Profit', p.id
from (select distinct t from load_spec) as tenant (t)
join auth.users u on u.email = format('load-%s-1@load.example.test', t)
join app.people p on p.user_id = u.id
where not exists (select 1 from app.organizations o where o.slug = format('load-tenant-%s', t));

do $$
declare
  v_org uuid;
begin
  for v_org in
    select o.id from app.organizations o
    where o.slug like 'load-tenant-%'
      and not exists (select 1 from app.subscriptions s where s.org_id = o.id and s.deleted_at is null)
  loop
    perform private.create_subscription(v_org, 'enterprise');
  end loop;
end;
$$;

create temporary table load_org on commit drop as
select o.id from app.organizations o where o.slug like 'load-tenant-%';
\endif

insert into app.memberships (org_id, person_id, valid_from)
select o.id, p.id, now()
from load_spec s
join app.organizations o
  on o.id in (select id from load_org)
  and (:{?join_org} or o.slug = format('load-tenant-%s', s.t))
join auth.users u on u.email = format('load-%s-%s@load.example.test', s.t, s.n)
join app.people p on p.user_id = u.id
where not exists (
  select 1 from app.memberships m where m.org_id = o.id and m.person_id = p.id and m.deleted_at is null
);

insert into app.membership_roles (membership_id, role_id)
select m.id, r.id
from app.memberships m
join app.people p on p.id = m.person_id
join auth.users u on u.id = p.user_id and u.email like 'load-%@load.example.test'
join app.roles r on r.org_id is null and r.code = 'manager'
where m.org_id in (select id from load_org)
  and not exists (
    select 1 from app.membership_roles mr where mr.membership_id = m.id and mr.deleted_at is null
  );

commit;

-- The LOAD_USERS list for a run: every load user, or one tenant's (here tenant 99):
--   psql "$DB_URL" -Atc "select string_agg(email, ',') from auth.users where email like 'load-99-%@load.example.test'"
