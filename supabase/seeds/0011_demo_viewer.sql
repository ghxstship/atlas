-- 0011_demo_viewer.sql
-- A Viewer in the demo org, so role sweeps (A23's accessibility pass, Viewer refusal states) run on a
-- fresh reset. Fixed ids continue 0010's numbering:
--   Viewer user and person   01920000-0000-7000-8000-000000000105
--   Viewer membership        01920000-0000-7000-8000-00000000a105
-- Idempotent, like 0010. The password is 0010's local demo value.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values (
  '00000000-0000-0000-0000-000000000000', '01920000-0000-7000-8000-000000000105', 'authenticated',
  'authenticated', 'viewer@example.com', extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb, '{"full_name": "Demo Viewer"}'::jsonb,
  now(), now(), '', '', '', ''
)
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values (
  '01920000-0000-7000-8000-000000000105', '01920000-0000-7000-8000-000000000105',
  '01920000-0000-7000-8000-000000000105', 'email',
  '{"sub": "01920000-0000-7000-8000-000000000105", "email": "viewer@example.com", "email_verified": true}'::jsonb,
  null, now(), now()
)
on conflict (provider_id, provider) do nothing;

update app.people p set id = p.user_id
where p.user_id = '01920000-0000-7000-8000-000000000105' and p.id <> p.user_id;

insert into app.memberships (id, org_id, person_id, valid_from)
values ('01920000-0000-7000-8000-00000000a105', '01920000-0000-7000-8000-000000000001',
        '01920000-0000-7000-8000-000000000105', '2026-03-16T09:00:00Z')
on conflict (id) do nothing;

insert into app.membership_roles (membership_id, role_id, granted_by)
select '01920000-0000-7000-8000-00000000a105', r.id, '01920000-0000-7000-8000-000000000102'
from app.roles r
where r.org_id is null and r.code = 'viewer'
  and not exists (
    select 1 from app.membership_roles mr
    where mr.membership_id = '01920000-0000-7000-8000-00000000a105' and mr.role_id = r.id and mr.deleted_at is null
  );

insert into app.workspace_members (org_id, workspace_id, membership_id)
select '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000401', '01920000-0000-7000-8000-00000000a105'
where not exists (
  select 1 from app.workspace_members w
  where w.workspace_id = '01920000-0000-7000-8000-000000000401'
    and w.membership_id = '01920000-0000-7000-8000-00000000a105' and w.deleted_at is null
);
