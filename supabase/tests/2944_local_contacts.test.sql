-- pgTAP: migration 2944 (B5, G-56), local contacts. A day lists its venue's contacts, the project's every-day contacts
-- and its own; a member contact shows the member's current name and directory work phone, read live, and leaves the
-- default list once the membership ends; a typed contact keeps its phone and email. Writers need show.day_sheet.write on
-- the project (places.venue.write for a venue row); readers without show.run_of_show.read or venue read see none. Only
-- Shared rows reach api_external.local_contacts, for people engaged or rostered on the project, a member's without phone
-- or email. Refusals: a member who is not active in the org, a day outside the project. phone and email are Confidential.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 2940_travel_world.psql

select no_plan();

select pg_temp.producer('sheets', 'show.run_of_show.read');
select pg_temp.producer('sheetwriter', 'show.day_sheet.write');
select pg_temp.producer('places', 'places.venue.read');
update app.projects set starts_on = '2027-06-01', ends_on = '2027-06-06' where id = pg_temp.id('prj_a');

create function pg_temp.contact(p_key text, p_project boolean, p_day date, p_member text, p_name text, p_phone text,
  p_role text, p_audience text) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('alice');
  insert into app.local_contacts (project_id, venue_id, day, membership_id, contact_name, contact_title, phone, email, contact_role, audience,
    notes)
  values (case when p_project then pg_temp.id('prj_a') end, case when not p_project then pg_temp.id('venue_a') end, p_day,
    pg_temp.id(p_member), p_name, 'Duty Manager', p_phone, case when p_name is not null then 'desk@pier-pavilion.test' end,
    p_role::app.local_contact_role, p_audience::app.local_contact_audience, 'Gate code 4471.')
  returning id into v_id;
  perform pg_temp.as_platform();
  insert into world values (p_key, v_id);
  return v_id;
end $$;

create function pg_temp.day_list(p_who text, p_day date) returns text[]
language plpgsql as $$
declare v text[];
begin
  perform pg_temp.as_user(p_who);
  select array_agg(c.display_name order by c.display_name) into v from app.project_local_contacts c
  where c.project_id = pg_temp.id('prj_a') and (c.day is null or c.day = p_day) and c.member_active;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Rows -------------------------------------------------------------------------------------------------------------------------
select pg_temp.contact('venue_desk', false, null, null, 'Pier Pavilion Desk', '+13055550100', 'Venue', 'Shared');
select pg_temp.contact('dave_transport', true, null, 'dave@org_a', null, null, 'Transport', 'Shared');
select pg_temp.contact('medic', true, '2027-06-02', null, 'Bay Medical', '+13055550199', 'Medical', 'Internal');
select pg_temp.contact('gina_hosp', true, null, 'gina@org_a', null, null, 'Hospitality', 'Internal');
select app.set_personal_setting('workforce.work_phone', p_value_text => '+13055550111') from (select pg_temp.as_user('dave')) x;
select pg_temp.as_platform();

select is(pg_temp.day_list('sheets', '2027-06-02'), array['Bay Medical', 'Dave Lindqvist', 'Gina Rossi', 'Pier Pavilion Desk'],
  'June 2 lists the venue''s contact, the every-day contacts and its own');
select is(pg_temp.day_list('sheets', '2027-06-03'), array['Dave Lindqvist', 'Gina Rossi', 'Pier Pavilion Desk'],
  'June 3 leaves out the June 2 contact');
select pg_temp.as_user('sheets');
select is((select phone from app.project_local_contacts where id = pg_temp.id('dave_transport') and project_id = pg_temp.id('prj_a')),
  '+13055550111', 'a member contact shows the directory work phone');
select is((select source from app.project_local_contacts where id = pg_temp.id('dave_transport')), 'Member', 'as a Member row');
select is((select phone from app.project_local_contacts where id = pg_temp.id('medic')), '+13055550199', 'a typed contact keeps its phone');
select is((select email from app.project_local_contacts where id = pg_temp.id('medic')), 'desk@pier-pavilion.test', 'and email');
select pg_temp.as_platform();
select app.set_personal_setting('workforce.work_phone', p_value_text => '+13055550222') from (select pg_temp.as_user('dave')) x;
select pg_temp.as_user('sheets');
select is((select phone from app.project_local_contacts where id = pg_temp.id('dave_transport')), '+13055550222',
  'changing the work phone changes the contact with no edit to its row');
select pg_temp.as_platform();
select is((select phone from app.local_contacts where id = pg_temp.id('dave_transport')), null, 'nothing is copied to the row');
update app.memberships set valid_from = now() - interval '2 days', valid_to = now() - interval '1 second' where id = pg_temp.id('gina@org_a');
select is(pg_temp.day_list('sheets', '2027-06-03'), array['Dave Lindqvist', 'Pier Pavilion Desk'],
  'an ended member leaves the default list');
select pg_temp.as_user('sheets');
select is((select phone from app.project_local_contacts where id = pg_temp.id('gina_hosp')), null, 'and has no work phone');
select pg_temp.as_platform();

-- Readers and writers ------------------------------------------------------------------------------------------------------------
select is(pg_temp.day_list('hops', '2027-06-02'), null, 'a reader without show.run_of_show.read or venue read sees none');
select pg_temp.as_user('places');
select is((select count(*)::int from app.local_contacts), 1, 'a venue reader reads the venue''s rows only');
select pg_temp.as_user('sheetwriter');
select is(pg_temp.rule_of(format($$insert into app.local_contacts (project_id, contact_name, contact_role) values (%L, 'Gate Lead', 'Security')$$,
  pg_temp.id('prj_a'))), 'ok', 'show.day_sheet.write adds a project contact');
select is(pg_temp.rule_of(format($$insert into app.local_contacts (venue_id, contact_name, contact_role) values (%L, 'Dock Lead', 'Venue')$$,
  pg_temp.id('venue_a'))), '42501', 'but not a venue contact, which needs places.venue.write');
select pg_temp.as_user('alice');
select is(pg_temp.rule_of(format($$insert into app.local_contacts (project_id, day, contact_name, contact_role) values (%L, '2027-07-01', 'Late', 'Other')$$,
  pg_temp.id('prj_a'))), 'local_contact_day_outside_project', 'a day outside the project is refused');
select is(pg_temp.rule_of(format($$insert into app.local_contacts (project_id, membership_id, contact_role) values (%L, %L, 'Other')$$,
  pg_temp.id('prj_a'), pg_temp.id('gina@org_a'))), 'local_contact_member', 'an ended member is refused');
select is(pg_temp.rule_of(format($$insert into app.local_contacts (project_id, membership_id, contact_role) values (%L, %L, 'Other')$$,
  pg_temp.id('prj_a'), pg_temp.id('mia@org_b'))), 'cross_org_reference', 'so is another org''s member');
select is(pg_temp.rule_of(format($$insert into app.local_contacts (project_id, membership_id, phone, contact_role) values (%L, %L, '+13055550123', 'Other')$$,
  pg_temp.id('prj_a'), pg_temp.id('dave@org_a'))), '23514', 'a member row copies no phone');
select is(pg_temp.rule_of(format($$insert into app.local_contacts (project_id, contact_name, phone, contact_role) values (%L, 'X', '305-555-0100', 'Other')$$,
  pg_temp.id('prj_a'))), '23514', 'a typed phone is E.164');
select pg_temp.as_platform();
select is((select org_id from app.local_contacts where id = pg_temp.id('venue_desk')), pg_temp.id('org_a'), 'org_id is stamped from the venue');

-- Outside the org --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select is((select array_agg(display_name order by display_name) from api_external.local_contacts where project_id = pg_temp.id('prj_a')),
  array['Dave Lindqvist', 'Pier Pavilion Desk'], 'a person on an operational roster reads the Shared rows');
select is((select phone from api_external.local_contacts where id = pg_temp.id('dave_transport')), null, 'a member row carries no phone');
select is((select email from api_external.local_contacts where id = pg_temp.id('dave_transport')), null, 'nor an email');
select is((select phone from api_external.local_contacts where id = pg_temp.id('venue_desk')), '+13055550100', 'a typed Shared row does');
select pg_temp.as_user('victor');
select is((select count(*)::int from api_external.local_contacts where project_id = pg_temp.id('prj_a')), 2, 'so does the engaged party');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.local_contacts), 0, 'a person without project reach reads none');
select pg_temp.as_platform();
select ok(not exists (select 1 from information_schema.columns where table_schema = 'api_external' and table_name = 'local_contacts'
  and column_name in ('notes', 'audience', 'membership_id')), 'notes never leave the org');

-- Classification ----------------------------------------------------------------------------------------------------------------
select is((select array_agg(column_name::text order by column_name) from private.column_classifications
  where table_name = 'app.local_contacts' and classification = 'Confidential'), array['email', 'phone'], 'phone and email are Confidential');
select is(private.export_column_classification('app.project_local_contacts', 'phone')::text, 'Confidential',
  'and so is the view''s phone in an export');
select ok(not has_table_privilege('xos_backup', 'app.project_local_contacts', 'select'), 'xos_backup cannot select the view');

select * from finish();
rollback;
