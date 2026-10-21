-- pgTAP: migration 1401 (A83, RRR-128, finding A65-029, Section 4.6.4). Warehouse delivery: Enterprise plan only,
-- managed by holders of reports.schedule.write, available providers only, public HTTPS endpoints only, Confidential
-- columns only by a holder of data.export.confidential, Restricted and encrypted columns never. The bucket credential
-- lives in Vault. Deliveries read only the org's own rows, record every file, retry with backoff and are audited.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(57);

-- Plan gate --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name, region)
  values ((select id from world where key = 'org_a'), 'S3', 'Lake', 'northwind-lake', 'us-east-1')$$,
  'XR001', 'warehouse_plan: Warehouse delivery is part of the Enterprise plan.', 'a Team org cannot add a destination');

select pg_temp.as_platform();
update app.subscriptions set plan_code = 'enterprise' where org_id = pg_temp.id('org_a');
-- "Nightly" is the org's night: the org keeps its calendar in Pacific/Auckland, far from UTC.
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'locale.time_zone', 'Organization', pg_temp.id('org_a'), 'Pacific/Auckland', null, null, true);
select pg_temp.as_platform();

-- Destinations -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with d as (insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name, region, delivery_hour, credential_stored_at, last_delivered_at)
  values (pg_temp.id('org_a'), 'S3', 'Northwind Lake', 'northwind-lake', 'us-east-1', 3, now(), now()) returning id) insert into world select 'dest', id from d;
select ok((select credential_stored_at is null and last_delivered_at is null from app.warehouse_destinations where id = pg_temp.id('dest')),
  'credential and delivery details sent on insert are discarded');
select ok((select next_delivery_at > now() and next_delivery_at <= now() + interval '1 day'
                  and extract(hour from next_delivery_at at time zone 'Pacific/Auckland') = 3
                  and extract(minute from next_delivery_at at time zone 'Pacific/Auckland') = 0
           from app.warehouse_destinations where id = pg_temp.id('dest')), 'the next delivery is the chosen hour on the org''s calendar, within a day');
select pg_temp.as_platform();
select is(private.next_warehouse_slot(1::smallint, '2027-06-30 12:00:00+00', 'Pacific/Auckland'), '2027-06-30 13:00:00+00'::timestamptz,
  '01:00 in Auckland (UTC+12 in winter) after noon UTC is 13:00 UTC the same day');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name)
  values ((select id from world where key = 'org_a'), 'BigQuery', 'Warehouse', 'northwind-bq')$$,
  'XR001', 'warehouse_provider_unavailable: Delivery to BigQuery is not available yet. Use S3 or an S3-compatible bucket.', 'an unavailable provider is refused');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name, endpoint_url)
  values ((select id from world where key = 'org_a'), 'S3', 'Local', 'northwind-local', 'https://localhost')$$,
  'XR001', 'warehouse_private_endpoint: A bucket endpoint must be a public HTTPS host.', 'a localhost endpoint is refused (the webhook SSRF guard)');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name, endpoint_url)
  values ((select id from world where key = 'org_a'), 'S3', 'Private', 'northwind-private', 'https://10.0.0.5')$$,
  'XR001', 'warehouse_private_endpoint: A bucket endpoint must be a public HTTPS host.', 'a private address is refused');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name, endpoint_url)
  values ((select id from world where key = 'org_a'), 'S3', 'Plain', 'northwind-plain', 'http://storage.example.test')$$,
  'XR001', 'warehouse_private_endpoint: A bucket endpoint must be a public HTTPS host.', 'a plain HTTP endpoint is refused');
select lives_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name, endpoint_url, region)
  values ((select id from world where key = 'org_a'), 'S3', 'Compatible', 'northwind-compat', 'https://objects.example-storage.test', 'auto')$$,
  'a public S3-compatible endpoint is accepted');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name)
  values ((select id from world where key = 'org_a'), 'S3', 'Bad', 'Not A Bucket')$$, '23514', null, 'a bucket name follows bucket naming rules');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name, path_prefix)
  values ((select id from world where key = 'org_a'), 'S3', 'Climb', 'northwind-climb', '../other')$$, '23514', null, 'a path prefix cannot climb out');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name, include_confidential)
  values ((select id from world where key = 'org_a'), 'S3', 'Confidential', 'northwind-conf', true)$$,
  'XR001', 'warehouse_confidential_capability: Delivering Confidential columns needs the confidential export capability.',
  'a Manager without data.export.confidential cannot include Confidential columns');
select throws_ok($$update app.warehouse_destinations set credential_stored_at = now() where id = (select id from world where key = 'dest')$$,
  'XR001', 'warehouse_fields_service_only: Credential and delivery details change only through the warehouse RPCs.', 'credential details change only through the RPC');
select throws_ok($$update app.warehouse_destinations set provider = 'Snowflake' where id = (select id from world where key = 'dest')$$,
  'XR001', 'warehouse_provider_fixed: A destination keeps its provider; add another destination instead.', 'the provider is fixed');
select pg_temp.as_user('bob');
select lives_ok($$update app.warehouse_destinations set include_confidential = true where id = (select id from world where key = 'dest')$$,
  'an Admin with data.export.confidential includes Confidential columns');
update app.warehouse_destinations set include_confidential = false where id = pg_temp.id('dest');

select pg_temp.as_user('dave');
select is((select count(*)::int from app.warehouse_destinations), 0, 'a Member reads no destinations');
select throws_ok($$insert into app.warehouse_destinations (org_id, provider, display_name, bucket_name)
  values ((select id from world where key = 'org_a'), 'S3', 'Member', 'northwind-member')$$, '42501', null, 'a Member cannot add one');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.warehouse_destinations), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.warehouse_destinations', '42501', null, 'anon cannot read destinations');

-- Credential in Vault ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.request_warehouse_delivery((select id from world where key = 'dest'))$$,
  'XR001', 'warehouse_credential_required: Store the bucket credential before the first delivery.', 'no delivery before a credential');
select lives_ok($$select app.store_warehouse_credential((select id from world where key = 'dest'), '{"access_key_id":"test-key-id","secret_access_key":"test-secret"}')$$,
  'a Manager stores the bucket credential');
select ok((select credential_stored_at is not null from app.warehouse_destinations where id = pg_temp.id('dest')), 'the destination records when');
select throws_ok($$select app.read_warehouse_credential((select id from world where key = 'dest'))$$, '42501', null, 'a signed-in person never reads it back');
select pg_temp.as_user('dave');
select throws_ok($$select app.store_warehouse_credential((select id from world where key = 'dest'), 'x')$$, '42501', null, 'a Member cannot store one');
select pg_temp.as_platform();
select ok(app.read_warehouse_credential(pg_temp.id('dest')) like '{"access_key_id"%', 'the service role decrypts it for the worker');

-- Deliver now ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world select 'del1', app.request_warehouse_delivery(pg_temp.id('dest'));
select ok((select delivery_state = 'Queued' and requested_manually and file_format = 'Parquet' and not include_confidential
           from app.warehouse_deliveries where id = pg_temp.id('del1')), 'Deliver now queues a delivery with the destination''s format');
select throws_ok($$select app.request_warehouse_delivery((select id from world where key = 'dest'))$$,
  'XR001', 'warehouse_delivery_in_progress: A delivery to this destination is already on its way.', 'one delivery at a time');
select throws_ok($$update app.warehouse_deliveries set delivery_state = 'Delivered' where id = (select id from world where key = 'del1')$$,
  '42501', null, 'a person cannot change a delivery');
select pg_temp.as_platform();
select is((select count(*)::int from app.job_queue where job_kind = 'warehouse.deliver' and subject_id = pg_temp.id('del1')), 1, 'its job is queued');

-- Running: the org's own rows, delivered columns only ---------------------------------------------------------------
select is((select provider::text || ' ' || bucket_name || ' ' || attempt from app.claim_warehouse_delivery(pg_temp.id('del1'))), 'S3 northwind-lake 1',
  'the worker claims the delivery and learns where it goes');
select ok((select delivery_state = 'Running' and snapshot_at is not null from app.warehouse_deliveries where id = pg_temp.id('del1')), 'the delivery is Running with a snapshot time');
select is((select count(*)::int from app.warehouse_table_rows(pg_temp.id('del1'), 'projects', null, 100)), 2, 'the projects file holds the org''s two projects');
select ok((select bool_and(r ->> 'org_id' = pg_temp.id('org_a')::text) from app.warehouse_table_rows(pg_temp.id('del1'), 'projects', null, 100) r),
  'and only the org''s own rows');
select is((select count(*)::int from app.warehouse_table_rows(pg_temp.id('del1'), 'projects',
  (select id from app.projects where org_id = pg_temp.id('org_a') order by id limit 1), 100)), 1, 'pages continue after the last id');
select is((select delivered::text || ' ' || withheld_reason from app.warehouse_delivery_columns(pg_temp.id('del1'))
           where table_key = 'pay_rates' and column_name = 'rate_minor'), 'false restricted', 'a Restricted column is withheld');
select is((select delivered::text || ' ' || withheld_reason from app.warehouse_delivery_columns(pg_temp.id('del1'))
           where table_key = 'engagements' and column_name = 'internal_note'), 'false confidential', 'a Confidential column is withheld unless included');

insert into app.pay_rates (org_id, membership_id, role_code, rate_minor, currency_code, effective_from)
select pg_temp.id('org_a'), pg_temp.id('frank@org_a'), r.role_code, 4200, 'USD', current_date - 1 from xpms.role r order by r.role_code limit 1;
select is((select count(*)::int from app.warehouse_table_rows(pg_temp.id('del1'), 'pay_rates', null, 100)), 1, 'the pay rate row is delivered');
select ok((select not (r ? 'rate_minor') and r ? 'currency_code' from app.warehouse_table_rows(pg_temp.id('del1'), 'pay_rates', null, 100) r),
  'without its Restricted rate');
select throws_ok($$select app.warehouse_table_rows((select id from world where key = 'del1'), 'people', null, 10)$$,
  'XR001', 'warehouse_table_unknown: The table is not part of the warehouse schema.', 'only catalog tables are read');
select pg_temp.as_user('bob');
select throws_ok($$select app.warehouse_table_rows((select id from world where key = 'del1'), 'projects', null, 10)$$,
  '42501', null, 'a signed-in person cannot read delivery rows');

select pg_temp.as_platform();
select app.record_warehouse_delivery_file(pg_temp.id('del1'), 'projects', 'xos/2026-10-20/' || pg_temp.id('del1') || '/projects.parquet',
  2, 1500, repeat('a', 64), 20::smallint, 0::smallint);
select app.record_warehouse_delivery_file(pg_temp.id('del1'), 'pay_rates', 'xos/2026-10-20/' || pg_temp.id('del1') || '/pay_rates.parquet',
  1, 700, repeat('b', 64), 9::smallint, 1::smallint);
select throws_ok($$update app.warehouse_delivery_files set row_count = 0 where warehouse_delivery_id = (select id from world where key = 'del1')$$,
  'XR001', null, 'delivery files are append-only');
select lives_ok($$select app.complete_warehouse_delivery((select id from world where key = 'del1'), 'xos/2026-10-20/x', '1')$$, 'the worker completes the delivery');
select is((select delivery_state::text || ' ' || tables_delivered || ' ' || rows_delivered || ' ' || bytes_delivered || ' ' || columns_withheld
           from app.warehouse_deliveries where id = pg_temp.id('del1')), 'Delivered 2 3 2200 1', 'the delivery totals its files');
select ok((select last_delivered_at is not null from app.warehouse_destinations where id = pg_temp.id('dest')), 'the destination records the delivery');
select is((select count(*)::int from app.domain_events where event_type = 'warehouse_delivery.finished' and subject_id = pg_temp.id('del1')), 1,
  'warehouse_delivery.finished is emitted');
select ok((select count(*) >= 2 from app.audit_events where subject_table = 'app.warehouse_deliveries' and subject_id = pg_temp.id('del1')),
  'every change of the delivery is in the audit ledger');

-- Retries, backoff and failure -------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world select 'del2', app.request_warehouse_delivery(pg_temp.id('dest'));
select pg_temp.as_platform();
select app.claim_warehouse_delivery(pg_temp.id('del2'));
select is(app.fail_warehouse_delivery(pg_temp.id('del2'), 'warehouse_unreachable', 'The bucket answered 503.', true), 'Retrying'::app.warehouse_delivery_state,
  'a retryable failure retries');
select ok((select next_attempt_at > now() from app.warehouse_deliveries where id = pg_temp.id('del2')), 'after a backoff');
update app.warehouse_deliveries set next_attempt_at = now() - interval '1 second' where id = pg_temp.id('del2');
select app.claim_warehouse_delivery(pg_temp.id('del2'));
select is(app.fail_warehouse_delivery(pg_temp.id('del2'), 'warehouse_access_denied', 'The bucket refused the credential.', false), 'Failed'::app.warehouse_delivery_state,
  'a permanent failure fails the delivery');
select is((select last_error_code from app.warehouse_destinations where id = pg_temp.id('dest')), 'warehouse_access_denied', 'the destination shows the last error');

-- The nightly schedule ------------------------------------------------------------------------------------------------
select private.begin_trusted_operation('warehouse_delivery');
update app.warehouse_destinations set next_delivery_at = now() - interval '1 minute' where id = pg_temp.id('dest');
select private.end_trusted_operation('warehouse_delivery');
select is(app.queue_due_warehouse_deliveries(), 1, 'the scheduler queues the due nightly delivery');
select ok((select next_delivery_at > now() from app.warehouse_destinations where id = pg_temp.id('dest')), 'and moves the next one to tomorrow');
select is(app.queue_due_warehouse_deliveries(), 0, 'nothing more is due');

-- Losing the plan before the delivery runs fails it -----------------------------------------------------------------
update app.subscriptions set plan_code = 'team' where org_id = pg_temp.id('org_a');
select is((select count(*)::int from app.claim_warehouse_delivery((select id from app.warehouse_deliveries where warehouse_destination_id = pg_temp.id('dest') and delivery_state = 'Queued'))),
  0, 'a delivery of an org that left Enterprise does not run');
select is((select error_code from app.warehouse_deliveries where warehouse_destination_id = pg_temp.id('dest') and requested_manually = false),
  'warehouse_destination_unavailable', 'it fails with the reason');
update app.subscriptions set plan_code = 'enterprise' where org_id = pg_temp.id('org_a');

-- Deleting a destination destroys its credential ---------------------------------------------------------------------
select pg_temp.as_user('carol');
update app.warehouse_destinations set deleted_at = now() where id = pg_temp.id('dest');
select pg_temp.as_platform();
select is((select count(*)::int from vault.secrets where name = 'xos_warehouse_' || pg_temp.id('dest')), 0, 'deleting a destination destroys its Vault credential');

-- The published schema is readable to members, without data ------------------------------------------------------
select pg_temp.as_user('dave');
select ok((select not delivered_by_default and not delivered_with_confidential and classification = 'Restricted'
           from app.warehouse_published_schema() where table_key = 'engagements' and column_name = 'agreed_rate_minor'),
  'the published schema shows a Restricted column as never delivered');

select * from finish();
rollback;
