-- 1276_invite_token_open.sql
-- A61 (finding A59-024): an invitation link that is unknown, used, revoked or expired sent a signed-out
-- person straight to Create account, and they learned the invitation was dead only after signing up.
-- api_public.invite_token_open answers one question before sign-up: is this token an open invitation
-- (an email invite or an invitation link) that someone could still accept? It reveals nothing else: not
-- the org, the role, the email or why a token is closed. Tokens carry 32 random bytes, so the answer is
-- no help in guessing one. Accepting still goes through app.accept_invite and app.accept_invite_link,
-- which keep their own checks, rate limits and lockouts.

create or replace function api_public.invite_token_open(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_token, '') <> '' and (
    exists (
      select 1 from app.invites i
      where i.token_hash = private.invite_token_hash(p_token)
        and i.accepted_at is null and i.revoked_at is null and i.deleted_at is null
        and i.expires_at > now() and i.failed_attempts < 5)
    or exists (
      select 1 from app.invite_links l
      where l.token_hash = private.invite_token_hash(p_token)
        and l.revoked_at is null and l.deleted_at is null
        and l.expires_at > now() and l.use_count < l.max_uses)
  );
$$;

comment on function api_public.invite_token_open(text) is 'Named token RPC: true when the token is an email invitation or an invitation link that can still be accepted (not used, revoked, expired or locked), for the invitation page before sign-up. Reveals nothing about the invitation itself.';

revoke all on function api_public.invite_token_open(text) from public;
grant execute on function api_public.invite_token_open(text) to anon, authenticated, service_role;
