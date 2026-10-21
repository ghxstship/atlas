-- pgTAP: migration 1400 (A83, RRR-128, finding A65-013). Inbound integration webhooks: recorded once per provider event
-- (idempotency), processed with attempts and exponential backoff, Dead Letter when they fail for good, sent back by an
-- admin with a reason. Per-connection webhook secrets live in Vault and die with the connection. Only the service role
-- records and processes; holders of org.integrations.manage read and retry; members, other orgs and anon see nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(47);

-- A Connected Slack connection in org A, and a Teams one for the per-connection secret.
select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name, external_account_id)
  values (pg_temp.id('org_a'), 'slack', 'Northwind Slack', 'T0NWL') returning id) insert into world select 'slack_a', id from c;
select app.store_integration_credential(pg_temp.id('slack_a'), 'xoxb-test-token-value', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('slack_a'), 'Pending', 'Connected', 'Workspace installed.');
with c as (insert into app.integration_connections (org_id, provider_code, display_name, external_account_id)
  values (pg_temp.id('org_a'), 'microsoft_teams', 'Northwind Teams', 'tenant-nwl') returning id) insert into world select 'teams_a', id from c;

-- Routing ---------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(app.find_integration_connection('slack', 'T0NWL'), pg_temp.id('slack_a'), 'a webhook routes to the Connected connection of its account id');
select is(app.find_integration_connection('slack', 'T0OTHER'), null, 'an unknown account routes nowhere');
select is(app.find_integration_connection('microsoft_teams', 'tenant-nwl'), null, 'a Pending connection receives no routed webhooks');

-- Recording: idempotency ------------------------------------------------------------------------------------------
create temporary table recorded as
select * from app.record_integration_inbound_event(pg_temp.id('slack_a'), 'Link Unfurl', 'Ev0001',
  '{"team_id":"T0NWL","user":"U1","links":[{"url":"https://atlas.test/x?peek=NWL-1"}]}');
insert into world select 'ev1', event_id from recorded;
select is((select duplicate from recorded), false, 'the first delivery of an event is recorded');
select is((select inbound_state::text from app.integration_inbound_events where id = pg_temp.id('ev1')), 'Received', 'it starts Received');
select is((select org_id from app.integration_inbound_events where id = pg_temp.id('ev1')), pg_temp.id('org_a'), 'the org comes from the connection');
select is((select count(*)::int from app.job_queue where job_kind = 'integration.inbound' and subject_id = pg_temp.id('ev1')), 1,
  'its processing is queued on the job queue');
select is((select event_id from app.record_integration_inbound_event(pg_temp.id('slack_a'), 'Link Unfurl', 'Ev0001', '{"retry":1}')),
  pg_temp.id('ev1'), 'a provider retry of the same event returns the first record');
select is((select duplicate from app.record_integration_inbound_event(pg_temp.id('slack_a'), 'Link Unfurl', 'Ev0001', '{}')),
  true, 'and says it is a duplicate');
select is((select count(*)::int from app.job_queue where job_kind = 'integration.inbound' and subject_id = pg_temp.id('ev1')), 1,
  'a duplicate queues nothing more');
select throws_ok($$select * from app.record_integration_inbound_event((select id from world where key = 'slack_a'), 'Link Unfurl', 'Ev0002', '[]')$$,
  '23514', null, 'a payload is a JSON object');
select throws_ok($$select * from app.record_integration_inbound_event((select id from world where key = 'slack_a'), 'Link Unfurl', 'Ev0003',
  jsonb_build_object('blob', repeat('x', 70000)))$$, '23514', null, 'a payload is at most 64 KB');

-- Processing: retries, backoff and Dead Letter ---------------------------------------------------------------------
select is((select attempt from app.claim_integration_inbound_event(pg_temp.id('ev1'))), 1::smallint, 'the worker claims the first attempt');
select is((select inbound_state::text from app.integration_inbound_events where id = pg_temp.id('ev1')), 'Processing', 'the event is Processing');
select throws_ok($$select app.claim_integration_inbound_event((select id from world where key = 'ev1'))$$,
  'XR001', 'integration_inbound_not_pending: Only a Received or Retrying event can be processed.', 'an event is claimed once');
select is(app.fail_integration_inbound_event(pg_temp.id('ev1'), 'provider_unavailable', 'Slack answered 503.', true), 'Retrying'::app.integration_inbound_state,
  'a retryable failure with attempts left retries');
select ok((select next_attempt_at between now() + interval '29 seconds' and now() + interval '31 seconds'
           from app.integration_inbound_events where id = pg_temp.id('ev1')), 'the first retry waits 30 seconds (private.integration_backoff)');
select is((select count(*)::int from app.job_queue where job_kind = 'integration.inbound' and subject_id = pg_temp.id('ev1') and run_after > now()), 1,
  'the retry is queued for when it is due');
select throws_ok($$select app.claim_integration_inbound_event((select id from world where key = 'ev1'))$$,
  'XR001', 'integration_inbound_not_due: The event is not due yet.', 'a retry is not claimed early');
update app.integration_inbound_events set next_attempt_at = now() - interval '1 second' where id = pg_temp.id('ev1');
select is((select attempt from app.claim_integration_inbound_event(pg_temp.id('ev1'))), 2::smallint, 'the due retry is the second attempt');
select is(app.fail_integration_inbound_event(pg_temp.id('ev1'), 'slack_invalid_auth', 'Slack refused the token.', false), 'Dead Letter'::app.integration_inbound_state,
  'a permanent failure goes to Dead Letter at once');
select ok((select dead_lettered_at is not null and error_code = 'slack_invalid_auth' from app.integration_inbound_events where id = pg_temp.id('ev1')),
  'the dead letter keeps its error');
select is((select count(*)::int from app.domain_events where event_type = 'integration_inbound.dead_lettered' and subject_id = pg_temp.id('ev1')), 1,
  'going to Dead Letter emits integration_inbound.dead_lettered');

create temporary table recorded2 as
select * from app.record_integration_inbound_event(pg_temp.id('slack_a'), 'Link Unfurl', 'Ev0004', '{"team_id":"T0NWL"}');
insert into world select 'ev2', event_id from recorded2;
update app.integration_inbound_events set max_attempts = 1 where id = pg_temp.id('ev2');
select app.claim_integration_inbound_event(pg_temp.id('ev2'));
select is(app.fail_integration_inbound_event(pg_temp.id('ev2'), 'provider_unavailable', 'Timed out.', true), 'Dead Letter'::app.integration_inbound_state,
  'a retryable failure goes to Dead Letter once attempts are used up');

create temporary table recorded3 as
select * from app.record_integration_inbound_event(pg_temp.id('slack_a'), 'Link Unfurl', 'Ev0005', '{"team_id":"T0NWL"}');
insert into world select 'ev3', event_id from recorded3;
select app.claim_integration_inbound_event(pg_temp.id('ev3'));
select lives_ok($$select app.complete_integration_inbound_event((select id from world where key = 'ev3'), 'Unfurled 1 link.')$$, 'the worker completes an event');
select ok((select inbound_state = 'Processed' and processed_at is not null and outcome = 'Unfurled 1 link.' from app.integration_inbound_events where id = pg_temp.id('ev3')),
  'a Processed event says what processing did');
select throws_ok($$select app.complete_integration_inbound_event((select id from world where key = 'ev3'), 'Again.')$$,
  'XR001', 'integration_inbound_not_processing: Only an event being processed can be completed.', 'a Processed event is final');

-- Reading and retrying: role bands and tenancy ---------------------------------------------------------------------
select pg_temp.as_user('bob');
select is((select count(*)::int from app.integration_inbound_events), 3, 'an Admin reads the org''s inbound events');
select throws_ok($$select * from app.record_integration_inbound_event((select id from world where key = 'slack_a'), 'Link Unfurl', 'Ev9', '{}')$$,
  '42501', null, 'a signed-in person cannot record an inbound event');
select throws_ok($$update app.integration_inbound_events set inbound_state = 'Processed' where id = (select id from world where key = 'ev1')$$,
  '42501', null, 'nor change one directly');
select throws_ok($$select app.retry_integration_inbound_event((select id from world where key = 'ev1'), '')$$,
  'XR001', 'integration_inbound_reason: Say why the event should be tried again (up to 500 characters).', 'a retry needs a reason');
select throws_ok($$select app.retry_integration_inbound_event((select id from world where key = 'ev3'), 'Once more.')$$,
  'XR001', 'integration_inbound_not_dead_letter: Only a Dead Letter event can be sent back for another try.', 'only a dead letter is retried');
select lives_ok($$select app.retry_integration_inbound_event((select id from world where key = 'ev1'), 'Token reinstalled.')$$, 'an Admin sends a dead letter back');
select ok((select inbound_state = 'Received' and attempt = 0 and dead_lettered_at is null from app.integration_inbound_events where id = pg_temp.id('ev1')),
  'it is Received again with fresh attempts');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.integration_inbound_events), 0, 'a Member reads no inbound events');
select throws_ok($$select app.retry_integration_inbound_event((select id from world where key = 'ev2'), 'Please.')$$,
  '42501', null, 'a Member cannot retry a dead letter');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_inbound_events), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.integration_inbound_events', '42501', null, 'anon cannot read inbound events');

-- Inbound secrets in Vault -------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.store_integration_inbound_secret((select id from world where key = 'teams_a'), 'short')$$,
  'XR001', 'integration_inbound_secret_short: A webhook secret has at least 16 characters.', 'a webhook secret has at least 16 characters');
select lives_ok($$select app.store_integration_inbound_secret((select id from world where key = 'teams_a'), 'dGVhbXMtb3V0Z29pbmctd2ViaG9vaw==')$$,
  'an Admin stores a connection''s webhook secret');
select is((select count(*)::int from app.integration_inbound_secrets_stored(pg_temp.id('org_a'))), 1, 'the Admin sees which connections have one');
select throws_ok($$select app.read_integration_inbound_secret((select id from world where key = 'teams_a'))$$,
  '42501', null, 'a signed-in person never reads the secret back');
select pg_temp.as_user('dave');
select throws_ok($$select app.integration_inbound_secrets_stored((select id from world where key = 'org_a'))$$,
  '42501', null, 'a Member cannot list them');
select pg_temp.as_platform();
select is(app.read_integration_inbound_secret(pg_temp.id('teams_a')), 'dGVhbXMtb3V0Z29pbmctd2ViaG9vaw==', 'the service role decrypts it for the inbound endpoint');
select pg_temp.as_user('bob');
select app.transition_integration_connection(pg_temp.id('teams_a'), 'Pending', 'Disconnected', 'Not using Teams.');
select pg_temp.as_platform();
select is(app.read_integration_inbound_secret(pg_temp.id('teams_a')), null, 'disconnecting destroys the webhook secret');
select is((select count(*)::int from vault.secrets where name = 'xos_integration_inbound_' || pg_temp.id('teams_a')), 0, 'and its Vault row');
select throws_ok($$select * from app.record_integration_inbound_event((select id from world where key = 'teams_a'), 'Change Notice', 'n1', '{}')$$,
  'XR001', 'integration_disconnected: A disconnected connection receives no webhooks.', 'a disconnected connection receives no webhooks');

select * from finish();
rollback;
