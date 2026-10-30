-- pgTAP: subscription pauses (B16, 3051; Section 16, ADR 0155 D4). Northwind Live pays the monthly Team plan through
-- Stripe. Its Owner pauses for whole months from the end of the paid period; the org stays writable until the pause
-- starts and is read-only while it runs, with every row kept, the personal tables writable and leaving open. The Owner
-- resumes at any time, Stripe-side pauses are mirrored, stale Stripe events change nothing, the hourly job notifies and
-- ends pauses on schedule, and cancellation or a deletion request ends a pause.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(78);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
-- The webhook's sync of Northwind's Stripe subscription, as the server module calls it.
create function pg_temp.sync(p_status text, p_pause boolean, p_resumes_at timestamptz, p_event_at timestamptz) returns text
language plpgsql as $$
begin
  perform pg_temp.as_service();
  return app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'team', 'Monthly', p_status,
    (select at from k where key = 'period_end'), false, 0, p_pause, p_resumes_at, p_event_at)::text;
end $$;
create function pg_temp.open_pause() returns app.subscription_pauses language sql stable as $$
  select p.* from app.subscription_pauses p where p.org_id = pg_temp.id('org_a') and p.ended_at is null and p.deleted_at is null $$;
-- Every pause of one test transaction has the same created_at, so the pause a step looks at is remembered by id.
create function pg_temp.remember_open() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  insert into k (key, id) values ('last', (pg_temp.open_pause()).id) on conflict (key) do update set id = excluded.id;
end $$;
create function pg_temp.last_pause() returns app.subscription_pauses language sql stable as $$
  select p.* from app.subscription_pauses p where p.id = (select id from k where key = 'last') $$;
-- Moves the open Owner pause so it started a day ago and resumes p_months later (UTC whole months).
create function pg_temp.start_open_pause(p_months integer) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  update app.subscription_pauses
  set starts_at = now() - interval '1 day', resumes_at = private.pause_resume_at(now() - interval '1 day', p_months)
  where id = (pg_temp.open_pause()).id;
end $$;

create temporary table k (key text primary key, at timestamptz, id uuid);
grant select, insert, update on k to public;
insert into k (key, at) values ('period_end', date_trunc('second', now() + interval '20 days'));

-- Setup: a file made before any pause; Northwind pays monthly through Stripe; Harbor Lights pays annually; Bluewater
-- is past due; Nina has a trial and a sandbox.
select pg_temp.as_user('alice');
insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWP', 'Northwind Pause Tour', 'America/New_York');
insert into k (key, id) select 'file_version', u.attachment_version_id
from app.begin_attachment_upload('app.projects', (select id from app.projects where project_key = 'NWP'), 'rider.pdf', 'application/pdf', 1200) u;
insert into storage.objects (bucket_id, name, metadata)
select 'attachments', v.object_name, '{"size": 1200}' from app.attachment_versions v where v.id = (select id from k where key = 'file_version');
select app.complete_attachment_upload((select id from k where key = 'file_version'), repeat('ab', 32));
select pg_temp.as_platform();
select app.record_attachment_scan((select id from k where key = 'file_version'), true);
insert into k (key, id) select 'file', v.attachment_id from app.attachment_versions v where v.id = (select id from k where key = 'file_version');
select pg_temp.sync('active', false, null, now() - interval '1 day');
select pg_temp.as_service();
select app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_H4rb0r', 'sub_H4rb0r', 'team', 'Annual', 'active', now() + interval '200 days', false);
select app.sync_subscription_from_stripe(pg_temp.id('org_p'), 'cus_Blu3', 'sub_Blu3', 'team', 'Monthly', 'active', now() + interval '30 days', false);
select pg_temp.as_platform();
select private.transition_subscription(s.id, 'active', 'past_due', 'Fixture: a payment failed.') from app.subscriptions s
where s.org_id = pg_temp.id('org_p') and s.subscription_state = 'active';
select pg_temp.as_user('nina');
insert into world values ('org_n', app.create_organization('Nina Lighting', 'nina-lighting'));
insert into world values ('org_s', app.create_organization('Nina Sandbox', 'nina-sandbox'));
select pg_temp.as_platform();
insert into app.sandbox_orgs (org_id, person_id, expires_at) values (pg_temp.id('org_s'), pg_temp.id('nina'), now() + interval '1 day');

-- The table ----------------------------------------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'app.subscription_pauses', 'insert')
  and not has_table_privilege('authenticated', 'app.subscription_pauses', 'update'), 'nobody writes a pause directly');
select ok(not has_function_privilege('authenticated',
  'app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer, boolean, timestamptz, timestamptz)', 'execute'),
  'only the service role syncs a Stripe subscription');
select ok(exists (select 1 from private.read_only_exempt_tables where table_name = 'app.subscription_pauses')
  and not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'app.subscription_pauses'::regclass and t.tgname = 't15_refuse_read_only_org'),
  'pauses stay writable while the org is read-only, so resuming works');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'subscription_pauses'), 'pauses are kept out of Trash');

-- The checks, in order, with step-up last ------------------------------------------------------------------------------
select pg_temp.as_user_stepped_up('dave');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_a'), 2, false)$$, '42501', null,
  'a member who does not manage billing cannot pause');
select pg_temp.as_user_stepped_up('nina');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_s'), 2, false)$$, 'XR001',
  'sandbox_not_billable: A sandbox is never billed.', 'a sandbox is never billed');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_n'), 2, false)$$, 'XR001',
  'pause_not_paid: Only a plan paid through Stripe can pause.', 'a trial without Stripe has nothing to pause');
select pg_temp.as_user_stepped_up('cora');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_c'), 2, false)$$, 'XR001',
  'billing_through_partner: Your partner bills this organization. Ask the partner about a pause.', 'a partner-billed org is not paused');
select pg_temp.as_user_stepped_up('paul');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_p'), 2, false)$$, 'XR001',
  'pause_past_due: A payment is overdue, so billing cannot pause. Update the payment method first.',
  'a past-due org cannot hide its overdue payment behind a pause');
select pg_temp.as_platform();
select private.transition_subscription(s.id, 'past_due', 'read_only', 'Fixture: day 21 of dunning.') from app.subscriptions s
where s.org_id = pg_temp.id('org_p') and s.subscription_state = 'past_due';
select pg_temp.as_user_stepped_up('paul');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_p'), 2, false)$$, 'XR001',
  'org_read_only: A read-only organization cannot pause. Settle what made it read-only first.', 'nor can an org read-only for dunning');
select pg_temp.as_user_stepped_up('xavier');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_b'), 2, false)$$, 'XR001',
  'pause_annual: An annual plan is paid for the year and cannot pause.', 'an annual plan cannot pause');
select pg_temp.as_user_stepped_up('alice');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_a'), 0, false)$$, 'XR001',
  'pause_months_range: A pause lasts 1 to 6 whole months.', 'a pause lasts at least a month');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_a'), 7, false)$$, 'XR001', null, 'and at most six');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_a'), 2, true)$$, 'XR001',
  'pause_not_paid: Only a plan paid through Stripe can pause.', 'the mode must match the Stripe subscription');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.begin_subscription_pause(pg_temp.id('org_a'), 2, false)$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to change billing.', 'step-up is asked last');

-- Pausing --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user_stepped_up('alice');
select results_eq($$select * from app.begin_subscription_pause(pg_temp.id('org_a'), 2, false)$$,
  $$values ('sub_N0rthw1nd'::text, (select at from k where key = 'period_end'),
            ((select at from k where key = 'period_end') at time zone 'UTC' + interval '2 months') at time zone 'UTC')$$,
  'begin returns the Stripe subscription, the end of the paid period and exactly two months later');
select is((select count(*)::integer from app.subscription_pauses), 0, 'nothing is recorded until Stripe confirms');
insert into k (key, id) values ('pause', app.record_subscription_pause(pg_temp.id('org_a'), 2, false, 'sub_N0rthw1nd'));
select results_eq($$select source::text, starts_at, resumes_at, requested_by from app.subscription_pauses where id = (select id from k where key = 'pause')$$,
  $$values ('Owner'::text, (select at from k where key = 'period_end'),
            ((select at from k where key = 'period_end') at time zone 'UTC' + interval '2 months') at time zone 'UTC', pg_temp.id('alice'))$$,
  'the Owner''s pause starts at the paid period end and resumes two whole months later');
select throws_ok($$select app.record_subscription_pause(pg_temp.id('org_a'), 2, false, 'sub_Wr0ng')$$, 'XR001',
  'pause_open: This organization already has a pause. Resume it or cancel it first.', 'a second pause is refused');
select results_eq($$select source::text, months, started from app.subscription_pause_status(pg_temp.id('org_a'))$$,
  $$values ('Owner'::text, 2, false)$$, 'Billing and Plan reads the scheduled pause');
select is(pg_temp.sync('active', true, (pg_temp.open_pause()).resumes_at - interval '1 hour', now()), 'active',
  'Stripe''s pause_collection keeps the subscription active');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subscription_pauses where org_id = pg_temp.id('org_a')), 1,
  'the webhook finds the Owner''s pause and opens no other');

-- Scheduled: still writable -------------------------------------------------------------------------------------------
select is(private.org_read_only_reason(pg_temp.id('org_a')), null, 'before the pause starts the org is writable');
select pg_temp.as_user('dave');
select lives_ok($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('org_a'), 'before', 'Before the pause')$$,
  'and members write as usual');
select is((select coalesce(read_only_reason, 'none') || ' ' || (pause_starts_at is null)::text from app.org_banner_status(pg_temp.id('org_a'))),
  'none true', 'a member without billing access sees no scheduled pause');
select pg_temp.as_user('alice');
select is((select pause_starts_at from app.org_banner_status(pg_temp.id('org_a'))), (select at from k where key = 'period_end'),
  'a billing reader sees when it starts');

-- Started: read-only -------------------------------------------------------------------------------------------------
select pg_temp.start_open_pause(2);
select is(private.org_read_only_reason(pg_temp.id('org_a')), 'paused', 'from starts_at the org is read-only as paused');
select pg_temp.as_user('dave');
select ok((select pause_starts_at is not null and pause_resumes_at is not null and read_only_reason = 'paused'
           from app.org_banner_status(pg_temp.id('org_a'))), 'every member sees the started pause in the banner');
select throws_ok($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('org_a'), 'north', 'North')$$, 'XR001',
  'org_read_only: This organization is paused and read-only. The Owner can resume it in Settings, Billing and plan; no data is deleted.',
  'a person''s write is refused with the paused sentence');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.create_share_link((select id from k where key = 'file'), now() + interval '7 days')$$, 'XR001',
  'org_read_only: This organization is paused and read-only. The Owner can resume it in Settings, Billing and plan; no data is deleted.',
  'making a share link names the pause');
select lives_ok($$select app.record_legal_acceptances(pg_temp.id('org_a'), array['terms-of-service'], array['1.0.1'])$$,
  'a paused member still accepts a new legal version');
select pg_temp.as_user('dave');
select lives_ok($$insert into app.favorites (org_id, person_id, node_id) values (pg_temp.id('org_a'), pg_temp.id('dave'), 'projects')$$,
  'and keeps the personal tables: favorites');
select pg_temp.as_user('gina');
select lives_ok($$select app.leave_organization(pg_temp.id('org_a'))$$, 'a member can leave a paused org');
select pg_temp.as_platform();
select ok(exists (select 1 from app.offboardings o where o.membership_id = pg_temp.id('gina@org_a')), 'and leaving opens their offboarding');
select lives_ok($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('org_a'), 'kept-by-worker', 'Kept by a worker')$$,
  'workers and the service role still write');
select is((select count(*)::integer from app.projects where org_id = pg_temp.id('org_a')), 1, 'no data is deleted');
select ok(exists (select 1 from private.read_only_exempt_tables where table_name = 'app.org_exports')
  and exists (select 1 from private.read_only_exempt_tables where table_name = 'app.notifications'),
  'exports and notifications stay writable');

-- The hourly job tells the billing owners once --------------------------------------------------------------------------
select ok(private.run_subscription_pauses(now()) >= 1, 'the hourly job acts on the started pause');
select ok(exists (select 1 from app.notifications where recipient_person_id = pg_temp.id('alice') and kind = 'billing.paused'
                  and message_args ->> 'resumesOn' = to_char((pg_temp.open_pause()).resumes_at at time zone 'UTC', 'YYYY-MM-DD')),
  'billing owners hear billing.paused with the resume date');
select ok(not exists (select 1 from app.notifications where recipient_person_id = pg_temp.id('dave') and kind = 'billing.paused'),
  'other members do not');
select is(private.run_subscription_pauses(now()), 0, 'and only once');
select ok(private.run_org_lifecycle(now()) is not null, 'the pauses run inside the hourly lifecycle job');

-- Resuming while paused ----------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select * from app.begin_subscription_resume(pg_temp.id('org_a'), false)$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to change billing.', 'resuming needs step-up too');
select pg_temp.as_user_stepped_up('dave');
select throws_ok($$select * from app.begin_subscription_resume(pg_temp.id('org_a'), false)$$, '42501', null, 'and the billing capability');
select pg_temp.as_user_stepped_up('alice');
select results_eq($$select * from app.begin_subscription_resume(pg_temp.id('org_a'), false)$$, $$values ('sub_N0rthw1nd'::text, true)$$,
  'begin_subscription_resume works while the org is read-only and says the pause has started');
-- Stripe's update arrives before Atlas records the resume.
select pg_temp.remember_open();
select pg_temp.sync('active', false, null, now());
select pg_temp.as_platform();
select is((pg_temp.last_pause()).end_reason::text, 'Resumed in Stripe', 'the webhook ends the pause when Stripe clears it');
select pg_temp.as_user_stepped_up('alice');
select is(app.record_subscription_resume(pg_temp.id('org_a'), false), (select id from k where key = 'pause'),
  'recording the resume afterwards finds that pause');
select pg_temp.as_platform();
select results_eq($$select end_reason::text, ended_by from app.subscription_pauses where id = (select id from k where key = 'pause')$$,
  $$values ('Resumed by Owner'::text, pg_temp.id('alice'))$$, 'and rewrites it as the Owner''s resume');
select is(private.org_read_only_reason(pg_temp.id('org_a')), null, 'writes are restored at once');
select pg_temp.as_user_stepped_up('alice');
select throws_ok($$select app.record_subscription_resume(pg_temp.id('org_a'), false)$$, 'XR001', null, 'with nothing to resume twice');
select pg_temp.as_platform();
update app.subscription_pauses set ended_at = now() - interval '11 minutes' where id = (select id from k where key = 'pause');
select pg_temp.as_user_stepped_up('alice');
select throws_ok($$select * from app.begin_subscription_resume(pg_temp.id('org_a'), false)$$, 'XR001',
  'pause_none: This organization has no pause to resume.', 'begin refuses without an open pause');

-- Stale Stripe events change nothing -------------------------------------------------------------------------------------
select pg_temp.sync('active', true, now() + interval '40 days', now() - interval '20 minutes');
select pg_temp.as_platform();
select is((pg_temp.open_pause()).id, null, 'a late paused event older than the last resume does not reopen a pause');

-- A pause set in Stripe ----------------------------------------------------------------------------------------------
select is(pg_temp.sync('paused', false, null, now() + interval '1 second'), 'active', 'Stripe''s paused status changes no state');
select pg_temp.as_platform();
select ok((pg_temp.open_pause()).source = 'Stripe' and (pg_temp.open_pause()).resumes_at is null
          and (pg_temp.open_pause()).starts_at <= now(), 'but opens an open-ended Stripe pause from now');
select is(private.org_read_only_reason(pg_temp.id('org_a')), 'paused', 'which makes the org read-only at once');
select pg_temp.remember_open();
select pg_temp.sync('active', false, null, now() - interval '1 hour');
select pg_temp.as_platform();
select ok((pg_temp.open_pause()).id is not null, 'an event older than the pause does not end it');
select pg_temp.sync('active', false, null, now() + interval '2 seconds');
select pg_temp.as_platform();
select is((pg_temp.last_pause()).end_reason::text, 'Resumed in Stripe', 'Stripe resuming the subscription ends it');

select pg_temp.sync('active', true, (select at from k where key = 'period_end') + interval '30 days', now() + interval '3 seconds');
select pg_temp.as_platform();
select results_eq($$select source::text, starts_at, resumes_at from app.subscription_pauses where id = (pg_temp.open_pause()).id$$,
  $$values ('Stripe'::text, (select at from k where key = 'period_end'), (select at from k where key = 'period_end') + interval '30 days 1 hour')$$,
  'pause_collection set in Stripe is mirrored from the paid period end until Stripe''s resume plus an hour');
select pg_temp.as_user_stepped_up('alice');
select is(app.record_subscription_pause(pg_temp.id('org_a'), 3, false, 'sub_N0rthw1nd'), (pg_temp.open_pause()).id,
  'Atlas recording right after the webhook takes over that pause');
select pg_temp.as_platform();
select results_eq($$select source::text, months from app.subscription_pause_status(pg_temp.id('org_a'))$$,
  $$values ('Owner'::text, 3)$$, 'as the Owner''s, for the months chosen');

-- Ending on schedule -------------------------------------------------------------------------------------------------
select pg_temp.remember_open();
update app.subscription_pauses set starts_at = now() - interval '100 days',
  resumes_at = private.pause_resume_at(now() - interval '100 days', 3) where id = (select id from k where key = 'last');
select is(private.org_read_only_reason(pg_temp.id('org_a')), null, 'read-only lifts at resumes_at, before any job runs');
select ok(private.run_subscription_pauses(now()) >= 1, 'the hourly job ends it');
select is((pg_temp.last_pause()).end_reason::text, 'Resumed on schedule', 'as Resumed on schedule');
select ok(exists (select 1 from app.notifications where recipient_person_id = pg_temp.id('alice') and kind = 'billing.resumed'),
  'billing owners hear billing.resumed');

-- Stripe clears an Owner's pause at its own resume, an hour early.
select pg_temp.sync('active', true, (select at from k where key = 'period_end') + interval '30 days', now() + interval '4 seconds');
select pg_temp.as_user_stepped_up('alice');
select app.record_subscription_pause(pg_temp.id('org_a'), 1, false, 'sub_N0rthw1nd');
select pg_temp.remember_open();
update app.subscription_pauses set starts_at = private.pause_resume_at(now() + interval '1 hour', -1),
  resumes_at = private.pause_resume_at(private.pause_resume_at(now() + interval '1 hour', -1), 1)
where id = (select id from k where key = 'last');
delete from app.notifications where kind = 'billing.resumed';
select pg_temp.sync('active', false, null, now() + interval '5 seconds');
select pg_temp.as_platform();
select is((pg_temp.last_pause()).end_reason::text, 'Resumed on schedule', 'Stripe clearing it within two hours of the resume ends it on schedule');
select is((select count(*)::integer from app.notifications where recipient_person_id = pg_temp.id('alice') and kind = 'billing.resumed'), 1,
  'with billing.resumed, once');

-- Cancellation, deletion and Stripe deleting the subscription end a pause --------------------------------------------------
select pg_temp.sync('active', true, null, now() + interval '6 seconds');
select pg_temp.remember_open();
update app.subscription_pauses set starts_at = now() - interval '1 hour' where id = (select id from k where key = 'last');
select pg_temp.as_user('alice');
select lives_ok($$select app.cancel_organization(pg_temp.id('org_a'), 'Northwind Live', 'The season is over.')$$, 'a paused org can be canceled');
select pg_temp.as_platform();
select is((pg_temp.last_pause()).end_reason::text, 'Canceled', 'which ends its pause as Canceled');
select is(private.org_read_only_reason(pg_temp.id('org_a')), 'canceled', 'and the org follows the cancellation');
select pg_temp.as_user('paul');
select throws_ok($$select app.cancel_organization(pg_temp.id('org_p'), 'Bluewater Partners', 'No.')$$, 'XR001',
  'org_already_canceled: This organization is already canceled.', 'an org read-only for dunning is refused as before');

select pg_temp.as_platform();
insert into app.subscription_pauses (stripe_subscription_link_id, source, starts_at)
select l.id, 'Stripe', now() - interval '1 hour' from app.stripe_subscription_links l where l.stripe_subscription_id = 'sub_H4rb0r';
insert into app.org_deletion_requests (org_id, reason, recover_until, requested_by)
values (pg_temp.id('org_b'), 'Closing down.', now() + interval '7 days', pg_temp.id('xavier'));
select is((select end_reason::text from app.subscription_pauses where org_id = pg_temp.id('org_b')), 'Canceled',
  'a deletion request ends the pause too');
select pg_temp.as_service();
select app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_H4rb0r', 'sub_H4rb0r', 'team', 'Annual', 'paused', now() + interval '200 days', false,
  0, false, null, now() + interval '1 minute');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subscription_pauses where org_id = pg_temp.id('org_b') and ended_at is null), 1,
  'a later paused status opens a new Stripe pause');
select pg_temp.as_service();
select is(app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_H4rb0r', 'sub_H4rb0r', 'team', 'Annual', 'canceled', now() + interval '200 days', false,
  0, false, null, now() + interval '2 minutes')::text, 'canceled', 'Stripe deleting the subscription cancels it');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subscription_pauses where org_id = pg_temp.id('org_b') and end_reason = 'Canceled'), 2,
  'and ends the pause as Canceled');

-- Read-only refusals name their reason ------------------------------------------------------------------------------
select is(private.read_only_refusal('dunning'), 'This organization is read-only because a payment is overdue. An Owner can update the payment method in Settings, Billing and plan; no data is deleted.',
  'dunning keeps its sentence');
select is(private.read_only_refusal(null), null, 'a writable org has none');
select is(private.pause_resume_at('2026-01-31 12:00:00+00', 1), '2026-02-28 12:00:00+00'::timestamptz,
  'whole months are counted in UTC, ending on the last day of a shorter month');
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events a where a.subject_table = 'app.subscription_pauses') > 0, 'every pause change is audited');

select * from finish();
rollback;
