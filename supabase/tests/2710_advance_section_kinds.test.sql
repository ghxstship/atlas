-- pgTAP: migration 2710 (R9), typed advance sections. Every row of the kind and configuration matrix; section choices
-- held to their kind, project and org, and fixed after send; send_advance_packet refuses an Item Request or Credential
-- Request section without a choice; the kind and configuration fixed after send while the title can still change; the
-- recipient engagement guard (same party, same project, live, fixed after send) and its backfill; who supplies a
-- sponsor asset is fixed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

-- Inserts a section into a packet as dave and returns its id, or the refusal as text.
create function pg_temp.section(p_packet text, p_position integer, p_kind text, p_window text default null,
  p_max integer default null, p_per_person boolean default false) returns text
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('dave');
  insert into app.advance_sections (advance_packet_id, position, title, section_kind, window_kind, max_lines, per_person)
  values (pg_temp.id(p_packet), p_position, p_kind || ' ' || p_position, p_kind::app.advance_section_kind,
    p_window::app.advance_window_kind, p_max, p_per_person)
  returning id into v;
  return v::text;
exception when check_violation then
  return 'check';
end $$;

select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Vendor Advance') returning id)
insert into world select 'pkt', id from x;

-- The kind and configuration matrix ---------------------------------------------------------------------------------------
select isnt(pg_temp.section('pkt', 1, 'Text'), 'check', 'Text takes no configuration');
select is(pg_temp.section('pkt', 2, 'Text', null, 3), 'check', 'Text refuses max_lines');
select is(pg_temp.section('pkt', 3, 'Crew Roster', null, null, true), 'check', 'Crew Roster refuses per_person');
select isnt(pg_temp.section('pkt', 4, 'Crew Roster'), 'check', 'Crew Roster takes no configuration');
select is(pg_temp.section('pkt', 5, 'Guest List', 'Arrival'), 'check', 'Guest List refuses a window kind');
select isnt(pg_temp.section('pkt', 6, 'Guest List'), 'check', 'Guest List takes no configuration');
select is(pg_temp.section('pkt', 7, 'File'), 'check', 'File needs max_lines');
select is(pg_temp.section('pkt', 8, 'File', null, 11), 'check', 'File takes at most 10 files');
select is(pg_temp.section('pkt', 9, 'File', 'Load In', 2), 'check', 'File refuses a window kind');
select isnt(pg_temp.section('pkt', 10, 'File', null, 2), 'check', 'File takes 1 to 10 files');
select is(pg_temp.section('pkt', 11, 'Schedule Window', null, 1), 'check', 'Schedule Window needs a window kind');
select is(pg_temp.section('pkt', 12, 'Schedule Window', 'Load In', 6), 'check', 'Schedule Window takes at most 5 windows');
select is(pg_temp.section('pkt', 13, 'Schedule Window', 'Load In', 1, true), 'check', 'Schedule Window refuses per_person');
select isnt(pg_temp.section('pkt', 14, 'Schedule Window', 'Load In', 2), 'check', 'Schedule Window takes a window kind and 1 to 5');
select is(pg_temp.section('pkt', 15, 'Item Request', null, 51), 'check', 'Item Request takes at most 50 lines');
select is(pg_temp.section('pkt', 16, 'Item Request', 'Arrival', 5), 'check', 'Item Request refuses a window kind');
select isnt(pg_temp.section('pkt', 17, 'Item Request', null, 5, true), 'check', 'Item Request takes 1 to 50 lines, per person or not');
select is(pg_temp.section('pkt', 18, 'Credential Request'), 'check', 'Credential Request needs max_lines');
select isnt(pg_temp.section('pkt', 19, 'Credential Request', null, 10), 'check', 'Credential Request takes 1 to 50 lines');
insert into world select 'sec_item', id from app.advance_sections where advance_packet_id = pg_temp.id('pkt') and position = 17;
insert into world select 'sec_cred', id from app.advance_sections where advance_packet_id = pg_temp.id('pkt') and position = 19;
insert into world select 'sec_file', id from app.advance_sections where advance_packet_id = pg_temp.id('pkt') and position = 10;
select pg_temp.as_platform();
select is((select section_kind::text from app.advance_sections where advance_packet_id = pg_temp.id('pkt') and position = 1), 'Text',
  'a section is Text unless a kind is given');

-- Choices ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into app.advance_section_choices (advance_section_id, asset_class_id)
  values ((select id from world where key = 'sec_item'), (select id from world where key = 'cls_radio'))$$,
  'an Item Request offers the org''s radio class');
select throws_ok($$insert into app.advance_section_choices (advance_section_id, asset_class_id)
  values ((select id from world where key = 'sec_item'), (select id from world where key = 'cls_cable'))$$,
  'XR001', null, 'a site asset class that answers for no offering is not offered');
select throws_ok($$insert into app.advance_section_choices (advance_section_id, credential_category_id)
  values ((select id from world where key = 'sec_item'), (select id from world where key = 'cat_crew'))$$,
  'XR001', 'advance_section_choice_kind: Credential categories are offered by a Credential Request section.', 'a category is not an item');
select throws_ok($$insert into app.advance_section_choices (advance_section_id, asset_class_id)
  values ((select id from world where key = 'sec_cred'), (select id from world where key = 'cls_radio'))$$,
  'XR001', 'advance_section_choice_kind: Asset classes are offered by an Item Request section.', 'a class is not a credential');
select throws_ok($$insert into app.advance_section_choices (advance_section_id, asset_class_id, credential_category_id)
  values ((select id from world where key = 'sec_item'), (select id from world where key = 'cls_radio'), (select id from world where key = 'cat_crew'))$$,
  '23514', null, 'a choice names one target');
select lives_ok($$insert into app.advance_section_choices (advance_section_id, credential_category_id)
  values ((select id from world where key = 'sec_cred'), (select id from world where key = 'cat_crew'))$$,
  'a Credential Request offers a category of the project');
select throws_ok($$insert into app.advance_section_choices (advance_section_id, credential_category_id)
  values ((select id from world where key = 'sec_cred'), (select id from world where key = 'cat_crew'))$$,
  '23505', null, 'a section offers a category once');
select pg_temp.as_user('alice');
insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a2'), 'GALA', 'Gala Crew');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.advance_section_choices (advance_section_id, credential_category_id)
  values ((select id from world where key = 'sec_cred'), (select id from app.credential_categories where code = 'GALA'))$$,
  'XR001', 'advance_section_choice_project: A credential category comes from the packet''s project.', 'a category of another project is refused');
select throws_ok($$update app.advance_sections set section_kind = 'Text', max_lines = null where id = (select id from world where key = 'sec_cred')$$,
  'XR001', 'advance_section_kind_choices: Remove the section''s choices before changing its kind.', 'a section with choices keeps its kind');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.advance_section_choices), 0, 'another org reads no choices');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.advance_section_choices), 0, 'a Viewer outside the project reads no choices');

-- Sending -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id) insert into world select 'rcp', id from x;
select pg_temp.section('pkt', 20, 'Item Request', null, 3);
select throws_ok($$select app.send_advance_packet((select id from world where key = 'pkt'))$$,
  'XR001', 'advance_section_choices_missing: Give every Item Request and Credential Request section at least one choice before sending.',
  'a request section without a choice is not sent');
update app.advance_sections set deleted_at = now() where advance_packet_id = pg_temp.id('pkt') and position = 20;
select lives_ok($$select app.send_advance_packet((select id from world where key = 'pkt'))$$, 'every request section offers something, so it sends');

-- Fixed after send -----------------------------------------------------------------------------------------------------------
select throws_ok($$update app.advance_sections set max_lines = 4 where id = (select id from world where key = 'sec_file')$$,
  'XR001', 'advance_packet_sections_fixed: The sections of a sent packet are fixed; wording may still be corrected.', 'the configuration is fixed after send');
select throws_ok($$update app.advance_sections set per_person = false where id = (select id from world where key = 'sec_item')$$,
  'XR001', null, 'per person is fixed after send');
select lives_ok($$update app.advance_sections set title = 'Radios and carts', prompt = 'What do you need?' where id = (select id from world where key = 'sec_item')$$,
  'the title and prompt can still be corrected');
select throws_ok($$insert into app.advance_section_choices (advance_section_id, asset_class_id)
  values ((select id from world where key = 'sec_item'), (select id from world where key = 'cls_cable'))$$,
  'XR001', 'advance_packet_sections_fixed: The sections of a sent packet are fixed; wording may still be corrected.', 'no choice is added after send');
select throws_ok($$update app.advance_section_choices set deleted_at = now() where advance_section_id = (select id from world where key = 'sec_item')$$,
  'XR001', null, 'no choice is removed after send');

-- The recipient's engagement --------------------------------------------------------------------------------------------------
select throws_ok($$update app.advance_recipients set engagement_id = null where id = (select id from world where key = 'rcp')$$,
  'XR001', 'advance_recipient_engagement: A recipient keeps its engagement once the packet is sent.', 'the engagement is fixed after send');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Artist Advance') returning id) insert into world select 'pkt2', id from x;
select throws_ok($$insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values ((select id from world where key = 'pkt2'), (select id from world where key = 'cp_v_a'), (select id from world where key = 'eng_art_a'))$$,
  'XR001', 'advance_recipient_engagement: The engagement is a live engagement of the same party on the packet''s project.', 'an engagement of another party is refused');
select throws_ok($$insert into app.advance_recipients (advance_packet_id, person_id, engagement_id)
  values ((select id from world where key = 'pkt2'), (select id from world where key = 'ivy'), (select id from world where key = 'eng_ivy_b'))$$,
  'XR001', null, 'an engagement of another project is refused');
with x as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.id('pkt2'), pg_temp.id('art')) returning id)
insert into world select 'rcp_art', id from x;
with x as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.id('pkt2'), pg_temp.id('quinn')) returning id)
insert into world select 'rcp_quinn', id from x;
select pg_temp.as_platform();
select ok(private.backfill_advance_recipient_engagements() >= 1, 'the backfill links recipients with exactly one matching engagement');
select is((select engagement_id from app.advance_recipients where id = pg_temp.id('rcp_art')), pg_temp.id('eng_art_a'),
  'the artist recipient gets the artist''s engagement');
select is((select engagement_id from app.advance_recipients where id = pg_temp.id('rcp_quinn')), null,
  'a recipient engaged on no project of the packet stays unlinked');
select is(private.backfill_advance_recipient_engagements(), 0, 'running it again links nothing');
select pg_temp.as_user('dave');
select lives_ok($$update app.advance_recipients set engagement_id = null where id = (select id from world where key = 'rcp_art')$$,
  'before send the engagement can still change');

-- Who supplies a sponsor asset ----------------------------------------------------------------------------------------------------
select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
select pg_temp.as_user('carol');
with s as (insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Main stage banner placement', 2) returning id) insert into world select 'ent', id from s;
with a as (insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title) values (pg_temp.id('ent'), 'Logo', 'Brightwave logo') returning id)
insert into world select 'asset', id from a;
select is((select asset_source::text from app.sponsor_assets where id = pg_temp.id('asset')), 'Org Supplied', 'an asset the org adds is Org Supplied');
select throws_ok($$update app.sponsor_assets set asset_source = 'Sponsor Supplied' where id = (select id from world where key = 'asset')$$,
  'XR001', 'sponsor_asset_source: An asset keeps who supplies it.', 'who supplies an asset never changes');
select throws_ok($$insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title, asset_source)
  values ((select id from world where key = 'ent'), 'Logo', 'Fake supply', 'Sponsor Supplied')$$,
  'XR001', 'sponsor_asset_source: A sponsor supplies its own asset through app.supply_sponsor_asset.', 'the org never inserts a Sponsor Supplied asset');

select * from finish();
rollback;
