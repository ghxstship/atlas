-- pgTAP: api_public.invite_token_open (migration 1276, finding A59-024). The invitation page asks, before
-- sign-up, whether a token is still an open invitation; open email invites and open links answer true,
-- unknown, expired, revoked, accepted and used-up ones false, and anonymous callers may ask.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(9);

-- Fixtures in the demo org, with the demo Viewer role.
insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by)
select '01920000-0000-7000-8000-000000000001', e.email, r.id, private.invite_token_hash(e.token), e.expires_at,
  '01920000-0000-7000-8000-000000000101'::uuid
from (values
  ('open.a61@example.com', 'tok_open_a61', now() + interval '1 day'),
  ('expired.a61@example.com', 'tok_expired_a61', now() - interval '1 minute')
) as e (email, token, expires_at)
cross join lateral (
  select id from app.roles where org_id is null and code = 'viewer' limit 1
) r;
insert into app.invites (org_id, email, role_id, token_hash, expires_at, revoked_at, invited_by)
select '01920000-0000-7000-8000-000000000001', 'revoked.a61@example.com', r.id,
  private.invite_token_hash('tok_revoked_a61'), now() + interval '1 day', now(), '01920000-0000-7000-8000-000000000101'::uuid
from app.roles r where r.org_id is null and r.code = 'viewer' limit 1;
insert into app.invite_links (org_id, role_id, token_hash, expires_at, max_uses, use_count)
select '01920000-0000-7000-8000-000000000001', r.id, private.invite_token_hash(l.token), now() + interval '1 day', 2, l.uses
from (values ('xlnk_open_a61', 0), ('xlnk_used_a61', 2)) as l (token, uses)
cross join lateral (select id from app.roles where org_id is null and code = 'viewer' limit 1) r;

set local role anon;
select is(api_public.invite_token_open('tok_open_a61'), true, 'an open email invitation answers true to anonymous callers');
select is(api_public.invite_token_open('tok_expired_a61'), false, 'an expired invitation answers false');
select is(api_public.invite_token_open('tok_revoked_a61'), false, 'a revoked invitation answers false');
select is(api_public.invite_token_open('not-a-real-token'), false, 'an unknown token answers false');
select is(api_public.invite_token_open(''), false, 'an empty token answers false');
select is(api_public.invite_token_open(null), false, 'a missing token answers false');
select is(api_public.invite_token_open('xlnk_open_a61'), true, 'an open invitation link answers true');
select is(api_public.invite_token_open('xlnk_used_a61'), false, 'a used-up invitation link answers false');
reset role;

update app.invites set accepted_at = now(), accepted_person_id = '01920000-0000-7000-8000-000000000105'
  where email = 'open.a61@example.com';
select is(api_public.invite_token_open('tok_open_a61'), false, 'an accepted invitation answers false');

select * from finish();
rollback;
