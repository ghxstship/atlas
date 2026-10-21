-- pgTAP: dunning read-only and the banner status (1353, A79, finding A65-015, Section 16). From day 21 of a failed
-- payment the org refuses people's writes with the fix; billing still writes and a recovered payment restores writes.
-- The banner status tells Owners and Admins from day 0 and everyone once the org is read-only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(16);

-- A failed payment: Owners and Admins see it, the org stays writable -----------------------------------------------
select pg_temp.as_platform();
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_A79Dunning', 'sub_A79Dunning', 'team', 'Monthly', 'active', now() + interval '30 days', false);
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_A79Dunning', 'sub_A79Dunning', 'team', 'Monthly', 'past_due', now() + interval '30 days', false);
select pg_temp.as_user('alice');
select results_eq($$select read_only_reason, billing_state from app.org_banner_status((select id from world where key = 'org_a'))$$,
  $$values (null::text, 'past_due'::text)$$, 'the Owner sees the failed payment from day 0');
select ok((select past_due_since between now() - interval '1 minute' and now() from app.org_banner_status(pg_temp.id('org_a'))),
  'with the day it began');
select pg_temp.as_user('bob');
select is((select billing_state from app.org_banner_status(pg_temp.id('org_a'))), 'past_due', 'so does an Admin');
select pg_temp.as_user('dave');
select is((select billing_state from app.org_banner_status(pg_temp.id('org_a'))), null, 'a Member does not while the org is writable');
select pg_temp.as_user('bob');
select lives_ok($$insert into app.teams (org_id, name) values ((select id from world where key = 'org_a'), 'Day Ten Crew')$$,
  'before day 21 the org stays writable');

-- Day 21: read-only --------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select private.run_dunning(now() + interval '21 days');
select is(private.org_read_only_reason(pg_temp.id('org_a')), 'dunning', 'on day 21 the org is read-only for non-payment');
select pg_temp.as_user('dave');
select results_eq($$select read_only_reason, billing_state from app.org_banner_status((select id from world where key = 'org_a'))$$,
  $$values ('dunning'::text, 'read_only'::text)$$, 'everyone sees why');
select pg_temp.as_user('bob');
select throws_like($$insert into app.teams (org_id, name) values ((select id from world where key = 'org_a'), 'Day Twenty Crew')$$,
  'org_read_only: This organization is read-only because a payment is overdue%', 'a person''s write is refused with the fix');
select pg_temp.as_user('alice');
select throws_like($$update app.teams set name = 'Renamed' where org_id = (select id from world where key = 'org_a')$$,
  'org_read_only:%', 'the Owner''s too');
select pg_temp.as_platform();
select ok((select count(*) from app.teams where org_id = pg_temp.id('org_a')) >= 2, 'no data is deleted for non-payment');
select is(app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_A79Dunning', 'sub_A79Dunning', 'team', 'Monthly', 'active', now() + interval '30 days', false),
  'active'::app.subscription_state, 'billing still writes while the org is read-only');
select is(private.org_read_only_reason(pg_temp.id('org_a')), null, 'a recovered payment restores writes');
select pg_temp.as_user('bob');
select lives_ok($$insert into app.teams (org_id, name) values ((select id from world where key = 'org_a'), 'Back In Business')$$,
  'and people write again');

-- Trial and access --------------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
insert into world values ('trial_org', app.create_organization('Signal Yard', 'signal-yard'));
select results_eq($$select trial_plan, read_only_reason from app.org_banner_status((select id from world where key = 'trial_org'))$$,
  $$values ('pro'::text, null::text)$$, 'a new org''s banner shows its trial');
select ok((select trial_ends_at > now() + interval '13 days' from app.org_banner_status(pg_temp.id('trial_org'))), 'and when it ends');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.org_banner_status((select id from world where key = 'org_a'))$$, '42501', null,
  'someone outside the org reads no banner status');

select * from finish();
rollback;
