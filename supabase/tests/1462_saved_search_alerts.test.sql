-- pgTAP: migration 1462, the saved-search matcher (A89, RRR-134, A65-008). It writes an alert for each listing published
-- since a search was saved that is open to the search's owner and matches it, once, and notifies the owner by email and
-- push with kind opportunity.matched. It never alerts a listing the person could not see (A76's 1327 visibility).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(16);

create function pg_temp.listing(p_key text, p_role text, p_title text, p_invitee text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.opportunities (project_id, requisition_id, role_type, role_code, title, visibility, rate_type, deadline_at, starts_on, ends_on)
  values (pg_temp.id('prj_a'), case when p_role = 'Crew' then pg_temp.id('requisition_a') end, p_role::app.external_role_type,
    case when p_role = 'Crew' then '5000.51.02' end, p_title, 'Invited', case when p_role = 'Crew' then 'Day' else 'Bid' end::app.rate_type,
    now() + interval '20 days', '2027-06-01', '2027-06-03')
  returning id into v;
  insert into world values (p_key, v);
  if p_invitee is not null then
    insert into app.opportunity_invitations (opportunity_id, person_id) values (v, pg_temp.id(p_invitee));
  end if;
  perform app.transition_opportunity(v, 'Draft', 'Pending Approval', 'Ready.');
  perform app.transition_opportunity(v, 'Pending Approval', 'Published', 'Approved.');
  perform pg_temp.as_platform();
  return v;
end $$;
grant execute on function pg_temp.listing(text, text, text, text) to public;

-- Moves a row's creation time back inside the test transaction, where now() never moves; ledgers and the audit stamp
-- trigger refuse it otherwise, so the user triggers are off for the one statement.
create function pg_temp.backdate(p_table text, p_column text, p_key text, p_age interval) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  execute format('alter table %s disable trigger user', p_table);
  execute format('update %s set created_at = now() - %L::interval where %I = %L', p_table, p_age, p_column, pg_temp.id(p_key));
  execute format('alter table %s enable trigger user', p_table);
end $$;

create function pg_temp.alerts(p_search text) returns integer
language sql as $$ select count(*)::integer from app.opportunity_alerts a where a.saved_search_id = pg_temp.id(p_search) and a.deleted_at is null $$;

-- A listing published before nina saves her search never alerts it.
select pg_temp.listing('opp_old', 'Vendor', 'Summer Series Old Towers', 'nina');
select pg_temp.backdate('app.opportunity_state_transitions', 'opportunity_id', 'opp_old', '1 hour');

select pg_temp.as_user('nina');
insert into app.saved_searches (person_id, name, role_type, query_text) values (pg_temp.id('nina'), 'Delay towers', 'Vendor', 'towers')
returning id as v_search \gset
insert into world values ('search_nina', :'v_search');
select pg_temp.backdate('app.saved_searches', 'id', 'search_nina', '30 minutes');

select pg_temp.listing('opp_match', 'Vendor', 'Summer Series Delay Towers', 'nina');
select pg_temp.listing('opp_words', 'Vendor', 'Summer Series Consoles', 'nina');
select pg_temp.listing('opp_role', 'Crew', 'Summer Series Tower Riggers', null);
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp_role'), pg_temp.id('nina'));
select pg_temp.listing('opp_hidden', 'Vendor', 'Summer Series Hidden Towers', null);

select is(private.match_saved_searches(), 1, 'the matcher writes one alert');
select ok(exists (select 1 from app.opportunity_alerts where saved_search_id = pg_temp.id('search_nina') and opportunity_id = pg_temp.id('opp_match')),
  'for the new listing open to nina that matches her role type and words');
select ok(not exists (select 1 from app.opportunity_alerts where opportunity_id = pg_temp.id('opp_old')), 'not for a listing published before she saved the search');
select ok(not exists (select 1 from app.opportunity_alerts where opportunity_id = pg_temp.id('opp_words')), 'nor one without her words');
select ok(not exists (select 1 from app.opportunity_alerts where opportunity_id = pg_temp.id('opp_role')), 'nor one of another role type');
select ok(not exists (select 1 from app.opportunity_alerts where opportunity_id = pg_temp.id('opp_hidden')),
  'nor one she cannot see: the matcher never widens visibility');
select isnt((select delivered_at from app.opportunity_alerts where opportunity_id = pg_temp.id('opp_match')), null,
  'the alert is marked delivered once the notification is queued');

select results_eq($$select n.kind, n.org_id, n.subject_id, n.message_args ->> 'searchName', n.message_args ->> 'gatewayPath'
  from app.notifications n where n.recipient_person_id = pg_temp.id('nina')$$,
  format($$values ('opportunity.matched'::text, %L::uuid, %L::uuid, 'Delay towers'::text, %L::text)$$, pg_temp.id('org_a'), pg_temp.id('opp_match'),
    '/explore/' || private.gateway_display_key('OPP', pg_temp.id('opp_match'))),
  'nina gets one opportunity.matched notification from the posting org, linking to the listing');
select is((select string_agg(d.channel::text, ',' order by d.channel) from app.notification_deliveries d
           join app.notifications n on n.id = d.notification_id where n.recipient_person_id = pg_temp.id('nina')),
  'Email,Push', 'by email and push');

select is(private.match_saved_searches(), 0, 'a second run writes nothing');
select is((select count(*)::integer from app.notifications where recipient_person_id = pg_temp.id('nina')), 1, 'and notifies nobody again');

-- Two new matches from one org: one notification for both, linking to Alerts.
select pg_temp.listing('opp_m2', 'Vendor', 'Summer Series Light Towers', 'nina');
select pg_temp.listing('opp_m3', 'Vendor', 'Summer Series Sound Towers', 'nina');
select is(private.match_saved_searches(), 2, 'two more matches');
select results_eq($$select (n.message_args ->> 'count')::integer, n.message_args ->> 'gatewayPath' from app.notifications n
  where n.recipient_person_id = pg_temp.id('nina') and n.message_args ->> 'count' <> '1'$$,
  $$values (2, '/explore/alerts'::text)$$, 'notify once per search and org, with the count, linking to Alerts');

-- Passed and applied listings, and alerts turned off.
select pg_temp.listing('opp_m4', 'Vendor', 'Summer Series Passed Towers', 'nina');
select pg_temp.as_user('nina');
insert into app.passed_opportunities (opportunity_id) values (pg_temp.id('opp_m4'));
select pg_temp.as_platform();
select is(private.match_saved_searches(), 0, 'a listing she passed on never alerts');

select pg_temp.as_user('nina');
update app.saved_searches set alerts_enabled = false where id = pg_temp.id('search_nina');
select pg_temp.as_platform();
select pg_temp.listing('opp_m5', 'Vendor', 'Summer Series Late Towers', 'nina');
select is(private.match_saved_searches(), 0, 'a search with alerts off writes nothing');

-- The org narrows its marketplace visibility: a Network listing open to victor through a completed engagement stops
-- alerting once the org turns private (1327).
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select pg_temp.as_user('victor');
insert into app.saved_searches (person_id, name, role_type) values (pg_temp.id('victor'), 'Vendor work', 'Vendor') returning id as v_vs \gset
insert into world values ('search_victor', :'v_vs');
select pg_temp.backdate('app.saved_searches', 'id', 'search_victor', '30 minutes');
select pg_temp.as_user('carol');
insert into app.opportunities (project_id, role_type, title, visibility, rate_type, deadline_at)
values (pg_temp.id('prj_a'), 'Vendor', 'Summer Series Network Stage', 'Network', 'Bid', now() + interval '20 days') returning id as v_net \gset
select app.transition_opportunity(:'v_net', 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(:'v_net', 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'private');
select pg_temp.as_platform();
select private.match_saved_searches();
select is(pg_temp.alerts('search_victor'), 0, 'a listing the org''s marketplace visibility now hides never alerts');

select * from finish();
rollback;
