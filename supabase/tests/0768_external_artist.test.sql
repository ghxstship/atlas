-- pgTAP: migration 0768, artist projections (Section 4.4.4 Artist, Section 8.7). Advance packets for the person,
-- their Advance representative and a recipient account, answers through the signed-in path with A10's guards, riders
-- of the account or the representing agency, and travel and hospitality lines without prices. Denial for another
-- party, another tenant and anon, and drafts kept internal.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');

-- Fixture ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with p as (insert into app.advance_packets (project_id, title, due_at) values (pg_temp.id('prj_a'), 'Opening Night Advance', now() + interval '14 days') returning id)
  insert into world select 'packet', id from p;
with s as (insert into app.advance_sections (advance_packet_id, position, title, prompt) values (pg_temp.id('packet'), 1, 'Backline', 'List your backline needs.') returning id)
  insert into world select 'section', id from s;
with r as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.id('packet'), pg_temp.id('art')) returning id)
  insert into world select 'rcpt_art', id from r;
with r as (insert into app.advance_recipients (advance_packet_id, counterparty_id) values (pg_temp.id('packet'), pg_temp.id('cp_v_a')) returning id)
  insert into world select 'rcpt_v', id from r;
insert into world values ('cp_t_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_t')));
with r as (insert into app.riders (project_id, counterparty_id, title) values (pg_temp.id('prj_a'), pg_temp.id('cp_t_a'), 'Arturo Bell Technical Rider') returning id)
  insert into world select 'rider', id from r;
insert into app.rider_lines (rider_id, description, quantity) values (pg_temp.id('rider'), 'Two wedge monitors', 2);
with f as (insert into app.fulfillments (project_id, fulfillment_kind, title, starts_at, ends_at)
  values (pg_temp.id('prj_a'), 'Travel', 'Inbound Flights', '2027-06-01 14:00+00', '2027-06-01 18:00+00') returning id)
  insert into world select 'travel', id from f;
insert into app.fulfillment_lines (fulfillment_id, description, person_id, unit_price_minor, currency_code) values
  (pg_temp.id('travel'), 'MIA arrival, seat 3A', pg_temp.id('art'), 64000, 'USD'),
  (pg_temp.id('travel'), 'MIA arrival, seat 14C', pg_temp.id('ivy'), 31000, 'USD');
select pg_temp.as_platform();

-- Advance packets --------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('art', 'select 1 from api_external.advance_packets'), 0, 'an unsent packet stays internal');
select pg_temp.as_user('alice');
select app.send_advance_packet(pg_temp.id('packet'));
select pg_temp.as_platform();
select is(pg_temp.n('art', 'select 1 from api_external.advance_packets'), 1, 'own engagement: the artist reads the sent packet');
select is(pg_temp.n('art', 'select 1 from api_external.advance_sections'), 1, 'with its sections');
select is(pg_temp.n('rita', 'select 1 from api_external.my_advance_recipients'), 1, 'representation: the Advance representative answers for the artist');
select is(pg_temp.n('victor', 'select 1 from api_external.my_advance_recipients'), 1, 'account: the vendor Owner answers for the account');
select is(pg_temp.n('ivy', 'select 1 from api_external.advance_packets'), 0, 'denial: a party who is not a recipient');
select is(pg_temp.n('xavier', 'select 1 from api_external.advance_packets'), 0, 'denial: another tenant');

select pg_temp.as_user('ivy');
select throws_ok(format($$select app.submit_engaged_advance_answer('%s', '%s', 'Not mine.')$$, pg_temp.id('rcpt_art'), pg_temp.id('section')),
  '42501', null, 'another party cannot answer for the artist');
select pg_temp.as_user('rita');
select lives_ok(format($$select app.submit_engaged_advance_answer('%s', '%s', 'Two wedges and a drum riser.')$$, pg_temp.id('rcpt_art'), pg_temp.id('section')),
  'the representative answers for the artist');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.submit_engaged_advance_answer('%s', '%s', 'Wrong recipient.')$$, pg_temp.id('rcpt_art'), pg_temp.id('section')),
  '42501', null, 'a recipient account cannot answer as another recipient');
select pg_temp.as_platform();
select is(pg_temp.n('art', 'select 1 from api_external.advance_submissions where review_outcome is null'), 1, 'the artist reads the unreviewed answer');
select is(pg_temp.n('victor', 'select 1 from api_external.advance_submissions'), 0, 'the vendor never reads the artist''s answers');
select hasnt_column('api_external', 'advance_submissions', 'reviewed_by', 'who reviewed never reaches externals');

-- Riders ------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('rita', 'select 1 from api_external.riders'), 1, 'representation: the agency Owner reads the rider of the artist it represents');
select is(pg_temp.n('rita', 'select 1 from api_external.rider_lines'), 1, 'with its asks');
select is(pg_temp.n('victor', 'select 1 from api_external.riders'), 0, 'denial: another account');
select is(pg_temp.n('ivy', 'select 1 from api_external.riders'), 0, 'denial: another party');

-- Travel and hospitality -----------------------------------------------------------------------------------------------------------
select is(pg_temp.n('art', 'select 1 from api_external.hospitality'), 1, 'own engagement: the artist reads their own flight only');
select is(pg_temp.n('rita', 'select 1 from api_external.hospitality'), 1, 'representation: the Advance representative reads it');
select is(pg_temp.n('ivy', 'select 1 from api_external.hospitality'), 0, 'Onboarding: ivy''s operational area is not open yet');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select is(pg_temp.n('ivy', 'select 1 from api_external.hospitality'), 1, 'at Active ivy reads her own flight only');
select hasnt_column('api_external', 'hospitality', 'unit_price_minor', 'prices never reach externals');

-- Time box and anon ------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_art_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_art_a', 'Closing', 'Complete');
select is(pg_temp.n('art', 'select 1 from api_external.advance_packets'), 0, 'Complete: advancing closes');
select is(pg_temp.n('rita', 'select 1 from api_external.riders'), 0, 'Complete: riders close');
select is(pg_temp.n('art', 'select 1 from api_external.hospitality'), 0, 'Complete: hospitality closes');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.advance_packets', '42501', null, 'anon deny');
select pg_temp.as_platform();

select * from finish();
rollback;
