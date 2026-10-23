-- pgTAP: company account notification defaults (A86, RRR-131, finding A65-004, Section 4.5.6 company settings
-- item 7). Account Owners and Admins set them; members read them; a team member without their own preference
-- follows them; their own preference still wins; nobody outside the account reads or sets them.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(12);

-- Who sets them -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('sam');
select throws_ok($$select app.set_account_notification_defaults(pg_temp.id('acct_v'), '[{"category": "finance", "channel": "Email", "enabled": false}]'::jsonb)$$,
  '42501', null, 'an Account Member cannot set the company''s defaults');
select throws_ok($$insert into app.account_notification_defaults (org_id, category_code, channel, enabled)
  values (pg_temp.id('acct_v'), 'finance', 'Email', false)$$, '42501', null, 'nor write the table directly');

select pg_temp.as_user('victor');
select lives_ok($$select app.set_account_notification_defaults(pg_temp.id('acct_v'), '[{"category": "finance", "channel": "Email", "enabled": false}]'::jsonb)$$,
  'the Account Owner turns finance email off by default');
select lives_ok($$select app.set_account_notification_defaults(pg_temp.id('acct_v'), '[{"category": "finance", "channel": "Email", "enabled": false}]'::jsonb)$$,
  'saving again is idempotent');
select is((select count(*)::integer from app.account_notification_defaults where org_id = pg_temp.id('acct_v')), 1,
  'one row per category and channel');
select throws_ok($$select app.set_account_notification_defaults(pg_temp.id('acct_v'), '[{"category": "finance", "channel": "SMS", "enabled": true}]'::jsonb)$$,
  'XR001', 'notification_channel_outside: A company sets Email and Push only.', 'a company sets Email and Push only');

select pg_temp.as_user('sam');
select is((select count(*)::integer from app.account_notification_defaults), 1, 'team members read the defaults');
select pg_temp.as_user('quinn');
select is((select count(*)::integer from app.account_notification_defaults), 0, 'someone outside the account reads nothing');
select throws_ok($$select app.set_account_notification_defaults(pg_temp.id('acct_v'), '[]'::jsonb)$$, '42501', null,
  'nor sets them');

-- Resolution ----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.person_channel_enabled(pg_temp.id('sam'), 'finance', 'Email'), false,
  'a team member without a preference follows the company default');
select is(private.person_channel_enabled(pg_temp.id('quinn'), 'finance', 'Email'), true,
  'someone outside the account keeps the channel default');
insert into app.person_notification_preferences (person_id, category_code, channel, enabled)
values (pg_temp.id('sam'), 'finance', 'Email', true);
select is(private.person_channel_enabled(pg_temp.id('sam'), 'finance', 'Email'), true,
  'their own preference still wins');

select * from finish();
rollback;
