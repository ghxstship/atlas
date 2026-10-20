-- pgTAP: support tickets, consented diagnostics, queues by role and plan, and the ticket lifecycle
-- (A31, Section 11.16).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(41);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Opening tickets ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into k select 'org_ticket', app.open_support_ticket(pg_temp.id('org_a'), 'Organization', 'Access',
  'Cannot open the Access Grid', 'The grid page shows an error after I pick a zone.', 'Severity 3',
  '{"consent": true, "route": "/northwind/credentials/access-grid", "app_version": "4.0.0 (812)", "device": "Firefox 141 on macOS", "recent_errors": "TypeError at grid.tsx"}'::jsonb)$$,
  'a member asks their org''s admins with diagnostics');
select is((select ticket_number || ' ' || channel::text from app.support_tickets where id = (select id from k where key = 'org_ticket')),
  'SUP-0001 In App', 'an Organization ticket is numbered and answered in app');
select is((select first_response_due_at from app.support_tickets where id = (select id from k where key = 'org_ticket')), null::timestamptz,
  'the Organization queue has no platform deadline');
select is((select route from app.support_ticket_diagnostics where support_ticket_id = (select id from k where key = 'org_ticket')),
  '/northwind/credentials/access-grid', 'consented diagnostics are attached');
select throws_ok($$select app.open_support_ticket(pg_temp.id('org_a'), 'Organization', 'Problem', 'Slow page', 'The schedule loads slowly.',
  'Severity 3', '{"route": "/northwind/schedule"}'::jsonb)$$, 'XR001', null, 'diagnostics without consent are refused');
select throws_ok($$select app.open_support_ticket(pg_temp.id('org_a'), 'Platform', 'Problem', 'Slow page', 'The schedule loads slowly.')$$,
  'XR001', null, 'a member without org.help.write cannot contact platform support');
select throws_ok($$select app.open_support_ticket(pg_temp.id('org_b'), 'Organization', 'Question', 'Hello', 'A question.')$$,
  '42501', null, 'nobody opens a ticket in an org they do not belong to');
select throws_ok($$insert into app.support_tickets (membership_id, ticket_number, queue, category, subject, body, channel)
  values (pg_temp.id('dave@org_a'), 'SUP-0099', 'Organization', 'Question', 'Direct', 'Direct insert.', 'In App')$$,
  '42501', null, 'tickets are opened only through the RPC');

select pg_temp.as_user('bob');
select lives_ok($$insert into k select 'platform_ticket', app.open_support_ticket(pg_temp.id('org_a'), 'Platform', 'Problem',
  'Payroll export fails', 'The export job stops at 40 percent.', 'Severity 1')$$, 'an admin contacts platform support');
select is((select channel::text from app.support_tickets where id = (select id from k where key = 'platform_ticket')),
  'Priority Queue', 'a Team plan ticket goes to the priority queue');
select ok((select first_response_due_at > now() from app.support_tickets where id = (select id from k where key = 'platform_ticket')),
  'a Team plan ticket carries its first response deadline');
select is((select ticket_number from app.support_tickets where id = (select id from k where key = 'platform_ticket')), 'SUP-0002',
  'numbers run per org');

select pg_temp.as_user('xavier');
select throws_ok($$select app.open_support_ticket(pg_temp.id('org_b'), 'Platform', 'Question', 'Plans', 'Which plan fits us?')$$,
  'XR001', null, 'the Access plan has no platform support channel');
select lives_ok($$select app.open_support_ticket(pg_temp.id('org_b'), 'Organization', 'Question', 'Plans', 'Which plan fits us?')$$,
  'an Access plan org still uses its own Organization queue');

select pg_temp.as_user('cora');
select lives_ok($$insert into k select 'core_ticket', app.open_support_ticket(pg_temp.id('org_c'), 'Platform', 'Billing',
  'Invoice address', 'Please change the invoice address.', 'Severity 4')$$, 'a Core plan owner contacts platform support');
select is((select channel::text from app.support_tickets where id = (select id from k where key = 'core_ticket')), 'Email', 'Core answers by email');
select ok((select first_response_due_at >= created_at + interval '48 hours' from app.support_tickets where id = (select id from k where key = 'core_ticket')),
  'Core answers within two business days');

-- Reading -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.support_tickets where org_id = pg_temp.id('org_a')), 1, 'a requester reads their own tickets only');
select is((select count(*)::integer from app.support_ticket_diagnostics), 1, 'a requester reads their diagnostics');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.support_tickets) + (select count(*)::integer from app.support_ticket_diagnostics), 0,
  'another member reads nobody else''s tickets');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.support_tickets where org_id = pg_temp.id('org_a')), 2, 'an admin reads every ticket of the org');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.support_tickets where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant ticket reads');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.support_tickets$$, '42501', null, 'anon reads no tickets');

-- Immutability -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok($$update app.support_tickets set subject = 'Changed' where id = (select id from k where key = 'org_ticket')$$,
  'XR001', null, 'a ticket keeps what was asked');
select throws_ok($$update app.support_ticket_diagnostics set route = '/elsewhere'$$, 'XR001', null, 'diagnostics are append-only');
select throws_ok($$update app.support_tickets set ticket_state = 'Resolved' where id = (select id from k where key = 'org_ticket')$$,
  'XR001', null, 'the state changes only through the transition RPC');

-- Organization queue lifecycle ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_support_ticket((select id from k where key = 'org_ticket'), 'Open', 'Resolved', 'Fixed.')$$,
  'XR001', null, 'a requester cannot resolve their own ticket');
select pg_temp.as_user('gina');
select throws_ok($$select app.post_support_message((select id from k where key = 'org_ticket'), 'Me too.')$$,
  '42501', null, 'an outsider cannot write on a ticket');
select pg_temp.as_user('bob');
select app.post_support_message((select id from k where key = 'org_ticket'), 'Which zone did you pick?');
select ok((select first_responded_at is not null from app.support_tickets where id = (select id from k where key = 'org_ticket')),
  'the first responder message records the response time');
select lives_ok($$select app.transition_support_ticket((select id from k where key = 'org_ticket'), 'Open', 'Waiting', 'Asked for the zone.')$$,
  'a responder waits on the requester');
select pg_temp.as_user('dave');
select app.post_support_message((select id from k where key = 'org_ticket'), 'Zone B, backstage.');
select is((select ticket_state::text from app.support_tickets where id = (select id from k where key = 'org_ticket')), 'Open',
  'the requester''s reply hands the ticket back');
select pg_temp.as_user('bob');
select app.transition_support_ticket((select id from k where key = 'org_ticket'), 'Open', 'Resolved', 'Zone B was archived; restored it.');
select throws_ok($$select app.transition_support_ticket((select id from k where key = 'org_ticket'), 'Resolved', 'Waiting', 'Asked again.')$$,
  'XR001', 'support_ticket_transition_not_allowed: A support ticket cannot move from Resolved to Waiting.', 'a Resolved ticket does not wait on the requester');
select pg_temp.as_user('dave');
select lives_ok($$select app.transition_support_ticket((select id from k where key = 'org_ticket'), 'Resolved', 'Open', 'Still failing.')$$,
  'a requester reopens a resolved ticket');
select lives_ok($$select app.transition_support_ticket((select id from k where key = 'org_ticket'), 'Open', 'Closed', 'Works now.')$$,
  'a requester closes their ticket');
select throws_ok($$select app.post_support_message((select id from k where key = 'org_ticket'), 'One more thing.')$$,
  'XR001', null, 'a closed ticket takes no messages');
-- A responder may make any move the rules hold, so the refusal comes from the rules, not the requester guard (A54-003).
select pg_temp.as_user('bob');
select throws_ok($$select app.transition_support_ticket((select id from k where key = 'org_ticket'), 'Closed', 'Open', 'Again.')$$,
  'XR001', 'support_ticket_transition_not_allowed: A support ticket cannot move from Closed to Open.', 'a closed ticket is final');
select is((select count(*)::integer from app.support_ticket_state_transitions where support_ticket_id = (select id from k where key = 'org_ticket')), 6,
  'every state change is in the ledger');

-- Platform queue ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.transition_support_ticket((select id from k where key = 'platform_ticket'), 'Open', 'Resolved', 'Fixed.')$$,
  'XR001', null, 'only the platform team resolves a Platform ticket');
select pg_temp.as_platform();
select throws_ok($$select app.post_support_message((select id from k where key = 'org_ticket'), 'Platform here.')$$,
  'XR001', null, 'the platform team stays out of the Organization queue');
select app.post_support_message((select id from k where key = 'platform_ticket'), 'We restarted the export worker.');
select app.transition_support_ticket((select id from k where key = 'platform_ticket'), 'Open', 'Resolved', 'Export worker restarted.');
select is((select ticket_state::text || ' ' || (first_responded_at is not null)::text from app.support_tickets where id = (select id from k where key = 'platform_ticket')),
  'Resolved true', 'the platform team answers and resolves a Platform ticket');
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a') and subject_table = 'support_tickets'
  and subject_id in ((select id from k where key = 'org_ticket'), (select id from k where key = 'platform_ticket'))
  and event_type in ('support_ticket.opened', 'support_ticket.answered', 'support_ticket.resolved')), 6,
  'opening, first answers and resolutions emit domain events');

select * from finish();
rollback;
