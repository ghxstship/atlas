-- 0510_jobs_webhooks_usage.sql
-- A18 Platform Services. Jobs, idempotency, webhooks and usage (Section 7.3 Platform services and
-- Billing, Section 5 rule 4, ADR 0003):
--   * job_queue: background work claimed by workers with SKIP LOCKED and retried with backoff
--   * idempotency_keys: per-tenant Idempotency-Key ledger; a replay within 24 hours returns the
--     original response, a different request under the same key is refused
--   * webhook_endpoints, webhook_endpoint_events and webhook_deliveries: every domain event fans out
--     to the org's subscribed endpoints; deliveries are signed HMAC-SHA256 over {timestamp}.{body},
--     retried with exponential backoff for 72 hours and replayable
--   * usage_events (monthly partitions) and usage_rollups (closed monthly totals reported to billing)
--   * carry-overs from A03 (ADR 0016): the kiosk PIN service RPC and a rate limit on
--     api_public.verify_certification

-- Job queue ----------------------------------------------------------------------------------------

create table private.job_kinds (
  code text primary key,
  subject_table text not null,
  max_attempts smallint not null,
  description text not null,
  constraint job_kinds_code_format check (code ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  constraint job_kinds_attempts_range check (max_attempts between 1 and 25),
  constraint job_kinds_description_length check (char_length(btrim(description)) between 1 and 300)
);

comment on table private.job_kinds is 'Kinds of background job a worker runs, the table each kind works on and how often it is tried.';
comment on column private.job_kinds.code is 'Job kind, subject first, for example import.validate.';
comment on column private.job_kinds.subject_table is 'Table whose row the job works on.';
comment on column private.job_kinds.max_attempts is 'Attempts before the job is marked Failed.';
comment on column private.job_kinds.description is 'What the job does.';

alter table private.job_kinds enable row level security;
revoke all on private.job_kinds from public, anon, authenticated;
grant select on private.job_kinds to service_role;

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('import.detect', 'app.import_jobs', 3, 'Finds sheets, header rows and data ranges in an uploaded file and proposes targets.'),
  ('import.validate', 'app.import_jobs', 3, 'Validates every row of an import against the target schema and records row states.'),
  ('import.commit', 'app.import_batches', 3, 'Writes the valid rows of an import batch.'),
  ('import.undo', 'app.import_batches', 3, 'Rolls back an import batch except rows later edits depend on.'),
  ('export.render', 'app.export_jobs', 5, 'Renders an export to CSV, .xlsx or PDF and stores the file.'),
  ('report.run', 'app.report_runs', 5, 'Runs a report definition and stores its result file.'),
  ('notification.deliver', 'app.notifications', 8, 'Delivers a notification through each channel the recipient prefers.'),
  ('digest.send', 'app.email_digest_queue', 5, 'Sends a person''s pending email digest.'),
  ('usage.report', 'app.usage_rollups', 10, 'Reports a closed usage rollup to Stripe metered billing.'),
  ('billing.sync', 'app.stripe_events', 10, 'Applies a received Stripe event to the subscription.'),
  ('inbound.process', 'app.inbound_messages', 5, 'Verifies and files an inbound email.');

create type app.job_status as enum ('Queued', 'Running', 'Succeeded', 'Failed', 'Canceled');
comment on type app.job_status is 'Run status of a background job (a sync status, not a lifecycle; ADR 0002).';

create table app.job_queue (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  job_kind text not null references private.job_kinds (code),
  subject_id uuid not null,
  job_status app.job_status not null default 'Queued',
  run_after timestamptz not null default now(),
  attempts smallint not null default 0,
  locked_by text,
  locked_at timestamptz,
  finished_at timestamptz,
  last_error text,
  constraint job_queue_attempts_nonnegative check (attempts >= 0),
  constraint job_queue_lock_pair check ((locked_by is null) = (locked_at is null)),
  constraint job_queue_finished check ((finished_at is not null) = (job_status in ('Succeeded', 'Failed', 'Canceled'))),
  constraint job_queue_last_error_length check (last_error is null or char_length(last_error) <= 2000),
  constraint job_queue_locked_by_length check (locked_by is null or char_length(locked_by) <= 200)
);

create index job_queue_job_kind_idx on app.job_queue (job_kind);
create index job_queue_ready_idx on app.job_queue (run_after) where job_status = 'Queued';
create index job_queue_subject_idx on app.job_queue (subject_id);

call private.install_domain_table('app.job_queue');
call private.describe('app.job_queue', 'Background jobs (Section 7.3). Workers claim ready jobs with app.claim_jobs, which skips locked rows so two workers never run one job, and report through app.finish_job, which retries with exponential backoff.', array[
  'job_kind', 'What the job does.',
  'subject_id', 'Row of the job kind''s subject table the job works on.',
  'job_status', 'Queued, Running, Succeeded, Failed or Canceled.',
  'run_after', 'Earliest time a worker may claim the job.',
  'attempts', 'Attempts started so far.',
  'locked_by', 'Worker that holds the job while Running.',
  'locked_at', 'When the worker claimed the job.',
  'finished_at', 'When the job reached a final status.',
  'last_error', 'Error of the latest failed attempt.'
]);

call private.install_policies('app.job_queue',
  $$org_id in (select private.orgs_with_capability('org.settings.read'))$$);

create or replace function private.enqueue_job(p_org_id uuid, p_job_kind text, p_subject_id uuid, p_run_after timestamptz default now())
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  insert into app.job_queue (org_id, job_kind, subject_id, run_after)
  values (p_org_id, p_job_kind, p_subject_id, coalesce(p_run_after, now()))
  returning id;
$$;

comment on function private.enqueue_job(uuid, text, uuid, timestamptz) is 'Queues a background job for a subject row. Called by triggers and definer RPCs.';

create or replace function app.claim_jobs(p_worker text, p_job_kind text, p_limit integer default 10)
returns setof app.job_queue
language sql
volatile
security definer
set search_path = ''
as $$
  update app.job_queue j
  set job_status = 'Running', attempts = j.attempts + 1, locked_by = left(p_worker, 200), locked_at = now()
  where j.id in (
    select q.id from app.job_queue q
    where q.job_status = 'Queued' and q.run_after <= now() and q.job_kind = p_job_kind and q.deleted_at is null
    order by q.run_after, q.id
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  )
  returning j.*;
$$;

comment on function app.claim_jobs(text, text, integer) is 'Worker API (service role): claims up to p_limit ready jobs of one kind. SKIP LOCKED keeps concurrent workers from claiming the same job.';

create or replace function app.finish_job(p_job_id uuid, p_succeeded boolean, p_error text default null)
returns app.job_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job app.job_queue;
  v_max smallint;
begin
  select * into v_job from app.job_queue where id = p_job_id for update;
  if v_job.id is null or v_job.job_status <> 'Running' then
    perform private.refuse('job_not_running', 'Only a running job can be finished.');
  end if;
  v_max := (select k.max_attempts from private.job_kinds k where k.code = v_job.job_kind);
  if p_succeeded then
    update app.job_queue set job_status = 'Succeeded', finished_at = now(), locked_by = null, locked_at = null, last_error = null
    where id = p_job_id;
    return 'Succeeded';
  end if;
  if v_job.attempts >= v_max then
    update app.job_queue set job_status = 'Failed', finished_at = now(), locked_by = null, locked_at = null,
      last_error = left(coalesce(p_error, 'Failed without an error message.'), 2000)
    where id = p_job_id;
    return 'Failed';
  end if;
  update app.job_queue set job_status = 'Queued', locked_by = null, locked_at = null,
    run_after = now() + make_interval(secs => least(30 * power(2, v_job.attempts - 1), 21600)),
    last_error = left(coalesce(p_error, 'Failed without an error message.'), 2000)
  where id = p_job_id;
  return 'Queued';
end;
$$;

comment on function app.finish_job(uuid, boolean, text) is 'Worker API (service role): records a job outcome. A failure is retried after 30 seconds doubling per attempt (capped at 6 hours) until the kind''s attempts are used, then marked Failed with its error.';

-- Idempotency keys (ADR 0003) ------------------------------------------------------------------------

create table app.idempotency_keys (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  idempotency_key text not null,
  person_id uuid references app.people (id),
  request_hash bytea not null,
  response_status smallint,
  response_body jsonb,
  completed_at timestamptz,
  constraint idempotency_keys_key_length check (char_length(idempotency_key) between 1 and 255),
  constraint idempotency_keys_request_hash_length check (octet_length(request_hash) = 32),
  constraint idempotency_keys_response_pair check ((response_status is null) = (completed_at is null)),
  constraint idempotency_keys_status_range check (response_status is null or response_status between 100 and 599)
);

create index idempotency_keys_person_id_idx on app.idempotency_keys (person_id);

call private.install_domain_table('app.idempotency_keys');
call private.describe('app.idempotency_keys', 'Idempotency-Key ledger per tenant (ADR 0003, Section 5 rule 4): two devices or tabs draining one queue never file a record twice. A key lives 24 hours; a replay returns the stored response.', array[
  'idempotency_key', 'Idempotency-Key header value, unique per org.',
  'person_id', 'Person whose request first used the key.',
  'request_hash', 'SHA-256 of method, path and body of the first request; a different request under the same key is refused.',
  'response_status', 'HTTP status of the original response, once it completed.',
  'response_body', 'Original response body (an API provider payload, ADR 0002), returned verbatim on replay.',
  'completed_at', 'When the original request completed.'
]);

create unique index idempotency_keys_org_key on app.idempotency_keys (org_id, idempotency_key) where deleted_at is null;

call private.install_policies('app.idempotency_keys',
  $$person_id = (select private.current_person_id())$$);

create or replace function app.begin_idempotent_request(p_org_id uuid, p_key text, p_request_hash bytea)
returns table (outcome text, response_status smallint, response_body jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.idempotency_keys;
  v_person uuid := private.current_person_id();
begin
  if v_person is not null and not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if v_person is null and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role'
     and current_user not in ('postgres', 'service_role') then
    raise exception using errcode = '42501', message = 'a signed-in caller is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org_id::text || ':' || p_key, 0));
  update app.idempotency_keys set deleted_at = now()
  where org_id = p_org_id and idempotency_key = p_key and deleted_at is null and created_at < now() - interval '24 hours';
  select * into v_row from app.idempotency_keys k where k.org_id = p_org_id and k.idempotency_key = p_key and k.deleted_at is null;
  if v_row.id is null then
    insert into app.idempotency_keys (org_id, idempotency_key, person_id, request_hash)
    values (p_org_id, p_key, v_person, p_request_hash);
    return query select 'proceed'::text, null::smallint, null::jsonb;
  elsif v_row.request_hash <> p_request_hash then
    return query select 'mismatch'::text, null::smallint, null::jsonb;
  elsif v_row.completed_at is null then
    return query select 'in_progress'::text, null::smallint, null::jsonb;
  else
    return query select 'replay'::text, v_row.response_status, v_row.response_body;
  end if;
end;
$$;

comment on function app.begin_idempotent_request(uuid, text, bytea) is 'Starts a POST under an Idempotency-Key (ADR 0003). Returns proceed for a new key, replay with the original response for a completed one, in_progress while the first request runs (the API answers 409), or mismatch when the same key carries a different request (422). Keys expire after 24 hours.';

create or replace function app.complete_idempotent_request(p_org_id uuid, p_key text, p_response_status smallint, p_response_body jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.idempotency_keys
  set response_status = p_response_status, response_body = p_response_body, completed_at = now()
  where org_id = p_org_id and idempotency_key = p_key and deleted_at is null and completed_at is null
    and (person_id is not distinct from private.current_person_id() or private.current_person_id() is null);
  if not found then
    perform private.refuse('idempotency_key_not_open', 'No open request holds this Idempotency-Key.');
  end if;
end;
$$;

comment on function app.complete_idempotent_request(uuid, text, smallint, jsonb) is 'Stores the response of the request that holds an Idempotency-Key, so replays return it verbatim.';

create or replace function app.abandon_idempotent_request(p_org_id uuid, p_key text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update app.idempotency_keys set deleted_at = now()
  where org_id = p_org_id and idempotency_key = p_key and deleted_at is null and completed_at is null
    and (person_id is not distinct from private.current_person_id() or private.current_person_id() is null);
$$;

comment on function app.abandon_idempotent_request(uuid, text) is 'Releases an Idempotency-Key whose request failed before producing a response, so the client may retry with the same key.';

-- Webhook endpoints ------------------------------------------------------------------------------------

create table app.webhook_endpoints (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  url text not null,
  description text,
  signing_secret_id uuid not null,
  disabled_at timestamptz,
  constraint webhook_endpoints_url_https check (url ~ '^https://[^/\s:@]+(:[0-9]{1,5})?(/[^\s]*)?$' and char_length(url) <= 2000),
  constraint webhook_endpoints_description_length check (description is null or char_length(btrim(description)) between 1 and 300)
);

call private.install_domain_table('app.webhook_endpoints');
call private.describe('app.webhook_endpoints', 'Outbound webhook endpoints of an org (Section 10.1, ADR 0003). The signing secret lives in Supabase Vault; only its reference is stored here.', array[
  'url', 'HTTPS URL deliveries are posted to. Private network hosts are refused.',
  'description', 'What the endpoint is for.',
  'signing_secret_id', 'Vault secret id of the HMAC-SHA256 signing secret (vault.secrets).',
  'disabled_at', 'When the endpoint was turned off; disabled endpoints get no new deliveries.'
]);

create unique index webhook_endpoints_signing_secret_key on app.webhook_endpoints (signing_secret_id);

create or replace function private.assert_public_webhook_host(p_url text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_host text := lower(substring(p_url from '^https://([^/:]+)'));
  v_ip inet;
begin
  if v_host is null or v_host = 'localhost' or v_host like '%.localhost' or v_host like '%.local' or v_host like '%.internal' then
    perform private.refuse('webhook_private_host', 'Webhook endpoints must be public HTTPS hosts.');
  end if;
  begin
    v_ip := v_host::inet;
  exception when invalid_text_representation then
    return;
  end;
  if v_ip << '10.0.0.0/8' or v_ip << '172.16.0.0/12' or v_ip << '192.168.0.0/16' or v_ip << '127.0.0.0/8'
     or v_ip << '169.254.0.0/16' or v_ip << '100.64.0.0/10' or v_ip << '0.0.0.0/8' then
    perform private.refuse('webhook_private_host', 'Webhook endpoints must be public HTTPS hosts.');
  end if;
end;
$$;

comment on function private.assert_public_webhook_host(text) is 'SSRF guard (Section 9): refuses localhost, internal names and private, loopback, link-local and carrier-grade NAT addresses. The dispatcher repeats the check after DNS resolution.';

create or replace function private.guard_webhook_endpoint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_public_webhook_host(new.url);
  if tg_op = 'INSERT' then
    if not private.org_has_feature(new.org_id, 'webhooks') then
      perform private.refuse('plan_feature_required', 'Webhooks need the Pro plan or above.');
    end if;
    if not private.in_trusted_operation('webhook_endpoint_create') then
      perform private.refuse('webhook_endpoint_rpc_only', 'Create endpoints with app.create_webhook_endpoint, which issues the signing secret.');
    end if;
  elsif new.signing_secret_id <> old.signing_secret_id then
    perform private.refuse('webhook_secret_immutable', 'Rotate a signing secret by creating a new endpoint.');
  end if;
  return new;
end;
$$;

comment on function private.guard_webhook_endpoint() is 'Webhook endpoints: public HTTPS only, the webhooks plan feature, created only by the RPC that issues the secret, and the secret reference never changes.';

create trigger t40_guard_webhook_endpoint before insert or update on app.webhook_endpoints
  for each row execute function private.guard_webhook_endpoint();

call private.install_policies('app.webhook_endpoints',
  $$org_id in (select private.orgs_with_capability('org.webhooks.manage'))$$,
  null,
  $$org_id in (select private.orgs_with_capability('org.webhooks.manage'))$$);
call private.install_audit_trail('app.webhook_endpoints');

create table app.webhook_endpoint_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  webhook_endpoint_id uuid not null references app.webhook_endpoints (id),
  event_type text not null references private.domain_event_types (code)
);

create index webhook_endpoint_events_endpoint_idx on app.webhook_endpoint_events (webhook_endpoint_id);
create index webhook_endpoint_events_event_type_idx on app.webhook_endpoint_events (event_type);

call private.install_domain_table('app.webhook_endpoint_events', 'app.webhook_endpoints', 'webhook_endpoint_id');
call private.describe('app.webhook_endpoint_events', 'Event types an endpoint subscribes to, one row per endpoint and event type.', array[
  'webhook_endpoint_id', 'Endpoint.',
  'event_type', 'Event code from the domain event catalog.'
]);

create unique index webhook_endpoint_events_unique on app.webhook_endpoint_events (webhook_endpoint_id, event_type) where deleted_at is null;

call private.install_policies('app.webhook_endpoint_events',
  $$org_id in (select private.orgs_with_capability('org.webhooks.manage'))$$,
  $$org_id in (select private.orgs_with_capability('org.webhooks.manage'))$$);
call private.install_audit_trail('app.webhook_endpoint_events');

create or replace function app.create_webhook_endpoint(p_org_id uuid, p_url text, p_event_types text[], p_description text default null)
returns table (webhook_endpoint_id uuid, signing_secret text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_secret text := 'whsec_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_secret_id uuid;
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.webhooks.manage') then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if coalesce(cardinality(p_event_types), 0) = 0 then
    perform private.refuse('webhook_events_required', 'Subscribe the endpoint to at least one event type.');
  end if;
  v_secret_id := vault.create_secret(v_secret, 'webhook:' || private.uuid_v7()::text, 'XOS webhook signing secret');
  perform private.begin_trusted_operation('webhook_endpoint_create');
  insert into app.webhook_endpoints (org_id, url, description, signing_secret_id)
  values (p_org_id, btrim(p_url), nullif(btrim(p_description), ''), v_secret_id)
  returning id into v_id;
  perform private.end_trusted_operation('webhook_endpoint_create');
  insert into app.webhook_endpoint_events (webhook_endpoint_id, event_type)
  select v_id, e from (select distinct unnest(p_event_types) as e) d;
  return query select v_id, v_secret;
end;
$$;

comment on function app.create_webhook_endpoint(uuid, text, text[], text) is 'Creates a webhook endpoint subscribed to the given event types, stores a new signing secret in Vault and returns it once. Needs org.webhooks.manage and the webhooks plan feature.';

create or replace function private.webhook_signing_secret(p_webhook_endpoint_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s
  join app.webhook_endpoints e on e.signing_secret_id = s.id
  where e.id = p_webhook_endpoint_id;
$$;

comment on function private.webhook_signing_secret(uuid) is 'Decrypted signing secret of an endpoint, for signing deliveries inside the database. Never exposed to signed-in callers.';

create or replace function private.webhook_signature(p_secret text, p_timestamp bigint, p_body text)
returns text
language sql
immutable
set search_path = ''
as $$
  select format('t=%s,v1=%s', p_timestamp,
    encode(extensions.hmac(convert_to(p_timestamp::text || '.' || p_body, 'UTF8'), convert_to(p_secret, 'UTF8'), 'sha256'), 'hex'));
$$;

comment on function private.webhook_signature(text, bigint, text) is 'XOS-Signature header value (ADR 0003): t={unix seconds},v1={hex HMAC-SHA256 of "{timestamp}.{body}" under the endpoint secret}.';

-- Webhook deliveries (partitioned) ---------------------------------------------------------------------

create type app.delivery_status as enum ('Pending', 'Delivering', 'Delivered', 'Retrying', 'Expired');
comment on type app.delivery_status is 'Delivery status of a webhook (a delivery status, ADR 0002). Expired means 72 hours passed without a 2xx response.';

create table app.webhook_deliveries (
  id uuid not null default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  webhook_endpoint_id uuid not null references app.webhook_endpoints (id),
  domain_event_id uuid not null references app.domain_events (id),
  delivery_status app.delivery_status not null default 'Pending',
  attempt_count smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_response_status smallint,
  last_error text,
  delivered_at timestamptz,
  replay_requested_by uuid references app.people (id),
  created_at timestamptz not null default now(),
  primary key (id, created_at),
  constraint webhook_deliveries_attempts_nonnegative check (attempt_count >= 0),
  constraint webhook_deliveries_delivered check ((delivered_at is not null) = (delivery_status = 'Delivered')),
  constraint webhook_deliveries_last_error_length check (last_error is null or char_length(last_error) <= 2000)
) partition by range (created_at);

create index webhook_deliveries_endpoint_idx on app.webhook_deliveries (webhook_endpoint_id, created_at);
create index webhook_deliveries_domain_event_id_idx on app.webhook_deliveries (domain_event_id);
create index webhook_deliveries_due_idx on app.webhook_deliveries (next_attempt_at) where delivery_status in ('Pending', 'Retrying');
create index webhook_deliveries_replay_requested_by_idx on app.webhook_deliveries (replay_requested_by);

call private.install_domain_table('app.webhook_deliveries', 'app.webhook_endpoints', 'webhook_endpoint_id', array['app.domain_events', 'domain_event_id']);
call private.describe('app.webhook_deliveries', 'One delivery of one domain event to one endpoint (ADR 0003), in monthly partitions. Retried with exponential backoff for 72 hours; a replay is a new delivery of the same event.', array[
  'id', 'Delivery id, UUID v7; sent as XOS-Delivery.',
  'webhook_endpoint_id', 'Endpoint the event is posted to.',
  'domain_event_id', 'Domain event delivered; the body is built from it, so every attempt sends the same body.',
  'delivery_status', 'Pending, Delivering, Delivered, Retrying or Expired.',
  'attempt_count', 'Attempts started.',
  'next_attempt_at', 'When the dispatcher may try next.',
  'last_attempt_at', 'When the latest attempt started.',
  'last_response_status', 'HTTP status of the latest response, or null when no response arrived.',
  'last_error', 'Network or HTTP error of the latest failed attempt.',
  'delivered_at', 'When a 2xx response arrived.',
  'replay_requested_by', 'Person who replayed the event from Atlas, for a replay.'
]);

insert into private.partitioned_tables (table_name, partition_column, premake_months, maintenance_order)
values ('app.webhook_deliveries', 'created_at', 3, 70);
select private.ensure_partitions('app.webhook_deliveries');

call private.install_policies('app.webhook_deliveries',
  $$org_id in (select private.orgs_with_capability('org.webhooks.manage'))$$);

create or replace function private.fan_out_webhooks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.webhook_deliveries (webhook_endpoint_id, domain_event_id)
  select e.id, new.id
  from app.webhook_endpoints e
  join app.webhook_endpoint_events s on s.webhook_endpoint_id = e.id and s.deleted_at is null
  where e.org_id = new.org_id and e.disabled_at is null and e.deleted_at is null and s.event_type = new.event_type;
  return null;
end;
$$;

comment on function private.fan_out_webhooks() is 'After insert trigger on app.domain_events: queues one delivery per active endpoint of the org subscribed to the event type.';

create trigger t87_fan_out_webhooks after insert on app.domain_events
  for each row execute function private.fan_out_webhooks();

create or replace function private.webhook_body(p_domain_event_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', e.id, 'type', e.event_type, 'occurred_at', e.occurred_at,
    'project_id', e.project_id, 'subject', jsonb_build_object('table', e.subject_table, 'id', e.subject_id), 'data', e.data)::text
  from app.domain_events e where e.id = p_domain_event_id;
$$;

comment on function private.webhook_body(uuid) is 'Webhook body of a domain event. Built from the append-only event, so every attempt and replay sends identical bytes.';

create or replace function private.webhook_retry_delay(p_attempt integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select make_interval(secs => least(30 * power(2, greatest(p_attempt, 1) - 1), 43200));
$$;

comment on function private.webhook_retry_delay(integer) is 'Exponential backoff after a failed attempt: 30 seconds doubling per attempt, capped at 12 hours.';

create or replace function app.claim_webhook_deliveries(p_limit integer default 25)
returns table (delivery_id uuid, url text, event_type text, body text, signature text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now bigint := extract(epoch from now())::bigint;
begin
  return query
  with due as (
    select d.id, d.created_at from app.webhook_deliveries d
    where d.delivery_status in ('Pending', 'Retrying') and d.next_attempt_at <= now()
    order by d.next_attempt_at
    limit least(greatest(p_limit, 1), 200)
    for update skip locked
  ), claimed as (
    update app.webhook_deliveries d
    set delivery_status = 'Delivering', attempt_count = d.attempt_count + 1, last_attempt_at = now()
    from due where d.id = due.id and d.created_at = due.created_at
    returning d.id, d.webhook_endpoint_id, d.domain_event_id
  )
  select c.id, e.url, ev.event_type, private.webhook_body(c.domain_event_id),
    private.webhook_signature(private.webhook_signing_secret(e.id), v_now, private.webhook_body(c.domain_event_id))
  from claimed c
  join app.webhook_endpoints e on e.id = c.webhook_endpoint_id
  join app.domain_events ev on ev.id = c.domain_event_id;
end;
$$;

comment on function app.claim_webhook_deliveries(integer) is 'Dispatcher API (service role): claims due deliveries with SKIP LOCKED and returns the URL, event type, body and XOS-Signature header to post.';

create or replace function app.record_webhook_attempt(p_delivery_id uuid, p_response_status smallint, p_error text default null)
returns app.delivery_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.webhook_deliveries;
  v_status app.delivery_status;
begin
  select * into v_delivery from app.webhook_deliveries where id = p_delivery_id for update;
  if v_delivery.id is null or v_delivery.delivery_status <> 'Delivering' then
    perform private.refuse('webhook_delivery_not_in_flight', 'Only a delivery being attempted can record an outcome.');
  end if;
  if p_response_status between 200 and 299 then
    v_status := 'Delivered';
  elsif now() + private.webhook_retry_delay(v_delivery.attempt_count) > v_delivery.created_at + interval '72 hours' then
    v_status := 'Expired';
  else
    v_status := 'Retrying';
  end if;
  update app.webhook_deliveries
  set delivery_status = v_status, last_response_status = p_response_status,
    last_error = case when v_status = 'Delivered' then null else left(coalesce(p_error, format('HTTP %s', p_response_status)), 2000) end,
    delivered_at = case when v_status = 'Delivered' then now() end,
    next_attempt_at = case when v_status = 'Retrying' then now() + private.webhook_retry_delay(v_delivery.attempt_count) else next_attempt_at end
  where id = p_delivery_id and created_at = v_delivery.created_at;
  return v_status;
end;
$$;

comment on function app.record_webhook_attempt(uuid, smallint, text) is 'Dispatcher API (service role): records an attempt. 2xx delivers; anything else retries with exponential backoff until 72 hours after the delivery was created, then expires.';

create or replace function app.replay_webhook_delivery(p_delivery_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.webhook_deliveries;
  v_id uuid;
begin
  select * into v_delivery from app.webhook_deliveries where id = p_delivery_id;
  if v_delivery.id is null or not private.has_capability(v_delivery.org_id, 'org.webhooks.manage') then
    raise exception using errcode = '42501', message = 'webhook delivery not found';
  end if;
  insert into app.webhook_deliveries (webhook_endpoint_id, domain_event_id, replay_requested_by)
  values (v_delivery.webhook_endpoint_id, v_delivery.domain_event_id, private.current_person_id())
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.replay_webhook_delivery(uuid) is 'Replays a delivery from Atlas (ADR 0003): queues a new delivery of the same event to the same endpoint, recording who asked. Needs org.webhooks.manage.';

-- Usage (Section 16) ---------------------------------------------------------------------------------------

create table private.usage_meters (
  code text primary key,
  unit text not null,
  metered_billing boolean not null,
  sort_order smallint not null unique,
  constraint usage_meters_code_format check (code ~ '^[a-z][a-z_]*$')
);

comment on table private.usage_meters is 'What the platform meters (Section 16): seats and field members, external engagements, messages, API calls, storage and AI. Labels come from the i18n catalogs keyed by code.';
comment on column private.usage_meters.code is 'Meter code.';
comment on column private.usage_meters.unit is 'Unit counted, for example member, message or byte_day.';
comment on column private.usage_meters.metered_billing is 'True when closed totals are reported to Stripe metered billing.';
comment on column private.usage_meters.sort_order is 'Display order.';

alter table private.usage_meters enable row level security;
revoke all on private.usage_meters from public, anon, authenticated;
grant select on private.usage_meters to service_role;

insert into private.usage_meters (code, unit, metered_billing, sort_order) values
  ('field_members', 'member', true, 1),
  ('external_engagements', 'engagement', false, 2),
  ('emails_sent', 'message', false, 3),
  ('sms_segments', 'segment', true, 4),
  ('push_sent', 'message', false, 5),
  ('api_requests', 'request', false, 6),
  ('storage_bytes', 'byte_day', false, 7),
  ('ai_tokens', 'token', true, 8);

create table app.usage_events (
  id uuid not null default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  meter_code text not null references private.usage_meters (code),
  quantity bigint not null,
  source_id uuid,
  created_at timestamptz not null default now(),
  primary key (id, created_at),
  constraint usage_events_quantity_positive check (quantity > 0)
) partition by range (created_at);

create index usage_events_org_meter_idx on app.usage_events (org_id, meter_code, created_at);
create index usage_events_meter_code_idx on app.usage_events (meter_code);

call private.install_domain_table('app.usage_events', null, null, '{}', true);
call private.describe('app.usage_events', 'Metered usage (Section 16), one row per counted act, in monthly partitions. Written by the database and platform services only.', array[
  'id', 'Usage event id, UUID v7.',
  'meter_code', 'What was used.',
  'quantity', 'How much, in the meter''s unit.',
  'source_id', 'Row that caused the usage, when there is one (a notification delivery, an AI request).'
]);

insert into private.partitioned_tables (table_name, partition_column, premake_months, maintenance_order)
values ('app.usage_events', 'created_at', 3, 60);
select private.ensure_partitions('app.usage_events');

call private.install_policies('app.usage_events',
  $$org_id in (select private.orgs_with_capability('org.usage.read'))$$);

create or replace function private.record_usage(p_org_id uuid, p_meter text, p_quantity bigint, p_source_id uuid default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into app.usage_events (org_id, meter_code, quantity, source_id) values (p_org_id, p_meter, p_quantity, p_source_id);
$$;

comment on function private.record_usage(uuid, text, bigint, uuid) is 'Counts usage against a meter for an org.';

create table app.usage_rollups (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  meter_code text not null references private.usage_meters (code),
  period_start date not null,
  quantity bigint not null,
  closed_at timestamptz not null default now(),
  reported_at timestamptz,
  stripe_usage_record_id text,
  constraint usage_rollups_month_start check (period_start = date_trunc('month', period_start)::date),
  constraint usage_rollups_quantity_nonnegative check (quantity >= 0),
  constraint usage_rollups_reported_pair check ((reported_at is null) = (stripe_usage_record_id is null))
);

create index usage_rollups_meter_code_idx on app.usage_rollups (meter_code);

call private.install_domain_table('app.usage_rollups');
call private.describe('app.usage_rollups', 'Closed monthly usage totals per org and meter: the billing record reported to Stripe. Written once by the monthly rollup after the month ends and kept after the usage events age out (stored total registered in the denormalization register).', array[
  'meter_code', 'Meter.',
  'period_start', 'First day of the month the total covers (UTC).',
  'quantity', 'Total usage in the month, summed from usage_events when the month closed.',
  'closed_at', 'When the total was computed.',
  'reported_at', 'When the total was reported to Stripe.',
  'stripe_usage_record_id', 'Stripe usage record id returned on reporting.'
]);

create unique index usage_rollups_period_key on app.usage_rollups (org_id, meter_code, period_start) where deleted_at is null;

call private.install_policies('app.usage_rollups',
  $$org_id in (select private.orgs_with_capability('org.usage.read'))$$);

create or replace function private.guard_usage_rollup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.quantity <> old.quantity or new.period_start <> old.period_start or new.meter_code <> old.meter_code
     or (old.reported_at is not null and (new.reported_at is distinct from old.reported_at
         or new.stripe_usage_record_id is distinct from old.stripe_usage_record_id))) then
    perform private.refuse('usage_rollup_closed', 'A closed usage total never changes; only its first report to Stripe is recorded.');
  end if;
  if tg_op = 'INSERT' and new.period_start + interval '1 month' > now() at time zone 'UTC' then
    perform private.refuse('usage_period_open', 'A month is rolled up only after it ends.');
  end if;
  return new;
end;
$$;

comment on function private.guard_usage_rollup() is 'Usage rollups: only ended months, the total never changes, and the Stripe report is recorded once.';

create trigger t40_guard_usage_rollup before insert or update on app.usage_rollups
  for each row execute function private.guard_usage_rollup();

create or replace function private.rollup_usage(p_period_start date)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into app.usage_rollups (org_id, meter_code, period_start, quantity)
  select u.org_id, u.meter_code, p_period_start, sum(u.quantity)
  from app.usage_events u
  where u.created_at >= (p_period_start::timestamp at time zone 'UTC')
    and u.created_at < ((p_period_start + interval '1 month')::timestamp at time zone 'UTC')
    and u.deleted_at is null
    and not exists (select 1 from app.usage_rollups r where r.org_id = u.org_id and r.meter_code = u.meter_code
                    and r.period_start = p_period_start and r.deleted_at is null)
  group by u.org_id, u.meter_code;
  get diagnostics v_count = row_count;
  insert into app.job_queue (org_id, job_kind, subject_id)
  select r.org_id, 'usage.report', r.id from app.usage_rollups r
  join private.usage_meters m on m.code = r.meter_code and m.metered_billing
  where r.period_start = p_period_start and r.reported_at is null and r.deleted_at is null
    and not exists (select 1 from app.job_queue j where j.subject_id = r.id and j.job_kind = 'usage.report');
  return v_count;
end;
$$;

comment on function private.rollup_usage(date) is 'Closes a month: sums each org''s usage per meter into usage_rollups (once) and queues metered totals for reporting to Stripe. Returns the totals written.';

select cron.schedule('xos_monthly_usage_rollup', '30 1 1 * *',
  $$select private.rollup_usage((date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date)$$);

-- Kiosk PIN service (A03 carry-over, ADR 0016) -------------------------------------------------------------

create type app.kiosk_punch as enum ('Clock In', 'Clock Out');
comment on type app.kiosk_punch is 'What a kiosk punch did.';

create or replace function app.kiosk_punch(p_device_key text, p_membership_id uuid, p_pin text, p_project_id uuid default null)
returns table (time_entry_id uuid, punch app.kiosk_punch, refusal text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device app.kiosk_devices;
  v_project uuid;
  v_open uuid;
  v_id uuid;
begin
  if private.rate_limit_exceeded('kiosk_pin.failure', p_device_key, 20, interval '15 minutes') then
    return query select null::uuid, null::app.kiosk_punch, 'kiosk_rate_limited'::text;
    return;
  end if;
  if not private.verify_kiosk_pin(p_device_key, p_membership_id, p_pin) then
    perform private.note_rate_event('kiosk_pin.failure', p_device_key);
    return query select null::uuid, null::app.kiosk_punch, 'kiosk_pin_rejected'::text;
    return;
  end if;
  select * into v_device from app.kiosk_devices d where d.device_key_hash = extensions.digest(p_device_key, 'sha256');
  v_project := coalesce(v_device.project_id, p_project_id);
  if v_project is null or (v_device.project_id is not null and p_project_id is not null and p_project_id <> v_device.project_id)
     or not exists (select 1 from app.projects p where p.id = v_project and p.org_id = v_device.org_id and p.deleted_at is null) then
    perform private.refuse('kiosk_project', 'The punch needs a project of the kiosk''s org; a project kiosk punches only its project.');
  end if;
  select t.id into v_open from app.time_entries t
  where t.membership_id = p_membership_id and t.project_id = v_project and t.clock_out is null and t.deleted_at is null
  order by t.clock_in desc limit 1 for update;
  if v_open is not null then
    update app.time_entries set clock_out = now() where id = v_open;
    return query select v_open, 'Clock Out'::app.kiosk_punch, null::text;
  else
    insert into app.time_entries (project_id, membership_id, clock_in, source, kiosk_device_id)
    values (v_project, p_membership_id, now(), 'Kiosk', v_device.id)
    returning id into v_id;
    return query select v_id, 'Clock In'::app.kiosk_punch, null::text;
  end if;
end;
$$;

comment on function app.kiosk_punch(text, uuid, text, uuid) is 'Kiosk PIN service (service role only, called by the kiosk-punch Edge Function): verifies the device key and member PIN through private.verify_kiosk_pin, limits failed PINs to 20 per device in 15 minutes, then clocks the member out of their open entry or in to a new Kiosk entry on the kiosk''s project. A rejected PIN or a rate-limited kiosk returns a refusal code instead of raising, so failure counts persist (invariant 8).';

-- Rate limit for the public certificate check (A03 carry-over, ADR 0016) ----------------------------------

create or replace function api_public.verify_certification(p_verification_code text)
returns table (holder_name text, certification text, issuing_body text, expires_on date)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client text := coalesce(host(private.request_ip()), 'unknown');
  v_found integer := 0;
begin
  if private.rate_limit_exceeded('verify_certification.failure', v_client, 10, interval '15 minutes') then
    return;
  end if;
  return query
  select p.full_name, c.name, c.issuing_body, h.expires_on
  from app.certification_holders h
  join app.certifications c on c.id = h.certification_id and c.deleted_at is null
  join app.people p on p.id = h.person_id
  where h.verification_code = p_verification_code and h.public_verification_consented and h.deleted_at is null
    and (h.expires_on is null or h.expires_on >= current_date);
  get diagnostics v_found = row_count;
  if v_found = 0 then
    perform private.note_rate_event('verify_certification.failure', v_client);
  end if;
end;
$$;

comment on function api_public.verify_certification(text) is 'Named token RPC (invariants 7, 8 and 21): returns only the fields a public verification page renders for a current certificate whose holder consented; nothing otherwise. Ten failed lookups per client in 15 minutes lock the client out (Section 9).';
revoke all on function api_public.verify_certification(text) from public;
grant execute on function api_public.verify_certification(text) to anon, authenticated, service_role;

-- Retention ----------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.job_queue', 'Age', 'finished_at', interval '30 days', 'Delete', 'Finished jobs are kept 30 days for support.'),
  ('app.idempotency_keys', 'Age', 'created_at', interval '24 hours', 'Delete', 'Idempotency keys live 24 hours (ADR 0003).'),
  ('app.webhook_endpoints', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Deleted endpoints kept a year for delivery history.'),
  ('app.webhook_endpoint_events', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Kept as long as their endpoint.'),
  ('app.webhook_deliveries', 'Age', 'created_at', interval '90 days', 'Drop Partition', 'Delivery history kept 90 days for replay and support.'),
  ('app.usage_events', 'Age', 'created_at', interval '25 months', 'Drop Partition', 'Usage detail kept two years for billing disputes.'),
  ('app.usage_rollups', 'Age', 'closed_at', interval '7 years', 'Delete', 'Billing records kept 7 years.');

-- Privileges ----------------------------------------------------------------------------------------------

revoke all on function private.enqueue_job(uuid, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.claim_jobs(text, text, integer) from public, anon, authenticated;
grant execute on function app.claim_jobs(text, text, integer) to service_role;
revoke all on function app.finish_job(uuid, boolean, text) from public, anon, authenticated;
grant execute on function app.finish_job(uuid, boolean, text) to service_role;
revoke all on function app.begin_idempotent_request(uuid, text, bytea) from public, anon;
grant execute on function app.begin_idempotent_request(uuid, text, bytea) to authenticated, service_role;
revoke all on function app.complete_idempotent_request(uuid, text, smallint, jsonb) from public, anon;
grant execute on function app.complete_idempotent_request(uuid, text, smallint, jsonb) to authenticated, service_role;
revoke all on function app.abandon_idempotent_request(uuid, text) from public, anon;
grant execute on function app.abandon_idempotent_request(uuid, text) to authenticated, service_role;
revoke all on function private.assert_public_webhook_host(text) from public, anon, authenticated;
revoke all on function private.guard_webhook_endpoint() from public, anon, authenticated;
revoke all on function app.create_webhook_endpoint(uuid, text, text[], text) from public, anon;
grant execute on function app.create_webhook_endpoint(uuid, text, text[], text) to authenticated, service_role;
revoke all on function private.webhook_signing_secret(uuid) from public, anon, authenticated;
revoke all on function private.webhook_signature(text, bigint, text) from public, anon, authenticated;
revoke all on function private.fan_out_webhooks() from public, anon, authenticated;
revoke all on function private.webhook_body(uuid) from public, anon, authenticated;
revoke all on function private.webhook_retry_delay(integer) from public, anon, authenticated;
revoke all on function app.claim_webhook_deliveries(integer) from public, anon, authenticated;
grant execute on function app.claim_webhook_deliveries(integer) to service_role;
revoke all on function app.record_webhook_attempt(uuid, smallint, text) from public, anon, authenticated;
grant execute on function app.record_webhook_attempt(uuid, smallint, text) to service_role;
revoke all on function app.replay_webhook_delivery(uuid) from public, anon;
grant execute on function app.replay_webhook_delivery(uuid) to authenticated, service_role;
revoke all on function private.record_usage(uuid, text, bigint, uuid) from public, anon, authenticated;
revoke all on function private.guard_usage_rollup() from public, anon, authenticated;
revoke all on function private.rollup_usage(date) from public, anon, authenticated;
revoke all on function app.kiosk_punch(text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function app.kiosk_punch(text, uuid, text, uuid) to service_role;
