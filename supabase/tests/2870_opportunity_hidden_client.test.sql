-- pgTAP: migration 2870, the client and event hidden on crew opportunities until booking (P10, RRR-224, gap G-128). The
-- flag and its default exist with their column grants; while the flag is on the title and description cannot name the
-- project, its client or the venue, for a member session and for the service role alike; the flag goes on only before
-- publishing and comes off in any state; and private.opportunity_disclosed_to_me answers true only for the posting
-- org's readers and for a side holding an Accepted application.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(30);

-- The project's client and a venue with a short name.
select pg_temp.as_user('alice');
insert into world values ('cp_client', app.create_counterparty(pg_temp.id('org_a'), 'Lakeshore Brands', null));
update app.projects set client_counterparty_id = pg_temp.id('cp_client') where id = pg_temp.id('prj_a');
insert into app.venues (org_id, name, jurisdiction_id, time_zone) values (pg_temp.id('org_a'), 'Bay', 'US-FL-MIAMI-DADE', 'America/New_York')
returning id as v_bay \gset
insert into world values ('venue_bay', :'v_bay');
select pg_temp.as_platform();

-- A Draft vendor listing on prj_a, as a Manager.
create function pg_temp.draft(p_key text, p_title text, p_description text, p_hidden boolean, p_venue text default 'venue_a') returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.opportunities (project_id, role_type, title, description, visibility, rate_type, venue_id, deadline_at,
    starts_on, ends_on, hide_client_until_booked)
  values (pg_temp.id('prj_a'), 'Vendor', p_title, p_description, 'Invited', 'Bid', pg_temp.id(p_venue), now() + interval '20 days',
    '2027-06-01', '2027-06-03', p_hidden)
  returning id into v;
  insert into world values (p_key, v);
  return v;
end $$;
grant execute on function pg_temp.draft(text, text, text, boolean, text) to public;

create function pg_temp.publish(p_key text) returns void
language plpgsql as $$
begin
  perform app.transition_opportunity(pg_temp.id(p_key), 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(pg_temp.id(p_key), 'Pending Approval', 'Published', 'Approved.');
end $$;
grant execute on function pg_temp.publish(text) to public;

-- An application moved to a state as the fixture; the offer flow is 0764's to test.
create function pg_temp.application_state(p_key text, p_state text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  alter table app.applications disable trigger user;
  update app.applications set application_state = p_state::app.application_state where id = pg_temp.id(p_key);
  alter table app.applications enable trigger user;
end $$;

-- Columns ----------------------------------------------------------------------------------------------------------------
select col_type_is('app', 'opportunities', 'hide_client_until_booked', 'boolean', 'opportunities carry the flag as a boolean');
select col_not_null('app', 'opportunities', 'hide_client_until_booked', 'that is never NULL');
select col_default_is('app', 'opportunities', 'hide_client_until_booked', 'false', 'and starts off');
select col_type_is('app', 'opportunity_defaults', 'hide_client_until_booked', 'boolean', 'the opportunity defaults carry it too');
select col_not_null('app', 'opportunity_defaults', 'hide_client_until_booked', 'never NULL');
select col_default_is('app', 'opportunity_defaults', 'hide_client_until_booked', 'false', 'and off');
select ok(has_column_privilege('authenticated', 'app.opportunities', 'hide_client_until_booked', 'INSERT')
  and has_column_privilege('authenticated', 'app.opportunities', 'hide_client_until_booked', 'UPDATE'),
  'authenticated holds the column insert and update grants');

-- Names while hidden ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_like($$select pg_temp.draft('opp_named_project', 'Riggers for Northwind Summer Series', null, true)$$,
  'opportunity_hidden_client_named:%Northwind Summer Series%', 'the title cannot name the project while hidden, and the refusal names it');
select throws_like($$select pg_temp.draft('opp_named_client', 'Audio Package', 'Line arrays for LAKESHORE brands guests.', true)$$,
  'opportunity_hidden_client_named:%Lakeshore Brands%', 'the description cannot name the client, ignoring case');
select throws_like($$select pg_temp.draft('opp_named_venue', 'Audio at the northwind pier pavilion', null, true)$$,
  'opportunity_hidden_client_named:%Northwind Pier Pavilion%', 'nor the opportunity''s venue');
select lives_ok($$select pg_temp.draft('opp_short', 'Bay crew audio', 'Covering the Bay stage.', true, 'venue_bay')$$,
  'a name of 3 characters or fewer is ignored');
select lives_ok($$select pg_temp.draft('opp_open_named', 'Riggers for Northwind Summer Series', 'Lakeshore Brands at Northwind Pier Pavilion.', false)$$,
  'the same text is accepted with the flag off');
select throws_like($$update app.opportunities set hide_client_until_booked = true where id = pg_temp.id('opp_open_named')$$,
  'opportunity_hidden_client_named:%', 'turning the flag on checks the text already there');
select lives_ok($$select pg_temp.draft('opp_hidden', 'Audio Package', 'Line arrays and consoles for six weekends.', true)$$,
  'a hidden listing with neutral text is accepted');
select throws_like($$update app.opportunities set description = 'Six weekends at Northwind Pier Pavilion.' where id = pg_temp.id('opp_hidden')$$,
  'opportunity_hidden_client_named:%', 'editing the text of a hidden listing is checked');
select throws_like($$update app.opportunities set venue_id = null, title = 'Audio for Northwind Pier Pavilion' where id = pg_temp.id('opp_hidden')$$,
  'opportunity_hidden_client_named:%', 'with no venue of its own, the project''s venue is checked');

-- The service role is held to the same rule: the client name is read directly, not through a member-scoped helper.
select pg_temp.as_platform();
set local role service_role;
select throws_like($$update app.opportunities set title = 'Lakeshore Brands Audio' where id = (select id from world where key = 'opp_hidden')$$,
  'opportunity_hidden_client_named:%Lakeshore Brands%', 'the service role cannot name the client on a hidden listing either');
select pg_temp.as_platform();

-- Turning the flag on and off ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.draft('opp_shown', 'Stage Crew Audio', null, false);
select lives_ok($$update app.opportunities set hide_client_until_booked = true where id = pg_temp.id('opp_shown')$$,
  'the flag goes on while Draft');
select lives_ok($$update app.opportunities set hide_client_until_booked = false where id = pg_temp.id('opp_shown')$$,
  'and comes off');
select pg_temp.publish('opp_shown');
select throws_like($$update app.opportunities set hide_client_until_booked = true where id = pg_temp.id('opp_shown')$$,
  'opportunity_hidden_client_published:%', 'a Published listing already showed its names, so the flag cannot go on');
select app.transition_opportunity(pg_temp.id('opp_shown'), 'Published', 'Paused', 'Holding.');
select throws_like($$update app.opportunities set hide_client_until_booked = true where id = pg_temp.id('opp_shown')$$,
  'opportunity_hidden_client_published:%', 'nor once Paused');
select pg_temp.publish('opp_hidden');
select lives_ok($$update app.opportunities set hide_client_until_booked = false where id = pg_temp.id('opp_hidden')$$,
  'turning it off is allowed after publishing');
select pg_temp.draft('opp_secret', 'Audio Package', 'Line arrays and consoles for six weekends.', true);
select pg_temp.publish('opp_secret');

-- Disclosure --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp_secret'), pg_temp.id('ivy'));
select pg_temp.as_user('ivy');
with a as (insert into app.applications (opportunity_id, applicant_person_id) values (pg_temp.id('opp_secret'), pg_temp.id('ivy')) returning id)
insert into world select 'app_ivy', id from a;

select pg_temp.claims('ivy');
select is(private.opportunity_disclosed_to_me(pg_temp.id('opp_secret')), false, 'a Submitted applicant is not told the client');
select pg_temp.application_state('app_ivy', 'Offered');
select pg_temp.claims('ivy');
select is(private.opportunity_disclosed_to_me(pg_temp.id('opp_secret')), false, 'nor an Offered one');
select pg_temp.application_state('app_ivy', 'Accepted');
select pg_temp.claims('ivy');
select is(private.opportunity_disclosed_to_me(pg_temp.id('opp_secret')), true, 'an Accepted applicant is booked and told');
select pg_temp.claims('quinn');
select is(private.opportunity_disclosed_to_me(pg_temp.id('opp_secret')), false, 'another person is not');
select is(private.opportunity_disclosed_to_me(pg_temp.id('opp_open_named')), true, 'a listing with the flag off hides nothing');
select pg_temp.claims('carol');
select is(private.opportunity_disclosed_to_me(pg_temp.id('opp_secret')), true,
  'a member who reads the posting''s project sees their own listing unmasked');
select pg_temp.as_platform();
select ok(not has_function_privilege('anon', 'private.opportunity_disclosed_to_me(uuid)', 'execute')
  and has_function_privilege('authenticated', 'private.opportunity_disclosed_to_me(uuid)', 'execute'),
  'the disclosure check is for signed-in callers');
select ok(not has_function_privilege('authenticated', 'private.guard_opportunity_hidden_client()', 'execute'),
  'the guard is not callable');

select * from finish();
rollback;
