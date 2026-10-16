-- Load tenants for the k6 scripts (Section 5.1). Creates :tenants organizations on the Enterprise
-- plan, each with :users members (Producer role, so they read records and create them), signing in
-- as load-<tenant>-<n>@load.example.test with the password in :password. The public API limits each
-- caller to 600 requests a minute, so full-scale runs spread virtual users across these accounts.
--
-- Run only against a local stack or the staging project, never production:
--   psql "$DB_URL" -v tenants=20 -v users=500 -v password="'<staging load password>'" \
--     -f packages/testing/load/fixtures/load-tenants.sql
-- Idempotent: rerunning adds nothing that exists. The users live under load.example.test, a
-- reserved test domain, so no mail can reach a real person.

\set ON_ERROR_STOP on

begin;

create temporary table load_spec on commit drop as
select t, n
from generate_series(1, :tenants) as t, generate_series(1, :users) as n;

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

-- One organization per tenant, owned by its first user, on the Enterprise plan.
insert into app.organizations (slug, name, organization_type, created_by)
select format('load-tenant-%s', t), format('Load Tenant %s', t), 'For-Profit', p.id
from generate_series(1, :tenants) as t
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

insert into app.memberships (org_id, person_id, valid_from)
select o.id, p.id, now()
from load_spec s
join app.organizations o on o.slug = format('load-tenant-%s', s.t)
join auth.users u on u.email = format('load-%s-%s@load.example.test', s.t, s.n)
join app.people p on p.user_id = u.id
where not exists (
  select 1 from app.memberships m where m.org_id = o.id and m.person_id = p.id and m.deleted_at is null
);

insert into app.membership_roles (membership_id, role_id)
select m.id, r.id
from app.memberships m
join app.organizations o on o.id = m.org_id and o.slug like 'load-tenant-%'
join app.roles r on r.org_id is null and r.code = 'manager'
where not exists (
  select 1 from app.membership_roles mr where mr.membership_id = m.id and mr.deleted_at is null
);

commit;

-- The LOAD_USERS list for a tenant run (one tenant) or a platform run (every tenant):
--   psql "$DB_URL" -Atc "select string_agg(email, ',') from auth.users where email like 'load-1-%@load.example.test'"
