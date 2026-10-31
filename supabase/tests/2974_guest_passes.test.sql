-- pgTAP: migration 2974 (B8, G-68), guest passes. The pass code is stamped on approval and kept on check-in, never
-- written by a caller; the pass type is an Access category of the project; the host is a project person; a party never
-- sets the production fields but may give the guest's email; the door list finds a guest by pass code and shows the
-- pass; a check-in tells the host, unless the host checked the guest in; a checked-in guest keeps their pass fields.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.notified(p_who text, p_kind text, p_subject uuid) returns integer
language sql security definer as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind and n.subject_id = p_subject
$$;

select pg_temp.as_user('carol');
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'VIP', 'VIP Guest') returning id) insert into world select 'cat_vip', id from x;
with x as (insert into app.credential_categories (project_id, code, name, category_kind) values (pg_temp.id('prj_a'), 'PARK', 'Parking', 'Parking') returning id) insert into world select 'cat_park', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a2'), 'GALA', 'Gala Guest') returning id) insert into world select 'cat_a2', id from x;

-- Pass type and host --------------------------------------------------------------------------------------------------------
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, pass_category_id) values ((select id from world where key = 'prj_a'), 'Lee Park', (select id from world where key = 'cat_park'))$$,
  'XR001', 'guest_pass_category: A pass type is an Access credential category of this project.', 'a Parking category is not a pass type');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, pass_category_id) values ((select id from world where key = 'prj_a'), 'Lee Park', (select id from world where key = 'cat_a2'))$$,
  'XR001', null, 'a category of another project is not a pass type');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, host_person_id) values ((select id from world where key = 'prj_a'), 'Lee Park', (select id from world where key = 'quinn'))$$,
  'XR001', 'guest_host_not_on_project: A host is a member of the organization or engaged on this project.', 'a host engaged only by another org is refused');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, guest_email) values ((select id from world where key = 'prj_a'), 'Lee Park', 'Lee@Example.test')$$,
  '23514', null, 'the stored email is lowercase');
with x as (insert into app.guest_list_entries (project_id, guest_name, plus_ones, pass_category_id, table_label, host_person_id, guest_email)
  values (pg_temp.id('prj_a'), 'Sasha Bell', 2, pg_temp.id('cat_vip'), 'Table 4', pg_temp.id('dave'), 'sasha@example.test') returning id)
  insert into world select 'g_req', id from x;
select ok(pg_temp.id('g_req') is not null, 'a member host and an Access pass type are accepted');
select lives_ok($$insert into app.guest_list_entries (project_id, guest_name, host_person_id) values ((select id from world where key = 'prj_a'), 'Lee Park', (select id from world where key = 'ivy'))$$,
  'a host engaged on the project is accepted');
select is((select pass_code from app.guest_list_entries where id = pg_temp.id('g_req')), null, 'a Requested guest has no pass code');
select throws_ok($$update app.guest_list_entries set pass_code = 'GP-AAAAAAAAAA' where id = (select id from world where key = 'g_req')$$,
  'XR001', 'guest_entry_stamped: Decision and check-in times are set by the database.', 'a caller never writes the pass code');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, pass_code) values ((select id from world where key = 'prj_a'), 'Lee Park', 'GP-AAAAAAAAAA')$$,
  'XR001', 'guest_entry_stamped: Decision and check-in times are set by the database.', 'not on insert either');

-- The pass code -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.guest_list_entries set entry_state = 'Approved' where id = pg_temp.id('g_req');
select matches((select pass_code from app.guest_list_entries where id = pg_temp.id('g_req')), '^GP-[A-Z2-7]{10}$', 'approval stamps a pass code');
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name, entry_state, host_person_id) values (pg_temp.id('prj_a'), 'Rowan Hale', 'Approved', pg_temp.id('carol')) returning id)
  insert into world select 'g_appr', id from x;
select matches((select pass_code from app.guest_list_entries where id = pg_temp.id('g_appr')), '^GP-[A-Z2-7]{10}$', 'a guest added as Approved gets one too');
select isnt((select pass_code from app.guest_list_entries where id = pg_temp.id('g_appr')), (select pass_code from app.guest_list_entries where id = pg_temp.id('g_req')),
  'the codes differ');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Jo Park') returning id) insert into world select 'g_dec', id from x;
select pg_temp.as_user('alice');
update app.guest_list_entries set entry_state = 'Declined' where id = pg_temp.id('g_dec');
select is((select pass_code from app.guest_list_entries where id = pg_temp.id('g_dec')), null, 'a Declined guest has no pass code');
select pg_temp.as_user('carol');
update app.guest_list_entries set table_label = 'Table 5', guest_email = 'rowan@example.test' where id = pg_temp.id('g_appr');
select is((select table_label from app.guest_list_entries where id = pg_temp.id('g_appr')), 'Table 5', 'the table changes after approval');

-- A party ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select private.begin_trusted_operation('request_engaged_guest');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, table_label) values ((select id from world where key = 'prj_a'), 'Lee Park', 'Table 1')$$,
  'XR001', 'guest_entry_production_fields: The pass type, table and host are set by the production.', 'a party never sets the table');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, pass_category_id) values ((select id from world where key = 'prj_a'), 'Lee Park', (select id from world where key = 'cat_vip'))$$,
  'XR001', 'guest_entry_production_fields: The pass type, table and host are set by the production.', 'or the pass type');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, host_person_id) values ((select id from world where key = 'prj_a'), 'Lee Park', (select id from world where key = 'carol'))$$,
  'XR001', 'guest_entry_production_fields: The pass type, table and host are set by the production.', 'or the host');
select private.end_trusted_operation('request_engaged_guest');

select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Guest List', 'Provided', 4);
select pg_temp.as_user('art');
select throws_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'Kim Lee', 0, null, null, 'not an email')$$,
  'XR001', 'guest_email_format: Enter one email address for the guest, or leave it empty.', 'a party''s guest email is checked before the insert');
insert into world values ('g_party', app.request_engaged_guest(pg_temp.id('eng_art_a'), 'Kim Lee', 1, null, null, '  Kim.Lee@Example.TEST '));
select is((select guest_email from app.guest_list_entries where id = pg_temp.id('g_party')), 'kim.lee@example.test', 'a party gives the guest''s email, stored lowercase');
select throws_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'Max Ray', 2)$$,
  'XR001', null, 'R9''s cap still applies');
select pg_temp.as_platform();
select has_function('api_public', 'request_advance_guest', array['text', 'text', 'uuid', 'text', 'integer', 'text', 'text'],
  'the token flow takes the guest''s email');
select hasnt_function('api_public', 'request_advance_guest', array['text', 'text', 'uuid', 'text', 'integer', 'text'], 'the old signature is gone');

-- The door list ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select row(guest_name, pass_category_code, pass_category_name, table_label, host_person_id = pg_temp.id('dave'))::text
           from app.door_guest_list(pg_temp.id('prj_a'), (select lower(pass_code) from app.guest_list_entries where id = pg_temp.id('g_req')))),
  '("Sasha Bell",VIP,"VIP Guest","Table 4",t)', 'a search by the exact pass code finds the guest with the pass type, table and host');
select is((select count(*)::int from app.door_guest_list(pg_temp.id('prj_a'), 'GP-ZZZZZZZZZZ')), 0, 'an unknown code finds nobody');

-- Check-in and the host -------------------------------------------------------------------------------------------------------------
select app.check_in_guest(pg_temp.id('g_req'), 1::smallint, 'North Gate');
select is(pg_temp.notified('dave', 'guest.arrived', pg_temp.id('g_req')), 1, 'the host hears that their guest arrived');
select pg_temp.as_platform();
select is((select (n.message_args ->> 'guest_name') || '/' || (n.message_args ->> 'plus_ones_admitted') || '/' || (n.message_args ->> 'door') || '/' || (n.message_args ->> 'table_label')
           from app.notifications n where n.kind = 'guest.arrived' and n.subject_id = pg_temp.id('g_req')),
  'Sasha Bell/1/North Gate/Table 4', 'with the guest''s name, plus-ones, door and table');
select matches((select pass_code from app.guest_list_entries where id = pg_temp.id('g_req')), '^GP-', 'check-in keeps the pass code');
select pg_temp.as_user('carol');
select app.check_in_guest(pg_temp.id('g_appr'), 0::smallint, 'South Gate');
select is(pg_temp.notified('carol', 'guest.arrived', pg_temp.id('g_appr')), 0, 'no notification when the host checks their own guest in');
select throws_ok($$update app.guest_list_entries set table_label = 'Table 9' where id = (select id from world where key = 'g_appr')$$,
  'XR001', 'guest_entry_checked_in: A checked-in guest keeps their pass type, table, host and email.', 'a checked-in guest keeps their table');

-- Import fields --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select string_agg(field_name, ',' order by field_name) from private.import_target_fields
           where target_code = 'guest_list_entries' and field_name in ('guest_email', 'table_label')), 'guest_email,table_label',
  'the guest list import fills the email and the table');
select is((select classification::text from private.column_classifications where table_name = 'app.guest_list_entries' and column_name = 'guest_email'),
  'Confidential', 'the guest''s email is Confidential');

select * from finish();
rollback;
