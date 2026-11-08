-- pgTAP: a return of data the export omits holds the org's deletion (RRR-248, ADR 0167; Terms 11.2 and 11.4, DPA 10.2). The
-- operator names the org, the item places a legal hold on it while the org waits to be deleted and is read-only, the deletion
-- job holds the certificate and the purge waits, and closing the item releases the hold so the purge goes on. The item
-- outlives the org.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(25);

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'The only operator.');

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.ny(p_at timestamptz) returns timestamp
language sql stable as $$ select p_at at time zone 'America/New_York' $$;

create function pg_temp.hold() returns app.legal_holds
language sql security definer as $$
  select h.* from app.legal_holds h
  where h.id = (select i.legal_hold_id from app.legal_queue_items i where i.id = pg_temp.id('return'))
$$;

create function pg_temp.events(p_kind text) returns integer
language sql security definer as $$
  select count(*)::int from private.legal_queue_events e
  where e.legal_queue_item_id = pg_temp.id('return') and e.event_kind::text = p_kind
$$;

-- The Owner asked to delete the org eight days ago, and its recovery window has ended: it is read-only and due.
insert into app.org_deletion_requests (org_id, reason, requested_at, recover_until, requested_by)
values (pg_temp.id('org_b'), 'Closing the company.', now() - interval '8 days', now() - interval '1 hour', pg_temp.id('xavier'));
select is(private.org_read_only_reason(pg_temp.id('org_b')), 'deletion', 'the org waits to be deleted, read-only');

select pg_temp.as_op('olga');
select throws_ok($$select app.console_add_legal_queue_item('omitted_data_return', 'Payroll records', pg_temp.ny(now() - interval '2 days'))$$,
  'XR001', null, 'a return of omitted data must name the org');
select throws_ok($$select app.console_add_legal_queue_item('omitted_data_return', 'Payroll records', pg_temp.ny(now() - interval '2 days'),
  p_org_slug => 'no-such-org')$$, 'XR001', null, 'and an org that exists');
select lives_ok($$insert into world select 'return', app.console_add_legal_queue_item('omitted_data_return', 'Payroll records',
  pg_temp.ny(now() - interval '2 days'), 'Wage and tax records the export leaves out.', 'owner@harbor.test', p_org_slug => ' Harbor-Lights ')$$,
  'an operator adds it by the org''s slug while the org is read-only');
select pg_temp.as_platform();

select is((select tenant_org_id from app.legal_queue_items where id = pg_temp.id('return')), pg_temp.id('org_b'), 'the item names the org');
select is((pg_temp.hold()).org_id, pg_temp.id('org_b'), 'and placed a legal hold on it');
select is((pg_temp.hold()).table_name, null, 'over every table of the org');
select is((pg_temp.hold()).released_at, null, 'that stands');
select is(pg_temp.events('Hold Placed'), 1, 'the item''s log says so');
select is((select count(*)::int from app.legal_holds where org_id = pg_temp.id('org_b')), 1, 'only the one hold');

-- The queue's hold is the queue's: the Owner cannot release it while the return is open, and the org is still read-only
-- to every other hold write.
select pg_temp.as_user('xavier');
select throws_ok(format($$update app.legal_holds set released_at = now() where id = %L$$, (pg_temp.hold()).id),
  'XR001', 'legal_hold_queue: GHXSTSHIP placed this hold while it returns data your export left out. It is released when the return is done. To withdraw the request, write to support@ghxstship.pro with Return of Data in the subject line.',
  'the Owner cannot release the hold the queue placed');
select throws_ok(format($$insert into app.legal_holds (org_id, matter) values (%L, 'Our own hold')$$, pg_temp.id('org_b')),
  'XR001', 'org_read_only: This organization is waiting to be deleted and is read-only. The Owner can recover it in Settings, Danger zone, during the 7 days.',
  'nor place another while the org is read-only');
select pg_temp.as_platform();

-- The deletion job writes the certificate and holds it; the purge waits.
select private.schedule_deletions(now());
insert into world select 'cert', d.id from app.deletion_certificates d where d.deleted_org_id = pg_temp.id('org_b');
select isnt((select held_at from app.deletion_certificates where id = pg_temp.id('cert')), null, 'the deletion certificate is held');
select is((select count(*)::int from app.claim_deletion_certificates('test-worker', 25) where deleted_org_id = pg_temp.id('org_b')), 0,
  'the worker deletes none of its storage');
update app.deletion_certificates set storage_cleared_at = now(), locked_at = null, locked_by = null where id = pg_temp.id('cert');
select private.run_org_purges(25);
select is((select count(*)::int from app.organizations where id = pg_temp.id('org_b')), 1, 'and the purge leaves the org');

-- The return is done: closing the item releases the hold, and the purge goes on.
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'In Progress', 'Exporting the payroll tables.')$$, pg_temp.id('return')),
  'the operator starts the return');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'In Progress', 'Completed', 'Sent the payroll tables to the Owner.')$$, pg_temp.id('return')),
  'and completes it');
select pg_temp.as_platform();
select isnt((pg_temp.hold()).released_at, null, 'closing it released the hold');
select is(pg_temp.events('Hold Released'), 1, 'and the log says so');
select private.schedule_deletions(now());
select is((select held_at from app.deletion_certificates where id = pg_temp.id('cert')), null, 'the certificate is no longer held');
select private.run_org_purges(25);
select is((select count(*)::int from app.organizations where id = pg_temp.id('org_b')), 0, 'and the org is purged');
select is((select legal_hold_id from app.legal_queue_items where id = pg_temp.id('return')), null, 'the item outlives the hold');
select cmp_ok((select count(*)::int from private.legal_queue_events where legal_queue_item_id = pg_temp.id('return')), '>=', 4,
  'and keeps its log, as evidence the return was made');

-- The heartbeat's recipient check reaches the same people the operator path does: a holder with no sign-in left is no one.
select is(api_public.legal_queue_heartbeat() ->> 'recipient_ok', 'true', 'the heartbeat has someone to alert');
delete from auth.users where id = pg_temp.id('olga_user');
select is(api_public.legal_queue_heartbeat() ->> 'recipient_ok', 'false', 'and has no one once the only holder''s sign-in is deleted');

select * from finish();
rollback;
