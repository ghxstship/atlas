-- pgTAP: job queue, idempotency keys, webhook endpoints and signed deliveries, usage, the kiosk PIN
-- service and the certificate check rate limit (Section 7.3, ADR 0003, ADR 0016 carry-overs).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(56);

-- Job queue -------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select private.enqueue_job(pg_temp.id('org_a'), 'export.render', gen_random_uuid());
select private.enqueue_job(pg_temp.id('org_a'), 'export.render', gen_random_uuid());
select private.enqueue_job(pg_temp.id('org_b'), 'export.render', gen_random_uuid(), now() + interval '1 hour');
select is((select count(*)::integer from app.claim_jobs('worker-1', 'export.render', 1)), 1, 'a worker claims one ready job');
select is((select count(*)::integer from app.claim_jobs('worker-2', 'export.render', 10)), 1, 'a second worker gets only the remaining ready job');
select is((select count(*)::integer from app.claim_jobs('worker-3', 'export.render', 10)), 0, 'a job scheduled later is not claimed early');
select is(app.finish_job((select id from app.job_queue where locked_by = 'worker-1'), false, 'Renderer timed out.'), 'Queued'::app.job_status,
  'a failed job is queued again');
select ok((select run_after > now() and attempts = 1 and last_error = 'Renderer timed out.' from app.job_queue where last_error is not null),
  'a retried job waits with backoff and keeps its error');
select is(app.finish_job((select id from app.job_queue where locked_by = 'worker-2'), true), 'Succeeded'::app.job_status, 'a job succeeds');
select throws_ok($$select app.finish_job((select id from app.job_queue where job_status = 'Succeeded'), true)$$, 'XR001', null,
  'a finished job cannot finish again');
update app.job_queue set attempts = 5, job_status = 'Running', locked_by = 'w', locked_at = now(), run_after = now() where last_error is not null;
select is(app.finish_job((select id from app.job_queue where locked_by = 'w'), false, 'Still failing.'), 'Failed'::app.job_status,
  'a job fails after its kind''s attempts');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.job_queue), 2, 'an admin reads the org''s jobs');
select ok(not has_function_privilege('authenticated', 'app.claim_jobs(text, text, integer)', 'execute')
  and not has_function_privilege('authenticated', 'app.finish_job(uuid, boolean, text)', 'execute'), 'signed-in callers cannot claim or finish jobs');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.job_queue), 0, 'a member reads no jobs');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.job_queue where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant job reads');

-- Idempotency keys (ADR 0003) ------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select outcome from app.begin_idempotent_request(pg_temp.id('org_a'), 'key-1', sha256('POST /expenses {a}'))), 'proceed',
  'a new key proceeds');
select is((select outcome from app.begin_idempotent_request(pg_temp.id('org_a'), 'key-1', sha256('POST /expenses {a}'))), 'in_progress',
  'the same key while the first request runs is in progress');
select lives_ok($$select app.complete_idempotent_request(pg_temp.id('org_a'), 'key-1', 201::smallint, '{"id": "exp-1"}')$$,
  'the original response is stored');
select results_eq($$select outcome, response_status, response_body from app.begin_idempotent_request(pg_temp.id('org_a'), 'key-1', sha256('POST /expenses {a}'))$$,
  $$values ('replay'::text, 201::smallint, '{"id": "exp-1"}'::jsonb)$$, 'a replay returns the original response');
select is((select outcome from app.begin_idempotent_request(pg_temp.id('org_a'), 'key-1', sha256('POST /expenses {b}'))), 'mismatch',
  'the same key with a different request is refused');
select pg_temp.as_user('xavier');
select is((select outcome from app.begin_idempotent_request(pg_temp.id('org_b'), 'key-1', sha256('POST /expenses {z}'))), 'proceed',
  'keys are scoped per tenant');
select throws_ok($$select app.begin_idempotent_request(pg_temp.id('org_a'), 'key-2', sha256('x'))$$, '42501', null,
  'a non-member cannot use another org''s key space');
select is((select count(*)::integer from app.idempotency_keys where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant key reads');
select pg_temp.as_platform();
alter table app.idempotency_keys disable trigger t90_stamp_audit_columns;
update app.idempotency_keys set created_at = now() - interval '25 hours' where idempotency_key = 'key-1' and org_id = pg_temp.id('org_a');
alter table app.idempotency_keys enable trigger t90_stamp_audit_columns;
select pg_temp.as_user('dave');
select is((select outcome from app.begin_idempotent_request(pg_temp.id('org_a'), 'key-1', sha256('POST /expenses {b}'))), 'proceed',
  'a key expires after 24 hours');

-- Webhook endpoints --------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.create_webhook_endpoint(pg_temp.id('org_a'), 'https://hooks.northwind.test/xos', array['project.created'])$$,
  '42501', null, 'a manager cannot create webhook endpoints');
select pg_temp.as_user('xavier');
select throws_ok($$select app.create_webhook_endpoint(pg_temp.id('org_b'), 'https://hooks.harbor.test/xos', array['project.created'])$$,
  'XR001', 'plan_feature_required: Webhooks need the Pro plan or above.', 'webhooks need the Pro plan');
select pg_temp.as_user('bob');
create temporary table hook as select * from app.create_webhook_endpoint(pg_temp.id('org_a'), 'https://hooks.northwind.test/xos',
  array['project.created', 'project.member_added'], 'Ops dashboard');
grant select on hook to public;
select ok((select signing_secret like 'whsec_%' and length(signing_secret) = 70 from hook), 'the signing secret is returned once');
select is((select count(*)::integer from app.webhook_endpoint_events where webhook_endpoint_id = (select webhook_endpoint_id from hook)), 2,
  'subscriptions are one row per event type');
select throws_ok($$select app.create_webhook_endpoint(pg_temp.id('org_a'), 'https://192.168.1.20/hook', array['project.created'])$$,
  'XR001', null, 'private network hosts are refused');
select throws_ok($$select app.create_webhook_endpoint(pg_temp.id('org_a'), 'http://hooks.northwind.test/xos', array['project.created'])$$,
  'XR001', null, 'plain HTTP is refused');
select throws_ok($$insert into app.webhook_endpoints (org_id, url, signing_secret_id) values (pg_temp.id('org_a'), 'https://x.test/h', gen_random_uuid())$$,
  '42501', null, 'endpoints are created only through the RPC');
select throws_ok($$update app.webhook_endpoints set url = 'https://localhost/h'$$, 'XR001', null, 'an endpoint cannot be moved to localhost');
select pg_temp.as_platform();
select ok(exists (select 1 from vault.secrets s join app.webhook_endpoints e on e.signing_secret_id = s.id),
  'the endpoint row holds only a Vault reference');
select is(private.webhook_signing_secret((select webhook_endpoint_id from hook)), (select signing_secret from hook),
  'the secret is kept in Vault and readable only inside the database');

-- Signing (ADR 0003) ----------------------------------------------------------------------------------------------
select is(private.webhook_signature('whsec_test', 1700000000, '{"a": 1}'),
  't=1700000000,v1=f9086839ba44ac933ad5d79a65f74e64811e534328d3bf3c278acf3329bf7ce5',
  'the signature is HMAC-SHA256 over {timestamp}.{body} in the XOS-Signature format');

-- Fan-out, delivery, backoff and replay -------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWH', 'Northwind Harbor Fest', 'America/New_York');
select pg_temp.as_platform();
select private.emit_event(pg_temp.id('org_b'), 'project.created', 'projects', pg_temp.id('prj_b'), pg_temp.id('prj_b'), '{"project_key": "HLP"}');
select is((select count(*)::integer from app.webhook_deliveries d join app.domain_events e on e.id = d.domain_event_id
           where e.event_type = 'project.created' and e.data ->> 'project_key' = 'NWH'), 1,
  'a domain event fans out to the subscribed endpoint');
select is((select count(*)::integer from app.webhook_deliveries where org_id = pg_temp.id('org_b')), 0,
  'events of another org reach none of this org''s endpoints');
create temporary table claimed as select * from app.claim_webhook_deliveries(10);
grant select on claimed to public;
select is((select count(*)::integer from claimed), 1, 'the dispatcher claims the due delivery');
select is((select count(*)::integer from app.claim_webhook_deliveries(10)), 0, 'a claimed delivery is not claimed twice');
select ok((select body::jsonb ->> 'type' = 'project.created' and body::jsonb -> 'data' ->> 'project_key' = 'NWH' from claimed),
  'the body carries the event type and payload');
select is((select signature from claimed),
  private.webhook_signature((select signing_secret from hook), split_part(split_part((select signature from claimed), ',', 1), '=', 2)::bigint, (select body from claimed)),
  'the delivery is signed with the endpoint secret');
select is(app.record_webhook_attempt((select delivery_id from claimed), 503::smallint, 'Service Unavailable'), 'Retrying'::app.delivery_status,
  'a 5xx response is retried');
select ok((select next_attempt_at > now() and attempt_count = 1 from app.webhook_deliveries where id = (select delivery_id from claimed)),
  'the retry waits with exponential backoff');
select is(private.webhook_retry_delay(1), interval '30 seconds', 'the first retry waits 30 seconds');
select is(private.webhook_retry_delay(5), interval '8 minutes', 'the delay doubles each attempt');
update app.webhook_deliveries set next_attempt_at = now() where id = (select delivery_id from claimed);
select is((select count(*)::integer from app.claim_webhook_deliveries(10)), 1, 'a due retry is claimed again');
select is(app.record_webhook_attempt((select delivery_id from claimed), 200::smallint), 'Delivered'::app.delivery_status, 'a 2xx delivers');
select throws_ok($$select app.record_webhook_attempt((select delivery_id from claimed), 200::smallint)$$, 'XR001', null,
  'a delivered attempt cannot be recorded twice');
alter table app.webhook_deliveries disable trigger t90_stamp_audit_columns;
insert into app.webhook_deliveries (webhook_endpoint_id, domain_event_id, delivery_status, attempt_count, created_at)
select (select webhook_endpoint_id from hook), id, 'Delivering', 12, now() - interval '71 hours' from app.domain_events
where event_type = 'project.created' and data ->> 'project_key' = 'NWH';
alter table app.webhook_deliveries enable trigger t90_stamp_audit_columns;
select is(app.record_webhook_attempt((select id from app.webhook_deliveries where attempt_count = 12), 500::smallint), 'Expired'::app.delivery_status,
  'retries stop after 72 hours');
select pg_temp.as_user('bob');
select ok(app.replay_webhook_delivery((select delivery_id from claimed)) is not null, 'an admin replays a delivery');
select is((select count(*)::integer from app.webhook_deliveries where replay_requested_by = pg_temp.id('bob') and delivery_status = 'Pending'), 1,
  'the replay is a new pending delivery that records who asked');
select pg_temp.as_user('xavier');
select throws_ok($$select app.replay_webhook_delivery((select delivery_id from claimed))$$, '42501', null, 'another org cannot replay');
select is((select count(*)::integer from app.webhook_endpoints), 0, 'another org cannot see the endpoint');

-- Usage -------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select private.create_month_partition('app.usage_events', (date_trunc('month', now()) - interval '2 months')::date);
alter table app.usage_events disable trigger t90_stamp_audit_columns;
insert into app.usage_events (org_id, meter_code, quantity, created_at) values
  (pg_temp.id('org_a'), 'sms_segments', 3, date_trunc('month', now()) - interval '40 days'),
  (pg_temp.id('org_a'), 'sms_segments', 4, date_trunc('month', now()) - interval '35 days');
alter table app.usage_events enable trigger t90_stamp_audit_columns;
select ok(private.rollup_usage((date_trunc('month', now()) - interval '2 months')::date) >= 1, 'a closed month rolls up');
select is((select quantity from app.usage_rollups where org_id = pg_temp.id('org_a') and meter_code = 'sms_segments'), 7::bigint,
  'the rollup sums the month''s usage');
select is((select count(*)::integer from app.job_queue where job_kind = 'usage.report'), 1, 'metered totals are queued for Stripe');
select throws_ok($$update app.usage_rollups set quantity = 1$$, 'XR001', null, 'a closed total never changes');

-- Certificate rate limit (the kiosk PIN service is covered in 0592) ------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select count(*)::integer from api_public.verify_certification('no-such-code')), 0, 'an unknown code verifies nothing');
select pg_temp.as_platform();
select private.note_rate_event('verify_certification.failure', 'unknown') from generate_series(1, 10);
select ok(private.rate_limit_exceeded('verify_certification.failure', 'unknown', 10, interval '15 minutes'),
  'repeated failed certificate lookups lock the client out');

select * from finish();
rollback;
