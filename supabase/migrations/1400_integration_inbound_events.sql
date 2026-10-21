-- 1400_integration_inbound_events.sql
-- A83 Integration runtime (RRR-128, finding A65-013, work package WP13). The connector framework (0600) moves data
-- out on a schedule; nothing received what providers send back. This adds the inbound half that the
-- integration-inbound Edge Function and the integration-worker run:
--   * app.integration_inbound_events: every webhook a provider sends (a Slack link to unfurl, an accounting or
--     calendar change notice), recorded once per provider event (idempotency), then processed by the worker with
--     attempts, exponential backoff (private.integration_backoff, as for sync runs) and a Dead Letter state an
--     admin can send back for another try
--   * per-connection inbound secrets in Supabase Vault (Section 9), for providers whose webhook secret belongs to
--     one connection (a Teams outgoing webhook, a Google Calendar channel token, a Microsoft Graph client state).
--     Platform-wide signing secrets (Slack, Xero, QuickBooks) are Edge Function secrets instead.
--   * app.find_integration_connection: the Connected connection of a provider account id, for routing a webhook
--     whose payload names the account (a Xero tenant, a QuickBooks realm)
-- Signatures are verified before anything is recorded (packages/integrations/src/inbound). Only the service role
-- records and processes events; holders of org.integrations.manage read them and retry a dead letter.

-- Enums ---------------------------------------------------------------------------------------------------------

create type app.integration_inbound_kind as enum ('Link Unfurl', 'Change Notice');
comment on type app.integration_inbound_kind is 'What an inbound webhook asks for: unfurl record links posted in chat (Slack link_shared), or a provider change notice that queues a sync run (accounting and calendar push notifications).';

create type app.integration_inbound_state as enum ('Received', 'Processing', 'Processed', 'Retrying', 'Dead Letter');
comment on type app.integration_inbound_state is 'Inbound event lifecycle: Received, Processing, then Processed, Retrying (a retryable failure with attempts left, due again at next_attempt_at) or Dead Letter (attempts used up or a permanent failure). An admin can send a Dead Letter event back to Received.';

insert into private.domain_event_types (code, subject, description) values
  ('integration_inbound.dead_lettered', 'integration_inbound_events', 'An inbound integration webhook failed for good and waits in the dead letter list.');

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('integration.inbound', 'app.integration_inbound_events', 3, 'Processes one attempt of an inbound integration webhook; the event owns its own attempts and backoff.');

-- Events --------------------------------------------------------------------------------------------------------

create table app.integration_inbound_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  provider_code text not null references private.integration_providers (provider_code),
  inbound_kind app.integration_inbound_kind not null,
  idempotency_key text not null,
  payload jsonb not null,
  inbound_state app.integration_inbound_state not null default 'Received',
  attempt smallint not null default 0,
  max_attempts smallint not null default 8,
  received_at timestamptz not null default now(),
  next_attempt_at timestamptz,
  started_at timestamptz,
  processed_at timestamptz,
  dead_lettered_at timestamptz,
  outcome text,
  error_code text,
  error_message text,
  constraint integration_inbound_events_key_length check (char_length(idempotency_key) between 1 and 200),
  constraint integration_inbound_events_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint integration_inbound_events_payload_size check (octet_length(payload::text) <= 65536),
  constraint integration_inbound_events_attempts check (attempt >= 0 and max_attempts between 1 and 20 and attempt <= max_attempts),
  constraint integration_inbound_events_outcome_length check (outcome is null or char_length(outcome) <= 500),
  constraint integration_inbound_events_error_length check (error_message is null or char_length(error_message) <= 2000),
  constraint integration_inbound_events_dead_letter check ((inbound_state = 'Dead Letter') = (dead_lettered_at is not null)),
  constraint integration_inbound_events_processed check ((inbound_state = 'Processed') = (processed_at is not null))
);

create unique index integration_inbound_events_idempotency_key on app.integration_inbound_events (integration_connection_id, idempotency_key);
create index integration_inbound_events_due_idx on app.integration_inbound_events (next_attempt_at)
  where inbound_state in ('Received', 'Retrying');
create index integration_inbound_events_connection_idx on app.integration_inbound_events (integration_connection_id, received_at desc);
create index integration_inbound_events_provider_code_idx on app.integration_inbound_events (provider_code);

call private.install_domain_table('app.integration_inbound_events', 'app.integration_connections', 'integration_connection_id');
call private.describe('app.integration_inbound_events', 'Webhooks a provider sent to XOS (Section 17), recorded once per provider event after the signature checked out, then processed by the integration worker with retries and exponential backoff. Events that fail for good wait as Dead Letter for an admin.', array[
  'integration_connection_id', 'Connection the webhook belongs to.',
  'provider_code', 'Provider that sent it, the connection''s provider.',
  'inbound_kind', 'Link Unfurl or Change Notice.',
  'idempotency_key', 'Provider event id (or a digest of the body when the provider sends none); a repeat delivery of the same event is recorded once.',
  'payload', 'The part of the provider payload the worker needs (a provider payload, ADR 0002), at most 64 KB.',
  'inbound_state', 'Received, Processing, Processed, Retrying or Dead Letter.',
  'attempt', 'Processing attempts started so far.',
  'max_attempts', 'Attempts before the event goes to Dead Letter.',
  'received_at', 'When the webhook arrived.',
  'next_attempt_at', 'When a Received or Retrying event is due.',
  'started_at', 'When the current or last attempt started.',
  'processed_at', 'When the event was Processed.',
  'dead_lettered_at', 'When the event went to Dead Letter.',
  'outcome', 'What processing did, for example the sync run it queued.',
  'error_code', 'Rule code of the last failure.',
  'error_message', 'Message of the last failure.'
]);

call private.install_policies('app.integration_inbound_events',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.integration_inbound_events', 'Age', 'received_at', interval '90 days', 'Delete', 'Webhook payloads are kept 90 days to trace a sync or a dead letter, then deleted.');

-- Inbound secrets ----------------------------------------------------------------------------------------------

create table private.integration_inbound_secrets (
  integration_connection_id uuid primary key references app.integration_connections (id),
  vault_secret_id uuid not null,
  stored_at timestamptz not null default now()
);

comment on table private.integration_inbound_secrets is 'Pointer from a connection to the secret its provider signs webhooks with, held in vault.secrets as xos_integration_inbound_<connection id>. Only the service role decrypts it, through app.read_integration_inbound_secret.';
comment on column private.integration_inbound_secrets.integration_connection_id is 'Connection the secret belongs to.';
comment on column private.integration_inbound_secrets.vault_secret_id is 'Id of the vault.secrets row holding the encrypted secret.';
comment on column private.integration_inbound_secrets.stored_at is 'When the secret was last stored or rotated.';

alter table private.integration_inbound_secrets enable row level security;
revoke all on private.integration_inbound_secrets from public, anon, authenticated;

create or replace function app.integration_inbound_secrets_stored(p_org_id uuid)
returns table (integration_connection_id uuid, stored_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.authorize_integration_manage(p_org_id);
  return query
  select s.integration_connection_id, s.stored_at
  from private.integration_inbound_secrets s
  join app.integration_connections c on c.id = s.integration_connection_id
  where c.org_id = p_org_id and c.deleted_at is null;
end;
$$;

comment on function app.integration_inbound_secrets_stored(uuid) is 'Which of an org''s connections have an inbound webhook secret, and when it was stored; the secret itself never leaves Vault. Needs org.integrations.manage.';

create or replace function app.store_integration_inbound_secret(p_connection_id uuid, p_secret text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
  v_secret_id uuid;
begin
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null for update;
  perform private.authorize_integration_manage(v_connection.org_id);
  if v_connection.connection_state = 'Disconnected' then
    perform private.refuse('integration_disconnected', 'A disconnected connection is kept for its history and cannot change.');
  end if;
  if p_secret is null or char_length(btrim(p_secret)) < 16 then
    perform private.refuse('integration_inbound_secret_short', 'A webhook secret has at least 16 characters.');
  end if;
  if char_length(p_secret) > 1024 then
    perform private.refuse('integration_inbound_secret_long', 'A webhook secret is at most 1024 characters.');
  end if;
  select s.vault_secret_id into v_secret_id from private.integration_inbound_secrets s where s.integration_connection_id = p_connection_id;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(btrim(p_secret), 'xos_integration_inbound_' || p_connection_id::text,
      format('Inbound webhook secret of integration connection %s (%s).', p_connection_id, v_connection.provider_code));
    insert into private.integration_inbound_secrets (integration_connection_id, vault_secret_id) values (p_connection_id, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, btrim(p_secret));
    update private.integration_inbound_secrets set stored_at = now() where integration_connection_id = p_connection_id;
  end if;
end;
$$;

comment on function app.store_integration_inbound_secret(uuid, text) is 'Stores or rotates the secret a provider signs a connection''s webhooks with, in Supabase Vault (Section 9). Needs org.integrations.manage; the secret is never returned to signed-in callers.';

create or replace function app.read_integration_inbound_secret(p_connection_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret
  from private.integration_inbound_secrets x
  join app.integration_connections c on c.id = x.integration_connection_id and c.deleted_at is null
    and c.connection_state <> 'Disconnected'
  join vault.decrypted_secrets s on s.id = x.vault_secret_id
  where x.integration_connection_id = p_connection_id;
$$;

comment on function app.read_integration_inbound_secret(uuid) is 'Decrypts a connection''s inbound webhook secret for the integration-inbound Edge Function, or NULL when it has none or is disconnected. Service role only.';

create or replace function private.destroy_integration_inbound_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  delete from private.integration_inbound_secrets s where s.integration_connection_id = new.id
  returning s.vault_secret_id into v_secret_id;
  if v_secret_id is not null then
    delete from vault.secrets s where s.id = v_secret_id;
  end if;
  return null;
end;
$$;

comment on function private.destroy_integration_inbound_secret() is 'Destroys a connection''s inbound webhook secret in Vault when it is disconnected, so no secret outlives the connection.';
revoke all on function private.destroy_integration_inbound_secret() from public, anon, authenticated;

create trigger t91_destroy_integration_inbound_secret after update of connection_state on app.integration_connections
  for each row when (new.connection_state = 'Disconnected' and old.connection_state <> 'Disconnected')
  execute function private.destroy_integration_inbound_secret();

-- Routing --------------------------------------------------------------------------------------------------------

create or replace function app.find_integration_connection(p_provider_code text, p_external_account_id text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.integration_connections c
  where c.provider_code = p_provider_code and c.external_account_id = p_external_account_id
    and c.connection_state = 'Connected' and c.deleted_at is null
  order by c.created_at
  limit 1;
$$;

comment on function app.find_integration_connection(text, text) is 'Inbound routing: the Connected connection of a provider account id (a Xero tenant, a QuickBooks realm), or NULL. Service role only.';

-- Recording and processing ---------------------------------------------------------------------------------------

create or replace function app.record_integration_inbound_event(
  p_connection_id uuid,
  p_kind app.integration_inbound_kind,
  p_idempotency_key text,
  p_payload jsonb
)
returns table (event_id uuid, duplicate boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
  v_id uuid;
begin
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null;
  if v_connection.id is null then
    raise exception using errcode = '42501', message = 'the connection does not exist';
  end if;
  if v_connection.connection_state = 'Disconnected' then
    perform private.refuse('integration_disconnected', 'A disconnected connection receives no webhooks.');
  end if;
  insert into app.integration_inbound_events (integration_connection_id, provider_code, inbound_kind, idempotency_key, payload, next_attempt_at)
  values (p_connection_id, v_connection.provider_code, p_kind, p_idempotency_key, p_payload, now())
  on conflict (integration_connection_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select e.id into v_id from app.integration_inbound_events e
    where e.integration_connection_id = p_connection_id and e.idempotency_key = p_idempotency_key;
    return query select v_id, true;
    return;
  end if;
  perform private.enqueue_job(v_connection.org_id, 'integration.inbound', v_id, now());
  return query select v_id, false;
end;
$$;

comment on function app.record_integration_inbound_event(uuid, app.integration_inbound_kind, text, jsonb) is 'Records a verified webhook once per connection and provider event (idempotency) and queues its processing on the job queue. A repeat returns the first event with duplicate = true. Service role only.';

create or replace function app.claim_integration_inbound_event(p_event_id uuid)
returns app.integration_inbound_events
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event app.integration_inbound_events;
begin
  select * into v_event from app.integration_inbound_events e where e.id = p_event_id and e.deleted_at is null for update;
  if v_event.id is null then
    raise exception using errcode = '42501', message = 'the event does not exist';
  end if;
  if v_event.inbound_state not in ('Received', 'Retrying') then
    perform private.refuse('integration_inbound_not_pending', 'Only a Received or Retrying event can be processed.');
  end if;
  if v_event.next_attempt_at is not null and v_event.next_attempt_at > now() then
    perform private.refuse('integration_inbound_not_due', 'The event is not due yet.');
  end if;
  update app.integration_inbound_events
  set inbound_state = 'Processing', attempt = attempt + 1, started_at = now(), next_attempt_at = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

comment on function app.claim_integration_inbound_event(uuid) is 'Worker: starts the next attempt of a Received or due Retrying event. Service role only.';

create or replace function app.complete_integration_inbound_event(p_event_id uuid, p_outcome text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.integration_inbound_events
  set inbound_state = 'Processed', processed_at = now(), outcome = left(p_outcome, 500), error_code = null, error_message = null
  where id = p_event_id and inbound_state = 'Processing';
  if not found then
    perform private.refuse('integration_inbound_not_processing', 'Only an event being processed can be completed.');
  end if;
end;
$$;

comment on function app.complete_integration_inbound_event(uuid, text) is 'Worker: marks a Processing event Processed with what it did. Service role only.';

create or replace function app.fail_integration_inbound_event(
  p_event_id uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
)
returns app.integration_inbound_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event app.integration_inbound_events;
  v_due timestamptz;
begin
  select * into v_event from app.integration_inbound_events e where e.id = p_event_id for update;
  if v_event.id is null or v_event.inbound_state <> 'Processing' then
    perform private.refuse('integration_inbound_not_processing', 'Only an event being processed can fail.');
  end if;
  if p_retryable and v_event.attempt < v_event.max_attempts then
    v_due := now() + private.integration_backoff(v_event.attempt);
    update app.integration_inbound_events
    set inbound_state = 'Retrying', next_attempt_at = v_due,
        error_code = left(p_error_code, 100), error_message = left(p_error_message, 2000)
    where id = p_event_id;
    perform private.enqueue_job(v_event.org_id, 'integration.inbound', p_event_id, v_due);
    return 'Retrying';
  end if;
  update app.integration_inbound_events
  set inbound_state = 'Dead Letter', dead_lettered_at = now(),
      error_code = left(p_error_code, 100), error_message = left(p_error_message, 2000)
  where id = p_event_id;
  perform private.emit_event(v_event.org_id, 'integration_inbound.dead_lettered', 'integration_inbound_events', p_event_id, null,
    jsonb_build_object('provider_code', v_event.provider_code, 'inbound_kind', v_event.inbound_kind, 'error_code', left(p_error_code, 100)));
  return 'Dead Letter';
end;
$$;

comment on function app.fail_integration_inbound_event(uuid, text, text, boolean) is 'Worker: records a failed attempt. A retryable failure with attempts left moves the event to Retrying, due after private.integration_backoff; otherwise it goes to Dead Letter and emits integration_inbound.dead_lettered. Service role only.';

create or replace function app.retry_integration_inbound_event(p_event_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event app.integration_inbound_events;
begin
  select * into v_event from app.integration_inbound_events e where e.id = p_event_id and e.deleted_at is null for update;
  perform private.authorize_integration_manage(v_event.org_id);
  if v_event.inbound_state <> 'Dead Letter' then
    perform private.refuse('integration_inbound_not_dead_letter', 'Only a Dead Letter event can be sent back for another try.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('integration_inbound_reason', 'Say why the event should be tried again (up to 500 characters).');
  end if;
  update app.integration_inbound_events
  set inbound_state = 'Received', attempt = 0, dead_lettered_at = null, next_attempt_at = now(),
      outcome = left('Sent back by an admin: ' || btrim(p_reason), 500)
  where id = p_event_id;
  perform private.enqueue_job(v_event.org_id, 'integration.inbound', p_event_id, now());
end;
$$;

comment on function app.retry_integration_inbound_event(uuid, text) is 'Sends a Dead Letter event back to Received with fresh attempts and queues it. Needs org.integrations.manage and a reason.';

-- Privileges ------------------------------------------------------------------------------------------------------

revoke all on function app.store_integration_inbound_secret(uuid, text) from public, anon;
grant execute on function app.store_integration_inbound_secret(uuid, text) to authenticated, service_role;
revoke all on function app.integration_inbound_secrets_stored(uuid) from public, anon;
grant execute on function app.integration_inbound_secrets_stored(uuid) to authenticated, service_role;
revoke all on function app.read_integration_inbound_secret(uuid) from public, anon, authenticated;
grant execute on function app.read_integration_inbound_secret(uuid) to service_role;
revoke all on function app.find_integration_connection(text, text) from public, anon, authenticated;
grant execute on function app.find_integration_connection(text, text) to service_role;
revoke all on function app.record_integration_inbound_event(uuid, app.integration_inbound_kind, text, jsonb) from public, anon, authenticated;
grant execute on function app.record_integration_inbound_event(uuid, app.integration_inbound_kind, text, jsonb) to service_role;
revoke all on function app.claim_integration_inbound_event(uuid) from public, anon, authenticated;
grant execute on function app.claim_integration_inbound_event(uuid) to service_role;
revoke all on function app.complete_integration_inbound_event(uuid, text) from public, anon, authenticated;
grant execute on function app.complete_integration_inbound_event(uuid, text) to service_role;
revoke all on function app.fail_integration_inbound_event(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function app.fail_integration_inbound_event(uuid, text, text, boolean) to service_role;
revoke all on function app.retry_integration_inbound_event(uuid, text) from public, anon;
grant execute on function app.retry_integration_inbound_event(uuid, text) to authenticated, service_role;
