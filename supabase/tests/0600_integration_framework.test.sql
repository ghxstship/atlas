-- pgTAP: the integration framework (Section 17, Section 9). Same-tenant allow, cross-tenant deny, anon deny,
-- role bands (Owner and Admin hold org.integrations.manage, Manager and Member do not), plan gates, credentials
-- in Vault, the external identifier map, and every connection and sync run transition, allowed and refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

-- Provider catalog ------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.integration_providers), 19, 'the catalog lists the 19 Section 17 connectors');
select is((select provider_code from app.integration_providers order by sort_order limit 1), 'xero', 'in numeric catalog order');
select pg_temp.as_anon();
select throws_ok('select 1 from app.integration_providers', '42501', null, 'anon cannot read the catalog');
select throws_ok('select 1 from app.integration_connections', '42501', null, 'anon cannot read connections');
select throws_ok('select 1 from app.integration_sync_runs', '42501', null, 'anon cannot read sync runs');
select throws_ok('select 1 from app.integration_external_ids', '42501', null, 'anon cannot read the identifier map');
select throws_ok($$select app.store_integration_credential(gen_random_uuid(), 'x', 'API Key')$$, '42501', null, 'anon cannot store credentials');

-- Connections and role bands -------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name, external_account_id)
  values (pg_temp.id('org_a'), 'xero', 'Northwind Xero', 'tenant-nwl') returning id) insert into world select 'xero_a', id from c;
select is((select connection_state::text from app.integration_connections where id = pg_temp.id('xero_a')), 'Pending', 'a new connection starts Pending');
select is((select count(*)::int from app.integration_connection_state_transitions where integration_connection_id = pg_temp.id('xero_a')), 1, 'the creation entry is logged');
select throws_ok($$insert into app.integration_connections (org_id, provider_code, display_name, external_account_id) values ((select id from world where key = 'org_a'), 'xero', 'Again', 'tenant-nwl')$$,
  '23505', null, 'one live connection per provider account');
select throws_ok($$insert into app.integration_connections (org_id, provider_code, display_name, connection_state) values ((select id from world where key = 'org_a'), 'slack', 'Slack', 'Connected')$$,
  'XR001', 'integration_connection_initial_state: A new integration connection starts in Pending; use its transition RPC to move it.', 'a connection cannot be inserted Connected');
with c as (insert into app.integration_connections (org_id, provider_code, display_name, credential_kind, credential_stored_at)
  values (pg_temp.id('org_a'), 'ticketing_csv', 'Box Office Exports', 'API Key', now()) returning id) insert into world select 'csv_a', id from c;
select is((select credential_kind from app.integration_connections where id = pg_temp.id('csv_a')), null::app.integration_credential_kind, 'credential details sent on insert are discarded');
select throws_ok($$update app.integration_connections set credential_kind = 'API Key', credential_stored_at = now() where id = (select id from world where key = 'xero_a')$$,
  'XR001', 'integration_credential_rpc_only: Credential details change only through app.store_integration_credential.', 'credential details change only through the RPC');
select throws_ok($$update app.integration_connections set last_synced_at = now() where id = (select id from world where key = 'xero_a')$$,
  'XR001', 'integration_sync_fields_runner_only: Sync results are written only by the integration runner.', 'sync results are runner-only');
select throws_ok($$update app.integration_connections set provider_code = 'netsuite' where id = (select id from world where key = 'xero_a')$$,
  'XR001', 'integration_provider_fixed: A connection keeps its provider; connect the other provider separately.', 'the provider is fixed');
select throws_ok($$update app.integration_connections set provider_settings = '[]' where id = (select id from world where key = 'xero_a')$$,
  '23514', null, 'provider settings are an object');
select lives_ok($$update app.integration_connections set provider_settings = '{"default_tracking_category":"Cost Center"}' where id = (select id from world where key = 'xero_a')$$,
  'an Admin edits provider settings');

select pg_temp.as_user('alice');
select is((select count(*)::int from app.integration_connections), 2, 'the Owner reads the org''s connections');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.integration_connections), 0, 'a Manager reads no connections (no org.integrations.manage)');
select throws_ok($$insert into app.integration_connections (org_id, provider_code, display_name) values ((select id from world where key = 'org_a'), 'slack', 'Slack')$$,
  '42501', null, 'a Manager cannot connect an integration');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.integration_connections), 0, 'a Member reads no connections');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_connections), 0, 'another org reads none');
select is((select count(*)::int from app.integration_connection_state_transitions), 0, 'nor their ledger');
select throws_ok($$insert into app.integration_connections (org_id, provider_code, display_name) values ((select id from world where key = 'org_a'), 'slack', 'Slack')$$,
  '42501', null, 'another org cannot connect for org A');
select throws_ok($$insert into app.integration_connections (org_id, provider_code, display_name) values ((select id from world where key = 'org_b'), 'xero', 'Harbor Xero')$$,
  'XR001', 'integration_plan_feature: Connecting xero needs a plan with the upl_export feature.', 'accounting connectors need the upl_export plan feature');
select throws_ok($$insert into app.integration_connections (org_id, provider_code, display_name) values ((select id from world where key = 'org_b'), 'gusto', 'Harbor Gusto')$$,
  'XR001', 'integration_plan_feature: Connecting gusto needs a plan with the payroll_export feature.', 'payroll handoff needs the payroll_export plan feature');
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_b'), 'google_calendar', 'Harbor Calendar') returning id)
  insert into world select 'gcal_b', id from c;
select is((select count(*)::int from app.integration_connections), 1, 'an ungated connector connects on any plan');

-- Credentials in Vault -------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Pending', 'Connected', 'Authorized.')$$,
  'XR001', 'integration_credential_required: Store the provider credential before connecting.', 'Connected needs a stored credential');
select pg_temp.as_user('carol');
select throws_ok($$select app.store_integration_credential((select id from world where key = 'xero_a'), 'fixture-token-one', 'OAuth Token')$$,
  '42501', null, 'a Manager cannot store a credential');
select pg_temp.as_user('xavier');
select throws_ok($$select app.store_integration_credential((select id from world where key = 'xero_a'), 'fixture-token-one', 'OAuth Token')$$,
  '42501', null, 'another org cannot store a credential');
select pg_temp.as_user('bob');
select throws_ok($$select app.store_integration_credential((select id from world where key = 'xero_a'), '', 'OAuth Token')$$,
  'XR001', 'integration_credential_empty: A credential needs a secret value.', 'an empty secret is refused');
select throws_ok($$select app.store_integration_credential((select id from world where key = 'xero_a'), 'fixture-token-one', 'OAuth Token', now() - interval '1 minute')$$,
  'XR001', 'integration_credential_expired: The credential has already expired.', 'an expired secret is refused');
select lives_ok($$select app.store_integration_credential((select id from world where key = 'xero_a'), 'fixture-token-one', 'OAuth Token', now() + interval '30 days')$$,
  'an Admin stores the credential');
select is((select credential_kind::text from app.integration_connections where id = pg_temp.id('xero_a')), 'OAuth Token', 'the connection records the credential kind');
select ok((select credential_stored_at is not null from app.integration_connections where id = pg_temp.id('xero_a')), 'and when it was stored');
select ok(not exists (select 1 from app.integration_connections c where c::text like '%fixture-token-one%'), 'the secret never appears on the connection');
select throws_ok($$select app.read_integration_credential((select id from world where key = 'xero_a'))$$, '42501', null, 'signed-in callers cannot read the secret');
select throws_ok('select 1 from private.integration_credentials', '42501', null, 'nor the credential pointer');
select throws_ok('select decrypted_secret from vault.decrypted_secrets', '42501', null, 'nor Vault');
select pg_temp.as_platform();
select is(app.read_integration_credential(pg_temp.id('xero_a')), 'fixture-token-one', 'the service role reads the secret from Vault');
select is((select count(*)::int from vault.secrets s join private.integration_credentials c on c.vault_secret_id = s.id
  where c.integration_connection_id = pg_temp.id('xero_a')), 1, 'the secret lives in vault.secrets');
select ok((select s.secret <> 'fixture-token-one' from vault.secrets s join private.integration_credentials c on c.vault_secret_id = s.id
  where c.integration_connection_id = pg_temp.id('xero_a')), 'encrypted at rest');
select pg_temp.as_user('bob');
select lives_ok($$select app.store_integration_credential((select id from world where key = 'xero_a'), 'fixture-token-two', 'OAuth Token', now() + interval '30 days')$$,
  'rotating the credential');
select pg_temp.as_platform();
select is(app.read_integration_credential(pg_temp.id('xero_a')), 'fixture-token-two', 'rotation replaces the secret in place');
select is((select count(*)::int from private.integration_credentials where integration_connection_id = pg_temp.id('xero_a')), 1, 'one secret per connection');

-- Connection transitions ------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Pending', 'Paused', 'Hold.')$$,
  'XR001', 'integration_connection_transition_not_allowed: A integration connection cannot move from Pending to Paused.', 'Pending cannot pause');
select throws_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Pending', 'Connected', '')$$,
  'XR001', 'transition_reason_required: Every state change carries a reason.', 'every transition carries a reason');
select lives_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Pending', 'Connected', 'Authorized in Xero.')$$,
  'Pending to Connected');
select throws_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Pending', 'Connected', 'Again.')$$,
  'XR001', 'integration_connection_state_conflict: The integration connection is not in the expected state Pending.', 'compare-and-set on the expected state');
select throws_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Connected', 'Error', 'Broken.')$$,
  'XR001', 'integration_error_runner_only: Only the integration runner marks a connection as failing.', 'only the runner sets Error');
select throws_ok($$update app.integration_connections set connection_state = 'Paused' where id = (select id from world where key = 'xero_a')$$,
  'XR001', 'integration_connection_transition_rpc_only: connection_state changes only through its transition RPC, which logs the change.', 'the state changes only through the RPC');
select lives_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Connected', 'Paused', 'Month-end close.')$$, 'Connected to Paused');
select lives_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Paused', 'Connected', 'Close finished.')$$, 'Paused to Connected');
select lives_ok($$select app.transition_integration_connection((select id from world where key = 'csv_a'), 'Pending', 'Connected', 'CSV import needs no credential.')$$,
  'a connector without credentials connects directly');
select pg_temp.as_user('carol');
select throws_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Connected', 'Paused', 'Hold.')$$,
  '42501', null, 'a Manager cannot move a connection');
select pg_temp.as_platform();
select is((select count(*)::int from app.integration_connection_state_transitions where integration_connection_id = pg_temp.id('xero_a')), 4, 'every move is logged');
select is((select count(*)::int from app.domain_events where event_type = 'integration.state_changed' and subject_id = pg_temp.id('xero_a')), 3, 'and emitted as integration.state_changed');
select pg_temp.as_platform();
select throws_ok($$update app.integration_connection_state_transitions set reason = 'x'$$, 'XR001', null, 'the connection ledger is append-only');

-- External identifier map -------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$insert into app.integration_external_ids (integration_connection_id, entity, local_id, external_id) values ((select id from world where key = 'xero_a'), 'Membership', (select id from world where key = 'dave@org_a'), 'contact-1001')$$,
  'an Admin maps a local row to a provider identifier');
select is((select org_id from app.integration_external_ids where external_id = 'contact-1001'), pg_temp.id('org_a'), 'the org comes from the connection');
select throws_ok($$insert into app.integration_external_ids (integration_connection_id, entity, local_id, external_id) values ((select id from world where key = 'xero_a'), 'Membership', (select id from world where key = 'dave@org_a'), 'contact-1002')$$,
  '23505', null, 'a local row maps once per connection and kind');
select throws_ok($$insert into app.integration_external_ids (integration_connection_id, entity, local_id, external_id) values ((select id from world where key = 'xero_a'), 'Membership', (select id from world where key = 'erin@org_a'), 'contact-1001')$$,
  '23505', null, 'a provider identifier maps once per connection and kind');
select throws_ok($$insert into app.integration_external_ids (integration_connection_id, entity, local_id, external_id) values ((select id from world where key = 'xero_a'), 'Membership', (select id from world where key = 'xavier@org_b'), 'contact-9')$$,
  'XR001', 'cross_org_reference: integration_external_ids.local_id points to a row of another org.', 'a local row of another org is refused');
select throws_ok($$insert into app.integration_external_ids (integration_connection_id, entity, local_id, external_id) values ((select id from world where key = 'xero_a'), 'Payment', gen_random_uuid(), 'pay-9')$$,
  '23503', null, 'the local row must exist');
select throws_ok($$update app.integration_external_ids set local_id = (select id from world where key = 'erin@org_a') where external_id = 'contact-1001'$$,
  'XR001', 'integration_external_id_rekey: An identifier pair keeps its local row; map the other row separately.', 'a pair keeps its local row');
select throws_ok($$update app.integration_external_ids set content_hash = 'abc' where external_id = 'contact-1001'$$, '23514', null, 'content hashes are SHA-256 hex');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_external_ids), 0, 'another org reads none of the map');
select throws_ok($$insert into app.integration_external_ids (integration_connection_id, entity, local_id, external_id) values ((select id from world where key = 'xero_a'), 'Membership', (select id from world where key = 'erin@org_a'), 'contact-2')$$,
  '42501', null, 'nor writes into it');
select pg_temp.as_platform();
select is(app.upsert_integration_external_id(pg_temp.id('xero_a'), 'Membership', pg_temp.id('dave@org_a'), 'contact-1001', 'v2', null),
  (select id from app.integration_external_ids where external_id = 'contact-1001'), 'the runner refreshes an existing pair');
select is((select external_version from app.integration_external_ids where external_id = 'contact-1001'), 'v2', 'with the provider version');

-- Sync runs: enqueue --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.enqueue_integration_sync((select id from world where key = 'xero_a'), 'Ledger Export', 'Outbound', 'k1')$$,
  '42501', null, 'a Manager cannot queue a sync');
select pg_temp.as_user('bob');
select lives_ok($$insert into world values ('run1', app.enqueue_integration_sync((select id from world where key = 'xero_a'), 'Ledger Export', 'Outbound', 'ledger-2027-06'))$$,
  'an Admin queues a ledger export');
select is(app.enqueue_integration_sync(pg_temp.id('xero_a'), 'Ledger Export', 'Outbound', 'ledger-2027-06'), pg_temp.id('run1'), 'repeating the idempotency key returns the first run');
select throws_ok($$select app.enqueue_integration_sync((select id from world where key = 'xero_a'), 'Ledger Export', 'Outbound', 'ledger-other')$$,
  'XR001', 'integration_sync_in_progress: A run of this scope is already queued or running for the connection.', 'one active run per connection and scope');
select throws_ok($$select app.enqueue_integration_sync((select id from world where key = 'xero_a'), 'Calendar Sync', 'Two Way', 'cal-1')$$,
  'XR001', 'integration_scope_mismatch: A Accounting connection cannot run Calendar Sync.', 'a scope outside the connection''s category is refused');
select throws_ok($$select app.enqueue_integration_sync((select id from world where key = 'xero_a'), 'Payment Sync', 'Outbound', 'subject-x', null, 5::smallint, 'Membership', (select id from world where key = 'xavier@org_b'))$$,
  'XR001', 'cross_org_reference: integration_sync_runs.subject_id points to a row of another org.', 'a run''s subject must be a row of the same org');
select throws_ok($$select app.enqueue_integration_sync((select id from world where key = 'xero_a'), 'Payment Sync', 'Outbound', 'subject-y', null, 5::smallint, 'Payment', gen_random_uuid())$$,
  '23503', null, 'a run''s subject must exist');
select throws_ok($$insert into app.integration_sync_runs (integration_connection_id, sync_scope, direction, idempotency_key) values ((select id from world where key = 'xero_a'), 'Payment Sync', 'Inbound', 'direct')$$,
  '42501', null, 'runs are queued only through the RPC');
select throws_ok($$select app.claim_integration_sync((select id from world where key = 'run1'))$$, '42501', null, 'signed-in callers cannot run the runner RPCs');
select is((select sync_run_state::text from app.integration_sync_runs where id = pg_temp.id('run1')), 'Queued', 'a new run is Queued');
select pg_temp.as_platform();
select is((select count(*)::int from app.job_queue where job_kind = 'integration.sync' and subject_id = pg_temp.id('run1')), 1, 'queueing a run puts an integration.sync job on the platform job queue');
select is((select job_id from app.integration_sync_runs where id = pg_temp.id('run1')), (select id from app.job_queue where subject_id = pg_temp.id('run1')), 'and records the job on the run');
select pg_temp.as_user('bob');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_sync_runs), 0, 'another org reads no runs');
select throws_ok($$select app.enqueue_integration_sync((select id from world where key = 'gcal_b'), 'Calendar Sync', 'Two Way', 'cal-1')$$,
  'XR001', 'integration_not_connected: Only a Connected connection can sync.', 'a Pending connection cannot sync');

-- Sync runs: attempts, retry with backoff, success ------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((app.claim_integration_sync(pg_temp.id('run1'))).attempt::int, 1, 'claiming starts attempt 1');
select is((select sync_run_state::text from app.integration_sync_runs where id = pg_temp.id('run1')), 'Running', 'Queued to Running');
select throws_ok($$select app.claim_integration_sync((select id from world where key = 'run1'))$$,
  'XR001', 'integration_sync_run_transition_not_allowed: A integration sync run cannot move from Running to Running.', 'a Running run cannot be claimed twice');
select lives_ok($$select app.record_integration_sync_error((select id from world where key = 'run1'), 'account_unmapped', 'GL 5000 has no Xero account.', 'Journal Line', null, null)$$,
  'the runner records an item error');
select is(app.fail_integration_sync(pg_temp.id('run1'), 'provider_rate_limited', 'Xero returned 429.', true), 'Retrying'::app.integration_sync_run_state,
  'a retryable failure with attempts left retries');
select ok((select next_attempt_at between now() + interval '29 seconds' and now() + interval '31 seconds' from app.integration_sync_runs where id = pg_temp.id('run1')),
  'the first retry is due after 30 seconds');
select is((select last_error_code from app.integration_connections where id = pg_temp.id('xero_a')), 'provider_rate_limited', 'the connection shows the last error');
select ok((select j.run_after = r.next_attempt_at from app.integration_sync_runs r join app.job_queue j on j.id = r.job_id where r.id = pg_temp.id('run1')),
  'the retry is scheduled on the job queue for the backoff time');
select is((select count(*)::int from app.job_queue where subject_id = pg_temp.id('run1')), 2, 'one job per attempt');
select throws_ok($$select app.claim_integration_sync((select id from world where key = 'run1'))$$,
  'XR001', 'integration_sync_not_due: The run is backing off until its next attempt time.', 'a backing-off run is not claimed early');
select throws_ok($$select app.record_integration_sync_error((select id from world where key = 'run1'), 'late', 'Too late.')$$,
  'XR001', 'integration_sync_not_running: Item errors are recorded only while the run is Running.', 'item errors only while Running');
update app.integration_sync_runs set next_attempt_at = now() - interval '1 second' where id = pg_temp.id('run1');
select is((app.claim_integration_sync(pg_temp.id('run1'))).attempt::int, 2, 'Retrying to Running starts attempt 2');
select lives_ok($$select app.complete_integration_sync((select id from world where key = 'run1'), 40, 38, 1, 1, 'journal:2027-06-30')$$, 'Running to Succeeded');
select is((select items_written from app.integration_sync_runs where id = pg_temp.id('run1')), 38, 'the run keeps its counts');
select is((select cursor_after from app.integration_sync_runs where id = pg_temp.id('run1')), 'journal:2027-06-30', 'and the cursor for the next run');
select ok((select last_synced_at is not null and last_error_code is null from app.integration_connections where id = pg_temp.id('xero_a')),
  'success stamps the connection and clears its error');
select is((select count(*)::int from app.domain_events where event_type = 'integration_sync.finished' and subject_id = pg_temp.id('run1')), 1, 'integration_sync.finished is emitted');
select throws_ok($$select app.complete_integration_sync((select id from world where key = 'run1'), 0, 0, 0, 0)$$,
  'XR001', 'integration_sync_run_state_conflict: The integration sync run is not in the expected state Running.', 'Succeeded is final');
select throws_ok($$update app.integration_sync_errors set error_message = 'x'$$, 'XR001', null, 'item errors are append-only');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.integration_sync_errors), 1, 'an Admin reads the item errors');
select is((select count(*)::int from app.integration_sync_run_state_transitions where integration_sync_run_id = pg_temp.id('run1')), 5, 'every run move is logged');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_sync_errors), 0, 'another org reads none');

-- Attempts exhausted, manual retry and cancel ----------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into world values ('run2', app.enqueue_integration_sync(pg_temp.id('xero_a'), 'Payment Sync', 'Two Way', 'payments-1', null, 2::smallint));
select pg_temp.as_platform();
select app.claim_integration_sync(pg_temp.id('run2'));
select is(app.fail_integration_sync(pg_temp.id('run2'), 'provider_unavailable', 'Xero returned 503.', true), 'Retrying'::app.integration_sync_run_state, 'attempt 1 of 2 retries');
update app.integration_sync_runs set next_attempt_at = now() - interval '1 second' where id = pg_temp.id('run2');
select app.claim_integration_sync(pg_temp.id('run2'));
select is(app.fail_integration_sync(pg_temp.id('run2'), 'provider_unavailable', 'Xero returned 503.', true), 'Failed'::app.integration_sync_run_state, 'the last attempt fails for good');
select ok((select finished_at is not null from app.integration_sync_runs where id = pg_temp.id('run2')), 'a Failed run is finished');
select pg_temp.as_user('carol');
select throws_ok($$select app.retry_integration_sync((select id from world where key = 'run2'), 'Try again.')$$, '42501', null, 'a Manager cannot retry');
select pg_temp.as_user('bob');
select throws_ok($$select app.retry_integration_sync((select id from world where key = 'run1'), 'Again.')$$,
  'XR001', 'integration_sync_not_failed: Only a Failed run can be queued again.', 'only a Failed run is retried');
select lives_ok($$select app.retry_integration_sync((select id from world where key = 'run2'), 'Xero is back.')$$, 'Failed to Queued');
select is((select attempt::int from app.integration_sync_runs where id = pg_temp.id('run2')), 0, 'a retried run starts with fresh attempts');
select lives_ok($$select app.cancel_integration_sync((select id from world where key = 'run2'), 'Not needed this month.')$$, 'Queued to Canceled');
select throws_ok($$select app.cancel_integration_sync((select id from world where key = 'run2'), 'Again.')$$,
  'XR001', 'integration_sync_not_cancelable: Only a Queued or Retrying run can be canceled.', 'a Canceled run cannot be canceled again');
select pg_temp.as_platform();
select throws_ok($$select app.claim_integration_sync((select id from world where key = 'run2'))$$,
  'XR001', 'integration_sync_run_transition_not_allowed: A integration sync run cannot move from Canceled to Running.', 'a Canceled run is not claimed');
select is(private.integration_backoff(1), interval '30 seconds', 'backoff starts at 30 seconds');
select is(private.integration_backoff(3), interval '2 minutes', 'and doubles per attempt');
select is(private.integration_backoff(9), interval '1 hour', 'capped at one hour');

-- A refused credential moves the connection to Error --------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into world values ('run3', app.enqueue_integration_sync(pg_temp.id('xero_a'), 'Payment Sync', 'Two Way', 'payments-2'));
select pg_temp.as_platform();
select app.claim_integration_sync(pg_temp.id('run3'));
select is(app.fail_integration_sync(pg_temp.id('run3'), 'credential_revoked', 'Xero refused the token.', true, true), 'Failed'::app.integration_sync_run_state,
  'a connection error fails the run for good');
select is((select connection_state::text from app.integration_connections where id = pg_temp.id('xero_a')), 'Error', 'and moves the connection to Error');
select pg_temp.as_user('bob');
select throws_ok($$select app.enqueue_integration_sync((select id from world where key = 'xero_a'), 'Ledger Export', 'Outbound', 'ledger-2027-07')$$,
  'XR001', 'integration_not_connected: Only a Connected connection can sync.', 'a failing connection cannot sync');
select throws_ok($$select app.retry_integration_sync((select id from world where key = 'run3'), 'Again.')$$,
  'XR001', 'integration_not_connected: Only a Connected connection can sync.', 'nor retry');
select lives_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Error', 'Connected', 'Reauthorized.')$$, 'Error to Connected');

-- Disconnect destroys the credential ------------------------------------------------------------------------------------------
insert into world values ('run4', app.enqueue_integration_sync(pg_temp.id('xero_a'), 'Ledger Export', 'Outbound', 'ledger-2027-08'));
select pg_temp.as_platform();
insert into world select 'secret_a', c.vault_secret_id from private.integration_credentials c where c.integration_connection_id = pg_temp.id('xero_a');
select pg_temp.as_user('bob');
select lives_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Connected', 'Disconnected', 'Moving to NetSuite.')$$, 'Connected to Disconnected');
select is((select credential_kind from app.integration_connections where id = pg_temp.id('xero_a')), null::app.integration_credential_kind, 'the credential details are cleared');
select is((select sync_run_state::text from app.integration_sync_runs where id = pg_temp.id('run4')), 'Canceled', 'queued runs are canceled');
select throws_ok($$update app.integration_connections set display_name = 'Old Xero' where id = (select id from world where key = 'xero_a')$$,
  'XR001', 'integration_disconnected: A disconnected connection is kept for its history and cannot change.', 'a disconnected connection is frozen');
select throws_ok($$select app.store_integration_credential((select id from world where key = 'xero_a'), 'fixture-token-three', 'OAuth Token')$$,
  'XR001', 'integration_disconnected: A disconnected connection is kept for its history and cannot change.', 'and takes no new credential');
select throws_ok($$select app.transition_integration_connection((select id from world where key = 'xero_a'), 'Disconnected', 'Connected', 'Back.')$$,
  'XR001', 'integration_disconnected: A disconnected connection is kept for its history and cannot change.', 'Disconnected is final');
select lives_ok($$insert into app.integration_connections (org_id, provider_code, display_name, external_account_id) values ((select id from world where key = 'org_a'), 'xero', 'Northwind Xero', 'tenant-nwl')$$,
  'the provider account can be connected again');
select pg_temp.as_platform();
select is((select count(*)::int from vault.secrets where id = pg_temp.id('secret_a')), 0, 'the Vault secret is destroyed');
select throws_ok($$select app.read_integration_credential((select id from world where key = 'xero_a'))$$,
  'XR001', 'integration_not_active: A paused or disconnected connection does not hand out its credential.', 'a disconnected connection hands out no credential');

select * from finish();
rollback;
