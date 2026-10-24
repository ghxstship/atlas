-- pgTAP: per-person sandboxes (A96, RRR-141, A65-022, Section 11.7). A person opens one private sandbox filled from the
-- sandbox template; it is theirs alone, never billed, sends no email or SMS, lets nobody else in, and the hourly purge
-- removes every row of it once it expires.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(27);

select has_table('app', 'sandbox_orgs', 'sandboxes live in app.sandbox_orgs');
select is((select relrowsecurity from pg_class where oid = 'app.sandbox_orgs'::regclass), true, 'row level security is on');
select ok(exists (select 1 from cron.job where jobname = 'xos_purge_expired_sandboxes' and schedule = '37 * * * *'),
  'the purge runs every hour');

-- nina has no org of her own: she opens a sandbox from Help.
select pg_temp.as_user('nina');
insert into world select 'sandbox', s.org_id from app.open_my_sandbox() s;
select matches((select o.slug from app.organizations o where o.id = pg_temp.id('sandbox')), '^sandbox-[0-9a-f]{10}$',
  'the sandbox gets a sandbox slug');
select is((select o.name from app.organizations o where o.id = pg_temp.id('sandbox')), 'Northwind Live Sandbox',
  'and says plainly what it is');
select is((select s.org_id from app.open_my_sandbox() s), pg_temp.id('sandbox'), 'opening again returns the same sandbox');
select ok((select s.expires_at between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour'
           from app.my_sandbox() s), 'it ends 14 days after it opens');

select pg_temp.as_platform();
select is((select count(*)::int from app.projects p where p.org_id = pg_temp.id('sandbox')), 2,
  'the template brings the Northwind Summer Series and Winter Gala projects');
select is((select p.project_state::text from app.projects p where p.org_id = pg_temp.id('sandbox') and p.project_key = 'NWS'),
  'Active', 'with the Summer Series past gate 1');
select is((select count(*)::int from app.scope_nodes n join app.projects p on p.id = n.project_id
           where p.org_id = pg_temp.id('sandbox')), 8, 'their scope trees');
select is((select count(*)::int from app.records r join app.projects p on p.id = r.project_id
           where p.org_id = pg_temp.id('sandbox')), 10, 'and a load-in to strike run of records');
select is((select count(*)::int from app.memberships m where m.org_id = pg_temp.id('sandbox')), 1, 'nina is its only member');
select is((select r.code from app.memberships m join app.membership_roles mr on mr.membership_id = m.id
           join app.roles r on r.id = mr.role_id where m.org_id = pg_temp.id('sandbox')), 'owner', 'and its Owner');
select is((select s.plan_code from app.subscriptions s where s.org_id = pg_temp.id('sandbox')), 'team',
  'it runs on the Team plan');

select pg_temp.as_user('dave');
select is((select count(*)::int from app.sandbox_orgs), 0, 'nobody else reads the sandbox');
select is((select count(*)::int from app.my_sandbox()), 0, 'and dave has no sandbox of his own');

-- Nobody else gets in.
select pg_temp.as_user('nina');
select throws_ok(format($$select * from app.invite_member(%L, 'friend@example.com', %L)$$, pg_temp.id('sandbox'),
  pg_temp.system_role('admin')), 'XR001', 'sandbox_private: A sandbox is private: nobody else can be invited, join or be sent a link.',
  'nina cannot invite anyone');
select pg_temp.as_platform();
select throws_ok(format($$insert into app.memberships (org_id, person_id) values (%L, %L)$$, pg_temp.id('sandbox'), pg_temp.id('dave')),
  'XR001', 'sandbox_private: A sandbox is private: nobody else can be invited, join or be sent a link.',
  'not even the platform adds another member');

-- Never billed.
select throws_ok(format($$insert into app.stripe_subscription_links (org_id, subscription_id, stripe_customer_id, stripe_subscription_id,
    billing_interval, livemode) select %L, s.id, 'cus_Test123', 'sub_Test123', 'Monthly', false from app.subscriptions s where s.org_id = %L$$,
  pg_temp.id('sandbox'), pg_temp.id('sandbox')), 'XR001', 'sandbox_not_billable: A sandbox is never billed.',
  'no Stripe subscription is ever linked');

-- Never sends email or SMS.
insert into world select 'note', private.notify(pg_temp.id('sandbox'), pg_temp.id('nina'), 'approval.requested');
select is((select d.message_status::text from app.notification_deliveries d where d.notification_id = pg_temp.id('note') and d.channel = 'Email'),
  'Suppressed', 'an email from the sandbox is recorded Suppressed');
select is((select d.last_error from app.notification_deliveries d where d.notification_id = pg_temp.id('note') and d.channel = 'Email'),
  'Sandbox orgs send no email or text messages.', 'with the reason');
select isnt((select d.message_status::text from app.notification_deliveries d where d.notification_id = pg_temp.id('note') and d.channel = 'Push'),
  'Suppressed', 'a push to nina''s own devices still goes');
update app.notification_deliveries set message_status = 'Queued' where notification_id = pg_temp.id('note') and channel = 'Email';
select is((select d.message_status::text from app.notification_deliveries d where d.notification_id = pg_temp.id('note') and d.channel = 'Email'),
  'Suppressed', 'and it cannot be queued again');

select pg_temp.as_anon();
select throws_ok($$select * from app.open_my_sandbox()$$, '42501', null, 'anonymous visitors open no sandbox');

-- The purge.
select pg_temp.as_platform();
select throws_ok(format($$select private.purge_sandbox_org(%L)$$, pg_temp.id('org_a')), 'XR001',
  'sandbox_unknown: Only a sandbox org is purged this way.', 'the purge touches only sandboxes');
update app.sandbox_orgs set expires_at = now() - interval '1 second' where org_id = pg_temp.id('sandbox');
select is(private.purge_expired_sandboxes(), 1, 'an expired sandbox is purged');
select ok(not exists (select 1 from app.organizations o where o.id = pg_temp.id('sandbox'))
  and not exists (select 1 from app.sandbox_orgs s where s.org_id = pg_temp.id('sandbox'))
  and exists (select 1 from app.people p where p.id = pg_temp.id('nina')),
  'with every row of it, while nina herself stays');

select * from finish();
rollback;
