-- 0769_engagement_document_tokens.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 7 for A27 (Section 4.4.6 token flows without an account):
-- signing links for engagement documents.
--   * app.engagement_document_tokens: a token and a 6-digit access code per recipient email, stored only as SHA-256
--     hashes, with expiry, a lock after 5 wrong codes, first use and the name the signer typed
--   * app.issue_engagement_document_token and app.revoke_engagement_document_token for the org (Atlas)
--   * api_public.token_document and api_public.token_sign_document for anyone holding the link and code; signing
--     moves a Sent document to Signed with the signer's name in the ledger reason, and the org countersigns in Atlas
--   * app.claim_token_submissions: a signed-in person with a confirmed email claims every unclaimed link sent to that
--     email, engagement document links and A10's advance links alike, so earlier token work appears under the account
--   * api_external.my_token_documents: documents signed or sent through links the caller claimed
-- Advance tokens themselves stay A10's (0430).

create table app.engagement_document_tokens (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_document_id uuid not null references app.engagement_documents (id),
  recipient_email text not null,
  token_hash bytea not null,
  access_code_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  signer_name text,
  revoked_at timestamptz,
  failed_attempts smallint not null default 0,
  claimed_by uuid references app.people (id),
  claimed_at timestamptz,
  deleted_at timestamptz,
  constraint engagement_document_tokens_email_format check (recipient_email = lower(btrim(recipient_email)) and recipient_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(recipient_email) <= 320),
  constraint engagement_document_tokens_token_hash_length check (octet_length(token_hash) = 32),
  constraint engagement_document_tokens_code_hash_length check (octet_length(access_code_hash) = 32),
  constraint engagement_document_tokens_attempts check (failed_attempts between 0 and 5),
  constraint engagement_document_tokens_claim_pair check ((claimed_by is null) = (claimed_at is null)),
  constraint engagement_document_tokens_signer check ((signer_name is null) = (used_at is null) and (signer_name is null or char_length(btrim(signer_name)) between 1 and 200))
);

create unique index engagement_document_tokens_token_hash_key on app.engagement_document_tokens (token_hash);
create index engagement_document_tokens_document_idx on app.engagement_document_tokens (engagement_document_id);
create index engagement_document_tokens_email_idx on app.engagement_document_tokens (recipient_email) where claimed_by is null;
create index engagement_document_tokens_claimed_by_idx on app.engagement_document_tokens (claimed_by);

call private.install_domain_table('app.engagement_document_tokens', 'app.engagement_documents', 'engagement_document_id');
call private.describe('app.engagement_document_tokens', 'Signing links for engagement documents (Section 4.4.6): a person without an account opens the document with the link and its access code and signs it. Only SHA-256 hashes of the token and code are stored; both are shown once. Written only by the token RPCs.', array[
  'engagement_document_id', 'Document the link signs.',
  'recipient_email', 'Email the link was sent to, lower case. A person who signs in with this email, confirmed, may claim the link.',
  'token_hash', 'SHA-256 of the token. Never readable by signed-in callers.',
  'access_code_hash', 'SHA-256 of the token, a colon and the 6-digit access code. Never readable by signed-in callers.',
  'expires_at', 'When the link stops working.',
  'used_at', 'When the document was signed through the link.',
  'signer_name', 'Full name the signer typed when signing.',
  'revoked_at', 'When the link was revoked; issuing a new link for the document revokes the old ones.',
  'failed_attempts', 'Wrong access codes entered; the link locks at 5.',
  'claimed_by', 'Person who claimed the link by signing in with its email.',
  'claimed_at', 'When it was claimed.'
]);

call private.install_policies('app.engagement_document_tokens',
  $$engagement_document_id in (select d.id from app.engagement_documents d
    where d.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.write')))$$);
revoke select, insert, update on app.engagement_document_tokens from authenticated;
grant select (id, org_id, engagement_document_id, recipient_email, expires_at, used_at, signer_name, revoked_at, failed_attempts,
  claimed_by, claimed_at, created_at, created_by, updated_at, updated_by, deleted_at) on app.engagement_document_tokens to authenticated;

insert into private.domain_event_types (code, subject, description) values
  ('engagement_document.token_signed', 'engagement_documents', 'A document was signed through a signing link without an account.');

-- Hashing and resolving -----------------------------------------------------------------------------------------------------

create or replace function private.document_token_hash(p_token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, ''), 'sha256');
$$;

comment on function private.document_token_hash(text) is 'SHA-256 of a document signing token, the only form stored.';

create or replace function private.document_code_hash(p_token text, p_code text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, '') || ':' || coalesce(btrim(p_code), ''), 'sha256');
$$;

comment on function private.document_code_hash(text, text) is 'SHA-256 of the token, a colon and the access code: the token salts the 6-digit code.';

create or replace function private.resolve_document_token(p_token text, p_access_code text)
returns table (token_id uuid, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token app.engagement_document_tokens;
begin
  select * into v_token from app.engagement_document_tokens t where t.token_hash = private.document_token_hash(p_token);
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

comment on function private.resolve_document_token(text, text) is 'Resolves a signing token and access code: invalid, locked after 5 wrong codes, wrong code (counted), expired, or the token id. Returns a reason instead of raising so a wrong code is counted.';

-- Org side -----------------------------------------------------------------------------------------------------------------------

create or replace function app.issue_engagement_document_token(p_document_id uuid, p_recipient_email text, p_valid_for interval default interval '14 days')
returns table (token_id uuid, token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_document app.engagement_documents;
  v_project uuid;
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_token text := 'xdoc_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_code text := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  v_expires timestamptz := now() + p_valid_for;
  v_id uuid;
begin
  perform private.require_person();
  select d.* into v_document from app.engagement_documents d where d.id = p_document_id and d.deleted_at is null;
  select e.project_id into v_project from app.engagements e where e.id = v_document.engagement_id;
  if v_document.id is null or not private.can_on_project(v_project, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  if v_document.engagement_document_state <> 'Sent' then
    perform private.refuse('document_token_state', 'Send the document before issuing a signing link.');
  end if;
  if p_valid_for is null or p_valid_for < interval '1 hour' or p_valid_for > interval '90 days' then
    perform private.refuse('document_token_validity', 'A signing link is valid for 1 hour to 90 days.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    perform private.refuse('document_token_email', 'A signing link goes to a valid email address.');
  end if;
  update app.engagement_document_tokens t set revoked_at = now()
  where t.engagement_document_id = p_document_id and t.revoked_at is null and t.deleted_at is null;
  insert into app.engagement_document_tokens (engagement_document_id, recipient_email, token_hash, access_code_hash, expires_at)
  values (p_document_id, v_email, private.document_token_hash(v_token), private.document_code_hash(v_token, v_code), v_expires)
  returning id into v_id;
  return query select v_id, v_token, v_code, v_expires;
end;
$$;

comment on function app.issue_engagement_document_token(uuid, text, interval) is 'Issues a signing link for a Sent engagement document (opportunities.engagement.write on the project): a token and a 6-digit access code, returned once and stored only as hashes, valid for 1 hour to 90 days. Revokes the document''s earlier links. Delivery is A18''s notification service.';

create or replace function app.revoke_engagement_document_token(p_token_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  perform private.require_person();
  select e.project_id into v_project
  from app.engagement_document_tokens t
  join app.engagement_documents d on d.id = t.engagement_document_id
  join app.engagements e on e.id = d.engagement_id
  where t.id = p_token_id and t.deleted_at is null;
  if v_project is null or not private.can_on_project(v_project, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'signing link not found';
  end if;
  update app.engagement_document_tokens t set revoked_at = coalesce(t.revoked_at, now()) where t.id = p_token_id;
end;
$$;

comment on function app.revoke_engagement_document_token(uuid) is 'Revokes a signing link (opportunities.engagement.write). Revoking twice keeps the first time.';

-- Anyone holding the link ------------------------------------------------------------------------------------------------------------

create or replace function api_public.token_document(p_token text, p_access_code text)
returns table (
  refusal text,
  reason text,
  org_name text,
  project_name text,
  document_kind app.engagement_document_kind,
  title text,
  document_state app.engagement_document_state,
  expires_on date,
  storage_uri text,
  recipient_email text,
  link_expires_at timestamptz,
  signed_at timestamptz,
  signer_name text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_document_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select 'REFUSE'::text, v_reason, null::text, null::text, null::app.engagement_document_kind, null::text,
      null::app.engagement_document_state, null::date, null::text, null::text, null::timestamptz, null::timestamptz, null::text;
    return;
  end if;
  return query
    select null::text, null::text, o.name, p.name, d.document_kind, d.title, d.engagement_document_state, d.expires_on,
      (select v.storage_uri from app.document_versions v where v.document_id = d.document_id order by v.version_number desc limit 1),
      t.recipient_email, t.expires_at, t.used_at, t.signer_name
    from app.engagement_document_tokens t
    join app.engagement_documents d on d.id = t.engagement_document_id
    join app.engagements e on e.id = d.engagement_id
    join app.projects p on p.id = e.project_id
    join app.organizations o on o.id = d.org_id
    where t.id = v_token_id;
end;
$$;

comment on function api_public.token_document(text, text) is 'Signing page without an account (Section 4.4.6): with a valid link and access code, returns the document to sign and where its file is stored (the Gateway server signs a short-lived URL for it). Otherwise one row with refusal REFUSE and the reason: document_token_invalid, document_token_locked, document_access_code or document_token_expired.';

create or replace function api_public.token_sign_document(p_token text, p_access_code text, p_signer_name text)
returns table (signed_at timestamptz, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_document app.engagement_documents;
  v_name text := btrim(coalesce(p_signer_name, ''));
  v_at timestamptz := now();
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_document_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select null::timestamptz, 'REFUSE'::text, v_reason;
    return;
  end if;
  select d.* into v_document from app.engagement_document_tokens t join app.engagement_documents d on d.id = t.engagement_document_id
  where t.id = v_token_id;
  if v_document.engagement_document_state <> 'Sent' then
    return query select null::timestamptz, 'REFUSE'::text, 'document_not_awaiting_signature'::text;
    return;
  end if;
  if char_length(v_name) not between 1 and 200 then
    return query select null::timestamptz, 'REFUSE'::text, 'document_signer_name'::text;
    return;
  end if;
  perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
    'app.engagement_document_state_transitions', 'engagement_document_id', v_document.id, 'Sent', 'Signed',
    left(format('Signed by %s through a signing link.', v_name), 500));
  update app.engagement_document_tokens t set used_at = v_at, signer_name = v_name where t.id = v_token_id;
  perform private.emit_event(v_document.org_id, 'engagement_document.token_signed', 'engagement_documents', v_document.id,
    (select e.project_id from app.engagements e where e.id = v_document.engagement_id), jsonb_build_object('token_id', v_token_id));
  return query select v_at, null::text, null::text;
end;
$$;

comment on function api_public.token_sign_document(text, text, text) is 'Signs a Sent engagement document through a signing link and access code with the name the signer typed (Sent to Signed; the org countersigns to Executed in Atlas). Refusals come back as REFUSE with a reason: the token reasons of token_document, document_not_awaiting_signature or document_signer_name.';

-- Claiming ------------------------------------------------------------------------------------------------------------------------------

create or replace function app.claim_token_submissions()
returns table (claimed_documents integer, claimed_advance integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_email text;
  v_confirmed timestamptz;
  v_documents integer;
  v_advance integer;
begin
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = (select auth.uid());
  if v_confirmed is null then
    perform private.refuse('claim_email_unconfirmed', 'Confirm your email address before claiming links sent to it.');
  end if;
  update app.engagement_document_tokens t set claimed_by = v_person, claimed_at = now()
  where t.recipient_email = v_email and t.claimed_by is null and t.deleted_at is null;
  get diagnostics v_documents = row_count;
  update app.advance_recipient_tokens t set claimed_by = v_person, claimed_at = now()
  where t.recipient_email = v_email and t.claimed_by is null and t.deleted_at is null;
  get diagnostics v_advance = row_count;
  return query select v_documents, v_advance;
end;
$$;

comment on function app.claim_token_submissions() is 'Section 4.4.6: after a person signs up or signs in with a confirmed email, claims every unclaimed engagement document link and advance link sent to that email, so their earlier signatures and answers appear under their account. Returns how many of each were claimed.';

create view api_external.my_token_documents as
select d.id as engagement_document_id, o.name as org_name, d.document_kind, d.title, d.engagement_document_state, t.used_at as signed_at,
  t.signer_name, t.claimed_at
from app.engagement_document_tokens t
join app.engagement_documents d on d.id = t.engagement_document_id and d.deleted_at is null
join app.organizations o on o.id = d.org_id
where t.deleted_at is null and t.claimed_by = private.current_person_id();

call private.describe('api_external.my_token_documents', 'Engagement documents sent to the caller through signing links they claimed, with whether and when they signed.', array[
  'engagement_document_id', 'Document.', 'org_name', 'Org.', 'document_kind', 'Kind.', 'title', 'Title.',
  'engagement_document_state', 'Document state.', 'signed_at', 'When signed through the link.', 'signer_name', 'Name typed when signing.',
  'claimed_at', 'When the caller claimed the link.']);

-- Retention, audit and privileges --------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.engagement_document_tokens');
call private.install_audit_trail('app.engagement_document_tokens');

revoke all on function private.document_token_hash(text) from public, anon, authenticated;
revoke all on function private.document_code_hash(text, text) from public, anon, authenticated;
revoke all on function private.resolve_document_token(text, text) from public, anon, authenticated;
revoke all on function app.issue_engagement_document_token(uuid, text, interval) from public, anon;
revoke all on function app.revoke_engagement_document_token(uuid) from public, anon;
revoke all on function app.claim_token_submissions() from public, anon;
revoke all on function api_public.token_document(text, text) from public;
revoke all on function api_public.token_sign_document(text, text, text) from public;
grant execute on function app.issue_engagement_document_token(uuid, text, interval) to authenticated, service_role;
grant execute on function app.revoke_engagement_document_token(uuid) to authenticated, service_role;
grant execute on function app.claim_token_submissions() to authenticated, service_role;
grant execute on function api_public.token_document(text, text) to anon, authenticated, service_role;
grant execute on function api_public.token_sign_document(text, text, text) to anon, authenticated, service_role;

revoke all on api_external.my_token_documents from public, anon;
grant select on api_external.my_token_documents to authenticated, service_role;
