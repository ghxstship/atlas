-- pgTAP: migration 6220 (R11), the advancing heatmap. app.advance_progress gives every cell state (Missing, Awaiting
-- Review, Accepted, Returned, Complete from the roster, Not Applicable for a sponsor's guest list) and overdue, only to
-- readers of the project's packets. app.roster_readiness hides each category from a reader without its capability, shows
-- allergies only as Shared or Not Shared and only to holders of data.restricted.read.medical, says Not Offered when the
-- offering is off, has no value column and refuses a non-reader. xos_backup reads neither view; the publication and the
-- field history subjects are in place.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 4654_project_facts_world.psql

select no_plan();

-- A member whose only role holds advancing.packet.read and, optionally, one more capability.
create function pg_temp.reader(p_key text, p_extra text default null) returns void
language plpgsql as $$
begin
  perform pg_temp.producer(p_key, 'advancing.packet.read');
  perform pg_temp.as_platform();
  if p_extra is not null then
    insert into app.role_capabilities (role_id, capability_code, reach)
    select r.id, p_extra, 'organization' from app.roles r where r.org_id = pg_temp.id('org_a') and r.code = p_key || '_only';
  end if;
end $$;

create function pg_temp.cell(p_who text, p_recipient text, p_section text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(p_who);
  select g.cell_state into v from app.advance_progress g
  where g.advance_recipient_id = pg_temp.id(p_recipient) and g.advance_section_id = pg_temp.id(p_section);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.ready(p_who text, p_entry text, p_category text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(p_who);
  select r.cell_state into v from app.roster_readiness(pg_temp.id('prj_a')) r
  where r.roster_entry_id = pg_temp.id(p_entry) and r.category = p_category;
  perform pg_temp.as_platform();
  return v;
end $$;

select pg_temp.reader('reader');
select pg_temp.reader('medic', 'data.restricted.read.medical');
select pg_temp.reader('hopsr', 'hospitality.fulfillment.read');
select pg_temp.reader('credr', 'credentials.credential.read');

-- A sponsor, whose guest list is not asked of it.
select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01') returning id)
insert into world select 'eng_sponsor', id from e;

-- A packet to the vendor, the artist and the sponsor: a text section, the crew roster and the guest list.
with p as (insert into app.advance_packets (project_id, title, due_at) values (pg_temp.id('prj_a'), 'Production Advance', now() + interval '10 days') returning id)
insert into world select 'pkt', id from p;
with s as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt'), 1, 'Power') returning id)
insert into world select 's_text', id from s;
with s as (insert into app.advance_sections (advance_packet_id, position, title, section_kind) values (pg_temp.id('pkt'), 2, 'Crew', 'Crew Roster') returning id)
insert into world select 's_roster', id from s;
with s as (insert into app.advance_sections (advance_packet_id, position, title, section_kind) values (pg_temp.id('pkt'), 3, 'Guests', 'Guest List') returning id)
insert into world select 's_guest', id from s;
with r as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id)
insert into world select 'rcp_v', id from r;
with r as (insert into app.advance_recipients (advance_packet_id, person_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('art'), pg_temp.id('eng_art_a')) returning id)
insert into world select 'rcp_art', id from r;
with r as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_s_a'), pg_temp.id('eng_sponsor')) returning id)
insert into world select 'rcp_s', id from r;
select pg_temp.as_platform();

select pg_temp.as_user('reader');
select is((select count(*)::int from app.advance_progress where advance_packet_id = pg_temp.id('pkt')), 0, 'a draft packet has no progress rows');
select pg_temp.as_user('alice');
select app.send_advance_packet(pg_temp.id('pkt'));
select pg_temp.as_platform();

-- Packets ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('reader');
select is((select count(*)::int from app.advance_progress where advance_packet_id = pg_temp.id('pkt')), 9,
  'one row per recipient and section of a sent packet');
select is((select recipient_label from app.advance_progress where advance_recipient_id = pg_temp.id('rcp_v') limit 1), 'Bayside Audio',
  'a counterparty recipient reads as its organization');
select is((select recipient_label from app.advance_progress where advance_recipient_id = pg_temp.id('rcp_art') limit 1), 'Arturo Bell',
  'a person recipient reads as their name');
select pg_temp.as_platform();

select is(pg_temp.cell('reader', 'rcp_v', 's_text'), 'Missing', 'an unanswered section is Missing');
select is(pg_temp.cell('reader', 'rcp_v', 's_roster'), 'Missing', 'a roster with a Draft entry is Missing');
select is(pg_temp.cell('reader', 'rcp_art', 's_roster'), 'Complete', 'a roster of only the accepted self entry is Complete');
select is(pg_temp.cell('reader', 'rcp_v', 's_guest'), 'Missing', 'a vendor''s unanswered guest list is Missing');
select is(pg_temp.cell('reader', 'rcp_s', 's_guest'), 'Not Applicable', 'a sponsor''s guest list is Not Applicable');

select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_una'), 'Not touring this leg.');
select pg_temp.as_platform();
select is(pg_temp.cell('reader', 'rcp_v', 's_roster'), 'Complete', 'once no entry is Draft or Returned, the roster is Complete');
select pg_temp.as_user('carol');
select app.review_roster_entry(pg_temp.id('e_kai'), 'Returned', 'Add the arrival window.');
select pg_temp.as_platform();
select is(pg_temp.cell('reader', 'rcp_v', 's_roster'), 'Missing', 'a Returned entry makes it Missing again');

insert into app.advance_submissions (advance_section_id, advance_recipient_id, body)
values (pg_temp.id('s_text'), pg_temp.id('rcp_v'), 'Two 63 A three-phase feeds.');
select is(pg_temp.cell('reader', 'rcp_v', 's_text'), 'Awaiting Review', 'an answer awaits review');
select pg_temp.as_user('reader');
select isnt((select latest_submission_id from app.advance_progress where advance_recipient_id = pg_temp.id('rcp_v')
  and advance_section_id = pg_temp.id('s_text')), null, 'with the latest answer');
select pg_temp.as_user('alice');
update app.advance_submissions set review_outcome = 'Returned', return_reason = 'Which stage?', reviewed_at = now(), reviewed_by = pg_temp.id('alice')
where advance_recipient_id = pg_temp.id('rcp_v') and advance_section_id = pg_temp.id('s_text');
select pg_temp.as_platform();
select is(pg_temp.cell('reader', 'rcp_v', 's_text'), 'Returned', 'a returned answer is Returned');
insert into app.advance_submissions (advance_section_id, advance_recipient_id, body)
values (pg_temp.id('s_text'), pg_temp.id('rcp_v'), 'Two 63 A three-phase feeds at the main stage.');
select pg_temp.as_user('alice');
update app.advance_submissions set review_outcome = 'Accepted', reviewed_at = now(), reviewed_by = pg_temp.id('alice')
where advance_recipient_id = pg_temp.id('rcp_v') and advance_section_id = pg_temp.id('s_text') and review_outcome is null;
select pg_temp.as_platform();
select is(pg_temp.cell('reader', 'rcp_v', 's_text'), 'Accepted', 'the latest answer decides: Accepted');

-- Overdue: past the due date, Missing and Returned cells are overdue, the others are not.
update app.advance_packets set due_at = now() - interval '1 day' where id = pg_temp.id('pkt');
select pg_temp.as_user('reader');
select ok((select overdue from app.advance_progress where advance_recipient_id = pg_temp.id('rcp_v') and advance_section_id = pg_temp.id('s_guest')),
  'a Missing cell past due is overdue');
select ok(not (select overdue from app.advance_progress where advance_recipient_id = pg_temp.id('rcp_v') and advance_section_id = pg_temp.id('s_text')),
  'an Accepted cell is not');
select ok(not (select overdue from app.advance_progress where advance_recipient_id = pg_temp.id('rcp_s') and advance_section_id = pg_temp.id('s_guest')),
  'nor a Not Applicable one');
select pg_temp.as_platform();

select pg_temp.as_user('hops');
select is((select count(*)::int from app.advance_progress), 0, 'a member who does not read packets sees no rows');
select pg_temp.as_user('sam');
select is((select count(*)::int from app.advance_progress), 0, 'nor does an external party');
select pg_temp.as_platform();

-- Crew readiness ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('mo');
select app.share_work_details(pg_temp.id('eng_vendor_a'), array['Dietary Needs', 'Passport']::app.work_detail_category[]);
select pg_temp.as_platform();

select is(pg_temp.ready('reader', 'e_mo', 'Acceptance'), 'Accepted', 'the person''s answer shows to a packet reader');
select is(pg_temp.ready('reader', 'e_mo', 'Dietary Needs'), 'Hidden', 'a category is Hidden without its capability');
select is(pg_temp.ready('reader', 'e_mo', 'Emergency Contacts'), 'Hidden', 'emergency contacts too');
select is(pg_temp.ready('reader', 'e_mo', 'Contact'), 'Hidden', 'and the contact');
select is(pg_temp.ready('reader', 'e_mo', 'Allergies'), 'Hidden', 'allergies are Hidden without data.restricted.read.medical');
select is(pg_temp.ready('reader', 'e_mo', 'Travel'), 'Hidden', 'a project fact is Hidden without its capability');
select is(pg_temp.ready('reader', 'e_mo', 'Uniform'), 'Hidden', 'uniform sizes too');
select is(pg_temp.ready('reader', 'e_mo', 'Vehicle'), 'Hidden', 'and the vehicle');

select is(pg_temp.ready('hopsr', 'e_mo', 'Dietary Needs'), 'Missing', 'shared but empty dietary needs are Missing');
select is(pg_temp.ready('hopsr', 'e_kai', 'Dietary Needs'), 'Not Shared', 'unshared ones are Not Shared');
select is(pg_temp.ready('hopsr', 'e_mo', 'Passport'), 'Shared', 'a shared passport is Shared');
select is(pg_temp.ready('hopsr', 'e_kai', 'Passport'), 'Not Shared', 'an unshared one Not Shared');
select is(pg_temp.ready('hopsr', 'e_mo', 'Travel'), 'Missing', 'travel offered and not requested is Missing');
select is(pg_temp.ready('hopsr', 'e_mo', 'Allergies'), 'Hidden', 'hospitality alone never sees allergies');

select is(pg_temp.ready('medic', 'e_mo', 'Allergies'), 'Shared', 'a medical reader sees that the person shares the category allergies live in');
select is(pg_temp.ready('medic', 'e_kai', 'Allergies'), 'Not Shared', 'or does not');
select pg_temp.as_user('medic');
select ok((select bool_and(r.cell_state in ('Shared', 'Not Shared')) from app.roster_readiness(pg_temp.id('prj_a')) r where r.category = 'Allergies'),
  'allergies only ever read Shared or Not Shared');
select pg_temp.as_platform();

select is(pg_temp.ready('credr', 'e_mo', 'Vehicle'), 'Missing', 'parking offered and no vehicle is Missing');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.parking', 'Organization', null, 'not-offered');
select pg_temp.as_platform();
select is(pg_temp.ready('credr', 'e_mo', 'Vehicle'), 'Not Offered', 'with parking off, Not Offered');

select is((select proargnames from pg_catalog.pg_proc where oid = 'app.roster_readiness(uuid)'::regprocedure),
  array['p_project_id', 'roster_entry_id', 'engagement_id', 'party_label', 'person_label', 'role_code', 'entry_state', 'category', 'cell_state'],
  'the result has states only, no value column');
select pg_temp.as_user('hops');
select throws_ok(format($$select * from app.roster_readiness(%L)$$, pg_temp.id('prj_a')), '42501', null,
  'a member who reads neither packets nor engagements is refused');
select pg_temp.as_platform();

-- A closed engagement ------------------------------------------------------------------------------------------------------
-- The party can no longer answer (Section 8.7), so what it left stays visible but is neither overdue nor outstanding.
update app.advance_packets set due_at = now() - interval '1 day' where id = pg_temp.id('pkt');
select pg_temp.as_user('reader');
select ok((select bool_and(g.overdue) from app.advance_progress g where g.advance_recipient_id = pg_temp.id('rcp_art') and g.cell_state = 'Missing'),
  'past the due date, an open recipient''s missing section is overdue');
select is((select count(*)::int from app.roster_readiness(pg_temp.id('prj_a')) r where r.engagement_id = pg_temp.id('eng_art_a')) > 0, true,
  'and its roster is in the readiness grid');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Active', 'Closing');
select pg_temp.as_user('reader');
select ok((select bool_and(g.recipient_open) from app.advance_progress g where g.advance_recipient_id = pg_temp.id('rcp_art')),
  'Closing still counts: the party can answer until the engagement is Complete');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_art_a', 'Closing', 'Complete');
select pg_temp.as_user('reader');
select ok((select bool_and(not g.recipient_open) from app.advance_progress g where g.advance_recipient_id = pg_temp.id('rcp_art')),
  'at Complete the recipient is marked closed, for a reader with no policy on engagements as well');
select ok((select count(*) > 0 from app.advance_progress g where g.advance_recipient_id = pg_temp.id('rcp_art')), 'and keeps its rows');
select ok((select not bool_or(g.overdue) from app.advance_progress g where g.advance_recipient_id = pg_temp.id('rcp_art')), 'none of them overdue');
select is((select count(*)::int from app.roster_readiness(pg_temp.id('prj_a')) r where r.engagement_id = pg_temp.id('eng_art_a')), 0,
  'and its roster leaves the readiness grid');
select pg_temp.as_platform();

-- Allocations ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('hops');
select is((select count(*)::int from app.advance_allocation_heat), 0, 'the allocation heat follows R7''s readers');
select pg_temp.as_platform();

-- Catalog ------------------------------------------------------------------------------------------------------------------
select ok(not has_table_privilege('xos_backup', 'app.advance_progress', 'select'), 'xos_backup cannot select app.advance_progress');
select ok(not has_table_privilege('xos_backup', 'app.advance_allocation_heat', 'select'), 'nor app.advance_allocation_heat');
select ok(exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app'
  and tablename = 'advance_submissions'), 'answers are in the realtime publication');
select ok(exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app'
  and tablename = 'engagement_roster_entries'), 'and roster entries');
select ok(exists (select 1 from private.field_history_subjects where table_name = 'app.advance_recipients'), 'recipients have field history');
select ok(exists (select 1 from private.field_history_subjects where table_name = 'app.advance_sections'), 'and sections');

-- Openness goes by the party's engagements on the project, linked to the recipient or not.
select pg_temp.as_platform();
select ok(private.advance_party_open(pg_temp.id('prj_a'), null, pg_temp.id('quinn'), null), 'a party with no engagement here stays open');
select ok(private.advance_party_open(pg_temp.id('prj_a'), null, null, null), 'as does a recipient naming no party');
select ok(private.advance_party_open(pg_temp.id('prj_a'), null, pg_temp.id('ivy'), null), 'an unlinked person with an open engagement is open');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Canceled');
select ok(not private.advance_party_open(pg_temp.id('prj_a'), null, pg_temp.id('ivy'), null), 'an unlinked person whose only engagement here is Canceled is closed');
select ok(not private.advance_party_open(pg_temp.id('prj_a'), null, pg_temp.id('art'), null), 'and one whose only engagement is Complete');
insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  select e.project_id, e.person_id, e.role_type, e.role_code, e.worker_classification, e.pay_basis, e.arrangement, e.start_date
  from app.engagements e where e.id = pg_temp.id('eng_art_a');
select ok(private.advance_party_open(pg_temp.id('prj_a'), pg_temp.id('eng_art_a'), pg_temp.id('art'), null), 'a second open engagement keeps the party open though the linked one is Complete');
update app.engagements set deleted_at = now() where person_id = pg_temp.id('art') and id <> pg_temp.id('eng_art_a');
select ok(not private.advance_party_open(pg_temp.id('prj_a'), pg_temp.id('eng_art_a'), pg_temp.id('art'), null), 'a removed engagement counts for nothing');

select * from finish();
rollback;
