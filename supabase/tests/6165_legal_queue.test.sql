-- pgTAP: migrations 6165 to 6167, the legal queue (RRR-248, ADR 0167). One list of legal and security work with its clock:
-- computed due dates that count business days past weekends and federal holidays, a lifecycle with a log, DMCA timing and
-- repeat infringer counts, government request counts, feeds from records the system already creates, and alerts before an
-- item is due and every day it is overdue. Only an Administrator with a second factor reaches it, and each write is logged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(195);

create function pg_temp.as_op(p_key text, p_aal text default 'aal2') returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- A time as an operator types it: local, in the zone the queue counts in.
create function pg_temp.ny(p_at timestamptz) returns timestamp
language sql stable as $$ select p_at at time zone 'America/New_York' $$;

create function pg_temp.item(p_key text) returns app.legal_queue_items
language sql security definer as $$ select i.* from app.legal_queue_items i where i.id = pg_temp.id(p_key) $$;

-- A published Public Crew listing of Northwind on prj_a, written by carol (marketplace manager).
create function pg_temp.public_listing(p_key text, p_title text) returns void
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.opportunities (project_id, role_type, role_code, title, visibility, rate_type, pay_min_minor, pay_max_minor,
    currency_code, deadline_at, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', p_title, 'Public', 'Day', 70000, 90000, 'USD', now() + interval '7 days',
    '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id into v;
  insert into world values (p_key, v);
  perform app.transition_opportunity(v, 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(v, 'Pending Approval', 'Published', 'Approved.');
  perform pg_temp.as_platform();
end $$;

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');
select pg_temp.new_user('rene', 'rene@uploader.test', 'Rene Okafor');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'First platform administrator.');
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');
select private.grant_platform_operator('tess@platform.test', 'Trust and Safety', 'Moderation.');
insert into world select 'rene', p.id from app.people p where p.id = pg_temp.id('rene_user') or p.user_id = pg_temp.id('rene_user')
on conflict do nothing;

-- Clock math -----------------------------------------------------------------------------------------------------------
select ok(not private.is_legal_business_day('2026-11-07'), 'a Saturday is no business day');
select ok(not private.is_legal_business_day('2026-11-08'), 'nor a Sunday');
select ok(private.is_legal_business_day('2026-11-09'), 'a Monday is one');
select ok(not private.is_legal_business_day('2026-11-11'), 'Veterans Day is a federal holiday');
select ok(not private.is_legal_business_day('2026-11-26'), 'Thanksgiving, the fourth Thursday');
select ok(private.is_legal_business_day('2026-11-27'), 'the day after is not');
select ok(not private.is_legal_business_day('2026-05-25'), 'Memorial Day, the last Monday of May');
select ok(not private.is_legal_business_day('2026-06-19'), 'Juneteenth');
select ok(not private.is_legal_business_day('2027-07-05'), 'a holiday on a Sunday is observed on Monday');
select ok(not private.is_legal_business_day('2027-12-24'), 'a holiday on a Saturday is observed on Friday');
select ok(not private.is_legal_business_day('2021-12-31'), 'a New Year''s Day on a Saturday is observed the year before');
select ok(not private.is_legal_business_day('2040-01-16'), 'the calendar never runs out: Martin Luther King Jr. Day of 2040');
select is(private.legal_clock_end('2026-11-06 10:00-05', 5, 'Business Days'), '2026-11-16 23:59:59-05'::timestamptz,
  'five business days from a Friday skip the weekend and Veterans Day and end with the local day');
select is(private.legal_clock_end('2026-10-30 10:00-04', 30, 'Days'), '2026-11-29 23:59:59-05'::timestamptz,
  'thirty days across the end of daylight saving end at the local day''s end');
select is(private.legal_clock_end('2026-11-06 10:00-05', 48, 'Hours'), '2026-11-08 10:00-05'::timestamptz,
  'hours count from the instant');
select is(private.legal_clock_end('2026-11-07 10:00-05', 1, 'Business Days'), '2026-11-09 23:59:59-05'::timestamptz,
  'a matter received on a Saturday starts its count on Monday');

select is(private.legal_clock_end('2027-02-01 12:00-05', 1, 'Months Or 30 Days'), '2027-03-01 23:59:59-05'::timestamptz,
  'a request in February runs for its month, two days shorter than 30 days');
select is(private.legal_clock_end('2027-01-15 12:00-05', 1, 'Months Or 30 Days'), '2027-02-14 23:59:59-05'::timestamptz,
  'in a 31-day month it runs for 30 days, shorter than the month');
select is(private.legal_clock_end('2027-01-31 12:00-05', 1, 'Months Or 30 Days'), '2027-02-28 23:59:59-05'::timestamptz,
  'and a month from the 31st ends with February');
select is((select due_amount::text || ' ' || due_unit::text from private.legal_queue_rules where code = 'dsar_privacy'), '1 Months Or 30 Days',
  'a GHXSTSHIP data subject request uses that clock, as Privacy Policy 7 says');
select is((select count(*)::int from generate_series('2027-01-01 12:00-05'::timestamptz, '2031-12-31 12:00-05'::timestamptz, interval '1 day') d
  where private.legal_clock_end(private.legal_clock_end(d, 1, 'Months Or 30 Days'), 59, 'Days')
    > (((d at time zone 'America/New_York')::date + interval '3 months' + interval '1 day')::timestamp at time zone 'America/New_York')), 0,
  'on every day across a leap year, the first period and its extension stay inside three months');
select is(private.legal_local_instant('2026-10-30 23:30'), '2026-10-30 23:30-04'::timestamptz, 'a time typed before the autumn change keeps its own offset');
select is(private.legal_local_instant('2026-12-15 09:00'), '2026-12-15 09:00-05'::timestamptz, 'and one after it its own');
select is(private.legal_local_instant('2026-11-01 01:30'), '2026-11-01 01:30-04'::timestamptz, 'the hour the autumn change repeats reads as the earlier, so no clock ends late');
select is(private.legal_local_instant('2027-03-14 02:30'), '2027-03-14 03:30-04'::timestamptz, 'and the hour the spring change skips moves forward');
select is(private.legal_local_instant(null), null, 'nothing typed is nothing');

-- Who may ------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select throws_ok($$select app.console_legal_queue()$$, '42501', null, 'Support holds no legal queue');
select pg_temp.as_op('tess');
select throws_ok($$select app.console_legal_queue()$$, '42501', null, 'nor does Trust and Safety: a queue can hold a government request');
select throws_ok($$select app.console_add_legal_queue_item('security_report', 'Bug.', pg_temp.ny(now()))$$, '42501', null, 'nor write to it');
select is(app.console_legal_queue_overdue(), 0, 'and the banner stays quiet for them');
select pg_temp.as_user('alice');
select throws_ok($$select app.console_legal_queue()$$, '42501', null, 'an org Owner holds none');
select throws_ok($$select count(*) from app.legal_queue_items$$, '42501', null, 'and no one reads the table directly');
select pg_temp.as_op('olga', 'aal1');
select throws_ok($$select app.console_legal_queue()$$, 'XR001', null, 'an Administrator needs a second factor (step_up_required)');

-- Adding by hand -------------------------------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select throws_ok($$select app.console_add_legal_queue_item('nonsense', 'x', pg_temp.ny(now()))$$, 'XR001',
  'legal_queue_rule: Choose what this item is.', 'an unknown rule is refused');
select throws_ok($$select app.console_add_legal_queue_item('moderation_appeal', 'x', pg_temp.ny(now()))$$, 'XR001',
  'legal_queue_rule: Choose what this item is.', 'and a rule only the feed uses');
select throws_ok($$select app.console_add_legal_queue_item('security_report', ' ', pg_temp.ny(now()))$$, 'XR001', null, 'a title is needed');
select throws_ok($$select app.console_add_legal_queue_item('security_report', 'x', pg_temp.ny(now() + interval '1 day'))$$, 'XR001',
  'legal_queue_received: Say when it arrived. That cannot be in the future.', 'a matter cannot arrive tomorrow');
select lives_ok($$insert into world select 'sec', app.console_add_legal_queue_item('security_report', 'XSS in the docs search',
  '2026-11-06 10:00', 'Reported with a proof of concept.', 'researcher@example.test')$$, 'an operator adds a security report');
select is((select first_response_due_at from pg_temp.item('sec')), '2026-11-12 23:59:59-05'::timestamptz,
  'three business days to acknowledge, past Veterans Day, from when it arrived');
select is((select due_at from pg_temp.item('sec')), '2026-11-23 23:59:59-05'::timestamptz, 'ten to share a plan');
select ok((select reference ~ '^LQ-2026-[0-9]{5}$' from pg_temp.item('sec')), 'it gets a reference with no personal data');
select is((select count(*)::int from app.platform_operator_actions where action = 'legal_queue.added' and subject_id = pg_temp.id('sec')), 1,
  'the addition is in the console ledger');
select pg_temp.as_platform();
select is((select event_kind::text from private.legal_queue_events where legal_queue_item_id = pg_temp.id('sec')), 'Received', 'and starts the item''s log');

-- The lifecycle ----------------------------------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_record_legal_first_response(%L, 'Acknowledged by email.')$$, pg_temp.id('sec')),
  'the first response stops that clock');
select ok((select first_response_at is not null from pg_temp.item('sec')), 'it is stamped');
select throws_ok(format($$select app.console_record_legal_first_response(%L, 'Again.')$$, pg_temp.id('sec')), 'XR001',
  'legal_queue_first_response: This item has no first response waiting.', 'once');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'In Progress', ' ')$$, pg_temp.id('sec')), 'XR001',
  'transition_reason_required: Every state change carries a reason.', 'a move carries a reason');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Waiting', 'In Progress', 'Stale.')$$, pg_temp.id('sec')), 'XR001',
  'legal_queue_item_state_conflict: The item is not Waiting any more.', 'and compares and sets the state');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Waiting', 'Asked the researcher for the browser.')$$, pg_temp.id('sec')),
  'it waits on the reporter');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Waiting', 'Completed', 'Plan sent, fix released.')$$, pg_temp.id('sec')),
  'and completes');
select ok((select closed_at is not null from pg_temp.item('sec')), 'closing stamps it');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Completed', 'In Progress', 'Reopen.')$$, pg_temp.id('sec')), 'XR001',
  'legal_queue_item_transition_not_allowed: A legal queue item cannot move from Completed to In Progress.', 'closed is closed');
select lives_ok(format($$select app.console_note_legal_queue_item(%L, 'Credited in the release notes.')$$, pg_temp.id('sec')),
  'a closed item still takes a note');
select pg_temp.as_platform();
select is((select array_agg(event_kind::text order by created_at, id) from private.legal_queue_events where legal_queue_item_id = pg_temp.id('sec')),
  array['Received', 'First Response', 'State Changed', 'State Changed', 'Note'], 'the log says what was done, in order');
select throws_ok(format($$update private.legal_queue_events set note = 'Rewritten.' where legal_queue_item_id = %L$$, pg_temp.id('sec')), 'XR001', null,
  'and the log is append-only');

-- A clock with an extension ----------------------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select lives_ok($$insert into world select 'dsar', app.console_add_legal_queue_item('dsar_privacy', 'Access request by email', pg_temp.ny(now()))$$,
  'a data subject request by email');
select throws_ok(format($$select app.console_extend_legal_queue_item(%L, ' ')$$, pg_temp.id('dsar')), 'XR001', null, 'an extension needs a reason');
select lives_ok(format($$select app.console_extend_legal_queue_item(%L, 'The request covers three organizations.')$$, pg_temp.id('dsar')),
  'its clock extends once');
select is((select extract(day from due_at at time zone 'America/New_York' - date_trunc('day', received_at at time zone 'America/New_York'))::int <= 89 from pg_temp.item('dsar')), true,
  'to no more than 89 days');
select throws_ok(format($$select app.console_extend_legal_queue_item(%L, 'Again.')$$, pg_temp.id('dsar')), 'XR001',
  'legal_queue_extended: This item can no longer be extended.', 'and only once');
select throws_ok(format($$select app.console_extend_legal_queue_item(%L, 'No.')$$, pg_temp.id('sec')), 'XR001',
  'legal_queue_no_extension: This clock has no extension.', 'a rule without one refuses');
select lives_ok($$insert into world select 'dsar_late', app.console_add_legal_queue_item('dsar_privacy', 'Access request found late', pg_temp.ny(now() - interval '40 days'))$$,
  'a request found after its first period');
select throws_ok(format($$select app.console_extend_legal_queue_item(%L, 'Too late.')$$, pg_temp.id('dsar_late')), 'XR001',
  'legal_queue_extension_late: An extension must be taken, and the person told, before the first period ends.', 'cannot be extended any more');

-- DMCA --------------------------------------------------------------------------------------------------------------------
select throws_ok($$select app.console_add_legal_queue_item('dmca_notice', 'Photo', pg_temp.ny(now()), null, null, 'nobody@nowhere.test')$$, 'XR001', null,
  'a notice can only name an account that exists');
select lives_ok($$insert into world select 'dmca_1', app.console_add_legal_queue_item('dmca_notice', 'Portfolio photo one', pg_temp.ny(now() - interval '60 days'),
  null, 'agent@studio.test', 'rene@uploader.test')$$, 'a notice names the account');
select lives_ok($$insert into world select 'dmca_2', app.console_add_legal_queue_item('dmca_notice', 'Portfolio photo two', pg_temp.ny(now() - interval '50 days'),
  null, 'agent@studio.test', 'rene@uploader.test')$$, 'a second');
select lives_ok($$insert into world select 'dmca_3', app.console_add_legal_queue_item('dmca_notice', 'Portfolio photo three', pg_temp.ny(now() - interval '40 days'),
  null, 'agent@studio.test', 'rene@uploader.test')$$, 'a third');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Valid; removed; uploader told.')$$, pg_temp.id('dmca_1')), 'the first is valid');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Valid; removed; uploader told.')$$, pg_temp.id('dmca_2')), 'so is the second');
select is((app.console_legal_queue() #>> '{repeat_infringers,0,counted}')::int, 2, 'two valid notices count');
select is((app.console_legal_queue() #>> '{repeat_infringers,0,threshold_met}')::boolean, false, 'which is not more than two');

select throws_ok($$select app.console_add_legal_queue_item('dmca_counter_notice', 'Mistake', pg_temp.ny(now()), null, null, null, 'LQ-2000-00001')$$, 'XR001',
  'legal_queue_related: Name the reference of the DMCA notice this answers.', 'a counter-notice names its notice');
select lives_ok(format($$insert into world select 'counter', app.console_add_legal_queue_item('dmca_counter_notice', 'Says it is licensed', pg_temp.ny(now()), null, null, null, %L)$$,
  (select reference from pg_temp.item('dmca_2'))), 'a counter-notice answers the second');
select is((app.console_legal_queue() #>> '{repeat_infringers,0,counted}')::int, 1, 'and an answered notice stops counting while the counter-notice is open');
select pg_temp.as_platform();
select is((select first_response_due_at from pg_temp.item('counter')),
  private.legal_clock_end((select received_at from pg_temp.item('counter')), 1, 'Business Days'), 'the notifier gets a copy promptly');
select is((select earliest_action_at from pg_temp.item('counter')),
  private.legal_clock_end((select received_at from pg_temp.item('counter')), 10, 'Business Days'), 'restoration waits until the tenth business day');
select is((select due_at from pg_temp.item('counter')),
  private.legal_clock_end((select received_at from pg_temp.item('counter')), 14, 'Business Days'), 'and must come by the fourteenth');
select pg_temp.as_op('olga');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Restored.')$$, pg_temp.id('counter')), 'XR001',
  'legal_queue_too_early: The statute does not allow this before its earliest day. Wait for it, or record the court action.',
  'material cannot go back early');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Waiting', 'Court.', true)$$, pg_temp.id('counter')), 'XR001',
  'legal_queue_court_action: A court action applies only when completing a DMCA counter-notice.', 'a court action fits only the completion');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Notifier filed suit; the material stays down.', true)$$, pg_temp.id('counter')),
  'unless the notifier files a court action');
select is((app.console_legal_queue() #>> '{repeat_infringers,0,counted}')::int, 2, 'and then the notice counts again');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Valid; removed; uploader told.')$$, pg_temp.id('dmca_3')),
  'a third valid notice in twelve months');
select is((app.console_legal_queue() #>> '{repeat_infringers,0,threshold_met}')::boolean, true, 'passes the threshold');
select pg_temp.as_platform();
select is((select count(*)::int from app.legal_queue_items where rule_code = 'repeat_infringer_review' and subject_person_id = (select subject_person_id from pg_temp.item('dmca_1'))), 1,
  'and opens a review for a person to decide');
select is((select count(*)::int from app.people p where p.id = (select subject_person_id from pg_temp.item('dmca_1')) and p.deleted_at is null), 1,
  'nothing ends the account by itself');

-- Government requests -----------------------------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select throws_ok($$select app.console_add_legal_queue_item('government_request', 'Subpoena', pg_temp.ny(now()))$$, 'XR001',
  'legal_queue_due: Enter the date the document sets, after the day it arrived.', 'the due date comes from the document');
select lives_ok($$insert into world select 'gov', app.console_add_legal_queue_item('government_request', 'Subpoena', '2026-03-02 10:00',
  null, null, null, null, '2026-03-20 17:00')$$, 'it is entered from the document');
select is((select due_at from pg_temp.item('gov')), '2026-03-20 17:00-04'::timestamptz, 'and stands as entered, across the daylight saving change after it arrived');
select is((select received_at from pg_temp.item('gov')), '2026-03-02 10:00-05'::timestamptz, 'each time takes the offset of its own day');
select lives_ok($$insert into world select 'gov_mistake', app.console_add_legal_queue_item('government_request', 'Filed by mistake', '2026-04-02 10:00',
  null, null, null, null, '2026-05-20 17:00')$$, 'a request entered by mistake');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Withdrawn', 'Not a government request.')$$, pg_temp.id('gov_mistake')), 'is withdrawn');
select is((select e ->> 'received' from jsonb_array_elements(app.console_legal_queue() -> 'government_requests') e where (e ->> 'year')::int = 2026), '1',
  'the queue counts requests per calendar year, for the yearly publication the DPA promises, and a withdrawn mistake is not one');

-- Feeds ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'public');
select pg_temp.public_listing('opp_feed', 'Summer Series Riggers');
select pg_temp.as_user('ivy');
insert into app.listing_reports (opportunity_id, reason, details) values (pg_temp.id('opp_feed'), 'Fraud', 'Asks for a fee to apply.');
select pg_temp.as_platform();
insert into app.dsar_requests (org_id, subject_person_id, subject_email, request_type, details)
values (pg_temp.id('org_a'), pg_temp.id('dave'), 'dave@example.test', 'Erasure', 'Please erase my medical notes.');
insert into world select 'dsar_row', id from app.dsar_requests where subject_email = 'dave@example.test' and details like 'Please erase%';
insert into app.dsar_requests (org_id, subject_person_id, subject_email, request_type)
values (pg_temp.id('org_a'), pg_temp.id('dave'), 'dave@example.test', 'Access');
insert into world select 'dsar_closed', id from app.dsar_requests where subject_email = 'dave@example.test' and details is null;
select private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions', 'dsar_request_id',
  pg_temp.id('dsar_closed'), 'Received', 'In Progress', 'Working.');
select private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions', 'dsar_request_id',
  pg_temp.id('dsar_closed'), 'In Progress', 'Completed', 'Done before the queue read it.');
select is(private.sync_legal_queue_feeds() >= 2, true, 'the feed opens items for open records');
select is(private.sync_legal_queue_feeds(), 0, 'and is idempotent');
insert into world select 'fed_report', id from app.legal_queue_items where source_table = 'app.listing_reports'
  and source_id = (select id from app.listing_reports where opportunity_id = pg_temp.id('opp_feed'));
insert into world select 'fed_dsar', id from app.legal_queue_items where source_id = pg_temp.id('dsar_row');
select is((select count(*)::int from app.legal_queue_items where source_id = pg_temp.id('dsar_closed')), 0,
  'a request already closed, as an account deletion writes it, opens nothing');
select is((select row(title, details, requester_contact, subject_person_id)::text from pg_temp.item('fed_dsar')), '(Erasure,,,)',
  'a Customer''s register feeds the kind of request and never the person or their words');
select is((select tenant_org_id from pg_temp.item('fed_dsar')), pg_temp.id('org_a'), 'and says which org');
select ok(not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = 'app.legal_queue_items'::regclass and a.attname = 'org_id'),
  'an item is the platform''s record, so the org purge (1351), which takes every org_id row, leaves it');
select is((select k.confdeltype::text from pg_catalog.pg_constraint k where k.conrelid = 'app.legal_queue_items'::regclass
           and k.confrelid = 'app.organizations'::regclass), 'n', 'and deleting the org only clears the link, so it never blocks the purge');
select pg_temp.as_op('olga');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'No.')$$, pg_temp.id('fed_dsar')), 'XR001',
  'legal_queue_fed: This item follows its source. Act on the source, and it follows.', 'a fed item follows its source');
select pg_temp.as_platform();
select private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions', 'dsar_request_id',
  pg_temp.id('dsar_row'), 'Received', 'In Progress', 'Working.');
select private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions', 'dsar_request_id',
  pg_temp.id('dsar_row'), 'In Progress', 'Extended', 'Needs more time.');
select private.sync_legal_queue_feeds();
select is((select item_state::text from pg_temp.item('fed_dsar')), 'In Progress', 'it follows the register''s state');
select ok((select due_at > received_at + interval '89 days' from pg_temp.item('fed_dsar')), 'and the register''s extension');
select pg_temp.as_op('tess');
select app.console_decide_listing(pg_temp.id('opp_feed'), 'No Action', 'No Violation', 'Terms 7.6', 'The fee is not charged.', 'We found no violation.');
select pg_temp.as_platform();
select private.sync_legal_queue_feeds();
select is((select item_state::text from pg_temp.item('fed_report')), 'Completed', 'a decision closes the report''s item');

-- Appeals that arrive by email ---------------------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select lives_ok($$insert into world select 'hand_appeal', app.console_add_legal_queue_item('abuse_appeal', 'Account suspension appeal', pg_temp.ny(now()), 'Says the suspension was a mistake.', 'appellant@example.test')$$,
  'an appeal of an account suspension, which has no listing, is added by hand');
select is((select due_at from pg_temp.item('hand_appeal')), private.legal_clock_end((select received_at from pg_temp.item('hand_appeal')), 30, 'Days'), 'and its rule computes the clock');
select is((app.console_legal_queue_item(pg_temp.id('hand_appeal')) ->> 're_review_required')::boolean, true, 'the console knows closing it needs a re-review');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'In Progress', 'Reading the file.')$$, pg_temp.id('hand_appeal')),
  'working on it needs no re-review yet');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'In Progress', 'Completed', 'Upheld.')$$, pg_temp.id('hand_appeal')), 'XR001',
  'legal_queue_re_review: Record what you looked at again and how you weighed the grounds, in up to 4,000 characters.', 'closing it does');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'In Progress', 'Refused', 'Out of time.', false, 'Read the dates.')$$, pg_temp.id('hand_appeal')), 'XR001',
  'legal_queue_person_told: Say how and when you told the person the result and the reasons, in up to 1,000 characters.', 'and so does telling the person');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'In Progress', 'Completed', 'Upheld: the suspension stands.', false,
  'Read the appeal and the logs again.', 'Emailed the result and reasons on the same day, and said the same person reviewed it.', true)$$, pg_temp.id('hand_appeal')), 'with both it closes');
select is((select re_review_same_person from pg_temp.item('hand_appeal')), true, 'the record says the first decider did it');
select pg_temp.as_platform();
select is((select array_agg(note order by created_at, id) filter (where event_kind in ('Re-Review', 'Person Told'))
  from private.legal_queue_events where legal_queue_item_id = pg_temp.id('hand_appeal')),
  array['Read the appeal and the logs again.', 'Emailed the result and reasons on the same day, and said the same person reviewed it.'], 'and the log holds the re-review and how they were told');
select pg_temp.as_op('olga');
select lives_ok($$insert into world select 'hand_appeal_2', app.console_add_legal_queue_item('abuse_appeal', 'Withdrawn appeal', pg_temp.ny(now()))$$, 'another appeal');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Withdrawn', 'They withdrew it.')$$, pg_temp.id('hand_appeal_2')), 'a withdrawn appeal needs neither');
select lives_ok($$insert into world select 'dsar_appeal', app.console_add_legal_queue_item('dsar_appeal', 'Appeal of a refused request', pg_temp.ny(now()))$$, 'an appeal of a refused data request');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Upheld.')$$, pg_temp.id('dsar_appeal')), 'XR001',
  'legal_queue_re_review: Record what you looked at again and how you weighed the grounds, in up to 4,000 characters.', 'keeps the same promise');
select lives_ok($$insert into world select 'a11y_review', app.console_add_legal_queue_item('accessibility_review', 'Asks for a review', pg_temp.ny(now()))$$, 'as does an accessibility review request');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Answered.')$$, pg_temp.id('a11y_review')), 'XR001',
  'legal_queue_re_review: Record what you looked at again and how you weighed the grounds, in up to 4,000 characters.', 'which Accessibility Statement 6 promises');
select throws_ok($$select app.console_add_legal_queue_item('undelivered_notice', 'x', pg_temp.ny(now()))$$, 'XR001', 'legal_queue_rule: Choose what this item is.', 'an undelivered notice is only fed');

-- The queue's activity in the console ledger, which every operator role reads -----------------------------------------------
select pg_temp.as_op('omar');
select cmp_ok((select count(*)::int from app.platform_operator_actions where action like 'legal\_%' or action like 'outside\_reviewer%'), '>', 0,
  'Support sees that queue actions happened');
select is((select count(*)::int from app.platform_operator_actions where (action like 'legal\_%' or action like 'outside\_reviewer%') and (reason is not null or details <> '{}'::jsonb)), 0,
  'and reading the table directly shows no rule, reason or date for any of them');
select is((select count(*)::int from app.console_action_log(null, 500) a where (a.action like 'legal\_%' or a.action like 'outside\_reviewer%') and (a.reason is not null or a.details <> '{}'::jsonb)), 0,
  'nor does the Activity page''s read');
select is((select count(*)::int from app.platform_operator_actions a where a.reason ~ 'Notifier filed suit|Plan sent|covers three organizations' or a.details::text ~ 'government_request|dmca'), 0,
  'not the words an Administrator wrote about a matter, and not which rule it fell under');
select pg_temp.as_op('tess');
select is((select count(*)::int from app.platform_operator_actions where action like 'legal\_%' and (reason is not null or details <> '{}'::jsonb)), 0, 'and neither does Trust and Safety');

-- A Customer's clock is kept apart from GHXSTSHIP's own work --------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.dsar_requests (org_id, subject_person_id, subject_email, request_type)
values (pg_temp.id('org_a'), pg_temp.id('dave'), 'dave@example.test', 'Portability');
select private.sync_legal_queue_feeds();
insert into world select 'watched', id from app.legal_queue_items where source_table = 'app.dsar_requests' and title = 'Portability';
select pg_temp.as_op('olga');
select is((select count(*)::int from jsonb_array_elements(app.console_legal_queue() -> 'items') e where e ->> 'id' = pg_temp.id('watched')::text), 0, 'a watched clock is not in the work list');
select is((select count(*)::int from jsonb_array_elements(app.console_legal_queue() -> 'watched') e where e ->> 'id' = pg_temp.id('watched')::text), 1, 'it has its own');
select is((select count(*)::int from jsonb_array_elements(app.console_legal_queue(false) -> 'watched')), 0, 'and the closed view has no second list');
select is((select jsonb_agg(e ->> 'reference' order by ord) = jsonb_agg(e ->> 'reference' order by e ->> 'next_clock_at', ord)
  from jsonb_array_elements(app.console_legal_queue() -> 'items') with ordinality as x (e, ord)), true, 'the work list runs by the clock that comes next');
select pg_temp.as_platform();
select is((select title from pg_temp.item('watched')), 'Portability', 'a fed item stores a code');
select is(private.legal_queue_item_json(pg_temp.item('watched'), now()) ->> 'live_title', null, 'and no listing title');

-- Racing a feed, and a feed that fails ----------------------------------------------------------------------------------------
select is(private.open_legal_queue_item('dsar_customer_register', 'Portability', now(), p_source_table => 'app.dsar_requests',
  p_source_id => (select source_id from pg_temp.item('watched'))), null, 'a second open for the same record, as when a console read races the sweep, answers null and raises nothing');
select lives_ok($$insert into world select 'hand_for_failure', private.open_legal_queue_item('accessibility_report', 'Reached despite a failure', now())$$, 'a hand-entered item');
alter table app.listing_reports rename column reported_at to reported_at_broken;
select is(private.sync_legal_queue_feeds() >= 0, true, 'a feed that fails raises nothing out of the sync');
select is((select count(*)::int from app.legal_queue_items where rule_code = 'queue_feed_failure' and title = 'listing_reports' and closed_at is null), 1, 'it opens an item of its own');
select ok((select details ~ 'reported_at' from app.legal_queue_items where rule_code = 'queue_feed_failure' and title = 'listing_reports' and closed_at is null), 'that names the error');
select is(private.sync_legal_queue_feeds() >= 0, true, 'and running again');
select is((select count(*)::int from app.legal_queue_items where rule_code = 'queue_feed_failure' and title = 'listing_reports' and closed_at is null), 1, 'keeps one open');
delete from private.platform_emails where template = 'legal_clock_alert';
select ok(private.sweep_legal_queue(now() + interval '3 days') >= 1, 'the sweep still raises alerts');
select ok((select bool_or(args -> 'items' @> jsonb_build_array(jsonb_build_object('reference', (select reference from pg_temp.item('hand_for_failure'))))) from private.platform_emails where template = 'legal_clock_alert'),
  'on the hand-entered item as well');
select ok((select bool_or(args -> 'items' @> '[{"matter": "Queue Failure"}]'::jsonb) from private.platform_emails where template = 'legal_clock_alert'), 'and the failure itself reaches the owner');
select is(api_public.legal_queue_heartbeat() ->> 'feeds_ok', 'false', 'and the outside heartbeat says the feeds are not clean');
select is(api_public.legal_queue_heartbeat() ->> 'sweep_ok', 'true', 'while the sweep did run');
alter table app.listing_reports rename column reported_at_broken to reported_at;
select private.sync_legal_queue_feeds();
select is((select count(*)::int from app.legal_queue_items where rule_code = 'queue_feed_failure' and title = 'listing_reports' and closed_at is null), 0, 'the item closes when the feed works again');
select is(api_public.legal_queue_heartbeat() ->> 'feeds_ok', 'true', 'and the heartbeat clears');
select pg_temp.as_anon();
select is((select array_agg(k order by k) from jsonb_object_keys(api_public.legal_queue_heartbeat()) k), array['email_ok', 'feeds_ok', 'recipient_ok', 'sweep_ok'],
  'anyone may ask the heartbeat, and it answers four booleans about the machinery and nothing about a matter');
select pg_temp.as_platform();
update private.legal_queue_health set last_sweep_at = now() - interval '3 hours';
select is(api_public.legal_queue_heartbeat() ->> 'sweep_ok', 'false', 'a sweep that stopped shows in the heartbeat');
select pg_temp.as_op('olga');
select is(app.console_legal_queue() #>> '{delivery,sweep_stale}', 'true', 'and on the queue page');
select pg_temp.as_platform();
update private.legal_queue_health set last_sweep_at = now();
select lives_ok($$insert into private.platform_emails (template, to_email, locale, args) values ('legal_clock_alert', 'stuck@example.test', 'en-US', '{}')$$, 'an alert email waiting');
update private.platform_emails set created_at = now() - interval '2 hours' where to_email = 'stuck@example.test';
select is(api_public.legal_queue_heartbeat() ->> 'email_ok', 'false', 'stuck for over an hour fails the heartbeat');
delete from private.platform_emails where to_email = 'stuck@example.test';

-- Alerts -------------------------------------------------------------------------------------------------------------------
-- Every open item from above is cleared to see one clock at a time, and the sweep's own clock is passed in.
select pg_temp.as_platform();
update app.legal_queue_items set item_state = 'Withdrawn', closed_at = now() where closed_at is null;
delete from private.platform_emails where template = 'legal_clock_alert';
select pg_temp.as_op('olga');
select lives_ok($$insert into world select 'alert', app.console_add_legal_queue_item('accessibility_report', 'Screen reader skips the form',
  '2026-11-06 10:00')$$, 'an accessibility report, five business days');
select pg_temp.as_platform();
select is((select due_at from pg_temp.item('alert')), '2026-11-16 23:59:59-05'::timestamptz, 'due the Monday after next');
select is(private.sweep_legal_queue('2026-11-09 10:00-05'), 0, 'a week out, no alert');
select is(private.sweep_legal_queue('2026-11-14 23:59:59-05'), 1, 'two days out, an alert');
select is((select row(alert_clock, alert_overdue, note)::text from private.legal_queue_events where legal_queue_item_id = pg_temp.id('alert') and event_kind = 'Alert Sent'), '(Due,f,)',
  'the log stores codes the console words in the operator''s language, not English text');
select is(private.sweep_legal_queue('2026-11-15 00:30-05'), 0, 'once');
select is((select count(*)::int from private.platform_emails where template = 'legal_clock_alert'), 1, 'one email, to the one operator holding legal.queue');
select is((select to_email from private.platform_emails where template = 'legal_clock_alert'), 'olga@platform.test', 'the Administrator');
select is(private.sweep_legal_queue('2026-11-16 01:00-05'), 1, 'one day out, another');
select is(private.sweep_legal_queue('2026-11-17 01:00-05'), 1, 'overdue, another');
select is(private.sweep_legal_queue('2026-11-17 02:00-05'), 0, 'not hourly');
select is(private.sweep_legal_queue('2026-11-18 01:00-05'), 1, 'but every day it stays overdue');
select is((select count(*)::int from private.legal_queue_events where legal_queue_item_id = pg_temp.id('alert') and event_kind = 'Alert Sent'), 4,
  'each alert is logged on the item');
update app.legal_queue_items set due_at = now() - interval '1 day', received_at = now() - interval '9 days' where id = pg_temp.id('alert');
select pg_temp.as_op('olga');
select is(app.console_legal_queue_overdue(), 1, 'the console''s banner counts it');
select lives_ok($$select app.console_add_legal_alert_contact('Backup Person', 'Backup@Example.test')$$, 'a backup contact is added');
select throws_ok($$select app.console_add_legal_alert_contact('Again', 'backup@example.test')$$, 'XR001', null, 'once');
select pg_temp.as_platform();
select vault.create_secret('https://hooks.example.test/oncall', 'xos_alert_webhook_url');
select lives_ok($$insert into world select 'gone_contact', app.console_add_legal_alert_contact('Former Backup', 'former@example.test')$$, 'a second contact');
select lives_ok(format($$select app.console_remove_legal_alert_contact(%L)$$, pg_temp.id('gone_contact')), 'who is removed');
select throws_ok(format($$select app.console_remove_legal_alert_contact(%L)$$, pg_temp.id('gone_contact')), 'XR001',
  'legal_contact_missing: That contact was already removed. Reload the page.', 'once');
select pg_temp.as_platform();
select is(private.sweep_legal_queue('2026-11-19 01:00-05'), 1, 'the next day''s overdue alert');
select ok((select args ->> 'audience' = 'backup' and not (args -> 'items' -> 0 ? 'matter') and args -> 'items' -> 0 ->> 'reference' = (select reference from pg_temp.item('alert'))
  from private.platform_emails where template = 'legal_clock_alert' and to_email = 'backup@example.test'),
  'reaches the backup contact, with the reference and never the matter');
select is((select count(*)::int from private.platform_emails where to_email = 'former@example.test'), 0, 'and not the contact who was removed');
select ok((select args -> 'items' -> 0 ->> 'matter' = 'Accessibility Complaint' from private.platform_emails
  where template = 'legal_clock_alert' and to_email = 'olga@platform.test' order by created_at desc, id desc limit 1), 'the operator''s names the matter');
select ok((select convert_from(r.body, 'UTF8') like '%' || (select reference from pg_temp.item('alert')) || '%' and convert_from(r.body, 'UTF8') not like '%Screen reader%'
  from net.http_request_queue r where r.url = 'https://hooks.example.test/oncall' order by r.id desc limit 1),
  'and the on-call channel gets the reference and nothing else about it');
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Replied; fix scheduled.')$$, pg_temp.id('alert')), 'a reply closes it');
select pg_temp.as_platform();
select is(private.sweep_legal_queue('2026-11-20 01:00-05'), 0, 'and the alerts stop');

-- A Customer's own clock alerts once, by email only.
insert into app.dsar_requests (org_id, subject_person_id, subject_email, request_type)
values (pg_temp.id('org_a'), pg_temp.id('dave'), 'dave@example.test', 'Objection');
select private.sync_legal_queue_feeds();
insert into world select 'watch', id from app.legal_queue_items where source_table = 'app.dsar_requests' and title = 'Objection';
select is(private.sweep_legal_queue(now() + interval '10 days'), 0, 'a Customer''s clock has no lead alerts');
select is(private.sweep_legal_queue(now() + interval '40 days'), 1, 'it alerts when overdue');
select is(private.sweep_legal_queue(now() + interval '41 days'), 0, 'once');

-- Retention ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(to_regclass('app.legal_queue_events'), null, 'the log has no age of its own in the retention schedule');
select is((select count(*)::int from private.retention_policies where table_name = 'app.legal_queue_items' and retention = interval '5 years' and time_column = 'closed_at'), 1,
  'an item is kept 5 years after it closes');
select lives_ok($$insert into world select 'old_closed', private.open_legal_queue_item('security_report', 'Long closed', now() - interval '6 years')$$, 'an item closed years ago');
update app.legal_queue_items set item_state = 'Completed', closed_at = now() - interval '5 years 1 day', created_at = now() - interval '6 years' where id = pg_temp.id('old_closed');
select lives_ok($$insert into world select 'just_closed', private.open_legal_queue_item('security_report', 'Closed lately', now() - interval '6 years')$$, 'one closed lately');
update app.legal_queue_items set item_state = 'Completed', closed_at = now() - interval '4 years' where id = pg_temp.id('just_closed');
select lives_ok($$insert into world select 'old_open', private.open_legal_queue_item('security_report', 'Open for years', now() - interval '6 years')$$, 'and one open for years');
select cmp_ok(private.purge_table('app.legal_queue_items'), '>=', 1::bigint, 'the purge runs');
select is((select count(*)::int from app.legal_queue_items where id = pg_temp.id('old_closed')), 0, 'the item past 5 years goes');
select is((select count(*)::int from private.legal_queue_events where legal_queue_item_id = pg_temp.id('old_closed')), 0, 'its whole log goes with it, the same day');
select is((select count(*)::int from private.legal_queue_events where legal_queue_item_id = pg_temp.id('just_closed')), 1, 'an item within 5 years keeps its log');
select is((select count(*)::int from app.legal_queue_items where id = pg_temp.id('old_open')), 1, 'an open item never expires');
select is((select count(*)::int from private.legal_queue_events where legal_queue_item_id = pg_temp.id('old_open')), 1, 'and its log stays whole, however old');

select lives_ok($$insert into private.legal_alert_contacts (contact_name, email, added_by, removed_at, removed_by)
  values ('Old Backup', 'old@example.test', pg_temp.id('olga'), now() - interval '13 months', pg_temp.id('olga')),
         ('Recent Backup', 'recent@example.test', pg_temp.id('olga'), now() - interval '11 months', pg_temp.id('olga'))$$, 'two removed backup contacts');
select lives_ok($$insert into private.legal_outside_reviewers (reviewer_name, email, reason, appointed_by, ended_at, ended_by, end_reason)
  values ('Old Reviewer', 'oldreview@example.test', 'Appeals.', pg_temp.id('olga'), now() - interval '8 years', pg_temp.id('olga'), 'Ended.')$$, 'a reviewer whose appointment ended long ago');
select cmp_ok(private.purge_legal_queue_people(), '>=', 2, 'the sweep''s cleanup runs');
select is((select count(*)::int from private.legal_alert_contacts where email = 'old@example.test'), 0, 'a contact removed over a year ago goes');
select is((select count(*)::int from private.legal_alert_contacts where email = 'recent@example.test'), 1, 'one removed within the year stays');
select is((select count(*)::int from private.legal_outside_reviewers where email = 'oldreview@example.test'), 0, 'and so does an appointment past 7 years that no decision names');

select * from finish();
rollback;
