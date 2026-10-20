-- 1295_token_lockouts_need_writes.sql
-- A69 security review (RRR-114), finding A69-001. PostgREST runs a GET call of an RPC in a READ ONLY transaction, and it
-- runs volatile functions that way too. The anonymous token RPCs count a wrong access code (or a failed lookup) with a
-- write, so through GET the write failed, the counter never moved, and a right code still returned its rows:
--   * preview_advance and token_document (and the submit and sign calls built on the same resolvers) took unlimited
--     guesses at a link's 6-digit access code, though the code locks after 5 wrong tries;
--   * verify_certification and calendar_feed_events never counted a failure against the caller's address, and the
--     different error of a hit and a miss told the two apart.
-- Fixes:
--   * private.require_read_write() refuses a read-only transaction with one fixed message (SQLSTATE 25006, which
--     PostgREST answers 405) before anything is looked up, so a GET learns nothing about the token or the code;
--   * every lockout and per-address limit helper calls it first: private.resolve_advance_token,
--     private.resolve_document_token, private.agreement_by_token and private.rate_limit_exceeded;
--   * the two resolvers lock the token row (FOR UPDATE) before comparing the code, so parallel guesses queue behind each
--     other and the fifth wrong code locks the link for every one still waiting. Before, a burst of parallel requests
--     all read failed_attempts = 0 and each got a guess.
-- 1295_token_lockouts_need_writes.test.sql calls every volatile api_public RPC in a read-only transaction.

create or replace function private.require_read_write()
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('transaction_read_only') = 'on' then
    raise exception using errcode = '25006', message = 'this call changes data: send it with POST',
      hint = 'Token and code checks count every attempt, so they never run in a read-only (GET) request.';
  end if;
end;
$$;

comment on function private.require_read_write() is 'Refuses a read-only transaction (a PostgREST GET) with one fixed 25006 error, before any lookup. Called first by every helper that counts failed attempts, so a GET can neither skip the count nor tell a hit from a miss (A69-001).';
revoke all on function private.require_read_write() from public, anon, authenticated;

create or replace function private.rate_limit_exceeded(p_bucket text, p_subject text, p_limit integer, p_window interval)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_read_write();
  return (
    select count(*) >= p_limit from private.rate_limit_events e
    where e.bucket = p_bucket and e.subject_hash = extensions.digest(coalesce(p_subject, 'unknown'), 'sha256')
      and e.occurred_at > now() - p_window);
end;
$$;

comment on function private.rate_limit_exceeded(text, text, integer, interval) is 'True when a subject has used up a bucket: p_limit attempts within p_window. Refuses a read-only transaction first, since a caller that is not over the limit is about to be counted (A69-001).';
revoke all on function private.rate_limit_exceeded(text, text, integer, interval) from public, anon, authenticated;

create or replace function private.resolve_advance_token(p_token text, p_access_code text)
returns table (token_id uuid, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token app.advance_recipient_tokens;
begin
  perform private.require_read_write();
  select * into v_token from app.advance_recipient_tokens t where t.token_hash = private.advance_token_hash(p_token) for update;
  if v_token.id is null or v_token.deleted_at is not null or v_token.revoked_at is not null or not exists (
    select 1 from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
    where r.id = v_token.advance_recipient_id and r.deleted_at is null and p.deleted_at is null) then
    return query select null::uuid, 'advance_token_invalid'::text;
    return;
  end if;
  if v_token.failed_attempts >= 5 then
    return query select null::uuid, 'advance_token_locked'::text;
    return;
  end if;
  if v_token.access_code_hash <> private.advance_code_hash(p_token, p_access_code) then
    update app.advance_recipient_tokens t set failed_attempts = least(t.failed_attempts + 1, 5) where t.id = v_token.id;
    return query select null::uuid,
      (case when v_token.failed_attempts + 1 >= 5 then 'advance_token_locked' else 'advance_access_code' end)::text;
    return;
  end if;
  if v_token.expires_at <= now() then
    return query select null::uuid, 'advance_token_expired'::text;
    return;
  end if;
  return query select v_token.id, null::text;
end;
$$;

comment on function private.resolve_advance_token(text, text) is 'Resolves an advance link and its access code to the token id, or a refusal reason: invalid, locked after 5 wrong codes, wrong code (counted) or expired. Refuses a read-only transaction and locks the token row first, so neither GET nor parallel requests get extra guesses (A69-001).';
revoke all on function private.resolve_advance_token(text, text) from public, anon, authenticated;

create or replace function private.resolve_document_token(p_token text, p_access_code text)
returns table (token_id uuid, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token app.engagement_document_tokens;
begin
  perform private.require_read_write();
  select * into v_token from app.engagement_document_tokens t where t.token_hash = private.document_token_hash(p_token) for update;
  if v_token.id is null or v_token.deleted_at is not null or v_token.revoked_at is not null or not exists (
    select 1 from app.engagement_documents d where d.id = v_token.engagement_document_id and d.deleted_at is null) then
    return query select null::uuid, 'document_token_invalid'::text;
    return;
  end if;
  if v_token.failed_attempts >= 5 then
    return query select null::uuid, 'document_token_locked'::text;
    return;
  end if;
  if v_token.access_code_hash <> private.document_code_hash(p_token, p_access_code) then
    update app.engagement_document_tokens t set failed_attempts = least(t.failed_attempts + 1, 5) where t.id = v_token.id;
    return query select null::uuid,
      (case when v_token.failed_attempts + 1 >= 5 then 'document_token_locked' else 'document_access_code' end)::text;
    return;
  end if;
  if v_token.expires_at <= now() then
    return query select null::uuid, 'document_token_expired'::text;
    return;
  end if;
  return query select v_token.id, null::text;
end;
$$;

comment on function private.resolve_document_token(text, text) is 'Resolves a document signing link and its access code to the token id, or a refusal reason: invalid, locked after 5 wrong codes, wrong code (counted) or expired. Refuses a read-only transaction and locks the token row first, so neither GET nor parallel requests get extra guesses (A69-001).';
revoke all on function private.resolve_document_token(text, text) from public, anon, authenticated;

create or replace function private.agreement_by_token(p_token text, p_access_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement app.agreements;
begin
  perform private.require_read_write();
  select * into v_agreement from app.agreements a
  where a.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256') for update;
  if v_agreement.id is null or v_agreement.deleted_at is not null or v_agreement.agreement_state <> 'Sent'
     or v_agreement.token_expires_at <= now() or v_agreement.failed_attempts >= 5 then
    return null;
  end if;
  if v_agreement.access_code_hash <> extensions.crypt(coalesce(p_access_code, ''), v_agreement.access_code_hash) then
    perform private.begin_trusted_operation('agreement_signing');
    update app.agreements set failed_attempts = least(failed_attempts + 1, 5) where id = v_agreement.id;
    perform private.end_trusted_operation('agreement_signing');
    return null;
  end if;
  return v_agreement.id;
end;
$$;

comment on function private.agreement_by_token(text, text) is 'Resolves a signing token and access code to a Sent, unexpired agreement, counting a wrong code (locked after 5). Refuses a read-only transaction first (A69-001).';
revoke all on function private.agreement_by_token(text, text) from public, anon, authenticated;
