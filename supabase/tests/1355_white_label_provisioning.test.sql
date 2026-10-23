-- pgTAP: white label provisioning and the downgrade grace (1355, A79, finding A65-033, Section 12). Adding a custom Atlas,
-- Gateway or sending domain queues the provider worker; only the worker records provisioning and verification; removing
-- a provisioned domain queues its release. A downgrade keeps white label to the end of the paid period with notice,
-- then reverts; regaining the plan ends the grace; a trial that ends reverts at once with notice.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(29);

-- Provisioning ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.org_domains (org_id, hostname, purpose) values (pg_temp.id('org_a'), 'atlas.northwind-live.com', 'Atlas');
insert into app.org_domains (org_id, hostname, purpose) values (pg_temp.id('org_a'), 'mail.northwind-live.com', 'Email Sending');
insert into app.org_domains (org_id, hostname, purpose) values (pg_temp.id('org_a'), 'northwind-live.com', 'Verified Domain');
select pg_temp.as_platform();
insert into world select 'atlas_host', id from app.org_domains where hostname = 'atlas.northwind-live.com';
insert into world select 'mail_host', id from app.org_domains where hostname = 'mail.northwind-live.com';
insert into world select 'verified_host', id from app.org_domains where hostname = 'northwind-live.com';
select is((select provisioning_status::text from app.org_domains where id = pg_temp.id('atlas_host')), 'Not Started',
  'a new custom domain starts unprovisioned');
select is((select count(*)::int from app.job_queue where job_kind = 'domain.provision' and subject_id in (pg_temp.id('atlas_host'), pg_temp.id('mail_host'))),
  2, 'adding an Atlas host or a sending domain queues the provider worker');
select is((select count(*)::int from app.job_queue where subject_id = pg_temp.id('verified_host')), 0,
  'a verified domain proves itself by TXT record and is not provisioned');

select pg_temp.as_user('alice');
select throws_like($$update app.org_domains set provisioning_status = 'Active', tls_ready = true where id = (select id from world where key = 'atlas_host')$$,
  'domain_verification_service:%', 'no member records provisioning');
insert into app.org_domains (org_id, hostname, purpose, provisioning_status, tls_ready)
values (pg_temp.id('org_a'), 'gw.northwind-live.com', 'Gateway', 'Active', true);
select is((select provisioning_status::text || ' ' || tls_ready::text from app.org_domains where hostname = 'gw.northwind-live.com'),
  'Not Started false', 'nor sets it on insert');
select pg_temp.as_platform();
select is(app.record_domain_provisioning(pg_temp.id('atlas_host'), 'Pending DNS', 'atlas.northwind-live.com',
  '[{"type": "CNAME", "name": "atlas.northwind-live.com", "value": "cname.vercel-dns.com", "purpose": "routing"}]'::jsonb, false, false),
  'Pending DNS'::app.domain_provisioning_status, 'the worker records the records to publish');
select ok((select provider_ref = 'atlas.northwind-live.com' and jsonb_array_length(dns_records) = 1 and verification_state = 'Pending'
  from app.org_domains where id = pg_temp.id('atlas_host')), 'with the provider reference');
select ok(exists (select 1 from app.job_queue where job_kind = 'domain.check' and subject_id = pg_temp.id('atlas_host')
  and run_after > now() + interval '14 minutes'), 'and checks again in 15 minutes while DNS is pending');
select is((select count(*)::int from api_public.org_brand_for_host('atlas.northwind-live.com')), 0, 'an unverified host serves no brand');
select is(app.record_domain_provisioning(pg_temp.id('atlas_host'), 'Active', null, null, true, true),
  'Active'::app.domain_provisioning_status, 'once DNS verifies, Vercel issues TLS and the host is active');
select ok((select verification_state = 'Verified' and tls_ready and provisioned_at is not null from app.org_domains where id = pg_temp.id('atlas_host')),
  'verified, with TLS ready');
select is((select org_id from api_public.org_brand_for_host('atlas.northwind-live.com')), pg_temp.id('org_a'), 'the host serves the org''s brand');
select is(app.record_domain_provisioning(pg_temp.id('mail_host'), 'Failed', null, null, null, null, 'Resend refused the domain: invalid.'),
  'Failed'::app.domain_provisioning_status, 'a failed step keeps the provider''s reason');
select is((select provisioning_error from app.org_domains where id = pg_temp.id('mail_host')), 'Resend refused the domain: invalid.', 'for the Owner to read');

select pg_temp.as_user('alice');
select ok(app.request_domain_check(pg_temp.id('mail_host')) is not null, 'an Owner asks for another try');
select pg_temp.as_user('xavier');
select throws_ok($$select app.request_domain_check((select id from world where key = 'atlas_host'))$$, '42501', null,
  'another org cannot');

-- Downgrade grace -------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.org_brands (org_id, display_name, suppress_powered_by) values (pg_temp.id('org_a'), 'Northwind', true);
select pg_temp.as_platform();
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_A79Brand', 'sub_A79Brand', 'team', 'Monthly', 'active', now() + interval '20 days', false);
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_A79Brand', 'sub_A79Brand', 'core', 'Monthly', 'active', now() + interval '50 days', false);
select ok((select kept_until > now() + interval '19 days' and kept_until < now() + interval '21 days' from app.white_label_grace
  where org_id = pg_temp.id('org_a') and ended_at is null), 'a downgrade keeps white label to the end of the period already paid');
select is((select count(*)::int from app.notifications where kind = 'organization.white_label_reverting' and recipient_person_id = pg_temp.id('alice')),
  1, 'every Owner is told when it reverts');
select ok((select suppress_powered_by from private.public_brand(pg_temp.id('org_a'))), '"Powered by XOS" stays hidden meanwhile');
select is((select org_id from api_public.org_brand_for_host('atlas.northwind-live.com')), pg_temp.id('org_a'), 'and the custom domain keeps serving');
select pg_temp.as_user('alice');
select ok((select white_label_until is not null from app.org_banner_status(pg_temp.id('org_a'))), 'the banner shows until when');
select pg_temp.as_platform();
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_A79Brand', 'sub_A79Brand', 'team', 'Monthly', 'active', now() + interval '20 days', false);
select is((select end_reason from app.white_label_grace where org_id = pg_temp.id('org_a')), 'plan_regained', 'regaining the plan ends the grace');
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_A79Brand', 'sub_A79Brand', 'core', 'Monthly', 'active', now() + interval '20 days', false);
select is(private.revert_white_label(now() + interval '10 days'), 0, 'nothing reverts inside the paid period');
select is(private.revert_white_label(now() + interval '21 days'), 1, 'at the next billing cycle the lifecycle job reverts it');
select ok(not (select suppress_powered_by from private.public_brand(pg_temp.id('org_a'))), 'default branding returns');
select is((select count(*)::int from api_public.org_brand_for_host('atlas.northwind-live.com')), 0, 'and the custom domain stops serving the brand');
select is((select count(*)::int from app.notifications where kind = 'organization.white_label_reverted' and recipient_person_id = pg_temp.id('alice')),
  1, 'with a second notice');

-- A trial that ends reverts at once, with notice -----------------------------------------------------------------------
select pg_temp.as_user('nina');
insert into world values ('trial_org', app.create_organization('Copper Lane', 'copper-lane'));
insert into app.org_brands (org_id, suppress_powered_by) values (pg_temp.id('trial_org'), true);
select pg_temp.as_platform();
select private.run_trials(now() + interval '15 days');
select ok(not exists (select 1 from app.white_label_grace where org_id = pg_temp.id('trial_org'))
  and exists (select 1 from app.notifications where kind = 'organization.white_label_reverted' and recipient_person_id = pg_temp.id('nina')),
  'nothing was paid, so a trial''s white label reverts when it ends, with notice');

-- Release --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.org_domains set deleted_at = now() where id = pg_temp.id('atlas_host');
select pg_temp.as_platform();
select ok(exists (select 1 from app.job_queue where job_kind = 'domain.release' and subject_id = pg_temp.id('atlas_host')),
  'removing a provisioned domain queues its release at the provider');

select * from finish();
rollback;
